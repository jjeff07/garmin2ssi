"use strict";
/**
 * Build the MySSI add-dive form body (pure; unit-testable under Node).
 * Field reference: reference/ssi_logbook_api.md
 * The dive site (`odin_user_log_dive_sites_id`) is MANDATORY - a site-less POST
 * gets the success redirect but silently creates nothing.
 */

const DIVE_TYPE_SCUBA = "0"; // 2 XR, 4 SCR, 8 CCR, 6 Freediving
const DIVETYPE_FUN_DIVE = "24"; // 23 Education, 138 Scientific, 139 Work
const WATERTYPE = { fresh: "4", salt: "5" };

// 82-field template captured 2026-09-01 from a real dive; only structural
// defaults are non-empty.
const TEMPLATE = {
  odin_user_log_user_master_id: "", source: "mydl_18_add_AddDiveOnline",
  odin_user_log_animal_ids: "", odin_user_log_transferDate: "",
  odin_user_log_diveComputer: "", odin_user_log_diveComputerData_ue: "",
  odin_user_log_si_before: "", odin_user_log_gf_set: "", odin_user_log_gf_set_1: "",
  odin_user_log_gf_set_2: "", odin_user_log_gf_end: "", odin_user_log_cns_start: "",
  odin_user_log_cns_end: "", odin_user_log_otu_start: "", odin_user_log_otu_end: "",
  odin_user_log_alarm_deco_stop: "", odin_user_log_alarm_fast_ascent: "",
  odin_user_log_alarm_deco_violation: "", odin_user_log_divecomputer_dive_ref: "",
  odin_user_log_divecomputer_ref: "", odin_user_log_divecomputer_imported: "",
  odin_user_log_dive_type: DIVE_TYPE_SCUBA,
  date_sel2_dd: "", date_sel2_mm: "", date_sel2_yy: "", odin_user_log_entry_time: "",
  odin_user_log_dive_nr: "", odin_user_log_var_divetype_id: DIVETYPE_FUN_DIVE,
  log_linked_brevet_rule_id: "0", odin_user_log_leader_nr: "", log_linked_facility_id: "",
  odin_user_log_dive_sites_id: "", dive_site_bow: "", adr: "", searchSite: "",
  odin_user_log_divetime: "", odin_user_log_depth_m: "", odin_user_log_depth_ft: "",
  odin_user_log_avg_depth_m: "", odin_user_log_avg_depth_ft: "",
  odin_user_log_weight_kg: "", odin_user_log_weight_lb: "",
  odin_user_log_gearconfiguration_id: "", odin_user_log_var_tanktype_id: "",
  odin_user_log_tank_vol_l: "", odin_user_log_tank_vol_cuft: "",
  odin_user_log_pressure_start_bar: "", odin_user_log_pressure_start_psi: "",
  odin_user_log_pressure_end_bar: "", odin_user_log_pressure_end_psi: "",
  odin_user_log_amv_l: "", odin_user_log_amv_psi: "", odin_user_log_deco_time: "",
  odin_user_log_deco_gas_tanktype_id: "", odin_user_log_deco_gas_tank_vol_l: "",
  odin_user_log_deco_gas_tank_vol_cuft: "", odin_user_log_deco_gas_o2: "",
  odin_user_log_deco_gas_start_bar: "", odin_user_log_deco_gas_start_psi: "",
  odin_user_log_deco_gas_end_bar: "", odin_user_log_deco_gas_end_psi: "",
  log_extended_data_cleanup_weight_kg: "", log_extended_data_cleanup_weight_lb: "",
  "odin_user_log_var_specialdive_id[]": "", odin_user_log_rating: "",
  odin_user_log_var_water_body_id: "", odin_user_log_var_entry_id: "",
  odin_user_log_var_watertype_id: "", odin_user_log_var_current_id: "",
  odin_user_log_var_surface_id: "", odin_user_log_var_weather_id: "",
  odin_user_log_airtemp_c: "", odin_user_log_airtemp_f: "",
  odin_user_log_watertemp_c: "", odin_user_log_watertemp_f: "",
  odin_user_log_watertemp_max_c: "", odin_user_log_watertemp_max_f: "",
  odin_user_log_vis_m: "", odin_user_log_vis_ft: "",
  odin_user_log_gear_details: "", odin_user_log_comment: "", submit: "Submit",
};

const pad = (n) => String(n).padStart(2, "0");
const cToF = (c) => Math.round((c * 9) / 5 + 32);
const mToFt = (m) => Math.round(m * 3.28084 * 10) / 10;

/**
 * @param dive  from fit.extractDive: {startLocal:Date, divetimeS, maxDepthM,
 *              avgDepthM, waterTempC, waterType, diveNumber}
 * @param cfg   {userId, divetypeId?, comment?, diveNrOffset?}
 * @param siteId  SSI dive-site id (required for the dive to actually save)
 */
function diveToForm(dive, cfg, siteId) {
  const b = Object.assign({}, TEMPLATE);
  const d = dive.startLocal;
  b.odin_user_log_user_master_id = cfg.userId || "";
  b.date_sel2_dd = pad(d.getUTCDate());
  b.date_sel2_mm = pad(d.getUTCMonth() + 1);
  b.date_sel2_yy = String(d.getUTCFullYear());
  b.odin_user_log_entry_time = pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  // FIT dive_number is Garmin's internal count; Connect shows it +1. An offset
  // (SSI_DIVE_NR_OFFSET) lets the logged number match Garmin Connect.
  b.odin_user_log_dive_nr =
    dive.diveNumber == null ? "" : String(dive.diveNumber + (Number(cfg.diveNrOffset) || 0));
  b.odin_user_log_var_divetype_id = cfg.divetypeId || DIVETYPE_FUN_DIVE;
  b.odin_user_log_divetime = String(Math.round(dive.divetimeS / 60));
  b.odin_user_log_depth_m = dive.maxDepthM.toFixed(1);
  b.odin_user_log_depth_ft = mToFt(dive.maxDepthM).toFixed(1);
  if (dive.avgDepthM != null) {
    b.odin_user_log_avg_depth_m = dive.avgDepthM.toFixed(1);
    b.odin_user_log_avg_depth_ft = mToFt(dive.avgDepthM).toFixed(1);
  }
  if (dive.waterTempC != null) {
    b.odin_user_log_watertemp_c = String(Math.round(dive.waterTempC));
    b.odin_user_log_watertemp_f = String(cToF(dive.waterTempC));
  }
  const wt = WATERTYPE[(dive.waterType || "").toLowerCase()];
  if (wt) {
    b.odin_user_log_var_watertype_id = wt;
    b.dive_site_bow = (dive.waterType || "").toLowerCase();
  }
  if (siteId) b.odin_user_log_dive_sites_id = String(siteId);
  b.odin_user_log_comment = cfg.comment || "Imported from Garmin Descent";
  return b;
}

function formEncode(obj) {
  return Object.keys(obj)
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
    .join("&");
}

const api = { DIVETYPE_FUN_DIVE, TEMPLATE, diveToForm, formEncode };
if (typeof module !== "undefined" && module.exports) module.exports = api;
