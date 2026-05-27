# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.19) —
#   Add 2 filter chips to the Work Order list view header:
#
#   1. "Production Plan" — Link → Production Plan, in_standard_filter=1
#      via Property Setter on the existing standard `production_plan`
#      field. Lets operators search WOs scoped to a specific PP.
#
#   2. "Has Production Plan?" — new Custom Field `custom_has_pp`
#      (Select: "Yes" / "No"), in_standard_filter=1. Mirrors a boolean
#      "production_plan IS NULL / NOT NULL" derivation onto a sortable
#      column so the standard filter chip can offer a 2-option dropdown
#      instead of a free-text search.
#
# WHY:
#   1. Operators frequently want to look at "all WOs from PP-2026-00123"
#      to verify a production run is complete. Without `in_standard_filter`,
#      they had to click the filter icon → pick field → type the PP name.
#      One-click chip access is the goal.
#
#   2. Operationally, "WOs without a PP" are usually MANUALLY-created WOs
#      that bypass the planning workflow — important to monitor. The
#      operator wants a single click to see only those.
#
#      Why not just use Frappe's "is_set / is_not_set" filter on
#      production_plan? Because Frappe's standard filter chip on a Link
#      field renders as a SEARCH BOX (the link autocomplete), not as
#      "is set / is not set" toggles. To get a 2-option dropdown chip,
#      we need a Select field. `custom_has_pp` is the mirror.
#
#      Why "Yes"/"No" instead of "Manual"/"Planned"? Standard Frappe
#      Select-filter UX shows option values literally; "Yes / No" reads
#      naturally as an answer to the column label "Has Production Plan?".
#
# WHAT THIS PATCH DOES:
#   1. Install `custom_has_pp` Custom Field (Select, options "Yes\nNo",
#      read_only=1, in_standard_filter=1, hidden=1, no_copy=1).
#      Position: insert_after=production_plan so it's nestled next to the
#      source field in the form view (when un-hidden for debugging).
#
#   2. Install Property Setter Work Order-production_plan-in_standard_filter
#      = 1 so the existing standard `production_plan` field gets its own
#      filter chip alongside the new "Has Production Plan?" chip.
#
#   3. Backfill `custom_has_pp` on every existing WO via single SQL UPDATE.
#
#   4. Add a validate hook (in production_plan_engine.py — separate
#      commit, NOT in this patch) so `custom_has_pp` stays in sync with
#      `production_plan` changes on every WO save. The hook is:
#
#          def stamp_has_pp_on_wo_validate(doc, method=None):
#              doc.custom_has_pp = "Yes" if doc.production_plan else "No"
#
#      Registered in hooks.py:doc_events.Work Order.validate as part of
#      a chained list with the existing stamp_uom_fields_on_wo_validate.
#
# RESTRICTED:
#   - DO NOT make `custom_has_pp` editable. It's a DERIVED field — any
#     manual write would drift from the source-of-truth (production_plan).
#     read_only=1 + hidden=1 enforce "system-managed only".
#   - DO NOT remove the validate hook stamp_has_pp_on_wo_validate. Without
#     it, the field goes stale the moment a user clears or sets the
#     production_plan link on an existing WO.
#   - DO NOT change the option values from "Yes"/"No". The filter chip
#     stores the literal option string in the URL filter; renaming to
#     "Linked"/"Manual" would break any saved filters / Saved Reports
#     that operators have already created.
#   - DO NOT add `in_list_view = 1` to custom_has_pp. The filter is the
#     point — adding it as a default column would duplicate the
#     Production Plan ID column (#2) which already shows the answer
#     visually (filled cell = Yes, empty cell = No).
#   - Same INSERT-only fixture gotcha: changes to property_setter.json /
#     custom_field.json for existing rows need a paired patch (this one).
#
# IDEMPOTENT: re-runs are no-ops (create_custom_fields upserts,
# Property Setter exists-check, UPDATE writes same data).
#
# MEMORY: app_chaizup_toc.md § "v0.0.19 — WO PP filter chips (2026-05-27)"
# =============================================================================

import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Install custom_has_pp Custom Field (Select Yes/No) ───────────────
    create_custom_fields({
        "Work Order": [
            {
                "fieldname": "custom_has_pp",
                "label": "Has Production Plan?",
                "fieldtype": "Select",
                "options": "\nYes\nNo",
                "read_only": 1,
                "hidden": 1,                # form-level hidden; filter chip stays visible
                "in_list_view": 0,
                "in_standard_filter": 1,
                "no_copy": 1,
                "allow_on_submit": 1,
                "insert_after": "production_plan",
                "description": "v0.0.19 — Derived flag mirroring production_plan IS NULL / NOT NULL. System-managed: validate hook keeps it in sync. Exposed as a standard-filter chip so operators can one-click filter WOs with/without a PP.",
                "module": "Chaizup Toc",
            },
        ]
    }, ignore_validate=True)
    log.info("v0.0.19 patch: installed custom_has_pp on Work Order")

    # ── 2. Property Setter — production_plan.in_standard_filter = 1 ────────
    ps_name = "Work Order-production_plan-in_standard_filter"
    if not frappe.db.exists("Property Setter", ps_name):
        ps = frappe.new_doc("Property Setter")
        ps.doc_type = "Work Order"
        ps.doctype_or_field = "DocField"
        ps.field_name = "production_plan"
        ps.property = "in_standard_filter"
        ps.property_type = "Check"
        ps.value = "1"
        ps.module = "Chaizup Toc"
        ps.flags.ignore_permissions = True
        ps.insert()
        log.info(f"v0.0.19 patch: created {ps_name} = 1")
    else:
        frappe.db.set_value("Property Setter", ps_name, "value", "1",
                            update_modified=True)
        log.info(f"v0.0.19 patch: {ps_name} already exists — value set to 1")

    # ── 3. Backfill custom_has_pp on every existing WO ─────────────────────
    frappe.db.sql("""
        UPDATE `tabWork Order`
           SET custom_has_pp = CASE
               WHEN production_plan IS NULL OR production_plan = ''
                   THEN 'No'
               ELSE 'Yes'
           END
    """)
    has = frappe.db.sql(
        "SELECT custom_has_pp, COUNT(*) AS cnt FROM `tabWork Order` "
        "GROUP BY custom_has_pp", as_dict=True
    )
    log.info(f"v0.0.19 patch: backfilled custom_has_pp — distribution: "
             f"{[(r['custom_has_pp'], r['cnt']) for r in has]}")

    frappe.clear_cache(doctype="Work Order")
    frappe.db.commit()
    log.info("v0.0.19 patch: Work Order meta cache cleared. Two new filter "
             "chips ('Production Plan', 'Has Production Plan?') live in the "
             "list header after browser hard-reload.")
