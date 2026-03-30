"""
Patch: Fix old field references in Workspace child tables and Number Cards.

In Frappe v16, workspace shortcuts are stored in child table "Workspace Shortcut"
(not as a JSON column). The stats_filter field on those child rows may contain
old field names like "custom_toc_generated" which no longer exist.

SAFEST approach: Delete the workspace record and let Frappe recreate it
from the corrected JSON file during this same migrate run.
"""
import frappe


def execute():
    # Strategy 1: Delete workspace so Frappe resyncs from corrected JSON
    _resync_workspace()

    # Strategy 2: Fix Number Cards (these ARE simple single records)
    _fix_number_cards()

    frappe.db.commit()


def _resync_workspace():
    """
    Delete the TOC workspace from DB so Frappe resyncs from the
    corrected JSON file (which has custom_toc_recorded_by, not custom_toc_generated).
    Frappe automatically recreates standard workspaces from JSON during migrate.
    """
    ws_name = "TOC Buffer Management"
    try:
        if frappe.db.exists("Workspace", ws_name):
            frappe.delete_doc("Workspace", ws_name, force=True, ignore_permissions=True)
            frappe.logger("chaizup_toc").info(
                f"Deleted workspace '{ws_name}' — will be recreated from corrected JSON"
            )
    except Exception:
        # If delete fails, try updating child table directly
        try:
            frappe.db.sql("""
                UPDATE `tabWorkspace Shortcut`
                SET stats_filter = REPLACE(stats_filter, 'custom_toc_generated', 'custom_toc_recorded_by')
                WHERE parent = %s AND stats_filter LIKE '%%custom_toc_generated%%'
            """, ws_name)
            frappe.db.sql("""
                UPDATE `tabWorkspace Shortcut`
                SET stats_filter = REPLACE(stats_filter, '",1]', '","By System"]')
                WHERE parent = %s AND stats_filter LIKE '%%custom_toc_recorded_by%%'
            """, ws_name)
        except Exception:
            pass  # Table might not exist in older Frappe


def _fix_number_cards():
    """Fix Number Card filters — these are simple single-doc records."""
    try:
        for nc_name in frappe.get_all("Number Card",
                filters={"module": "Chaizup Toc"}, pluck="name"):
            try:
                fj = frappe.db.get_value("Number Card", nc_name, "filters_json") or ""
                changed = False
                if "custom_toc_generated" in fj:
                    fj = fj.replace("custom_toc_generated", "custom_toc_recorded_by")
                    fj = fj.replace('"=",1', '"=","By System"')
                    changed = True
                if '"Today"' in fj:
                    fj = fj.replace('"log_date","=","Today"', '"log_date","Timespan","today"')
                    fj = fj.replace('"log_date",">=","Today"', '"log_date","Timespan","today"')
                    changed = True
                if changed:
                    frappe.db.set_value("Number Card", nc_name, "filters_json", fj)
            except Exception:
                pass
    except Exception:
        pass
