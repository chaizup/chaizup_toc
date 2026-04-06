"""
Patch: Hide "Buffer Type [TOC App]" custom field on Item.

Buffer type is now always resolved from TOC Settings → Item Group Rules.
The field is kept in the schema so `depends_on` conditions on BOM/T/CU sections
continue to work, but it must never be user-editable or visible.
"""
import frappe


def execute():
    cf_name = "Item-custom_toc_buffer_type"
    if not frappe.db.exists("Custom Field", cf_name):
        return

    frappe.db.set_value("Custom Field", cf_name, {
        "read_only": 1,
        "hidden": 1,
        "label": "Buffer Type [TOC App]",
        "description": (
            "Auto-resolved from TOC Settings → Item Group Rules. "
            "Not user-editable. Hidden — used only for depends_on conditions."
        ),
    })
    frappe.db.commit()
    frappe.clear_cache(doctype="Item")
    frappe.logger("chaizup_toc").info(
        "Patch: Item-custom_toc_buffer_type set to hidden=1, read_only=1"
    )
