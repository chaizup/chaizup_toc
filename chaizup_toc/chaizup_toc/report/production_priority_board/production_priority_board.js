// Production Priority Board — Client-side filters + action buttons

frappe.query_reports["Production Priority Board"] = {
    filters: [
        {
            fieldname: "company",
            label: __("Company"),
            fieldtype: "Link",
            options: "Company",
            default: frappe.defaults.get_user_default("Company"),
        },
        {
            fieldname: "buffer_type",
            label: __("Buffer Type"),
            fieldtype: "Select",
            options: "\nFG\nSFG\nRM\nPM",
            description: "FG=Finished | SFG=Semi-Finished | RM=Raw Material | PM=Packaging",
        },
        {
            fieldname: "warehouse",
            label: __("Warehouse"),
            fieldtype: "Link",
            options: "Warehouse",
        },
        {
            fieldname: "zone",
            label: __("Zone Filter"),
            fieldtype: "Select",
            options: "\nGreen\nYellow\nRed\nBlack",
            description: "F3: Filter by buffer zone. Leave blank for all.",
        },
        {
            fieldname: "item_code",
            label: __("Item"),
            fieldtype: "Link",
            options: "Item",
            get_query: function() {
                return { filters: { custom_toc_enabled: 1 } };
            },
        },
    ],

    onload(report) {
        // ── ACTION BUTTON: Generate Material Requests NOW ──
        report.page.add_inner_button(__("🔴 Generate MRs Now"), function() {
            frappe.confirm(
                "<b>Run TOC Buffer Analysis Now?</b><br><br>" +
                "This will calculate all buffers and create Material Requests " +
                "for Red/Yellow zone items immediately.<br><br>" +
                "<small>Formula: F4 Order Qty = Target Buffer − Inventory Position</small>",
                function() {
                    frappe.call({
                        method: "chaizup_toc.api.toc_api.trigger_manual_run",
                        freeze: true,
                        freeze_message: __("Running TOC Buffer Analysis..."),
                        callback(r) {
                            if (r.message) {
                                let msg = `<b>${r.message.created}</b> Material Requests created.`;
                                if (r.message.material_requests && r.message.material_requests.length) {
                                    msg += "<br><br>MRs: " + r.message.material_requests.map(
                                        mr => `<a href="/app/material-request/${mr}">${mr}</a>`
                                    ).join(", ");
                                }
                                frappe.msgprint({title: "TOC Run Complete", message: msg, indicator: "green"});
                                report.refresh();
                            }
                        }
                    });
                }
            );
        }, __("Actions"));

        // ── ACTION BUTTON: Apply DAF (Seasonal Adjustment) ──
        report.page.add_inner_button(__("📅 Apply DAF"), function() {
            let d = new frappe.ui.Dialog({
                title: "Apply Demand Adjustment Factor (F6)",
                fields: [
                    {fieldtype: "Float", fieldname: "daf", label: "DAF Multiplier",
                     default: 1.0, reqd: 1,
                     description: "F6: Adjusted Buffer = Target × DAF. Diwali=1.6, Summer=0.7, Normal=1.0"},
                    {fieldtype: "Select", fieldname: "preset", label: "Or Select Preset",
                     options: "\nDiwali (1.6x)\nTrade Promotion (1.8x)\nYear-End (1.3x)\nMonsoon (0.85x)\nSummer (0.7x)\nNormal (1.0x)",
                     change: function() {
                         let map = {"Diwali (1.6x)":1.6, "Trade Promotion (1.8x)":1.8,
                                    "Year-End (1.3x)":1.3, "Monsoon (0.85x)":0.85,
                                    "Summer (0.7x)":0.7, "Normal (1.0x)":1.0};
                         let v = map[d.get_value("preset")];
                         if (v) d.set_value("daf", v);
                     }},
                    {fieldtype: "Data", fieldname: "event_name", label: "Event Name",
                     description: "Descriptive name (e.g. 'Diwali 2026')"},
                ],
                primary_action_label: "Apply to All Buffers",
                primary_action(values) {
                    frappe.call({
                        method: "chaizup_toc.api.toc_api.apply_global_daf",
                        args: {daf_value: values.daf, event_name: values.event_name},
                        freeze: true,
                        callback(r) {
                            if (r.message) {
                                frappe.msgprint(`DAF ${values.daf}x applied to ${r.message.updated_rules} buffer rules.`);
                                report.refresh();
                            }
                        }
                    });
                    d.hide();
                }
            });
            d.show();
        }, __("Actions"));

        // ── ACTION BUTTON: Reset DAF ──
        report.page.add_inner_button(__("↩️ Reset DAF"), function() {
            frappe.confirm("Reset DAF to 1.0x (Normal Operations) for all buffers?", function() {
                frappe.call({
                    method: "chaizup_toc.api.toc_api.reset_global_daf",
                    freeze: true,
                    callback(r) {
                        frappe.msgprint("DAF reset to 1.0x (Normal Operations).");
                        report.refresh();
                    }
                });
            });
        }, __("Actions"));

        // ── ACTION BUTTON: Open TOC Guide ──
        report.page.add_inner_button(__("📖 TOC Guide"), function() {
            window.open("/toc-guide", "_blank");
        });
    },

    // Row formatting — color by zone
    formatter(value, row, column, data, default_formatter) {
        value = default_formatter(value, row, column, data);

        if (data && column.fieldname === "zone") {
            let colors = {Green:"#27AE60", Yellow:"#F39C12", Red:"#E74C3C", Black:"#2C3E50"};
            let bgs = {Green:"#D5F5E3", Yellow:"#FEF9E7", Red:"#FADBD8", Black:"#D5D8DC"};
            let c = colors[data.zone] || "#7F8C8D";
            let bg = bgs[data.zone] || "#FFF";
            value = `<span style="background:${bg};color:${c};padding:3px 10px;border-radius:12px;font-weight:bold;font-size:11px">${data.zone}</span>`;
        }

        if (data && column.fieldname === "bp_pct" && data.bp_pct >= 67) {
            value = `<span style="color:#E74C3C;font-weight:bold">${data.bp_pct}%</span>`;
        } else if (data && column.fieldname === "bp_pct" && data.bp_pct >= 33) {
            value = `<span style="color:#F39C12;font-weight:bold">${data.bp_pct}%</span>`;
        }

        if (data && column.fieldname === "order_qty" && data.order_qty > 0) {
            value = `<span style="color:#E67E22;font-weight:bold">${frappe.format(data.order_qty, {fieldtype:'Float'})}</span>`;
        }

        if (data && column.fieldname === "zone_action") {
            let c = {Green:"#27AE60", Yellow:"#F39C12", Red:"#E74C3C", Black:"#E74C3C"}[data.zone] || "#7F8C8D";
            value = `<span style="color:${c};font-weight:bold">${data.zone_action}</span>`;
        }

        return value;
    },
};
