import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { diveToForm, formEncode, TEMPLATE } = require("../scriptable/ssi.js");

const dive = {
  startLocal: new Date(Date.UTC(2026, 5, 6, 17, 10, 50)),
  divetimeS: 1414.323,
  maxDepthM: 3.847,
  avgDepthM: 2.924,
  waterTempC: 27,
  waterType: "fresh",
  diveNumber: 5,
};
const cfg = { userId: "4195537", divetypeId: "24", comment: "x" };

test("diveToForm maps the core fields", () => {
  const b = diveToForm(dive, cfg, "1965");
  assert.equal(b.odin_user_log_user_master_id, "4195537");
  assert.equal(b.source, "mydl_18_add_AddDiveOnline");
  assert.equal(b.odin_user_log_dive_type, "0");
  assert.deepEqual(
    [b.date_sel2_dd, b.date_sel2_mm, b.date_sel2_yy],
    ["06", "06", "2026"],
  );
  assert.equal(b.odin_user_log_entry_time, "17:10");
  assert.equal(b.odin_user_log_dive_nr, "5");
  assert.equal(b.odin_user_log_divetime, "24");
  assert.equal(b.odin_user_log_depth_m, "3.8");
  assert.equal(b.odin_user_log_depth_ft, "12.6");
  assert.equal(b.odin_user_log_watertemp_c, "27");
  assert.equal(b.odin_user_log_watertemp_f, "81");
  assert.equal(b.odin_user_log_var_watertype_id, "4"); // fresh
  assert.equal(b.dive_site_bow, "fresh");
  assert.equal(b.odin_user_log_dive_sites_id, "1965");
  assert.equal(b.submit, "Submit");
});

test("template is the full 82 fields", () => {
  assert.equal(Object.keys(TEMPLATE).length, 82);
  assert.equal(Object.keys(diveToForm(dive, cfg, "1965")).length, 82);
});

test("optional fields blank when absent; dive_nr blank when null", () => {
  const b = diveToForm(
    { startLocal: new Date(Date.UTC(2026, 0, 2, 8, 5, 0)), divetimeS: 1800, maxDepthM: 18 },
    cfg,
    "1965",
  );
  assert.equal(b.odin_user_log_watertemp_c, "");
  assert.equal(b.odin_user_log_var_watertype_id, "");
  assert.equal(b.odin_user_log_avg_depth_m, "");
  assert.equal(b.odin_user_log_dive_nr, "");
  assert.equal(b.odin_user_log_depth_m, "18.0");
});

test("formEncode", () => {
  assert.equal(formEncode({ a: "1 2", b: "x&y" }), "a=1%202&b=x%26y");
});
