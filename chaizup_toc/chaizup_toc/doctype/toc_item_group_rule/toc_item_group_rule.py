import frappe
from frappe.model.document import Document


class TOCItemGroupRule(Document):
    def validate(self):
        if not self.buffer_type:
            frappe.throw(f"Row {self.idx}: Buffer Type is required for item group {self.item_group}")
        if self.priority is None or self.priority < 0:
            self.priority = 10
