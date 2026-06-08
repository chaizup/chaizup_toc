# =============================================================================
# CONTEXT (ADU-PER-WAREHOUSE · 2026-06-02):
#   Removes the standalone item-level Average Daily Usage (ADU) Custom Fields on
#   Item. They duplicated the per-warehouse "Minimum Manufacture / Purchase Qty
#   per Warehouse" table (Item.custom_minimum_manufacture -> Item Minimum
#   Manufacture.adu), which is now the single source of ADU for the whole app.
#
#   Fields removed (whole "2. Average Daily Usage" section):
#     - Item-custom_toc_sec_adu          (Section Break)
#     - Item-custom_toc_custom_adu       (Check  — "Custom ADU (Manual Entry)")
#     - Item-custom_toc_adu_period       (Select — "ADU Calculation Period")
#     - Item-custom_toc_col_adu          (Column Break)
#     - Item-custom_toc_adu_value        (Float  — "ADU Value (units/day)")
#     - Item-custom_toc_adu_last_updated (Datetime — "ADU Last Calculated")
#
# DANGER:
#   - All readers were repointed to the per-warehouse table (Item Projection
#     View "Days of Cover", Bulk Item Settings, demo data). The old item-level
#     06:30/01:00 cron (daily_adu_update) was deleted; the per-warehouse writer
#     (update_min_mfg_adu_levels) is the sole ADU job (01:00 AM).
#   - Deleting the Custom Field drops the DB column automatically; a defensive
#     DROP COLUMN follows for sites where a previous run half-applied.
#
# RESTRICT:
#   - Do NOT re-introduce any item-level ADU field or item-level ADU cron.
#     ADU is per (item, warehouse) only.
# =============================================================================

import frappe

_FIELDS = [
    "Item-custom_toc_custom_adu",
    "Item-custom_toc_adu_period",
    "Item-custom_toc_adu_value",
    "Item-custom_toc_adu_last_updated",
    "Item-custom_toc_col_adu",
    "Item-custom_toc_sec_adu",
]

_COLUMNS = [
    "custom_toc_custom_adu",
    "custom_toc_adu_period",
    "custom_toc_adu_value",
    "custom_toc_adu_last_updated",
]


def execute():
    for cf_name in _FIELDS:
        if frappe.db.exists("Custom Field", cf_name):
            try:
                frappe.delete_doc("Custom Field", cf_name, force=True, ignore_permissions=True)
                frappe.logger("chaizup_toc").info(f"ADU-PER-WAREHOUSE: deleted Custom Field {cf_name}")
            except Exception:
                frappe.log_error(frappe.get_traceback(),
                                 f"ADU-PER-WAREHOUSE: failed to delete Custom Field {cf_name}")

    # Defensive: drop any data columns that linger after the delete.
    for col in _COLUMNS:
        try:
            exists = frappe.db.sql(
                "SELECT COUNT(*) FROM information_schema.columns "
                "WHERE table_schema = DATABASE() "
                "  AND table_name = 'tabItem' "
                "  AND column_name = %s",
                (col,),
            )
            if exists and exists[0][0]:
                frappe.db.sql_ddl(f"ALTER TABLE `tabItem` DROP COLUMN `{col}`")
                frappe.logger("chaizup_toc").info(f"ADU-PER-WAREHOUSE: dropped tabItem.{col}")
        except Exception:
            frappe.log_error(frappe.get_traceback(),
                             f"ADU-PER-WAREHOUSE: DROP COLUMN {col} failed")

    frappe.db.commit()
    frappe.clear_cache(doctype="Item")
