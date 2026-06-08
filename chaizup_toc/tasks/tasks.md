# tasks — Scheduled Background Tasks

All scheduled job functions called by the Frappe scheduler via `hooks.py → scheduler_events`.
Each function is a top-level module function in `daily_tasks.py`.

---

## Cron Schedule (IST)

```
hooks.py scheduler_events:
  "0 0 * * *"   → daily_min_order_sync()         12:00 AM daily
  "0 1 * * *"   → update_min_mfg_adu_levels()    01:00 AM daily  (SOLE ADU job; per warehouse)
  "0 2 * * *"   → daily_production_plan_automation() 02:00 AM daily
  "0 7 * * *"   → daily_production_run()          07:00 AM daily
  "30 7 * * *"  → daily_procurement_run()         07:30 AM daily
  "0 8 * * *"   → daily_buffer_snapshot()         08:00 AM daily
  "0 9 * * 0"   → weekly_dbm_check()              09:00 AM Sunday only
```

> **2026-06-02:** the item-level `daily_adu_update` job was REMOVED (the
> standalone item-level ADU fields it wrote no longer exist). ADU is now
> per warehouse only — see `update_min_mfg_adu_levels` below — and runs at 01:00.

**Why DBM runs at 09:00 AM Sunday (not 08:00 AM):** DBM reads from today's `TOC Buffer Log` entries. The snapshot task fires at 08:00 AM. If both ran at the same time, DBM could read before the snapshot committed, silently evaluating stale data. The 1-hour gap ensures the snapshot is fully committed before DBM reads it.

**Execution context**: All tasks run in Frappe's `long` queue worker as the site's system user (usually Administrator). No HTTP session — no request context. DB transactions are auto-committed per function or manually via `frappe.db.commit()`.

---

## update_min_mfg_adu_levels() — 01:00 AM  (SOLE ADU job since 2026-06-02)

> Replaces the removed item-level `daily_adu_update`. ADU is computed PER
> WAREHOUSE into the "Minimum Manufacture / Purchase Qty per Warehouse" table
> (`Item.custom_minimum_manufacture` → `Item Minimum Manufacture`). The
> standalone item-level ADU fields were deleted (patch
> `v1_0.remove_item_level_adu_fields`).

### Purpose
Per (item, warehouse), refresh `adu`, `adu_lookback_days`, `max_level` and
`last_updated_on` from actual historical transactions.

### Skip rules (per warehouse row)
- `auto_adu = 0` → row is user-managed; the engine never touches it.
- Insufficient history (earliest outflow newer than `today − lookback`) → row is
  left as "warming up" to avoid understating ADU (IMM-003).

### ADU Calculation — UNIVERSAL, item-group-independent (current behaviour)

> **2026-06-02 — IMPORTANT:** ADU does **NOT** depend on Item Group or buffer
> type (FG/SFG/RM/PM). Whatever the Item Group is, the calculation reads **all**
> outward stock movements from the Stock Ledger Entry. This section previously
> documented a per-buffer-type branch (Delivery Note for FG, Stock Entry for
> RM/PM) — that branching **no longer exists in the code** and must not be
> re-introduced. The single source of truth is the Stock Ledger Entry.

**One query for every item — no branching:**
```sql
SELECT COALESCE(ABS(SUM(actual_qty)), 0) AS total_out
FROM `tabStock Ledger Entry`
WHERE item_code   = %(item)s
  AND actual_qty  < 0            -- negative = stock LEFT (any outward movement)
  AND posting_date BETWEEN %(from)s AND %(to)s
  AND is_cancelled = 0
```
`ADU = total_out / days`

**Why the Stock Ledger Entry, and why `actual_qty < 0`?**
Every outward movement in ERPNext writes a Stock Ledger Entry with a negative
`actual_qty`, regardless of the document that caused it. A single `actual_qty < 0`
filter therefore captures, in one query and for any item type:

| Outward movement | Underlying document |
|---|---|
| Sales shipment | Delivery Note |
| Production consumption | Stock Entry (Manufacture / Material Transfer for Manufacture) |
| Manual issue | Stock Entry (Material Issue) |
| Subcontracting transfer-out | Stock Entry / Subcontracting |
| Inventory correction down* | Stock Reconciliation |
| Inter-warehouse transfer-out* | Stock Entry (Material Transfer) |

*\*Consideration (not a bug):* the directive is literally "all the outward
database", so Stock Reconciliation down-adjustments and inter-warehouse
Material Transfer out-legs are currently included. They are corrections /
relocations rather than true demand. If operations later wants a pure
demand-only ADU, exclude those two voucher types in **both** `daily_adu_update`
and `update_min_mfg_adu_levels` — do not change one without the other.

**Live verification (development.localhost, 2026-06-02):** item `CZPFG653`
(a Finished Goods item) — outward in the last 90 days was Delivery Note 61,200 +
Stock Entry 7,200 + Stock Reconciliation 65,880 = 134,280. The scheduled
function wrote `custom_toc_adu_value = 134,280 / 90 = 1,492.0`, summing all
three voucher types — proving item-group independence.

### Lookback window

The lookback is read from `TOC Settings.adu_lookback_days` (default 90), the
single source of truth. `from_date = add_days(today(), -lookback)` to `today()`.
(The old per-item `custom_toc_adu_period` select was removed with the item-level
ADU fields on 2026-06-02.)

### What Gets Written

Per `Item Minimum Manufacture` row (scoped by item AND warehouse), via
`frappe.db.set_value(..., update_modified=False)`:

```python
frappe.db.set_value("Item Minimum Manufacture", row.name, {
    "adu": adu,                          # per-warehouse units/day
    "adu_lookback_days": lookback,       # snapshot of the window used
    "max_level": round(adu * lead * sf, 3),
    "last_updated_on": now_datetime(),
}, update_modified=False)
```

The universal outward SQL above is the same, but additionally scoped by
`warehouse = %(wh)s` so each warehouse gets its own ADU.
`update_modified=False` keeps the parent Item's modified history clean.

### Error Handling
- Per-item exceptions caught → logged to Error Log → batch continues
- Outer try/except catches total failure → logs "TOC ADU FAILED"
- `frappe.db.commit()` once at end of all items

---

## daily_production_run() — 07:00 AM

### Purpose
Generate Material Requests for all buffer types (FG, SFG, RM, PM) in zones defined by `TOC Settings.mr_zones`.

### Execution
```python
def daily_production_run():
    mrs = generate_material_requests()   # no buffer_type filter = ALL types
    # Returns list of created MR names
```

Delegates entirely to `mr_generator.generate_material_requests()`. See `toc_engine/toc_engine.md` for full MR generation logic.

### What Gets Created
- Draft Material Requests (docstatus=0)
- `custom_toc_recorded_by = "By System"`
- `material_request_type = "Manufacture"` for FG/SFG items
- `material_request_type = "Purchase"` for RM/PM items
- One MR per item+warehouse (not batched)
- Skips items with an existing open MR (deduplication)

### Email Alerts
If `TOC Settings.notify_on_red = 1`, sends HTML email to role holders in `red_alert_roles`.

---

## daily_procurement_run() — 07:30 AM

### Purpose
**Monitoring only — NO Material Requests are created here.**

RM and PM MRs are already created by `daily_production_run()` at 07:00 AM (which has no buffer_type filter). This task is a secondary alert for the procurement team.

### Execution
```python
def daily_procurement_run():
    rm_pm = calculate_all_buffers(buffer_type="RM") + calculate_all_buffers(buffer_type="PM")
    red = [b for b in rm_pm if b["zone"] in ("Red", "Black")]
    if red:
        frappe.logger("chaizup_toc").warning(
            f"Procurement: {len(red)} RM/PM in Red/Black")
```

Log entry visible in `Scheduled Job Log` in ERPNext. Procurement managers can check this log.

**Why separate from production run?** Different audiences: production supervisor uses the 07:00 run; procurement team checks this 07:30 log to prioritize supplier calls.

---

## daily_buffer_snapshot() — 08:00 AM

### Purpose
Archive all current buffer states to `TOC Buffer Log`. This historical data feeds:
- DBM engine (TMR/TMG evaluations)
- Buffer Status Report (trend charts)
- DBM Analysis Report (% days in Red/Green)
- Number Cards (today's zone counts)

### Execution
```python
def daily_buffer_snapshot():
    buffers = calculate_all_buffers()   # all types
    for b in buffers:
        log = frappe.new_doc("TOC Buffer Log")
        log.item_code = b["item_code"]
        log.warehouse = b["warehouse"]
        log.log_date = today()
        log.buffer_type = b["buffer_type"]
        log.on_hand_qty = b.get("on_hand", 0)
        log.wip_qty = b.get("wip_or_on_order", 0)       # combined supply
        log.reserved_qty = b.get("backorders_or_committed", 0)  # combined demand
        log.inventory_position = b["inventory_position"]
        log.target_buffer = b["target_buffer"]
        log.buffer_penetration_pct = b["bp_pct"]
        log.stock_remaining_pct = b["sr_pct"]
        log.zone = b["zone"]
        log.order_qty_suggested = b["order_qty"]
        log.flags.ignore_permissions = True
        log.insert()
    frappe.db.commit()
```

**Per-log failure**: Each log insert is in its own try/except. Failures are recorded via `frappe.log_error(frappe.get_traceback(), f"TOC Snapshot: {b['item_code']}")` — visible in the Error Log for diagnosis. One bad record doesn't stop archiving the rest. Commit happens once at the end.

**Note on `wip_qty` field**: The log stores `wip_or_on_order` (the combined supply pipeline, not just WIP). Field name is slightly misleading for RM/PM items where this value is `on_order`, not WIP.

### Data Volume
- 1 record per (item × enabled rule) per day
- 50 items × 2 warehouses = 100 records/day = 36,500 records/year
- No automatic archiving or cleanup exists — monitor `tabTOC Buffer Log` table size

---

## weekly_dbm_check() — 09:00 AM Sunday

### Purpose
Evaluate all buffers for TMR (Too Much Red) and TMG (Too Much Green) triggers.
Auto-adjust target buffer sizes by ±33%.

### Execution
```python
def weekly_dbm_check():
    from chaizup_toc.toc_engine.dbm_engine import evaluate_all_dbm
    evaluate_all_dbm()
```

See `toc_engine/toc_engine.md` for full TMR/TMG logic.

**Prerequisites**: At least 1 RLT worth of `TOC Buffer Log` entries must exist for TMR; 3×RLT entries for TMG. A fresh install has no log data — DBM silently does nothing for first few weeks.

**Skip condition**: `TOC Settings.enable_dbm = 0` → function returns immediately, logs "DBM skipped — disabled in TOC Settings".

---

## Task Execution Order and Dependencies

```
06:30 ADU Update
  ↓  (writes Item.custom_toc_adu_value)
07:00 Production Run
  ↓  (reads ADU from Item via TOC Item Buffer.adu field)
  ↓  (but ADU in TOC Item Buffer is a SEPARATE field — user must manually
  ↓   update TOC Item Buffer.adu or use recalculate_item_buffers API
  ↓   to propagate Item.custom_toc_adu_value → TOC Item Buffer.adu)
07:30 Procurement Run
  ↓  (independent monitoring — no dependency on 07:00)
08:00 Buffer Snapshot
  ↓  (captures current state after all morning operations)
Sunday DBM
     (reads snapshots from previous week)
```

**Important**: The ADU value in `Item.custom_toc_adu_value` is NOT automatically propagated to `TOC Item Buffer.adu`. The buffer rules store their own ADU. The daily ADU calculation updates the Item-level field as a reference, but the actual F1 calculation uses `TOCItemBuffer.adu`. Use `recalculate_item_buffers(item_code)` API to sync them.

---

## Monitoring and Debugging

| Where to check | What to look for |
|---------------|-----------------|
| `Scheduled Job Log` | All 5 tasks listed, status (Success/Failed), execution time |
| `Error Log` | Per-item errors, DBM safeguard hits, ADU failures |
| `frappe.logger("chaizup_toc")` | Info/Warning logs in site's logs/worker.log |
| TOC Buffer Log list | Count of today's entries (should equal enabled rules count) |
| Item.custom_toc_adu_last_updated | Verify 06:30 ADU run succeeded for an item |

### Common Issues

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No MRs created at 07:00 | `auto_generate_mr=0` in TOC Settings | Enable the setting |
| All items showing 0 ADU | No Delivery Notes / Stock Entries in period | Check `custom_toc_adu_period` and posting dates |
| DBM never adjusting | `enable_dbm=0` or insufficient log history | Enable DBM; wait for log data to accumulate |
| Snapshot count < expected | Some items failing `calculate_all_buffers` | Check Error Log for individual item failures |
| Duplicate MRs | `_has_open_mr` check failing | Check MR status — might be "Stopped" (query excludes it) |

---

## Sync Block — 2026-06-02 (ADU-UNIVERSAL)

```
[chaizup_toc · tasks/daily_tasks · ADU-UNIVERSAL · 2026-06-02]
- Average Daily Usage (ADU) is UNIVERSAL and ITEM-GROUP-INDEPENDENT.
  daily_adu_update() (06:30) and update_min_mfg_adu_levels() (06:35) both
  read ALL outward stock movement from `tabStock Ledger Entry`
  (actual_qty < 0, is_cancelled = 0), divided by the lookback days.
- NO branching by Item Group / buffer type / FG-SFG-RM-PM anywhere. One
  query per item (item-level) and per (item, warehouse) (min-mfg rows).
- This supersedes the old per-buffer-type branch (Delivery Note for FG,
  Stock Entry for RM/PM). That code path is gone; do not re-introduce it.
- Consideration: the universal query also includes negative Stock
  Reconciliation legs and inter-warehouse Material Transfer out-legs
  (corrections / relocations, not true demand). Kept because the directive
  is "all outward". To switch to demand-only ADU, exclude those two
  voucher types in BOTH functions in lockstep.
- Verified live (development.localhost): CZPFG653 ADU = (Delivery Note
  61,200 + Stock Entry 7,200 + Stock Reconciliation 65,880) / 90 = 1,492.0.
- RESTRICT: do NOT re-add Item-Group / buffer-type branching to ADU;
  keep update_modified=False on every write; keep the warm-up history
  gate in update_min_mfg_adu_levels (IMM-003); per-warehouse SLE scope
  must stay scoped by warehouse on the min-mfg path.
```

---

## Sync Block — 2026-06-02 (ADU-PER-WAREHOUSE — item-level fields removed)

```
[chaizup_toc · tasks/daily_tasks · ADU-PER-WAREHOUSE · 2026-06-02]
- Standalone item-level ADU fields removed (custom_toc_custom_adu /
  _adu_period / _adu_value / _adu_last_updated + section/column breaks).
  ADU now lives ONLY in the per-warehouse "Minimum Manufacture / Purchase
  Qty per Warehouse" table (Item Minimum Manufacture.adu).
- daily_adu_update DELETED. update_min_mfg_adu_levels is the SOLE ADU job,
  moved to 01:00 (0 1 * * *). Universal + item-group-independent.
- Patch v1_0.remove_item_level_adu_fields drops the 6 Custom Fields + columns.
- Consumers repointed to per-warehouse ADU: Item Projection View Days of
  Cover; Bulk Item Settings (per-row ADU column in Buffer Rules).
- RESTRICT: never re-add an item-level ADU field or item-level ADU cron.
```

---

## Sync Block — Phase 2 (2026-06-03): every job writes an audit row (D4)

```
[chaizup_toc · tasks/daily_tasks · PHASE 2 · 2026-06-03]
- Helper _write_job_log(triggered_by, summary) writes ONE header-only
  TOC Production Plan Run Log row (summary in pending_so_statuses_used) for the
  MONITORING jobs: min_order_sync_cron (00:00), adu_cron (01:00),
  procurement_cron (07:30), snapshot_cron (08:00), dbm_cron (Sun 09:00).
- Voucher-creating jobs log richer: the 07:00 buffer MR generator
  (toc_engine/mr_generator.generate_material_requests) now writes a FULL run log
  with per-item Run Items + a replenishment-mode gate (monitor-only items skipped
  + logged). The 02:00 projection run + Calc SO + Calc Action already log.
- RESTRICT: monitoring logs stay header-only (run-item.item_code is a mandatory
  Link). Do not force item rows there.
```
