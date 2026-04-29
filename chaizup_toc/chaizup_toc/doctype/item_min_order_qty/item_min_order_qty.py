# =============================================================================
# CONTEXT: Item Min Order Qty — child table on Item Master.
#   Stores the minimum purchase / production quantity per warehouse.
#   Used by two automation engines:
#     1. component_mr_generator.py — post-WO component shortage MR creation
#     2. mr_generator.py — buffer-triggered purchase MR creation
#   Both apply: order_qty = max(shortage, stock_uom_qty)
#
# INSTRUCTIONS:
#   - validate() auto-populates stock_uom, conversion_factor, stock_uom_qty.
#   - stock_uom is fetched from the parent Item's stock_uom field.
#   - conversion_factor is fetched from UOM Conversion Detail on the parent Item.
#     If no conversion row exists and uom == stock_uom, cf = 1.0.
#     If no conversion row exists and uom != stock_uom, cf = 1.0 (silent fallback;
#     user should configure UOM Conversion Detail on the Item first).
#   - stock_uom_qty = min_order_qty × conversion_factor.
#     This is the effective floor in Stock UOM used at runtime.
#
# DANGER ZONE:
#   - Do NOT call frappe.db.commit() here — child rows save as part of parent Item.
#   - parenttype check ('Item') ensures this validator only fires for Item rows.
#     It is safe to skip validation for other parent contexts (future-proofing).
#
# RESTRICT:
#   - Do NOT make stock_uom, conversion_factor, or stock_uom_qty user-editable.
#     They are display/runtime fields auto-populated from Item + UOM Conversion Detail.
#   - Do NOT rename 'custom_min_order_qty' parentfield — it is referenced in
#     build_min_order_map() in component_mr_generator.py.
# =============================================================================

import frappe
from frappe.model.document import Document
from frappe.utils import flt


class ItemMinOrderQty(Document):
    def validate(self):
        if self.parenttype != "Item":
            return
        self._populate_stock_uom()
        self._populate_conversion_factor()
        self._compute_stock_uom_qty()

    def _populate_stock_uom(self):
        self.stock_uom = frappe.db.get_value("Item", self.parent, "stock_uom") or ""

    def _populate_conversion_factor(self):
        if not self.uom:
            self.conversion_factor = 1.0
            return
        if self.uom == self.stock_uom:
            self.conversion_factor = 1.0
            return
        cf = frappe.db.get_value(
            "UOM Conversion Detail",
            {"parent": self.parent, "uom": self.uom},
            "conversion_factor",
        )
        self.conversion_factor = flt(cf) if cf else 1.0

    def _compute_stock_uom_qty(self):
        cf = flt(self.conversion_factor) if flt(self.conversion_factor) > 0 else 1.0
        self.stock_uom_qty = flt(self.min_order_qty) * cf
