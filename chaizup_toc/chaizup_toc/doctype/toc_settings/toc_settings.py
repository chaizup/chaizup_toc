import frappe
from frappe.model.document import Document
from frappe.utils import flt


class TOCSettings(Document):
    def validate(self):
        self._validate_zone_thresholds()
        self._validate_dbm_params()
        self._validate_warehouse_rules()
        self._validate_item_group_rules()

    def _validate_zone_thresholds(self):
        if flt(self.red_zone_threshold) <= flt(self.yellow_zone_threshold):
            frappe.throw("Red Zone Threshold must be greater than Yellow Zone Threshold")
        if flt(self.default_vf) < 1.0:
            frappe.throw("Default Variability Factor must be ≥ 1.0")

    def _validate_dbm_params(self):
        if flt(self.dbm_adjustment_pct) <= 0 or flt(self.dbm_adjustment_pct) > 100:
            frappe.throw("DBM Adjustment % must be between 1 and 100")

    def _validate_warehouse_rules(self):
        if not self.warehouse_rules:
            frappe.msgprint(
                "No Warehouse Classification rules defined. Buffer calculations will use the "
                "warehouse specified on each item's buffer rule. Scrap, Expiry, and Wastage "
                "warehouses will not be automatically excluded.",
                indicator="orange",
                alert=True
            )
            return

        seen = {}
        for row in self.warehouse_rules:
            if row.warehouse in seen:
                frappe.throw(
                    f"Row {row.idx}: Warehouse <b>{row.warehouse}</b> is already classified "
                    f"in row {seen[row.warehouse]}. Each warehouse can only appear once."
                )
            seen[row.warehouse] = row.idx

        inventory_count = sum(1 for r in self.warehouse_rules if r.warehouse_purpose == "Inventory")
        if inventory_count == 0:
            frappe.msgprint(
                "Warehouse Classification is defined but no warehouses are marked as "
                "<b>Inventory</b>. All items will show 0 on-hand stock. "
                "Mark your main stores as 'Inventory'.",
                indicator="orange"
            )

    def _validate_item_group_rules(self):
        if not self.item_group_rules:
            return

        from collections import defaultdict
        group_entries = defaultdict(list)
        for row in self.item_group_rules:
            group_entries[row.item_group].append(row.idx)

        conflicts = {g: rows for g, rows in group_entries.items() if len(rows) > 1}
        if conflicts:
            msgs = [f"<b>{g}</b> (rows {', '.join(str(r) for r in rows)})"
                    for g, rows in conflicts.items()]
            frappe.msgprint(
                "Duplicate item group rules found — use Priority to resolve conflicts:<br>" +
                "<br>".join(msgs),
                indicator="orange"
            )
