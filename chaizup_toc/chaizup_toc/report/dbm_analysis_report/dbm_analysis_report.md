# `dbm_analysis_report/` — DBM Analysis Report

## Role
Shows Dynamic Buffer Management state for all TOC-managed buffer rules. Used by operations managers to review buffer sizing health, TMR/TMG trigger frequency, and whether any buffers need manual review.

Type: **Script Report** (no filters)

## Columns

| Column | Source | Description |
|--------|--------|-------------|
| Item | Item.name | TOC-enabled item |
| Warehouse | TOC Item Buffer | Buffer warehouse |
| Current Target (F1) | rule.target_buffer | Current target buffer size |
| ADU | rule.adu | Average Daily Usage |
| RLT | rule.rlt | Replenishment Lead Time |
| VF | rule.variability_factor | Variability Factor |
| TMR Count (F7) | rule.tmr_count | Consecutive Too-Much-Red increases |
| Green Days (F8) | rule.tmg_green_days | Consecutive Green days |
| Last DBM Check | rule.last_dbm_date | Date of last TMR/TMG evaluation |
| % Days in Red | calculated | Proportion of last 30 log entries that were Red/Black |
| % Days in Green | calculated | Proportion of last 30 log entries that were Green |
| DBM Status | calculated | Categorical status with warning indicators |

## Status Logic

| Condition | Status |
|-----------|--------|
| `tmr_count >= 3` | "⚠️ TMR Safeguard Hit" |
| `red_days / total > 30%` | "🔴 Trending Red — TMR likely" |
| `green_days / total > 80%` | "🟢 Trending Green — TMG possible" |
| Otherwise | "Normal" |

## Data Source
- Item list: `frappe.get_all("Item", filters={"custom_toc_enabled":1})`
- Rules: `frappe.get_all("TOC Item Buffer", filters={"parent": item.name, "enabled": 1})`
- Logs: Last 30 days from `TOC Buffer Log` per item+warehouse

## No Chart, No Summary
This report returns only `columns, data` (no chart or summary). The `execute()` call signature: `return columns, data`.

## Usage
1. Run weekly after the Sunday DBM check to see which buffers were adjusted.
2. Look for "TMR Safeguard Hit" — those items need manual review. Buffer has been increased 3 consecutive times without stabilizing.
3. Look for "Trending Red" — consider increasing buffer size manually or investigating supply/demand issues.
4. Look for "Trending Green" — TMG auto-decrease will trigger next Sunday if pattern continues.

## Known Issues

### NOTE: `% Days in Red` uses last 30 calendar days, not last N×RLT
The report uses a fixed 30-day window for trend analysis regardless of each item's RLT. An item with RLT=20 should be evaluated over 60 days (3 cycles) for meaningful TMG analysis, but this report always shows 30 days.

### NOTE: `total = len(logs) or 1` prevents division by zero
If an item has no logs in the last 30 days (no snapshot ran), total defaults to 1. Red/green percentages will be 0%. The status will show "Normal". This is intentional (no data = no action), but the user sees "Normal" where "No Data" would be more accurate.
