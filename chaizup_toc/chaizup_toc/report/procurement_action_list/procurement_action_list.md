# procurement_action_list — Procurement Action List Report

The daily purchasing decision support report. While Production Priority Board tells the **production supervisor** what to make, this report tells the **procurement officer** what to buy — and how fast to ship it.

Type: **Script Report** (Frappe Query Report with Python `execute()`)

```
procurement_action_list/
├── procurement_action_list.json   ← Report metadata
├── procurement_action_list.py     ← execute() → columns, data, chart, summary
└── procurement_action_list.js     ← Client-side filters + freight recommendation formatter
```

Primary audience: **Purchase Manager, Procurement Officer** — open every morning after the 07:00 AM auto-MR run.

---

## What It Answers

**"Which raw materials and packaging materials do I need to buy, at what urgency, and do I ship by air or road?"**

Every row = one RM or PM item-warehouse buffer. Sorted by Buffer Penetration % descending — most critical material at Rank 1.

The Freight column provides a concrete shipping-mode recommendation based on zone:

| Zone | Freight Recommendation | Rationale |
|------|----------------------|-----------|
| Black | 🚨 EMERGENCY — Air/Same Day | Stockout imminent. Production will halt without this material |
| Red | ✈️ Express/Air Freight | Urgent. Standard lead time will not replenish fast enough |
| Yellow | 🚛 Standard Freight | Plan ahead. Normal procurement cycle is adequate |
| Green | N/A | No action needed. Buffer is comfortable |

---

## Data Source — Live Calculations

Uses `calculate_all_buffers()` for both RM and PM types, merged and sorted:

```python
def get_data(filters):
    rm_buffers = calculate_all_buffers(buffer_type="RM", **filter_kwargs)
    pm_buffers = calculate_all_buffers(buffer_type="PM", **filter_kwargs)
    all_buffers = rm_buffers + pm_buffers
    
    # Zone filter applied post-calculation (same pattern as Production Priority Board)
    if filters and filters.get("zone"):
        all_buffers = [b for b in all_buffers if b["zone"] == filters["zone"]]
    
    # Sort by BP% descending — most urgent first
    all_buffers.sort(key=lambda x: x["bp_pct"], reverse=True)
    
    data = []
    for i, b in enumerate(all_buffers):
        data.append({
            "rank": i + 1,
            "item_code": b["item_code"],
            "item_name": b["item_name"],
            "buffer_type": b["buffer_type"],
            "warehouse": b["warehouse"],
            "target_buffer": b["target_buffer"],
            "on_hand": b["on_hand"],
            "on_order": b["wip_or_on_order"],       # for RM/PM this is On-Order qty
            "committed": b["backorders_or_committed"], # for RM/PM this is Committed qty
            "inventory_position": b["inventory_position"],
            "bp_pct": b["bp_pct"],
            "zone": b["zone"],
            "po_qty": b["order_qty"],               # F4: PO quantity to raise
            "freight": _get_freight(b["zone"]),
            "zone_action": b["zone_action"],
        })
    return data
```

**Real-time**: Unlike Buffer Status Report (historical), this reads current `Bin.ordered_qty`, `Bin.actual_qty`, `Bin.reserved_qty` at the moment the report is run.

---

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| `company` | Link | Defaults to user's default company |
| `warehouse` | Link → Warehouse | Filter to one warehouse |
| `zone` | Select (Green/Yellow/Red/Black) | Show only items in this zone |
| `item_code` | Link → Item | Filter to a single item |

Company filter is passed to `calculate_all_buffers()` (affects which Bin rows are read). Zone, warehouse, item filters are applied post-calculation.

---

## Columns

| Column | Fieldname | Formula | Description |
|--------|-----------|---------|-------------|
| Rank | `rank` | Sequential | Priority position (1 = most urgent) |
| Material | `item_code` | — | Link to Item |
| Name | `item_name` | — | Item display name |
| Type | `buffer_type` | — | RM or PM |
| Target (F1) | `target_buffer` | ADU × RLT × VF | Buffer size goal |
| On-Hand | `on_hand` | — | Current physical stock (Inventory warehouses only) |
| On-Order | `on_order` | — | Open Purchase Order qty (not yet received) |
| Committed | `committed` | — | Reserved for open Work Orders / Sales Orders |
| IP (F2b) | `inventory_position` | OH + On-Order − Committed | Effective available stock |
| BP% (F3) | `bp_pct` | (T − IP) / T × 100 | Urgency percentage |
| Zone | `zone` | — | Green / Yellow / Red / Black |
| PO Qty (F4) | `po_qty` | T − IP | Units to order today |
| Freight | `freight` | — | Express / Standard / EMERGENCY / N/A |
| Action | `zone_action` | — | Action text for this zone |

---

## F2b Calculation (RM/PM) — How IP is Computed

For RM and PM items, the Inventory Position formula differs from FG/SFG:

```
F2b (RM/PM):
  On-Hand    = SUM(Bin.actual_qty WHERE warehouse IN Inventory warehouses)
  On-Order   = SUM(Bin.ordered_qty WHERE warehouse IN Inventory + WIP warehouses)
               ← This is the qty on open, not-yet-received Purchase Orders
  Committed  = SUM(Bin.reserved_qty WHERE warehouse IN Inventory warehouses)
               ← This is qty reserved for open Work Orders (materials released to production)
  
  IP = On-Hand + On-Order − Committed
```

**Example:**
```
FG-MASALA-1KG needs MASALA-BASE powder (RM):
  On-Hand:    400 kg  (in RM Store)
  On-Order:   200 kg  (Purchase Order PO-2026-042 placed, not received)
  Committed:  180 kg  (Work Order WO-2026-015 has material requisitioned)
  
  IP = 400 + 200 − 180 = 420 kg
  
  Target = ADU(30) × RLT(5) × VF(1.2) = 180 kg
  BP% = (180 − 420) / 180 = negative → Green zone (IP > Target)
```

**Negative IP edge case**: If `IP < 0` (committed exceeds on-hand + on-order), `bp_pct > 100%` → zone = Black → Freight = EMERGENCY.

---

## Freight Recommendation Logic

```python
def _get_freight(zone):
    return {
        "Black": "🚨 EMERGENCY — Air/Same Day",
        "Red": "✈️ Express/Air Freight",
        "Yellow": "🚛 Standard Freight",
        "Green": "N/A",
    }.get(zone, "N/A")
```

This is a recommendation, not an automated action. The procurement officer decides the final shipping mode based on supplier terms and lead times.

---

## Row Formatting (procurement_action_list.js)

```javascript
frappe.query_reports["Procurement Action List"] = {
    formatter(value, row, column, data) {
        if (column.fieldname === "zone") {
            const colors = { Red: "#E74C3C", Yellow: "#F39C12", Green: "#27AE60", Black: "#2C3E50" };
            return `<span style="background:${colors[value]};color:white;
                     padding:2px 8px;border-radius:4px;font-weight:bold">${value}</span>`;
        }
        if (column.fieldname === "freight") {
            if (value.includes("EMERGENCY")) return `<b style="color:#E74C3C">${value}</b>`;
            if (value.includes("Express")) return `<b style="color:#E67E22">${value}</b>`;
            return value;
        }
        if (column.fieldname === "bp_pct") {
            if (value >= 67) return `<b style="color:#E74C3C">${value}%</b>`;
            if (value >= 33) return `<b style="color:#F39C12">${value}%</b>`;
            return `${value}%`;
        }
        if (column.fieldname === "po_qty" && value > 0) {
            return `<b style="color:#E67E22">${value}</b>`;
        }
        return value;
    }
};
```

---

## get_chart(data) — Zone Pie Chart

```python
zone_counts = {"Green": 0, "Yellow": 0, "Red": 0, "Black": 0}
for d in data:
    zone_counts[d["zone"]] = zone_counts.get(d["zone"], 0) + 1

return {
    "data": {
        "labels": list(zone_counts.keys()),
        "datasets": [{"name": "Materials", "values": list(zone_counts.values())}]
    },
    "type": "pie",
    "colors": ["#27AE60", "#F39C12", "#E74C3C", "#2C3E50"],
    "height": 280,
}
```

---

## get_summary(data) — Summary Cards

| Card | Value | Indicator |
|------|-------|-----------|
| Total RM/PM Buffers | `len(data)` | blue |
| Urgent (Red/Black) | count of Red + Black items | red |
| Plan (Yellow) | count of Yellow items | orange |
| OK (Green) | count of Green items | green |

---

## Daily Workflow

```
07:00 AM — daily_production_run() creates auto-MRs for Red/Black/Yellow RM/PM items
07:35 AM — Open Procurement Action List

Row 1: MASALA-BASE (RM) | Zone: BLACK | BP%: 103% | On-Hand: 0 | PO Qty: 220 kg
        Freight: EMERGENCY — Air/Same Day
        → Call supplier NOW. If no stock available, escalate to COO.

Row 2: CARDAMOM-EXTRACT (RM) | Zone: RED | BP%: 78% | PO Qty: 90 kg
        Freight: Express/Air
        → MR was auto-created at 07:00 AM. Convert to PO immediately.
        → Request express shipping — standard 7-day lead time will not work.

Row 3: FOIL-POUCH-1KG (PM) | Zone: YELLOW | BP%: 41% | PO Qty: 3,000 pcs
        Freight: Standard Freight
        → Check if MR was created. Convert to PO with normal lead time.

Row 4: JUTE-SACK-50KG (PM) | Zone: GREEN | BP%: 12%
        Freight: N/A
        → No action needed. Comfortable buffer.
```

---

## Relationship to Production Priority Board

| Attribute | Procurement Action List | Production Priority Board |
|-----------|------------------------|--------------------------|
| Buffer types shown | RM + PM only | FG + SFG (all types if filter=blank) |
| Primary user | Procurement Officer | Production Supervisor |
| Key decision | What to BUY and how fast to SHIP | What to PRODUCE first on VFFS |
| Freight column | ✓ Express/Standard/Emergency | ✗ Not shown |
| Order Qty label | "PO Qty" (Purchase Order) | "Order Qty" (Work Order) |
| Data source | Live `calculate_all_buffers()` | Live `calculate_all_buffers()` |

Both reports read live data from the same underlying function. The split is purely by audience and buffer type.

---

## Important Note: Read-Only Report

This report has **no "Generate MRs" toolbar button** (unlike Production Priority Board). 

Purchase Material Requests are generated automatically at **07:00 AM** by `daily_production_run()` for all buffer types including RM/PM. This report is for:
1. Human review of urgency and freight mode
2. Identifying items that may need manual PO creation (if MR-to-PO conversion is not automated)
3. Escalation decisions for Black-zone items

The 07:00 AM auto-MRs appear in `Material Request` list with `custom_toc_recorded_by = "By System"`. The procurement officer's job is to review and convert these to Purchase Orders with appropriate freight terms.
