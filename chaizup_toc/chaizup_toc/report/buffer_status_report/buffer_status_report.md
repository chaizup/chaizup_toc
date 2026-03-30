# `buffer_status_report/` — Buffer Status Report

## Role
Historical trend analysis of buffer states over time. Reads from the `TOC Buffer Log` archive (not live calculations). Used for management reviews, DBM parameter tuning, and audit trail.

Type: **Script Report**

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| `item_code` | Link→Item | Filter to one item (enables time-series chart) |
| `warehouse` | Link | Filter to one warehouse |
| `zone` | Select | Filter to one zone |
| `from_date` | Date | Start of date range |
| `to_date` | Date | End of date range |

## Columns

| Column | Formula | Description |
|--------|---------|-------------|
| Date | | Snapshot date |
| Item | Link | Item code |
| Item Name | | |
| Warehouse | Link | |
| Type | | FG/SFG/RM/PM |
| Target (F1) | | At time of snapshot |
| On-Hand | | Physical stock |
| WIP | | WIP or On-Order qty |
| IP (F2) | | Inventory Position |
| BP% (F3) | | Buffer Penetration % |
| Zone | | Green/Yellow/Red/Black |
| Suggested Qty (F4) | | Order qty at snapshot time |
| MR Created | Link | Material Request (if any) |

## Data Query
Reads from `tabTOC Buffer Log` with conditions built dynamically:
```sql
SELECT tbl.log_date, tbl.item_code, i.item_name, ...
FROM `tabTOC Buffer Log` tbl
LEFT JOIN `tabItem` i ON i.name = tbl.item_code
WHERE {conditions}
ORDER BY tbl.log_date DESC, tbl.buffer_penetration_pct DESC
LIMIT 500
```

## Chart
Shown **only** when `item_code` filter is set. Time-series line chart of BP% for selected item (last 30 log entries).

```python
dates = sorted(set(d.log_date for d in data))[-30:]
```

## Summary
From the first 50 records:
| Card | Count |
|------|-------|
| Red/Black Entries | red + black count |
| Yellow Entries | yellow count |
| Green Entries | green count |

## Bug History

### ~~BUG (FIXED): Correlated subquery for item_name~~
The SQL previously used a subquery per row for `item_name` (O(n) per query). **Fixed**: replaced with `LEFT JOIN \`tabItem\` i ON i.name = tbl.item_code`.

## Notes

### NOTE: LIMIT 500 is hardcoded
No pagination. If filters return more than 500 records, the oldest are silently truncated. This is documented in no UI warning.

### NOTE: Summary uses `data[:50]` only
The summary counts (Red/Black/Yellow/Green entries) only look at the first 50 rows after the ORDER BY. With heavy filters, the summary could be unrepresentative.
