"use strict";
/**
 * Minimal Garmin FIT decoder + dive extractor. Pure JS, no dependencies, no
 * Scriptable APIs (so it's unit-testable under Node).
 *
 * Handles what a Descent dive .fit carries: file_id, session, lap, activity,
 * dive_summary, dive_settings, dive_gas, sport. Other messages (incl. the
 * per-second `record` stream) are skipped by advancing the byte cursor.
 *
 * FIT spec bits relied on:
 *  - 12/14-byte header: [size][protoVer][profileVer u16 LE][dataSize u32 LE]".FIT"[crc u16?]
 *  - record header byte: bit7=compressed-ts, bit6=definition, bit5=has-dev-fields,
 *    bits0-3 = local message type
 *  - definition body: [reserved][arch 0=LE/1=BE][globalNum u16][nFields]
 *    then nFields * [fieldDefNum, sizeBytes, baseType];  dev fields if bit5
 *  - timestamps: uint32 seconds since 1989-12-31T00:00:00Z (offset 631065600)
 *  - positions: sint32 semicircles;  deg = raw * (180 / 2**31)
 *  - invalid = all-ones for unsigned, max-positive for signed, 0xFF for enum
 */

const FIT_EPOCH = 631065600; // unix seconds at 1989-12-31T00:00:00Z
const SEMI_TO_DEG = 180 / 2 ** 31;

const MESG = {
  0: "file_id", 12: "sport", 18: "session", 19: "lap", 20: "record",
  21: "event", 23: "device_info", 34: "activity", 49: "file_creator",
  258: "dive_settings", 259: "dive_gas", 262: "dive_alarm", 268: "dive_summary",
};

// baseType -> [byteSize, reader]  (reader(dv, off, littleEndian) -> number|null)
const BASE = {
  0x00: [1, (dv, o) => nz(dv.getUint8(o), 0xff)],            // enum
  0x01: [1, (dv, o) => nz(dv.getInt8(o), 0x7f)],             // sint8
  0x02: [1, (dv, o) => nz(dv.getUint8(o), 0xff)],            // uint8
  0x83: [2, (dv, o, le) => nz(dv.getInt16(o, le), 0x7fff)],
  0x84: [2, (dv, o, le) => nz(dv.getUint16(o, le), 0xffff)],
  0x85: [4, (dv, o, le) => nz(dv.getInt32(o, le), 0x7fffffff)],
  0x86: [4, (dv, o, le) => nz(dv.getUint32(o, le), 0xffffffff)],
  0x07: [1, null],                                            // string (handled specially)
  0x88: [4, (dv, o, le) => { const v = dv.getFloat32(o, le); return Number.isNaN(v) ? null : v; }],
  0x89: [8, (dv, o, le) => { const v = dv.getFloat64(o, le); return Number.isNaN(v) ? null : v; }],
  0x0a: [1, (dv, o) => nz(dv.getUint8(o), 0x00)],            // uint8z
  0x8b: [2, (dv, o, le) => nz(dv.getUint16(o, le), 0x0000)],
  0x8c: [4, (dv, o, le) => nz(dv.getUint32(o, le), 0x00000000)],
  0x0d: [1, (dv, o) => dv.getUint8(o)],                       // byte
  0x8e: [8, (dv, o, le) => big64(dv, o, le, true)],          // sint64
  0x8f: [8, (dv, o, le) => big64(dv, o, le, false)],         // uint64
  0x90: [8, (dv, o, le) => big64(dv, o, le, false)],         // uint64z
};

function nz(v, invalid) { return v === invalid ? null : v; }
function big64(dv, o, le, signed) {
  try {
    const b = signed ? dv.getBigInt64(o, le) : dv.getBigUint64(o, le);
    return Number(b);
  } catch (_) {
    return null; // no BigInt DataView support; not a field we need anyway
  }
}

/** Decode a FIT file. `bytes` is a Uint8Array. -> { [messageName]: Array<{[fieldNum]: value}> } */
function decodeFit(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  let pos = headerSize;
  const end = Math.min(headerSize + dataSize, bytes.byteLength);

  const defs = {};            // localType -> { le, global, fields:[{num,size,base}], totalSize }
  const out = {};

  while (pos < end) {
    const h = dv.getUint8(pos); pos += 1;

    if (h & 0x80) {
      // compressed-timestamp data message: local type in bits 5-6
      const local = (h >> 5) & 0x03;
      const d = defs[local];
      if (!d) break; // malformed
      readData(d, false);
      continue;
    }

    const local = h & 0x0f;
    if (h & 0x40) {
      // definition message
      const le = dv.getUint8(pos + 1) === 0;
      const global = dv.getUint16(pos + 2, le);
      const nFields = dv.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      let totalSize = 0;
      for (let i = 0; i < nFields; i++) {
        const num = dv.getUint8(pos);
        const size = dv.getUint8(pos + 1);
        const base = dv.getUint8(pos + 2);
        pos += 3;
        fields.push({ num, size, base });
        totalSize += size;
      }
      if (h & 0x20) {
        const nDev = dv.getUint8(pos); pos += 1;
        for (let i = 0; i < nDev; i++) {
          totalSize += dv.getUint8(pos + 1);
          pos += 3;
        }
      }
      defs[local] = { le, global, fields, totalSize };
    } else {
      const d = defs[local];
      if (!d) break;
      readData(d, true);
    }
  }
  return out;

  function readData(d, keep) {
    const name = MESG[d.global];
    if (!keep || !name || !WANT.has(name)) { pos += d.totalSize; return; }
    const rec = {};
    let p = pos;
    for (const f of d.fields) {
      const spec = BASE[f.base];
      if (!spec) { p += f.size; continue; }
      const [bsize] = spec;
      if (f.base === 0x07) {
        // string
        let s = "";
        for (let i = 0; i < f.size; i++) {
          const c = dv.getUint8(p + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        rec[f.num] = s || null;
      } else {
        rec[f.num] = spec[1](dv, p, d.le);   // first element only (scalars for our fields)
      }
      p += f.size;
    }
    pos += d.totalSize;
    (out[name] || (out[name] = [])).push(rec);
  }
}

const WANT = new Set([
  "file_id", "sport", "session", "lap", "activity",
  "dive_settings", "dive_gas", "dive_summary",
]);

// ---- dive extraction -------------------------------------------------------

function firstNum(...vals) {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
}

function semiPair(msg, latNum, lngNum) {
  if (!msg) return null;
  const la = msg[latNum], lo = msg[lngNum];
  if (la == null || lo == null) return null;
  let lng = lo * SEMI_TO_DEG;
  if (lng > 180) lng -= 360;
  return { lat: la * SEMI_TO_DEG, lng };
}

/** messages -> normalised dive object */
function extractDive(m) {
  const session = m.session && m.session[0];
  const lap = m.lap && m.lap[0];
  const activity = m.activity && m.activity[0];
  const settings = m.dive_settings && m.dive_settings[0];
  const gas = m.dive_gas && m.dive_gas[0];
  // prefer the dive_summary that carries a dive_number
  let summ = null;
  for (const s of m.dive_summary || []) if (s[10] != null) summ = s;
  if (!summ) summ = (m.dive_summary || [])[0] || null;

  const startRaw = firstNum(session && session[2], lap && lap[2]);
  if (startRaw == null) throw new Error("FIT: no session/lap start_time");

  const ts = activity && activity[253];
  const localTs = activity && activity[5];
  const offset = ts != null && localTs != null ? localTs - ts : 0;
  const startLocal = new Date((FIT_EPOCH + startRaw + offset) * 1000); // read via getUTC*

  const maxDepthRaw = summ && summ[3];
  if (maxDepthRaw == null) throw new Error("FIT: no dive_summary.max_depth - not a recorded dive");

  const divetimeS =
    firstNum(session && session[7], lap && lap[7], summ && summ[11]) / 1000;

  const waterTempC = firstNum(
    session && session[57], session && session[58],
    lap && lap[50], lap && lap[51],
  );

  const wt = settings && settings[4];
  const waterType = wt === 0 ? "fresh" : wt === 1 ? "salt" : null;

  const fix =
    semiPair(session, 3, 4) ||
    semiPair(lap, 3, 4) ||
    semiPair(lap, 5, 6) ||
    semiPair(session, 29, 30) ||
    semiPair(session, 31, 32);

  return {
    startLocal,                                   // Date; use getUTC* for wall clock
    divetimeS,
    maxDepthM: maxDepthRaw / 1000,
    avgDepthM: summ && summ[2] != null ? summ[2] / 1000 : null,
    waterTempC,
    waterType,
    diveNumber: summ && summ[10] != null ? summ[10] : null,
    o2Pct: gas && gas[1] != null ? gas[1] : null,
    lat: fix ? fix.lat : null,
    lng: fix ? fix.lng : null,
  };
}

// ---- geo -----------------------------------------------------------------

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** locator elements -> nearest {id,name,distKm} within maxKm, or null */
function pickNearestSite(elements, lat, lng, maxKm = 5) {
  const sites = [];
  for (const el of elements || []) {
    const p = el && el.data && el.data.properties;
    if (!p || !p.id) continue;
    const sLat = parseFloat(p.lat), sLng = parseFloat(p.lng);
    const dist = Number.isFinite(sLat)
      ? haversineKm(lat, lng, sLat, sLng)
      : parseFloat(p.distanceToCenter);
    sites.push({ id: String(p.id), name: p.name || "", distKm: Number.isFinite(dist) ? dist : null });
  }
  sites.sort((a, b) => (a.distKm ?? 1e9) - (b.distKm ?? 1e9));
  const top = sites[0];
  if (top && (top.distKm == null || top.distKm <= maxKm)) return top;
  return null;
}

// ---- base64 -> bytes (Scriptable Data has no byte accessor) --------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64ToBytes(str) {
  const s = str.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array((s.length * 3) >> 2);
  let bits = 0, nbits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    bits = (bits << 6) | B64.indexOf(s[i]);
    nbits += 6;
    if (nbits >= 8) { nbits -= 8; out[o++] = (bits >> nbits) & 0xff; }
  }
  return out.subarray(0, o);
}

/** unzip nothing - but a Connect "Export Original" is a raw .fit, and the
 *  download-service gives a .zip. Detect the PK magic and bail with a clear msg. */
function assertRawFit(bytes) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    throw new Error("that's a .zip - share the .fit itself (Export Original), not the download-service zip");
  }
  // FIT files have ".FIT" at bytes 8-11
  const tag = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (tag !== ".FIT") throw new Error("not a FIT file (missing .FIT signature)");
}

const api = {
  FIT_EPOCH, decodeFit, extractDive, haversineKm, pickNearestSite,
  base64ToBytes, assertRawFit,
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
