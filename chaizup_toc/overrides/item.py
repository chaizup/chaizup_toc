"""
Item Override — validates TOC Setting tab configuration.
# =============================================================================
# CONTEXT: Validates TOC fields on Item save. No buffer-type classification.
#   Replenishment mode (Purchase/Manufacture) is set by the user directly via
#   checkboxes — not resolved from any Item Group mapping.
# MEMORY: app_chaizup_toc.md § Item Override
# INSTRUCTIONS:
#   - R1: Skip ADU auto-calc warning (handled in daily_tasks.py).
#   - R2: Mutual exclusion — auto_purchase XOR auto_manufacture.
#   - F5: T/CU auto-calc runs for any item with auto_manufacture enabled.
#   - R3: BOM link ownership validated — BOM must belong to this item.
# DANGER ZONE:
#   - Do NOT re-add _resolve_buffer_type_for_item().
#   - Do NOT add any item-group or item-category checks here.
# RESTRICT:
#   - Do NOT remove the mutual exclusion (R2) — it prevents invalid MR routing.
# =============================================================================
"""
import frappe
from frappe.utils import flt


def on_item_validate(doc, method):
    if not doc.custom_toc_enabled:
        return

    # R1: Custom ADU value check
    if doc.custom_toc_custom_adu and flt(doc.custom_toc_adu_value) <= 0:
        frappe.msgprint(
            "You have 'Custom ADU' checked but ADU Value is 0. "
            "Please enter your manual ADU value (units/day).",
            indicator="orange", alert=True)

    # R2: Mutual exclusion — auto_purchase XOR auto_manufacture
    if doc.custom_toc_auto_purchase and doc.custom_toc_auto_manufacture:
        frappe.throw(
            "Choose ONE replenishment mode: 'Auto Purchase TOC' (for items you BUY) OR "
            "'Auto Manufacturing TOC' (for items you PRODUCE). Not both.",
            title="TOC: Choose Purchase or Manufacturing")

    if not doc.custom_toc_auto_purchase and not doc.custom_toc_auto_manufacture:
        frappe.msgprint(
            "Neither 'Auto Purchase TOC' nor 'Auto Manufacturing TOC' is checked. "
            "TOC will monitor this item but will NOT auto-create Material Requests.",
            indicator="orange", alert=True)

    # F5: T/CU for any manufactured item (not restricted to FG)
    if doc.custom_toc_auto_manufacture:
        price = flt(doc.custom_toc_selling_price)
        tvc = flt(doc.custom_toc_tvc)
        speed = flt(doc.custom_toc_constraint_speed)
        doc.custom_toc_tcu = round((price - tvc) * speed, 2) if price and speed > 0 else 0
    else:
        doc.custom_toc_tcu = 0

    # R3: Validate BOM link ownership
    if doc.custom_toc_default_bom:
        bom_item = frappe.db.get_value("BOM", doc.custom_toc_default_bom, "item")
        if bom_item != doc.name:
            frappe.throw(f"BOM '{doc.custom_toc_default_bom}' belongs to item '{bom_item}', not '{doc.name}'.")

    # Warn if buffer rules missing
    if not (doc.get("custom_toc_buffer_rules") or []):
        frappe.msgprint(
            "TOC is enabled but no buffer rules added. "
            "Add warehouse rules in Section 5 below.",
            indicator="orange", alert=True)
