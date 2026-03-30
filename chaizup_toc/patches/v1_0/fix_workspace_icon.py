"""
Patch: Fix workspace icon from SVG path to standard Frappe icon name.
The icon must be a standard name like "graph", "stock", "chart-line" etc.
SVG paths don't render in the Frappe sidebar.
"""

import frappe

def execute():
    ws_name = "TOC Buffer Management"
    if frappe.db.exists("Workspace", ws_name):
        current_icon = frappe.db.get_value("Workspace", ws_name, "icon")
        if current_icon and ("/" in current_icon or ".svg" in current_icon):
            frappe.db.set_value("Workspace", ws_name, "icon", "graph")
            frappe.logger("chaizup_toc").info(
                f"Fixed workspace icon: '{current_icon}' → 'graph'"
            )
    frappe.db.commit()
