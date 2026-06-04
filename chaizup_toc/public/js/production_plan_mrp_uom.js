/*
============================================================================
CONTEXT: Production Plan — UOM picker + MRP auto-fetch + qty-lock
  controller. Covers TWO child tables (refactored 2026-05-19):

    1. po_items / "Items to Manufacture"
         Fields:
           custom_qty_in_uom         (label "Planned Qty in UOM")
           custom_uom                (label "UOM[TOC]")
           custom_uom_conversion_factor
           custom_mrp_source / custom_mrp (existing from 2026-05-18)
         Behaviour:
           UOM-conversion math drives the standard `planned_qty` field.
           Property Setter pushes `planned_qty.idx` and `stock_uom.idx`
           to 50/51 so the standard "Planned" + "UOM" columns appear at
           the END of the grid; the custom UOM picker takes cols 3 & 4.

    2. sub_assembly_items / "Sub Assembly Items"
         Fields:
           custom_required_qty_in_uom    (label "Required Qty in UOM")
           custom_uom                    (label "UOM[TOC]", cols 4-5)
           custom_projected_qty_in_uom   (read-only, "Projected Qty in UOM")
           custom_qty_to_order_in_uom    ("Qty to Order in UOM")
           custom_uom_conversion_factor
         Behaviour:
           ONE UOM picker per row, drives THREE qty fields:
             custom_required_qty_in_uom    × CF → required_qty
             custom_projected_qty_in_uom (read-only display) = projected_qty / CF
             custom_qty_to_order_in_uom    × CF → qty
           Property Setter pushes required_qty/projected_qty/qty.idx to
           50/51/52 so the three standard qty columns appear LAST.

  Cross-table mechanics:
    - Both child grids restrict `custom_uom` dropdown via
      `grid.get_field("custom_uom").get_query` → chaizup_toc.api.uom_query
      .get_item_uoms with the row's item_code as filter.
    - CF lookup uses chaizup_toc.api.uom_query.get_uom_conversion_factor
      (perm-safe).
    - Standard qty fields (planned_qty / required_qty / qty) are locked
      for non-System-Manager via grid.get_field(fn).df.read_only. The
      UOM-driven auto-compute uses frappe.model.set_value which bypasses
      the lock.

MEMORY: app_chaizup_toc.md § PP grid refactor (2026-05-19)

DANGER ZONE:
  - Different child tables call their FG-link field differently:
      Production Plan Item              → `item_code`
      Production Plan Sub Assembly Item → `production_item`
    We branch on cdt to pick the right field.
  - Different child tables call their stock-UOM-qty field differently:
      po_items.planned_qty
      sub_assembly_items.required_qty / projected_qty / qty
    Same — branch by cdt.

RESTRICT:
  - Field IDs are referenced by fixtures and the engine. Don't rename.
  - Don't widen the qty lock beyond System Manager.
============================================================================
*/

// =============================================================================
// PARENT — Production Plan (set_query wiring + qty lock + column reorder
//                            per child grid)
// =============================================================================
frappe.ui.form.on("Production Plan", {
    onload(frm)  {
        _ipv_pp_reorder_grid_columns(frm);
        _ipv_pp_wire_grids(frm);
    },
    refresh(frm) {
        _ipv_pp_reorder_grid_columns(frm);
        _ipv_pp_wire_grids(frm);
        _ipv_pp_apply_qty_locks(frm);
    },
});


// 2026-05-19 — Reorder grid columns by mutating docfield.idx at runtime.
//   Frappe's Property Setter does NOT honour `idx` (the field-order
//   metadata is loaded once and cached). The reliable way to reorder
//   grid columns is to mutate the docfield list before the grid renders.
//
// What this does (per the user's spec):
//   po_items (Items to Manufacture):
//     col 1: item_code (unchanged)
//     col 2: bom_no (unchanged)
//     col 3: custom_qty_in_uom  ("Planned Qty in UOM")
//     col 4: custom_uom         ("UOM[TOC]")
//     ... mid-grid columns ...
//     col last:  planned_qty   ("Planned")
//     col last+: stock_uom     ("UOM")
//   sub_assembly_items (Sub Assembly Items):
//     col 1: production_item
//     col 2: bom_no
//     col 3: type_of_manufacturing
//     col 4: custom_required_qty_in_uom
//     col 5: custom_uom
//     col 6: custom_projected_qty_in_uom
//     col 7: custom_qty_to_order_in_uom
//     ... other cols ...
//     col last:    required_qty
//     col last+1:  projected_qty
//     col last+2:  qty                (Qty to Order)
function _ipv_pp_reorder_grid_columns(frm) {
    const push_to_end = {
        "po_items": ["planned_qty", "stock_uom"],
        "sub_assembly_items": ["required_qty", "projected_qty", "qty"],
    };
    Object.keys(push_to_end).forEach(table_fn => {
        const grid = frm.fields_dict[table_fn] && frm.fields_dict[table_fn].grid;
        if (!grid || !grid.docfields) return;
        const targets = push_to_end[table_fn];
        // Bump idx of each target to a value higher than any current
        // docfield idx. Iterate in the order given so the relative
        // order between targets is preserved (planned → uom, etc).
        let max_idx = 0;
        grid.docfields.forEach(f => { if ((f.idx || 0) > max_idx) max_idx = f.idx; });
        targets.forEach((fn, i) => {
            const fld = grid.docfields.find(f => f.fieldname === fn);
            if (fld) fld.idx = max_idx + 100 + i;   // safely past everything
        });
        // Frappe's grid sorts docfields by idx on every render — by
        // mutating idx in place we ensure the next refresh picks the
        // new order. A grid.refresh() is called by the lock-apply
        // helper later.
    });
}


function _ipv_pp_wire_grids(frm) {
    // po_items → custom_uom set_query filtered by row.item_code
    if (frm.fields_dict.po_items && frm.fields_dict.po_items.grid) {
        const fld = frm.fields_dict.po_items.grid.get_field("custom_uom");
        if (fld) {
            fld.get_query = function (doc, cdt, cdn) {
                const row = locals[cdt][cdn] || {};
                return {
                    query:   "chaizup_toc.api.uom_query.get_item_uoms",
                    filters: {item_code: row.item_code || ""},
                };
            };
        }
    }
    // sub_assembly_items → custom_uom set_query filtered by row.production_item
    if (frm.fields_dict.sub_assembly_items
        && frm.fields_dict.sub_assembly_items.grid) {
        const fld = frm.fields_dict.sub_assembly_items.grid.get_field("custom_uom");
        if (fld) {
            fld.get_query = function (doc, cdt, cdn) {
                const row = locals[cdt][cdn] || {};
                return {
                    query:   "chaizup_toc.api.uom_query.get_item_uoms",
                    filters: {item_code: row.production_item || ""},
                };
            };
        }
    }
}


function _ipv_pp_apply_qty_locks(frm) {
    const isAdmin = (frappe.user_roles || []).includes("System Manager")
                 || frappe.session.user === "Administrator";
    const lock = (grid, fieldname) => {
        if (!grid) return;
        const fld = grid.get_field(fieldname);
        if (fld) fld.df.read_only = isAdmin ? 0 : 1;
    };
    if (frm.fields_dict.po_items && frm.fields_dict.po_items.grid) {
        lock(frm.fields_dict.po_items.grid, "planned_qty");
        frm.fields_dict.po_items.grid.refresh();
    }
    if (frm.fields_dict.sub_assembly_items
        && frm.fields_dict.sub_assembly_items.grid) {
        const sg = frm.fields_dict.sub_assembly_items.grid;
        lock(sg, "required_qty");
        lock(sg, "qty");                // "Qty to Order"
        // projected_qty is naturally read-only in ERPNext — but reassert
        // here in case a future site customisation flips it editable.
        lock(sg, "projected_qty");
        sg.refresh();
    }
}


// =============================================================================
// CHILD — Production Plan Item ("Items to Manufacture")
// =============================================================================
frappe.ui.form.on("Production Plan Item", {

    item_code(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.item_code) return;
        // Wipe stale UOM state — different item, different ladder.
        frappe.model.set_value(row.doctype, row.name, "custom_uom", "");
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", 0);
        _ipv_ppi_fetch_mrp(frm, row);
        // 2026-05-19 — auto-default custom_uom to the item's largest-CF UOM
        _ipv_ppi_default_higher_uom(row);
    },

    custom_mrp_source(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (row.custom_mrp_source === "Auto from Item") {
            _ipv_ppi_fetch_mrp(frm, row, /* force */ true);
        }
    },

    custom_uom(frm, cdt, cdn) {
        _ipv_ppi_refresh_cf(frm, locals[cdt][cdn]);
    },

    custom_qty_in_uom(frm, cdt, cdn) {
        _ipv_ppi_recompute_qty(frm, locals[cdt][cdn]);
    },

    custom_uom_conversion_factor(frm, cdt, cdn) {
        _ipv_ppi_recompute_qty(frm, locals[cdt][cdn]);
    },

    // 2026-05-19 — REVERSE sync: standard planned_qty → custom_qty_in_uom.
    // Catches ERPNext/scripted writes that bypass the custom inputs (e.g.,
    // BOM explosion, scheduler back-fills). Forward sync (custom → std)
    // happens via _ipv_ppi_recompute_qty above.
    planned_qty(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        const cf  = row.custom_uom_conversion_factor || 0;
        if (!cf || cf <= 0) return;
        const v = (row.planned_qty || 0) / cf;
        if (Math.abs((row.custom_qty_in_uom || 0) - v) > 0.0001) {
            frappe.model.set_value(row.doctype, row.name,
                                   "custom_qty_in_uom", v);
        }
    },
});


// 2026-05-19 — Higher-UOM auto-default for PPI rows. When the user picks
// an item_code on the "Items to Manufacture" row, pre-fill custom_uom
// with the item's largest-CF UOM. The custom_uom event handler then
// chains the CF + qty recompute.
function _ipv_ppi_default_higher_uom(row) {
    if (!row.item_code) return;
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_default_higher_uom",
        args:   {item_code: row.item_code},
    }).then(r => {
        const u = ((r && r.message) || {}).uom || "";
        if (u) frappe.model.set_value(row.doctype, row.name, "custom_uom", u);
    });
}

// Same for Sub Assembly rows (different item field name).
function _ipv_sub_default_higher_uom(row) {
    if (!row.production_item) return;
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_default_higher_uom",
        args:   {item_code: row.production_item},
    }).then(r => {
        const u = ((r && r.message) || {}).uom || "";
        if (u) frappe.model.set_value(row.doctype, row.name, "custom_uom", u);
    });
}


function _ipv_ppi_fetch_mrp(frm, row, force) {
    if (row.custom_mrp_source !== "Auto from Item" && !force) return;
    if (!row.item_code) return;
    frappe.db.get_value("Item", row.item_code, "custom_mrp")
        .then(r => {
            const v = (r && r.message) ? r.message.custom_mrp : null;
            if (v !== undefined) {
                frappe.model.set_value(row.doctype, row.name,
                                       "custom_mrp", v || 0);
            }
        });
}

function _ipv_ppi_refresh_cf(frm, row) {
    if (!row.custom_uom || !row.item_code) {
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", 0);
        return;
    }
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_uom_conversion_factor",
        args: {item_code: row.item_code, uom: row.custom_uom},
    }).then(r => {
        const cf = (r && r.message) ? Number(r.message) : 0;
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", cf || 0);
        if (cf > 0 && (row.custom_qty_in_uom || 0) > 0) {
            _ipv_ppi_recompute_qty(frm, row);
        }
    });
}

function _ipv_ppi_recompute_qty(frm, row) {
    const cf  = row.custom_uom_conversion_factor || 0;
    const qiu = row.custom_qty_in_uom            || 0;
    if (!cf || cf <= 0) return;
    if (!qiu || qiu <= 0) return;
    const new_qty = qiu * cf;
    if (Math.abs((row.planned_qty || 0) - new_qty) > 0.0001) {
        frappe.model.set_value(row.doctype, row.name,
                               "planned_qty", new_qty);
    }
}


// =============================================================================
// CHILD — Production Plan Sub Assembly Item
// =============================================================================
frappe.ui.form.on("Production Plan Sub Assembly Item", {

    production_item(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (!row.production_item) return;
        frappe.model.set_value(row.doctype, row.name, "custom_uom", "");
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", 0);
        // 2026-05-19 — auto-default custom_uom to the item's largest-CF UOM
        _ipv_sub_default_higher_uom(row);
    },

    custom_uom(frm, cdt, cdn) {
        _ipv_sub_refresh_cf(frm, locals[cdt][cdn]);
    },

    custom_required_qty_in_uom(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        _ipv_sub_recompute_qty(row, "custom_required_qty_in_uom", "required_qty");
    },

    custom_qty_to_order_in_uom(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        _ipv_sub_recompute_qty(row, "custom_qty_to_order_in_uom", "qty");
    },

    custom_uom_conversion_factor(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        // CF changed (likely from a UOM change). Recompute all three
        // qty pairs so the row stays internally consistent.
        _ipv_sub_recompute_qty(row, "custom_required_qty_in_uom", "required_qty");
        _ipv_sub_recompute_qty(row, "custom_qty_to_order_in_uom", "qty");
        _ipv_sub_recompute_projected(row);
    },

    required_qty(frm, cdt, cdn) {
        // Reverse direction: when ERPNext writes required_qty (e.g.,
        // during BOM explosion), back-fill custom_required_qty_in_uom
        // so the user sees a coherent value.
        _ipv_sub_back_fill(locals[cdt][cdn], "required_qty",
                           "custom_required_qty_in_uom");
    },

    projected_qty(frm, cdt, cdn) {
        _ipv_sub_recompute_projected(locals[cdt][cdn]);
    },

    qty(frm, cdt, cdn) {
        _ipv_sub_back_fill(locals[cdt][cdn], "qty",
                           "custom_qty_to_order_in_uom");
    },
});


function _ipv_sub_refresh_cf(frm, row) {
    if (!row.custom_uom || !row.production_item) {
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", 0);
        return;
    }
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_uom_conversion_factor",
        args: {item_code: row.production_item, uom: row.custom_uom},
    }).then(r => {
        const cf = (r && r.message) ? Number(r.message) : 0;
        frappe.model.set_value(row.doctype, row.name,
                               "custom_uom_conversion_factor", cf || 0);
    });
}

function _ipv_sub_recompute_qty(row, qiu_field, std_field) {
    const cf  = row.custom_uom_conversion_factor || 0;
    const qiu = row[qiu_field] || 0;
    if (!cf || cf <= 0) return;
    if (!qiu || qiu <= 0) return;
    const new_qty = qiu * cf;
    if (Math.abs((row[std_field] || 0) - new_qty) > 0.0001) {
        frappe.model.set_value(row.doctype, row.name, std_field, new_qty);
    }
}

// projected_qty is read-only / system-computed; we DISPLAY it in UOM.
function _ipv_sub_recompute_projected(row) {
    const cf = row.custom_uom_conversion_factor || 0;
    if (!cf || cf <= 0) {
        frappe.model.set_value(row.doctype, row.name,
                               "custom_projected_qty_in_uom", 0);
        return;
    }
    const v = (row.projected_qty || 0) / cf;
    frappe.model.set_value(row.doctype, row.name,
                           "custom_projected_qty_in_uom", v);
}

// Reverse fill — when a standard qty field is written (BOM explosion,
// scheduler), populate the corresponding "in UOM" field so the row
// stays consistent for the user.
function _ipv_sub_back_fill(row, std_field, qiu_field) {
    const cf = row.custom_uom_conversion_factor || 0;
    if (!cf || cf <= 0) return;
    const std = row[std_field] || 0;
    const v   = std / cf;
    if (Math.abs((row[qiu_field] || 0) - v) > 0.0001) {
        frappe.model.set_value(row.doctype, row.name, qiu_field, v);
    }
}

// =============================================================================
// Production Plan — TOC "Recorded By" + "Creation Reason" read-only rules
// (2026-06-04). custom_recorded_by (Select User/System, renamed from the old
// "Created By") + custom_creation_reason (Text Editor, formatted "why").
//   - recorded_by is read-only.
//   - System rows -> reason read-only; User rows -> editable before submit.
// =============================================================================
frappe.ui.form.on("Production Plan", {
    refresh(frm) { _toc_pp_recorded_rules(frm); },
    custom_recorded_by(frm) { _toc_pp_recorded_rules(frm); },
});

function _toc_pp_recorded_rules(frm) {
    if (frm.fields_dict.custom_recorded_by) {
        frm.set_df_property("custom_recorded_by", "read_only", 1);
    }
    if (frm.fields_dict.custom_creation_reason) {
        const is_system = frm.doc.custom_recorded_by === "System";
        frm.set_df_property("custom_creation_reason", "read_only", is_system ? 1 : 0);
    }
}
