# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.17) —
#   Polish the BOM list view to match the chaizup spec:
#
#   ID, Status (coloured), Item to Manufacture (code:name), Is Active,
#   Is Default, Created By, Created On, Work Orders (count → hyperlink)
#
# WHAT THIS PATCH DOES
#   1. Install `custom_wo_count` Custom Field on BOM (Int, in_list_view=1).
#   2. Flip live Property Setter BOM.default_view "Report" → "List".
#      (Same v0.0.13 lesson — Report view ignores List View Settings.fields
#      AND ignores get_indicator, so any list-view polish is invisible
#      until the default is flipped.)
#   3. Clear per-user list-settings overrides for BOM
#      (tabDefaultValue rows with defkey LIKE "_list_settings:BOM%")
#      so the new default fixture takes effect on next page load.
#   4. Force-rewrite live List View Settings.BOM.fields to 8 columns.
#      (Same INSERT-only fixture-importer gotcha as v0.0.11/12/15/16 —
#      bench migrate won't update existing rows.)
#   5. Backfill BOM.custom_wo_count for every existing BOM via raw SQL.
#
#   THE JS-SIDE CHANGES (combined item formatter + WO-count hyperlink)
#   live in public/js/bom_list_extras.js (v0.0.17) and ship in the bundle.
#
# WHY (deferred requirements recap)
#   - "same way fix the bom list also looks like a report via toc fixtare"
#       → Same Report-view-locked symptom as the WO list before v0.0.13.
#         Fix is the same pattern: default_view → List, clear user
#         overrides, force-rewrite the fixture, then the in-app fixture +
#         JS extras take over.
#
# RESTRICTED:
#   - Don't remove force_re_route_to_default_view = 1 for BOM. It guards
#     against stale ?view=Report URLs undoing the fix.
#   - Don't add a workflow_state Property Setter for BOM — BOM has no
#     workflow_state field (proven 2026-05-27 in v0.0.11 patch).
#   - Don't widen the user-settings clear to other doctypes. BOM-only.
#   - The Work Orders count backfill uses docstatus < 2 (Draft +
#     Submitted, excludes Cancelled). Matches the on_cancel hook
#     refresh_bom_wo_count semantics. Don't change to docstatus = 1
#     only — Drafts are legitimate "in progress" from a BOM POV.
#   - Don't bypass this patch with a fixture-only edit; install_fixtures
#     is INSERT-only for existing rows.
#
# IDEMPOTENT: re-runs are no-ops (create_custom_fields upserts,
# set_value short-circuits identical writes, COUNT UPDATE writes same data).
#
# MEMORY: app_chaizup_toc.md § "v0.0.17 — BOM list polish + WO connection (2026-05-27)"
# =============================================================================

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


_BOM_LIST_VIEW_FIELDS = (
    '[{"fieldname": "name", "label": "ID"}, '
    '{"type": "Status", "fieldname": "status_field", "label": "Status"}, '
    '{"fieldname": "item", "label": "Item To Manufacture"}, '
    '{"fieldname": "is_active", "label": "Is Active ?"}, '
    '{"fieldname": "is_default", "label": "Is Default ?"}, '
    '{"fieldname": "owner", "label": "Created By"}, '
    '{"fieldname": "creation", "label": "Created On"}, '
    '{"fieldname": "custom_wo_count", "label": "Work Orders"}]'
)


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Install custom_wo_count Custom Field ────────────────────────────
    create_custom_fields({
        "BOM": [
            {
                "fieldname": "custom_wo_count", "label": "Work Orders",
                "fieldtype": "Int", "default": "0",
                "read_only": 1, "in_list_view": 1, "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "is_default",
                "description": "v0.0.17 — Count of non-cancelled Work Orders that reference this BOM. Auto-refreshed via doc_events on Work Order after_insert / on_cancel / on_trash.",
                "module": "Chaizup Toc",
            },
        ]
    }, ignore_validate=True)
    log.info("v0.0.17 patch: installed custom_wo_count on BOM")

    # ── 2. Flip default_view → List ─────────────────────────────────────────
    ps_name = "BOM-main-default_view"
    if frappe.db.exists("Property Setter", ps_name):
        current = frappe.db.get_value("Property Setter", ps_name, "value")
        if current != "List":
            frappe.db.set_value("Property Setter", ps_name, "value", "List",
                                update_modified=True)
            log.info(f"v0.0.17 patch: flipped {ps_name} {current!r} → 'List'")
        else:
            log.info(f"v0.0.17 patch: {ps_name} already 'List' — no-op")

    # ── 3. Clear per-user list overrides for BOM ───────────────────────────
    frappe.db.sql("""
        DELETE FROM `tabDefaultValue`
         WHERE defkey LIKE %s
    """, ("\\_list\\_settings:BOM%",))
    try:
        frappe.db.sql("DELETE FROM `tabUser Settings` WHERE doctype = 'BOM'")
    except Exception:
        # older Frappe — table doesn't exist; safe to ignore.
        pass
    log.info("v0.0.17 patch: cleared per-user list settings for BOM")

    # ── 4. Force-sync the BOM List View Settings to 8 columns ──────────────
    if frappe.db.exists("List View Settings", "BOM"):
        frappe.db.set_value("List View Settings", "BOM", "fields",
                            _BOM_LIST_VIEW_FIELDS, update_modified=True)
        log.info("v0.0.17 patch: BOM List View Settings rewritten to 8 columns")

    # ── 5. Backfill custom_wo_count on every existing BOM ──────────────────
    # Single UPDATE with subquery — fast even for 1000+ BOMs.
    frappe.db.sql("""
        UPDATE `tabBOM` bom
        LEFT JOIN (
            SELECT bom_no, COUNT(*) AS cnt
              FROM `tabWork Order`
             WHERE docstatus < 2 AND bom_no IS NOT NULL
             GROUP BY bom_no
        ) wo ON wo.bom_no = bom.name
           SET bom.custom_wo_count = COALESCE(wo.cnt, 0)
    """)
    with_wo = frappe.db.sql(
        "SELECT COUNT(*) FROM `tabBOM` WHERE custom_wo_count > 0"
    )[0][0]
    log.info(f"v0.0.17 patch: backfilled custom_wo_count — {with_wo} BOMs "
             "have at least one non-cancelled WO")

    frappe.clear_cache(doctype="BOM")
    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.17 patch: caches cleared. BOM list ready in List view "
             "after browser hard-reload.")
