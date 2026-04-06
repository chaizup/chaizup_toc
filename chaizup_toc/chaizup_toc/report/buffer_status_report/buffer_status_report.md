# buffer_status_report — Buffer Status Report

The historical lens on buffer health. While the Production Priority Board shows *live* state, this report reads from the `TOC Buffer Log` archive to answer: **"How has this item's buffer behaved over time — and is the buffer correctly sized?"**

Type: **Script Report** (Frappe Query Report with Python `execute()`)

```
buffer_status_report/
├── buffer_status_report.json   ← Report metadata
├── buffer_status_report.py     ← execute() → columns, data, chart, summary
└── buffer_status_report.js     ← Client-side filters + zone pill formatter
```

Primary audience: **Operations Manager, TOC Manager** — for weekly/monthly review, DBM parameter tuning, audit trails, and management reporting.

---

## What It Answers

| Question | How |
|----------|-----|
| "Was FG-MASALA-1KG always Red last week?" | Filter item + date range → read BP% trend |
| "How many Red events triggered MRs in April?" | Filter zone=Red + from/to dates → check MR Created column |
| "Is this buffer correctly sized?" | Look at zone distribution across dates — too much Red = increase target |
| "What did DBM do to this item's buffer?" | Compare target_buffer across dates — jumps indicate TMR/TMG events |
| "Did the MR get created on the day it went Red?" | Check mr_created is populated for Red-zone dates |

---

## Data Source — TOC Buffer Log (Historical)

**NOT live data.** This report reads `tabTOC Buffer Log` — the daily snapshot archive created by `daily_buffer_snapshot()` at 08:00 AM.

The live state equivalent is `Production Priority Board` (uses `calculate_all_buffers()` in real-time).

This distinction matters:
- Buffer Status Report shows **what the buffer was** at snapshot time
- Production Priority Board shows **what the buffer is right now**
- An item that received a large delivery at 10:00 AM will show old data in Buffer Status Report until tomorrow's 08:00 AM snapshot

---

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| `item_code` | Link → Item | Filter to one item. Enables time-series chart |
| `warehouse` | Link → Warehouse | Filter to one warehouse |
| `zone` | Select (Green/Yellow/Red/Black) | Filter to one zone only |
| `from_date` | Date | Start of date range |
| `to_date` | Date | End of date range |

**Recommended usage patterns:**
- Single item + 30-day range → shows BP% trend with line chart
- All items + zone=Red + this month → shows all Red events for management review
- Single item + warehouse → narrows to specific rule (item can have multiple warehouse rules)
- No filters → last 500 snapshots across all items (use tight date range to avoid truncation)

---

## Columns

| Column | Fieldname | Formula | Source |
|--------|-----------|---------|--------|
| Date | `log_date` | — | `TOC Buffer Log.log_date` |
| Item | `item_code` | — | Link to Item |
| Item Name | `item_name` | — | Fetched via LEFT JOIN on Item |
| Warehouse | `warehouse` | — | Link to Warehouse |
| Type | `buffer_type` | — | FG/SFG/RM/PM |
| Target (F1) | `target_buffer` | ADU × RLT × VF | At snapshot time |
| On-Hand | `on_hand_qty` | — | `Bin.actual_qty` at snapshot time |
| WIP | `wip_qty` | — | WIP qty (FG/SFG) or On-Order qty (RM/PM) |
| IP (F2) | `inventory_position` | OH + WIP − BO | Combined inventory position |
| BP% (F3) | `buffer_penetration_pct` | (T − IP) / T × 100 | Urgency % |
| Zone | `zone` | — | Green / Yellow / Red / Black |
| Suggested Qty (F4) | `order_qty_suggested` | T − IP | Replenishment needed at snapshot time |
| MR Created | `mr_created` | — | Link to Material Request if one was created |

---

## execute() — Python Backend

```python
def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data, filters)
    summary = get_summary(data)
    return columns, data, None, chart, summary
```

### get_data(filters) — SQL Query

```python
def get_data(filters):
    conditions = "1=1"
    values = {}

    if filters:
        if filters.get("item_code"):
            conditions += " AND tbl.item_code = %(item_code)s"
            values["item_code"] = filters["item_code"]
        if filters.get("warehouse"):
            conditions += " AND tbl.warehouse = %(warehouse)s"
            values["warehouse"] = filters["warehouse"]
        if filters.get("zone"):
            conditions += " AND tbl.zone = %(zone)s"
            values["zone"] = filters["zone"]
        if filters.get("from_date"):
            conditions += " AND tbl.log_date >= %(from_date)s"
            values["from_date"] = filters["from_date"]
        if filters.get("to_date"):
            conditions += " AND tbl.log_date <= %(to_date)s"
            values["to_date"] = filters["to_date"]

    return frappe.db.sql(f"""
        SELECT tbl.log_date, tbl.item_code,
            i.item_name,
            tbl.warehouse, tbl.buffer_type, tbl.target_buffer,
            tbl.on_hand_qty, tbl.wip_qty, tbl.inventory_position,
            tbl.buffer_penetration_pct, tbl.zone,
            tbl.order_qty_suggested, tbl.mr_created
        FROM `tabTOC Buffer Log` tbl
        LEFT JOIN `tabItem` i ON i.name = tbl.item_code
        WHERE {conditions}
        ORDER BY tbl.log_date DESC, tbl.buffer_penetration_pct DESC
        LIMIT 500
    """, values, as_dict=True)
```

**JOIN rationale**: `item_name` uses `LEFT JOIN tabItem` (not a subquery per row). This was a bug fix — the original used a correlated subquery `(SELECT item_name FROM tabItem WHERE name=tbl.item_code)` which ran one sub-query per row (O(n) round-trips). The LEFT JOIN fetches all item names in a single pass.

**LIMIT 500**: Hardcoded. No pagination available in Frappe Script Reports without custom JS paging. If query returns more than 500 records, the oldest records (lowest date, lowest BP%) are silently dropped due to `ORDER BY log_date DESC`. Apply tight date ranges or item filters to avoid losing data.

---

### get_chart(data, filters) — Time-Series Line Chart

Only rendered when `item_code` filter is set (single-item trend view):

```python
def get_chart(data, filters):
    if not data or not filters or not filters.get("item_code"):
        return None

    # Time series of BP% for selected item
    dates = sorted(set(d.log_date for d in data))[-30:]  # Last 30 unique dates
    bp_values = []
    for date in dates:
        rows = [d for d in data if d.log_date == date]
        bp_values.append(rows[0].buffer_penetration_pct if rows else 0)

    return {
        "data": {
            "labels": [str(d) for d in dates],
            "datasets": [{"name": "BP%", "values": bp_values}]
        },
        "type": "line",
        "colors": ["#E74C3C"],
        "height": 250,
        "axisOptions": {"xIsSeries": True},
    }
```

**Chart logic**: Takes the last 30 unique `log_date` values from the result set. For each date, picks the first matching row's BP%. If an item has multiple warehouse rows on the same date, only the first is shown — use the `warehouse` filter to isolate one rule.

**Red line color (#E74C3C)**: Intentional — highlights that BP% represents "penetration" (urgency). A rising line = deteriorating buffer = approaching stockout.

---

### get_summary(data) — Zone Entry Counts

Counts zone occurrences in the **first 50 rows** of the result (after ORDER BY):

```python
def get_summary(data):
    if not data:
        return []
    zones = {}
    for d in data[:50]:   # WARNING: only first 50 rows
        zones[d.zone] = zones.get(d.zone, 0) + 1
    return [
        {"value": zones.get("Red", 0) + zones.get("Black", 0),
         "label": "Red/Black Entries", "indicator": "red"},
        {"value": zones.get("Yellow", 0),
         "label": "Yellow Entries", "indicator": "orange"},
        {"value": zones.get("Green", 0),
         "label": "Green Entries", "indicator": "green"},
    ]
```

**Known limitation**: `data[:50]` — if result has 500 rows, only the 50 most recent/urgent entries contribute to the summary count. With no filters or broad date ranges, the summary is statistically unrepresentative of the full dataset.

---

## Row Formatting (buffer_status_report.js)

```javascript
frappe.query_reports["Buffer Status Report"] = {
    formatter(value, row, column, data) {
        if (column.fieldname === "zone") {
            const colors = {
                Red: { bg: "#FADBD8", fg: "#E74C3C" },
                Yellow: { bg: "#FEF9E7", fg: "#F39C12" },
                Green: { bg: "#D5F5E3", fg: "#27AE60" },
                Black: { bg: "#D5D8DC", fg: "#2C3E50" },
            };
            const c = colors[value] || { bg: "#eee", fg: "#333" };
            return `<span style="background:${c.bg};color:${c.fg};
                     padding:2px 8px;border-radius:4px;font-weight:bold">${value}</span>`;
        }
        if (column.fieldname === "buffer_penetration_pct") {
            if (value >= 67) return `<b style="color:#E74C3C">${value}%</b>`;
            if (value >= 33) return `<b style="color:#F39C12">${value}%</b>`;
            return `${value}%`;
        }
        return value;
    }
};
```

---

## How to Read This Report — Use Cases

### Use Case 1: Weekly DBM Review

Open report → no item filter, last 7 days:
- Sort by BP% descending
- Look for items that were Red on 5+ of 7 days → strong candidate for TMR (buffer increase)
- Look for items that were Green on all 7 days → TMG candidate (can decrease buffer)
- Compare `target_buffer` values across days — a jump means DBM fired this week

### Use Case 2: Post-MR Audit

Filter `from_date`=today, `zone`=Red:
- All Red entries from today's 08:00 AM snapshot
- `mr_created` column shows which items got MRs from the 07:00 AM run
- Empty `mr_created` for Red items = MR was not generated (check MR zones setting in TOC Settings)

### Use Case 3: Buffer Trend Analysis (Single Item)

Filter `item_code`=FG-MASALA-1KG, `from_date`=2026-01-01, `to_date`=today:
- Line chart shows BP% trend over 3 months
- Can see seasonal patterns (Diwali spike, post-festival dip)
- Compare target_buffer values across dates — flat line = no DBM adjustments
- Any step change in target_buffer = TMR or TMG fired on that date

### Use Case 4: Management Monthly Report

Filter `from_date`=first of month, `to_date`=last of month:
- Export to CSV
- Pivot by zone to get zone-distribution breakdown per item
- Count `mr_created` entries to measure how many procurement actions were taken

---

## Integration

```
TOC Buffer Log populated by:
  daily_buffer_snapshot() at 08:00 AM → one row per item+warehouse
  mr_generator._log_snapshot()        → one row per item where MR was created (07:00 AM)

Buffer Status Report reads these rows:
  → Shows historical state, not live calculations
  → MR Created column links back to the auto-generated Material Request
  → target_buffer column shows the buffer size at snapshot time
      (may differ from current target if DBM has since adjusted it)

DBM Analysis Report reads the same table:
  → Aggregates zone counts over last 30 days per buffer rule
  → Used to assess TMR/TMG readiness
```

---

## Known Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| LIMIT 500 hardcoded | Oldest data silently dropped with broad filters | Apply item or date range filters |
| Summary uses first 50 rows only | Summary counts may not reflect full dataset | Read totals from the full grid, not the summary cards |
| Duplicate logs per day possible | Two rows per item per date (snapshot + MR creation) | Filter by MR Created != "" to see only MR-linked entries |
| No live data | Yesterday's snapshot may not reflect today's deliveries | Use Production Priority Board for current state |
| Chart only for single item | Cannot compare two items' trend on same chart | Run report twice, export, compare in Excel |
