# Configurable Automation Triggers

> Feature module doc (2026-06-04). Lives under `toc_engine/` because the
> registry, scheduler-sync, and pending resolver are engine-layer concerns.
> Read alongside [`toc_engine.md`](./toc_engine.md) and
> [`production_plan_engine.md`](./production_plan_engine.md).

## Reasoning — why this exists

Before this feature, every TOC automation engine's **trigger time was hard-coded
in `hooks.py`** (only changeable by a developer + `bench migrate`), and the
"which Sales/Work/Purchase Order statuses count as pending" lists were **global**
(one set shared by all engines via TOC Settings — the TS-001 contract). Two
operator needs were unmet:

1. **Change when an engine runs** without a code deploy.
2. **Tune pending-status eligibility per engine** (e.g. Calc SO may treat a
   different SO workflow state as pending than Calc A/B), without disturbing the
   reports that depend on the global lists.

Plus: operators need to **see every engine + its schedule in one place** and
**run any engine on demand**.

## In-depth use cases

- *Ops shifts the nightly Sales-Order shortage run from 07:00 to 06:30* → edit
  the `so_shortage` row's Time; the native Scheduled Job Type's `cron_format`
  updates immediately (no restart/migrate).
- *Calc Action should only fire after a planner opts in* → its row is seeded
  **disabled**; ticking Enabled flips the Scheduled Job Type `stopped` flag.
- *Calc SO must also count `On Hold` SOs as pending, but reports must not* →
  fill the `so_shortage` row's Pending SO multiselect; the global field (and
  therefore WKP/POR reports) is untouched.
- *A planner wants to run the buffer MR run right now* → the per-engine
  **▶ Run Now** button enqueues it on the long queue.

## Architecture (4 pieces)

| Unit | File | Responsibility |
|---|---|---|
| **Registry** | `trigger_registry.py` | The ONE canonical list of all 9 engines: `key`, `name`, `job_method`, default schedule, `considers {so,wo,po}`, `seed_enabled`, `help`. Single source mapping engine ↔ method ↔ Scheduled Job Type. |
| **Scheduler sync** | `trigger_scheduler.py` | `compute_cron(row)` (pure, validated) → cron string; `sync_one/sync_all` write it onto the native `Scheduled Job Type`; `ensure_trigger_rows` + `seed_and_sync` auto-seed one row per engine (idempotent) on install/migrate. |
| **Pending resolver** | `pending_status.py` | `row_override(voucher, trigger_key)` → the per-trigger override text, or `""` (inherit). Override-only by design — the global fallback stays in the engine helpers so the global path is byte-for-byte unchanged. |
| **Run dispatcher** | `../../api/trigger_runner.py` | `run_trigger_now(trigger_key)` (enqueue, permission-gated) + `get_trigger_overview()` (UI panel data). |

Data model: child DocType **`TOC Trigger Configuration`** on TOC Settings
(`trigger_configurations`), one row per engine.

UI: `doctype/toc_settings/toc_settings.js` — engine overview panel + per-engine
Run Now buttons, HH:MM validation, locked grid (no manual add/delete), and the
Status:Workflow **multiselect** on the 3 child pending cells (same widget as the
global pending fields, via `item_short_surplus_api.get_filter_options`).

## Resolution order (pending statuses)

```
per-trigger row cell (non-empty)   → override
        ↓ blank
global TOC Settings field          → default  (TS-001 — reports read THIS)
        ↓ blank
hard-coded engine default (_parse_* helper fallbacks)
```

A **blank** row cell = inherit global = identical to pre-feature behaviour.
Only the 3 engines that actually read vouchers honour overrides:
`sales_projection`, `so_shortage`, `shortage_action`. `buffer_mr_run` and
`procurement_monitor` read live `Bin` quantities — their pending columns are
Not Applicable.

## Schedule authority & migrate safety

Frappe's `sync_jobs` (run during `bench migrate`) **overwrites**
`Scheduled Job Type.cron_format` from `hooks.py`. To keep the table
authoritative, `seed_and_sync` is wired into **`after_migrate`**, which
`frappe/migrate.py` runs **after** `sync_jobs` — so the table's times win.
Verified against framework source (migrate.py: sync_jobs L162 < after_migrate
L194).

## Database connections

- **TOC Settings** (Single) ← child table `trigger_configurations`
  (`TOC Trigger Configuration`). Also reads global `projection_pending_so_statuses`,
  `pending_wo_statuses` (+`_workflow_states`), `pending_po_statuses` (+`_workflow_states`).
- **Scheduled Job Type** (core) — one row per engine `method`; this feature
  writes `cron_format`, `frequency='Cron'`, `stopped`.
- Pair options sourced from `Sales Order` / `Work Order` / `Purchase Order` meta
  + `Workflow Document State` (via `item_short_surplus_api.get_filter_options`).
- Engines write **TOC Production Plan Run Log** (+ Run Items) as before.

## RESTRICTED — do NOT change without understanding

- **`trigger_key` is immutable.** It joins row ↔ registry ↔ Scheduled Job Type.
  Renaming a key orphans the schedule + the override.
- **Seed pending cells BLANK.** Pre-filling them from the global field
  re-introduces a parity regression: the combined override cell parses both the
  status AND workflow side, but the global WO/PO path reads workflow from a
  *separate* field it leaves empty — so a pre-filled cell silently changes
  eligibility. Blank = inherit is the contract.
- **Do not add a global/default branch inside `pending_status.row_override`.**
  Keep it override-only; the global fallback lives in `_toc_wo_statuses_and_wf` /
  `_toc_po_statuses_and_wf` / the SO entry points so the global path stays
  byte-for-byte identical to legacy.
- **`considers` flags reflect reality** — only the 3 PP-engine engines read
  configurable statuses. Do not set `considers` true for buffer/procurement.
- **`seed_and_sync` must never raise** out of `after_migrate`/`after_install`
  (would abort migrate). It is wrapped in try/except + `frappe.log_error`.
- **Keep `frappe.only_for` on `run_trigger_now`** — it is whitelisted.
- The global pending-status pair-widget IIFE in `toc_settings.js` is shared with
  the Item Short/Surplus report. The child-row widget is a separate, additive
  block — do not merge them in a way that breaks the global one.

## Verified (live, 2026-06-04)

Edit time → SJT cron updates; disable → stopped=1; bad time → save aborts;
shortage_action seeded stopped; blank rows == global lists (byte-for-byte);
override wins; all 9 engines auto-seeded; `get_toc_pending_filters` (reports)
unchanged. Pure unit tests: 15 pass. Integration tests committed in
`doctype/toc_settings/test_toc_settings.py`.
