# =============================================================================
# CONTEXT: Sales Projected Items — child table controller + whitelisted UOM search.
#   Controller body is intentionally empty (all logic lives in the parent form).
#   get_item_uoms() filters the UOM Link field to show only UOMs valid for the
#   selected item (its stock_uom + all entries in UOM Conversion Detail).
# MEMORY:  sales_projected_items.md § UOM Filtering
# INSTRUCTIONS:
#   - get_item_uoms() is registered as get_query in sales_projection.js on the
#     uom_unit_of_measurement field of the child table grid.
#   - Function signature (doctype, txt, searchfield, start, page_len, filters)
#     is required by Frappe link-search — do NOT rename parameters.
#   - filters may arrive as a dict or a JSON string — always call parse_json guard.
# DANGER ZONE:
#   - SQL uses UNION (not UNION ALL) to deduplicate if stock_uom also appears
#     in UOM Conversion Detail (ERPNext sometimes adds the stock UOM as a 1:1 row).
#   - Do NOT add LIMIT before the UNION subqueries — MariaDB syntax requires the
#     LIMIT on the outer query only.
# RESTRICT:
#   - Do not remove the stock_uom UNION branch — stock_uom is always a valid
#     selection even when no UOM Conversion Detail row exists for it.
#   - Do not rename this file — sales_projection.js calls the full dotted path
#     chaizup_toc.chaizup_toc.doctype.sales_projected_items.sales_projected_items.get_item_uoms
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class SalesProjectedItems(Document):
	pass


# =============================================================================
# CONTEXT: Frappe link-search function for the UOM field in the child table grid.
#   Returns all UOMs available for the given item:
#     - All UOMs listed in the item's UOM Conversion Detail child table
#     - The item's own stock_uom (always included, may have no conversion row)
# INSTRUCTIONS:
#   - Called by sales_projection.js via get_query on uom_unit_of_measurement field
#   - filters["item_code"] is set by the JS from the current child row's item field
# DANGER ZONE:
#   - frappe.db.sql returns list of tuples; each tuple = one row in the search
#     dropdown. Format: [(uom_name,), ...] — Frappe renders the first element.
#   - If item_code is empty (row has no item yet), return [] immediately to
#     avoid returning ALL UOMs in the system.
# =============================================================================
@frappe.whitelist()
def get_uom_conversion_factor(item_code, uom):
    """
    Return the conversion_factor for a given item + UOM from UOM Conversion Detail.
    Returns 1 if no row exists (stock UOM has no conversion row — factor is always 1).
    Called by _fetch_conversion_factor in sales_projection.js to avoid a direct
    frappe.db.get_value call on UOM Conversion Detail (which requires read permission).
    """
    if not item_code or not uom:
        return 1

    cf = frappe.db.get_value(
        "UOM Conversion Detail",
        {"parent": item_code, "uom": uom},
        "conversion_factor",
    )
    return float(cf) if cf else 1


@frappe.whitelist()
def get_item_uoms(doctype, txt, searchfield, start, page_len, filters):
	if isinstance(filters, str):
		filters = frappe.parse_json(filters)

	item_code = (filters or {}).get("item_code", "")
	if not item_code:
		return []

	return frappe.db.sql(
		"""
		SELECT name
		FROM `tabUOM`
		WHERE name IN (
			SELECT uom
			FROM `tabUOM Conversion Detail`
			WHERE parent = %(item_code)s
			UNION
			SELECT stock_uom
			FROM `tabItem`
			WHERE name = %(item_code)s
		)
		AND name LIKE %(txt)s
		ORDER BY name
		LIMIT %(page_len)s OFFSET %(start)s
		""",
		{
			"item_code": item_code,
			"txt": f"%{txt}%",
			"page_len": int(page_len),
			"start": int(start),
		},
	)
