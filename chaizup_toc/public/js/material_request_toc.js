// Material Request — TOC zone badge + priority board button
frappe.ui.form.on("Material Request", {
    refresh(frm) {
        if (frm.doc.custom_toc_recorded_by === "By System") {
            let z = frm.doc.custom_toc_zone || "Unknown";
            let c = {Red:"red",Black:"red",Yellow:"orange",Green:"green"}[z] || "blue";
            frm.set_intro(
                `<b>TOC Auto-Generated</b> | Zone: <b>${z}</b> | BP: <b>${frm.doc.custom_toc_bp_pct}%</b> | ` +
                `Target: ${frm.doc.custom_toc_target_buffer} | IP: ${frm.doc.custom_toc_inventory_position}` +
                `<br><small>F3: BP% = (Target − IP) ÷ Target × 100 | F4: Qty = Target − IP</small>`, c);
        }
        frm.add_custom_button(__("TOC Priority Board"), function() {
            frappe.set_route("query-report", "Production Priority Board");
        }, __("View"));
    }
});
