"""
TOC Trigger Runner — manual "Run Now" dispatcher + engine overview.
====================================================================
# =============================================================================
# CONTEXT: Backs the per-engine "Run Now" buttons + the engine overview panel on
#   the TOC Settings page. ONE whitelisted dispatcher fires any engine by its
#   registry key, so a button and its cron invoke the EXACT same method path
#   (no drift). get_trigger_overview feeds the read-only summary list (every
#   engine + resolved schedule + enabled + per-engine help tooltip).
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - The dotted method path comes ONLY from trigger_registry (single source) —
#     never hardcode an engine path here.
#   - run_trigger_now enqueues to the long queue and returns immediately; the
#     worker runs the engine as Administrator (engines self-guard via only_for).
# DANGER ZONE:
#   - Keep frappe.only_for on run_trigger_now — it is whitelisted (any logged-in
#     user could POST to it otherwise).
#   - Unknown trigger_key MUST raise (never silently no-op) so a typo surfaces.
# =============================================================================
"""

import frappe

from chaizup_toc.chaizup_toc.toc_engine import trigger_registry


@frappe.whitelist()
def get_trigger_overview():
    """Return every engine + its resolved schedule, enabled flag, considers map
    and help text — for the TOC Settings 'Automation Engines & Triggers' panel.

    Reads the live TOC Trigger Configuration rows; falls back to the registry
    defaults for any engine that does not yet have a row (pre-seed safety).
    """
    settings = frappe.get_cached_doc("TOC Settings")
    rows = {r.trigger_key: r for r in (settings.get("trigger_configurations") or [])}
    out = []
    for trig in trigger_registry.all_triggers():
        r = rows.get(trig["key"])
        out.append({
            "key": trig["key"],
            "name": trig["name"],
            "enabled": int(r.enabled) if r else trig["seed_enabled"],
            "frequency": (r.frequency if r else trig["default_frequency"]),
            "schedule_time": (r.schedule_time if r else trig["default_time"]),
            "weekday": (r.weekday if r else trig["default_weekday"]),
            "considers": trig["considers"],
            "help": trigger_registry.help_for(trig["key"]),
        })
    return out


@frappe.whitelist()
def run_trigger_now(trigger_key):
    """Fire one automation engine on demand, SYNCHRONOUSLY, returning its result.

    Runs in the request (the UI freezes with an overlay) so the caller gets the
    engine's structured result back — Run Log link + created/skipped/errors —
    in a result dialog, matching the old per-engine Run buttons.

    Routing (single source = the registry):
      - Voucher engines (sales_projection / so_shortage / shortage_action) carry a
        `run_method` (the rich @whitelist engine) + `run_triggered_by`. We call
        THAT so the result dict (ok, run_log, counts) flows back to the dialog.
      - Other engines have no run_method → we call their no-arg `job_method`
        (monitoring/buffer runs that return None → the dialog shows a generic
        "completed" with a pointer to the Error Log).

    SECURITY (2026-06-04): System Manager only. The rich engines also self-guard
    with frappe.only_for([...]); a System Manager passes, and the run is recorded
    against the REAL user (better audit than a queued Administrator run).
    """
    frappe.only_for("System Manager")
    try:
        trig = trigger_registry.get_trigger(trigger_key)
    except KeyError:
        frappe.throw(f"Unknown trigger: {trigger_key}")

    run_method = trig.get("run_method") or trig["job_method"]
    fn = frappe.get_attr(run_method)
    kwargs = {}
    if trig.get("run_method") and trig.get("run_triggered_by"):
        kwargs["triggered_by"] = trig["run_triggered_by"]

    result = fn(**kwargs)

    # Normalise to a plain dict the UI can read. Rich engines return a dict with
    # run_log + counts; monitoring engines return None.
    rich = result if isinstance(result, dict) else {}
    return {
        "ok": True,
        "trigger_key": trigger_key,
        "name": trig["name"],
        "has_result": bool(rich),
        "run_log": rich.get("run_log"),
        "created": rich.get("created"),
        "skipped": rich.get("skipped"),
        "errors": rich.get("errors"),
        "evaluated": rich.get("evaluated"),
        "pairs": rich.get("pairs"),
        "message": rich.get("message"),
    }
