import frappe
from frappe.model.document import Document
from frappe.utils import flt


class TOCItemBuffer(Document):
    def validate(self):
        self.calculate_target_buffer()
        self.calculate_adjusted_buffer()
        self.calculate_zone_thresholds()
        self.validate_inputs()

    def calculate_target_buffer(self):
        """F1: Target Buffer = ADU × RLT × VF"""
        self.target_buffer = round(flt(self.adu) * flt(self.rlt) * flt(self.variability_factor))

    def calculate_adjusted_buffer(self):
        """F6: Adjusted Buffer = Target × DAF"""
        daf = flt(self.daf) or 1.0
        if daf != 1.0:
            self.adjusted_buffer = round(flt(self.target_buffer) * daf)
        else:
            self.adjusted_buffer = 0

    def calculate_zone_thresholds(self):
        """Calculate stock qty boundaries for each zone."""
        effective = flt(self.adjusted_buffer) or flt(self.target_buffer)
        try:
            settings = frappe.get_cached_doc("TOC Settings")
            yellow_threshold = flt(settings.yellow_zone_threshold)
        except Exception:
            yellow_threshold = 33.0  # Default: 33% threshold
        red_pct = yellow_threshold / 100  # stock below 33% of buffer = Red zone
        self.red_zone_qty = round(effective * red_pct)
        self.yellow_zone_qty = round(effective * (1 - yellow_threshold / 100))

    def validate_inputs(self):
        if flt(self.adu) <= 0:
            frappe.throw(f"Row {self.idx}: ADU (Average Daily Usage) must be > 0")
        if flt(self.rlt) <= 0:
            frappe.throw(f"Row {self.idx}: RLT (Replenishment Lead Time) must be > 0")
        if flt(self.variability_factor) < 1.0:
            frappe.throw(f"Row {self.idx}: Variability Factor must be ≥ 1.0 (1.0 = no variability)")
        if flt(self.variability_factor) > 3.0:
            frappe.msgprint(f"Row {self.idx}: VF > 3.0 is unusually high — verify this is intentional.", indicator="orange")
        if flt(self.daf) and (flt(self.daf) < 0.1 or flt(self.daf) > 5.0):
            frappe.throw(f"Row {self.idx}: DAF must be between 0.1 and 5.0")
