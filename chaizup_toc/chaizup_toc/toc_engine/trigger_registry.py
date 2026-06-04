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
        "help": (
            "WHAT: Syncs each item's Minimum Order Qty (purchase, from the ERPNext "
            "item field) and Minimum Manufacture (from Work Order history) into the "
            "per-warehouse tables.\nEFFECT: Keeps the order/production floors current.\n"
            "WHY: So replenishment never raises an order below the supplier/batch "
            "minimum.\nPending statuses: not used (creates no demand/supply scan)."
        ),
    },
    {
        "key": "adu_max_level",
        "name": "ADU + Max Level Refresh",
        "job_method": "chaizup_toc.tasks.daily_tasks.update_min_mfg_adu_levels",
        "default_frequency": "Daily", "default_time": "01:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Recomputes Average Daily Usage (ADU) and Maximum Level per "
            "item x warehouse from ALL outward stock movement (item-group "
            "independent).\nEFFECT: Buffers and Days-of-Cover resize to real "
            "consumption.\nWHY: A buffer is only as good as its demand rate; stale "
            "ADU under/over-stocks.\nPending statuses: not used."
        ),
    },
    {
        "key": "sales_projection",
        "name": "Sales Projection (Calc A + Calc B)",
        "job_method": "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.daily_production_plan_automation",
        # run_method = the rich whitelisted entry used by the manual "Run Now"
        # button (returns {ok, run_log, summary, ...} for the result dialog). The
        # job_method above is the no-arg CRON wrapper (returns None).
        "run_method": "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_projection_automation_for_all_warehouses",
        "run_triggered_by": "manual_button",
        "default_frequency": "Daily", "default_time": "02:00", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Calc A (forecast) + Calc B (Sales-Order safety net) turn the "
            "current month's submitted Sales Projection into Production Plans "
            "(manufacture) or one consolidated Material Request (purchase) for "
            "shortfalls.\nEFFECT: Creates PP + Work Orders / MR.\nWHY: Produces ahead "
            "of forecast demand so finished goods are ready on time.\nPending SO/WO "
            "statuses below define which Sales Orders count as demand and which Work "
            "Orders count as in-progress supply."
        ),
    },
    {
        "key": "buffer_mr_run",
        "name": "Buffer Material Request Run",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_production_run",
        "default_frequency": "Daily", "default_time": "07:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Calculates every item's Buffer Penetration % and raises Draft "
            "Material Requests / Production Plans for Yellow and Red zone items.\n"
            "EFFECT: Creates MR/PP (left as Draft for a planner to submit).\nWHY: The "
            "core demand-driven replenishment run that keeps stock inside its buffer.\n"
            "Pending statuses: NOT used — this engine reads live Bin quantities "
            "(on-hand, ordered, reserved), so its pending columns are not applicable."
        ),
    },
    {
        "key": "so_shortage",
        "name": "Sales Order Shortage (Calc SO)",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_so_shortage_automation",
        "run_method": "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_so_shortage_automation",
        "run_triggered_by": "so_shortage_manual",
        "default_frequency": "Daily", "default_time": "07:00", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 1},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Calc SO scans every pending Sales Order and covers real shortages "
            "with a Production Plan (manufacture) or Purchase Material Request.\n"
            "EFFECT: Creates PP + Work Orders / MR, floored by the per-warehouse "
            "Minimum Qty.\nWHY: Guarantees confirmed customer orders are backed by "
            "supply even when forecast missed them.\nPending SO/WO/PO statuses below "
            "define what counts as pending demand (SO) and existing supply (WO, PO)."
        ),
    },
    {
        "key": "procurement_monitor",
        "name": "Procurement Monitoring",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_procurement_run",
        "default_frequency": "Daily", "default_time": "07:30", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Logs purchase-mode items sitting in the Red/Black zone for the "
            "buying team and writes a one-line audit summary.\nEFFECT: No documents "
            "created — monitoring only.\nWHY: Gives procurement an early heads-up "
            "without auto-raising purchase requests.\nPending statuses: not used "
            "(reads live buffer state)."
        ),
    },
    {
        "key": "buffer_snapshot",
        "name": "Buffer Snapshot",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot",
        "default_frequency": "Daily", "default_time": "08:00", "default_weekday": "",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Archives every item x warehouse buffer state into TOC Buffer Log.\n"
            "EFFECT: Writes one history row per item x warehouse per run.\nWHY: Feeds "
            "the weekly Dynamic Buffer Management evaluation and trend analysis.\n"
            "Pending statuses: not used."
        ),
    },
    {
        "key": "weekly_dbm",
        "name": "Weekly Dynamic Buffer Management",
        "job_method": "chaizup_toc.tasks.daily_tasks.weekly_dbm_check",
        "default_frequency": "Weekly", "default_time": "09:00", "default_weekday": "Sunday",
        "considers": {"so": 0, "wo": 0, "po": 0},
        "schedulable": 1, "seed_enabled": 1,
        "help": (
            "WHAT: Dynamic Buffer Management resizes target buffers UP (Too Much Red) "
            "or DOWN (Too Much Green) based on the last week's zone behaviour.\n"
            "EFFECT: Updates TOC Item Buffer target buffers + counters.\nWHY: Buffers "
            "self-tune to changing demand without manual review.\nRuns weekly (default "
            "Sunday). Pending statuses: not used."
        ),
    },
    {
        "key": "shortage_action",
        "name": "Shortage Action (Calc Action)",
        "job_method": "chaizup_toc.tasks.daily_tasks.daily_shortage_action_automation",
        "run_method": "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_shortage_action_automation",
        "run_triggered_by": "shortage_action_manual",
        "default_frequency": "Daily", "default_time": "07:15", "default_weekday": "",
        "considers": {"so": 1, "wo": 1, "po": 1},
        "schedulable": 1, "seed_enabled": 0,  # opt-in: seeded disabled
        "help": (
            "WHAT: Calc Action — for opted-in Item Minimum Manufacture rows, tops up "
            "an item when it falls short (Mode 1) or drops below a max-level threshold "
            "(Mode 2).\nEFFECT: Creates PP + Work Orders (manufacture) or MR "
            "(purchase).\nWHY: Preventive, per-warehouse safety automation driven by "
            "each row's opt-in checkboxes.\nSEEDED DISABLED — tick Enabled on this row "
            "to schedule it. Pending SO/WO/PO statuses below define demand vs supply."
        ),
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


def help_for(key):
    """Return the human 'what / effect / why' help text for a trigger key.

    Surfaced as a per-trigger tooltip in the TOC Settings engine overview and
    seeded into the read-only `engine_help` field on each child row.
    """
    return _BY_KEY[key].get("help", "")
