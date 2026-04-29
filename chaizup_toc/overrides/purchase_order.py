# =============================================================================
# CONTEXT: Purchase Order override — stamps TOC metadata when a PO is made
#   from a TOC-generated Material Request.
#
# WHY: TOC creates MRs with zone/BP%/target/IP/SR% metadata. When purchasing
#   staff converts a TOC MR into a Purchase Order, those fields must carry over
#   so the PO is also identifiable as TOC-generated and shows the original buffer
#   state that triggered the replenishment.
#
# HOW: On PO before_insert, scan po.items for any item.material_request link.
#   If the first linked MR has custom_toc_recorded_by = "By System", copy all
#   six TOC fields to the PO header. First TOC MR found wins (multi-MR POs are
#   rare in TOC context — all TOC MRs for a warehouse run share the same buffer).
#
# INSTRUCTIONS:
#   - Registered in hooks.py: "Purchase Order": {"before_insert": ...}
#   - Only copies when source MR is TOC-generated (By System). Manual MRs/POs
#     are left with blank TOC fields — they do not interfere.
#   - Does NOT block PO creation on any error — wrapped in try/except.
#
# DANGER ZONE:
#   - Uses frappe.db.get_value() to read MR fields — do NOT load full MR doc,
#     that would trigger MR validators unnecessarily.
#   - The six TOC fields (custom_toc_zone, etc.) must exist on tabPurchase Order.
#     They are created by chaizup_toc fixtures / via bench console on first deploy.
#
# RESTRICT:
#   - Do NOT modify PO items — only PO header TOC fields are set here.
#   - Do NOT raise exceptions inside this function — wrap everything in try/except.
#   - Do NOT change field names without updating mr_generator.py and fixtures.
# =============================================================================

import frappe
from frappe.utils import flt

_TOC_FIELDS = [
    "custom_toc_recorded_by",
    "custom_toc_zone",
    "custom_toc_bp_pct",
    "custom_toc_sr_pct",
    "custom_toc_target_buffer",
    "custom_toc_inventory_position",
]


def on_purchase_order_before_insert(doc, method):
    """Copy TOC metadata from the source Material Request to the Purchase Order header."""
    try:
        for item in doc.items or []:
            mr_name = item.get("material_request")
            if not mr_name:
                continue

            mr_fields = frappe.db.get_value(
                "Material Request", mr_name, _TOC_FIELDS, as_dict=True
            )
            if not mr_fields or mr_fields.get("custom_toc_recorded_by") != "By System":
                continue

            # First TOC-generated MR found — copy all fields to PO header
            doc.custom_toc_recorded_by        = mr_fields["custom_toc_recorded_by"]
            doc.custom_toc_zone               = mr_fields.get("custom_toc_zone") or ""
            doc.custom_toc_bp_pct             = flt(mr_fields.get("custom_toc_bp_pct"))
            doc.custom_toc_sr_pct             = flt(mr_fields.get("custom_toc_sr_pct"))
            doc.custom_toc_target_buffer      = flt(mr_fields.get("custom_toc_target_buffer"))
            doc.custom_toc_inventory_position = flt(mr_fields.get("custom_toc_inventory_position"))
            break  # one source MR is enough

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC PO field stamp failed")
