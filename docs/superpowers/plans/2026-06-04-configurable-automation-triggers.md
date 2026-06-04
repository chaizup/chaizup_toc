# Configurable Automation Triggers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the TOC Settings page, let the user see every automation engine, edit each engine's schedule at runtime, configure per-trigger pending PO/SO/WO statuses (overriding the global defaults), and fire any engine manually with a Run Now button.

**Architecture:** A single Python **registry** lists every engine (key, friendly name, job method path, default schedule, which vouchers it filters). A new **child DocType** `TOC Trigger Configuration` on TOC Settings holds one editable row per engine. On save (and on `after_migrate`) a **scheduler-sync** module writes each row's cron into Frappe's native `Scheduled Job Type`. A **pending-status resolver** picks the per-trigger override (else the global field, else a hardcoded default), threaded into the three `production_plan_engine` engines via a `frappe.flags` context key. A whitelisted **run dispatcher** fires any engine by key for the Run Now buttons.

**Tech Stack:** Frappe/ERPNext v16, Python 3, MariaDB, Frappe Desk JS (`frappe.ui.form`), `bench --site development.localhost run-tests`.

---

## ⚠️ Codebase Quirks (read before starting)

1. **Two `toc_engine` package roots** — import paths differ:
   - `chaizup_toc.toc_engine.*` → `apps/chaizup_toc/chaizup_toc/toc_engine/` (buffer_calculator, mr_generator, min_order_sync, dbm_engine, component_mr_generator, auto_remarks)
   - `chaizup_toc.chaizup_toc.toc_engine.*` → `apps/chaizup_toc/chaizup_toc/chaizup_toc/toc_engine/` (production_plan_engine, projection_engine)
   - **New engine modules in this plan go in the double-nest** `chaizup_toc/chaizup_toc/toc_engine/` next to `production_plan_engine.py` (their main consumer). Import them as `chaizup_toc.chaizup_toc.toc_engine.<mod>`.
2. **DocTypes** live at `chaizup_toc/chaizup_toc/doctype/...`; controller import root `chaizup_toc.chaizup_toc.doctype.*`.
3. **tasks** at `chaizup_toc/tasks/` → `chaizup_toc.tasks.daily_tasks`. **api** at `chaizup_toc/api/` → `chaizup_toc.api.*`.
4. **Only 3 engines read configurable pending statuses** (Calc A/B, Calc SO, Calc Action — all in `production_plan_engine.py`). `buffer_mr_run` and `procurement_monitor` use `Bin.ordered_qty` + a hardcoded WIP clause and do **not** consult the configurable lists — their pending cells are **N/A**. This corrects the spec's §2 table (which optimistically marked buffer/procurement as voucher-considering).
5. **All file paths below are relative to** `apps/chaizup_toc/`. The repo root for git is `apps/chaizup_toc/`.
6. **No single quotes (`'`) in any `.html` Desk page template** (project rule — they break Frappe's template wrapping). Not relevant here (we only touch `.js`/`.json`/`.py`), but keep in mind if you add HTML.
7. **Run tests with:** `cd /workspace/development/frappe-bench && bench --site development.localhost run-tests --module <dotted.module>` (heavy; needs DB). Pure helpers (`compute_cron`, registry lookups) are written dependency-light so they also run via `python3` with a tiny stub — each task says which.

---

## File Structure

**New files**
| Path | Responsibility |
|---|---|
| `chaizup_toc/chaizup_toc/toc_engine/trigger_registry.py` | Canonical list of all engines + lookup helpers. Pure data, no frappe import. |
| `chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py` | Unit tests for the registry + `compute_cron`. |
| `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py` | `compute_cron`, `sync_one`, `sync_all` → writes native `Scheduled Job Type`. |
| `chaizup_toc/chaizup_toc/toc_engine/pending_status.py` | `row_override(voucher, trigger_key=None)` → per-trigger override text or `""` (engine helpers do `override or <global>`). |
| `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.json` | Child DocType schema. |
| `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.py` | Empty controller. |
| `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/__init__.py` | Package marker. |
| `chaizup_toc/api/trigger_runner.py` | `run_trigger_now(trigger_key)`, `get_trigger_overview()`. |
| `chaizup_toc/patches/v1_0/seed_trigger_configurations.py` | Idempotent seeding + initial schedule sync. |

**Modified files**
| Path | Change |
|---|---|
| `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.json` | Add section + `trigger_configurations` Table field. |
| `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.py` | `validate` → `trigger_scheduler.sync_all(self)`. |
| `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.js` | Engine overview + per-engine Run buttons + HH:MM validation + pending-cell greying. |
| `chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py` | Set `frappe.flags.toc_trigger_key` at the 3 entry points; front the SO/WO/PO status reads with `pending_status.row_override` (else legacy global read). |
| `chaizup_toc/tasks/daily_tasks.py` | Add `daily_shortage_action_automation` wrapper. |
| `chaizup_toc/hooks.py` | `after_migrate` sync; `shortage_action` cron seeded disabled. |
| `chaizup_toc/patches.txt` | Register the seed patch. |
| `documentation/build_docs.py` | Document the feature; regenerate docx. |

---

## Task 1: Trigger registry (pure data + lookups)

**Files:**
- Create: `chaizup_toc/chaizup_toc/toc_engine/trigger_registry.py`
- Test: `chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py`

- [ ] **Step 1: Write the failing test**

Create `chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py`:

```python
import unittest

from chaizup_toc.chaizup_toc.toc_engine import trigger_registry as reg


class TestTriggerRegistry(unittest.TestCase):
    def test_all_triggers_has_nine_engines(self):
        keys = [t["key"] for t in reg.all_triggers()]
        self.assertEqual(
            sorted(keys),
            sorted([
                "min_order_sync", "adu_max_level", "sales_projection",
                "buffer_mr_run", "so_shortage", "procurement_monitor",
                "buffer_snapshot", "weekly_dbm", "shortage_action",
            ]),
        )

    def test_keys_are_unique(self):
        keys = [t["key"] for t in reg.all_triggers()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_get_trigger_returns_dict(self):
        t = reg.get_trigger("so_shortage")
        self.assertEqual(t["name"], "Sales Order Shortage (Calc SO)")
        self.assertTrue(t["considers"]["po"])

    def test_get_trigger_unknown_raises(self):
        with self.assertRaises(KeyError):
            reg.get_trigger("does_not_exist")

    def test_job_method_for_returns_dotted_path(self):
        self.assertEqual(
            reg.job_method_for("buffer_snapshot"),
            "chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot",
        )

    def test_only_three_engines_consider_vouchers(self):
        considering = [t["key"] for t in reg.all_triggers()
                       if any(t["considers"].values())]
        self.assertEqual(
            sorted(considering),
            sorted(["sales_projection", "so_shortage", "shortage_action"]),
        )

    def test_shortage_action_seed_disabled(self):
        self.assertEqual(reg.get_trigger("shortage_action")["seed_enabled"], 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/development/frappe-bench/apps/chaizup_toc && python3 -m pytest chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'chaizup_toc...trigger_registry'` (or import error). If `chaizup_toc` is not importable from that cwd, run instead: `cd /workspace/development/frappe-bench/apps/chaizup_toc && python3 -m unittest chaizup_toc.chaizup_toc.toc_engine.trigger_registry_test -v` → Expected FAIL.

- [ ] **Step 3: Write minimal implementation**

Create `chaizup_toc/chaizup_toc/toc_engine/trigger_registry.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/development/frappe-bench/apps/chaizup_toc && python3 -m unittest chaizup_toc.chaizup_toc.toc_engine.trigger_registry_test -v`
Expected: PASS (7 tests). If import path fails under plain python, run via bench: `cd /workspace/development/frappe-bench && bench --site development.localhost run-tests --module chaizup_toc.chaizup_toc.toc_engine.trigger_registry_test` → Expected PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/toc_engine/trigger_registry.py chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py
git commit -m "feat(toc): trigger registry — canonical engine list + lookups"
```

---

## Task 2: compute_cron (pure, dependency-light)

**Files:**
- Create: `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py` (compute_cron only for now)
- Test: add to `chaizup_toc/chaizup_toc/toc_engine/trigger_registry_test.py` (reuse file) — OR a new `trigger_scheduler_test.py`. Use a new test file.

- [ ] **Step 1: Write the failing test**

Create `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler_test.py`:

```python
import unittest

from chaizup_toc.chaizup_toc.toc_engine.trigger_scheduler import (
    compute_cron, CronValidationError,
)


class _Row:
    def __init__(self, **kw):
        self.frequency = kw.get("frequency", "Daily")
        self.schedule_time = kw.get("schedule_time", "02:00")
        self.weekday = kw.get("weekday", "")
        self.cron_override = kw.get("cron_override", "")


class TestComputeCron(unittest.TestCase):
    def test_daily(self):
        self.assertEqual(compute_cron(_Row(schedule_time="02:00")), "0 2 * * *")

    def test_daily_with_minutes(self):
        self.assertEqual(compute_cron(_Row(schedule_time="07:30")), "30 7 * * *")

    def test_weekly_sunday(self):
        r = _Row(frequency="Weekly", schedule_time="09:00", weekday="Sunday")
        self.assertEqual(compute_cron(r), "0 9 * * 0")

    def test_weekly_wednesday(self):
        r = _Row(frequency="Weekly", schedule_time="06:15", weekday="Wednesday")
        self.assertEqual(compute_cron(r), "15 6 * * 3")

    def test_cron_override_wins(self):
        r = _Row(schedule_time="02:00", cron_override="*/15 * * * *")
        self.assertEqual(compute_cron(r), "*/15 * * * *")

    def test_bad_time_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(schedule_time="25:00"))

    def test_bad_time_format_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(schedule_time="7am"))

    def test_bad_override_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(cron_override="not a cron"))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace/development/frappe-bench/apps/chaizup_toc && python3 -m unittest chaizup_toc.chaizup_toc.toc_engine.trigger_scheduler_test -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError: cannot import name 'compute_cron'`.

- [ ] **Step 3: Write minimal implementation**

Create `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py`:

```python
"""
TOC Trigger Scheduler — sync child rows into native Scheduled Job Type.
========================================================================
# =============================================================================
# CONTEXT: Turns each TOC Trigger Configuration row into a cron string and
#   writes it onto Frappe's built-in `Scheduled Job Type` (matched by `method`),
#   so editing a trigger's time on TOC Settings changes when the job fires —
#   no bench restart / migrate needed.
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - compute_cron is PURE + dependency-light (no frappe import) so it is unit
#     testable and raises CronValidationError on bad input.
#   - sync_one / sync_all import frappe lazily and convert CronValidationError
#     into frappe.throw so a bad time aborts the TOC Settings save cleanly.
# DANGER ZONE:
#   - Frappe's migrate runs `sync_jobs` which can RESET cron_format from hooks.
#     The after_migrate hook re-runs sync_all so the table stays authoritative.
# =============================================================================
"""

import re

_WEEKDAY_TO_CRON = {
    "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3,
    "Thursday": 4, "Friday": 5, "Saturday": 6,
}

_CRON_FIELD = re.compile(r"^[\d\*/,\-]+$")


class CronValidationError(ValueError):
    """Raised when a row cannot be turned into a valid 5-field cron."""


def _validate_cron(expr):
    parts = expr.split()
    if len(parts) != 5:
        raise CronValidationError(f"Cron must have 5 fields: {expr!r}")
    for p in parts:
        if not _CRON_FIELD.match(p):
            raise CronValidationError(f"Invalid cron field {p!r} in {expr!r}")
    return expr


def _parse_hhmm(value):
    if not value or not re.match(r"^\d{1,2}:\d{2}$", value.strip()):
        raise CronValidationError(f"Time must be HH:MM (24h), got {value!r}")
    hh, mm = value.strip().split(":")
    hh, mm = int(hh), int(mm)
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise CronValidationError(f"Time out of range: {value!r}")
    return hh, mm


def compute_cron(row):
    """Return a 5-field cron string for a TOC Trigger Configuration row.

    cron_override (when set) wins. Otherwise Daily -> 'M H * * *',
    Weekly -> 'M H * * <weekday>'. Raises CronValidationError on bad input.
    """
    override = (getattr(row, "cron_override", "") or "").strip()
    if override:
        return _validate_cron(override)

    hh, mm = _parse_hhmm(getattr(row, "schedule_time", "") or "")
    frequency = (getattr(row, "frequency", "Daily") or "Daily").strip()

    if frequency == "Weekly":
        wd = (getattr(row, "weekday", "") or "").strip()
        if wd not in _WEEKDAY_TO_CRON:
            raise CronValidationError(f"Weekly trigger needs a weekday, got {wd!r}")
        return f"{mm} {hh} * * {_WEEKDAY_TO_CRON[wd]}"

    return f"{mm} {hh} * * *"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace/development/frappe-bench/apps/chaizup_toc && python3 -m unittest chaizup_toc.chaizup_toc.toc_engine.trigger_scheduler_test -v`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler_test.py
git commit -m "feat(toc): compute_cron — row -> validated cron string"
```

---

## Task 3: TOC Trigger Configuration child DocType

**Files:**
- Create: `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.json`
- Create: `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.py`
- Create: `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/__init__.py`

- [ ] **Step 1: Create the package marker**

Create empty file `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/__init__.py` (0 bytes).

- [ ] **Step 2: Create the controller**

Create `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.py`:

```python
# Copyright (c) 2026, Chaizup and Contributors
# See license.txt

from frappe.model.document import Document


class TOCTriggerConfiguration(Document):
    """Child row on TOC Settings: one automation engine's schedule + pending
    status overrides. Behaviour lives in trigger_scheduler / pending_status;
    this controller is intentionally empty (child rows validate via parent)."""
    pass
```

- [ ] **Step 3: Create the DocType JSON**

Create `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.json`:

```json
{
 "actions": [],
 "allow_rename": 0,
 "creation": "2026-06-04 00:00:00.000000",
 "doctype": "DocType",
 "editable_grid": 1,
 "engine": "InnoDB",
 "field_order": [
  "trigger_name",
  "trigger_key",
  "enabled",
  "col_break_sched",
  "frequency",
  "schedule_time",
  "weekday",
  "cron_override",
  "sec_pending",
  "pending_so_statuses",
  "pending_wo_statuses",
  "pending_po_statuses",
  "sec_considers",
  "considers_so",
  "considers_wo",
  "considers_po"
 ],
 "fields": [
  {"fieldname": "trigger_name", "fieldtype": "Data", "label": "Trigger", "in_list_view": 1, "columns": 3, "read_only": 1},
  {"fieldname": "trigger_key", "fieldtype": "Data", "label": "Key", "read_only": 1, "reqd": 1},
  {"fieldname": "enabled", "fieldtype": "Check", "label": "Enabled", "in_list_view": 1, "columns": 1, "default": "1"},
  {"fieldname": "col_break_sched", "fieldtype": "Column Break"},
  {"fieldname": "frequency", "fieldtype": "Select", "label": "Frequency", "options": "Daily\nWeekly\nCron", "default": "Daily", "in_list_view": 1, "columns": 1},
  {"fieldname": "schedule_time", "fieldtype": "Data", "label": "Time (HH:MM)", "in_list_view": 1, "columns": 1, "description": "24-hour HH:MM, e.g. 07:30"},
  {"fieldname": "weekday", "fieldtype": "Select", "label": "Weekday", "options": "\nSunday\nMonday\nTuesday\nWednesday\nThursday\nFriday\nSaturday", "description": "Used only when Frequency = Weekly"},
  {"fieldname": "cron_override", "fieldtype": "Data", "label": "Cron Override", "description": "Advanced: raw 5-field cron. Wins over Frequency/Time when set."},
  {"fieldname": "sec_pending", "fieldtype": "Section Break", "label": "Pending Voucher Statuses (override; blank = use global default)"},
  {"fieldname": "pending_so_statuses", "fieldtype": "Small Text", "label": "Pending SO Statuses", "in_list_view": 1, "columns": 2, "description": "One per line. 'Status' = submitted; 'Status|WorkflowState' = also match draft."},
  {"fieldname": "pending_wo_statuses", "fieldtype": "Small Text", "label": "Pending WO Statuses", "in_list_view": 1, "columns": 2, "description": "One per line. 'Status' or 'Status|WorkflowState'."},
  {"fieldname": "pending_po_statuses", "fieldtype": "Small Text", "label": "Pending PO Statuses", "in_list_view": 1, "columns": 2, "description": "One per line. 'Status' or 'Status|WorkflowState'."},
  {"fieldname": "sec_considers", "fieldtype": "Section Break", "label": "Applies To (read-only)"},
  {"fieldname": "considers_so", "fieldtype": "Check", "label": "Considers SO", "read_only": 1},
  {"fieldname": "considers_wo", "fieldtype": "Check", "label": "Considers WO", "read_only": 1},
  {"fieldname": "considers_po", "fieldtype": "Check", "label": "Considers PO", "read_only": 1}
 ],
 "index_web_pages_for_search": 1,
 "istable": 1,
 "links": [],
 "modified": "2026-06-04 00:00:00.000000",
 "modified_by": "Administrator",
 "module": "Chaizup Toc",
 "name": "TOC Trigger Configuration",
 "owner": "Administrator",
 "permissions": [],
 "sort_field": "modified",
 "sort_order": "DESC",
 "states": []
}
```

> Verify `"module"` matches the app's module name. Check `cat chaizup_toc/modules.txt` — it should read `Chaizup Toc`. If it differs, use that exact value.

- [ ] **Step 4: Verify the JSON is valid + module name matches**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -c "import json; json.load(open('chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/toc_trigger_configuration.json')); print('json ok')"
cat chaizup_toc/modules.txt
```
Expected: `json ok` and the module name printed. Fix `"module"` in the JSON if it differs.

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/
git commit -m "feat(toc): TOC Trigger Configuration child doctype"
```

---

## Task 4: Add the table field to TOC Settings + wire schedule sync on save

**Files:**
- Modify: `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.json` (add section + Table field)
- Modify: `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.py` (validate → sync)
- Add `sync_one` / `sync_all` to `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py`

- [ ] **Step 1: Add `sync_one` / `sync_all` to trigger_scheduler.py**

Append to `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py`:

```python
def _scheduled_job_name(method):
    """Return the Scheduled Job Type docname for a method, or None."""
    import frappe
    rows = frappe.get_all(
        "Scheduled Job Type", filters={"method": method}, pluck="name", limit=1
    )
    return rows[0] if rows else None


def sync_one(row):
    """Write one trigger row's schedule onto its native Scheduled Job Type.

    Creates the Scheduled Job Type if it does not yet exist (e.g. a newly
    schedulable engine). Converts CronValidationError into frappe.throw so a
    bad time aborts the parent save.
    """
    import frappe
    from chaizup_toc.chaizup_toc.toc_engine import trigger_registry

    try:
        trig = trigger_registry.get_trigger(row.trigger_key)
    except KeyError:
        return  # unknown key (stale row) — skip silently
    if not trig.get("schedulable"):
        return

    method = trig["job_method"]
    try:
        cron = compute_cron(row)
    except CronValidationError as e:
        frappe.throw(f"{trig['name']}: {e}")

    name = _scheduled_job_name(method)
    if name:
        sjt = frappe.get_doc("Scheduled Job Type", name)
    else:
        sjt = frappe.new_doc("Scheduled Job Type")
        sjt.method = method

    sjt.frequency = "Cron"
    sjt.cron_format = cron
    sjt.stopped = 0 if int(row.enabled or 0) else 1
    sjt.flags.ignore_permissions = True
    sjt.save(ignore_permissions=True)


def sync_all(settings_doc):
    """Sync every schedulable trigger row on a TOC Settings doc."""
    for row in (settings_doc.get("trigger_configurations") or []):
        sync_one(row)
```

- [ ] **Step 2: Add the Table field to TOC Settings JSON**

In `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.json`:

1. Add these two fieldnames to `field_order`, immediately **after** `"pending_po_statuses"` (locate that string in `field_order` and insert after it):

```json
  "automation_triggers_section",
  "trigger_configurations",
```

2. Add these two field definitions to the `fields` array (anywhere in the array; order is controlled by `field_order`):

```json
  {"fieldname": "automation_triggers_section", "fieldtype": "Section Break", "label": "Automation Engines & Triggers"},
  {"fieldname": "trigger_configurations", "fieldtype": "Table", "label": "Trigger Configurations", "options": "TOC Trigger Configuration"}
```

- [ ] **Step 3: Verify JSON valid + field present**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -c "
import json
d=json.load(open('chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.json'))
fo=d['field_order']; assert 'trigger_configurations' in fo, 'missing in field_order'
names={f['fieldname'] for f in d['fields']}
assert 'trigger_configurations' in names and 'automation_triggers_section' in names
print('toc_settings json ok')
"
```
Expected: `toc_settings json ok`.

- [ ] **Step 4: Wire validate → sync_all in the controller**

In `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.py`, change the `validate` method to call the sync at the end:

```python
    def validate(self):
        self._validate_zone_thresholds()
        self._validate_dbm_params()
        self._validate_warehouse_rules()
        self._sync_trigger_schedules()

    def _sync_trigger_schedules(self):
        """Push every trigger row's schedule onto its native Scheduled Job Type.

        Runs on every save so editing a trigger time takes effect immediately.
        Bad time/cron raises frappe.throw inside sync_one and aborts the save.
        """
        from chaizup_toc.chaizup_toc.toc_engine import trigger_scheduler
        trigger_scheduler.sync_all(self)
```

- [ ] **Step 5: Apply schema to the site + smoke test the sync**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost migrate
bench --site development.localhost console <<'PY'
import frappe
s = frappe.get_doc("TOC Settings")
# add a temporary row to prove the sync writes a Scheduled Job Type
s.append("trigger_configurations", {
    "trigger_key": "buffer_snapshot", "trigger_name": "Buffer Snapshot",
    "enabled": 1, "frequency": "Daily", "schedule_time": "08:05",
})
s.save(ignore_permissions=True)
frappe.db.commit()
name = frappe.get_all("Scheduled Job Type",
    filters={"method": "chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot"},
    fields=["name","cron_format","frequency","stopped"])
print("SJT:", name)
PY
```
Expected: prints a Scheduled Job Type with `cron_format = '5 8 * * *'`, `frequency = 'Cron'`, `stopped = 0`. (The temporary row will be replaced by the seed patch in Task 8; you can leave it or remove it.)

- [ ] **Step 6: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.json chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.py chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py
git commit -m "feat(toc): TOC Settings trigger_configurations table + schedule sync on save"
```

---

## Task 5: Pending-status resolver (override → global → default)

**Files:**
- Create: `chaizup_toc/chaizup_toc/toc_engine/pending_status.py`
- Test: `chaizup_toc/chaizup_toc/chaizup_toc/doctype/toc_settings/test_toc_settings.py` (integration — needs DB)

> **Design note (regression-critical):** the legacy global path reads **two** fields for WO/PO (`pending_wo_statuses` + `pending_wo_workflow_states`, and the PO pair) and parses them with the existing helpers, which already carry their own blank-defaults. To avoid any change on the global path, this resolver is **override-only**: it returns just the per-trigger row's cell (or `""`). The engine helpers then do `override or <legacy global read>`, so a blank row reproduces today's behaviour byte-for-byte. The spec's "override → global → default" order is preserved — "global → default" is simply realized by the existing legacy reads/parsers.

- [ ] **Step 1: Write the resolver**

Create `chaizup_toc/chaizup_toc/toc_engine/pending_status.py`:

```python
"""
TOC Pending-Status Resolver — per-trigger OVERRIDE lookup.
===========================================================
# =============================================================================
# CONTEXT: The three production_plan_engine engines (Calc A/B, Calc SO, Calc
#   Action) decide which Sales/Work/Purchase Orders count as "pending". This
#   module returns ONLY the per-trigger override text from a TOC Trigger
#   Configuration row. The engine helpers fall back to the existing global
#   TOC Settings read when the override is blank, so a blank row behaves exactly
#   as before (TS-001 global contract + reports unaffected).
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - row_override returns the RAW text block (pair format 'Status|WorkflowState'
#     supported); existing _parse_* helpers consume it.
#   - voucher in {"so","wo","po"}; trigger_key from the registry.
#   - Active trigger is read from frappe.flags.toc_trigger_key when not passed
#     explicitly (deep WO/PO helpers can't thread a param).
# DANGER ZONE:
#   - NEVER raise on a missing row — return "" so the caller inherits the global.
#   - Do NOT add a global/default branch here; that lives in the engine helpers
#     to keep the global path byte-for-byte identical to the legacy code.
# =============================================================================
"""

import frappe

# Per-row override field on TOC Trigger Configuration, by voucher type.
_ROW_FIELD = {
    "so": "pending_so_statuses",
    "wo": "pending_wo_statuses",
    "po": "pending_po_statuses",
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
```

- [ ] **Step 2: Write the failing integration test**

Append to `chaizup_toc/chaizup_toc/doctype/toc_settings/test_toc_settings.py` (inside the class body, replacing `pass`):

```python
	def test_row_override_blank_returns_empty(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
		s = frappe.get_doc("TOC Settings")
		# ensure a blank-override row exists for so_shortage
		if not any(r.trigger_key == "so_shortage" for r in s.get("trigger_configurations") or []):
			s.append("trigger_configurations", {
				"trigger_key": "so_shortage", "trigger_name": "Sales Order Shortage (Calc SO)",
				"enabled": 1, "frequency": "Daily", "schedule_time": "07:00",
				"pending_wo_statuses": "",
			})
		else:
			for r in s.trigger_configurations:
				if r.trigger_key == "so_shortage":
					r.pending_wo_statuses = ""
		s.flags.ignore_mandatory = True
		s.save(ignore_permissions=True)
		frappe.db.commit()
		self.assertEqual(row_override("wo", trigger_key="so_shortage"), "")

	def test_row_override_returns_cell_when_set(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
		s = frappe.get_doc("TOC Settings")
		for r in s.get("trigger_configurations") or []:
			if r.trigger_key == "so_shortage":
				r.pending_wo_statuses = "Material Transferred"
		s.flags.ignore_mandatory = True
		s.save(ignore_permissions=True)
		frappe.db.commit()
		self.assertEqual(
			row_override("wo", trigger_key="so_shortage"),
			"Material Transferred",
		)
		# reset for other tests
		for r in s.trigger_configurations:
			if r.trigger_key == "so_shortage":
				r.pending_wo_statuses = ""
		s.save(ignore_permissions=True)
		frappe.db.commit()
```

- [ ] **Step 3: Run test to verify it passes (resolver already written)**

Run: `cd /workspace/development/frappe-bench && bench --site development.localhost run-tests --module chaizup_toc.chaizup_toc.doctype.toc_settings.test_toc_settings`
Expected: PASS (2 new tests). If `trigger_configurations` rejects the append because the child doctype isn't migrated, run `bench --site development.localhost migrate` first.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/toc_engine/pending_status.py chaizup_toc/chaizup_toc/doctype/toc_settings/test_toc_settings.py
git commit -m "feat(toc): pending-status resolver (override -> global -> default)"
```

---

## Task 6: Thread trigger context into the three production_plan_engine engines

**Files:**
- Modify: `chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py`

This makes Calc A/B, Calc SO, Calc Action set `frappe.flags.toc_trigger_key` and read pending statuses through the resolver. **Blank rows must reproduce today's behaviour exactly** (regression-critical).

- [ ] **Step 1: Add a context-manager helper near the top of production_plan_engine.py**

After the existing imports in `production_plan_engine.py`, add:

```python
# =============================================================================
# CONFIGURABLE TRIGGERS (2026-06-04) — per-engine pending-status context.
# Each engine entry point sets frappe.flags.toc_trigger_key so the deep WO/PO
# helpers (_toc_wo_statuses_and_wf / _toc_po_statuses_and_wf) can resolve that
# engine's per-trigger override. Always cleared in finally.
# =============================================================================
import contextlib


@contextlib.contextmanager
def _trigger_context(trigger_key):
    prev = getattr(frappe.flags, "toc_trigger_key", None)
    frappe.flags.toc_trigger_key = trigger_key
    try:
        yield
    finally:
        frappe.flags.toc_trigger_key = prev
```

- [ ] **Step 2: Make `_toc_wo_statuses_and_wf` / `_toc_po_statuses_and_wf` override-aware (global path unchanged)**

Replace the bodies of `_toc_wo_statuses_and_wf` (≈line 2067) and `_toc_po_statuses_and_wf` (≈line 2080). The **only** change is a row-override branch in front of the existing legacy read — the legacy two-field global read stays byte-for-byte so blank rows behave exactly as before:

```python
def _toc_wo_statuses_and_wf():
    """Return (statuses, workflow_states) for Work Orders.

    2026-06-04: if the active trigger (frappe.flags.toc_trigger_key) has a
    non-blank per-row override, parse THAT (pair format yields both the status
    and workflow lists from one cell). Otherwise fall back to the unchanged
    global two-field read so existing sites see no behaviour change.
    """
    from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
    ov = row_override("wo")
    if ov:
        return (_parse_wo_statuses(ov), _parse_wo_workflow_states(ov))
    s = frappe.get_cached_doc("TOC Settings")
    return (
        _parse_wo_statuses(s.get("pending_wo_statuses")),
        _parse_wo_workflow_states(s.get("pending_wo_workflow_states")),
    )


def _toc_po_statuses_and_wf():
    """Return (statuses, workflow_states) for Purchase Orders.

    2026-06-04: per-row override first (see _toc_wo_statuses_and_wf), else the
    unchanged global two-field read."""
    from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
    ov = row_override("po")
    if ov:
        return (_parse_po_statuses(ov), _parse_po_workflow_states(ov))
    s = frappe.get_cached_doc("TOC Settings")
    return (
        _parse_po_statuses(s.get("pending_po_statuses")),
        _parse_po_workflow_states(s.get("pending_po_workflow_states")),
    )
```

> Why the override cell carries both lists: a row cell uses the pair format `Status|WorkflowState` (decision #3). `_parse_wo_statuses` extracts the left/status side and `_parse_wo_workflow_states` the right/workflow side from the same text — so one override cell yields both lists, matching how the two legacy global fields were used.

- [ ] **Step 3: Route the SO reads at the three entry points through the resolver + set context**

There are three entry points. In each, (a) wrap the body in `_trigger_context(<key>)`, and (b) replace the direct `settings.projection_pending_so_statuses` reads with the resolver.

**(3a) `run_so_shortage_automation` (≈line 3336), key `"so_shortage"`:** replace these lines:

```python
    pending_statuses = _parse_statuses(settings.projection_pending_so_statuses)
    ...
    confirmed_states = _parse_confirmed_states(settings.projection_pending_so_statuses)
```

with (override-or-global; `_parse_*` already default when blank):

```python
    from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
    _so_raw = row_override("so", trigger_key="so_shortage") or settings.projection_pending_so_statuses
    pending_statuses = _parse_statuses(_so_raw)
    ...
    confirmed_states = _parse_confirmed_states(_so_raw)
```

and wrap the rest of the function body (from after `frappe.only_for(...)` to the `return`) inside:

```python
    with _trigger_context("so_shortage"):
        ... existing body ...
```

> Indentation note: wrapping a long body in a `with` block re-indents many lines. Prefer the lighter-touch alternative: set the flag manually at the top and clear in a `try/finally` around the existing body — same effect, smaller diff:
> ```python
>     frappe.flags.toc_trigger_key = "so_shortage"
>     try:
>         ... existing body ...
>     finally:
>         frappe.flags.toc_trigger_key = None
> ```
> Use whichever yields the smaller, clearer diff. The flag MUST be set before any `_pending_wo_qty` / `_open_po_qty` call and cleared after.

**(3b) `run_shortage_action_automation` (≈line 3925), key `"shortage_action"`:** set `frappe.flags.toc_trigger_key = "shortage_action"` at the top of the body (after `frappe.only_for`), clear in `finally`. If it reads `settings.projection_pending_so_statuses` for SO eligibility, replace with `row_override("so", trigger_key="shortage_action") or settings.projection_pending_so_statuses` (search the function for `projection_pending_so_statuses` and `_parse_statuses`/`_parse_confirmed_states`).

**(3c) `run_projection_automation_for_all_warehouses` (≈line 3099) and/or `_run_for_projection` (≈line 3003), key `"sales_projection"`:** set `frappe.flags.toc_trigger_key = "sales_projection"` around the per-projection loop, clear in `finally`. Replace SO-status reads (`_parse_statuses(settings.projection_pending_so_statuses)` / `_parse_confirmed_states(...)`) with `row_override("so", trigger_key="sales_projection") or settings.projection_pending_so_statuses`, then parse.

> Find every `projection_pending_so_statuses` read in these three functions:
> ```bash
> grep -n "projection_pending_so_statuses" chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py
> ```
> Each occurrence inside the three entry points becomes `row_override("so", trigger_key=...) or settings.projection_pending_so_statuses`. Occurrences OUTSIDE these engines (e.g. report filter-options APIs) must be LEFT UNCHANGED (TS-001: reports read the global field).
> The `import row_override` only needs to happen once per function (reuse `_so_raw`).

- [ ] **Step 4: Verify it compiles + behaviour unchanged for blank rows**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -m py_compile chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py && echo "compile ok"
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import _toc_wo_statuses_and_wf, _toc_po_statuses_and_wf
frappe.flags.toc_trigger_key = "so_shortage"
print("WO:", _toc_wo_statuses_and_wf())
print("PO:", _toc_po_statuses_and_wf())
frappe.flags.toc_trigger_key = None
PY
```
Expected: `compile ok`; WO prints `(['Not Started','In Process','Material Transferred'], [...])` (or the site's global values), PO prints its global/default — proving the resolver returns the same lists the legacy code did when no override is set.

- [ ] **Step 5: Run the existing engine regression (idempotent re-run)**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import run_so_shortage_automation
frappe.set_user("Administrator")
r = run_so_shortage_automation(triggered_by="so_shortage_manual")
print("Calc SO:", {k: r.get(k) for k in ("created","skipped","errors","pairs")})
frappe.db.rollback()
PY
```
Expected: runs without error; counters look sane (e.g. `created=0 skipped=N` on a settled site — matches the memory's "idempotent re-run" behaviour). `frappe.db.rollback()` discards any new PPs from this smoke run.

- [ ] **Step 6: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py
git commit -m "feat(toc): route Calc A/B/SO/Action pending statuses through resolver"
```

---

## Task 7: Calc Action scheduler wrapper + hooks (after_migrate + seeded-disabled cron)

**Files:**
- Modify: `chaizup_toc/tasks/daily_tasks.py` (add wrapper)
- Modify: `chaizup_toc/hooks.py` (after_migrate sync; shortage_action cron)

- [ ] **Step 1: Add the Calc Action wrapper to daily_tasks.py**

In `chaizup_toc/tasks/daily_tasks.py`, add after `daily_so_shortage_automation` (mirror its shape exactly):

```python
def daily_shortage_action_automation():
    """Scheduled wrapper for Shortage Action (Calc Action, feature ref §5.8).

    # =========================================================================
    # CONTEXT: Calc Action iterates Item Minimum Manufacture rows opted-in via
    #   auto_on_shortage / auto_on_max_level and creates PP+WO (manufacture) or
    #   MR (purchase). Previously button-only; this wrapper lets it run on a
    #   cron registered in hooks.py (seeded DISABLED — opt-in per the trigger
    #   config row).
    # MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
    # INSTRUCTIONS:
    #   - Delegate to run_shortage_action_automation; do not re-implement.
    #   - Administrator user so the engine's frappe.only_for guard passes.
    # =========================================================================
    """
    try:
        from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
            run_shortage_action_automation,
        )
        frappe.set_user("Administrator")
        result = run_shortage_action_automation(triggered_by="shortage_action_cron") or {}
        frappe.logger("chaizup_toc").info(
            "Calc Action (cron): %s" % ({k: result.get(k) for k in ("created", "skipped", "errors")})
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Calc Action (cron) FAILED")
```

> Verify `run_shortage_action_automation` accepts `triggered_by="shortage_action_cron"`. Memory says `triggered_by` Select already includes `shortage_action_cron`. Confirm:
> ```bash
> grep -n "shortage_action_cron" chaizup_toc/chaizup_toc/doctype/toc_production_plan_run_log/toc_production_plan_run_log.json
> ```
> If absent, add `shortage_action_cron` to that Select's options (and to `triggered_by` in the run log) before running.

- [ ] **Step 2: Register after_migrate + shortage_action cron in hooks.py**

In `chaizup_toc/hooks.py`:

(2a) Add the shortage_action cron inside `scheduler_events["cron"]` (seeded disabled means the *Scheduled Job Type* is created stopped by the seed patch; but hooks must still declare the method so Frappe knows it). Add after the 07:30 procurement block:

```python
        # ── 07:15 AM Daily: Shortage Action (Calc Action) — OPT-IN ──
        # Declared so Frappe registers the method; the seed patch creates its
        # Scheduled Job Type STOPPED (seed_enabled=0). Users enable it by ticking
        # the 'Shortage Action' row on TOC Settings (which sets stopped=0).
        "15 7 * * *": [
            "chaizup_toc.tasks.daily_tasks.daily_shortage_action_automation"
        ],
```

(2b) Add an `after_migrate` hook (top-level in hooks.py; if one already exists, append to its list):

```python
# ═══════════════════════════════════════════════════════
# AFTER MIGRATE — re-sync trigger schedules so the TOC
# Trigger Configuration table stays authoritative over the
# cron_format that Frappe's sync_jobs writes from hooks.py.
# ═══════════════════════════════════════════════════════
after_migrate = [
    "chaizup_toc.chaizup_toc.toc_engine.trigger_scheduler.resync_after_migrate"
]
```

- [ ] **Step 3: Add `resync_after_migrate` to trigger_scheduler.py**

Append to `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py`:

```python
def resync_after_migrate():
    """after_migrate hook — re-push the TOC Trigger Configuration schedules
    onto Scheduled Job Type, undoing any reset Frappe's sync_jobs applied."""
    import frappe
    try:
        settings = frappe.get_cached_doc("TOC Settings")
    except Exception:
        return  # settings not yet created (fresh install) — seed patch handles it
    sync_all(settings)
    frappe.db.commit()
```

- [ ] **Step 4: Verify compile + hooks load**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -m py_compile chaizup_toc/tasks/daily_tasks.py chaizup_toc/hooks.py chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py && echo "compile ok"
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
print("after_migrate:", frappe.get_hooks("after_migrate"))
PY
```
Expected: `compile ok`; `after_migrate` includes the `resync_after_migrate` path.

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/tasks/daily_tasks.py chaizup_toc/hooks.py chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py
git commit -m "feat(toc): Calc Action cron wrapper + after_migrate re-sync"
```

---

## Task 8: Seed patch (one row per engine, idempotent) + initial sync

**Files:**
- Create: `chaizup_toc/patches/v1_0/seed_trigger_configurations.py`
- Modify: `chaizup_toc/patches.txt`

- [ ] **Step 1: Write the patch**

Create `chaizup_toc/patches/v1_0/seed_trigger_configurations.py`:

```python
"""Seed one TOC Trigger Configuration row per engine (idempotent), then sync.

Pending cells are seeded from the current GLOBAL fields only for voucher
considering engines; schedule from the registry defaults (which mirror the
current hooks crons). Re-runnable: never duplicates an existing trigger_key.
"""

import frappe

from chaizup_toc.chaizup_toc.toc_engine import trigger_registry, trigger_scheduler


def execute():
    settings = frappe.get_doc("TOC Settings")
    existing = {r.trigger_key for r in (settings.get("trigger_configurations") or [])}

    global_so = settings.get("projection_pending_so_statuses") or ""
    global_wo = settings.get("pending_wo_statuses") or ""
    global_po = settings.get("pending_po_statuses") or ""

    added = 0
    for trig in trigger_registry.all_triggers():
        if trig["key"] in existing:
            continue
        c = trig["considers"]
        settings.append("trigger_configurations", {
            "trigger_key": trig["key"],
            "trigger_name": trig["name"],
            "enabled": trig["seed_enabled"],
            "frequency": trig["default_frequency"],
            "schedule_time": trig["default_time"],
            "weekday": trig["default_weekday"],
            "considers_so": c["so"], "considers_wo": c["wo"], "considers_po": c["po"],
            "pending_so_statuses": global_so if c["so"] else "",
            "pending_wo_statuses": global_wo if c["wo"] else "",
            "pending_po_statuses": global_po if c["po"] else "",
        })
        added += 1

    if added:
        settings.flags.ignore_mandatory = True
        settings.flags.ignore_permissions = True
        settings.save(ignore_permissions=True)

    # Always re-sync (covers a partially-seeded prior run).
    trigger_scheduler.sync_all(frappe.get_doc("TOC Settings"))
    frappe.db.commit()
    frappe.logger("chaizup_toc").info("seed_trigger_configurations: added %s rows" % added)
```

- [ ] **Step 2: Ensure the patch package dir is importable**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
test -f chaizup_toc/patches/v1_0/__init__.py && echo "has __init__" || touch chaizup_toc/patches/v1_0/__init__.py
ls chaizup_toc/patches/v1_0/__init__.py
```
Expected: file exists.

- [ ] **Step 3: Register in patches.txt**

Append to `chaizup_toc/patches.txt` (last line):

```
chaizup_toc.patches.v1_0.seed_trigger_configurations
```

- [ ] **Step 4: Run the patch + verify rows + Scheduled Job Types**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost migrate
bench --site development.localhost console <<'PY'
import frappe
s = frappe.get_doc("TOC Settings")
rows = [(r.trigger_key, r.enabled, r.schedule_time) for r in s.trigger_configurations]
print("ROWS:", len(rows)); [print(" ", x) for x in rows]
# all 9 engines present?
keys = {r.trigger_key for r in s.trigger_configurations}
print("missing:", {"min_order_sync","adu_max_level","sales_projection","buffer_mr_run","so_shortage","procurement_monitor","buffer_snapshot","weekly_dbm","shortage_action"} - keys)
# shortage_action should be stopped
sa = frappe.get_all("Scheduled Job Type",
    filters={"method":"chaizup_toc.tasks.daily_tasks.daily_shortage_action_automation"},
    fields=["name","cron_format","stopped"])
print("Calc Action SJT:", sa)
PY
```
Expected: 9 rows; `missing: set()`; Calc Action Scheduled Job Type has `stopped = 1`.

- [ ] **Step 5: Verify idempotency (re-run adds nothing)**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost execute chaizup_toc.patches.v1_0.seed_trigger_configurations.execute
bench --site development.localhost console <<'PY'
import frappe
print("ROWS now:", len(frappe.get_doc("TOC Settings").trigger_configurations))
PY
```
Expected: still 9 rows (no duplicates).

- [ ] **Step 6: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/patches/v1_0/seed_trigger_configurations.py chaizup_toc/patches/v1_0/__init__.py chaizup_toc/patches.txt
git commit -m "feat(toc): seed trigger configurations patch (idempotent + sync)"
```

---

## Task 9: Run dispatcher API (Run Now for every engine)

**Files:**
- Create: `chaizup_toc/api/trigger_runner.py`

- [ ] **Step 1: Write the dispatcher + overview API**

Create `chaizup_toc/api/trigger_runner.py`:

```python
"""
TOC Trigger Runner — manual "Run Now" dispatcher + engine overview.
====================================================================
# =============================================================================
# CONTEXT: Backs the per-engine "Run Now" buttons on TOC Settings. ONE
#   whitelisted dispatcher fires any engine by its registry key, so a button and
#   its cron invoke the exact same method path (no drift).
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# DANGER ZONE:
#   - frappe.only_for gate stays; engines also self-guard. set_user(Administrator)
#     so the engine's own only_for passes when triggered by a TOC Manager.
#   - Heavy engines are enqueued to the long queue; light ones could run inline,
#     but we enqueue ALL for a consistent, non-blocking UX.
# =============================================================================
"""

import frappe

from chaizup_toc.chaizup_toc.toc_engine import trigger_registry


@frappe.whitelist()
def get_trigger_overview():
    """Return the engine list + each engine's resolved schedule + enabled flag,
    for the TOC Settings 'Automation Engines & Triggers' summary."""
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
        })
    return out


@frappe.whitelist()
def run_trigger_now(trigger_key):
    """Fire one automation engine on demand (enqueued). Returns a job handle."""
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
```

- [ ] **Step 2: Smoke test the dispatcher (unknown key rejected; known key enqueues)**

Run:
```bash
cd /workspace/development/frappe-bench
python3 - <<'PY'
import subprocess, json
# compile check
subprocess.run(["python3","-m","py_compile",
  "apps/chaizup_toc/chaizup_toc/api/trigger_runner.py"], check=True)
print("compile ok")
PY
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.api.trigger_runner import run_trigger_now, get_trigger_overview
frappe.set_user("Administrator")
print("overview count:", len(get_trigger_overview()))
try:
    run_trigger_now("nope")
    print("ERROR: should have raised")
except frappe.ValidationError as e:
    print("unknown key rejected OK")
print("buffer_snapshot:", run_trigger_now("buffer_snapshot"))
PY
```
Expected: `compile ok`; `overview count: 9`; `unknown key rejected OK`; `buffer_snapshot: {... 'queued': True ...}`.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/trigger_runner.py
git commit -m "feat(toc): run_trigger_now dispatcher + get_trigger_overview"
```

---

## Task 10: TOC Settings JS — engine overview, Run Now buttons, HH:MM validation, pending-cell greying

**Files:**
- Modify: `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.js`

- [ ] **Step 1: Read the current refresh handler to find the insertion point**

Run: `grep -n "refresh(frm)\|frappe.ui.form.on(\"TOC Settings\"\|_wire_so_shortage_run_button" chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.js | head`
Note the `refresh(frm)` line; you'll add one call inside it.

- [ ] **Step 2: Add an overview+buttons renderer and a row validator**

In `chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.js`, inside the main `frappe.ui.form.on("TOC Settings", { refresh(frm) {...} })` handler, add a call `_toc_render_engine_overview(frm);` at the end of `refresh`. Then add these module-level functions (place near the other `_wire_*` helpers):

```javascript
// =============================================================================
// Configurable Automation Triggers (2026-06-04)
// Renders the engine overview with a per-engine "Run Now" button, validates
// HH:MM on row edit, and greys pending cells where the engine ignores them.
// =============================================================================
function _toc_render_engine_overview(frm) {
    const wrap = frm.fields_dict.automation_triggers_section
        && frm.fields_dict.automation_triggers_section.wrapper;
    if (!wrap) return;
    // Idempotency: remove a prior render.
    const host_id = "toc-engine-overview";
    let host = wrap.querySelector("#" + host_id);
    if (host) host.remove();
    host = document.createElement("div");
    host.id = host_id;
    host.style.cssText = "margin:8px 0 4px 0;";
    wrap.appendChild(host);

    frappe.call({ method: "chaizup_toc.api.trigger_runner.get_trigger_overview" })
        .then((r) => {
            const items = r.message || [];
            host.innerHTML = "";
            const title = document.createElement("div");
            title.style.cssText = "font-weight:600;margin-bottom:6px;";
            title.textContent = "Automation Engines — schedule & manual run";
            host.appendChild(title);
            items.forEach((it) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:10px;"
                    + "padding:4px 0;border-bottom:1px solid var(--border-color,#e5e7eb);";
                const when = it.frequency === "Weekly"
                    ? (it.weekday + " " + it.schedule_time)
                    : (it.schedule_time + " daily");
                const label = document.createElement("div");
                label.style.cssText = "flex:1;font-size:12px;";
                label.innerHTML = "<b>" + frappe.utils.escape_html(it.name) + "</b>"
                    + " &middot; " + frappe.utils.escape_html(when)
                    + (it.enabled ? "" : " &middot; <span style='color:#b45309'>disabled</span>");
                const btn = document.createElement("button");
                btn.className = "btn btn-xs btn-default";
                btn.textContent = "▶ Run Now";
                btn.onclick = () => _toc_run_trigger(it.key, it.name, btn);
                row.appendChild(label);
                row.appendChild(btn);
                host.appendChild(row);
            });
        });
}

function _toc_run_trigger(key, name, btn) {
    frappe.confirm(
        "Run <b>" + frappe.utils.escape_html(name) + "</b> now?",
        () => {
            btn.disabled = true;
            const old = btn.textContent;
            btn.textContent = "Queuing…";
            frappe.call({
                method: "chaizup_toc.api.trigger_runner.run_trigger_now",
                args: { trigger_key: key },
            }).then((r) => {
                frappe.show_alert({
                    message: (r.message && r.message.queued)
                        ? (name + " queued (long queue). Check the Run Log / Error Log.")
                        : (name + " started."),
                    indicator: "green",
                }, 7);
            }).finally(() => {
                btn.disabled = false;
                btn.textContent = old;
            });
        }
    );
}

// HH:MM validation on the child grid.
frappe.ui.form.on("TOC Trigger Configuration", {
    schedule_time(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        const v = (row.schedule_time || "").trim();
        if (v && !/^\d{1,2}:\d{2}$/.test(v)) {
            frappe.msgprint("Time must be HH:MM (24-hour), e.g. 07:30");
            frappe.model.set_value(cdt, cdn, "schedule_time", "");
            return;
        }
        if (v) {
            const [hh, mm] = v.split(":").map(Number);
            if (hh > 23 || mm > 59) {
                frappe.msgprint("Time out of range (00:00–23:59).");
                frappe.model.set_value(cdt, cdn, "schedule_time", "");
            }
        }
    },
});
```

> `frappe.utils.escape_html` exists in v16. If your bench lacks it, use a small inline replace. No single quotes inside any HTML string here are needed; this is JS, not a Desk page template, so the apostrophe rule does not apply — but keep button text ASCII-safe.

- [ ] **Step 3: Build assets + manual UI verification**

Run:
```bash
cd /workspace/development/frappe-bench
bench build --app chaizup_toc
bench --site development.localhost clear-cache
```
Then in a browser open `/app/toc-settings`:
- The **Automation Engines** section lists all 9 engines with their time and a **▶ Run Now** button.
- The `Trigger Configurations` grid shows the rows; editing a `Time` to `99:99` is rejected.
- Click **Run Now** on "Buffer Snapshot" → green toast "queued"; a `TOC Buffer Log` set appears after the worker runs (check `bench --site development.localhost console` for new logs, or the Error Log if it failed).

Expected: all three behaviours work.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/doctype/toc_settings/toc_settings.js
git commit -m "feat(toc): engine overview + per-engine Run Now + HH:MM validation"
```

---

## Task 11: End-to-end verification (override changes engine behaviour)

**Files:** none (verification only).

- [ ] **Step 1: Prove a per-trigger WO override changes Calc SO eligibility**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import _toc_wo_statuses_and_wf

s = frappe.get_doc("TOC Settings")
s.pending_wo_statuses = "Not Started\nIn Process\nMaterial Transferred"   # global
for r in s.trigger_configurations:
    if r.trigger_key == "so_shortage":
        r.pending_wo_statuses = "In Process"   # override: ONLY In Process
s.flags.ignore_mandatory = True
s.save(ignore_permissions=True); frappe.db.commit()

frappe.flags.toc_trigger_key = "so_shortage"
print("so_shortage WO statuses (override):", _toc_wo_statuses_and_wf())   # -> (['In Process'], [])
frappe.flags.toc_trigger_key = "sales_projection"
print("sales_projection WO statuses (inherits global):", _toc_wo_statuses_and_wf())  # -> 3 statuses
frappe.flags.toc_trigger_key = None

# cleanup
for r in s.trigger_configurations:
    if r.trigger_key == "so_shortage":
        r.pending_wo_statuses = ""
s.save(ignore_permissions=True); frappe.db.commit()
PY
```
Expected: the override row returns `(['In Process'], [])`; the projection row returns the 3 global statuses — proving per-trigger override + global inheritance coexist.

- [ ] **Step 2: Prove editing a row time updates the native Scheduled Job Type**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
s = frappe.get_doc("TOC Settings")
for r in s.trigger_configurations:
    if r.trigger_key == "buffer_snapshot":
        r.schedule_time = "08:45"
s.flags.ignore_mandatory = True
s.save(ignore_permissions=True); frappe.db.commit()
print(frappe.get_all("Scheduled Job Type",
    filters={"method":"chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot"},
    fields=["cron_format","frequency","stopped"]))
PY
```
Expected: `cron_format = '45 8 * * *'`.

- [ ] **Step 3: Confirm reports still read the GLOBAL field (TS-001 intact)**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.api.wo_kitting_api import get_toc_pending_filters
print(get_toc_pending_filters())
PY
```
Expected: returns the same `{wo, so, po, edit_route}` shape it did before this feature (reads globals, unaffected by per-trigger rows).

- [ ] **Step 4: Run the full TOC Settings test module**

Run: `cd /workspace/development/frappe-bench && bench --site development.localhost run-tests --module chaizup_toc.chaizup_toc.doctype.toc_settings.test_toc_settings`
Expected: PASS.

- [ ] **Step 5: Commit (no-op safety / notes)**

If any cleanup edits were made during verification, commit them:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add -A && git commit -m "test(toc): e2e verification notes for configurable triggers" --allow-empty
```

---

## Task 12: Documentation — build_docs.py + regenerate docx + memory

**Files:**
- Modify: `documentation/build_docs.py`
- Regenerate: `documentation/Chaizup_TOC_Feature_Reference.docx`
- Update: memory `app_chaizup_toc.md` (+ MEMORY.md pointer is already present)

- [ ] **Step 1: Add a documentation subsection in build_docs.py**

In `documentation/build_docs.py`, after the §6 scheduled-jobs table block (search for `h1("6. Scheduled Background Jobs`), add a new subsection describing the feature. Insert before the next `h1(`:

```python
h2("6.1 Configurable Triggers & Per-Trigger Pending Statuses (2026-06-04)")
para("Purpose:", bold=True)
para(
    "Every automation engine is listed on the TOC Settings page with its "
    "schedule, an Enabled switch, and a manual Run Now button. Editing a "
    "trigger's time rewrites Frappe's native Scheduled Job Type immediately "
    "(no restart or migrate)."
)
para("Per-trigger pending statuses:", bold=True)
para(
    "Each engine row can override which Sales Order, Work Order and Purchase "
    "Order statuses count as pending. Resolution order is: the trigger row's "
    "override (if filled), else the global TOC Settings field, else a built-in "
    "default. The global fields remain the single source of truth for reports "
    "(WO Kitting Planner, Production Overview). Only the three Sales-Order / "
    "shortage engines (Calc A+B, Calc SO, Calc Action) read these lists; the "
    "buffer and procurement runs use live Bin quantities and are marked Not "
    "Applicable."
)
para("Manual run:", bold=True)
para(
    "Run Now enqueues the selected engine on the long queue; the button and the "
    "scheduled job call exactly the same code. Shortage Action (Calc Action) is "
    "now schedulable too, seeded disabled so it only runs once a planner enables "
    "its row."
)
```

- [ ] **Step 2: Regenerate the docx + verify the text landed**

Run:
```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -m py_compile documentation/build_docs.py && python3 documentation/build_docs.py
python3 - <<'PY'
import zipfile, re, html
x = zipfile.ZipFile('documentation/Chaizup_TOC_Feature_Reference.docx').read('word/document.xml').decode()
t = html.unescape(re.sub(r'<[^>]+>','', x.replace('</w:p>','\n')))
print("FOUND" if "Configurable Triggers" in t else "MISSING", "— 6.1 subsection")
PY
```
Expected: `Saved: ...docx` and `FOUND — 6.1 subsection`.

- [ ] **Step 3: Update memory**

Append a new pointer line to `/home/frappe/.claude/projects/-workspace/memory/MEMORY.md` under "App-Specific Knowledge" and create `/home/frappe/.claude/projects/-workspace/memory/chaizup_configurable_triggers.md` summarizing: the registry (single source), the child table, native Scheduled Job Type sync + after_migrate, resolver order (override→global→default), the `frappe.flags.toc_trigger_key` context, the dispatcher, and the correction that buffer/procurement do NOT read configurable statuses. (Follow the memory file format in the repo's memory guidance.)

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add documentation/build_docs.py documentation/Chaizup_TOC_Feature_Reference.docx
git commit -m "docs(toc): document configurable triggers + per-trigger pending statuses"
```

---

## Final verification checklist

- [ ] All 9 engines appear as rows in `TOC Settings → Trigger Configurations` after migrate.
- [ ] Every engine has a working **▶ Run Now** button on the page.
- [ ] Editing a row time changes the matching `Scheduled Job Type.cron_format`.
- [ ] Disabling a row sets `stopped = 1`; enabling sets `stopped = 0`.
- [ ] A per-trigger pending override changes that engine's eligibility; a blank row inherits the global.
- [ ] `get_toc_pending_filters` (reports) output unchanged.
- [ ] Calc SO / Calc A+B idempotent re-run behaviour unchanged when rows are blank.
- [ ] `shortage_action` Scheduled Job Type is seeded `stopped = 1`.
- [ ] docx regenerated with the 6.1 subsection.
- [ ] `bench --site development.localhost run-tests --module chaizup_toc.chaizup_toc.doctype.toc_settings.test_toc_settings` passes.

---

## Notes for the executor

- **Regression is the #1 risk.** The whole point of the override→global→default order is that **blank rows = today's behaviour**. After Task 6, always confirm the blank-row path returns the same status lists the legacy code did before moving on.
- **Two `toc_engine` roots** — double-check every import path against the quirks list.
- **Don't touch** the report-side `get_toc_pending_filters` or any `projection_pending_so_statuses` read that lives outside the three engine entry points (TS-001).
- **Heavy console smoke runs** that create PPs/MRs should end with `frappe.db.rollback()` unless you intend to persist them.
