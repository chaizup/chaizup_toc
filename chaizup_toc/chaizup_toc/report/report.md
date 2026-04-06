# report/ — Script Reports Index

Four Script Reports covering the full operational and analytical surface of the TOC Buffer Management system.

```
report/
├── production_priority_board/    ← Daily: what to produce (FG/SFG)
├── procurement_action_list/      ← Daily: what to buy (RM/PM)
├── buffer_status_report/         ← Historical: how has buffer health changed over time
└── dbm_analysis_report/          ← Weekly: is DBM correctly auto-sizing buffers
```

---

## Reports at a Glance

| Report | Audience | Data Source | Filters | Returns |
|--------|---------|-------------|---------|---------|
| Production Priority Board | Production Supervisor | Live (calculate_all_buffers) | company, type, warehouse, zone, item | columns, data, None, chart, summary |
| Procurement Action List | Procurement Officer | Live (calculate_all_buffers — RM+PM) | company, warehouse, zone, item | columns, data, None, chart, summary |
| Buffer Status Report | Operations Manager | Historical (TOC Buffer Log) | item, warehouse, zone, from_date, to_date | columns, data, None, chart, summary |
| DBM Analysis Report | TOC Manager | Rules + TOC Buffer Log (30d) | None | columns, data |

---

## Frappe Script Report Mechanics

### File Structure (per report)

```
report_name/
├── report_name.json    ← Report metadata (type, doctype, roles, filters)
├── report_name.py      ← execute(filters) Python backend
└── report_name.js      ← Client-side: filters definition + cell formatter
```

### JSON Metadata Fields

```json
{
    "report_name": "Production Priority Board",
    "report_type": "Script",
    "ref_doctype": "TOC Buffer Log",
    "module": "Chaizup Toc",
    "is_standard": "Yes",
    "roles": [
        {"role": "System Manager"},
        {"role": "Stock Manager"},
        {"role": "TOC Manager"},
        {"role": "TOC User"}
    ]
}
```

`ref_doctype` is required for Script Reports even if the report doesn't read that DocType directly. It controls which users can access the report via role permissions.

### Standard execute() Signature

```python
def execute(filters=None):
    columns = get_columns()    # list of column dicts
    data = get_data(filters)   # list of row dicts
    chart = get_chart(data)    # chart config dict, or None
    summary = get_summary(data)# list of summary card dicts, or None
    return columns, data, None, chart, summary
    #                    ^^^^
    #                    "message" slot — unused, must be None not omitted
```

**DBM Analysis Report exception**: Returns only `(columns, data)` — the 2-tuple form. Frappe accepts both.

### Column Definition

```python
{"fieldname": "bp_pct",
 "label": _("BP%<br><small>F3</small>"),
 "fieldtype": "Percent",    # Float, Int, Currency, Data, Link, Date
 "width": 100,
 "options": "Item"}         # required if fieldtype is "Link"
```

`<br><small>` HTML in label is supported in report column headers for sub-labels (formula references).

### Summary Card Definition

```python
{"value": 5,
 "label": "Red Items",
 "datatype": "Int",         # or "Float", "Currency"
 "indicator": "red"}        # red, orange, green, blue
```

### Chart Definition

```python
{
    "data": {
        "labels": ["Green", "Yellow", "Red", "Black"],
        "datasets": [{"name": "Items", "values": [12, 5, 3, 1]}]
    },
    "type": "pie",           # pie, donut, bar, line
    "colors": ["#27AE60", "#F39C12", "#E74C3C", "#2C3E50"],
    "height": 280,
    "axisOptions": {"xIsSeries": True},  # for line/bar charts
}
```

---

## Data Flow Diagram

```
Production Priority Board / Procurement Action List
    │
    ├─→ calculate_all_buffers(company, buffer_type, warehouse, item_code)
    │       │
    │       ├─→ Bin.actual_qty, ordered_qty, reserved_qty   (live ERPNext data)
    │       ├─→ Work Order.qty, produced_qty, status         (live WIP data)
    │       ├─→ TOC Item Buffer.adu, rlt, vf, daf            (buffer rules)
    │       └─→ TOC Settings.zone thresholds, warehouse_rules (configuration)
    │
    └─→ Returns sorted rows with bp_pct, zone, order_qty — displayed in report
    
Buffer Status Report
    │
    └─→ SELECT FROM tabTOC Buffer Log WHERE {filters} LIMIT 500
            │
            └─→ Created daily by:
                  08:00 AM: daily_buffer_snapshot() → all items
                  07:00 AM: mr_generator._log_snapshot() → MR-linked items only

DBM Analysis Report
    │
    ├─→ frappe.get_all("TOC Item Buffer") → rule parameters + DBM counters
    └─→ frappe.get_all("TOC Buffer Log", last 30 days) → zone distribution per item
```

---

## Report Access and Permissions

All four reports share the same role set:

| Role | Can Run Reports |
|------|----------------|
| System Manager | ✓ |
| TOC Manager | ✓ |
| TOC User | ✓ |
| Stock Manager | ✓ |
| Stock User | ✗ (not in roles list) |
| Purchase Manager | ✗ (not in roles list) |

**Note**: Procurement Action List is conceptually for Purchase Managers but they are not in the roles list by default. Add `{"role": "Purchase Manager"}` to `procurement_action_list.json` if the procurement team needs access without TOC User role.

---

## Client-Side JavaScript Pattern

All reports register in `frappe.query_reports`:

```javascript
// In report_name.js
frappe.query_reports["Report Display Name"] = {
    filters: [
        {
            fieldname: "company",
            label: __("Company"),
            fieldtype: "Link",
            options: "Company",
            default: frappe.defaults.get_user_default("Company"),
            reqd: 1,
        },
        {
            fieldname: "zone",
            label: __("Zone"),
            fieldtype: "Select",
            options: "\nGreen\nYellow\nRed\nBlack",
        }
    ],
    formatter(value, row, column, data) {
        // Cell-level formatting — return HTML string
        if (column.fieldname === "zone") {
            // return zone pill HTML
        }
        return value;
    },
    onload(report) {
        // Add toolbar buttons
        report.page.add_inner_button(__("Generate MRs Now"), function() { ... });
    }
};
```

---

## Navigating Between Reports

The reports are connected via toolbar buttons:

```
Production Priority Board
    → [TOC Dashboard] button → toc-dashboard page
    → [Apply DAF] button → DAF dialog
    → [Generate MRs Now] button → trigger_manual_run()

Procurement Action List
    → [TOC Dashboard] button → toc-dashboard page

Buffer Status Report
    → No toolbar buttons (read-only historical report)

DBM Analysis Report
    → No toolbar buttons (read-only analysis report)
```

From the Workspace, all four reports are accessible via dedicated shortcut tiles.

---

## Adding a New Report

1. Create folder: `chaizup_toc/chaizup_toc/report/my_report/`
2. Create `my_report.json` with `"report_type": "Script"`, `"module": "Chaizup Toc"`, `"is_standard": "Yes"`
3. Create `my_report.py` with `def execute(filters=None): ...`
4. Create `my_report.js` with `frappe.query_reports["My Report"] = {...}`
5. Run `bench --site your-site migrate` to register the report
6. Add shortcut to workspace JSON if needed
