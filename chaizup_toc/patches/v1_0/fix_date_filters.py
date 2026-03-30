"""
Patch: Fix Number Card and Dashboard Chart date filters.
"Today" is not a valid date value in Frappe filters — use "Timespan","today" instead.
"""

import frappe


def execute():
    for nc_name in [
        "TOC - Items in Red Zone",
        "TOC - Items in Yellow Zone",
        "TOC - Items in Green Zone",
    ]:
        if frappe.db.exists("Number Card", nc_name):
            filters = frappe.db.get_value("Number Card", nc_name, "filters_json") or ""
            if '"Today"' in filters:
                new_filters = filters.replace(
                    '"log_date","=","Today"', '"log_date","Timespan","today"'
                ).replace(
                    '"log_date",">=","Today"', '"log_date","Timespan","today"'
                )
                frappe.db.set_value("Number Card", nc_name, "filters_json", new_filters)

    chart_name = "TOC - Zone Distribution"
    if frappe.db.exists("Dashboard Chart", chart_name):
        filters = frappe.db.get_value("Dashboard Chart", chart_name, "filters_json") or ""
        if '"Today"' in filters:
            new_filters = filters.replace(
                '"log_date",">=","Today"', '"log_date","Timespan","today"'
            ).replace(
                '"log_date","=","Today"', '"log_date","Timespan","today"'
            )
            frappe.db.set_value("Dashboard Chart", chart_name, "filters_json", new_filters)

    frappe.db.commit()
