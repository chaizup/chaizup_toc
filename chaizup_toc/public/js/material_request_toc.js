// =============================================================================
// Material Request — TOC client script
// CONTEXT: TOC auto-generates Material Requests (purpose=Purchase) for purchase-
//   mode items. Each carries:
//     custom_toc_recorded_by   (Select "By User" / "By System", READ-ONLY)
//     custom_toc_creation_reason (Text Editor, rich formatted "why")
// RULES (2026-06-04):
//   - recorded_by is ALWAYS read-only (set by the system / defaulted; the user
//     never edits who/what created the request).
//   - If recorded_by == "By System" -> the reason is the engine's formatted
//     explanation and is READ-ONLY.
//   - If recorded_by == "By User"   -> the user may edit the reason BEFORE submit
//     (after submit it locks like the rest of the doc).
// RESTRICT: do not make recorded_by editable; downstream TOC reports + the MR
//   netting query treat "By System" as the engine's own marker.
// =============================================================================
frappe.ui.form.on("Material Request", {
    refresh(frm) {
        _toc_apply_recorded_by_rules(frm);

        if (frm.doc.custom_toc_recorded_by === "By System") {
            let z = frm.doc.custom_toc_zone || "Unknown";
            let c = {Red:"red",Black:"red",Yellow:"orange",Green:"green"}[z] || "blue";
            frm.set_intro(
                `<b>TOC Auto-Generated</b> | Zone: <b>${z}</b> | BP: <b>${frm.doc.custom_toc_bp_pct || 0}%</b> | ` +
                `Target: ${frm.doc.custom_toc_target_buffer || 0} | IP: ${frm.doc.custom_toc_inventory_position || 0}` +
                `<br><small>F3: BP% = (Target − IP) ÷ Target × 100 | F4: Qty = Target − IP</small>`, c);
        }
        frm.add_custom_button(__("TOC Priority Board"), function() {
            frappe.set_route("query-report", "Production Priority Board");
        }, __("View"));
    },

    // Re-evaluate if recorded_by somehow changes (e.g. a script sets it).
    custom_toc_recorded_by(frm) {
        _toc_apply_recorded_by_rules(frm);
    },
});

function _toc_apply_recorded_by_rules(frm) {
    // recorded_by is always read-only.
    frm.set_df_property("custom_toc_recorded_by", "read_only", 1);

    const is_system = frm.doc.custom_toc_recorded_by === "By System";
    // System reason = engine output (read-only). User reason = editable until submit.
    const reason_ro = is_system ? 1 : 0;
    frm.set_df_property("custom_toc_creation_reason", "read_only", reason_ro);
}
