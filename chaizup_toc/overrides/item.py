"""
Item Override — validates TOC Setting tab configuration.
R1: Custom ADU logic
R2: Auto Purchase vs Auto Manufacturing mutual exclusion
"""
import frappe
from frappe.utils import flt


def _resolve_buffer_type_for_item(doc):
    """
    Resolve buffer type from TOC Settings → Item Group Rules.
    Sets doc.custom_toc_buffer_type (hidden field) so depends_on
    conditions on BOM/T/CU sections continue to work correctly.
    """
    try:
        from chaizup_toc.toc_engine.buffer_calculator import _resolve_buffer_type, _get_settings
        settings = _get_settings()
        btype = _resolve_buffer_type(doc.name, doc.item_group, settings)
        doc.custom_toc_buffer_type = btype or ""
        return btype or ""
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC: buffer type resolution failed on item validate")
        return doc.get("custom_toc_buffer_type") or ""


def on_item_validate(doc, method):
    if not doc.custom_toc_enabled:
        return

    # Auto-resolve buffer type from TOC Settings → Item Group Rules
    btype = _resolve_buffer_type_for_item(doc)
    if not btype:
        frappe.msgprint(
            f"No buffer type rule found for item group '{doc.item_group}' in "
            "TOC Settings → Item Group Rules. Please add a matching rule.",
            indicator="orange", alert=True)

    # R1: If Custom ADU is checked, make ADU editable; otherwise read-only
    # (handled in JS — here we just validate the value)
    if doc.custom_toc_custom_adu and flt(doc.custom_toc_adu_value) <= 0:
        frappe.msgprint(
            "You have 'Custom ADU' checked but ADU Value is 0. "
            "Please enter your manual ADU value (units/day).",
            indicator="orange", alert=True)

    # Mutual exclusion: Auto Purchase vs Auto Manufacturing
    if doc.custom_toc_auto_purchase and doc.custom_toc_auto_manufacture:
        frappe.throw(
            "Choose ONE: 'Auto Purchase TOC' (for items you BUY) OR "
            "'Auto Manufacturing TOC' (for items you PRODUCE). "
            "An item cannot be both purchased and manufactured.",
            title="TOC: Choose Purchase or Manufacturing")

    if not doc.custom_toc_auto_purchase and not doc.custom_toc_auto_manufacture:
        if doc.custom_toc_enabled:
            frappe.msgprint(
                "Neither 'Auto Purchase TOC' nor 'Auto Manufacturing TOC' is checked. "
                "TOC will monitor this item but will NOT auto-create Material Requests.",
                indicator="orange", alert=True)

    # F5: T/CU calculation for FG (uses auto-resolved btype)
    if btype == "FG":
        price = flt(doc.custom_toc_selling_price)
        tvc = flt(doc.custom_toc_tvc)
        speed = flt(doc.custom_toc_constraint_speed)
        if price and speed > 0:
            doc.custom_toc_tcu = round((price - tvc) * speed, 2)
        else:
            doc.custom_toc_tcu = 0

    # R3: Validate BOM link
    if doc.custom_toc_default_bom:
        bom_item = frappe.db.get_value("BOM", doc.custom_toc_default_bom, "item")
        if bom_item != doc.name:
            frappe.throw(f"BOM '{doc.custom_toc_default_bom}' belongs to item '{bom_item}', not '{doc.name}'.")

    # Check buffer rules exist
    if not (doc.get("custom_toc_buffer_rules") or []):
        frappe.msgprint(
            "TOC is enabled but no buffer rules added. "
            "Add warehouse rules in Section 5 below.",
            indicator="orange", alert=True)
