"""
Dynamic Buffer Management (DBM) Engine
========================================
F7: TMR (Too Much Red)  → Target × (1 + adj%) — buffer too small
F8: TMG (Too Much Green) → Target × (1 − adj%) — buffer too large

Safeguards:
  - MAX_TMR_CONSECUTIVE: prevents runaway buffer inflation spiral
  - MIN_BUFFER_FLOOR: prevents buffer collapse to zero
  - TMG requires 3 FULL RLT cycles (slow decrease) vs TMR at 20% of 1 RLT (fast increase)
  - This asymmetry is deliberate: stockout cost >> holding cost
"""

import frappe
from frappe.utils import flt, today, add_days, date_diff, cint
from frappe import _


def evaluate_all_dbm():
    """Weekly DBM run — check TMR/TMG for all enabled buffers."""
    settings = frappe.get_cached_doc("TOC Settings")
    if not cint(settings.enable_dbm):
        frappe.logger("chaizup_toc").info("DBM skipped — disabled in TOC Settings")
        return

    items = frappe.get_all("Item",
        filters={"custom_toc_enabled": 1, "disabled": 0},
        fields=["name"])

    tmr_count = 0
    tmg_count = 0

    for item in items:
        rules = frappe.get_all("TOC Item Buffer",
            filters={"parent": item.name, "parentfield": "custom_toc_buffer_rules", "enabled": 1},
            fields=["*"])

        for rule in rules:
            try:
                result = _evaluate_single(rule, settings)
                if result == "TMR":
                    tmr_count += 1
                elif result == "TMG":
                    tmg_count += 1
            except Exception:
                frappe.log_error(frappe.get_traceback(),
                    f"DBM Error: {item.name}/{rule.warehouse}")

    frappe.db.commit()
    frappe.logger("chaizup_toc").info(
        f"DBM Weekly: {tmr_count} TMR, {tmg_count} TMG, "
        f"{len(items)} items evaluated")


def _evaluate_single(rule, settings):
    """
    Evaluate TMR and TMG triggers for one buffer rule.

    F7 TMR: If days-in-Red > (RLT × TMR%) in last 1 RLT → increase buffer by adj%
    F8 TMG: If days-in-Green ≥ (RLT × TMG_cycles) in last N days → decrease buffer by adj%
    """
    rlt = flt(rule.rlt) or 3
    target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
    if target <= 0:
        return None

    adj_pct = flt(settings.dbm_adjustment_pct) / 100  # e.g. 0.33

    # Fetch recent buffer logs
    window = int(rlt * flt(settings.tmg_cycles_required) + 5)
    logs = frappe.get_all("TOC Buffer Log",
        filters={
            "item_code": rule.parent,
            "warehouse": rule.warehouse,
            "log_date": [">=", add_days(today(), -window)]
        },
        fields=["zone", "log_date"],
        order_by="log_date asc")

    if not logs:
        return None

    # ── F7: TMR CHECK (Too Much Red) ──
    recent = [l for l in logs if date_diff(today(), l.log_date) <= rlt]
    if recent:
        red_days = len([l for l in recent if l.zone in ("Red", "Black")])
        threshold = rlt * flt(settings.tmr_red_pct_of_rlt) / 100

        if red_days > threshold:
            max_tmr = cint(settings.max_tmr_consecutive)
            if (rule.tmr_count or 0) >= max_tmr:
                frappe.log_error(
                    f"TMR SAFEGUARD: {rule.parent}/{rule.warehouse} — "
                    f"{max_tmr} consecutive increases. Manual review needed. "
                    f"Current target: {target}",
                    "DBM TMR Safeguard")
                return None

            new_target = round(target * (1 + adj_pct))
            frappe.db.set_value("TOC Item Buffer", rule.name, {
                "target_buffer": new_target,
                "tmr_count": (rule.tmr_count or 0) + 1,
                "tmg_green_days": 0,
                "last_dbm_date": today(),
            })
            frappe.logger("chaizup_toc").info(
                f"F7 TMR: {rule.parent}/{rule.warehouse} — "
                f"Buffer {target} → {new_target} (+{settings.dbm_adjustment_pct}%)")
            return "TMR"

    # ── F8: TMG CHECK (Too Much Green) ──
    tmg_window = int(rlt * cint(settings.tmg_cycles_required))
    tmg_logs = [l for l in logs if date_diff(today(), l.log_date) <= tmg_window]

    if len(tmg_logs) >= tmg_window:
        green_days = len([l for l in tmg_logs if l.zone == "Green"])
        if green_days >= tmg_window:
            floor = flt(settings.min_buffer_floor)
            new_target = max(floor, round(target * (1 - adj_pct)))
            if new_target >= target:
                return None  # Already at floor

            frappe.db.set_value("TOC Item Buffer", rule.name, {
                "target_buffer": new_target,
                "tmr_count": 0,
                "tmg_green_days": 0,
                "last_dbm_date": today(),
            })
            frappe.logger("chaizup_toc").info(
                f"F8 TMG: {rule.parent}/{rule.warehouse} — "
                f"Buffer {target} → {new_target} (−{settings.dbm_adjustment_pct}%)")
            return "TMG"

    return None
