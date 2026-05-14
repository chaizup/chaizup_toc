# =============================================================================
# CONTEXT: Item Minimum Manufacture (child table) — IMM-002 (2026-05-13)
#   Per-warehouse MINMFG floor used by the Production Plan Engine, AND the
#   inputs/outputs for the daily ADU-driven max-level auto-calc.
#
# MEMORY: production_plan_engine.md § "Min Manufacturing Qty"  and
#         tasks/daily_tasks.py § update_min_mfg_adu_levels (06:30 AM)
#
# FIELDS:
#   warehouse              Link → Warehouse                       (required)
#   min_manufacturing_qty  Float, in `uom`                        (required)
#   uom                    Link → UOM, gated to item.uoms + stock_uom (req.)
#   lead_time_days         Int                                    (default 0)
#   safety_factor          Float                                  (default 1.0)
#   adu                    Float, READ-ONLY (engine-written)
#   adu_lookback_days      Int,   READ-ONLY (engine-written snapshot)
#   max_level              Float, READ-ONLY (auto-calc)
#                          = adu × lead_time_days × safety_factor
#   last_updated_on        Datetime, READ-ONLY (engine-written)
#
# CALCULATIONS (IMM-002, 2026-05-13):
#   - max_level = ADU × lead × safety
#     (formula change from IMM-001 where it was qty × lead × safety —
#      that earlier definition was wrong; ADU is the right driver)
#   - Safety factor defaults to 1.0 when blank.
#   - max_level is rounded to 3 decimals.
#
# WHO WRITES WHAT:
#   - User edits: warehouse, min_manufacturing_qty, uom, lead_time_days,
#     safety_factor.
#   - Engine writes (daily 06:30 AM in `update_min_mfg_adu_levels`):
#     adu, adu_lookback_days, max_level, last_updated_on.
#   - On every Item save (server validate) we ALSO recompute max_level
#     from the CURRENT adu so a lead/safety edit takes effect immediately
#     without waiting for the next scheduled run.
#
# DANGER:
#   - Renaming `min_manufacturing_qty` breaks the engine `_build_min_mfg_map`
#     SQL (column hardcoded). Coordinate the rename.
#   - Renaming `adu` / `adu_lookback_days` / `max_level` breaks the daily
#     task `update_min_mfg_adu_levels()` SET clause.
#
# RESTRICT:
#   - Keep adu / adu_lookback_days / max_level / last_updated_on as
#     read_only=1. They are engine-owned. Removing read-only lets users
#     overwrite values that the next scheduled run will simply clobber,
#     and silently breaks downstream buffer-cap / Purchase Priority logic.
#   - Do NOT add a `parent.uoms` cross-validation here — child docs cannot
#     load the parent reliably during child validate. The Item-level
#     validate is the contract.
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

from frappe.model.document import Document
from frappe.utils import flt, cint


class ItemMinimumManufacture(Document):
    """Child row of Item.custom_minimum_manufacture.

    The UOM validity check lives on the parent Item (cannot see parent.uoms
    from a child controller). Here we only recompute max_level from the
    CURRENT adu so a writer that bypasses the Item form (REST API, bench
    console) still gets a correct max_level on save.
    """

    def validate(self):
        # IMM-002: max_level = ADU × lead × safety (corrected formula).
        # The engine populates adu daily; between runs the form may edit
        # lead_time_days / safety_factor and the cap must update without
        # waiting for the next 06:30 AM run.
        adu   = flt(self.adu or 0)
        lead  = cint(self.lead_time_days or 0)
        sf    = flt(self.safety_factor or 0) or 1.0
        self.max_level = round(adu * lead * sf, 3)
