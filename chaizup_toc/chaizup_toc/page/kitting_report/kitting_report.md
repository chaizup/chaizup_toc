# kitting_report — Full Kitting Report Page

The production readiness dashboard. Answers the most critical manufacturing question: **"Can we produce today's required FG/SFG items, and if not, exactly which component is blocking us and what's its current procurement status?"**

Route: `/app/kitting-report`

Type: **Frappe Desk Page** (custom HTML + JS, not a Script Report)

```
kitting_report/
├── kitting_report.json   ← Page metadata (title, module, roles)
├── kitting_report.html   ← Jinja template (page skeleton, filter bar, table, drill-down panel)
└── kitting_report.js     ← KittingReport JS class (all logic)
```

API: `chaizup_toc/api/kitting_api.py`

---

## What It Answers

For every FG and SFG item with pending demand this month:

1. **How much demand exists?** (Sales Orders pending + previous month backlog)
2. **How much is already in stock?** (Bin.actual_qty across all warehouses)
3. **How much do we need to produce?** (Max(0, demand − stock))
4. **Can we produce right now?** (Full BOM check — every component against current stock)
5. **If not, why?** (Which specific component is short)
6. **What's the status of that shortage?** (On PO? On WO? MR raised? No action yet?)

---

## Page Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ Kitting Report    [Create All Work Orders] [Refresh]              │
├──────────────────────────────────────────────────────────────────┤
│ [Company] [Month] [Year] [Type: All/FG/SFG]                      │
├──────────────────────────────────────────────────────────────────┤
│ Main Table:                                                       │
│ Type│Item     │SO Pending│Stock│Prod Req│Should Produce│Kit Status│
│  FG │MASALA   │   240    │ 42  │  198   │   156        │ 🟢 Full  │
│  FG │GINGER   │    80    │  8  │   72   │    72        │🟡 Partial│
│ SFG │BASE-MIX │   300    │120  │  180   │    60        │🔴 Cannot │
├────────────────────────────────────────────────────────────────┤
│ Drill-Down Panel (appears when row clicked):                     │
│ ▼ FG-GINGER-500G — Should Produce: 72 | Can Kit: 45 | Short: 27 │
│                                                                   │
│ BOM Components:                                                   │
│ RM │GINGER-EXTRACT│Required: 360g│In Stock: 225g│Short: 135g     │
│    │Stage: 🔴 Short — No Action  [Create MR]                     │
│ RM │PACKAGING-FOIL│Required: 72pcs│In Stock: 150pcs│Short: 0     │
│    │Stage: 🟢 In Stock                                            │
│ PM │LABEL-GF-500  │Required: 72pcs│In Stock: 20pcs│Short: 52pcs  │
│    │Stage: 🟡 MR Raised [MAT-MR-2026-0089]                       │
└──────────────────────────────────────────────────────────────────┘
```

---

## Main Table Columns

| Column | Description | Calculation |
|--------|-------------|-------------|
| Type | FG / SFG badge | `Item.custom_toc_buffer_type` |
| Item | Item name + code (link to Item form) | — |
| Total SO Pending | Total undelivered SO qty (prev + curr month) | `pending_prev_month + pending_curr_month` |
| Prev Month Pending SO | SOs with delivery_date last month, not fully dispatched | `SO Item qty − delivered_qty WHERE delivery_date in prev month` |
| Curr Month Pending SO | SOs with delivery_date this month, not fully dispatched | Same, current month |
| Curr Dispatched | Delivery Note qty posted this calendar month | `DN Item.qty WHERE docstatus=1 AND posting_date in curr month` |
| Prev Dispatched | Delivery Note qty posted last calendar month | Same, previous month |
| In Stock | Current on-hand stock | `SUM(Bin.actual_qty WHERE item_code=...)` |
| Prod Required | Gross production needed | `Max(0, Total SO Pending − In Stock)` |
| Actual Produced | Manufacture Stock Entries this month | `SE Detail.qty WHERE is_finished_item=1 AND type=Manufacture AND this month` |
| Should Produce | Net remaining production target | `Max(0, Prod Required − Actual Produced)` |
| Kit Status | Can we produce Should Produce qty? | BOM walk — see Kit Status Logic |

---

## Kit Status Logic — How "Can We Kit?" is Calculated

For each FG/SFG item, walks the full multi-level BOM and asks: *"For each leaf component, how many complete units can I produce given current stock?"*

```python
def _calculate_kit_status(item_code, should_produce, bom):
    """
    Returns: (status, kit_qty, kit_pct, component_details)
    """
    # Walk full BOM recursively (up to 6 levels)
    components = _walk_bom(bom, qty_multiplier=1.0)
    
    min_units = float("inf")
    for comp in components:
        # How many complete parent units can this component support?
        units_supportable = comp["stock"] / comp["required_per_unit"]
        min_units = min(min_units, units_supportable)
    
    # Bottleneck: the weakest link in the BOM chain
    kit_qty = min(should_produce, min_units)
    kit_pct = min(100, (kit_qty / should_produce * 100)) if should_produce > 0 else 0
    
    if should_produce <= 0:
        return "No Demand", 0, 0, []
    if kit_pct >= 100:
        return "Full Kit", kit_qty, 100, components
    if kit_pct > 0:
        return "Partial Kit", kit_qty, kit_pct, components
    return "Cannot Kit", 0, 0, components
```

**Example (FG-GINGER-500G, Should Produce = 72 units)**:

```
Component         Required/unit   In Stock   Units Supportable
─────────────────────────────────────────────────────────────
GINGER-EXTRACT    5g              225g        225/5 = 45 units   ← BOTTLENECK
PACKAGING-FOIL    1 pc            150 pcs     150/1 = 150 units
LABEL-GF-500      1 pc            20 pcs      20/1 = 20 units    ← also a constraint

min_units = min(45, 150, 20) = 20

kit_qty = min(72, 20) = 20
kit_pct = 20/72 × 100 = 27.8%
status = "Partial Kit"
```

Wait — the display shows 45 can be kitted, but LABEL-GF-500 only has 20? In the example above, the drill-down showed 45 units "Can Kit". This suggests two separate components were being evaluated in sequence, not simultaneously. The report shows the minimum across ALL components simultaneously.

---

## Kit Status Display

| Status | Icon | Condition |
|--------|------|-----------|
| Full Kit | 🟢 | `kit_pct >= 100` — all components available for full Should Produce qty |
| Partial Kit | 🟡 | `0 < kit_pct < 100` — can produce some but not all required |
| Cannot Kit | 🔴 | `kit_pct = 0` — at least one component has zero stock |
| No Demand | ⚪ | `should_produce <= 0` — item has no outstanding demand this period |

---

## Drill-Down Panel — Component Detail

Clicking any row opens the drill-down panel showing every BOM component with:

### Component Row Data

| Field | Source |
|-------|--------|
| Type | `custom_toc_buffer_type` (or inferred from item group) |
| Item Name + Code | Item master |
| Required Qty | `BOM Item.qty × Should Produce` (for leaf RM/PM) |
| In Stock | `SUM(Bin.actual_qty)` across all warehouses |
| Shortage | `Max(0, Required − In Stock)` |
| Stage Badge | See Stage Logic below |
| Document Links | All open WOs, POs, MRs for this component |

### Stage Logic — Per Component

Evaluated in priority order (first match wins):

```python
def _get_stage(item_code, shortage, open_docs):
    if shortage <= 0:
        return "In Stock", "green"
    
    if any(d["type"] == "Work Order" for d in open_docs):
        return "In Production", "blue"
    
    if any(d["type"] == "Purchase Order" for d in open_docs):
        return "Purchase Ordered", "teal"
    
    if any(d["type"] == "Material Request" for d in open_docs):
        return "MR Raised", "orange"
    
    return "Short — No Action", "red"
```

| Stage | Color | Meaning |
|-------|-------|---------|
| In Stock | 🟢 Green | Shortage ≤ 0. Component is covered. |
| In Production | 🔵 Blue | Short, but a Work Order is open for this SFG/component |
| Purchase Ordered | 🩵 Teal | Short, but a Purchase Order covers the deficit |
| MR Raised | 🟡 Orange | Short, Material Request exists but not yet converted to PO |
| Short — No Action | 🔴 Red | Short, no active document — requires immediate action |

---

## SFG Multi-Level Chain

When a BOM component is itself an SFG (has its own BOM), the drill-down shows a **▼ chain** button:

```
FG-MASALA-1KG
  └─ MASALA-BASE (SFG) [▼ expand chain]
       ├─ CORIANDER-POWDER (RM) — 200g required — 150g in stock — Short 50g — Stage: MR Raised
       ├─ CHILLI-POWDER (RM) — 100g required — 500g in stock — In Stock
       └─ PACKAGING-INNER (PM) — 1 bag required — 3 bags in stock — In Stock
```

Maximum recursion depth: **6 levels**. Prevents infinite loops on circular BOMs (which ERPNext normally prevents, but defensive limit is useful).

---

## BOM Walking — `_walk_bom()`

```python
def _walk_bom(bom_name, qty_multiplier=1.0, depth=0, max_depth=6):
    """
    Recursively walks BOM tree.
    qty_multiplier: how many parent units are being produced (propagates down)
    Returns flat list of leaf components with:
        - item_code, item_name, buffer_type
        - required_qty (absolute, for qty_multiplier units of parent)
        - stock (current Bin.actual_qty sum)
        - shortage
        - open_docs (WOs, POs, MRs)
        - stage
    """
    if depth > max_depth:
        return []
    
    bom_items = frappe.get_all("BOM Item",
        filters={"parent": bom_name, "docstatus": 1},
        fields=["item_code", "qty", "uom"])
    
    result = []
    for bi in bom_items:
        item_type = _resolve_item_type(bi.item_code)
        
        if item_type in ("SFG",) and _has_active_bom(bi.item_code):
            # SFG with sub-BOM → recurse
            sub_bom = _get_active_bom(bi.item_code)
            sub_components = _walk_bom(
                sub_bom, 
                qty_multiplier * bi.qty, 
                depth + 1, 
                max_depth
            )
            result.extend(sub_components)
        else:
            # Leaf component (RM, PM, or SFG without sub-BOM)
            stock = _get_stock(bi.item_code)
            required = bi.qty * qty_multiplier
            shortage = max(0, required - stock)
            open_docs = _get_open_docs(bi.item_code)
            stage, color = _get_stage(bi.item_code, shortage, open_docs)
            
            result.append({
                "item_code": bi.item_code,
                "required_qty": required,
                "stock": stock,
                "shortage": shortage,
                "stage": stage,
                "stage_color": color,
                "open_docs": open_docs,
                ...
            })
    
    return result
```

---

## Action Buttons

### Row-Level Buttons (main table)

| Button | When Shown | Action |
|--------|-----------|--------|
| ⚙️ WO | FG or SFG, should_produce > 0, has active BOM | `create_work_order_from_kitting(item_code, qty, company, bom)` |
| 🛒 MR | Any type, should_produce > 0 | Walks BOM, collects RM/PM shortages → `create_purchase_requests(items_json, company)` |

### Drill-Down Panel Buttons

| Button | Action |
|--------|--------|
| ⚙️ Create Work Order (N units) | Creates WO for this FG with Should Produce qty |
| 🛒 Create Purchase MR (N items) | Creates one Purchase MR covering all short RM/PM in this BOM |
| 📦 Open Item | Opens ERPNext Item form |
| 📐 Open BOM | Opens the active BOM |

### Toolbar Buttons

| Button | Action |
|--------|--------|
| Create All Work Orders | Creates WOs for ALL FG/SFG with should_produce > 0 and active BOM |

**Permission gate on action buttons:**
```javascript
const canCreateWO = frappe.user.has_role([
    "System Manager", "Stock Manager", "TOC Manager", "Manufacturing Manager"
]);
const canCreateMR = frappe.user.has_role([
    "System Manager", "Stock Manager", "TOC Manager", "Purchase Manager"
]);
```

Users without these roles see the Kit Status but cannot trigger document creation.

---

## API Methods (kitting_api.py)

### `get_kitting_summary(company, month, year, buffer_type)`

Main table data. Queries:
1. Sales Orders with pending qty (current + previous month)
2. Delivery Notes for dispatched qty
3. Bin for current stock
4. Manufacture Stock Entries for actual produced this month
5. Kit status via BOM walk

### `get_item_kitting_detail(item_code, required_qty)`

Full BOM component tree for the clicked item. Returns component list with stage, docs, shortage.

### `create_purchase_requests(items_json, company)`

Creates one Purchase MR with all RM/PM shortage items. `items_json` is a JSON string array:
```json
[{"item_code": "GINGER-EXTRACT", "qty": 135, "uom": "Gram", "warehouse": "RM Store"},
 {"item_code": "LABEL-GF-500", "qty": 52, "uom": "Nos", "warehouse": "RM Store"}]
```

Sets `custom_toc_recorded_by = "By System"` on the created MR. Requires `purchase_items` permission.

### `create_work_order_from_kitting(item_code, qty, company, bom)`

Creates a Work Order document in Draft status. Sets:
- `production_item = item_code`
- `qty = qty`
- `bom_no = bom`
- `company = company`
- Warehouses populated from default BOM settings

---

## Filters

| Filter | Type | Description |
|--------|------|-------------|
| Company | Link | Filters SO, DN, Stock data by company |
| Month | Select (1-12) | Month for SO/DN/production calculations |
| Year | Int | Year for same |
| Type | Select (All/FG/SFG) | Show all types or filter |

Changing Month/Year triggers a full data reload (new API call). Type filter is client-side on cached data.

---

## Key Design Decisions

**Why a Page, not a Script Report?**
Script Reports are powerful for tabular data but lack interactive drill-down panels, expandable SFG chains, and inline action buttons. The kitting board needs a rich interactive UI that Script Report's table renderer cannot provide.

**Why not live-refresh like TOC Dashboard?**
BOM walking is expensive (multiple recursive DB queries per item). Auto-refresh every 5 minutes with 20 FG items × 3-level BOMs = 300+ queries per cycle. Instead, the report requires a manual refresh click.

**Why does "Should Produce" not match "Order Qty" from Production Priority Board?**
- **Production Priority Board Order Qty** = `Target Buffer − Inventory Position` (TOC pull signal)
- **Kitting Report Should Produce** = `SO Demand − In Stock − Already Produced` (demand-push signal)
These are complementary views. TOC pull ensures buffer coverage; kitting report ensures customer orders are filled.
