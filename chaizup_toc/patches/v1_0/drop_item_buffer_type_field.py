# =============================================================================
# CONTEXT (BTP-001 · 2026-05-14):
#   Final removal of the deprecated "Buffer Type" Custom Field on Item.
#   The previous patch `hide_item_buffer_type_field.py` only hid + made it
#   read-only. This patch deletes the Custom Field entirely. Replenishment
#   mode is fully expressed by `custom_toc_auto_purchase` /
#   `custom_toc_auto_manufacture` and by `Item Minimum Manufacture.action_type`.
#
# DANGER:
#   - Some legacy code referenced `Item.custom_toc_buffer_type`. All such
#     references were converted to silent no-ops or removed. Re-introducing
#     the field would re-enable dead code paths the engine no longer
#     supports.
#   - The DB column tab`tabItem`.`custom_toc_buffer_type` is dropped by
#     Frappe automatically when the Custom Field is deleted. If a stale
#     deployment still has the column, this patch also issues a manual
#     DROP COLUMN to make the migration deterministic across sites.
#
# RESTRICT:
#   - Do NOT re-add `Item-custom_toc_buffer_type`. The Item Group Rule
#     doctype that fed it is also being retired (see
#     `drop_toc_item_group_rule.py`).
# =============================================================================

import frappe


def execute():
    cf_name = "Item-custom_toc_buffer_type"
    if frappe.db.exists("Custom Field", cf_name):
        try:
            frappe.delete_doc("Custom Field", cf_name, force=True, ignore_permissions=True)
            frappe.logger("chaizup_toc").info(f"BTP-001: Deleted Custom Field {cf_name}")
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"BTP-001: failed to delete Custom Field {cf_name}")

    # Defensive: drop the column if it still lingers in the schema after the
    # delete (e.g. on sites where the delete failed in a previous run).
    try:
        col_exists = frappe.db.sql(
            "SELECT COUNT(*) FROM information_schema.columns "
            "WHERE table_schema = DATABASE() "
            "  AND table_name = 'tabItem' "
            "  AND column_name = 'custom_toc_buffer_type'"
        )
        if col_exists and col_exists[0][0]:
            frappe.db.sql_ddl("ALTER TABLE `tabItem` DROP COLUMN `custom_toc_buffer_type`")
            frappe.logger("chaizup_toc").info("BTP-001: Dropped tab`tabItem`.custom_toc_buffer_type column")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "BTP-001: DROP COLUMN custom_toc_buffer_type failed")

    frappe.db.commit()
    frappe.clear_cache(doctype="Item")
