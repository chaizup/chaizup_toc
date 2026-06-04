# Configurable Automation Triggers — Design Spec

- **Date:** 2026-06-04
- **App:** `chaizup_toc`
- **Surface:** TOC Settings ("TOC global setting") page
- **Status:** Approved design — pending spec review

## 1. Problem / Goal

On the TOC Settings page the user wants to:

1. **See every automation engine and its trigger time** in one place.
2. **Edit any trigger's time** at runtime (no code deploy / `bench migrate`).
3. Add a **child table** where, per trigger, they configure which **PO / SO / WO statuses count as "pending"** — each entry expressing both a submitted **Status** and a draft **Workflow State** (`Status : Workflow State`).
4. **Tie this into every existing trigger**: before an engine counts pending vouchers, it must resolve that trigger's pending condition (its own row's config), then act.

Today, pending statuses are **global** — three TOC Settings fields (`projection_pending_so_statuses`, `pending_wo_statuses`, `pending_po_statuses`) shared by all engines (the TS-001 "single source of truth" contract that the WO Kitting Planner and Production Overview reports read via `get_toc_pending_filters`). This feature moves pending config to **per-trigger**, while keeping the globals as the default so nothing breaks.

## 2. Engine Inventory (the "list down all engines + trigger time" deliverable)

| key | Trigger Name | Job method | Default trigger | Considers SO / WO / PO | Schedulable |
|---|---|---|---|---|---|
| `min_order_sync` | Min Order Qty Sync | `tasks.daily_tasks.daily_min_order_sync` | 00:00 daily | — / — / — | yes |
| `adu_max_level` | ADU + Max Level | `tasks.daily_tasks.update_min_mfg_adu_levels` | 01:00 daily | — / — / — | yes |
| `sales_projection` | Sales Projection (Calc A+B) | `...production_plan_engine.daily_production_plan_automation` | 02:00 daily | ✓ / ✓ / — | yes |
| `buffer_mr_run` | Buffer Material Request Run | `tasks.daily_tasks.daily_production_run` | 07:00 daily | — / ✓ / ✓ | yes |
| `so_shortage` | Sales Order Shortage (Calc SO) | `tasks.daily_tasks.daily_so_shortage_automation` | 07:00 daily | ✓ / ✓ / ✓ | yes |
| `procurement_monitor` | Procurement Monitoring | `tasks.daily_tasks.daily_procurement_run` | 07:30 daily | — / ✓ / ✓ | yes |
| `buffer_snapshot` | Buffer Snapshot | `tasks.daily_tasks.daily_buffer_snapshot` | 08:00 daily | — / — / — | yes |
| `weekly_dbm` | Weekly DBM | `tasks.daily_tasks.weekly_dbm_check` | Sun 09:00 | — / — / — | yes |
| `shortage_action` | Shortage Action (Calc Action) | `...production_plan_engine.run_shortage_action_automation` (via new wrapper) | on-demand (button); **schedulable, seeded disabled** | ✓ / ✓ / ✓ | yes |

Out of scope: **Real-time buffer alerts** (event-driven on SLE/SO/WO/PO submit/cancel) — no schedule, no pending list, not in the table.

Note: `so_shortage` is now a daily 07:00 cron (added 2026-06-04 in the prior task); this feature makes its time + pending config user-editable like the rest.

## 3. Decisions (locked during brainstorming)

1. **One unified child table** (not two) — trigger name + enabled + schedule + the three pending cells in a single row.
2. **Schedule mechanism = sync native `Scheduled Job Type`.** On save, write each row's computed cron into Frappe's built-in `Scheduled Job Type.cron_format`. No restart/migrate needed; survives restarts; visible in Frappe's own scheduler UI.
3. **Status entry = existing text format.** Each pending cell is a `Small Text`, one entry per line: bare word = submitted status (`docstatus=1 AND status=word`); `Status|WorkflowState` = also matches draft (`docstatus=0 AND workflow_state=...`). Reuses existing parsers/SQL builders. (Click-to-pick dialog deferred.)
4. **All engines are rows**, including button-only ones; setting time+enabled on `shortage_action` turns it into a scheduled job. Pending cells inactive ("— N/A") where the engine reads no vouchers.
5. **Per-trigger overrides; global = default.** Resolution: trigger-row cell (if non-empty) → global TOC Settings field → hardcoded engine default. Reports keep reading the global fields (TS-001 preserved). Seed rows on migrate from current globals + current hooks crons.

## 4. Data Model

### New child DocType — `TOC Trigger Configuration` (`istable = 1`)
Parent: TOC Settings, field `trigger_configurations` (Table).

| Field | Type | Notes |
|---|---|---|
| `trigger_key` | Data | **Read-only, immutable identity.** Matches registry key. Hidden-ish, in form. |
| `trigger_name` | Data | Read-only, `in_list_view`. Friendly label. |
| `enabled` | Check | Default 1. Drives `Scheduled Job Type.stopped`. |
| `frequency` | Select: `Daily`/`Weekly`/`Cron` | Default `Daily`. |
| `schedule_time` | Data | `HH:MM` 24h. Used for Daily/Weekly. |
| `weekday` | Select: Sunday…Saturday | Weekly only. |
| `cron_override` | Data | Advanced: raw 5-field cron; wins over frequency/time when set. |
| `pending_so_statuses` | Small Text | Override; blank = inherit global. |
| `pending_wo_statuses` | Small Text | Override; blank = inherit global. |
| `pending_po_statuses` | Small Text | Override; blank = inherit global. |
| `considers_so` / `considers_wo` / `considers_po` | Check | Read-only, seeded from registry. Drives grid greying. |

Grid (`in_list_view`) columns: `trigger_name`, `enabled`, `frequency`, `schedule_time`, `pending_so_statuses`, `pending_wo_statuses`, `pending_po_statuses`.

### Registry — `toc_engine/trigger_registry.py`
Single canonical list `TOC_TRIGGERS`: list of dicts `{key, name, job_method, default_frequency, default_time, default_weekday, considers: {so,wo,po}, schedulable, seed_enabled}`. Helpers:
- `get_trigger(key)` → dict
- `all_triggers()` → list
- `job_method_for(key)` → dotted path (used to find `Scheduled Job Type`)

This registry is the **one source** that seeds the table, maps rows → Scheduled Job Type, and gives engines their resolver key.

## 5. Schedule Sync (native Scheduled Job Type)

Module `toc_engine/trigger_scheduler.py`:

- `compute_cron(row)` → 5-field cron. `cron_override` wins; else Daily `M H * * *`, Weekly `M H * * <wd>`. Validates `HH:MM` (0–23 / 0–59) and cron shape; invalid → `frappe.throw` (save aborts, nothing half-written).
- `sync_one(row)` → find `Scheduled Job Type` where `method = job_method_for(row.trigger_key)`; set `cron_format`, `frequency="Cron"`, `stopped = not row.enabled`; `save(ignore_permissions=True)`. If the Scheduled Job Type doesn't exist yet (e.g. for a newly schedulable engine), create it.
- `sync_all(settings_doc)` → loop schedulable rows.

Wiring:
- `TOC Settings.validate` (or `on_update`) → `sync_all(self)`.
- `hooks.after_migrate` → reload TOC Settings + `sync_all` (defensive: neutralizes Frappe's `sync_jobs` resetting `cron_format` from hooks on migrate). **This is the load-bearing step that makes the table authoritative over hooks.py.**

For `shortage_action`: add wrapper `tasks.daily_tasks.daily_shortage_action_automation` (mirrors `daily_so_shortage_automation`: set Administrator, delegate to `run_shortage_action_automation(triggered_by="shortage_action_cron")`, its own try/except + run log via the engine). Add a hooks cron for it seeded **disabled** so it never fires until the user enables the row.

## 6. Pending-Status Resolver (ties into all existing triggers)

Module `toc_engine/pending_status.py`:

```python
def resolve_pending(trigger_key, voucher):  # voucher in {"so","wo","po"}
    # 1. trigger row override (non-empty)
    # 2. global TOC Settings field
    # 3. hardcoded engine default
    -> returns the raw text block, then existing _parse_* / _*_eligibility_sql consume it
```

- Reads the parent TOC Settings child rows via cached doc; matches `trigger_key`.
- Returns the **same text format** the existing `_parse_statuses` / `_parse_confirmed_states` / `_parse_wo_statuses` / `_parse_po_statuses` already consume — so SQL builders are unchanged.

Rewire each engine helper to pass **its own** `trigger_key` and route through the resolver before building eligibility SQL:
- Calc A/B (`sales_projection`), Calc SO (`so_shortage`), Calc Action (`shortage_action`) in `production_plan_engine.py`.
- Buffer MR run (`buffer_mr_run`) and Procurement (`procurement_monitor`) where they consult WO/PO/on-order eligibility (`mr_generator.py` / `buffer_calculator.py`).

**Reports unchanged:** `get_toc_pending_filters` keeps reading global fields (TS-001 contract preserved).

## 7. UI (TOC Settings form)

- New Section Break **"Automation Engines & Triggers"**:
  - A read-only HTML block listing every engine + resolved trigger time + enabled state (the "list down all engines + trigger time" ask), rendered from the registry + rows.
  - The editable `trigger_configurations` grid below it.
- `toc_settings.js`: validate `schedule_time` is `HH:MM` on row change; disable/grey the three pending cells when the matching `considers_*` is false; keep existing Run-Now buttons.

## 8. Seeding / Migration

Idempotent patch `chaizup_toc.patches.v1_0.seed_trigger_configurations`:
1. Load TOC Settings. For each registry trigger missing a row, append one: `trigger_name`, `considers_*`, `frequency`/`schedule_time`/`weekday` from registry default (which mirror current hooks crons), pending cells seeded from current global fields **only for voucher-consuming engines**, `enabled = seed_enabled` (1 for currently-scheduled, 0 for `shortage_action`).
2. Save, then `trigger_scheduler.sync_all`.
3. Re-runnable: never duplicates an existing `trigger_key` row.

Register in `patches.txt`.

## 9. Documentation

- Update `documentation/build_docs.py`: new subsection under §5/§6 describing the configurable trigger table + per-trigger pending resolution + the override→global→default order; note `shortage_action` is now schedulable (seeded disabled). Regenerate `Chaizup_TOC_Feature_Reference.docx`.
- Append a session note to memory `app_chaizup_toc.md` after implementation.

## 10. Files Touched

**New**
- `chaizup_toc/chaizup_toc/doctype/toc_trigger_configuration/` (json + py + `__init__`)
- `chaizup_toc/chaizup_toc/toc_engine/trigger_registry.py`
- `chaizup_toc/chaizup_toc/toc_engine/trigger_scheduler.py`
- `chaizup_toc/chaizup_toc/toc_engine/pending_status.py`
- `chaizup_toc/chaizup_toc/patches/v1_0/seed_trigger_configurations.py`

**Modified**
- `doctype/toc_settings/toc_settings.json` (add Table field + section)
- `doctype/toc_settings/toc_settings.py` (validate → sync_all)
- `doctype/toc_settings/toc_settings.js` (HH:MM validation, grid greying, engine summary)
- `hooks.py` (`after_migrate` sync; `shortage_action` cron seeded disabled)
- `tasks/daily_tasks.py` (`daily_shortage_action_automation` wrapper)
- `toc_engine/production_plan_engine.py` (resolver wiring for Calc A/B, SO, Action)
- `toc_engine/mr_generator.py`, `toc_engine/buffer_calculator.py` (resolver wiring for buffer/procurement)
- `documentation/build_docs.py` (+ regenerate docx)
- `patches.txt`

## 11. Guardrails / Risks

- **Migrate overwrite risk:** Frappe `sync_jobs` can reset `cron_format` from hooks on `bench migrate`. Mitigated by `after_migrate` re-sync (§5). **Verify during implementation** that after_migrate runs *after* sync_jobs.
- **Immutable identity:** `trigger_key` must never change once seeded — it links rows↔registry↔Scheduled Job Type. UI keeps it read-only.
- **TS-001 preserved:** global pending fields stay; reports keep reading them; per-trigger only overrides for engines.
- **No item-type / buffer_type reintroduction** (BTP-001 still in force).
- **Invalid schedule never half-applies:** validation throws before any Scheduled Job Type write.
- **YAGNI:** no click-to-pick dialog, no real-time-alert row, no removal of global fields.

## 12. Testing

- Unit: `compute_cron` (daily/weekly/override/invalid), `resolve_pending` (override / global fallback / hardcoded fallback / N/A voucher).
- Integration: seed patch idempotency; editing a row time updates the matching `Scheduled Job Type.cron_format`; disabling a row sets `stopped=1`; an engine with a row override uses the override in its eligibility SQL while a blank row inherits the global.
- Regression: `get_toc_pending_filters` output unchanged; existing Calc SO/A/B/Action dedup + run-log behavior unchanged when rows are blank (pure inherit).
