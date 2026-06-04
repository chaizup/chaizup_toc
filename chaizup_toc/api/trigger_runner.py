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
    """Fire one automation engine on demand (enqueued to the long queue).

    Returns a small handle the UI toasts. The engine itself writes its own
    TOC Production Plan Run Log where applicable.
    """
    frappe.only_for(["Manufacturing Manager", "TOC Manager", "System Manager"])
    try:
        trig = trigger_registry.get_trigger(trigger_key)
    except KeyError:
        frappe.throw(f"Unknown trigger: {trigger_key}")

    frappe.enqueue(
        "chaizup_toc.api.trigger_runner._execute_trigger",
        queue="long",
        timeout=1500,
        trigger_key=trigger_key,
        enqueued_by=frappe.session.user,
    )
    return {"ok": True, "queued": True, "trigger_key": trigger_key, "name": trig["name"]}


def _execute_trigger(trigger_key, enqueued_by=None):
    """Worker side: run the engine's no-arg job method as Administrator."""
    trig = trigger_registry.get_trigger(trigger_key)
    frappe.set_user("Administrator")
    fn = frappe.get_attr(trig["job_method"])
    try:
        fn()
        frappe.db.commit()
        frappe.logger("chaizup_toc").info(
            "run_trigger_now: %s done (by %s)" % (trigger_key, enqueued_by)
        )
    except Exception:
        frappe.db.rollback()
        frappe.log_error(frappe.get_traceback(), f"run_trigger_now {trigger_key} FAILED")
        raise
