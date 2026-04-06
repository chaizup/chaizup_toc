# toc_buffer_log — TOC Buffer Log DocType

Daily snapshot archive of every item's buffer state. The historical record that powers DBM analysis, trend reports, and Number Card counts.

---

## What It Is

Each record = one point-in-time reading of an item's buffer at a specific warehouse on a specific date. Created automatically — never edited manually.

```
TOCLOG-2026-04-05-FG-MASALA-1KG-0001
  item_code:  FG-MASALA-1KG
  warehouse:  Finished Goods Store
  log_date:   2026-04-05
  on_hand:    42
  wip_qty:    18        (WIP + On-Order combined)
  reserved_qty: 13      (Backorders + Committed combined)
  inventory_position: 47   (F2)
  target_buffer: 168        (F1 or F6 adjusted)
  bp_pct: 72.0              (F3)
  zone: Red
  order_qty_suggested: 121  (F4)
  mr_created: MAT-MR-2026-0042  (linked MR if created today)
```

---

## Fields

### Identity Fields
| Fieldname | Type | Indexed | Description |
|-----------|------|---------|-------------|
| `item_code` | Link → Item | ✓ | Item this snapshot belongs to |
| `item_name` | Data | — | Fetched from item, read-only |
| `warehouse` | Link → Warehouse | ✓ | Warehouse for this buffer rule |
| `log_date` | Date | ✓ | Date snapshot was taken |
| `buffer_type` | Select | — | FG / SFG / RM / PM |
| `company` | Link → Company | — | Company context |

### Inventory Position (F2 Components)
| Fieldname | Type | Description |
|-----------|------|-------------|
| `on_hand_qty` | Float | `Bin.actual_qty` at snapshot time |
| `wip_qty` | Float | WIP (FG) or On-Order (RM/PM) — combined supply pipeline |
| `reserved_qty` | Float | Backorders (FG) or Committed (RM/PM) — combined demand pipeline |
| `inventory_position` | Float | F2 result: On-Hand + WIP − Backorders |

Note: `wip_qty` field stores `wip_or_on_order` (combined supply) and `reserved_qty` stores `backorders_or_committed` (combined demand). The field names are slightly misleading for RM/PM items.

### Buffer Status (F3, F4)
| Fieldname | Type | Description |
|-----------|------|-------------|
| `target_buffer` | Float | F1/F6 value at snapshot time |
| `buffer_penetration_pct` | Float | F3: (Target − IP) / Target × 100 |
| `stock_remaining_pct` | Float | F3 inverse: IP / Target × 100 |
| `zone` | Select | Green / Yellow / Red / Black |
| `order_qty_suggested` | Float | F4: Target − IP |
| `mr_created` | Link → Material Request | MR created for this item on this date (if any) |

---

## How Records Are Created

Two creation paths:

### Path 1: Daily 08:00 AM Snapshot (`daily_buffer_snapshot`)

```python
# In tasks/daily_tasks.py
buffers = calculate_all_buffers()   # all types, all items
for b in buffers:
    log = frappe.new_doc("TOC Buffer Log")
    log.item_code = b["item_code"]
    log.warehouse = b["warehouse"]
    log.log_date = today()
    log.on_hand_qty = b["on_hand"]
    log.wip_qty = b["wip_or_on_order"]        # supply pipeline total
    log.reserved_qty = b["backorders_or_committed"]  # demand pipeline total
    log.inventory_position = b["inventory_position"]
    log.target_buffer = b["target_buffer"]
    log.buffer_penetration_pct = b["bp_pct"]
    log.stock_remaining_pct = b["sr_pct"]
    log.zone = b["zone"]
    log.order_qty_suggested = b["order_qty"]
    # mr_created NOT set here — these are monitoring snapshots
    log.flags.ignore_permissions = True
    log.insert()
frappe.db.commit()
```

This produces a complete daily archive of all buffer states regardless of zone.

### Path 2: MR Creation (`_log_snapshot` in mr_generator.py)

```python
# In toc_engine/mr_generator.py — called after each MR is created
log.mr_created = mr_name   # links snapshot to the generated MR
log.insert()
```

These snapshots link the buffer state to the specific MR that was created — providing an audit trail.

**Duplicate concern**: An item may get TWO logs on the same day:
1. One from `daily_buffer_snapshot()` at 08:00 AM (no `mr_created`)
2. One from `_log_snapshot()` at 07:00 AM (with `mr_created` set)

The DBM engine query doesn't deduplicate — it counts ALL logs in the window. Multiple logs per day = more data points, which skews zone percentages. This is a known quirk; in practice it's minor.

---

## Controller

```python
class TOCBufferLog(Document):
    pass
```

Empty controller — passes all logic to the JSON schema. The DocType uses Frappe's default autoname (`hash` or configured naming series).

---

## Permissions

Custom permission function: `chaizup_toc.api.permissions.has_buffer_log_permission`

| Role | Read | Write | Create | Delete |
|------|------|-------|--------|--------|
| All logged-in users | ✓ | — | — | — |
| Stock Manager | ✓ | — | — | — |
| TOC Manager | ✓ | ✓ | ✓ | — |
| System Manager | ✓ | ✓ | ✓ | ✓ |

Read is open to all roles — buffer data is non-sensitive operational information. Write is restricted to prevent accidental manual edits to the historical record.

---

## How the DBM Engine Reads This Table

```python
# dbm_engine._evaluate_single()

# TMR check: last 1 RLT worth of logs
rlt = flt(rule.rlt) or 3
window = int(rlt + 5)    # small buffer for data availability
logs = frappe.get_all("TOC Buffer Log",
    filters={
        "item_code": rule.parent,
        "warehouse": rule.warehouse,
        "log_date": [">=", add_days(today(), -window)]
    },
    fields=["zone", "log_date"],
    order_by="log_date asc")

# TMR: count Red/Black in last 1 RLT
recent = [l for l in logs if date_diff(today(), l.log_date) <= rlt]
red_days = len([l for l in recent if l.zone in ("Red", "Black")])
threshold = rlt * flt(settings.tmr_red_pct_of_rlt) / 100

if red_days > threshold:
    # Trigger TMR

# TMG: last N×RLT all-Green
tmg_window = int(rlt * cint(settings.tmg_cycles_required))
tmg_logs = [l for l in logs if date_diff(today(), l.log_date) <= tmg_window]
if len(tmg_logs) >= tmg_window:
    green_days = len([l for l in tmg_logs if l.zone == "Green"])
    if green_days >= tmg_window:
        # Trigger TMG
```

**Minimum data needed for DBM to work:**
- TMR: `rlt` days of log history
- TMG: `rlt × 3` days of log history

On fresh install, DBM silently does nothing until sufficient history accumulates.

---

## How Number Cards Read This Table

```python
# toc_api.nc_red_zone_count()
return frappe.db.count("TOC Buffer Log", filters={
    "zone": ["in", ["Red", "Black"]],
    "log_date": today(),
}) or 0
```

Counts today's log entries. If `daily_buffer_snapshot()` hasn't run yet today (e.g., before 08:00 AM), count will be 0 or will reflect yesterday's data if there's a duplicate from `_log_snapshot()` at 07:00 AM.

---

## Data Growth and Housekeeping

With default settings, the table grows at:
```
N items × M warehouses × 2 inserts/day (snapshot + MR creation)
Example: 50 items × 2 warehouses × 2 = 200 records/day = 73,000 records/year
```

**No automatic cleanup is implemented.** Monitor table size on long-running instances.

Archiving strategy options:
```sql
-- Delete logs older than 1 year (run from bench console or cron)
DELETE FROM `tabTOC Buffer Log` 
WHERE log_date < DATE_SUB(CURDATE(), INTERVAL 365 DAY);
```

Indexes on `item_code`, `warehouse`, `log_date` ensure DBM queries remain fast even with large table sizes.

---

## Buffer Status Report Reads This Table

```sql
SELECT tbl.log_date, tbl.item_code, i.item_name, tbl.warehouse,
       tbl.buffer_type, tbl.target_buffer, tbl.on_hand_qty, tbl.wip_qty,
       tbl.inventory_position, tbl.buffer_penetration_pct, tbl.zone,
       tbl.order_qty_suggested, tbl.mr_created
FROM `tabTOC Buffer Log` tbl
LEFT JOIN `tabItem` i ON i.name = tbl.item_code
WHERE {filters}
ORDER BY tbl.log_date DESC, tbl.buffer_penetration_pct DESC
LIMIT 500
```

The 500-record limit is hardcoded — no pagination. Apply tight filters (item_code + date range) to avoid truncation.

---

## Autoname

The DocType uses hash-based naming (Frappe default). Names look like `TOC Buffer Log/xxxxxxxx` (random hash). The `search_index` on `(item_code, warehouse, log_date)` handles all lookup patterns.
