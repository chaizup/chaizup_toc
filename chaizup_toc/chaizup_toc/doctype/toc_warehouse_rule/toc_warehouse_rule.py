import frappe
from frappe.model.document import Document


class TOCWarehouseRule(Document):
    def validate(self):
        if not self.warehouse_purpose:
            frappe.throw(f"Row {self.idx}: Purpose is required for warehouse {self.warehouse}")
