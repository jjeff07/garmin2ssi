"use strict";
/**
 * Garmin dive .fit  ->  MySSI web logbook.  Scriptable (iOS), no server.
 *
 * Setup: put fit.js, ssi.js and this file in the Scriptable folder. First run
 * prompts for your MySSI email / password / member id (stored in the iOS
 * keychain). Then share a .fit to this script, or call it from a Shortcut.
 *
 * Flow: decode FIT -> dive site from the FIT's own GPS (else the phone's
 * location, else your fallback id) via the public SSI locator -> log in ->
 * POST the dive.  Field spec: reference/ssi_logbook_api.md
 *
 * Every step is logged (see the "-- log --" block in the result, the Scriptable
 * console, and the garmin-to-ssi.log file in the Scriptable folder). A 150 s
 * watchdog guarantees a result even if something hangs.
 */

const DRY_RUN = false; // flip to true to decode + resolve site but not push
const REPICK = false;  // flip to true (or add ?repick=1) to re-choose a remembered site
const SETUP = false;   // flip to true (or add ?setup=1) to re-open the email/password/settings prompt
const FORCE_PHONE_LOCATION = false; // (or ?loc=phone) ignore the FIT's GPS, use the phone's
const STALE_FIT_KM = 0; // >0: if the FIT's GPS is farther than this (km) from the phone, ask which to use
const MAX_SITE_KM = 10; // sites within this many km are "near"; farther ones are still offered if nothing's near
const WATCHDOG_S = 150; // hard stop: emit whatever we have if we're not done by now
const NET_TIMEOUT_S = 30;
const LOCATION_TIMEOUT_S = 15;
const PICKER_TIMEOUT_S = 120;

let fit, ssiLib; // loaded inside main() so a load error is caught + shown

// ---------- logging ----------

const T0 = Date.now();
const LOG = [];
let LOG_FILE = null;
try {
  const fm = FileManager.local();
  LOG_FILE = fm.joinPath(fm.documentsDirectory(), "garmin-to-ssi.log");
} catch (e) { /* no file manager - console only */ }

function log(msg) {
  const secs = ((Date.now() - T0) / 1000).toFixed(1);
  const line = "+" + (secs + "s").padStart(7) + "  " + msg;
  LOG.push(line);
  console.log(line);
  if (LOG_FILE) {
    try { FileManager.local().writeString(LOG_FILE, LOG.join("\n") + "\n"); } catch (e) { /* ignore */ }
  }
}

// can we show an Alert / DocumentPicker / QuickLook? true in the app and the
// share-sheet extension; false for a headless Shortcut / automation / Siri run.
const canPrompt = () =>
  typeof config === "undefined" || config.runsInApp || config.runsInActionExtension;

/** reject after ms unless `p` settles first (Scriptable has no fetch timeout on await) */
function withTimeout(p, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = Timer.schedule(ms, false, () => reject(new Error("timed out after " + ms / 1000 + "s: " + label)));
  });
  return Promise.race([Promise.resolve(p), guard]).finally(() => {
    try { if (timer) timer.invalidate(); } catch (e) { /* ignore */ }
  });
}

/** GET/POST with a timeout + a log line for status and size */
async function fetchString(req, label) {
  req.timeoutInterval = NET_TIMEOUT_S;
  log(label + " ...");
  const txt = await withTimeout(req.loadString(), NET_TIMEOUT_S * 1000 + 2000, label);
  const code = (req.response && req.response.statusCode) || "?";
  log(label + " <- HTTP " + code + ", " + (txt ? txt.length : 0) + " bytes");
  return txt;
}

// ---------- config (iOS keychain) ----------

async function getConfig() {
  const g = (k) => (Keychain.contains(k) ? Keychain.get(k) : "");
  let email = g("ssi_email"), password = g("ssi_password"), userId = g("ssi_user_id");
  let siteId = g("ssi_dive_site_id");
  const divetypeId = g("ssi_divetype_id") || "24";
  const comment = g("ssi_comment") || "Imported from Garmin Descent";
  // add to the FIT's dive_number so the logged # matches Garmin Connect (set 1)
  const diveNrOffset = parseInt(g("ssi_dive_nr_offset") || "0", 10) || 0;

  const haveCreds = email && password && userId;
  const forceSetup =
    SETUP || (args.queryParameters && args.queryParameters.setup === "1");

  if (forceSetup || !haveCreds) {
    if (!haveCreds) log("keychain missing email/password/userId");
    if (!canPrompt()) {
      if (haveCreds) return { email, password, userId, diveSiteId: siteId, divetypeId, comment, diveNrOffset };
      throw new Error("not set up yet - run the script once inside Scriptable to enter MySSI credentials");
    }
    const a = new Alert();
    a.title = haveCreds ? "MySSI settings" : "MySSI setup (one time)";
    a.message = "Stored in the iOS keychain on this device only.";
    a.addTextField("MySSI email", email);
    a.addSecureTextField("MySSI password", password);
    a.addTextField("Member id (SSI_USER_ID)", userId);
    a.addTextField("Fallback dive-site id", siteId);
    a.addTextField("Dive-# offset (usually 1)", String(diveNrOffset));
    a.addAction("Save");
    a.addCancelAction("Cancel");
    const cancelled = (await a.presentAlert()) === -1;
    if (cancelled) {
      if (haveCreds) { log("settings unchanged"); return { email, password, userId, diveSiteId: siteId, divetypeId, comment, diveNrOffset }; }
      throw new Error("setup cancelled");
    }
    email = a.textFieldValue(0).trim() || email;
    password = a.textFieldValue(1) || password;
    userId = a.textFieldValue(2).trim() || userId;
    siteId = a.textFieldValue(3).trim();
    const off = parseInt(a.textFieldValue(4).trim(), 10) || 0;
    Keychain.set("ssi_email", email);
    Keychain.set("ssi_password", password);
    Keychain.set("ssi_user_id", userId);
    Keychain.set("ssi_dive_site_id", siteId);
    Keychain.set("ssi_dive_nr_offset", String(off));
    log("saved settings to keychain");
    return { email, password, userId, diveSiteId: siteId, divetypeId, comment, diveNrOffset: off };
  }
  return { email, password, userId, diveSiteId: siteId, divetypeId, comment, diveNrOffset };
}

// ---------- FIT input ----------

async function readFitBytes() {
  if (args.fileURLs && args.fileURLs.length) {
    log("input: fileURLs[0] = " + args.fileURLs[0]);
    const d = Data.fromFile(args.fileURLs[0]);
    if (!d) throw new Error("could not read " + args.fileURLs[0]);
    return fit.base64ToBytes(d.toBase64String());
  }
  const p = args.shortcutParameter;
  if (typeof p === "string" && p.length > 20) {
    log("input: shortcutParameter (string, " + p.length + " chars)");
    return fit.base64ToBytes(p);
  }
  if (p && typeof p.toBase64String === "function") {
    log("input: shortcutParameter (Data)");
    return fit.base64ToBytes(p.toBase64String());
  }
  if (!canPrompt()) {
    throw new Error("no .fit passed in - the Shortcut must send the file as input (Run Script parameter)");
  }
  log("input: no arg, opening DocumentPicker");
  const picked = await DocumentPicker.open(["public.data"]);
  if (picked && picked.length) {
    log("input: picked " + picked[0]);
    return fit.base64ToBytes(Data.fromFile(picked[0]).toBase64String());
  }
  throw new Error("no .fit input - share a file to this script or pass one from a Shortcut");
}

// ---------- HTTP helpers ----------

function cookieHeader(resp, names) {
  const jar = {};
  for (const c of (resp && resp.cookies) || []) jar[c.name] = c.value;
  return names.filter((n) => jar[n]).map((n) => n + "=" + jar[n]).join("; ");
}

// ---------- dive-site locator (public, no login) ----------

/** coords -> { candidates: [{id,name,distKm,...}], note } via the public locator.
 *  candidates = sites within MAX_SITE_KM if any, else every site the locator
 *  returned (nearest first) - so a hand-set FIT location still gets a picker. */
async function locateSites(lat, lng) {
  const boot = new Request("https://www.divessi.com/en/locator/divesites");
  const html = await fetchString(boot, "locator page");
  const m = html.match(/SSI_APIKEY\s*=\s*['"]([A-Za-z0-9]{16,80})['"]/);
  if (!m) return { candidates: [], note: "no SSI_APIKEY on locator page" };
  const cookie = cookieHeader(boot.response, ["PHPSESSID"]);
  log("SSI_APIKEY " + m[1].slice(0, 6) + "..., cookie " + (cookie ? "ok" : "MISSING"));

  const half = 0.15;
  const reqObj = {
    type: "BOUNDS_CHANGED",
    filter: {
      targets: ["DiveSites"],
      geoBounds: { south: lat - half, north: lat + half, west: lng - half, east: lng + half },
      viewportCenter: { lat, lng },
    },
  };
  const r = new Request("https://www.divessi.com/api/locationServices.php");
  r.method = "POST";
  r.headers = {
    "x-ssi-auth": m[1],
    Cookie: cookie,
    Origin: "https://www.divessi.com",
    Referer: "https://www.divessi.com/en/locator/divesites",
  };
  r.addParameterToMultipart("request", JSON.stringify(reqObj));
  let body;
  try {
    body = JSON.parse(await fetchString(r, "locator query"));
  } catch (e) {
    return { candidates: [], note: "locator request failed (" + (e && e.message ? e.message : e) + ")" };
  }
  const els = (body && body.result && body.result.elements) || [];
  const all = fit.sitesNearby(els, lat, lng, null); // every returned site, nearest first
  const near = fit.sitesNearby(els, lat, lng, MAX_SITE_KM);
  const candidates = near.length ? near : all;
  const show = (s) => s.name + " " + (s.distKm == null ? "?" : s.distKm.toFixed(1) + "km");
  let note;
  if (!all.length) note = "no sites near these coords";
  else if (near.length) note = near.length + " within " + MAX_SITE_KM + " km: " + near.slice(0, 6).map(show).join(", ");
  else note = "none within " + MAX_SITE_KM + " km; offering all " + all.length + ": " + all.slice(0, 6).map(show).join(", ");
  return { candidates, note };
}

/** pick one site: silent for 0/1, an Alert menu (remembered per spot) for many */
async function chooseSite(candidates, cfg, lat, lng) {
  if (!candidates.length) {
    return cfg.diveSiteId
      ? { id: cfg.diveSiteId, name: "(fallback id)", distKm: null, src: "config" }
      : { id: "", name: "(none)", distKm: null, src: "none" };
  }
  // auto-pick a lone candidate only if it's genuinely nearby
  if (candidates.length === 1 && candidates[0].distKm != null && candidates[0].distKm <= MAX_SITE_KM) {
    return Object.assign({ src: "locator" }, candidates[0]);
  }

  const key = "ssi_site_pick_" + lat.toFixed(3) + "_" + lng.toFixed(3);
  const repick = REPICK || (args.queryParameters && args.queryParameters.repick === "1");
  if (!repick && Keychain.contains(key)) {
    const hit = candidates.find((c) => c.id === Keychain.get(key));
    if (hit) {
      log("remembered pick for this spot: " + hit.name + " [" + hit.id + "]");
      return Object.assign({ src: "locator (remembered)" }, hit);
    }
  }

  const shown = candidates.slice(0, 10);
  if (!canPrompt()) {
    log(shown.length + " candidates but running headless (no picker) -> nearest");
    return Object.assign({ src: "locator (nearest - headless)" }, shown[0]);
  }

  log("prompting to pick between " + shown.length + " sites");
  let idx;
  try {
    const a = new Alert();
    a.title = "Which dive site?";
    a.message =
      "Nearest sites to " + lat.toFixed(4) + ", " + lng.toFixed(4) +
      ". Your choice is remembered for this spot.";
    shown.forEach((c) =>
      a.addAction(c.name + (c.distKm != null ? "  ·  " + c.distKm.toFixed(1) + " km" : ""))
    );
    if (cfg.diveSiteId) a.addAction("Fallback id " + cfg.diveSiteId);
    a.addCancelAction("Cancel");
    idx = await withTimeout(a.presentSheet(), PICKER_TIMEOUT_S * 1000, "site picker");
  } catch (e) {
    log("picker unavailable (" + (e && e.message ? e.message : e) + ") -> nearest");
    return Object.assign({ src: "locator (nearest - no picker)" }, shown[0]);
  }
  if (idx === -1) throw new Error("cancelled at dive-site selection");
  if (idx >= shown.length) {
    log("picked the fallback id");
    return { id: cfg.diveSiteId, name: "(fallback id)", distKm: null, src: "config" };
  }
  try { Keychain.set(key, shown[idx].id); } catch (e) { /* ignore */ }
  log("picked: " + shown[idx].name + " [" + shown[idx].id + "]");
  return Object.assign({ src: "locator (picked)" }, shown[idx]);
}

// ---------- MySSI login + create ----------

async function ssiLogin(cfg) {
  await fetchString(new Request("https://www.divessi.com/en/home"), "seed session"); // sets PHPSESSID
  const r = new Request("https://www.divessi.com/bridge/code/process/signin");
  r.method = "POST";
  r.headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://www.divessi.com",
    Referer: "https://www.divessi.com/en/home",
  };
  r.body =
    "username=" + encodeURIComponent(cfg.email) +
    "&password=" + encodeURIComponent(cfg.password) +
    "&rememberMe=off&auth=Portal";
  const txt = await fetchString(r, "signin");
  if (!(r.response.statusCode === 200 && txt.indexOf("url=/myssi") !== -1)) {
    const why = /NOT_AUTHORIZED|"success":false/.test(txt) ? " (credentials rejected)" : "";
    throw new Error("SSI login failed" + why + " - " + txt.slice(0, 140));
  }
  log("signed in");
  return cookieHeader(r.response, ["PHPSESSID", "mid"]);
}

async function diveCount(cookie) {
  const r = new Request("https://my.divessi.com/mydivelog");
  r.headers = { Cookie: cookie };
  const t = await fetchString(r, "read logbook");
  if (t.indexOf("mydivelog/show/") === -1) return null;
  return new Set(t.match(/\/mydivelog\/show\/[0-9_]+/g) || []).size;
}

async function createDive(cookie, form) {
  if (!form.odin_user_log_dive_sites_id) {
    return { ok: false, detail: "no dive site (a site-less POST is silently dropped)" };
  }
  const before = await diveCount(cookie);
  log("logbook has " + (before == null ? "?" : before) + " dives before; dive_nr=" + form.odin_user_log_dive_nr);
  const r = new Request("https://my.divessi.com/code/process/mydivelog_18.php");
  r.method = "POST";
  r.headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookie,
    Origin: "https://my.divessi.com",
    Referer: "https://my.divessi.com/mydivelog/add",
  };
  r.body = ssiLib.formEncode(form);
  const txt = await fetchString(r, "create dive");
  const ok =
    r.response.statusCode === 200 &&
    txt.indexOf("url=/mydivelog") !== -1 &&
    txt.indexOf("/mydivelog/add") === -1;
  if (!ok) return { ok: false, detail: "no success redirect - " + txt.slice(0, 140) };
  const after = await diveCount(cookie);
  log("logbook has " + (after == null ? "?" : after) + " dives after");
  if (before != null && after != null) {
    return after > before
      ? { ok: true, detail: `created (logbook ${before} -> ${after})` }
      : { ok: false, detail: `POST accepted but no new dive appeared (${before} -> ${after})` };
  }
  return { ok: true, detail: "created (redirect ok; count unavailable)" };
}

// ---------- main ----------

async function main() {
  log("start (canPrompt=" + canPrompt() + ", dryRun=" + DRY_RUN + ")");
  fit = importModule("fit");
  ssiLib = importModule("ssi");
  log("modules loaded");

  const cfg = await getConfig();
  log("config ok (member " + (cfg.userId || "?") + ", fallback site " + (cfg.diveSiteId || "none") + ")");

  const bytes = await readFitBytes();
  log("fit: " + bytes.length + " bytes");
  fit.assertRawFit(bytes);
  const msgs = fit.decodeFit(bytes);
  log("messages: " + Object.keys(msgs).map((k) => k + "=" + msgs[k].length).join(" "));
  if (msgs.dive_summary) log("dive_summary raw: " + JSON.stringify(msgs.dive_summary));
  const dive = fit.extractDive(msgs);
  log(
    "decoded: dive #" + (dive.diveNumber == null ? "?" : dive.diveNumber) +
    " (of " + dive.summaryCount + " summary msgs)" +
    ", " + dive.maxDepthM.toFixed(1) + " m, " + Math.round(dive.divetimeS / 60) + " min"
  );
  log(
    "fit coords: " +
    (dive.lat != null ? dive.lat.toFixed(5) + ", " + dive.lng.toFixed(5) : "none") +
    " (from " + dive.fixSrc + ")"
  );

  const forcePhone =
    FORCE_PHONE_LOCATION || (args.queryParameters && args.queryParameters.loc === "phone");
  const fitHasGps = dive.lat != null && dive.lng != null;
  let lat = null, lng = null, coordSrc = "none";

  async function phoneLocation() {
    Location.setAccuracyToHundredMeters();
    const loc = await withTimeout(Location.current(), LOCATION_TIMEOUT_S * 1000, "Location.current");
    return { lat: loc.latitude, lng: loc.longitude };
  }

  if (fitHasGps && !forcePhone) {
    lat = dive.lat; lng = dive.lng; coordSrc = "fit";
    log("FIT GPS: " + lat.toFixed(4) + ", " + lng.toFixed(4) + " (" + dive.fixSrc + ")");
    // the watch sometimes stamps a dive with a stale surface fix from a past
    // trip - if the phone is far from it, it's almost certainly wrong
    if (STALE_FIT_KM > 0) {
      try {
        const ph = await phoneLocation();
        const km = fit.haversineKm(lat, lng, ph.lat, ph.lng);
        log("phone is " + km.toFixed(0) + " km from the FIT fix");
        if (km > STALE_FIT_KM) {
          let usePhone = true;
          if (canPrompt()) {
            const a = new Alert();
            a.title = "FIT GPS looks stale";
            a.message = "The dive file's location is " + km.toFixed(0) +
              " km away from where you are now.";
            a.addAction("Use my current location");
            a.addAction("Keep the file's location");
            a.addCancelAction("Cancel");
            const pick = await withTimeout(a.presentSheet(), PICKER_TIMEOUT_S * 1000, "stale-fix prompt");
            if (pick === -1) throw new Error("cancelled at stale-GPS prompt");
            usePhone = pick === 0;
          }
          if (usePhone) {
            lat = ph.lat; lng = ph.lng;
            coordSrc = "phone (FIT fix was " + km.toFixed(0) + " km away)";
            log("using phone location instead of the stale FIT fix");
          } else {
            log("keeping the FIT fix");
          }
        }
      } catch (e) {
        log("stale-fix check skipped (" + (e && e.message ? e.message : e) + ")");
      }
    }
  } else {
    if (forcePhone && fitHasGps) log("FORCE_PHONE_LOCATION - ignoring the FIT's GPS");
    try {
      const ph = await phoneLocation();
      lat = ph.lat; lng = ph.lng; coordSrc = "phone";
      log("phone location: " + lat.toFixed(4) + ", " + lng.toFixed(4));
    } catch (e) {
      log("no phone location (" + (e && e.message ? e.message : e) + ")");
      if (fitHasGps) { // force-phone asked, phone failed -> fall back to the FIT
        lat = dive.lat; lng = dive.lng; coordSrc = "fit (phone unavailable)";
        log("falling back to FIT GPS: " + lat.toFixed(4) + ", " + lng.toFixed(4));
      }
    }
  }

  const found =
    lat != null && lng != null
      ? await locateSites(lat, lng)
      : { candidates: [], note: "no GPS in the FIT and no phone location" };
  log("locator: " + found.note);
  const site = await chooseSite(found.candidates, cfg, lat, lng);
  log("site: " + (site.name || "(none)") + " [" + (site.id || "no id") + "] via " + site.src);
  const form = ssiLib.diveToForm(dive, cfg, site.id);
  log(
    "dive_nr: FIT " + (dive.diveNumber == null ? "?" : dive.diveNumber) +
    " + offset " + (cfg.diveNrOffset || 0) + " -> " + (form.odin_user_log_dive_nr || "(blank)")
  );

  const d = dive.startLocal;
  const p2 = (n) => String(n).padStart(2, "0");
  const lines = [
    "dive #  " + (form.odin_user_log_dive_nr || "?"),
    "when    " +
      d.getUTCFullYear() + "-" + p2(d.getUTCMonth() + 1) + "-" + p2(d.getUTCDate()) +
      " " + p2(d.getUTCHours()) + ":" + p2(d.getUTCMinutes()) + " (local)",
    "runtime " + Math.round(dive.divetimeS / 60) + " min",
    "depth   " + dive.maxDepthM.toFixed(1) + " m max" +
      (dive.avgDepthM != null ? "  ·  " + dive.avgDepthM.toFixed(1) + " m avg" : ""),
  ];
  if (dive.waterTempC != null) lines.push("temp    " + dive.waterTempC + " °C");
  if (dive.waterType) lines.push("water   " + dive.waterType);
  if (dive.o2Pct != null) lines.push("gas     " + dive.o2Pct + "% O2");
  lines.push("");
  lines.push(
    "site    " + (site.name || "(none)") +
      "  [" + (site.id || "no id") +
      (site.distKm != null ? "  ·  " + site.distKm.toFixed(2) + " km" : "") + "]"
  );
  lines.push("coords  " + coordSrc + (found.note ? "  ·  " + found.note : ""));
  lines.push("match   " + site.src);
  const body = lines.join("\n");

  const dry = DRY_RUN || (args.queryParameters && args.queryParameters.dry === "1");
  if (dry) return finish("DRY RUN - POST skipped", body + "\n\nresult  decoded + site resolved only");
  if (!site.id) {
    return finish(
      "FAILED - no dive site",
      body + "\n\nresult  MySSI silently drops a site-less dive; set a fallback id or dive with GPS"
    );
  }

  let err = null, res = null;
  try {
    const cookie = await ssiLogin(cfg);
    res = await createDive(cookie, form);
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  if (err) return finish("FAILED - " + err, body + "\n\nresult  " + err);
  return finish(
    res.ok ? "OK - dive logged to MySSI" : "FAILED - " + res.detail,
    body + "\n\nresult  " + res.detail
  );
}

// ---------- output ----------

let DONE = false;
let WATCHDOG = null;
try {
  WATCHDOG = Timer.schedule(WATCHDOG_S * 1000, false, () =>
    finish("ERROR - watchdog: no result after " + WATCHDOG_S + " s", "stuck after the last log line below")
  );
} catch (e) { /* no Timer - skip watchdog */ }

function finish(head, body) {
  if (DONE) return;
  DONE = true;
  try { if (WATCHDOG) WATCHDOG.invalidate(); } catch (e) { /* ignore */ }

  log("done: " + head);
  const msg = (body ? head + "\n\n" + body : head) + "\n\n-- log --\n" + LOG.join("\n");
  console.log(msg);

  // surface the result every way we can - one of these always lands
  try { Pasteboard.copy(msg); } catch (e) { /* ignore */ }
  try {
    const fm = FileManager.local();
    fm.writeString(fm.joinPath(fm.documentsDirectory(), "garmin-to-ssi.result.txt"), msg);
  } catch (e) { /* ignore */ }
  try {
    if (typeof Script !== "undefined" && Script.setShortcutOutput) Script.setShortcutOutput(msg);
  } catch (e) { /* ignore */ }
  try {
    if (typeof Notification !== "undefined") {
      const n = new Notification();
      n.title = "Garmin → SSI";
      n.body = head;
      n.sound = "default";
      n.schedule();
    }
  } catch (e) { /* ignore */ }
  try {
    if (typeof QuickLook !== "undefined") QuickLook.present(msg, false);
  } catch (e) { /* ignore */ }
  try {
    if (typeof Script !== "undefined" && Script.complete) Script.complete();
  } catch (e) { /* ignore */ }
}

main().catch((e) => finish("ERROR - " + (e && e.message ? e.message : String(e))));
