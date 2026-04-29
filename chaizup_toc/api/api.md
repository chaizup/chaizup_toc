# api — Public API Endpoints & Utilities

All Python-callable API methods exposed to the Frappe frontend (JS `frappe.call`), REST clients, and internal services. Every function is `@frappe.whitelist()`.

```
api/
├── toc_api.py       ← Core buffer queries, DAF management, Number Cards
├── kitting_api.py   ← Kitting report — demand/supply/BOM analysis + one-click actions
├── permissions.py   ← App-level and DocType-level permission helpers
└── demo_data.py     ← Admin-only test data creation/deletion
```

---

## URL Pattern

```
REST:  GET /api/method/chaizup_toc.api.toc_api.get_priority_board
JS:    frappe.call({ method: "chaizup_toc.api.toc_api.get_priority_board", args: {...} })
```

---

## toc_api.py — Core API

### `get_priority_board(buffer_type, company, warehouse, item_code)`

Returns the full priority-sorted buffer board. Delegates to `calculate_all_buffers()`.

**Access**: All logged-in users.

**Returns**: List of buffer dicts sorted by BP% desc, T/CU desc.

The `item_code` parameter filters results to a single item — used by the Item form "Buffer Status" button to show only that item's buffer across its warehouse rules.

```javascript
// JS example — load FG board for a specific company
frappe.call({
    method: "chaizup_toc.api.toc_api.get_priority_board",
    args: { buffer_type: "FG", company: "Chaizup Foods Pvt Ltd" },
    callback(r) {
        if (!r.exc) {
            r.message.forEach(item => {
                console.log(item.item_code, item.zone, item.bp_pct + "%");
            });
        }
    }
});
```

**REST example:**
```
GET /api/method/chaizup_toc.api.toc_api.get_priority_board?buffer_type=FG
Authorization: token {api_key}:{api_secret}
```

---

### `get_single_buffer(item_code, warehouse)`

Returns buffer status for one item-warehouse pair. Returns `null` if not found.

```javascript
frappe.call({
    method: "chaizup_toc.api.toc_api.get_single_buffer",
    args: { item_code: "FG-MASALA-1KG", warehouse: "Finished Goods Store" },
    callback(r) {
        let buf = r.message;
        if (buf) {
            console.log(`Zone: ${buf.zone}, BP: ${buf.bp_pct}%, Order: ${buf.order_qty}`);
        }
    }
});
```

---

### `trigger_manual_run(buffer_type, zone_filter)`

Manually triggers Material Request generation. Used by Production Priority Board "Generate MRs Now" button.

**Access**: `System Manager`, `Stock Manager`, `TOC Manager` only. Other roles receive a PermissionError.

```javascript
frappe.call({
    method: "chaizup_toc.api.toc_api.trigger_manual_run",
    args: {
        buffer_type: "FG",
        zone_filter: JSON.stringify(["Red", "Black"])  // must be JSON string
    },
    callback(r) {
        if (!r.exc) {
            console.log(`Created ${r.message.created} MRs:`, r.message.material_requests);
        }
    }
});
```

**Returns**: `{ "status": "success", "created": 3, "material_requests": ["MAT-MR-001", ...] }`

---

### `recalculate_item_buffers(item_code)`

Recalculates `target_buffer` and `adjusted_buffer` for all warehouse rules of one item.

**When to use**: After manually changing ADU, RLT, or VF on a `TOC Item Buffer` rule — to sync the F1 target without doing a full item save.

**Access**: `System Manager`, `Stock Manager`, `TOC Manager`.

```python
# Server-side usage
from chaizup_toc.api.toc_api import recalculate_item_buffers
result = recalculate_item_buffers("FG-MASALA-1KG")
# result = {"item_code": "FG-MASALA-1KG", "rules_updated": 2}
```

**Formula applied**: For each rule:
```python
rule.target_buffer = round(flt(rule.adu) * flt(rule.rlt) * flt(rule.variability_factor))
daf = flt(rule.daf) or 1.0
rule.adjusted_buffer = round(rule.target_buffer * daf) if daf != 1.0 else 0
```

---

### `apply_global_daf(daf_value, event_name)`

Applies Demand Adjustment Factor to ALL enabled buffer rules across all items.

**Access**: `System Manager`, `TOC Manager`.

**Validation**: DAF must be between 0.1 and 5.0 (frappe.throw outside this range).

```javascript
// Diwali season — increase all buffers by 60%
frappe.call({
    method: "chaizup_toc.api.toc_api.apply_global_daf",
    args: { daf_value: 1.6, event_name: "Diwali 2026" },
    callback(r) {
        frappe.show_alert(`Updated ${r.message.updated_rules} rules (DAF=1.6 for Diwali 2026)`);
    }
});
```

**What gets updated:**
```sql
-- For each enabled TOC Item Buffer row:
UPDATE `tabTOC Item Buffer`
SET daf = 1.6, adjusted_buffer = ROUND(target_buffer * 1.6)
WHERE name = rule.name
```

Also updates `TOC Settings.default_daf` and `daf_event_name` via `frappe.db.set_single_value()` (correct API for Singleton DocTypes — do NOT use `frappe.db.set_value("TOC Settings", "TOC Settings", ...)` which writes to the wrong table).

**Example calculation:**
```
Before: target_buffer=105, daf=1.0, adjusted_buffer=0
apply_global_daf(1.6)
After:  target_buffer=105, daf=1.6, adjusted_buffer=168

In _calculate_single(): target = adjusted_buffer (168) or target_buffer (105)
  → 168 is used because adjusted_buffer != 0
```

### `reset_global_daf()`

Resets all buffers to DAF=1.0. Calls `apply_global_daf(1.0, "Normal Operations")`.

When DAF=1.0, `adjusted_buffer` is set to 0, meaning `_calculate_single()` falls back to `target_buffer`.

---

### `get_buffer_summary()`

Returns zone counts and average BP% across all items. Used by TOC Dashboard summary cards.

**Returns:**
```json
{
    "Green": 12,
    "Yellow": 5,
    "Red": 3,
    "Black": 1,
    "total": 21,
    "avg_bp_pct": 41.3
}
```

---

### `check_bom(item_code, qty)`

R3: Multi-level BOM component availability check.

```javascript
frappe.call({
    method: "chaizup_toc.api.toc_api.check_bom",
    args: { item_code: "FG-MASALA-1KG", qty: 50 },
    callback(r) {
        let bom = r.message;
        console.log(bom.available, bom.shortfalls, bom.message);
        bom.components.forEach(c => {
            console.log(c.item_code, c.required_qty, c.available_qty, c.available);
        });
    }
});
```

**Returns:**
```json
{
    "available": false,
    "total_components": 5,
    "shortfalls": 1,
    "message": "1 component(s) short",
    "components": [
        {"item_code": "RM-GINGER-PWD", "required_qty": 6, "available_qty": 4,
         "shortfall": 2, "available": false, "depth": 1, "item_type": "RM"}
    ]
}
```

---

### Number Card Methods

All four count `TOC Buffer Log` entries for today's date. Used by workspace Number Cards.

| Method | Returns | Query |
|--------|---------|-------|
| `nc_red_zone_count()` | Int | `COUNT WHERE zone IN ('Red','Black') AND log_date=today()` |
| `nc_yellow_zone_count()` | Int | `COUNT WHERE zone='Yellow' AND log_date=today()` |
| `nc_green_zone_count()` | Int | `COUNT WHERE zone='Green' AND log_date=today()` |
| `nc_open_mr_count()` | Int | `COUNT Material Request WHERE custom_toc_recorded_by='By System' AND docstatus=0` |

**Why custom methods instead of standard Number Card date filters?**
Frappe's Number Card filter uses `"Today"` as a raw string value which breaks in Frappe v14+ (expects `"Timespan","today"` tuple format). These methods bypass that issue by handling date logic server-side in Python.

---

## kitting_api.py — Kitting Report API

### `get_kitting_summary(company, month, year, buffer_type)`

Main table data — one row per TOC-enabled FG/SFG item.

**How demand is calculated:**
```python
curr_from, curr_to = _period_dates(curr_month, curr_year)    # e.g., 2026-04-01 to 2026-04-30
prev_from, prev_to = _period_dates(prev_month, prev_year)    # e.g., 2026-03-01 to 2026-03-31

# Batch SQL for all items at once (no per-item queries)
curr_pending = _so_pending(item_codes, curr_from, curr_to, company)
prev_pending = _so_pending(item_codes, prev_from, prev_to, company)
curr_disp    = _dispatched(item_codes, curr_from, curr_to, company)
curr_prod    = _produced(item_codes, curr_from, curr_to, company)
stock        = _stock_map(item_codes, company)
```

**Per-item calculation:**
```python
in_stock       = stock.get(ic, 0)
total_pending  = curr_pending.get(ic, 0) + prev_pending.get(ic, 0)
prod_required  = max(0, total_pending - in_stock)      # demand gap
actual_produced = curr_prod.get(ic, 0)
should_produce  = max(0, prod_required - actual_produced)

kit = _quick_kit_check(ic, should_produce, bom_name)
```

**Kit status logic:**
```python
# BOM walk → find most constrained component
min_units = min(component_stock / component_per_unit for all leaf components)
kit_qty = min_units
kit_pct = min(100, kit_qty / should_produce * 100)
status  = "full" if kit_pct >= 100 else ("partial" if kit_pct > 0 else "none")
```

**Sort order**: `none` (Cannot Kit) first → `partial` → `full` → `no_demand`. Most urgent items at top.

---

### `get_item_kitting_detail(item_code, required_qty)`

Full drill-down for one FG/SFG. Returns:

```python
{
    "item_code": "FG-MASALA-1KG",
    "required_qty": 50,
    "kit_qty": 35.7,          # can produce this many with current stock
    "shortage": 14.3,          # cannot produce this many
    "bom": "BOM-FG-MASALA-1KG-001",
    "components": [            # multi-level BOM tree
        {
            "item_code": "SFG-MASALA-BLEND",
            "type": "SFG",
            "required_qty": 30.0,
            "in_stock": 25.0,
            "shortage": 5.0,
            "stage": "In Production",    # has open Work Order
            "stage_color": "blue",
            "work_orders": [{"name": "WO-00123", "status": "In Process", "qty": 40, ...}],
            "purchase_orders": [],
            "material_requests": [],
            "depth": 0,
            "sub_components": [          # SFG's own BOM contents
                {"item_code": "RM-TEA-DUST", "type": "RM", ...}
            ]
        },
        ...
    ],
    "work_orders": [...],      # FG's own open Work Orders
    "material_requests": [...] # FG's own open Material Requests
}
```

### Stage Logic — Priority Order

```
if shortage <= 0:         → "In Stock"     (green)
elif work_orders:         → "In Production" (blue)
elif purchase_orders:     → "Purchase Ordered" (teal)
elif material_requests:   → "MR Raised"    (orange)
else:                     → "Short — No Action" (red)
```

Work Orders are fetched for Manufacture-mode components; Purchase Orders for Purchase-mode components. Stage logic applies to all component types — the replenishment mode determines which documents are expected, but all document types are always queried to catch transitional items.

**Important**: MR queries use `mr.docstatus < 2` (Draft + Submitted), NOT `mr.docstatus = 1` (Submitted only). All TOC auto-generated MRs are Drafts (docstatus=0) — they would be invisible if the query filtered only submitted MRs.

---

### `create_purchase_requests(items_json, company)`

One-click: creates a single Purchase Material Request covering all Purchase-mode component shortages.

**Access**: `Stock Manager`, `Purchase Manager`, `TOC Manager`, `System Manager`.

```javascript
frappe.call({
    method: "chaizup_toc.api.kitting_api.create_purchase_requests",
    args: {
        items_json: JSON.stringify([
            { item_code: "RM-GINGER-PWD", shortage_qty: 6000, warehouse: "RM Store" },
            { item_code: "PM-POUCH-1KG",  shortage_qty: 200 }
        ]),
        company: "Chaizup Foods Pvt Ltd"
    },
    callback(r) {
        if (!r.exc) frappe.set_route("Form", "Material Request", r.message.mr);
    }
});
```

**Returns**: `{ "status": "success", "mr": "MAT-MR-2026-0042", "items_count": 2 }`

**UOM resolution (stock_uom → purchase_uom)**:
`shortage_qty` input is always in **stock_uom**. The function converts to `purchase_uom` for the MR line:
```python
stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or "Nos"
purchase_uom = frappe.db.get_value("Item", item_code, "purchase_uom") or stock_uom
cf = frappe.db.get_value("UOM Conversion Detail",
    {"parent": item_code, "uom": purchase_uom}, "conversion_factor") or 1.0
mr_qty = shortage_qty / cf    # e.g., 6000 Gram / 1000 = 6 KG on MR line
```
The MR line stores `qty` (in purchase_uom), `stock_uom`, and `conversion_factor` so ERPNext can correctly compute `stock_qty = qty × conversion_factor`.

**Caller responsibility**: The JS `_collectPurchaseShortages()` in kitting_report.js collects only components where `c.type === "Purchase"` — Manufacture-mode sub-assemblies are excluded (they get Work Orders, not MRs).

---

### `create_work_order_from_kitting(item_code, qty, company, bom)`

One-click: creates a Work Order. Auto-detects BOM from `custom_toc_default_bom` or active ERPNext BOM.

**Access**: `Stock Manager`, `Manufacturing Manager`, `TOC Manager`, `System Manager`.

```python
wo = frappe.new_doc("Work Order")
wo.production_item = item_code
wo.bom_no = bom_name           # resolved from item or provided
wo.qty = qty
wo.company = company
wo.planned_start_date = today()
wo.flags.ignore_permissions = True
wo.insert()   # Draft Work Order — not submitted
```

**Returns**: `{ "status": "success", "work_order": "WO-00124", "item_code": "FG-MASALA-1KG", "qty": 50 }`

---

## permissions.py

### `has_buffer_log_permission(doc, ptype, user)`

Registered in `hooks.py → has_permission["TOC Buffer Log"]`.

| Permission Type | Who Can |
|----------------|---------|
| read | Everyone (returns True unconditionally) |
| write / create / delete | TOC Manager, Stock Manager, System Manager only |

```python
def has_buffer_log_permission(doc, ptype, user):
    if ptype == "read":
        return True
    roles = frappe.get_roles(user)
    return "TOC Manager" in roles or "System Manager" in roles or "Stock Manager" in roles
```

This broad read permission allows all supply chain roles to view historical buffer data without needing to configure role permissions on the DocType.

---

### `has_app_permission()`

Registered in `hooks.py → add_to_apps_screen[has_permission]`.

Controls visibility of the **Chaizup TOC tile** on the Frappe home screen.

**Allowed roles:**
- `System Manager`, `Administrator`
- `TOC Manager`, `TOC User`
- `Stock Manager`, `Stock User`
- `Purchase Manager`, `Purchase User`
- `Manufacturing Manager`, `Manufacturing User`

```python
def has_app_permission():
    roles = frappe.get_roles(frappe.session.user)
    allowed = {"System Manager", "Administrator", "TOC Manager", "TOC User",
               "Stock Manager", "Stock User", "Purchase Manager", "Purchase User",
               "Manufacturing Manager", "Manufacturing User"}
    return bool(allowed & set(roles))
```

---

## demo_data.py — Test Data

Admin-only utility for creating a complete test dataset. All documents prefixed with `TOC-DEMO-`.

### `create_demo_data()`

Creates:
- 1 demo Warehouse (`TOC-DEMO-FG Store`)
- 1 demo Customer (`TOC-DEMO Customer`)
- 7 Items (3 Manufacture/FG, 1 Manufacture/SFG sub-assembly, 2 Purchase/RM, 1 Purchase/PM) — each with TOC Setting tab configured (`custom_toc_auto_manufacture` or `custom_toc_auto_purchase`)
- 1 BOM: `FG-MASALA-1KG` → `SFG-MASALA-BLEND` + `RM-TEA-DUST` + `PM-POUCH-1KG`
- Initial Stock Entries to set realistic on-hand quantities
- Delivery Notes (3 months history) for FG ADU auto-calculation

**Expected zones after creation:**
| Item | ADU | Target | Stock | BP% | Zone |
|------|-----|--------|-------|-----|------|
| FG-MASALA-1KG | 10 | 105 | ~220 | ~68% | Red |
| FG-GINGER-500G | 6 | 63 | ~155 | ~40% | Yellow |
| FG-CARDAMOM-200G | 3 | 31 | ~145 | ~13% | Green |
| SFG-MASALA-BLEND | 6 | 81 | ~95 | ~10% | Green |
| RM-TEA-DUST | 30 | 450 | ~680 | ~45% | Yellow |
| RM-SUGAR | 100 | 1500 | ~1800 | ~18% | Green |
| PM-POUCH-1KG | 10 | 105 | ~580 | ~0% | Green |

A manifest JSON is saved to `TOC Settings.demo_data_manifest` tracking all created document names for cleanup.

### `delete_demo_data()`

Reads manifest, cancels + deletes all tracked documents in reverse dependency order (MRs → Stock Entries → DNs → WOs → BOMs → Items → Warehouse → Customer).

### `get_demo_status()`

Returns `{ "exists": bool, "count": int, "manifest": dict }`.

---

## pipeline_api.py — Supply Chain Tracker API

### `get_pipeline_data(item_code, buffer_type, zone, days_back, supplier, warehouse, show_overdue_only)`

Returns the full supply chain graph for TOC-managed items. Two views from one call:
- **Pipeline view**: `nodes` + `edges` (column/kanban layout by stage)
- **Tracker view**: `tracks` (one track per item with all linked documents)

**7 pipeline stages**: `items` → `material_request` → `rfq_pp` → `sq_wo` → `po_jc` → `receipt_qc` → `output`

**UOM standard in pipeline_api**:
- All TOC buffer data (`on_hand`, `order_qty`, `inventory_position`, `target_buffer`) come from `calculate_all_buffers()` and are in `stock_uom`.
- `Stock Entry.transfer_qty` (stock_uom) is used for `produced_qty` display — NOT `sed.qty` (transaction UOM).
- Purchase/Sales document quantities shown in pipeline UI are for display only and use document UOM (not converted).

### `get_filter_options()`

Returns `{ suppliers: [...], item_groups: [...], warehouses: [...] }` for filter dropdowns.

---

## Integration with Other Modules

```
toc_api.py calls:
  → buffer_calculator.calculate_all_buffers()   (get_priority_board, get_buffer_summary)
  → buffer_calculator.check_bom_availability()  (check_bom)
  → mr_generator.generate_material_requests()   (trigger_manual_run)

kitting_api.py calls:
  → frappe.db.sql() directly for demand/supply queries (all stock_uom fields)
  → kitting_api._walk_bom() for BOM tree (internal, not reusing buffer_calculator._walk_bom)

pipeline_api.py calls:
  → buffer_calculator.calculate_all_buffers()   (_get_toc_map — overlay TOC zone/bp on items)
  → frappe.db.sql() for pipeline document fetching
  Note: produced_qty uses sed.transfer_qty (stock_uom), NOT sed.qty (transaction UOM)

permissions.py called by:
  → hooks.py has_permission["TOC Buffer Log"]
  → hooks.py add_to_apps_screen[has_permission]
```

**Note**: `kitting_api._walk_bom()` is a separate implementation from `buffer_calculator._walk_bom()`. Both walk BOM trees but for different purposes:
- `buffer_calculator._walk_bom`: simple availability check (available/not, depth-first)
- `kitting_api._walk_bom`: full supply chain visibility (stage tracking, linked documents)
