# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.16) —
#   3 deferred requirements from the v0.0.15 chain:
#
#   1. Add `custom_product_life_days` (Int, in_list_view=1) — fetched from
#      Item.shelf_life_in_days. Appended after Best Before Date in the
#      15-column WO list view.
#
#   2. Backfill custom_product_life_days for all existing WOs.
#      (`fetch_from` only fires on save — needs raw UPDATE for historical
#      rows, same gotcha as v0.0.15's custom_item_group backfill.)
#
#   3. Update List View Settings.Work Order.fields → 15 columns
#      (appends Product Life [Days]).
#
#   NOTE — the JS-only changes for batch-no hyperlink + status/workflow
#   filter scoping are NOT in this patch. They live in
#   public/js/work_order_list_extras.js (v0.0.16) and ship in the bundle.
#
# WHY (deferred requirements recap):
#   a. "add column product life in days : comes from item to be manufacutre"
#      → Item has a standard `shelf_life_in_days` (Int) field. Mirror
#        it onto WO via Custom Field + fetch_from + backfill.
#   b. "filter field workflow state only shows the option related to
#      work order, same for status as well"
#      → Frappe's standard filter chip auto-derives options from the
#        field's Select options OR distinct values seen in the table.
#        For Link fields (workflow_state → Workflow State doctype) it
#        shows the WHOLE Workflow State list, which is unrelated to WO.
#        Fix is JS-side: override the filter input with set_query so the
#        dropdown only offers states that exist for Work Order. Patch is
#        only needed to flush meta cache once.
#   c. "batch no will be a hyper link to the batch"
#      → JS-side formatter wraps custom_batch_no in <a href="/app/batch/X">.
#
# RESTRICTED:
#   - `custom_product_life_days` is read-only + fetched. NEVER change to
#     an editable field — the WO copy must always reflect the current
#     Item master value.
#   - The backfill UPDATE uses `LEFT JOIN tabItem` — never INNER JOIN.
#     WOs with deleted/missing items must still keep their row (we set
#     the field to NULL in that case).
#   - Backfill writes 0 for items with no shelf_life_in_days set.
#     Originally tried NULLIF + NULL semantics, but Frappe Int columns
#     are `NOT NULL DEFAULT 0` — attempting to write NULL raises
#     MySQLdb.IntegrityError 1048. The patch instead writes 0 (matches
#     the schema default) and the list view can display "—" via a
#     formatter if desired. NULL semantics are unavailable for Int —
#     a follow-up Custom Field type change to Data is the only way to
#     distinguish "unknown" from "0 days".
#
# IDEMPOTENT: re-runs are no-ops (create_custom_fields upserts, UPDATE
# writes same data, set_value short-circuits identical writes).
#
# MEMORY: app_chaizup_toc.md § "v0.0.16 — WO product life + scoped filters + batch hyperlink (2026-05-27)"
# =============================================================================

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


# Updated 15-column list view — appends Product Life [Days] to v0.0.15's 14.
_WO_LIST_VIEW_FIELDS = (
    '[{"fieldname": "name", "label": "ID"}, '
    '{"fieldname": "production_item", "label": "Item To Manufacture"}, '
    '{"type": "Status", "fieldname": "status_field", "label": "Work Order Actual Status"}, '
    '{"fieldname": "custom_mrp", "label": "MRP"}, '
    '{"fieldname": "qty", "label": "Qty"}, '
    '{"fieldname": "custom_qty_in_uom", "label": "Qty In UOM [TOC]"}, '
    '{"fieldname": "custom_uom", "label": "UOM [TOC]"}, '
    '{"fieldname": "custom_produced_qty_in_uom", "label": "Manufactured Qty in UOM [TOC]"}, '
    '{"fieldname": "custom_created_time", "label": "Created On"}, '
    '{"fieldname": "custom_recorded_by", "label": "Created By"}, '
    '{"fieldname": "custom_batch_no", "label": "Batch No"}, '
    '{"fieldname": "custom_manufacturing_date", "label": "Manufacture Date"}, '
    '{"fieldname": "custom_batch_date", "label": "Batch Date"}, '
    '{"fieldname": "custom_best_before_date", "label": "Best Before Date"}, '
    '{"fieldname": "custom_product_life_days", "label": "Product Life [Days]"}]'
)


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Install `custom_product_life_days` Custom Field ─────────────────
    create_custom_fields({
        "Work Order": [
            {
                "fieldname": "custom_product_life_days",
                "label": "Product Life [Days]",
                "fieldtype": "Int",
                "fetch_from": "production_item.shelf_life_in_days",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "custom_best_before_date",
                "description": "v0.0.16 — Item.shelf_life_in_days mirrored onto the WO. Auto-fetched on save; backfilled by patches/v1_0/wo_product_life_and_filter_scope.py for historical rows.",
                "module": "Chaizup Toc",
            },
        ]
    }, ignore_validate=True)
    log.info("v0.0.16 patch: installed custom_product_life_days on Work Order")

    # ── 2. Backfill from Item.shelf_life_in_days ────────────────────────────
    # Frappe Int columns are NOT NULL DEFAULT 0 — write 0 (not NULL) when
    # the source item has no shelf_life set. COALESCE ensures the UPDATE
    # never violates the NOT NULL constraint, including for WOs whose
    # production_item Link is dangling (item deleted).
    frappe.db.sql("""
        UPDATE `tabWork Order` wo
        LEFT JOIN `tabItem` i ON i.name = wo.production_item
           SET wo.custom_product_life_days = COALESCE(i.shelf_life_in_days, 0)
         WHERE wo.production_item IS NOT NULL
    """)
    backfilled = frappe.db.sql(
        "SELECT COUNT(*) FROM `tabWork Order` WHERE custom_product_life_days > 0"
    )[0][0]
    log.info(f"v0.0.16 patch: backfilled custom_product_life_days on {backfilled} WOs")

    # ── 3. Force-sync the WO List View Settings to 15 columns ───────────────
    if frappe.db.exists("List View Settings", "Work Order"):
        frappe.db.set_value("List View Settings", "Work Order", "fields",
                            _WO_LIST_VIEW_FIELDS, update_modified=True)
        log.info("v0.0.16 patch: WO List View Settings extended to 15 columns "
                 "(appended Product Life [Days])")

    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.16 patch: Work Order meta cache cleared")
