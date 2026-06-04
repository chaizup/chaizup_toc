"""
TOC Trigger Registry — single source of truth for every automation engine.
============================================================================
# =============================================================================
# CONTEXT: One canonical list of all TOC automation engines. This registry is
#   used by THREE consumers and must stay the only place that maps an engine to
#   its job method path:
#     1. seed patch  -> creates one TOC Trigger Configuration row per engine
#     2. trigger_scheduler -> finds the native Scheduled Job Type by `job_method`
#     3. api.trigger_runner -> dispatches a manual "Run Now" by `job_method`
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - `key` is an IMMUTABLE identity stored on each child row; never rename a key
#     once shipped (it links row <-> registry <-> Scheduled Job Type).
#   - `considers` reflects REALITY: only the three production_plan_engine engines
#     read configurable pending SO/WO/PO statuses. buffer_mr_run /
#     procurement_monitor use Bin.ordered_qty + a hardcoded WIP clause and do
#     NOT consult the configurable lists, so all three flags are 0 for them.
#   - `job_method` must be a no-arg callable (the daily wrappers all are).
# DANGER ZONE:
#   - Do NOT point two keys at the same job_method (the scheduler keys jobs by
#     method; collisions would fight over one Scheduled Job Type).
# =============================================================================
"""

# Each entry:
#   key            immutable identity (stored on the child row)
#   name           friendly label shown in the UI
#   job_method     dotted path to a no-arg callable
#   default_frequency  "Daily" | "Weekly"
#   default_time   "HH:MM" (24h)
#   default_weekday  "" for Daily, else "Sunday".."Saturday"
#   considers      {"so":0/1, "wo":0/1, "po":0/1} — which pending lists apply
#   schedulable    1 if it can run on a cron
#   seed_enabled   1 if the seeded row starts enabled (0 = opt-in, e.g. Calc Action)

TOC_TRIGGERS = [
    {
        "key": "min_order_sync",
        "name": "Min Order Qty Sync",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_min_order_sync",
        "default_frequency": "Daily", "default_time": "00:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "adu_max_level",
        "name": "ADU + Max Level Refresh",
        "job_method": "chaizup_toc.tasks.daily_tasks.update_min_mfg_adu_levels",
        "default_frequency": "Daily", "default_time": "01:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "sales_projection",
        "name": "Sales Projection (Calc A + Calc B)",
        "job_method": "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.daily_production_plan_automation",
        "default_frequency": "Daily", "default_time": "02:00", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "buffer_mr_run",
        "name": "Buffer Material Request Run",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_production_run",
        "default_frequency": "Daily", "default_time": "07:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "so_shortage",
        "name": "Sales Order Shortage (Calc SO)",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_so_shortage_automation",
        "default_frequency": "Daily", "default_time": "07:00", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 1},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "procurement_monitor",
        "name": "Procurement Monitoring",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_procurement_run",
        "default_frequency": "Daily", "default_time": "07:30", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "buffer_snapshot",
        "name": "Buffer Snapshot",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot",
        "default_frequency": "Daily", "default_time": "08:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "weekly_dbm",
        "name": "Weekly Dynamic Buffer Management",
        "job_method": "chaizup_toc.tasks.daily_tasks.weekly_dbm_check",
        "default_frequency": "Weekly", "default_time": "09:00", "default_weekday": "Sunday",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
    },
    {
        "key": "shortage_action",
        "name": "Shortage Action (Calc Action)",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_shortage_action_automation",
        "default_frequency": "Daily", "default_time": "07:15", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 1},
        "schedulable": 1, "seed_enabled": 0,  # opt-in: seeded disabled
    },
]

_BY_KEY = {t["key"]: t for t in TOC_TRIGGERS}


def all_triggers():
    """Return the full list of trigger definitions (list of dicts)."""
    return list(TOC_TRIGGERS)


def get_trigger(key):
    """Return one trigger definition by key. Raises KeyError if unknown."""
    return _BY_KEY[key]


def job_method_for(key):
    """Return the dotted job-method path for a trigger key."""
    return _BY_KEY[key]["job_method"]
