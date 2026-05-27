# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.11) —
#   force-sync the BOM `List View Settings` row from the fixture.
#
# WHY:
#   Frappe's fixture importer (`install_fixtures`) only INSERTS new rows;
#   it does NOT update existing rows. So changes to fixtures/list_view_settings.json
#   for a row that's already present in `tabList View Settings` are silently
#   ignored on `bench migrate`. Existing sites (incl. Frappe Cloud production)
#   keep the old column ordering forever unless a patch force-rewrites the
#   row.
#
# WHAT THIS PATCH DOES (per 2026-05-27 spec):
#   1. Reorders BOM list-view columns so Status is FIRST.
#   2. Drops the `name` (docname / "ID") column from the visible set.
#      BOM docnames look like code strings (`BOM-FG-001-001`) — informally
#      "workflow-state-looking" to the operator, but they don't carry
#      product identity. The Status pill + Item column already identify
#      every row; clicking anywhere navigates to the BOM doc.
#
# RESTRICTED:
#   - Do NOT add a `workflow_state` Property Setter for BOM. BOM has no
#     workflow_state field (verified 2026-05-27: empty result on DocField,
#     Custom Field, Workflow.document_type, and information_schema.COLUMNS
#     queries). Adding a setter for a non-existent field would either no-op
#     or raise on import.
#   - Do NOT touch the ERPNext `get_indicator` callback in bom_list.js —
#     it controls the row-leading colored pill (Template/Default/Active/
#     Not active). That's the visual "Status" the user wants at the front.
#     The synthetic `{"type": "Status"}` column in the fixture mirrors the
#     same indicator into Report View; keep both in sync.
#   - Do NOT remove the `item` / `is_active` / `is_default` columns —
#     they're the canonical BOM scanning columns; users filter on them
#     daily.
#   - Do NOT add a fixture-update fast path that bypasses this patch —
#     Frappe's fixture importer is the ONLY guaranteed install-time
#     mechanism and it's INSERT-only by design.
#
# IDEMPOTENT: re-running the patch on an already-correct row is a no-op
# (Frappe.db.set_value short-circuits identical writes).
#
# MEMORY: app_chaizup_toc.md § "v0.0.11 — BOM list view column reorder (2026-05-27)"
# =============================================================================

import frappe


# Target column set — keep in sync with fixtures/list_view_settings.json.
# Status FIRST per user spec; name (docname) intentionally dropped.
_BOM_LIST_VIEW_FIELDS = (
    '[{"type": "Status", "fieldname": "status_field", "label": "Status"}, '
    '{"fieldname": "item", "label": "Item To Manufacture"}, '
    '{"fieldname": "custom_created_time", "label": "Created On"}, '
    '{"fieldname": "custom_created_by", "label": "Created By"}, '
    '{"fieldname": "is_active", "label": "Is Active ?"}, '
    '{"fieldname": "is_default", "label": "Is Default ?"}]'
)


def execute():
    log = frappe.logger("chaizup_toc")

    if not frappe.db.exists("List View Settings", "BOM"):
        # Fresh install (or row was deleted) — the fixture importer will
        # create it on this same migrate pass. No-op for us.
        log.info("v0.0.11 patch: BOM List View Settings row absent — "
                 "fixture importer will create it. Skipping update.")
        return

    frappe.db.set_value(
        "List View Settings", "BOM", "fields", _BOM_LIST_VIEW_FIELDS,
        update_modified=True,
    )
    frappe.db.commit()
    log.info("v0.0.11 patch: BOM List View Settings re-synced — Status now "
             "first column, ID/name dropped from visible set.")
