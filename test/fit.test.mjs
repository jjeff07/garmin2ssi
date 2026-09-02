import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fit = require("../scriptable/fit.js");

const load = (name) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));

// Oracle values from the Python `fitparse` parse of the same bytes.

test("sample_dive.fit — little-endian, no GPS", () => {
  const d = fit.extractDive(fit.decodeFit(load("sample_dive.fit")));
  // local start = 2026-06-06 21:10:50 UTC + (-04:00)
  assert.equal(d.startLocal.getUTCFullYear(), 2026);
  assert.equal(d.startLocal.getUTCMonth() + 1, 6);
  assert.equal(d.startLocal.getUTCDate(), 6);
  assert.equal(d.startLocal.getUTCHours(), 17);
  assert.equal(d.startLocal.getUTCMinutes(), 10);
  assert.equal(Math.round(d.divetimeS), 1414);
  assert.equal(Number(d.maxDepthM.toFixed(3)), 3.847);
  assert.equal(Number(d.avgDepthM.toFixed(3)), 2.924);
  assert.equal(d.waterTempC, 27);
  assert.equal(d.waterType, "fresh");
  assert.equal(d.diveNumber, 5);
  assert.equal(d.o2Pct, 21);
  assert.equal(d.lat, null);
  assert.equal(d.lng, null);
});

test("dive_with_gps.fit — BIG-endian, lap end_position fix", () => {
  const d = fit.extractDive(fit.decodeFit(load("dive_with_gps.fit")));
  assert.equal(d.startLocal.getUTCHours(), 17);
  assert.equal(d.startLocal.getUTCMinutes(), 11);
  assert.equal(Math.round(d.divetimeS), 1354);
  assert.equal(Number(d.maxDepthM.toFixed(3)), 3.847);
  assert.equal(d.waterTempC, 27);
  assert.equal(d.waterType, "fresh");
  assert.equal(d.diveNumber, 7);
  assert.ok(Math.abs(d.lat - 41.3706) < 0.01, `lat ${d.lat}`);
  assert.ok(Math.abs(d.lng - -83.3122) < 0.01, `lng ${d.lng}`);
});

test("assertRawFit rejects a zip and non-FIT", () => {
  assert.throws(() => fit.assertRawFit(new Uint8Array([0x50, 0x4b, 3, 4])), /zip/);
  assert.throws(() => fit.assertRawFit(new Uint8Array(20)), /not a FIT/);
  assert.doesNotThrow(() => fit.assertRawFit(load("sample_dive.fit")));
});

test("base64ToBytes round-trips", () => {
  const src = load("dive_with_gps.fit");
  const b64 = Buffer.from(src).toString("base64");
  assert.deepEqual([...fit.base64ToBytes(b64)], [...src]);
});

test("haversine + pickNearestSite", () => {
  assert.ok(Math.abs(fit.haversineKm(41.3871, -83.3027, 41.3716, -83.3155) - 2.0) < 0.2);
  const els = [
    { data: { properties: { id: "1965", name: "White Star Quarry", lat: "41.3716", lng: "-83.3155" } } },
    { data: { properties: { id: "9", name: "Far", lat: "42", lng: "-84", distanceToCenter: "80" } } },
  ];
  assert.equal(fit.pickNearestSite(els, 41.3871, -83.3027, 5).id, "1965");
  assert.equal(fit.pickNearestSite(els, 41.3871, -83.3027, 1), null);
});

test("sitesNearby: sorted nearest-first, filtered by maxKm", () => {
  const els = [
    { data: { properties: { id: "9", name: "Far", lat: "42", lng: "-84", distanceToCenter: "80" } } },
    { data: { properties: { id: "1965", name: "White Star Quarry", lat: "41.3716", lng: "-83.3155" } } },
    { data: { properties: { id: "7", name: "Portage Quarry", lat: "41.3800", lng: "-83.3100" } } },
  ];
  const near = fit.sitesNearby(els, 41.3871, -83.3027, 5);
  assert.deepEqual(near.map((s) => s.id), ["7", "1965"]);
  assert.ok(near[0].distKm < near[1].distKm);
  assert.equal(near[0].name, "Portage Quarry");
  assert.equal(fit.sitesNearby(els, 41.3871, -83.3027, null).length, 3); // no filter keeps all
  assert.deepEqual(fit.sitesNearby([], 0, 0), []);
});
