// Item Form — TOC Setting Tab
// R1: Custom ADU toggle makes ADU field editable/read-only
// R2: All config under "TOC Setting" tab
// R3: Item Min Order Qty child table — auto-populate readonly fields, filter UOM list,
//     guard against row creation before item is saved.

frappe.ui.form.on("Item", {
    refresh(frm) {
        // R1: Make ADU field read-only unless Custom ADU is checked
        _toggle_adu(frm);

        // R3: Disable "Add Row" in Min Order Qty table if item is not yet saved
        _setup_min_order_qty_grid(frm);

        // IMM-001 (2026-05-13): Same treatment for the
        // custom_minimum_manufacture table (Item Minimum Manufacture),
        // plus a hard gate: rows cannot be added until parent UOMs are
        // configured + saved. Max Level auto-calc happens client-side
        // for instant feedback; server-side validate() is the source of
        // truth.
        _setup_min_mfg_grid(frm);

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

    after_save(frm) {
        // Re-enable Min Order Qty grid after the item is saved for the first time
        _setup_min_order_qty_grid(frm);
        // IMM-001: refresh the Min Manufacture grid too — when the user
        // adds rows to "Units of Measure" and saves, the UOM filter must
        // re-evaluate against the new list.
        _setup_min_mfg_grid(frm);
    },

    // IMM-001: whenever the parent UOMs table is touched, refresh the
    // Min Manufacture grid filter so the UOM dropdown stays in sync
    // without requiring a save first.
    uoms_on_form_rendered(frm) { _setup_min_mfg_grid(frm); },

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

// ─── R3: Item Min Order Qty child table handlers ──────────────────────────────

function _setup_min_order_qty_grid(frm) {
    // Guard: disable Add Row if the item is not yet saved
    let grid = frm.get_field("custom_min_order_qty") && frm.get_field("custom_min_order_qty").grid;
    if (!grid) return;

    if (frm.is_new()) {
        grid.cannot_add_rows = true;
        grid.wrapper.find(".grid-add-row, .grid-footer .btn-open-row").hide();
        grid.wrapper.find(".grid-add-row-btn").hide();
    } else {
        grid.cannot_add_rows = false;
        grid.wrapper.find(".grid-add-row, .grid-footer .btn-open-row").show();
        grid.wrapper.find(".grid-add-row-btn").show();
    }

    // Filter UOM list to only UOMs in the item's "Units of Measure" section + stock_uom
    frm.set_query("uom", "custom_min_order_qty", function() {
        let configured_uoms = (frm.doc.uoms || []).map(r => r.uom).filter(Boolean);
        if (frm.doc.stock_uom && !configured_uoms.includes(frm.doc.stock_uom)) {
            configured_uoms.push(frm.doc.stock_uom);
        }
        if (!configured_uoms.length) return {};
        return { filters: [["UOM", "name", "in", configured_uoms]] };
    });
}

frappe.ui.form.on("Item Min Order Qty", {
    // Guard: block row creation before item is saved
    form_render(frm, cdt, cdn) {
        if (frm.is_new()) {
            frappe.model.delete_doc(cdt, cdn);
            frappe.msgprint({
                title: __("Save Required"),
                message: __("Save the Item first before adding Min Order Qty rules."),
                indicator: "orange",
            });
            return;
        }
        // Auto-populate stock_uom when the row is opened
        let row = locals[cdt][cdn];
        if (!row.stock_uom && frm.doc.stock_uom) {
            frappe.model.set_value(cdt, cdn, "stock_uom", frm.doc.stock_uom);
        }
    },

    // When UOM changes: fetch conversion_factor and recompute stock_uom_qty
    uom(frm, cdt, cdn) {
        let row = locals[cdt][cdn];
        if (!row.uom) {
            frappe.model.set_value(cdt, cdn, "conversion_factor", "");
            frappe.model.set_value(cdt, cdn, "stock_uom_qty", "");
            return;
        }
        // Always stamp stock_uom from the parent item
        frappe.model.set_value(cdt, cdn, "stock_uom", frm.doc.stock_uom);

        if (row.uom === frm.doc.stock_uom) {
            frappe.model.set_value(cdt, cdn, "conversion_factor", 1.0);
            _recompute_stock_uom_qty(cdt, cdn, row.min_order_qty, 1.0);
            return;
        }

        // Read conversion_factor from frm.doc.uoms (already in memory — no API call needed)
        let uom_row = (frm.doc.uoms || []).find(r => r.uom === row.uom);
        let cf = uom_row ? flt(uom_row.conversion_factor) : 1.0;
        if (!cf) cf = 1.0;
        frappe.model.set_value(cdt, cdn, "conversion_factor", cf);
        _recompute_stock_uom_qty(cdt, cdn, row.min_order_qty, cf);
    },

    // When min_order_qty changes: recompute stock_uom_qty client-side
    min_order_qty(frm, cdt, cdn) {
        let row = locals[cdt][cdn];
        let cf = flt(row.conversion_factor) || 1.0;
        _recompute_stock_uom_qty(cdt, cdn, row.min_order_qty, cf);
    },
});

function _recompute_stock_uom_qty(cdt, cdn, min_order_qty, conversion_factor) {
    let qty = flt(min_order_qty) * (flt(conversion_factor) || 1.0);
    frappe.model.set_value(cdt, cdn, "stock_uom_qty", qty);
}

// ─── IMM-001 (2026-05-13): Item Minimum Manufacture (per-warehouse MINMFG) ──
//
// CONTEXT:
//   Item.custom_minimum_manufacture is the per-warehouse table that drives
//   the Production Plan Engine MINMFG floor (`_build_min_mfg_map`). The
//   user wants:
//     1. The UOM Link column in each row may only show UOMs configured in
//        the parent Item's "Units of Measure" table (or stock_uom).
//     2. Rows must NOT be addable until the parent Item has at least one
//        UOM row configured AND has been saved.
//     3. Three new columns — Lead Time (days), Safety Factor, Max Level —
//        with `max_level` auto-calculated on the client (and authoritatively
//        on the server in ItemMinimumManufacture.validate).
//
// DANGER:
//   - The grid filter and Add-Row guard depend on the child fieldname
//     `custom_minimum_manufacture`. Renaming the custom field on Item
//     breaks both. Re-export the fixtures and update this file together.
//   - Do not auto-create rows on UOM change in the parent — that masks
//     the "must save UOMs first" gate which is the whole point.
//
// RESTRICT:
//   - Auto-recompute fires on min_manufacturing_qty / lead_time_days /
//     safety_factor changes ONLY. Do NOT bind a recompute to `max_level`
//     itself — infinite loop.
//   - Do NOT use frm.set_query to filter on `frm.doc.uoms` without first
//     checking that frm.doc.uoms is a non-empty array. An empty `in` filter
//     would silently allow every UOM (Frappe drops empty IN filters).
//
// ────────────────────────────────────────────────────────────────────────

function _setup_min_mfg_grid(frm) {
    const field = frm.get_field("custom_minimum_manufacture");
    const grid  = field && field.grid;
    if (!grid) return;

    const configured_uoms = ((frm.doc.uoms || [])
        .map(r => r.uom)
        .filter(Boolean));
    if (frm.doc.stock_uom && !configured_uoms.includes(frm.doc.stock_uom)) {
        configured_uoms.push(frm.doc.stock_uom);
    }
    const has_uoms     = configured_uoms.length > 0;
    const is_new       = frm.is_new();
    const can_add_rows = has_uoms && !is_new;

    // Add-Row gate: the Frappe grid exposes `cannot_add_rows` + a "+ Add row"
    // button. Toggle both so the affordance disappears entirely.
    grid.cannot_add_rows = !can_add_rows;
    grid.wrapper.find(".grid-add-row, .grid-add-row-btn, .grid-footer .btn-open-row")
        [can_add_rows ? "show" : "hide"]();
    grid.refresh();

    // Visible hint above the grid so the user understands why Add Row is
    // hidden. We inject once and re-evaluate the text on every refresh.
    const hint_id = "wkp-imm-uom-gate-hint";
    let hint = grid.wrapper.find("#" + hint_id);
    if (!hint.length) {
        hint = $(`<div id="${hint_id}" class="text-muted" style="font-size:11px;margin:4px 8px 0;"></div>`);
        grid.wrapper.prepend(hint);
    }
    if (!can_add_rows) {
        hint.html(is_new
            ? "<i class='fa fa-info-circle'></i> Save the Item first before adding Min Manufacture / Purchase rows."
            : "<i class='fa fa-info-circle'></i> Add at least one row under <b>Units of Measure</b> (and save the Item) before adding Min Manufacture / Purchase rules.");
        hint.show();
    } else {
        hint.hide();
    }

    // UOM column query — restrict to the configured UOMs only.
    frm.set_query("uom", "custom_minimum_manufacture", function() {
        if (!has_uoms) {
            // Defensive: should be unreachable because rows cannot be
            // added in this state. If somehow reached (e.g. stale rows
            // imported via fixtures), return a clause that matches
            // nothing rather than every UOM.
            return { filters: [["UOM", "name", "=", "__never_matches__"]] };
        }
        return { filters: [["UOM", "name", "in", configured_uoms]] };
    });
}

frappe.ui.form.on("Item Minimum Manufacture", {
    form_render(frm, cdt, cdn) {
        // Hard guard: if the user somehow opens an unsaved item and clicks
        // Add Row anyway, remove the row immediately.
        const configured_uoms = ((frm.doc.uoms || [])
            .map(r => r.uom)
            .filter(Boolean));
        if (frm.is_new() || configured_uoms.length === 0) {
            frappe.model.delete_doc(cdt, cdn);
            frappe.msgprint({
                title: __("UOMs Required"),
                message: __("Add at least one row under <b>Units of Measure</b> (and save the Item) before adding rows here. The dropdown is scoped to the UOMs you configure there."),
                indicator: "orange",
            });
            return;
        }
        // IMM-003: sync the row-level read-only state on adu to the
        // current auto_adu toggle so a freshly rendered row shows the
        // right affordance.
        _toggle_adu_readonly(frm, cdt, cdn);
    },

    // IMM-002 (2026-05-13): max_level = ADU × lead × safety. Daily engine
    // task `update_min_mfg_adu_levels` writes ADU when Auto ADU is ON
    // and the SLE history covers the lookback window. The form recomputes
    // max_level on every edit of lead / safety so the user sees the new
    // cap without waiting for the next scheduled run.
    //
    // IMM-003 (2026-05-13): per-row Auto ADU switch. When ON, adu is
    // read-only and engine-managed; when OFF, the user enters adu by
    // hand and the engine skips the row entirely.
    auto_adu(frm, cdt, cdn) {
        _toggle_adu_readonly(frm, cdt, cdn);
        const row = locals[cdt][cdn];
        if (!cint(row.auto_adu)) {
            frappe.show_alert({
                message: __("Auto ADU switched OFF — enter the ADU manually. The engine will leave this row alone."),
                indicator: "blue",
            }, 6);
        } else {
            frappe.show_alert({
                message: __("Auto ADU switched ON — the engine will refresh ADU at 06:35 AM daily once enough history exists for this item × warehouse."),
                indicator: "blue",
            }, 6);
        }
    },
    adu                  (frm, cdt, cdn) { _recompute_max_level(cdt, cdn); },
    lead_time_days       (frm, cdt, cdn) { _recompute_max_level(cdt, cdn); },
    safety_factor        (frm, cdt, cdn) { _recompute_max_level(cdt, cdn); },

    // UOM change: client-side sanity check. The set_query already restricts
    // the dropdown, but a paste / scripted set could bypass it; warn the
    // user immediately rather than waiting for server validation.
    uom(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.uom) return;
        const allowed = ((frm.doc.uoms || [])
            .map(r => r.uom)
            .filter(Boolean));
        if (frm.doc.stock_uom && !allowed.includes(frm.doc.stock_uom)) {
            allowed.push(frm.doc.stock_uom);
        }
        if (!allowed.includes(row.uom)) {
            frappe.show_alert({
                message: __("UOM <b>{0}</b> is not configured on this Item. Pick one from the configured list, or add it under Units of Measure first.",
                            [frappe.utils.escape_html(row.uom)]),
                indicator: "red",
            }, 6);
            frappe.model.set_value(cdt, cdn, "uom", "");
        }
    },
});

function _toggle_adu_readonly(frm, cdt, cdn) {
    // IMM-003: flip the `adu` cell between editable + read-only based on
    // the row-level Auto ADU toggle. The grid keeps a per-row map of
    // read-only columns; we set it via `grid_row.toggle_editable` which
    // updates the cell DOM in-place without a re-render.
    const grid_row = frm.fields_dict
        && frm.fields_dict.custom_minimum_manufacture
        && frm.fields_dict.custom_minimum_manufacture.grid
        && frm.fields_dict.custom_minimum_manufacture.grid.grid_rows_by_docname[cdn];
    if (!grid_row) return;
    const row = locals[cdt][cdn];
    const auto = cint(row.auto_adu);
    // Editable when auto OFF; read-only when auto ON.
    grid_row.toggle_editable("adu", !auto);
}

function _recompute_max_level(cdt, cdn) {
    // IMM-002: max_level = ADU × lead × safety (was qty × lead × safety
    // under IMM-001 — that earlier formula was wrong; ADU is the right
    // driver because lead-time cover depends on the consumption rate,
    // not the batch size).
    const row = locals[cdt][cdn];
    if (!row) return;
    const adu  = flt(row.adu || 0);
    const lead = flt(row.lead_time_days || 0);
    let sf     = flt(row.safety_factor || 0);
    if (sf === 0) sf = 1.0;     // mirrors server-side default
    const lvl  = Math.round(adu * lead * sf * 1000) / 1000;
    if (flt(row.max_level) !== lvl) {
        frappe.model.set_value(cdt, cdn, "max_level", lvl);
    }
}
