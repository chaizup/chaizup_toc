# =============================================================================
# CONTEXT (BTP-001 · 2026-05-14):
#   `TOC Item Group Rule` was the child doctype that mapped an Item Group
#   to a Buffer Type (FG / SFG / RM / PM / Manufacture / Purchase / Monitor).
#   The classification system itself was retired long ago — replenishment
#   mode is now read directly from `custom_toc_auto_purchase` /
#   `custom_toc_auto_manufacture` flags on Item, and per-warehouse routing
#   via `Item Minimum Manufacture.action_type`.
#
#   The doctype JSON described it as "LEGACY: no longer used for buffer
#   routing", but the schema + table were still installed on every site.
#   This patch removes the doctype + drops the table.
#
# DANGER:
#   - If any custom site code still queries `tabTOC Item Group Rule`,
#     the deletion will break that query. Grep the bench + custom apps
#     before applying.
#   - The DocType file is also deleted from the repo by the same change
#     set so a fresh `bench migrate` does not re-create it.
#
# RESTRICT:
#   - Do NOT re-create `TOC Item Group Rule`. Per-item routing is the
#     SoT; group-level mapping is a discarded design.
# =============================================================================

import frappe


def execute():
    name = "TOC Item Group Rule"
    if frappe.db.exists("DocType", name):
        try:
            frappe.delete_doc("DocType", name, force=True, ignore_permissions=True)
            frappe.logger("chaizup_toc").info(f"BTP-001: Deleted DocType {name}")
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"BTP-001: failed to delete DocType {name}")

    # Defensive: drop the table if Frappe's delete_doc left it (rare, but
    # happens on sites where the doctype was already orphaned).
    try:
        tbl_exists = frappe.db.sql(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_name = 'tabTOC Item Group Rule'"
        )
        if tbl_exists and tbl_exists[0][0]:
            frappe.db.sql_ddl("DROP TABLE `tabTOC Item Group Rule`")
            frappe.logger("chaizup_toc").info("BTP-001: Dropped tabTOC Item Group Rule")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "BTP-001: DROP TABLE tabTOC Item Group Rule failed")

    frappe.db.commit()
