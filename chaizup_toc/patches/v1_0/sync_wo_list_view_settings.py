# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.12) —
#   force-sync the Work Order `List View Settings` row from the fixture.
#
# WHY:
#   Same INSERT-only gotcha as the BOM patch (v0.0.11) — Frappe's
#   `install_fixtures` mechanism only INSERTS new rows; it does NOT
#   update existing rows. Changes to fixtures/list_view_settings.json
#   for a row already present in `tabList View Settings` are silently
#   ignored on `bench migrate`. Existing sites (incl. Frappe Cloud)
#   keep the old column set forever unless a patch force-rewrites it.
#
# WHAT THIS PATCH DOES (per 2026-05-27 spec):
#   Reorders Work Order list-view to the user's 10-column spec:
#     1.  ID                                 (name)
#     2.  Item To Manufacture                (production_item)
#     3.  Work Order Actual Status           (status_field — combined indicator)
#     4.  MRP                                (custom_mrp)
#     5.  Qty                                (qty — standard ERPNext field, stock UOM)
#     6.  Qty In UOM [TOC]                   (custom_qty_in_uom)
#     7.  UOM [TOC]                          (custom_uom)
#     8.  Manufactured Qty in UOM [TOC]      (custom_produced_qty_in_uom)
#     9.  Created On                         (custom_created_time)
#     10. Created By                         (custom_created_by)
#
#   Column 3 is the SYNTHETIC {"type": "Status"} entry that renders the
#   row indicator pill into a column. The pill itself is computed by
#   `frappe.listview_settings["Work Order"].get_indicator` — see
#   `public/js/work_order_list_extras.js` (v0.0.12) — which fuses
#   `status` and `workflow_state` into a single coloured label like
#   "Completed · Taken In Production".
#
#   Drops `production_plan` column from the visible set (was column 8 in
#   v0.0.11 fixture) — wasn't in the user's 10-column spec. The field is
#   still in meta + still filterable; it's just not a default Report View
#   column.
#
# RESTRICTED:
#   - Do NOT remove the `{"type": "Status"}` entry at position 3. It's
#     the bridge between the row indicator pill and the explicit Report
#     View column. Without it, Report View shows NO status column at all
#     (only LIST view would show the row-leading pill).
#   - Do NOT change `qty` to a custom field (e.g., custom_qty_in_stock).
#     `qty` is the standard ERPNext column on tabWork Order; it's the
#     authoritative quantity in stock UOM. The TOC custom_qty_in_uom is
#     the higher-UOM mirror, separate column at position 6.
#   - Do NOT bypass this patch with a fixture-only edit — `install_fixtures`
#     is INSERT-only by design. See `fixtures/fixtures.md` § "Fixture
#     update gotcha".
#   - Do NOT add a `workflow_state` Property Setter to make it a default
#     in_list_view docfield. The combined pill at column 3 ALREADY shows
#     the workflow state. Adding a separate workflow_state column would
#     duplicate the information.
#
# IDEMPOTENT: re-running on an already-correct row is a no-op
# (frappe.db.set_value short-circuits identical writes).
#
# MEMORY: app_chaizup_toc.md § "v0.0.12 — Work Order combined status indicator (2026-05-27)"
# =============================================================================

import frappe


# Target column set — keep in sync with fixtures/list_view_settings.json.
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
    '{"fieldname": "custom_created_by", "label": "Created By"}]'
)


def execute():
    log = frappe.logger("chaizup_toc")

    if not frappe.db.exists("List View Settings", "Work Order"):
        # Fresh install — the fixture importer will create it on this
        # same migrate pass. No-op for us.
        log.info("v0.0.12 patch: Work Order List View Settings row absent — "
                 "fixture importer will create it. Skipping update.")
        return

    frappe.db.set_value(
        "List View Settings", "Work Order", "fields", _WO_LIST_VIEW_FIELDS,
        update_modified=True,
    )
    frappe.db.commit()
    log.info("v0.0.12 patch: Work Order List View Settings re-synced — "
             "Status column relabelled 'Work Order Actual Status', new Qty "
             "column inserted at position 5, Created On/By appended at 9/10, "
             "Production Plan ID dropped.")
