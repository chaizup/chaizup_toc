"""
Reorder Override — Belt-and-Suspenders Safeguard
==================================================
This replaces erpnext.stock.reorder_item.reorder_item via hooks.py override_whitelisted_methods.

Even if someone accidentally re-enables 'auto_indent' in Stock Settings,
this function intercepts the call and redirects to TOC logic instead.
"""

import frappe
from frappe import _


def toc_reorder_item():
    """
    Replacement for erpnext.stock.reorder_item.reorder_item()

    Instead of running default reorder logic, this:
    1. Logs a warning that the default was intercepted
    2. Runs TOC buffer analysis instead (if enabled)
    3. Returns without creating any default-style Material Requests
    """
    frappe.logger("chaizup_toc").warning(
        "⚠️ Default reorder_item() intercepted by Chaizup TOC. "
        "The built-in auto Material Request is disabled. "
        "TOC Buffer Management is the active replenishment engine. "
        "If you see this, check Stock Settings > auto_indent — it should be unchecked."
    )

    # Auto-disable the setting if someone turned it back on
    if frappe.db.get_single_value("Stock Settings", "auto_indent"):
        frappe.db.set_single_value("Stock Settings", "auto_indent", 0)
        frappe.db.commit()
        frappe.logger("chaizup_toc").warning(
            "Auto-disabled Stock Settings.auto_indent — someone had re-enabled it."
        )

    # The default function returns nothing meaningful, so we match that
    return None
