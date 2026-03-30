"""Permission helpers for TOC DocTypes."""
import frappe

def has_buffer_log_permission(doc, ptype, user):
    if ptype == "read":
        return True
    roles = frappe.get_roles(user)
    return "TOC Manager" in roles or "System Manager" in roles or "Stock Manager" in roles


def has_app_permission():
    """
    Controls visibility of the Chaizup TOC tile on the Frappe apps home screen.
    Returns True if the current user has any TOC or supply-chain role.
    All System Managers and Administrators always see the tile.
    """
    roles = frappe.get_roles(frappe.session.user)
    allowed = {
        "System Manager", "Administrator",
        "TOC Manager", "TOC User",
        "Stock Manager", "Stock User",
        "Purchase Manager", "Purchase User",
        "Manufacturing Manager", "Manufacturing User",
    }
    return bool(allowed & set(roles))
