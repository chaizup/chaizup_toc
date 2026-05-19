# =============================================================================
# CONTEXT: UOM helpers used by the MRP/UOM client scripts on
#   Work Order, Production Plan Item, and BOM.
#
#   Two surfaces:
#     1. get_item_uoms       — Frappe LINK-QUERY function. Powers a
#                              `frm.set_query("custom_uom", …)` so the UOM
#                              dropdown shows ONLY the alt UOMs defined on
#                              the production item. No more 200-row UOM
#                              dropdown.
#     2. get_uom_conversion_factor — Plain endpoint returning a Float CF
#                              for (item, uom). Replaces frappe.client.get_list
#                              on UOM Conversion Detail, which is perm-blocked
#                              for non-admin users.
#
# MEMORY: app_chaizup_toc.md § MRP & UOM custom fields (added 2026-05-18)
#
# INSTRUCTIONS:
#   - get_item_uoms follows the Frappe link-query contract: signature
#       (doctype, txt, searchfield, start, page_len, filters)
#     returns a list of tuples (value, description). The `filters` dict
#     carries the item_code via set_query's `filters` argument.
#   - get_uom_conversion_factor returns a single float. If the (item, uom)
#     pair isn't in tabUOM Conversion Detail, returns 0 — the JS treats
#     0 as "no auto-compute" so the user can still type qty manually.
#
# DANGER ZONE:
#   - UOM Conversion Detail is a Frappe child DocType. Direct frappe.get_all
#     queries on it require explicit `parent_doctype="Item"` filter and
#     server-side perms — that's why these helpers exist.
#   - Do NOT widen the get_item_uoms output to ALL UOMs when item_code is
#     blank — that defeats the point of the filter. Return an empty list
#     and let the user pick production_item first.
#
# RESTRICT:
#   - These endpoints are whitelisted. They accept item_code from the JS;
#     don't trust the input — frappe.db parameter binding prevents SQL
#     injection, but anyone with desk read can call them. That's fine
#     because UOM and UOM Conversion Detail are not sensitive.
#   - Do NOT change the function names — they're referenced by JS via
#     `chaizup_toc.api.uom_query.<name>`.
# =============================================================================

import frappe
from frappe.utils import flt


@frappe.whitelist()
def get_item_uoms(doctype, txt, searchfield, start, page_len, filters):
    """Frappe Link-query function: returns only UOMs in the item's
    Conversion Detail ladder. Used by `frm.set_query("custom_uom", …)`.

    `filters` must carry {"item_code": "<item code>"}.

    Returns:
        list of tuples [(uom_name, description_str), ...] sorted by
        conversion_factor DESC (biggest UOM first so users see "Carton"
        before "Gram").

    INSTRUCTIONS:
      - If `item_code` is empty/missing, returns an empty list rather
        than every UOM in the system. The JS keeps the field disabled
        until production_item is picked anyway, but this is a safety net.
      - `txt` is the substring the user is typing; we LIKE-match against
        the UOM name.
    """
    filters = filters or {}
    if isinstance(filters, str):
        try:
            import json
            filters = json.loads(filters)
        except Exception:
            filters = {}
    item_code = (filters.get("item_code") or "").strip()
    if not item_code:
        return []

    txt = "%" + (txt or "").replace("%", r"\%") + "%"
    rows = frappe.db.sql(
        """
        SELECT u.uom AS uom, u.conversion_factor AS cf
        FROM `tabUOM Conversion Detail` u
        WHERE u.parent = %(item)s
          AND u.parenttype = 'Item'
          AND u.uom LIKE %(txt)s
          AND IFNULL(u.conversion_factor, 0) > 0
        ORDER BY u.conversion_factor DESC
        LIMIT %(pl)s OFFSET %(st)s
        """,
        {"item": item_code, "txt": txt, "pl": int(page_len or 20),
         "st": int(start or 0)},
        as_dict=True,
    )
    # Frappe link-query expects each row as (value, description).
    # We pack the CF into the description so users see e.g.
    # "CFC / Master   ×100" right in the dropdown.
    return [
        (r.uom, f"× {flt(r.cf):g}")
        for r in rows
    ]


@frappe.whitelist()
def get_uom_conversion_factor(item_code, uom):
    """Return the conversion factor for (item_code, uom) from the item's
    UOM Conversion Detail ladder. Returns 0 if not found.

    INSTRUCTIONS:
      - Called by the WO / PP / BOM client scripts every time the user
        picks a UOM, to auto-fill `custom_uom_conversion_factor` and
        recompute the standard `qty` field.
      - Stock UOM (CF=1) is included in the ladder by default in ERPNext,
        so picking the stock UOM returns 1.0 (correct).
    """
    if not item_code or not uom:
        return 0.0
    cf = frappe.db.get_value(
        "UOM Conversion Detail",
        {"parent": item_code, "parenttype": "Item", "uom": uom},
        "conversion_factor",
    )
    return flt(cf or 0)


@frappe.whitelist()
def get_default_higher_uom(item_code):
    """
    Return the item's DEFAULT higher UOM: the largest-CF row in
    tabUOM Conversion Detail whose UOM is NOT the stock UOM. This is the
    UOM that auto-populates `custom_uom` on Work Order / Production Plan
    Item / Production Plan Sub Assembly Item / BOM forms when the
    production item is picked.

    Returns:
        {"uom": "Carton", "conversion_factor": 12.0}
        or
        {"uom": "",       "conversion_factor": 1.0}   (no alt UOM exists)

    INSTRUCTIONS:
      - When the item's only UOM Conversion Detail row IS the stock UOM
        (CF=1), this returns `("", 1.0)`. The JS controller treats that
        as "no auto-default" and leaves the picker blank — the user
        sees the standard `quantity` / `qty` / `planned_qty` field as
        the authoritative input. Don't change to "return stock UOM"
        without updating the JS: a custom_uom = stock UOM would write
        `quantity = qiu × 1.0` which is fine but confusing for users.

    DANGER ZONE:
      - Items with multiple alt UOMs all > stock_uom — we return the
        LARGEST. If a site needs "default to the 2nd-largest" or
        "default to Carton if present, else largest", add a per-Item
        Customisation field; do NOT modify this helper.
    """
    if not item_code:
        return {"uom": "", "conversion_factor": 1.0}
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""
    row = frappe.db.sql(
        """
        SELECT uom, conversion_factor
        FROM `tabUOM Conversion Detail`
        WHERE parent = %(item)s
          AND parenttype = 'Item'
          AND uom != %(stock)s
          AND IFNULL(conversion_factor, 0) > 1
        ORDER BY conversion_factor DESC
        LIMIT 1
        """,
        {"item": item_code, "stock": stock_uom},
        as_dict=True,
    )
    if row:
        r = row[0]
        return {"uom": r.uom, "conversion_factor": flt(r.conversion_factor)}
    return {"uom": "", "conversion_factor": 1.0}


@frappe.whitelist()
def get_item_uoms_payload(item_code):
    """Return the full UOM ladder for `item_code` in one call.

    Used by client scripts to populate filter dropdowns without making
    one round trip per UOM. Shape:
       [{"uom": "Carton", "conversion_factor": 100}, ...]
    Sorted by CF desc.
    """
    if not item_code:
        return []
    return frappe.db.sql(
        """
        SELECT uom, conversion_factor
        FROM `tabUOM Conversion Detail`
        WHERE parent = %(item)s
          AND parenttype = 'Item'
          AND IFNULL(conversion_factor, 0) > 0
        ORDER BY conversion_factor DESC
        """,
        {"item": item_code},
        as_dict=True,
    )
