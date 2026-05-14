"""
Item Override — validates TOC Setting tab configuration.
# =============================================================================
# CONTEXT: Validates TOC fields on Item save. No buffer-type classification.
#   Replenishment mode (Purchase/Manufacture) is set by the user directly via
#   checkboxes — not resolved from any Item Group mapping.
# MEMORY: app_chaizup_toc.md § Item Override
# INSTRUCTIONS:
#   - R1: Skip ADU auto-calc warning (handled in daily_tasks.py).
#   - R2: Mutual exclusion — auto_purchase XOR auto_manufacture.
#   - F5: T/CU auto-calc runs for any item with auto_manufacture enabled.
#   - R3: BOM link ownership validated — BOM must belong to this item.
# DANGER ZONE:
#   - Do NOT re-add _resolve_buffer_type_for_item().
#   - Do NOT add any item-group or item-category checks here.
# RESTRICT:
#   - Do NOT remove the mutual exclusion (R2) — it prevents invalid MR routing.
# =============================================================================
"""
import frappe
from frappe.utils import flt


def on_item_validate(doc, method):
    # IMM-001 (2026-05-13): MUST run BEFORE the TOC-enabled early return.
    # The custom_minimum_manufacture table is consulted by the Production
    # Plan engine for every item with a BOM, regardless of whether
    # custom_toc_enabled is set. Skipping validation for non-TOC items
    # would let invalid UOM rows persist and break the engine downstream.
    _validate_min_mfg_rows(doc)

    if not doc.custom_toc_enabled:
        return

    # R1: Custom ADU value check
    if doc.custom_toc_custom_adu and flt(doc.custom_toc_adu_value) <= 0:
        frappe.msgprint(
            "You have 'Custom ADU' checked but ADU Value is 0. "
            "Please enter your manual ADU value (units/day).",
            indicator="orange", alert=True)

    # R2: Mutual exclusion — auto_purchase XOR auto_manufacture
    if doc.custom_toc_auto_purchase and doc.custom_toc_auto_manufacture:
        frappe.throw(
            "Choose ONE replenishment mode: 'Auto Purchase TOC' (for items you BUY) OR "
            "'Auto Manufacturing TOC' (for items you PRODUCE). Not both.",
            title="TOC: Choose Purchase or Manufacturing")

    if not doc.custom_toc_auto_purchase and not doc.custom_toc_auto_manufacture:
        frappe.msgprint(
            "Neither 'Auto Purchase TOC' nor 'Auto Manufacturing TOC' is checked. "
            "TOC will monitor this item but will NOT auto-create Material Requests.",
            indicator="orange", alert=True)

    # F5: T/CU for any manufactured item (not restricted to FG)
    if doc.custom_toc_auto_manufacture:
        price = flt(doc.custom_toc_selling_price)
        tvc = flt(doc.custom_toc_tvc)
        speed = flt(doc.custom_toc_constraint_speed)
        doc.custom_toc_tcu = round((price - tvc) * speed, 2) if price and speed > 0 else 0
    else:
        doc.custom_toc_tcu = 0

    # R3: Validate BOM link ownership
    if doc.custom_toc_default_bom:
        bom_item = frappe.db.get_value("BOM", doc.custom_toc_default_bom, "item")
        if bom_item != doc.name:
            frappe.throw(f"BOM '{doc.custom_toc_default_bom}' belongs to item '{bom_item}', not '{doc.name}'.")

    # Warn if buffer rules missing
    if not (doc.get("custom_toc_buffer_rules") or []):
        frappe.msgprint(
            "TOC is enabled but no buffer rules added. "
            "Add warehouse rules in Section 5 below.",
            indicator="orange", alert=True)


def _validate_min_mfg_rows(doc):
    """Validate every Item Minimum Manufacture child row + recompute max_level.

    Called from on_item_validate above. Runs regardless of `custom_toc_enabled`
    because the table is independent of TOC mode — the Production Plan engine
    consults it directly even on non-TOC items.
    """
    rows = doc.get("custom_minimum_manufacture") or []
    if not rows:
        return

    allowed = {r.uom for r in (doc.get("uoms") or []) if r.uom}
    if doc.stock_uom:
        allowed.add(doc.stock_uom)

    if not allowed:
        # Hard guard: any row at all with zero UOMs configured is illegal.
        frappe.throw(
            "Cannot save: <b>Minimum Manufacture / Purchase Qty per Warehouse</b> "
            "has rows but the Item has no <b>Units of Measure</b> configured. "
            "Add at least one UOM in the Units of Measure section first, then "
            "re-pick the UOM on each Min Manufacture row.",
            title="UOM Required",
        )

    for idx, row in enumerate(rows, start=1):
        if row.uom and row.uom not in allowed:
            frappe.throw(
                f"Row #{idx} of <b>Minimum Manufacture / Purchase Qty per "
                f"Warehouse</b> uses UOM <b>{frappe.utils.escape_html(row.uom)}</b>, "
                f"which is NOT in this Item Units of Measure table. "
                f"Allowed UOMs: {', '.join(sorted(allowed)) or '(none)'}.",
                title="UOM not configured on this Item",
            )

        # IMM-002: max_level = ADU × lead × safety  (corrected formula).
        # The daily engine task (update_min_mfg_adu_levels) refreshes
        # `adu` + `adu_lookback_days` + `last_updated_on` + `max_level`.
        # On every Item save we ALSO recompute max_level so a lead /
        # safety edit takes effect immediately (between scheduled runs).
        # Safety factor defaults to 1.0 when blank.
        adu  = flt(row.adu or 0)
        lead = int(row.lead_time_days or 0)
        sf   = flt(row.safety_factor or 0) or 1.0
        row.max_level = round(adu * lead * sf, 3)
