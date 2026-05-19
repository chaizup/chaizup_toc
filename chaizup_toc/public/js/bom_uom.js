/*
============================================================================
CONTEXT: BOM — UOM picker + Quantity (Output Qty) lock controller.
  MRP was removed from BOM on 2026-05-19 — a BOM is just the recipe; the
  MRP belongs to the Item master. This file is the pure UOM-picker pair
  alongside the standard `quantity` + `uom` pair on the BOM form.

  Field layout (post 2026-05-19 reposition):
     item
       → quantity   (Output Qty, in stock UOM, LOCKED for non-admin)
       → uom        (stock UOM of the FG)
       → custom_qty_in_uom   (Qty in UOM — user-typed)
       → custom_uom          (Pick UOM — filtered to item's ladder)
       → custom_uom_conversion_factor  (read-only, auto-fetched)

  Four behaviours:
    1. `custom_uom` dropdown is filtered to ONLY the UOMs in the BOM
       item's Conversion Detail ladder via `set_query` →
       `chaizup_toc.api.uom_query.get_item_uoms`.
    2. On `custom_qty_in_uom` / `custom_uom` change → resolve CF via the
       dedicated whitelisted endpoint, write CF into
       `custom_uom_conversion_factor`, and recompute the standard
       `quantity` as `custom_qty_in_uom × CF`. Standard `quantity`
       stays in stock UOM — ERPNext routings + cost-rollups assume this.
    3. On `item` change → wipe stale UOM state (different item, different
       ladder).
    4. On every refresh → lock the standard `quantity` field for all
       users EXCEPT System Manager. Auto-compute writes via
       `frm.set_value` bypass the lock; only typed edits are blocked.

MEMORY: app_chaizup_toc.md § BOM UOM-picker (2026-05-18, MRP removed +
        repositioned 2026-05-19)

INSTRUCTIONS:
  - Standard `quantity` field stays in stock UOM. Routing operations,
    BOM costing, and all downstream `flt(bom.quantity)` arithmetic
    depend on this.
  - The 3 custom fields ship as fixtures with module='Chaizup Toc'.
    A fresh `bench install-app chaizup_toc` creates them automatically.
  - CF lookup uses `chaizup_toc.api.uom_query.get_uom_conversion_factor`
    (perm-safe). Don't use `frappe.client.get_list` on UOM Conversion
    Detail — perm-blocked for non-admin.

DANGER ZONE:
  - Do NOT remove the role check on the quantity lock. Without it, a
    user typing in the field would silently desync from the UOM picker.
  - Do NOT recompute quantity when custom_uom is blank — would zero
    quantity unconditionally.
  - BOM has a child table `items` (components). This controller does
    NOT touch component qty — those use BOM Item.uom + conversion_factor
    which ERPNext handles natively.

RESTRICT:
  - Field IDs `custom_qty_in_uom` / `custom_uom` /
    `custom_uom_conversion_factor` are referenced by the fixture rows.
    Don't rename without updating fixtures/custom_field.json.
  - Don't widen the quantity lock beyond System Manager.
  - Do NOT add back a BOM.custom_mrp field. MRP lives on the Item
    master; pulling it onto BOM created redundant state with no clear
    owner. If a downstream report needs MRP for a BOM, read it from
    Item via the BOM's `item` link.
============================================================================
*/

frappe.ui.form.on("BOM", {

    onload(frm) {
        // Restrict the UOM dropdown to only this BOM-item's ladder.
        frm.set_query("custom_uom", () => ({
            query:   "chaizup_toc.api.uom_query.get_item_uoms",
            filters: {item_code: frm.doc.item || ""},
        }));
    },

    item(frm) {
        if (!frm.doc.item) return;
        // Different item → different ladder. Wipe stale UOM state.
        frm.set_value("custom_uom", "");
        frm.set_value("custom_uom_conversion_factor", 0);
        // 2026-05-19 — auto-default to the item's largest-CF UOM
        _ipv_bom_default_higher_uom(frm);
    },

    custom_uom(frm) {
        _ipv_bom_refresh_cf(frm);
    },

    custom_qty_in_uom(frm) {
        _ipv_bom_recompute_qty(frm);
    },

    custom_uom_conversion_factor(frm) {
        _ipv_bom_recompute_qty(frm);
    },

    // 2026-05-19 — REVERSE sync: standard `quantity` → custom_qty_in_uom.
    // Fires when ERPNext or admin writes the BOM quantity field; keeps
    // the UI internally consistent without a save round-trip.
    quantity(frm) {
        _ipv_bom_back_fill_qiu(frm);
    },

    refresh(frm) {
        _ipv_bom_apply_qty_lock(frm);
    },
});


// 2026-05-19 — Higher-UOM auto-default. When the user picks the BOM's
// `item`, default custom_uom to the item's largest-CF UOM so the picker
// is populated. Blank if the item has no alt UOM.
function _ipv_bom_default_higher_uom(frm) {
    if (!frm.doc.item) return;
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_default_higher_uom",
        args:   {item_code: frm.doc.item},
    }).then(r => {
        const u = ((r && r.message) || {}).uom || "";
        if (u) frm.set_value("custom_uom", u);
    });
}


// ─── UOM conversion factor lookup — perm-safe via dedicated endpoint ─────
function _ipv_bom_refresh_cf(frm) {
    if (!frm.doc.custom_uom || !frm.doc.item) {
        frm.set_value("custom_uom_conversion_factor", 0);
        return;
    }
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_uom_conversion_factor",
        args: {item_code: frm.doc.item, uom: frm.doc.custom_uom},
    }).then(r => {
        const cf = (r && r.message) ? Number(r.message) : 0;
        frm.set_value("custom_uom_conversion_factor", cf || 0);
        if (cf > 0 && (frm.doc.custom_qty_in_uom || 0) > 0) {
            _ipv_bom_recompute_qty(frm);
        }
    });
}


// ─── Recompute the standard `quantity` from the UOM input ────────────────
function _ipv_bom_recompute_qty(frm) {
    const cf  = frm.doc.custom_uom_conversion_factor || 0;
    const qiu = frm.doc.custom_qty_in_uom            || 0;
    if (!cf || cf <= 0) return;
    if (!qiu || qiu <= 0) return;
    const new_qty = qiu * cf;
    if (Math.abs((frm.doc.quantity || 0) - new_qty) > 0.0001) {
        // The `quantity` field is read-only at the UI level (locked per
        // role rule below). frm.set_value bypasses that lock — programmatic
        // writes are always honoured.
        frm.set_value("quantity", new_qty);
    }
}


// ─── REVERSE sync: standard `quantity` → custom_qty_in_uom ──────────────
function _ipv_bom_back_fill_qiu(frm) {
    const cf = frm.doc.custom_uom_conversion_factor || 0;
    if (!cf || cf <= 0) return;
    const v = (frm.doc.quantity || 0) / cf;
    if (Math.abs((frm.doc.custom_qty_in_uom || 0) - v) > 0.0001) {
        frm.set_value("custom_qty_in_uom", v);
    }
}


// ─── Lock BOM `quantity` for non-System-Manager ───────────────────────────
function _ipv_bom_apply_qty_lock(frm) {
    const isAdmin = (frappe.user_roles || []).includes("System Manager")
                 || frappe.session.user === "Administrator";
    frm.set_df_property("quantity", "read_only", isAdmin ? 0 : 1);
    const ctrl = frm.fields_dict.quantity && frm.fields_dict.quantity.$wrapper;
    if (ctrl) ctrl.toggleClass("ipv-qty-locked", !isAdmin);
    if (!isAdmin) {
        frm.set_df_property(
            "quantity", "description",
            "Locked — drive this value from \"Qty in UOM\" + \"Pick UOM\" below. " +
            "System Manager can override.",
        );
    }
}
