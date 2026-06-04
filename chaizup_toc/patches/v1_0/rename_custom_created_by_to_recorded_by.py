"""Rename custom_created_by -> custom_recorded_by on Production Plan, Work Order
and BOM, preserving existing data.

# =============================================================================
# CONTEXT (2026-06-04): The custom field `custom_created_by` duplicated Frappe's
#   built-in "Created By" (owner) and was renamed to `custom_recorded_by`
#   (label "Recorded By") across the app. This patch renames the DB COLUMN in
#   place so existing values survive, and removes the stale Custom Field doc so
#   the fixture sync (which runs AFTER patches in `bench migrate`) creates the
#   new field without re-adding the old column.
# WHY a column rename (not copy): patches run BEFORE sync_fixtures, so the new
#   `custom_recorded_by` column does not exist yet. Renaming the existing column
#   keeps the data AND satisfies the later fixture sync (column already present).
# RESTRICT:
#   - Idempotent: guarded by has_column on both old + new. Safe to re-run.
#   - All 3 columns are varchar(140) (Data/Select/Link) — the CHANGE keeps that.
#   - Do NOT touch `custom_created_time` (a different field, NOT renamed).
# =============================================================================
"""

import frappe


def execute():
    doctypes = ["Production Plan", "Work Order", "BOM"]
    for dt in doctypes:
        table = f"tab{dt}"
        has_old = frappe.db.has_column(dt, "custom_created_by")
        has_new = frappe.db.has_column(dt, "custom_recorded_by")

        if has_old and not has_new:
            # Rename the column in place — preserves every existing value.
            frappe.db.sql_ddl(
                f"ALTER TABLE `{table}` "
                f"CHANGE COLUMN `custom_created_by` `custom_recorded_by` varchar(140)"
            )
            frappe.logger("chaizup_toc").info(
                f"rename_custom_created_by: {dt} column renamed (data preserved)."
            )
        elif has_old and has_new:
            # Both columns exist (e.g. fixture already added the new one on a
            # prior partial run): copy any data over, then drop the stale column.
            frappe.db.sql(
                f"UPDATE `{table}` "
                f"SET `custom_recorded_by` = `custom_created_by` "
                f"WHERE (`custom_recorded_by` IS NULL OR `custom_recorded_by` = '') "
                f"  AND `custom_created_by` IS NOT NULL"
            )
            frappe.db.sql_ddl(f"ALTER TABLE `{table}` DROP COLUMN `custom_created_by`")

        # Remove the stale Custom Field doc so it does not recreate the old column
        # on the next fixture sync.
        frappe.delete_doc_if_exists("Custom Field", f"{dt}-custom_created_by")

    frappe.clear_cache()
