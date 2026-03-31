"""
Patch: Remove stale custom_toc_generated references from all DB locations.

The field custom_toc_generated was renamed to custom_toc_recorded_by.
The previous patch (fix_old_field_refs) deleted the workspace and relied on
Frappe recreating it from JSON — but if the workspace was already deleted and
recreated before the patch ran, the stale field could persist.

This patch does direct SQL fixes on every table that could hold the old name,
without relying on workspace deletion or recreation timing.
"""
import frappe


def execute():
    _fix_workspace_shortcuts()
    _fix_number_cards()
    _fix_custom_filters()
    frappe.db.commit()


def _fix_workspace_shortcuts():
    """Fix stats_filter on all Workspace Shortcut rows that reference the old field."""
    # Table name varies by Frappe version — try both
    for table in ("tabWorkspace Shortcut", "tabWorkspace Link"):
        try:
            frappe.db.sql(f"""
                UPDATE `{table}`
                SET stats_filter = REPLACE(stats_filter,
                    'custom_toc_generated',
                    'custom_toc_recorded_by')
                WHERE stats_filter LIKE '%%custom_toc_generated%%'
            """)
            # Also fix the value: old field stored 1, new field stores "By System"
            frappe.db.sql(f"""
                UPDATE `{table}`
                SET stats_filter = REPLACE(stats_filter, '"=",1]', '"=","By System"]')
                WHERE stats_filter LIKE '%%custom_toc_recorded_by%%,1]%%'
            """)
        except Exception:
            pass  # Table may not exist in this Frappe version


def _fix_number_cards():
    """Fix filters_json and method on all Number Cards that may reference the old field."""
    for nc_name in [
        "TOC - Items in Red Zone",
        "TOC - Items in Yellow Zone",
        "TOC - Items in Green Zone",
        "TOC - Open Material Requests",
    ]:
        if not frappe.db.exists("Number Card", nc_name):
            continue
        try:
            fj = frappe.db.get_value("Number Card", nc_name, "filters_json") or ""
            if "custom_toc_generated" in fj:
                fj = fj.replace("custom_toc_generated", "custom_toc_recorded_by")
                fj = fj.replace('"=",1', '"=","By System"')
                frappe.db.set_value("Number Card", nc_name, "filters_json", fj)
        except Exception:
            pass


def _fix_custom_filters():
    """Fix any User Permission or saved list filters referencing the old field."""
    try:
        frappe.db.sql("""
            UPDATE `tabUser Permission`
            SET `for_value` = REPLACE(`for_value`, 'custom_toc_generated', 'custom_toc_recorded_by')
            WHERE `for_value` LIKE '%%custom_toc_generated%%'
        """)
    except Exception:
        pass

    # Fix Desktop Icons with old field in filters
    try:
        for table in ("tabDesktop Icon", "tabNavigation", "tabReport Filter"):
            frappe.db.sql(f"""
                UPDATE `{table}`
                SET `filters` = REPLACE(`filters`, 'custom_toc_generated', 'custom_toc_recorded_by')
                WHERE `filters` LIKE '%%custom_toc_generated%%'
            """)
    except Exception:
        pass
