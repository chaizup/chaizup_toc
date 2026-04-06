# production_priority_board — Production Priority Board Report

THE daily operational report. Production supervisor opens this every morning at 07:05 AM (after 07:00 AM MRs are created) to decide what the bottleneck machine (VFFS) runs today.

Type: **Script Report** (Frappe Query Report with Python `execute()`)

```
production_priority_board/
├── production_priority_board.json   ← Report metadata
├── production_priority_board.py     ← execute() → columns, data, chart, summary
└── production_priority_board.js     ← Client-side filters + formatters + action buttons
```

---

## What It Answers

**"What do I produce/order first — and how many?"**

Every row = one item-warehouse buffer. Sorted by Buffer Penetration % descending — most urgent item at rank 1.

---

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| `company` | Link | Defaults to user's default company. Passed to `calculate_all_buffers()` |
| `buffer_type` | Select (FG/SFG/RM/PM) | Filter to one type. Blank = all types |
| `warehouse` | Link | Filter to one warehouse |
| `zone` | Select (Green/Yellow/Red/Black) | Post-calculation zone filter (applied in Python after full calculation) |
| `item_code` | Link → Item | Filter to a single item. Dropdown shows only `custom_toc_enabled=1` items |

---

## Columns

| Column | Formula Shown | Source Field | Width |
|--------|--------------|-------------|-------|
| Rank | — | Sequential `i+1` | 60 |
| Item Code | — | `item_code` | 140 |
| Item Name | — | `item_name` | 180 |
| Type | — | `buffer_type` | 60 |
| Warehouse | — | `warehouse` | 140 |
| Target Buffer | F1: ADU×RLT×VF | `target_buffer` | 120 |
| On-Hand | — | `on_hand` | 90 |
| WIP/On-Order | — | `wip_or_on_order` | 100 |
| Backorders/Committed | — | `backorders_or_committed` | 100 |
| IP | F2: OH+WIP−BO | `inventory_position` | 100 |
| BP% | F3: (T−IP)÷T | `bp_pct` | 100 |
| SR% | IP÷Target | `sr_pct` | 80 |
| Zone | — | `zone` | 80 |
| Order Qty | F4: Target−IP | `order_qty` | 110 |
| T/CU | F5: ₹/min | `tcu` | 100 |
| Action | — | `zone_action` | 150 |
| SFG Status | BOM check | `sfg_status.message` | 180 |

---

## execute() — Python Backend

```python
def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data)
    summary = get_summary(data)
    return columns, data, None, chart, summary
```

### get_data(filters)

```python
def get_data(filters):
    kwargs = {}
    if filters:
        for key in ("buffer_type", "company", "warehouse", "item_code"):
            if filters.get(key): kwargs[key] = filters[key]
    
    buffers = calculate_all_buffers(**kwargs)   # live, not from TOC Buffer Log
    
    # Zone filter is applied post-calculation
    if filters and filters.get("zone"):
        buffers = [b for b in buffers if b["zone"] == filters["zone"]]
    
    data = []
    for i, b in enumerate(buffers):
        data.append({
            "rank": i + 1,
            "item_code": b["item_code"],
            "item_name": b["item_name"],
            "buffer_type": b["buffer_type"],
            "warehouse": b["warehouse"],
            "target_buffer": b["target_buffer"],
            "on_hand": b["on_hand"],
            "wip_or_on_order": b["wip_or_on_order"],
            "backorders_or_committed": b["backorders_or_committed"],
            "inventory_position": b["inventory_position"],
            "bp_pct": b["bp_pct"],
            "sr_pct": b["sr_pct"],
            "zone": b["zone"],
            "order_qty": b["order_qty"],
            "tcu": b["tcu"],
            "zone_action": b["zone_action"],
            "sfg_message": b.get("sfg_status", {}).get("message", ""),
        })
    return data
```

**Key**: Data is LIVE from `calculate_all_buffers()` — reads current Bin, Work Order, Purchase Order quantities. Not from TOC Buffer Log (which is historical). This means the report always shows the current state.

### get_chart(data) — Zone Distribution Pie

```python
zone_counts = {"Green": 0, "Yellow": 0, "Red": 0, "Black": 0}
for d in data:
    zone_counts[d["zone"]] = zone_counts.get(d["zone"], 0) + 1

return {
    "data": {
        "labels": list(zone_counts.keys()),
        "datasets": [{"name": "Items", "values": list(zone_counts.values())}]
    },
    "type": "pie",
    "colors": ["#27AE60", "#F39C12", "#E74C3C", "#2C3E50"],
    "height": 280,
}
```

### get_summary(data) — Summary Cards

| Card | Formula | Indicator |
|------|---------|----------|
| Total Buffers | `len(data)` | blue |
| Red/Black (Urgent) | count of Red+Black | red |
| Yellow (Plan) | count of Yellow | orange |
| Green (OK) | count of Green | green |
| Avg BP% | `SUM(bp_pct) / total` | blue |

---

## Row Formatting (production_priority_board.js)

```javascript
frappe.query_reports["Production Priority Board"] = {
    formatter(value, row, column, data) {
        if (column.fieldname === "zone") {
            const colors = { Red: "#E74C3C", Yellow: "#F39C12", Green: "#27AE60", Black: "#2C3E50" };
            return `<span style="background:${colors[value]};color:white;
                     padding:2px 8px;border-radius:4px;font-weight:bold">${value}</span>`;
        }
        if (column.fieldname === "bp_pct") {
            if (value >= 67) return `<b style="color:#E74C3C">${value}%</b>`;
            if (value >= 33) return `<b style="color:#F39C12">${value}%</b>`;
            return `${value}%`;
        }
        if (column.fieldname === "order_qty" && value > 0) {
            return `<b style="color:#E67E22">${value}</b>`;
        }
        return value;
    }
};
```

---

## Action Buttons (Report Toolbar)

### "Generate MRs Now"

```javascript
frm.add_custom_button("Generate MRs Now", function() {
    frappe.only_for(["System Manager", "Stock Manager", "TOC Manager"]);
    frappe.call({
        method: "chaizup_toc.api.toc_api.trigger_manual_run",
        callback(r) {
            let mrs = r.message.material_requests;
            frappe.msgprint({
                title: `${r.message.created} Material Requests Created`,
                message: mrs.map(m => `<a href="/app/material-request/${m}">${m}</a>`).join("<br>"),
            });
            frappe.query_report.refresh();
        }
    });
});
```

### "Apply DAF"

Dialog with preset buttons:

| Preset | DAF | Event Name |
|--------|-----|-----------|
| Diwali | 1.6 | "Diwali 2026" |
| Trade Promotion | 1.8 | "Trade Promotion" |
| Year-End Push | 1.3 | "Year-End Push" |
| Monsoon Dip | 0.85 | "Monsoon Dip" |
| Summer Slow | 0.7 | "Summer Slow" |
| Normal | 1.0 | "Normal Operations" |
| Custom | (user enters) | (user enters) |

Calls `apply_global_daf(daf_value, event_name)` → updates all TOC Item Buffer.adjusted_buffer values → report auto-refreshes.

### "Reset DAF"

Calls `reset_global_daf()` → sets all buffers back to DAF=1.0 → report refreshes.

### "TOC Guide"

Opens `/toc-guide` in a new browser tab.

---

## How to Use (Daily Workflow)

```
07:05 AM — Open Production Priority Board (after daily_production_run completes)

Row 1 (Rank 1, highest BP%):
  FG-MASALA-1KG | Zone: RED | BP: 72.0% | Target: 168 | On-Hand: 42 | Order Qty: 121
  → Schedule VFFS run for 121 units today — FIRST on the machine

Row 2 (Rank 2):
  FG-GINGER-500G | Zone: YELLOW | BP: 44.0% | Order Qty: 50
  → Schedule after Red is completed — can wait until tomorrow if needed

Row 3:
  FG-CARDAMOM-200G | Zone: GREEN | BP: 13.0%
  → No action needed — comfortable buffer

For equal BP%:
  FG-MASALA-1KG (BP=72%, T/CU=1,840 ₹/min)  ← runs first
  FG-GINGER-500G (BP=72%, T/CU=1,200 ₹/min)  ← runs second

T/CU tie-breaker ensures the higher-revenue SKU gets the constraint machine first.
```

---

## Integration

```
Production Priority Board
  → calls calculate_all_buffers()
      → reads: Bin.actual_qty, ordered_qty, reserved_qty
      → reads: Work Order qty/produced_qty (WIP)
      → reads: Work Order Item required/transferred (Committed)
      → reads: TOC Item Buffer rules (ADU, RLT, VF, DAF, target)
      → reads: TOC Settings (zone thresholds, warehouse rules)
  → returns live buffer data sorted by BP% desc
  → "Generate MRs Now" calls trigger_manual_run()
      → calls generate_material_requests()
      → creates Material Request docs (Draft)
```
