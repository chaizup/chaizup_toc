# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.15) —
#   3 things in one atomic landing:
#
#   1. INSTALL the 5 new Custom Fields on Work Order via Frappe's
#      `create_custom_fields` helper (idempotent — upserts).
#         custom_item_group            (Link → Item Group, fetch_from
#                                       production_item.item_group,
#                                       in_standard_filter=1)
#         custom_batch_no              (Link → Batch, in_list_view=1)
#         custom_manufacturing_date    (Date, in_list_view=1)
#         custom_batch_date            (Date, in_list_view=1)
#         custom_best_before_date      (Date, in_list_view=1)
#
#   2. INSTALL 2 Property Setters making `status` + `workflow_state`
#      in_standard_filter=1 so the operator filter chips appear at the
#      top of the Work Order list.
#
#   3. BACKFILL the 4 batch fields on every existing Work Order from
#      `tabBatch` (where reference_doctype = "Work Order"). Single
#      raw-SQL UPDATE with LEFT JOIN — fast even for thousands of WOs.
#
#   4. EXTEND `List View Settings.Work Order.fields` from 10 columns to
#      14 (append: Batch No, Manufacture Date, Batch Date, Best Before
#      Date).
#
# WHY:
#   v0.0.14 settled the 10-column List view + combined indicator. User
#   then asked for (a) 4 more batch-identity columns, (b) standard
#   filters for item group / status / workflow_state. All three
#   reachable with a single migrate pass since they share the same
#   Work Order list-view config surface.
#
# RESTRICTED:
#   - `custom_item_group` is a Frappe `fetch_from` field — its value
#     auto-populates from `production_item.item_group` on save. Don't
#     change it to a manually-typed Link; would lose the auto-sync and
#     introduce data drift between Item.item_group changes and WO rows.
#   - The batch backfill picks the EARLIEST Batch per WO (`ORDER BY
#     creation ASC LIMIT 1`). If chaizup's policy ever changes to allow
#     multiple batches per WO, this query must change — losing batch
#     identity would break the audit chain. Currently a SITE POLICY.
#   - Don't widen the backfill UPDATE to set qty fields or any other
#     column — keep this patch's blast radius scoped to the 4 batch
#     fields it owns. Other WO data is managed by other patches/hooks.
#   - Don't skip the `frappe.clear_cache(doctype="Work Order")` at the
#     end. New Custom Fields need a meta cache flush or the list view
#     won't render them until the next bench restart.
#   - The list_view_settings.fields update at step 4 uses raw SQL via
#     frappe.db.set_value (NOT the fixture importer) because the row
#     already exists — same INSERT-only fixture gotcha as v0.0.11/12.
#
# IDEMPOTENT: re-running is a no-op (create_custom_fields upserts;
# Property Setter exists-check; backfill UPDATE writes same data; list
# view set_value short-circuits identical writes).
#
# MEMORY: app_chaizup_toc.md § "v0.0.15 — WO batch columns + standard filters (2026-05-27)"
# =============================================================================

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


# Updated 14-column list view — appends 4 batch fields to v0.0.14's 10.
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
    '{"fieldname": "custom_created_by", "label": "Created By"}, '
    '{"fieldname": "custom_batch_no", "label": "Batch No"}, '
    '{"fieldname": "custom_manufacturing_date", "label": "Manufacture Date"}, '
    '{"fieldname": "custom_batch_date", "label": "Batch Date"}, '
    '{"fieldname": "custom_best_before_date", "label": "Best Before Date"}]'
)


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Install 5 new Custom Fields (idempotent upsert) ──────────────────
    create_custom_fields({
        "Work Order": [
            {
                "fieldname": "custom_item_group", "label": "Item Group",
                "fieldtype": "Link", "options": "Item Group",
                "fetch_from": "production_item.item_group",
                "read_only": 1, "in_standard_filter": 1,
                "insert_after": "production_item",
                "module": "Chaizup Toc",
            },
            {
                "fieldname": "custom_batch_no", "label": "Batch No",
                "fieldtype": "Link", "options": "Batch",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "custom_produced_qty_in_uom",
                "module": "Chaizup Toc",
            },
            {
                "fieldname": "custom_manufacturing_date", "label": "Manufacture Date",
                "fieldtype": "Date",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "custom_batch_no",
                "module": "Chaizup Toc",
            },
            {
                "fieldname": "custom_batch_date", "label": "Batch Date",
                "fieldtype": "Date",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "custom_manufacturing_date",
                "module": "Chaizup Toc",
            },
            {
                "fieldname": "custom_best_before_date", "label": "Best Before Date",
                "fieldtype": "Date",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "custom_batch_date",
                "module": "Chaizup Toc",
            },
        ]
    }, ignore_validate=True)
    log.info("v0.0.15 patch: installed 5 Custom Fields on Work Order")

    # ── 2. Standard-filter Property Setters for status + workflow_state ─────
    for field in ("status", "workflow_state"):
        ps_name = f"Work Order-{field}-in_standard_filter"
        if not frappe.db.exists("Property Setter", ps_name):
            ps = frappe.new_doc("Property Setter")
            ps.doc_type = "Work Order"
            ps.doctype_or_field = "DocField"
            ps.field_name = field
            ps.property = "in_standard_filter"
            ps.property_type = "Check"
            ps.value = "1"
            ps.module = "Chaizup Toc"
            ps.flags.ignore_permissions = True
            ps.insert()
            log.info(f"v0.0.15 patch: created {ps_name} = 1")
        else:
            frappe.db.set_value("Property Setter", ps_name, "value", "1",
                                update_modified=True)

    # ── 3. Backfill the 4 batch fields on every existing WO ─────────────────
    # JOIN tabBatch on reference_name = WO name. Picks the EARLIEST batch
    # per WO when multiple exist (site policy: 1 batch / WO).
    cnt = frappe.db.sql("""
        UPDATE `tabWork Order` wo
        LEFT JOIN (
            SELECT reference_name AS wo,
                   MIN(name) AS batch_name
              FROM `tabBatch`
             WHERE reference_doctype = 'Work Order'
             GROUP BY reference_name
        ) earliest ON earliest.wo = wo.name
        LEFT JOIN `tabBatch` b ON b.name = earliest.batch_name
           SET wo.custom_batch_no           = b.name,
               wo.custom_manufacturing_date = b.manufacturing_date,
               wo.custom_batch_date         = DATE(b.creation),
               wo.custom_best_before_date   = b.expiry_date
         WHERE b.name IS NOT NULL
    """)
    backfilled = frappe.db.sql(
        "SELECT COUNT(*) FROM `tabWork Order` WHERE custom_batch_no IS NOT NULL"
    )[0][0]
    log.info(f"v0.0.15 patch: backfilled batch fields on {backfilled} WOs")

    # ── 4. Force-sync the WO List View Settings to 14 columns ──────────────
    if frappe.db.exists("List View Settings", "Work Order"):
        frappe.db.set_value("List View Settings", "Work Order", "fields",
                            _WO_LIST_VIEW_FIELDS, update_modified=True)
        log.info("v0.0.15 patch: WO List View Settings extended to 14 columns")

    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.15 patch: Work Order meta cache cleared — new fields "
             "+ filters + columns live on next page load")
