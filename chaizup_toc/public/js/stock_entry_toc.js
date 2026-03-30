// Stock Entry — TOC awareness
frappe.ui.form.on("Stock Entry", {
    refresh(frm) {
        if (frm.doc.docstatus === 0) {
            frm.add_custom_button(__("Check Buffer Impact"), function() {
                let itemSet = new Set(
                    (frm.doc.items || []).map(i => i.item_code).filter(Boolean)
                );
                if (!itemSet.size) { frappe.msgprint("Add items first."); return; }
                frappe.call({
                    method: "chaizup_toc.api.toc_api.get_priority_board",
                    callback(r) {
                        if (!r.message || !r.message.length) {
                            frappe.msgprint("No TOC buffer data found for these items.");
                            return;
                        }
                        let matches = r.message.filter(d => itemSet.has(d.item_code));
                        if (!matches.length) {
                            frappe.msgprint("None of the items in this entry are TOC-managed.");
                            return;
                        }
                        let rows = matches.map(d =>
                            `<tr>
                                <td style="padding:6px 10px;font-weight:600">${d.item_name || d.item_code}</td>
                                <td style="padding:6px 10px;color:#6b7280;font-size:12px">${d.item_code}</td>
                                <td style="padding:6px 10px">${d.zone}</td>
                                <td style="padding:6px 10px;font-family:monospace">${parseFloat(d.bp_pct||0).toFixed(1)}%</td>
                                <td style="padding:6px 10px;font-family:monospace">${parseFloat(d.inventory_position||0).toLocaleString("en-IN")}</td>
                            </tr>`
                        ).join("");
                        frappe.msgprint({
                            title: __("TOC Buffer Impact"),
                            message: `<table style="width:100%;border-collapse:collapse;font-size:13px">
                                <thead><tr style="border-bottom:1px solid #e5e7eb">
                                    <th style="padding:6px 10px;text-align:left">Item</th>
                                    <th style="padding:6px 10px;text-align:left;color:#6b7280">Code</th>
                                    <th style="padding:6px 10px;text-align:left">Zone</th>
                                    <th style="padding:6px 10px;text-align:left">BP%</th>
                                    <th style="padding:6px 10px;text-align:left">Inv. Position</th>
                                </tr></thead>
                                <tbody>${rows}</tbody>
                            </table>`,
                            wide: true
                        });
                    }
                });
            }, __("TOC"));
        }
    }
});
