/*
============================================================================
CONTEXT: Work Order — MRP auto-fetch + UOM conversion + qty-lock client
  controller. Adds five behaviours to the WO form:

    1. On `production_item` change → fetch `Item.custom_mrp` into
       `custom_mrp` UNLESS `custom_mrp_source` is "Manual".
    2. `custom_uom` dropdown is filtered to ONLY the UOMs defined in the
       production item's UOM Conversion Detail ladder. No more 200-row
       global UOM dropdown.
    3. On `custom_qty_in_uom` / `custom_uom` change → resolve CF via the
       dedicated whitelisted endpoint (perm-safe; child DocType direct
       reads were blocked), write CF into `custom_uom_conversion_factor`,
       and recompute the standard `qty` as `custom_qty_in_uom × CF`. This
       lets users enter "5 Carton" and the WO saves with qty = 5000 Pcs.
    4. On `custom_mrp_source` change → re-trigger MRP fetch + clear
       manual entry if user switches from Manual back to Auto.
    5. On every refresh → lock the standard `qty` ("Qty To Manufacture")
       field for all users EXCEPT System Manager. This enforces "the qty
       is driven by the UOM picker; only the admin can override" by
       making the field read-only at the UI level.

MEMORY: app_chaizup_toc.md § MRP & UOM custom fields (added 2026-05-18,
        polish 2026-05-19)

INSTRUCTIONS:
  - The standard `qty` field stays in stock UOM. Downstream ERPNext
    reports + Stock Entries assume this — never change.
  - CF lookup uses `chaizup_toc.api.uom_query.get_uom_conversion_factor`.
    The previous frappe.client.get_list approach was perm-blocked because
    UOM Conversion Detail is a child DocType and Frappe restricts direct
    child reads to admins.
  - The UOM set_query also points to that module: `get_item_uoms` is a
    Frappe link-query function that uses the `filters` arg to scope by
    item_code.

DANGER ZONE:
  - Do NOT remove the role check on the qty lock. Without it, the
    auto-computed qty can be silently destroyed by a user pressing a key
    in the field, which then desyncs from the UOM picker.
  - Do NOT recompute qty when custom_uom is blank. That would zero the
    qty unconditionally — bad UX.

RESTRICT:
  - Field IDs `custom_mrp` / `custom_mrp_source` / `custom_qty_in_uom` /
    `custom_uom` / `custom_uom_conversion_factor` are referenced by the
    server-side engine (production_plan_engine.py). Renaming any of these
    breaks the Auto creation path.
  - Do NOT widen the qty lock beyond System Manager. The lock is the
    safety net that keeps qty in sync with the UOM picker; any other
    role bypassing it would re-introduce the "qty edited away from UOM"
    drift this controller exists to prevent.
============================================================================
*/

frappe.ui.form.on("Work Order", {

    onload(frm) {
        // Restrict the UOM dropdown to only this item's ladder.
        // Frappe rebuilds the query each time the field is opened, so
        // dynamic frm.doc.production_item lookups work — no need to
        // re-bind on production_item change.
        frm.set_query("custom_uom", () => ({
            query:   "chaizup_toc.api.uom_query.get_item_uoms",
            filters: {item_code: frm.doc.production_item || ""},
        }));
    },

    production_item(frm) {
        if (!frm.doc.production_item) return;
        // Clear any stale UOM-driven state when the FG changes.
        frm.set_value("custom_uom", "");
        frm.set_value("custom_uom_conversion_factor", 0);
        _ipv_wo_fetch_mrp(frm);
        // 2026-05-19 — auto-default custom_uom to the item's largest-CF
        // UOM (the "higher UOM"). User can still pick a different UOM
        // from the dropdown (still filtered to this item's ladder).
        _ipv_wo_default_higher_uom(frm);
    },

    custom_mrp_source(frm) {
        if (frm.doc.custom_mrp_source === "Auto from Item") {
            _ipv_wo_fetch_mrp(frm, /* force */ true);
        }
    },

    custom_uom(frm) {
        _ipv_wo_refresh_cf(frm);
    },

    custom_qty_in_uom(frm) {
        _ipv_wo_recompute_qty(frm);
    },

    custom_uom_conversion_factor(frm) {
        _ipv_wo_recompute_qty(frm);
    },

    // 2026-05-19 — REVERSE sync: when something writes the standard `qty`
    // field (admin user typing, scripted writes, etc.), back-fill the
    // custom_qty_in_uom so the UI stays internally coherent without
    // waiting for a save.
    qty(frm) {
        _ipv_wo_back_fill_qiu(frm);
    },

    refresh(frm) {
        _ipv_wo_apply_qty_lock(frm);
    },
});


// ─── Higher-UOM auto-default ────────────────────────────────────────────
// 2026-05-19 — When the user picks a production_item, default custom_uom
// to the item's largest-CF UOM. If the item has no alt UOM (only the
// stock UOM in its ladder), leave custom_uom blank so the standard qty
// is the authoritative input.
function _ipv_wo_default_higher_uom(frm) {
    if (!frm.doc.production_item) return;
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_default_higher_uom",
        args:   {item_code: frm.doc.production_item},
    }).then(r => {
        const data = (r && r.message) || {};
        const u = data.uom || "";
        if (u) {
            frm.set_value("custom_uom", u);
            // The custom_uom handler chains _ipv_wo_refresh_cf → CF
            // populates → recompute qty.
        }
    });
}


// ─── MRP auto-fetch ─────────────────────────────────────────────────────
function _ipv_wo_fetch_mrp(frm, force) {
    if (frm.doc.custom_mrp_source !== "Auto from Item" && !force) return;
    if (!frm.doc.production_item) return;
    frappe.db.get_value("Item", frm.doc.production_item, "custom_mrp")
        .then(r => {
            const v = (r && r.message) ? r.message.custom_mrp : null;
            if (v !== undefined) frm.set_value("custom_mrp", v || 0);
        });
}


// ─── UOM conversion factor lookup ──────────────────────────────────────
// 2026-05-19 — switched from frappe.client.get_list (which was perm-blocked
// on UOM Conversion Detail for non-admin users → CF stayed 0 → qty never
// auto-computed). Now uses a dedicated whitelisted endpoint.
function _ipv_wo_refresh_cf(frm) {
    if (!frm.doc.custom_uom || !frm.doc.production_item) {
        frm.set_value("custom_uom_conversion_factor", 0);
        return;
    }
    frappe.call({
        method: "chaizup_toc.api.uom_query.get_uom_conversion_factor",
        args: {
            item_code: frm.doc.production_item,
            uom:       frm.doc.custom_uom,
        },
    }).then(r => {
        const cf = (r && r.message) ? Number(r.message) : 0;
        frm.set_value("custom_uom_conversion_factor", cf || 0);
        if (cf > 0 && (frm.doc.custom_qty_in_uom || 0) > 0) {
            _ipv_wo_recompute_qty(frm);
        }
    });
}


// ─── Recompute the standard qty from UOM input ─────────────────────────
function _ipv_wo_recompute_qty(frm) {
    const cf  = frm.doc.custom_uom_conversion_factor || 0;
    const qiu = frm.doc.custom_qty_in_uom            || 0;
    if (!cf || cf <= 0) return;
    if (!qiu || qiu <= 0) return;
    const new_qty = qiu * cf;
    if (Math.abs((frm.doc.qty || 0) - new_qty) > 0.0001) {
        // The qty field is normally read-only (locked per the role rule
        // below). Set the value programmatically to bypass the UI lock.
        frm.set_value("qty", new_qty);
    }
}


// ─── REVERSE sync: standard qty → custom_qty_in_uom ─────────────────────
// 2026-05-19 — when ERPNext or an admin writes the standard `qty` field,
// recompute custom_qty_in_uom = qty / CF so the UI stays coherent
// without a round-trip to the server.
function _ipv_wo_back_fill_qiu(frm) {
    const cf = frm.doc.custom_uom_conversion_factor || 0;
    if (!cf || cf <= 0) return;
    const v = (frm.doc.qty || 0) / cf;
    if (Math.abs((frm.doc.custom_qty_in_uom || 0) - v) > 0.0001) {
        frm.set_value("custom_qty_in_uom", v);
    }
}


// ─── Lock "Qty To Manufacture" for non-System-Manager users ────────────
// 2026-05-19 — user requirement: only System Admin can edit the standard
// qty; everyone else must drive it via the UOM picker so qty stays in
// sync with the chosen UOM.
function _ipv_wo_apply_qty_lock(frm) {
    const isAdmin = (frappe.user_roles || []).includes("System Manager")
                 || frappe.session.user === "Administrator";
    frm.set_df_property("qty", "read_only", isAdmin ? 0 : 1);
    // Visual cue — same class used to dim the field when UOM-driven.
    const ctrl = frm.fields_dict.qty && frm.fields_dict.qty.$wrapper;
    if (ctrl) ctrl.toggleClass("ipv-qty-locked", !isAdmin);
    // Description hint so the user knows why they can't edit.
    if (!isAdmin) {
        frm.set_df_property(
            "qty", "description",
            "Locked — drive this value from \"Qty in UOM\" + \"UOM\" below. " +
            "System Manager can override.",
        );
    }
}
