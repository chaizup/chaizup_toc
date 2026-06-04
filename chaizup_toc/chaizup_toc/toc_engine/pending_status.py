"""
TOC Pending-Status Resolver — per-trigger OVERRIDE lookup.
===========================================================
# =============================================================================
# CONTEXT: The three production_plan_engine engines (Calc A/B, Calc SO, Calc
#   Action) decide which Sales/Work/Purchase Orders count as "pending". This
#   module returns ONLY the per-trigger override text from a TOC Trigger
#   Configuration row. The engine helpers fall back to the existing global
#   TOC Settings read when the override is blank, so a blank row behaves exactly
#   as before (TS-001 global contract + the WKP/POR reports stay unaffected).
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - row_override returns the RAW text block (pair format 'Status|WorkflowState'
#     supported, one entry per line); existing _parse_* helpers consume it.
#   - voucher in {"so","wo","po"}; trigger_key is a registry key.
#   - The active trigger is read from frappe.flags.toc_trigger_key when not
#     passed explicitly (deep WO/PO helpers cannot thread a param down).
# DANGER ZONE:
#   - NEVER raise on a missing/unknown row — return "" so the caller inherits the
#     global. A half-configured site must never crash an engine.
#   - Do NOT add a global/default branch HERE. That lives in the engine helpers
#     so the global path stays byte-for-byte identical to the legacy code
#     (two fields for WO/PO: pending_*_statuses + pending_*_workflow_states).
# =============================================================================
"""

import frappe

# Per-row override field on TOC Trigger Configuration, by voucher type.
# `mr` (2026-06-04) = pending Purchase Material Request statuses (status-only;
# MR has no workflow_state here, so the cell holds plain status lines).
_ROW_FIELD = {
    "so": "pending_so_statuses",
    "wo": "pending_wo_statuses",
    "po": "pending_po_statuses",
    "mr": "pending_mr_statuses",
}


def active_trigger_key():
    """The trigger currently running, from frappe.flags (set by engine entry)."""
    return getattr(frappe.flags, "toc_trigger_key", None)


def row_override(voucher, trigger_key=None):
    """Return the per-trigger override text for a voucher, or '' if none/blank.

    trigger_key defaults to frappe.flags.toc_trigger_key. Returns '' when there
    is no active trigger, no matching row, or the row's cell is blank — the
    caller then inherits the global TOC Settings value.
    """
    assert voucher in _ROW_FIELD, f"bad voucher {voucher!r}"
    if trigger_key is None:
        trigger_key = active_trigger_key()
    if not trigger_key:
        return ""
    settings = frappe.get_cached_doc("TOC Settings")
    for row in (settings.get("trigger_configurations") or []):
        if row.trigger_key == trigger_key:
            return (row.get(_ROW_FIELD[voucher]) or "").strip()
    return ""
