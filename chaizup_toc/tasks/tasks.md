# tasks — Scheduled Background Tasks

All scheduled job functions called by the Frappe scheduler via `hooks.py → scheduler_events`.
Each function is a top-level module function in `daily_tasks.py`.

---

## Cron Schedule (IST)

```
hooks.py scheduler_events:
  "30 6 * * *"  → daily_adu_update()        06:30 AM daily
  "0 7 * * *"   → daily_production_run()    07:00 AM daily
  "30 7 * * *"  → daily_procurement_run()   07:30 AM daily
  "0 8 * * *"   → daily_buffer_snapshot()   08:00 AM daily
  "0 9 * * 0"   → weekly_dbm_check()        09:00 AM Sunday only
```

**Why DBM runs at 09:00 AM Sunday (not 08:00 AM):** DBM reads from today's `TOC Buffer Log` entries. The snapshot task fires at 08:00 AM. If both ran at the same time, DBM could read before the snapshot committed, silently evaluating stale data. The 1-hour gap ensures the snapshot is fully committed before DBM reads it.

**Execution context**: All tasks run in Frappe's `long` queue worker as the site's system user (usually Administrator). No HTTP session — no request context. DB transactions are auto-committed per function or manually via `frappe.db.commit()`.

---

## daily_adu_update() — 06:30 AM

### Purpose
Auto-calculate Average Daily Usage (ADU) for all TOC-enabled items from actual historical transactions.

### R1 Rule — Skip Manual ADU Items
```python
if item.custom_toc_custom_adu:
    skipped += 1
    continue   # User entered manual ADU — never overwrite it
```

### ADU Calculation by Buffer Type

**FG — Delivery Note based (what was SHIPPED)**
```sql
SELECT COALESCE(SUM(dni.qty), 0) as total
FROM `tabDelivery Note Item` dni
JOIN `tabDelivery Note` dn ON dn.name = dni.parent
WHERE dni.item_code = %(item)s
  AND dn.docstatus = 1                    -- submitted only
  AND dn.posting_date BETWEEN %(from)s AND %(to)s
```
`ADU = total / days`

Why Delivery Notes not Sales Orders? DNs represent actual shipments (what left the warehouse). SOs may have future delivery dates and represent demand, not consumption.

**RM/PM — Stock Entry based (what was CONSUMED in production)**
```sql
SELECT COALESCE(SUM(sed.qty), 0) as total
FROM `tabStock Entry Detail` sed
JOIN `tabStock Entry` se ON se.name = sed.parent
WHERE sed.item_code = %(item)s
  AND se.docstatus = 1
  AND se.posting_date BETWEEN %(from)s AND %(to)s
  AND se.stock_entry_type IN (
      'Material Issue',
      'Manufacture',
      'Material Transfer for Manufacture'
  )
  AND sed.s_warehouse IS NOT NULL        -- source warehouse present = outgoing
```
`ADU = total / days`

`s_warehouse IS NOT NULL` filters outgoing entries only — target-only rows (incoming to WIP) are excluded.

**SFG — Any outgoing Stock Entry**
```sql
WHERE sed.s_warehouse IS NOT NULL        -- all types where SFG was consumed
```
SFGs are consumed when blended into FG. Capture all such movements.

### Period Map

| `custom_toc_adu_period` | Days |
|------------------------|------|
| "Last 30 Days" | 30 |
| "Last 90 Days" | 90 (default) |
| "Last 180 Days" | 180 |
| "Last 365 Days" | 365 |

`from_date = add_days(today(), -days)` to `today()`.

### What Gets Written

```python
frappe.db.set_value("Item", item.name, {
    "custom_toc_adu_value": adu,           # e.g., 10.45 units/day
    "custom_toc_adu_last_updated": now_datetime(),
}, update_modified=False)   # Don't change modified timestamp — ADU update is not a doc edit
```

`update_modified=False` prevents ADU updates from cluttering the Item's modified history.

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
