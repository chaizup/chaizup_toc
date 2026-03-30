# `report/` — Script Reports

## Reports in This App

| Report | Primary Audience | Data Source | Filters |
|--------|-----------------|-------------|---------|
| `production_priority_board` | Production supervisor | Live (`calculate_all_buffers`) | company, type, warehouse, zone, item |
| `procurement_action_list` | Procurement officer | Live (`calculate_all_buffers`, RM+PM only) | company, warehouse, zone, item |
| `buffer_status_report` | Management / Operations | Historical (`TOC Buffer Log`) | item, warehouse, zone, date range |
| `dbm_analysis_report` | Operations manager | Rules + last 30 days of logs | None |

## Frappe Script Report File Structure
Each report folder:
```
report_name/
├── report_name.json    ← Report metadata (type, doctype, module)
├── report_name.py      ← execute(filters) → (columns, data, message, chart, summary)
└── report_name.js      ← Client-side filters + formatters
```

## Standard `execute()` Return Signature
```python
def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data)
    summary = get_summary(data)
    return columns, data, None, chart, summary
```

Note: `dbm_analysis_report` only returns `columns, data` (no chart/summary).

## Data Flow
```
Production Priority Board / Procurement Action List
    → calculate_all_buffers()      [live, real-time]
    → Bin.actual_qty, reserved_qty, ordered_qty
    → Work Order open qty
    → TOC Item Buffer rules

Buffer Status Report
    → TOC Buffer Log               [historical snapshots]
    → created by daily_buffer_snapshot() at 08:00 AM

DBM Analysis Report
    → TOC Item Buffer rules        [rule metadata]
    → TOC Buffer Log               [last 30 days]
```
