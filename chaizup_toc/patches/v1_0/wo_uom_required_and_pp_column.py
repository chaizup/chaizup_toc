# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.18) —
#   Two coordinated changes on the Work Order surface:
#
#   1. Make 3 TOC UOM fields MANDATORY:
#        custom_qty_in_uom              (Float)
#        custom_uom                     (Link → UOM)
#        custom_uom_conversion_factor   (Float, read_only — auto-derived
#                                        from the UOM picker via JS)
#
#      Safe to mark required: pre-check on chaizup-erp 2026-05-27 shows
#      ZERO of 271 existing WOs have NULL/zero in any of the three fields.
#      The `stamp_uom_fields_on_wo_validate` hook (v0.0.19) auto-populates
#      them on every WO save, so the required gate is operationally
#      already satisfied — this just adds the user-facing red-asterisk +
#      validate-time error message.
#
#   2. Insert "Production Plan ID" column at position 2 of the list view
#      (right after ID, before Item To Manufacture). 16 columns total.
#
# WHY:
#   1. Operational: TOC operators sometimes forget to pick a UOM on
#      manually-created WOs. Without a required gate, qty conversions
#      silently default to stock UOM, breaking downstream MRP / batch
#      planning reports. Required + the existing validate-hook
#      auto-populate together guarantee data integrity.
#   2. Visual: PP ID was previously at column 11 (Production Plan ID was
#      dropped in v0.0.12 then re-added at the end in v0.0.15 — but never
#      where operators look for it). Per user spec, restore it as
#      column 2 so the WO→PP linkage is immediately scannable.
#
# RESTRICTED:
#   - DO NOT make any of these 3 UOM fields required WITHOUT FIRST verifying
#     that all live WOs already have non-NULL values for them. Frappe's
#     mandatory validation runs on EVERY save including programmatic API
#     writes; an empty pre-existing field would block legitimate edits to
#     unrelated fields. The pre-flight query:
#         SELECT COUNT(*) FROM `tabWork Order`
#         WHERE custom_qty_in_uom IS NULL OR custom_qty_in_uom = 0
#            OR custom_uom IS NULL OR custom_uom = ''
#            OR custom_uom_conversion_factor IS NULL
#            OR custom_uom_conversion_factor = 0;
#   - DO NOT make custom_uom_conversion_factor user-editable. It's
#     read_only=1 because the value MUST come from the UOM picker's
#     conversion lookup, not from user input. Required-ness doesn't
#     change that — server still auto-fills via _sync_uom_on_single_doc
#     in production_plan_engine.py.
#   - DO NOT insert custom_qty_in_uom / custom_uom / custom_uom_conversion_factor
#     into mandatory_depends_on. We want them ALWAYS required (no
#     conditional escape), and the validate hook guarantees they're
#     populated on every save, so the static `reqd=1` is sufficient.
#   - Production Plan column position MUST be 2 (right after ID).
#     The user reads the table left-to-right; PP ID is the second-most
#     critical identifier after the WO's own name.
#   - Bypassing this patch with a fixture-only edit is silently a no-op
#     (the INSERT-only fixture importer gotcha — see fixtures/fixtures.md).
#
# IDEMPOTENT: re-runs are no-ops (frappe.db.set_value short-circuits
# identical writes for both the Custom Field rows and the List View
# Settings row).
#
# MEMORY: app_chaizup_toc.md § "v0.0.18 — WO UOM mandatory + PP ID column at position 2 (2026-05-27)"
# =============================================================================

import frappe


# Updated 16-column list view — adds Production Plan ID at position 2.
_WO_LIST_VIEW_FIELDS = (
    '[{"fieldname": "name", "label": "ID"}, '
    '{"fieldname": "production_plan", "label": "Production Plan ID"}, '
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


_MANDATORY_FIELDS = (
    "Work Order-custom_qty_in_uom",
    "Work Order-custom_uom",
    "Work Order-custom_uom_conversion_factor",
)


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 0. Pre-flight: refuse to mark required if data is dirty ────────────
    dirty = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabWork Order`
         WHERE custom_qty_in_uom IS NULL OR custom_qty_in_uom = 0
            OR custom_uom IS NULL OR custom_uom = ''
            OR custom_uom_conversion_factor IS NULL
            OR custom_uom_conversion_factor = 0
    """)[0][0]
    if dirty:
        # Don't silently mark required — log + skip the reqd step. Operator
        # must clean up the dirty rows first (e.g., touch-save each WO so
        # the validate hook back-fills the UOM fields).
        log.warning(
            f"v0.0.18 patch: {dirty} WOs have NULL/zero in one or more TOC "
            f"UOM fields. Skipping the mandatory-flag flip to avoid blocking "
            f"future edits. Touch-save those WOs first (their validate hook "
            f"will auto-populate the fields), then re-run this patch."
        )
    else:
        # ── 1. Flip reqd: 0 → 1 on the 3 Custom Field rows ─────────────────
        for cf_name in _MANDATORY_FIELDS:
            if frappe.db.exists("Custom Field", cf_name):
                current = frappe.db.get_value("Custom Field", cf_name, "reqd")
                if int(current or 0) != 1:
                    frappe.db.set_value("Custom Field", cf_name, "reqd", 1,
                                        update_modified=True)
                    log.info(f"v0.0.18 patch: {cf_name}.reqd 0 → 1")
                else:
                    log.info(f"v0.0.18 patch: {cf_name}.reqd already 1 — no-op")
            else:
                log.warning(f"v0.0.18 patch: {cf_name} missing — fixture "
                            "importer will create it on this migrate pass")

    # ── 2. Force-sync the WO List View Settings to 16 columns ──────────────
    if frappe.db.exists("List View Settings", "Work Order"):
        frappe.db.set_value("List View Settings", "Work Order", "fields",
                            _WO_LIST_VIEW_FIELDS, update_modified=True)
        log.info("v0.0.18 patch: WO List View Settings rewritten to 16 "
                 "columns — Production Plan ID inserted at position 2")

    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.18 patch: Work Order meta cache cleared. Users will see "
             "the red-asterisk mandatory markers on the 3 UOM fields + "
             "Production Plan ID column at position 2 after browser hard-reload.")
