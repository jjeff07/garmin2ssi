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
 */

const DRY_RUN = false; // flip to true to decode + resolve site but not push

const fit = importModule("fit");
const ssiLib = importModule("ssi");

// ---------- config (iOS keychain) ----------

async function getConfig() {
  const g = (k) => (Keychain.contains(k) ? Keychain.get(k) : "");
  let email = g("ssi_email"), password = g("ssi_password"), userId = g("ssi_user_id");
  let siteId = g("ssi_dive_site_id");
  const divetypeId = g("ssi_divetype_id") || "24";
  const comment = g("ssi_comment") || "Imported from Garmin Descent";

  if (!email || !password || !userId) {
    const a = new Alert();
    a.title = "MySSI setup (one time)";
    a.message = "Stored in the iOS keychain on this device only.";
    a.addTextField("MySSI email", email);
    a.addSecureTextField("MySSI password", password);
    a.addTextField("Member id (SSI_USER_ID)", userId);
    a.addTextField("Fallback dive-site id", siteId);
    a.addAction("Save");
    a.addCancelAction("Cancel");
    if ((await a.presentAlert()) === -1) throw new Error("setup cancelled");
    email = a.textFieldValue(0).trim();
    password = a.textFieldValue(1);
    userId = a.textFieldValue(2).trim();
    siteId = a.textFieldValue(3).trim();
    Keychain.set("ssi_email", email);
    Keychain.set("ssi_password", password);
    Keychain.set("ssi_user_id", userId);
    Keychain.set("ssi_dive_site_id", siteId);
  }
  return { email, password, userId, diveSiteId: siteId, divetypeId, comment };
}

// ---------- FIT input ----------

async function readFitBytes() {
  if (args.fileURLs && args.fileURLs.length) {
    const d = Data.fromFile(args.fileURLs[0]);
    if (!d) throw new Error("could not read " + args.fileURLs[0]);
    return fit.base64ToBytes(d.toBase64String());
  }
  const p = args.shortcutParameter;
  if (typeof p === "string" && p.length > 20) return fit.base64ToBytes(p);
  if (p && typeof p.toBase64String === "function") return fit.base64ToBytes(p.toBase64String());
  const picked = await DocumentPicker.open(["public.data"]);
  if (picked && picked.length) {
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

async function resolveSite(lat, lng, cfg) {
  const fallback = (name) => ({ id: cfg.diveSiteId, name, distKm: null, src: "config" });
  if (lat == null || lng == null) return fallback("(SSI_DIVE_SITE_ID)");

  const boot = new Request("https://www.divessi.com/en/locator/divesites");
  const html = await boot.loadString();
  const m = html.match(/SSI_APIKEY\s*=\s*['"]([A-Za-z0-9]{16,80})['"]/);
  if (!m) return fallback("(no SSI_APIKEY)");
  const cookie = cookieHeader(boot.response, ["PHPSESSID"]);

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
    body = JSON.parse(await r.loadString());
  } catch (e) {
    return fallback("(locator error)");
  }
  const els = (body && body.result && body.result.elements) || [];
  const hit = fit.pickNearestSite(els, lat, lng, 5);
  return hit ? Object.assign(hit, { src: "locator" }) : fallback("(nothing within 5 km)");
}

// ---------- MySSI login + create ----------

async function ssiLogin(cfg) {
  await new Request("https://www.divessi.com/en/home").loadString(); // seed a session
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
  const txt = await r.loadString();
  if (!(r.response.statusCode === 200 && txt.indexOf("url=/myssi") !== -1)) {
    const why = /NOT_AUTHORIZED|"success":false/.test(txt) ? " (credentials rejected)" : "";
    throw new Error("SSI login failed" + why + " - " + txt.slice(0, 140));
  }
  return cookieHeader(r.response, ["PHPSESSID", "mid"]);
}

async function diveCount(cookie) {
  const r = new Request("https://my.divessi.com/mydivelog");
  r.headers = { Cookie: cookie };
  const t = await r.loadString();
  if (t.indexOf("mydivelog/show/") === -1) return null;
  return new Set(t.match(/\/mydivelog\/show\/[0-9_]+/g) || []).size;
}

async function createDive(cookie, form) {
  if (!form.odin_user_log_dive_sites_id) {
    return { ok: false, detail: "no dive site (a site-less POST is silently dropped)" };
  }
  const before = await diveCount(cookie);
  const r = new Request("https://my.divessi.com/code/process/mydivelog_18.php");
  r.method = "POST";
  r.headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookie,
    Origin: "https://my.divessi.com",
    Referer: "https://my.divessi.com/mydivelog/add",
  };
  r.body = ssiLib.formEncode(form);
  const txt = await r.loadString();
  const ok =
    r.response.statusCode === 200 &&
    txt.indexOf("url=/mydivelog") !== -1 &&
    txt.indexOf("/mydivelog/add") === -1;
  if (!ok) return { ok: false, detail: "no success redirect - " + txt.slice(0, 140) };
  const after = await diveCount(cookie);
  if (before != null && after != null) {
    return after > before
      ? { ok: true, detail: `created (logbook ${before} -> ${after})` }
      : { ok: false, detail: `POST accepted but no new dive appeared (${before} -> ${after})` };
  }
  return { ok: true, detail: "created (redirect ok; count unavailable)" };
}

// ---------- main ----------

async function main() {
  const cfg = await getConfig();
  const bytes = await readFitBytes();
  fit.assertRawFit(bytes);
  const dive = fit.extractDive(fit.decodeFit(bytes));

  let lat = dive.lat, lng = dive.lng, coordSrc = "fit";
  if (lat == null || lng == null) {
    try {
      Location.setAccuracyToHundredMeters();
      const loc = await Location.current();
      lat = loc.latitude;
      lng = loc.longitude;
      coordSrc = "phone";
    } catch (e) {
      coordSrc = "none";
    }
  }

  const site = await resolveSite(lat, lng, cfg);
  const form = ssiLib.diveToForm(dive, cfg, site.id);

  const d = dive.startLocal;
  const p2 = (n) => String(n).padStart(2, "0");
  const summary =
    `dive #${dive.diveNumber == null ? "?" : dive.diveNumber}  ` +
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}\n` +
    `${Math.round(dive.divetimeS / 60)} min · ${dive.maxDepthM.toFixed(1)} m · ${dive.waterTempC == null ? "?" : dive.waterTempC + "°C"} ${dive.waterType || ""}\n` +
    `site: ${site.name} [${site.id || "none"}${site.distKm != null ? ", " + site.distKm.toFixed(1) + " km" : ""}]  coords:${coordSrc}`;

  const dry = DRY_RUN || (args.queryParameters && args.queryParameters.dry === "1");
  if (dry) return finish("DRY RUN\n" + summary);
  if (!site.id) return finish("FAILED\nno dive site, and no fallback SSI_DIVE_SITE_ID.\n\n" + summary);

  const cookie = await ssiLogin(cfg);
  const res = await createDive(cookie, form);
  return finish((res.ok ? "OK — " : "FAILED — ") + res.detail + "\n\n" + summary);
}

function finish(msg) {
  console.log(msg);
  if (typeof Script !== "undefined" && Script.setShortcutOutput) Script.setShortcutOutput(msg);
  if (typeof config !== "undefined" && config.runsInApp && typeof QuickLook !== "undefined") {
    QuickLook.present(msg);
  } else if (typeof Notification !== "undefined") {
    const n = new Notification();
    n.title = "Garmin → SSI";
    n.body = msg.split("\n").slice(0, 2).join(" — ");
    n.schedule();
  }
  if (typeof Script !== "undefined" && Script.complete) Script.complete();
}

main().catch((e) => finish("ERROR: " + (e && e.message ? e.message : String(e))));
