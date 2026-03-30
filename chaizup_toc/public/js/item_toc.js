// Item Form — TOC Setting Tab
// R1: Custom ADU toggle makes ADU field editable/read-only
// R2: All config under "TOC Setting" tab

frappe.ui.form.on("Item", {
    refresh(frm) {
        // R1: Make ADU field read-only unless Custom ADU is checked
        _toggle_adu(frm);

        if (frm.doc.custom_toc_enabled) {
            // "View Buffer Status" button
            frm.add_custom_button(__("Buffer Status"), function() {
                frappe.call({
                    method: "chaizup_toc.api.toc_api.get_priority_board",
                    args: {item_code: frm.doc.name},
                    callback(r) {
                        if (r.message && r.message.length) {
                            let d = r.message[0];
                            let color = {Green:"#27AE60",Yellow:"#F39C12",Red:"#E74C3C",Black:"#2C3E50"}[d.zone];
                            frappe.msgprint({
                                title: `Buffer Status: ${d.item_name}`,
                                indicator: d.zone==="Green"?"green":d.zone==="Yellow"?"orange":"red",
                                message: `
                                    <div style="font-size:14px;line-height:2">
                                    <b style="color:${color};font-size:22px">${d.zone} ZONE</b><br>
                                    <b>BP%:</b> ${d.bp_pct}% <small>(F3: (Target−IP)÷Target×100)</small><br>
                                    <b>Target:</b> ${d.target_buffer} <small>(F1: ADU×RLT×VF)</small><br>
                                    <b>IP:</b> ${d.inventory_position} <small>(F2)</small><br>
                                    <b>Order Qty:</b> <span style="color:#E67E22;font-size:18px;font-weight:bold">${d.order_qty}</span> <small>(F4: Target−IP)</small><br>
                                    <b>Action:</b> <span style="color:${color};font-weight:bold">${d.zone_action}</span>
                                    ${d.sfg_status ? '<hr><b>BOM/SFG:</b> ' + (d.sfg_status.message || '') : ''}
                                    </div>`
                            });
                        } else {
                            frappe.msgprint("No buffer data. Complete TOC Setting tab first.");
                        }
                    }
                });
            }, __("TOC"));

            // R3: "Check BOM Availability" button
            if (frm.doc.custom_toc_default_bom && frm.doc.custom_toc_check_bom_availability) {
                frm.add_custom_button(__("Check BOM"), function() {
                    frappe.call({
                        method: "chaizup_toc.api.toc_api.check_bom",
                        args: {item_code: frm.doc.name, qty: 1},
                        callback(r) {
                            if (r.message) {
                                let bom = r.message;
                                let html = `<b>${bom.available ? '✅ All OK' : '❌ Shortfalls Found'}</b>
                                    <br>${bom.message}<br><br>`;
                                if (bom.components && bom.components.length) {
                                    html += '<table class="table table-sm"><tr><th>Component</th><th>Type</th><th>Need</th><th>Have</th><th>Status</th></tr>';
                                    bom.components.forEach(c => {
                                        let st = c.available ? '<span style="color:green">OK</span>' :
                                            `<span style="color:red">Short: ${c.shortfall}</span>`;
                                        html += `<tr><td>${'&nbsp;'.repeat(c.depth*4)}${c.item_name}</td><td>${c.item_type||'Material'}</td>
                                            <td>${c.required_qty}</td><td>${c.available_qty}</td><td>${st}</td></tr>`;
                                    });
                                    html += '</table>';
                                }
                                frappe.msgprint({title:"BOM Availability",message:html,wide:true});
                            }
                        }
                    });
                }, __("TOC"));
            }

            frm.add_custom_button(__("Priority Board"), function() {
                frappe.set_route("query-report", "Production Priority Board");
            }, __("TOC"));
        }
    },

    // R1: Toggle ADU field editability
    custom_toc_custom_adu(frm) { _toggle_adu(frm); },

    // Mutual exclusion for Auto Purchase / Auto Manufacturing
    custom_toc_auto_purchase(frm) {
        if (frm.doc.custom_toc_auto_purchase && frm.doc.custom_toc_auto_manufacture) {
            frm.set_value("custom_toc_auto_manufacture", 0);
            frappe.show_alert("Unchecked Auto Manufacturing — choose only one.", "orange");
        }
    },
    custom_toc_auto_manufacture(frm) {
        if (frm.doc.custom_toc_auto_manufacture && frm.doc.custom_toc_auto_purchase) {
            frm.set_value("custom_toc_auto_purchase", 0);
            frappe.show_alert("Unchecked Auto Purchase — choose only one.", "orange");
        }
    },

    // F5: Auto-calc T/CU
    custom_toc_selling_price(frm) { _calc_tcu(frm); },
    custom_toc_tvc(frm) { _calc_tcu(frm); },
    custom_toc_constraint_speed(frm) { _calc_tcu(frm); },
});

function _toggle_adu(frm) {
    // R1: If Custom ADU is checked, user can edit ADU Value; otherwise read-only (auto-calculated)
    let is_custom = frm.doc.custom_toc_custom_adu;
    frm.set_df_property("custom_toc_adu_value", "read_only", is_custom ? 0 : 1);
    frm.set_df_property("custom_toc_adu_period", "hidden", is_custom ? 1 : 0);
    frm.set_df_property("custom_toc_adu_last_updated", "hidden", is_custom ? 1 : 0);
    if (is_custom) {
        frm.set_df_property("custom_toc_adu_value", "description",
            "MANUAL MODE: Enter your ADU value here. The daily auto-calculator will SKIP this item.");
    } else {
        frm.set_df_property("custom_toc_adu_value", "description",
            "AUTO MODE: Calculated daily at 6:30 AM from actual shipment/consumption data. Read-only.");
    }
}

function _calc_tcu(frm) {
    let p = flt(frm.doc.custom_toc_selling_price);
    let tvc = flt(frm.doc.custom_toc_tvc);
    let speed = flt(frm.doc.custom_toc_constraint_speed);
    if (p && speed > 0) frm.set_value("custom_toc_tcu", (p - tvc) * speed);
}
