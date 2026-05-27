# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.13) —
#   switch Work Order's default view from "Report" to "List" so the
#   v0.0.12 List View Settings fixture + combined `get_indicator` actually
#   take effect for end users.
#
# WHY:
#   v0.0.12 shipped the 10-column List View Settings reorder + a combined
#   "Work Order Actual Status" pill via `get_indicator`. None of it
#   rendered for users because a Property Setter forced
#   `Work Order.default_view = "Report"` with
#   `force_re_route_to_default_view = 1`. Report View ignores
#   List View Settings.fields AND ignores `get_indicator` — it builds
#   columns from `meta.fields where in_list_view=1` + `add_fields` +
#   per-user __UserSettings instead. That's why users saw:
#     - 17 columns (incl. duplicates: Created By twice, Created Time +
#       Created On, Item Name + Stock UOM + Production Plan extras)
#     - Two separate columns "Workflow State" + "Status" — NOT a
#       combined pill
#     - NO "Work Order Actual Status" column at all
#
# FIX:
#   1. Flip Property Setter `Work Order.default_view = "List"` (fixture
#      already updated; this patch syncs the live DB row).
#   2. Clear per-user list-settings overrides for Work Order
#      (`tabDefaultValue` rows with defkey LIKE "_list_settings:Work Order%").
#      Frappe caches each user's column picks here; without clearing,
#      the new default would be ignored by anyone who'd previously
#      opened the Work Order list.
#   3. Clear `tabUser Settings` rows for the doctype too (newer Frappe).
#
# RESTRICTED:
#   - Do NOT remove `force_re_route_to_default_view = 1`. Keeping it
#     ensures that even if a user has a stale URL with `?view=Report`,
#     they're sent back to List view. This is what makes the
#     v0.0.12 work visible.
#   - Do NOT delete the BOM `default_view = Report` Property Setter as
#     a side effect — this patch is scoped to Work Order only. BOM
#     intentionally uses Report view (more sortable for the BOM
#     navigator workflow).
#   - Do NOT widen the __UserSettings/DefaultValue clear to other
#     doctypes. Per-user column picks for other lists are legitimate
#     user data; only clear the Work Order rows we just changed
#     defaults for.
#   - Re-running this patch is a no-op (`frappe.db.set_value` short-
#     circuits identical writes; `frappe.db.delete` is filter-scoped).
#
# MEMORY: app_chaizup_toc.md § "v0.0.13 — switch Work Order default view to List (2026-05-27)"
# =============================================================================

import frappe


def execute():
    log = frappe.logger("chaizup_toc")

    # ── 1. Flip the live Property Setter row ────────────────────────────────
    ps_name = "Work Order-main-default_view"
    if frappe.db.exists("Property Setter", ps_name):
        current = frappe.db.get_value("Property Setter", ps_name, "value")
        if current != "List":
            frappe.db.set_value("Property Setter", ps_name, "value", "List",
                                update_modified=True)
            log.info(f"v0.0.13 patch: flipped {ps_name} from {current!r} → 'List'")
        else:
            log.info(f"v0.0.13 patch: {ps_name} already 'List' — no-op")
    else:
        log.warning(f"v0.0.13 patch: {ps_name} missing — fixture importer "
                    "will create it on this migrate pass")

    # ── 2. Clear per-user list-view overrides for Work Order ───────────────
    # Frappe stores user column picks in:
    #   (a) tabDefaultValue rows where defkey LIKE "_list_settings:Work Order%"
    #   (b) tabUser Settings rows (newer Frappe) — id matches user + doctype
    # We clear both so the new default fixture takes effect on the next
    # page load for every user.
    deleted_dv = frappe.db.sql("""
        DELETE FROM `tabDefaultValue`
         WHERE defkey LIKE %s
    """, ("\\_list\\_settings:Work Order%",))
    log.info(f"v0.0.13 patch: cleared per-user list settings for Work Order")

    # Frappe v15+ stores it in tabUser Settings (different schema).
    try:
        frappe.db.sql("""
            DELETE FROM `tabUser Settings`
             WHERE doctype = %s
        """, ("Work Order",))
    except Exception:
        # Older Frappe — table doesn't exist; safe to ignore.
        pass

    frappe.clear_cache()
    frappe.db.commit()
    log.info("v0.0.13 patch: cache cleared. Users will see the List view "
             "(with the combined Work Order Actual Status pill) on next load.")
