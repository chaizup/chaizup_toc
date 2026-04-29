# =============================================================================
# CONTEXT: SP Minimum Manufacture — child table of Sales Projection.
#   Defines per-item per-warehouse minimum production batch sizes.
#   The Production Plan Automation engine reads this table to ensure Production
#   Plans are never created below machine utilisation thresholds.
# MEMORY: production_plan_engine.md § Min Manufacturing Qty
# RESTRICT:
#   - Controller body intentionally empty — all logic lives in production_plan_engine.py.
#   - Do NOT add validate() here that changes qty/uom values — the engine reads the
#     raw values and performs its own UOM conversion to stock UOM.
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

from frappe.model.document import Document


class SpMinimumManufacture(Document):
	pass
