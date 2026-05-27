# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.20) —
#   DROP the stale `custom_item_group` Custom Field.
#
# WHY (root-cause correction of v0.0.15):
#   v0.0.15 added `custom_item_group` as a `fetch_from = "production_item.item_group"`
#   Custom Field to power an in_standard_filter chip on the WO list. That
#   is FUNDAMENTALLY INACCURATE for a filter because Frappe's fetch_from
#   is a SNAPSHOT at save time, not a live link. Symptoms:
#
#     - Today: Item.CZPFG606.item_group = "Finished Goods" →
#              100 WOs saved with custom_item_group = "Finished Goods"
#     - Tomorrow: admin reclassifies Item.CZPFG606.item_group = "Premium Tea"
#     - Result: NEW WOs get "Premium Tea" but those 100 OLD WOs forever
#       claim "Finished Goods". The filter chip groups them WRONG.
#
#   This breaks the operator's mental model: "Filter by Item Group" must
#   ALWAYS mean "current Item Group of the WO's production_item", never
#   "what it WAS the moment the WO was saved".
#
# FIX:
#   1. Drop the `custom_item_group` Custom Field row.
#   2. Drop the `custom_item_group` SQL column from tabWork Order.
#   3. Drop the JS controller's reference to it.
#   4. Replace with a JS-side virtual filter chip on the standard
#      `item_group` LINK that, on filter apply, transforms the value
#      into a SQL filter `production_item IN (SELECT name FROM Item
#      WHERE item_group = X)`. See `public/js/work_order_list_extras.js`
#      v0.0.20 onload handler.
#
# RESTRICTED:
#   - DO NOT re-add `custom_item_group` as a fetched / stored field.
#     The semantic correctness REQUIREMENT (filter = current state)
#     is fundamentally incompatible with denormalized storage.
#   - DO NOT replace this with an `is_virtual = 1` field. Virtual fields
#     CANNOT be filtered server-side via the standard filter chip — the
#     query runs against the storage column, which doesn't exist for
#     virtual fields.
#   - DO NOT add a "sync on Item.validate" hook to keep a stored mirror
#     fresh. Item.validate already does heavy work; adding a fan-out
#     update to potentially thousands of WOs per Item save makes Item
#     edits dangerously slow at chaizup scale.
#   - The JS-side live filter (v0.0.20+) is the canonical solution.
#     If you ever want to remove the filter chip entirely, leave the
#     SQL column drop alone — restoring via fixtures is straightforward.
#
# IDEMPOTENT: re-runs are safe (delete_doc with ignore_missing + the
# raw ALTER TABLE DROP COLUMN IF EXISTS).
#
# MEMORY: app_chaizup_toc.md § "v0.0.20 — drop stale custom_item_group, switch to live filter (2026-05-27)"
# =============================================================================

import frappe


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Delete the Custom Field row ──────────────────────────────────────
    cf_name = "Work Order-custom_item_group"
    if frappe.db.exists("Custom Field", cf_name):
        frappe.delete_doc("Custom Field", cf_name,
                          ignore_permissions=True, force=True)
        log.info(f"v0.0.20 patch: deleted Custom Field {cf_name}")
    else:
        log.info(f"v0.0.20 patch: {cf_name} already absent — no-op")

    # ── 2. Drop the SQL column ──────────────────────────────────────────────
    # ALTER TABLE ... DROP COLUMN IF EXISTS — MariaDB 10.3+ syntax.
    try:
        frappe.db.sql_ddl("""
            ALTER TABLE `tabWork Order`
              DROP COLUMN IF EXISTS `custom_item_group`
        """)
        log.info("v0.0.20 patch: dropped `tabWork Order`.custom_item_group column")
    except Exception:
        # Fallback for older MariaDB — check + drop
        cols = frappe.db.sql("""
            SELECT COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_NAME = 'tabWork Order' AND COLUMN_NAME = 'custom_item_group'
        """)
        if cols:
            frappe.db.sql_ddl("ALTER TABLE `tabWork Order` DROP COLUMN `custom_item_group`")
            log.info("v0.0.20 patch: dropped column (fallback path)")
        else:
            log.info("v0.0.20 patch: column already absent — no-op")

    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.20 patch: Work Order meta cache cleared. The JS-side "
             "live Item Group filter (v0.0.20 work_order_list_extras.js) "
             "takes over after browser hard-reload.")
