# =============================================================================
# CONTEXT: TOC Public API — all @frappe.whitelist() endpoints for the dashboard,
#   item settings page, and external integrations.
# MEMORY: app_chaizup_toc.md § Key Module Structure (toc_api.py)
# INSTRUCTIONS:
#   - get_priority_board: calls calculate_all_buffers(); returns sorted buffer list.
#     buffer_type param is kept for backward compat but silently ignored — routing
#     is derived from auto_purchase/auto_manufacture flags, not a type label.
#   - trigger_manual_run: passes buffer_type to generate_material_requests() which
#     also ignores it (kept for backward compat). zone_filter is a JSON list.
#   - Number Card methods (nc_*): return single int counts from TOC Buffer Log.
#     Called by Frappe Workspace number cards — must return a plain scalar.
# DANGER ZONE:
#   - Do NOT pass buffer_type= to calculate_all_buffers() — it no longer accepts
#     that param (removed in buffer_type refactor 2026-04-27). Causes TypeError.
#   - frappe.only_for() in trigger_manual_run — do not remove. Manual run is
#     destructive (creates MRs for ALL items in zones).
# RESTRICT:
#   - Do NOT remove buffer_type param from get_priority_board / trigger_manual_run
#     signatures — existing JS callers (dashboard, item form) pass it.
#   - Do NOT add item.save() or doc manipulation here — use toc_engine modules.
# =============================================================================

"""
Chaizup TOC — Public API Endpoints
====================================
All methods are @frappe.whitelist() — callable from JS, REST, or external systems.

Usage:
  JS:   frappe.call({ method: 'chaizup_toc.api.toc_api.get_priority_board', ... })
  REST: GET /api/method/chaizup_toc.api.toc_api.get_priority_board?company=...
"""

import frappe
from frappe.utils import flt, today, cint
from frappe import _


@frappe.whitelist()
def get_priority_board(buffer_type=None, company=None, warehouse=None, item_code=None):
    """
    Returns the full Production/Procurement Priority Board.
    Sorted by BP% desc (most urgent first), T/CU as tie-breaker (F5).

    Args:
        buffer_type: kept for backward compat — silently ignored. Routing is
                     derived from auto_purchase/auto_manufacture flags per item.
        item_code: filter to a single item (used by Item form "Buffer Status" button)

    Access: Stock User, Stock Manager, TOC User, TOC Manager, System Manager
    """
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
    return calculate_all_buffers(
        company=company,
        warehouse=warehouse,
        item_code=item_code,
    )


@frappe.whitelist()
def get_single_buffer(item_code, warehouse):
    """Get buffer status for one specific item-warehouse pair."""
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
    results = calculate_all_buffers(item_code=item_code, warehouse=warehouse)
    return results[0] if results else None


@frappe.whitelist()
def trigger_manual_run(buffer_type=None, zone_filter=None):
    """
    Manually trigger Material Request generation. For testing or ad-hoc runs.
    Access: Stock Manager, TOC Manager, System Manager only.
    """
    frappe.only_for(["System Manager", "Stock Manager", "TOC Manager"])

    from chaizup_toc.toc_engine.mr_generator import generate_material_requests
    zones = frappe.parse_json(zone_filter) if zone_filter else None
    mrs = generate_material_requests(buffer_type=buffer_type, zone_filter=zones)

    return {"status": "success", "created": len(mrs), "material_requests": mrs}


@frappe.whitelist()
def recalculate_item_buffers(item_code):
    """
    Recalculate all buffer rules for an item.
    F1: Target = ADU × RLT × VF for each warehouse rule.
    F5: T/CU = (Price − TVC) ÷ (1/Speed).
    """
    frappe.only_for(["System Manager", "Stock Manager", "TOC Manager"])

    item = frappe.get_doc("Item", item_code)
    if not item.custom_toc_enabled:
        frappe.throw(f"TOC is not enabled for {item_code}")

    for rule in item.get("custom_toc_buffer_rules") or []:
        rule.target_buffer = round(flt(rule.adu) * flt(rule.rlt) * flt(rule.variability_factor))
        daf = flt(rule.daf) or 1.0
        rule.adjusted_buffer = round(rule.target_buffer * daf) if daf != 1.0 else 0

    item.flags.ignore_permissions = True
    item.save()
    return {"item_code": item_code, "rules_updated": len(item.get("custom_toc_buffer_rules") or [])}


@frappe.whitelist()
def apply_global_daf(daf_value, event_name=None):
    """
    F6: Apply Demand Adjustment Factor to ALL enabled buffer rules.
    Adjusted Buffer = Target × DAF.

    Args:
        daf_value: multiplier (e.g. 1.6 for Diwali, 0.7 for Summer)
        event_name: descriptive label (e.g. 'Diwali 2026')
    """
    frappe.only_for(["System Manager", "TOC Manager"])

    daf = flt(daf_value)
    if daf < 0.1 or daf > 5.0:
        frappe.throw("DAF must be between 0.1 and 5.0")

    # Update all active buffer rules
    rules = frappe.db.sql("""
        SELECT tib.name, tib.target_buffer
        FROM `tabTOC Item Buffer` tib
        JOIN `tabItem` i ON i.name = tib.parent
        WHERE tib.enabled = 1 AND i.custom_toc_enabled = 1
    """, as_dict=True)

    for rule in rules:
        adjusted = round(flt(rule.target_buffer) * daf)
        frappe.db.set_value("TOC Item Buffer", rule.name, {
            "daf": daf,
            "adjusted_buffer": adjusted,
        })

    # Update TOC Settings (Singleton — must use set_single_value)
    frappe.db.set_single_value("TOC Settings", "default_daf", daf)
    frappe.db.set_single_value("TOC Settings", "daf_event_name", event_name or "")

    frappe.db.commit()
    return {"updated_rules": len(rules), "daf": daf, "event": event_name}


@frappe.whitelist()
def reset_global_daf():
    """Reset DAF to 1.0 (normal operations) for all buffer rules."""
    return apply_global_daf(1.0, "Normal Operations")


@frappe.whitelist()
def get_buffer_summary():
    """Dashboard summary — counts by zone across all buffers."""
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
    buffers = calculate_all_buffers()

    summary = {"Green": 0, "Yellow": 0, "Red": 0, "Black": 0, "total": len(buffers)}
    for b in buffers:
        summary[b["zone"]] = summary.get(b["zone"], 0) + 1

    summary["avg_bp_pct"] = round(
        sum(b["bp_pct"] for b in buffers) / len(buffers), 1) if buffers else 0

    return summary


@frappe.whitelist()
def check_bom(item_code, qty=1):
    """R3: Check BOM component availability for an item."""
    from chaizup_toc.toc_engine.buffer_calculator import check_bom_availability
    return check_bom_availability(item_code, flt(qty))


# ═══════════════════════════════════════════════════════
# NUMBER CARD METHODS — Used by workspace Number Cards
# These avoid date filter parsing issues entirely.
# Each returns a single integer count.
# ═══════════════════════════════════════════════════════

@frappe.whitelist()
def nc_red_zone_count():
    """Number Card: count of TOC items currently in Red/Black zone (today's logs)."""
    return frappe.db.count("TOC Buffer Log", filters={
        "zone": ["in", ["Red", "Black"]],
        "log_date": today(),
    }) or 0


@frappe.whitelist()
def nc_yellow_zone_count():
    """Number Card: count of TOC items currently in Yellow zone (today's logs)."""
    return frappe.db.count("TOC Buffer Log", filters={
        "zone": "Yellow",
        "log_date": today(),
    }) or 0


@frappe.whitelist()
def nc_green_zone_count():
    """Number Card: count of TOC items currently in Green zone (today's logs)."""
    return frappe.db.count("TOC Buffer Log", filters={
        "zone": "Green",
        "log_date": today(),
    }) or 0


@frappe.whitelist()
def nc_open_mr_count():
    """Number Card: count of open (draft) TOC-generated Material Requests."""
    return frappe.db.count("Material Request", filters={
        "custom_toc_recorded_by": "By System",
        "docstatus": 0,
    }) or 0
