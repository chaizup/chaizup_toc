# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.14) —
#   add 3 column-width Property Setters for the Work Order list view +
#   ensure the production_item formatter sees item_name.
#
# WHY:
#   v0.0.13 made the List view visible. User then asked for column
#   widths: production_item=6, custom_qty_in_uom=5,
#   custom_produced_qty_in_uom=5. Frappe stores list-view column width
#   as `Property Setter` rows with property="columns" — one per docfield.
#
#   The legacy sync_property_setters patch already ran (its row is in
#   tabPatch Log), so simply adding new rows to fixtures/property_setter.json
#   won't propagate — `install_fixtures` is INSERT-only, AND the previous
#   sync patch is registered as done. We need a fresh v0.0.14 patch.
#
# WHAT THIS PATCH DOES:
#   Upserts THREE Property Setter rows on tabProperty Setter:
#     - Work Order-production_item-columns           = 6
#     - Work Order-custom_qty_in_uom-columns          = 5
#     - Work Order-custom_produced_qty_in_uom-columns = 5
#
# RESTRICTED:
#   - Frappe list-view rows have a TOTAL grid budget of ~10 columns. The
#     three values above sum to 16 — Frappe will allow it but the row may
#     wrap across two lines on narrow viewports. Don't change the values
#     here without checking with the user — the operator-set widths
#     reflect operational priority (Manufactured Qty is critical scanning
#     surface, hence width=5).
#   - Do NOT remove the existing item_name.columns=4 Property Setter
#     elsewhere in this file's stack — it's used by the standard ERPNext
#     list indicator code which reads doc.item_name. We don't show
#     item_name as a separate column anymore (the combined "code : name"
#     formatter on production_item replaces it), but the Property Setter
#     stays for the indicator logic.
#   - The combined "<item_code> : <item_name>" formatter lives in
#     public/js/work_order_list_extras.js (v0.0.14). It depends on
#     `item_name` being in add_fields — already done in same commit.
#     Removing item_name from add_fields would collapse the cell to
#     just the code.
#
# IDEMPOTENT: re-runs are no-ops (frappe.db.set_value short-circuits
# identical writes).
#
# MEMORY: app_chaizup_toc.md § "v0.0.14 — Work Order list column widths + combined item display (2026-05-27)"
# =============================================================================

import frappe


_COLUMN_WIDTHS = (
    ("production_item",            6),
    ("custom_qty_in_uom",          5),
    ("custom_produced_qty_in_uom", 5),
)


def execute():
    log = frappe.logger("chaizup_toc")

    for field, width in _COLUMN_WIDTHS:
        ps_name = f"Work Order-{field}-columns"
        if frappe.db.exists("Property Setter", ps_name):
            current = frappe.db.get_value("Property Setter", ps_name, "value")
            if str(current) == str(width):
                log.info(f"v0.0.14 patch: {ps_name} already {width} — no-op")
                continue
            frappe.db.set_value("Property Setter", ps_name, "value", str(width),
                                update_modified=True)
            log.info(f"v0.0.14 patch: {ps_name} {current!r} → {width}")
        else:
            doc = frappe.new_doc("Property Setter")
            doc.doc_type = "Work Order"
            doc.doctype_or_field = "DocField"
            doc.field_name = field
            doc.property = "columns"
            doc.property_type = "Int"
            doc.value = str(width)
            doc.module = "Chaizup Toc"
            doc.flags.ignore_permissions = True
            doc.insert()
            log.info(f"v0.0.14 patch: created {ps_name} = {width}")

    # Clear meta cache so the new column widths apply on next list-load.
    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.14 patch: Work Order meta cache cleared")
