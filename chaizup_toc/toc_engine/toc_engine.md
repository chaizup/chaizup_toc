# toc_engine — Core TOC Calculation Engine

The mathematical heart of the Chaizup TOC app. Three modules form the complete replenishment pipeline:

```
toc_engine/
├── buffer_calculator.py         ← F1–F5 formulas, IP, Zone, BOM availability
├── dbm_engine.py                ← F7/F8 Dynamic Buffer Management (weekly auto-resize)
├── mr_generator.py              ← F4 Material Request creation from buffer data
└── component_mr_generator.py   ← Post-WO component shortage Purchase MR creation
```

---

## UOM Standard

**All inventory quantities are in `stock_uom`** — the item's canonical warehouse unit (Gram, Nos, Kg, etc. as set on the Item master).

| Source Field | DocType | UOM | Notes |
|---|---|---|---|
| `Bin.actual_qty` | Bin | stock_uom | Always stock_uom |
| `Bin.ordered_qty` | Bin | stock_uom | ERPNext updates from POs automatically |
| `Bin.reserved_qty` | Bin | stock_uom | ERPNext updates from SOs automatically |
| `Work Order.qty − produced_qty` | Work Order | stock_uom | ERPNext `wo.stock_uom` is fetched from item — WO qty IS in stock_uom |
| `Work Order Item.required_qty − transferred_qty` | Work Order Item | stock_uom | Set from BOM Item.stock_qty; already in stock_uom |
| `BOM Item.stock_qty` | BOM Item | stock_uom | ERPNext auto-converts at BOM save |
| `soi.stock_qty` | Sales Order Item | stock_uom | Use this, NOT `soi.qty` (transaction UOM) |
| `soi.delivered_qty` | Sales Order Item | transaction UOM | Multiply by `soi.conversion_factor` to get stock_uom |
| `dni.stock_qty` | Delivery Note Item | stock_uom | Use this, NOT `dni.qty` |
| `sed.transfer_qty` | Stock Entry Detail | stock_uom | Use this, NOT `sed.qty` (transaction UOM) |
| `Bin.ordered_qty` | Bin | stock_uom | ERPNext populates from `poi.stock_qty` |
| `Bin.reserved_qty` | Bin | stock_uom | ERPNext populates from `soi.stock_qty` |

### UOM Conversion for Purchase MRs

`order_qty` (from buffer_calculator) is always in `stock_uom`. When creating a Purchase MR:
```python
purchase_uom = frappe.db.get_value("Item", item_code, "purchase_uom") or stock_uom
# UOM Conversion Detail.conversion_factor = stock units per 1 purchase unit
# e.g., stock_uom=Gram, purchase_uom=KG → conversion_factor=1000
mr_qty = order_qty_in_stock_uom / conversion_factor   # e.g., 5000 Gram / 1000 = 5 KG
```
The MR line always stores `stock_uom` and `conversion_factor` so ERPNext can correctly compute stock impact.

### RESTRICT — UOM Rules
- **NEVER use `soi.qty`, `dni.qty`, or `sed.qty`** for stock calculations — these are transaction UOM.
- **NEVER compare `soi.delivered_qty` directly** to `soi.stock_qty` — multiply by `conversion_factor` first.
- **NEVER hard-code `"Nos"` or `"Kg"`** as a fallback UOM — always read from Item master.
- **BOM Item.stock_qty** is already in stock_uom — do NOT apply an additional conversion factor.

---

## Universal Transaction Model

**The IP formula queries ALL transaction types for EVERY item** — no mode-based branching in the calculation path.

A Purchase-mode item that is also occasionally used as a component in Work Orders will have `committed > 0`. A Manufacture-mode item with no open WOs has `wip = 0`. Unused transaction sources return 0 and do not distort the result.

**The replenishment mode** (Manufacture / Purchase) determines only what *output document* gets created (Work Order MR vs Purchase MR) — it does NOT limit which IP components are queried.

This matters in practice:
- Items can transition from purchased to manufactured in-house (or vice versa) — IP is always correct because all sources are always summed.
- Dual-source items (sometimes bought, sometimes produced) are correctly represented.
- Never add `IF mr_type = 'Purchase' THEN skip WIP` logic — it breaks the formula.

---

## Formula Reference

| ID | Formula | Where Used | Notes |
|----|---------|-----------|-------|
| F1 | `Target = ADU × RLT × VF` | `TOCItemBuffer.calculate_target_buffer()` | Rounded to integer |
| F2 | `IP = On-Hand + WIP + On-Order − Backorders − Committed` | `get_inventory_position()` | Universal — all items, all types |
| F3 | `BP% = (Target − IP) / Target × 100` | `_calculate_single()` | 0–100+ range; >100 = Black |
| F3a | `SR% = IP / Target × 100` | `_calculate_single()` | Stock Remaining % = 100 − BP% |
| F4 | `Order Qty = max(0, Target − IP)` | `_calculate_single()` + `_create_mr()` | Never negative |
| F5 | `T/CU = (Price − TVC) × Speed` | `on_item_validate()` in overrides | Manufacture-mode items; tie-breaker |
| F6 | `Adjusted = Target × DAF` | `TOCItemBuffer.calculate_adjusted_buffer()` | 0 if DAF = 1.0 (signals "use base target") |
| F7 | `new_target = round(target × (1 + adj%))` | `dbm_engine._evaluate_single()` → TMR | Fast increase; fires after 20% of RLT in Red |
| F8 | `new_target = max(floor, round(target × (1 − adj%)))` | `dbm_engine._evaluate_single()` → TMG | Slow decrease; needs 3 full RLT cycles all-Green |

### Step-by-Step Calculation Example

```
Item: FG-MASALA-1KG  (Manufacture mode)
Warehouse: Finished Goods Store
ADU = 10 units/day  (90-day average from all SLE outflows)
RLT = 7 days        (blend + fill + QC + move)
VF  = 1.5           (moderate demand variability)
DAF = 1.6           (Diwali season uplift)

F1 Base Target  = 10 × 7 × 1.5 = 105 units
F6 Adjusted     = 105 × 1.6   = 168 units   ← effective buffer

Live stock snapshot:
  On-Hand       = 42 units  (Bin.actual_qty)
  WIP           = 18 units  (open Work Order qty − produced_qty)
  On-Order      = 0         (no open POs — manufactured in-house)
  Backorders    = 8 units   (Bin.reserved_qty — Sales Orders)
  Committed     = 5 units   (WO Item.required_qty − transferred_qty)

F2 IP = 42 + 18 + 0 − 8 − 5 = 47 units

F3 BP% = (168 − 47) / 168 × 100 = 72.0%   → RED ZONE
F3a SR% = 47 / 168 × 100 = 28.0%

F4 Order Qty = 168 − 47 = 121 units  ← Production Plan created for this qty

F5 (Manufacture mode):
  Price = ₹350, TVC = ₹120, Speed = 8 units/min
  T/CU = (350 − 120) × 8 = ₹1,840/min  ← tie-breaker if two items both at 72%
```

---

## ERPNext Data Sources (IP Components)

| TOC Concept | ERPNext DocType | Field | SQL |
|-------------|----------------|-------|-----|
| On-Hand | `tabBin` | `actual_qty` | `SUM(actual_qty) WHERE warehouse IN (Inventory warehouses)` |
| WIP supply | `tabWork Order` | `qty − produced_qty` | `WHERE production_item = X AND docstatus=1 AND status NOT IN ('Completed','Stopped','Cancelled')` |
| WIP bins | `tabBin` | `actual_qty` | `WHERE warehouse IN (WIP warehouses)` |
| On-Order | `tabBin` | `ordered_qty` | `SUM(ordered_qty) WHERE warehouse IN (Inventory+WIP)` |
| Backorders | `tabBin` | `reserved_qty` | `SUM(reserved_qty) WHERE warehouse IN (Inventory)` |
| Committed | `tabWork Order Item` JOIN `tabWork Order` | `required_qty − transferred_qty` | `WHERE wo.docstatus=1 AND status NOT IN (...) AND source_warehouse IN (Inventory)` |

**Key insight**: All 5 components are queried for **every item** regardless of replenishment mode. A Purchase-mode item that is also occasionally sold will have `backorders > 0`. A Manufacture-mode item with no open Work Orders has `wip = 0`. Unused sources return 0 and don't distort the result.

---

## buffer_calculator.py

### Zone Classification

```python
def get_zone(bp_pct, settings=None):
    bp = flt(bp_pct)
    if bp >= 100:      return "Black"   # Stockout (negative IP)
    if bp >= 67:       return "Red"     # PRODUCE/ORDER NOW
    if bp >= 33:       return "Yellow"  # Plan replenishment
    return "Green"                       # Comfortable buffer
```

Thresholds (67 / 33) come from `TOC Settings` and are configurable. Defaults are stored as fallback in `_get_settings()`.

#### Zone Action Text by Replenishment Mode

| Zone | Manufacture Action | Purchase Action |
|------|-----------|-------------|
| Green | No action | No action |
| Yellow | Plan production | Standard PO |
| Red | PRODUCE NOW | ORDER NOW + Express |
| Black | EMERGENCY | EMERGENCY — Alt supplier |

#### Jinja Helpers (Print Formats)
```python
get_zone_color("Red")   # → "#E74C3C"
get_zone_label("Red")   # → "🔴 RED"
```
Registered in `hooks.py → jinja.methods`.

---

### Inventory Position — Two Modes

#### Mode 1: Warehouse-Aware (recommended)
Activated when `TOC Settings.warehouse_rules` has entries.

```python
wh = _get_warehouse_lists(settings)
# wh = {"inventory": ["FG Store", "Branch Store"],
#        "wip":       ["Production Floor"],
#        "excluded":  ["Scrap WH", "Expiry WH"]}

on_hand    = _sum_bin_field(item, wh["inventory"], "actual_qty")
backorders = _sum_bin_field(item, wh["inventory"], "reserved_qty")
on_order   = _sum_bin_field(item, wh["inventory"] + wh["wip"], "ordered_qty")

# WIP = open Work Orders targeting Inventory+WIP warehouses
wip_from_wo = SQL(f"""
    SELECT COALESCE(SUM(qty - produced_qty), 0)
    FROM tabWork Order
    WHERE production_item = %s AND docstatus = 1
      AND status NOT IN ('Completed', 'Stopped', 'Cancelled')
      AND fg_warehouse IN ({Inventory+WIP warehouses})
""")
wip_bins = _sum_bin_field(item, wh["wip"], "actual_qty")
wip = wip_from_wo + wip_bins

# Committed = open WO Items consuming this item from Inventory warehouses
committed = SQL(f"""
    SELECT COALESCE(SUM(GREATEST(woi.required_qty - woi.transferred_qty, 0)), 0)
    FROM tabWork Order Item woi JOIN tabWork Order wo ON wo.name = woi.parent
    WHERE woi.item_code = %s AND wo.docstatus = 1
      AND wo.status NOT IN ('Completed', 'Stopped', 'Cancelled')
      AND woi.source_warehouse IN ({Inventory warehouses})
""")
```

Why `GREATEST(required_qty - transferred_qty, 0)`? Prevents negative committed from overfulfilled transfers from double-counting.

#### Mode 2: Fallback (single warehouse)
When `warehouse_rules` is empty — uses the specific warehouse from each `TOC Item Buffer` rule row. Single `Bin` lookup + global WO/WOI queries (no warehouse filtering).

```python
bin_data = frappe.db.get_value("Bin",
    {"item_code": item_code, "warehouse": warehouse},
    ["actual_qty", "ordered_qty", "reserved_qty"])
```

---

### calculate_all_buffers() — Full Scan Logic

```
1. Query all Item WHERE custom_toc_enabled=1 AND disabled=0
   (no buffer_type filter in SQL — type resolved in Python step 3)

2. For each item:
   a. Get custom_toc_buffer_type from item record
   b. If blank → call _resolve_buffer_type(item_code, item_group, settings)
      → walks TOC Settings item_group_rules table
      → walks ERPNext Item Group hierarchy if include_sub_groups=1
      → if still None: log Error "TOC Buffer Type Unresolved", SKIP item
   c. Apply buffer_type function argument filter (skip if mismatch)
   
3. Get all enabled TOC Item Buffer rows for this item
   (filter by warehouse argument if provided)

4. For each rule row → _calculate_single(item, rule, settings)
   (exceptions per rule are logged, batch continues)

5. Sort results by (-bp_pct, -tcu)
   → most urgent item at position 0
   → equal BP% items ordered by T/CU (F5 tie-breaker)
```

#### Item Group Rule Resolution Detail

```python
def _resolve_buffer_type(item_code, item_group, settings):
    # Sort rules by priority (lowest number = highest priority)
    sorted_rules = sorted(rules, key=lambda r: r.priority or 10)
    
    # Build lookup maps
    exact_map = {}      # group → buffer_type (first rule wins on tie)
    sub_group_map = {}  # group → buffer_type (for include_sub_groups=1)
    
    # Step 1: Exact match on item_group
    if item_group in exact_map: return exact_map[item_group]
    
    # Step 2: Walk up Item Group hierarchy
    parent = frappe.db.get_value("Item Group", item_group, "parent_item_group")
    while parent and parent != "All Item Groups":
        if parent in sub_group_map: return sub_group_map[parent]
        parent = frappe.db.get_value("Item Group", parent, "parent_item_group")
    
    return None  # → Error Log + skip
```

**Example hierarchy walk:**
```
Item: "Cardamom Powder"
Item Group: "Spice Blends"

Rules:
  Priority 5  → "Finished Products"    FG   include_sub_groups=1
  Priority 10 → "Raw Materials"        RM   include_sub_groups=1

Item Group tree:
  All Item Groups
  └── Finished Products
      └── Spice Blends         ← "Cardamom Powder" is here

Result: "Spice Blends" not in exact_map
  Walk: parent("Spice Blends") = "Finished Products"
  "Finished Products" in sub_group_map (include_sub_groups=1) → FG ✓
```

---

### _calculate_single() — Per Rule Calculation

```python
def _calculate_single(item, rule, settings):
    # Effective target: DAF wins if adjusted_buffer != 0
    target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
    if target <= 0: return None  # skip rules with no target set

    pos = get_inventory_position(item.name, rule.warehouse, settings)
    ip = pos["ip"]

    bp_pct = max(0, (target - ip) / target * 100)   # clamped to 0 minimum
    sr_pct = min(100, max(0, ip / target * 100))     # clamped 0–100

    zone = get_zone(bp_pct, settings)
    order_qty = max(0, target - ip)                  # never negative

    # BOM availability check — all items with a default BOM configured
    sfg_status = None
    if item.custom_toc_default_bom and item.custom_toc_check_bom_availability:
        sfg_status = check_bom_availability(item.name, order_qty, rule.warehouse)

    return {
        # Identity
        "item_code", "item_name", "stock_uom", "warehouse", "company",
        "buffer_type", "mr_type",           # "Manufacture" or "Purchase"
        # F2 components (all always present)
        "on_hand", "wip", "on_order", "backorders", "committed",
        # Convenience sums
        "wip_or_on_order",                  # supply pipeline total
        "backorders_or_committed",          # demand pipeline total
        "inventory_position",              # F2 result
        # F3
        "target_buffer", "bp_pct", "sr_pct",
        "zone", "zone_color", "zone_action",
        # F4
        "order_qty",
        # F5
        "tcu",
        # Rule metadata
        "adu", "rlt", "vf", "daf", "rule_name",
        # BOM
        "sfg_item", "sfg_status",
    }
```

---

### Real-Time Alert Pipeline

```
Stock transaction committed
    └─► Stock Ledger Entry (after_insert)
            └─► on_stock_movement(doc, method)
                    ├─ if NOT TOC item → return
                    └─ frappe.enqueue("check_realtime_alert",
                                      queue="short",
                                      enqueue_after_commit=True)

Background worker (short queue):
    check_realtime_alert(item_code, warehouse)
        ├─ calculate_all_buffers(item_code=..., warehouse=...)
        └─ for each result with zone in ("Red", "Black"):
               frappe.publish_realtime("toc_buffer_alert", {
                   item_code, item_name, zone, bp_pct, order_qty, warehouse
               })

Browser (desk_branding.js):
    frappe.realtime.on("toc_buffer_alert", handler)
        └─ frappe.show_alert(`🔴 ${item_name} in ${zone} — BP: ${bp_pct}%`, 10s)
```

**Why `enqueue_after_commit=True`?** Ensures the SLE's DB transaction is committed before the background job reads `Bin.actual_qty`. Without this, the job might read the pre-transaction stock.

**Doc event triggers for realtime alerts:**

| Source DocType | Event | Items Checked |
|---------------|-------|---------------|
| Stock Ledger Entry | after_insert | `doc.item_code` |
| Sales Order | on_submit, on_cancel | All `doc.items` where `custom_toc_enabled=1` |
| Work Order | on_submit, on_cancel, on_update_after_submit | `doc.production_item` |
| Purchase Order | on_submit, on_cancel | All `doc.items` |

---

### BOM Availability Check (R3)

```python
def check_bom_availability(item_code, required_qty, warehouse=None):
    bom_name = frappe.db.get_value("Item", item_code, "custom_toc_default_bom")
    check_enabled = frappe.db.get_value("Item", item_code, "custom_toc_check_bom_availability")
    
    if not bom_name or not check_enabled:
        return {"available": True, "message": "No BOM check configured"}
    
    components = []
    _walk_bom(bom_name, required_qty, multiplier=1.0, warehouse, components, depth=0, max_depth=5)
    shortfalls = [c for c in components if not c["available"]]
    
    return {
        "available": len(shortfalls) == 0,
        "total_components": len(components),
        "shortfalls": len(shortfalls),
        "components": [...],
        "message": f"{len(shortfalls)} component(s) short"
    }
```

**Recursive BOM Walk (`_walk_bom`):**
- Fetches `BOM Item` rows for the BOM
- `required = stock_qty × multiplier × parent_qty` — accumulates through levels
- Checks `Bin.actual_qty` (by warehouse or SUM all warehouses)
- If component is SFG with its own BOM → recurses (depth+1)
- max_depth=5 prevents infinite recursion from circular BOMs

**Example multi-level check:**
```
FG-MASALA-1KG BOM:
  SFG-MASALA-BLEND (0.6kg) → has its own BOM:
      RM-TEA-DUST (0.3kg)
      RM-GINGER-PWD (0.2kg)
      RM-CARDAMOM (0.1kg)
  PM-POUCH-1KG (1 each)
  PM-CARTON-24 (0.042 each)

For order_qty=50:
  SFG-MASALA-BLEND needed: 50 × 0.6 = 30 kg
      RM-TEA-DUST:     30 × 0.3 = 9 kg  (in stock: 12 → available ✓)
      RM-GINGER-PWD:   30 × 0.2 = 6 kg  (in stock: 4  → SHORT by 2 kg ✗)
      RM-CARDAMOM:     30 × 0.1 = 3 kg  (in stock: 5  → available ✓)
  PM-POUCH-1KG:   50 × 1 = 50  (in stock: 200 → available ✓)
  PM-CARTON-24:   50 × 0.042 = 2.1 → ceil → 3 (in stock: 10 → available ✓)

Result: 1 shortfall (RM-GINGER-PWD), available=False, message="1 component(s) short"
```

---

## dbm_engine.py — Dynamic Buffer Management

### Theory
DBM auto-sizes buffers based on observed zone behavior. The key principle: **buffers should grow fast when too small (stockout risk >> holding cost) and shrink slowly when too large (conservatism)**.

### F7 — Too Much Red (TMR)

```
Observation window: last 1 RLT worth of daily buffer logs
Red threshold: RLT × tmr_red_pct_of_rlt / 100    (default: 20% of 1 RLT)

Example: RLT=7, threshold = 7 × 0.20 = 1.4 days
  If red_days > 1.4 (i.e., ≥ 2 days red in last 7 log entries):
    new_target = round(target × 1.33)   # 33% increase
    tmr_count += 1
    tmg_green_days = 0
    last_dbm_date = today()
```

**Safeguard**: If `tmr_count >= max_tmr_consecutive (3)`:
- Write Error Log: "TMR SAFEGUARD: {item}/{warehouse} — 3 consecutive increases. Manual review needed."
- Return None (block further inflation)
- Human intervention required: investigate demand spike vs supply failure

### F8 — Too Much Green (TMG)

```
Observation window: last (RLT × tmg_cycles_required) days (default: 3 × RLT)
Condition: ALL days in window must be Green

Example: RLT=7, tmg_cycles=3 → window = 21 days
  Need: all 21 log entries = Green
  If met:
    new_target = max(min_buffer_floor=50, round(target × 0.67))   # 33% decrease
    tmr_count = 0
    tmg_green_days = 0
    last_dbm_date = today()
```

**Asymmetry rationale:**
- TMR: fires if >20% of 1 RLT is Red → ~1-2 days triggers increase
- TMG: requires 100% of 3 RLTs as Green → ~21 days before decrease
- This is intentional: avoid premature buffer reduction that creates stockouts

### evaluate_all_dbm() Flow

```
1. Check TOC Settings.enable_dbm — skip entirely if disabled
2. For each enabled Item with custom_toc_enabled=1:
   For each enabled TOC Item Buffer rule:
     a. Calculate RLT and effective target
     b. Fetch TOC Buffer Log entries for look-back window
     c. Check TMR: count Red/Black days in last 1 RLT
     d. If TMR triggers → update rule, return "TMR"
     e. Else check TMG: count Green days in last N×RLT
     f. If TMG triggers → update rule, return "TMG"
3. frappe.db.commit() — single commit after all evaluations
4. Log summary: "DBM Weekly: X TMR, Y TMG, Z items evaluated"
```

---

## mr_generator.py — Material Request Creation

### generate_material_requests() Flow

```
1. Check TOC Settings.auto_generate_mr → return [] if disabled

2. buffers = calculate_all_buffers(company)
   → sorted by BP% desc, T/CU desc
   Note: buffer_type param kept for backward compat but silently ignored

3. zone_filter from settings:
   "Red and Black Only" → ["Red", "Black"]
   default             → ["Red", "Black", "Yellow"]

4. actionable = [b for b in buffers if b["zone"] in zone_filter and b["order_qty"] > 0]

5. For each item in actionable:
   a. _has_open_mr(item_code, warehouse, mr_type) → skip if True
   b. Log SFG shortfall warning (non-blocking — MR still created)
   c. _create_mr(data, settings) → insert MR, get mr_name
   d. _log_snapshot(data, mr_name) → insert TOC Buffer Log record
   e. Append mr_name to created_mrs list

6. frappe.db.commit()

7. if notify_on_red: _send_alerts(Red/Black items, created_mrs, settings)

8. Log: "TOC MR Generation: N created, M errors, K skipped"
9. return created_mrs
```

### _has_open_mr() — Deduplication Check

```sql
SELECT mr.name FROM `tabMaterial Request` mr
JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
WHERE mr.docstatus < 2                      -- draft or submitted (not cancelled)
AND mr.material_request_type = 'Manufacture'  -- or 'Purchase'
AND mr.status NOT IN ('Stopped', 'Cancelled')
AND mri.item_code = 'FG-MASALA-1KG'
AND mri.warehouse = 'Finished Goods Store'
LIMIT 1
```

Returns truthy if any open MR exists → item skipped to avoid duplicate MRs.

### _create_mr() — MR Document Structure

UOM handling: `order_qty` from buffer_calculator is always in `stock_uom`. For Purchase MRs,
the function looks up `Item.purchase_uom` and `UOM Conversion Detail.conversion_factor`,
then divides `order_qty` by the factor so the MR shows supplier-friendly units (e.g., KG
instead of Gram). ERPNext MR validation recomputes `stock_qty = qty × conversion_factor`.

```python
# UOM resolution for Purchase MRs
purchase_uom = frappe.db.get_value("Item", item_code, "purchase_uom") or stock_uom
# UOM Conversion Detail: conversion_factor = stock units per 1 purchase unit
# e.g., stock_uom=Gram, purchase_uom=KG → conversion_factor=1000
# mr_qty = order_qty (in Gram) / 1000 → qty in KG on the MR

mr.material_request_type = "Purchase"  # (or "Manufacture" for Manufacture-mode items)
mr.transaction_date = today()
mr.company = frappe.db.get_value("Warehouse", warehouse, "company")
mr.schedule_date = add_days(today(), max(1, int(rlt)))  # delivery expected date

# TOC metadata — recorded at MR creation time for auditability
mr.custom_toc_recorded_by = "By System"
mr.custom_toc_zone = "Red"
mr.custom_toc_bp_pct = 72.0
mr.custom_toc_target_buffer = 168
mr.custom_toc_inventory_position = 47
mr.custom_toc_sr_pct = 28.0

# Item row — one per MR (one item per MR for traceability)
mr.append("items", {
    "item_code": "RM-SALT-BULK",
    "qty": 5,                      # 5 KG (= 5000 Gram / 1000 conversion_factor)
    "uom": "KG",                   # purchase_uom — supplier-friendly unit
    "stock_uom": "Gram",           # stock_uom — warehouse unit
    "conversion_factor": 1000,     # ERPNext recomputes: stock_qty = 5 × 1000 = 5000 Gram
    "description": "TOC Replenishment | Zone: Red | BP: 72.0% | "
                   "Target: 168 | IP: 47 | Formula: F4 Order Qty = 168 − 47 = 121 Gram"
})

mr.flags.ignore_permissions = True   # scheduler runs as Administrator
mr.insert()                          # NOT submitted — stays as Draft for review
```

**Design decision**: MRs are inserted as **Draft** (docstatus=0). The production planner reviews and submits them, then converts to Purchase Orders. TOC does not auto-submit.

**UOM rule summary:**
- Manufacture-mode: `order_qty` used directly in `stock_uom` (Production Plans always use stock UOM)
- Purchase-mode: `order_qty` divided by `conversion_factor`; MR line shows `purchase_uom`

### Email Alert — _send_alerts()

Sends to all users whose roles are in `TOC Settings.red_alert_roles` (newline-separated):

```python
# Role → User email resolution
for role in ["Stock Manager", "Purchase Manager"]:
    users = frappe.get_all("Has Role",
        filters={"role": role, "parenttype": "User"},
        fields=["parent"], limit=20)
    recipients.update(u.parent for u in users if valid_email(u.parent))

frappe.sendmail(
    recipients=list(recipients),
    subject=f"🔴 TOC Alert: {len(red_items)} items in Red/Black — {today()}",
    message=HTML_TABLE_with_zone_colors
)
```

---

## Integration Map

```
Daily Schedule:
  06:30 daily_adu_update()          → writes Item.custom_toc_adu_value
  07:00 daily_production_run()      → calls generate_material_requests()
                                         → creates Material Request (Draft)
                                         → creates TOC Buffer Log
                                         → sends email alerts
  07:30 daily_procurement_run()     → calculate_all_buffers() → log warning (Purchase-mode items)
  08:00 daily_buffer_snapshot()     → creates TOC Buffer Log (all types)
  08:00 Sun weekly_dbm_check()      → evaluate_all_dbm() → updates TOC Item Buffer

Real-Time:
  Any stock transaction             → on_stock_movement → check_realtime_alert
  Sales Order submit/cancel         → on_demand_change → check_realtime_alert
  Work Order events                 → on_supply_change → check_realtime_alert
  Purchase Order events             → on_supply_change → check_realtime_alert
                                         → publish_realtime("toc_buffer_alert")

On-Demand (API):
  get_priority_board()              → calculate_all_buffers()
  trigger_manual_run()              → generate_material_requests()
  apply_global_daf()                → update all TOC Item Buffer.daf fields
  check_bom()                       → check_bom_availability()
```

---

## Use Cases

| Scenario | Function | What Happens |
|----------|----------|-------------|
| Morning operations review | `daily_production_run()` | MRs created for Red/Yellow; email sent |
| Diwali season prep | `apply_global_daf(1.6, "Diwali 2026")` | All targets × 1.6; adjusted_buffer updated |
| GRN posted (RM received) | `on_stock_movement` → `check_realtime_alert` | Real-time browser alert if still Red |
| Large SO submitted | `on_demand_change` | FG buffer checked; browser alert if Red |
| Item stuck Red 3 weeks | Sunday DBM → F7 TMR | Target grows 33%; tmr_count=1 |
| TMR fires 3 times in a row | DBM safeguard | Error Log written; further inflation blocked |
| Item Green for 3 RLTs | Sunday DBM → F8 TMG | Target shrinks 33%; saves holding cost |
| Component short on BOM | `check_bom_availability` | MR still created; sfg_status shows shortfall |
| Duplicate MR prevention | `_has_open_mr` | Second MR not created; existing MR reused |
| Item stock_uom=Gram, purchase_uom=KG | `_create_mr` | MR qty in KG with conversion_factor=1000 |

---

## Performance Notes

- `calculate_all_buffers()` runs N×M SQL queries where N=items, M=rules. For 100 items × 2 warehouses = ~600 queries.
- `_sum_bin_field` batches the warehouse list into one SQL with IN clause — reduces queries significantly vs per-warehouse lookup.
- `frappe.get_cached_doc("TOC Settings")` — cached in memory; no DB hit per item. Changes take effect after `bench clear-cache` or server restart.
- Background jobs (`enqueue_after_commit=True`) run asynchronously — real-time alerts don't block the transaction.
- Weekly DBM: single `frappe.db.commit()` at the end — all `set_value` calls accumulate and commit together.

---

## Production Plan Column Guards (mr_generator.py + production_plan_engine.py)

Two dynamically-created columns require runtime guards before querying:

### `tabProduction Plan.custom_projection_reference`

Defined in `chaizup_toc/fixtures/custom_field.json`. Only exists after fixtures are imported.

| File | Function | Guard |
|------|----------|-------|
| `mr_generator.py` | `_has_open_pp()` | `_pp_has_custom_ref_column()` with `_pp_custom_ref_column_cache` |
| `production_plan_engine.py` | `_pp_exists_for_item()` | — (assumes fixtures applied; documents fix procedure) |

Without this guard: `OperationalError: (1054, "Unknown column 'pp.custom_projection_reference' in 'WHERE'")`

**Fallback behaviour** when column missing:
- `_has_open_pp` falls back to matching ANY non-cancelled PP for item+warehouse (conservative dedup — may over-block but never crashes)

**To apply fixtures** (required on first deploy):
```python
# bench console
import frappe.utils.fixtures
frappe.utils.fixtures.sync_fixtures(app='chaizup_toc')
frappe.db.commit()
# If sync_fixtures fails silently, insert manually — see production_plan_engine.md
```

### `tabSales Order.workflow_state`

Frappe only adds this column when a Workflow is assigned to the Sales Order DocType.

| File | Function | Guard |
|------|----------|-------|
| `production_plan_engine.py` | `_so_conditions_and_params()` | `_so_has_workflow_column()` with `_so_workflow_column_cache` |

Without this guard: `OperationalError: (1054, "Unknown column 'so.workflow_state' in 'WHERE'")`

**Behaviour when column missing**: PATH A (draft SOs with workflow states) is skipped entirely. Only PATH B (submitted SOs in pending statuses) runs.

### General Rule for Dynamic Columns

Always use `frappe.db.has_column(doctype, fieldname)` before querying a column that:
- Is a Frappe workflow column (`workflow_state`, `workflow_state_before_workflow`)
- Is a Custom Field (may not be installed on all sites)
- Is added by an app's fixtures (installed lazily)

Cache the result at module level in a `_xxx_column_cache = None` variable to avoid repeated `INFORMATION_SCHEMA` lookups.

---

## DANGER ZONE (mr_generator.py)

| Risk | Detail |
|------|--------|
| `custom_projection_reference` column | Only exists after fixtures imported. `_has_open_pp` guards with `_pp_has_custom_ref_column()`. DO NOT remove guard. |
| `_pp_custom_ref_column_cache` | Module-level cache. Fixtures imported mid-session won't be reflected until worker restarts. Acceptable. |
| `frappe.sendmail` in `_send_alerts` | Already uses queue mode (no `now=True`). Wrapped in try/except. Safe. |
| `buffer_type` param in `generate_material_requests` | Kept for backward compat — silently ignored. DO NOT pass to `calculate_all_buffers`. |
| `frappe.db.commit()` in `_create_buffer_production_plan` | Called after PP insert AND after WO creation. Both required. Do NOT remove. |

## RESTRICT (mr_generator.py)

- Do NOT remove `_pp_has_custom_ref_column()` guard from `_has_open_pp`.
- Do NOT collapse the two `_has_open_pp` SQL branches into one query that always references `custom_projection_reference`.
- Do NOT pass `buffer_type` to `calculate_all_buffers` — parameter was removed in refactor.
- Do NOT use `stock_uom` directly for Purchase MR `uom` field — must use `purchase_uom` with `conversion_factor`.
- Do NOT skip `_log_snapshot` — required for DBM trend analysis.

---

## component_mr_generator.py — Post-WO Component Shortage MRs

**Full documentation**: `component_mr_generator.md` (same folder)

### Summary

Called as **Step 7** in `production_plan_engine._submit_pp_and_create_work_orders()` after WOs are created. Creates Purchase MRs for BOM components that are short, specifically for items with `custom_toc_auto_purchase = 1`.

### Min Order Qty Floor

Both `component_mr_generator` and `mr_generator` apply this floor for Purchase MRs:

```python
order_qty = max(shortage_in_stock_uom, min_order_qty_in_stock_uom)
```

The floor is read from the `Item Min Order Qty` child table on Item Master (custom field `custom_min_order_qty`, Table → `Item Min Order Qty`). Each row has: warehouse, uom, min_order_qty (user input), stock_uom (read-only), conversion_factor (read-only), stock_uom_qty (computed = min_order_qty × cf).

**`build_min_order_map(item_codes)`** is a public function in `component_mr_generator.py` — imported by `mr_generator.py` so both engines share the same min-order floor logic.

### Item Min Order Qty DocType

| Field | Type | Auto-populated? |
|---|---|---|
| `warehouse` | Link/Warehouse | No — user input |
| `uom` | Link/UOM | No — user input |
| `min_order_qty` | Float | No — user input |
| `stock_uom` | Data | Yes — from Item.stock_uom |
| `conversion_factor` | Float | Yes — from UOM Conversion Detail |
| `stock_uom_qty` | Float | Yes — `min_order_qty × conversion_factor` |

**RESTRICT**: `custom_min_order_qty` parentfield name must not change — hardcoded in `build_min_order_map()`.

### TOC Settings Toggle

`auto_create_component_mrs` (Check, default ON) — disabling this skips Step 7 entirely.

### RESTRICT (component_mr_generator.py)

- Do NOT call `frappe.db.commit()` — caller owns the transaction.
- Do NOT create MRs for `custom_toc_auto_manufacture = 1` items — they are manufactured via WOs already created by the PP.
- Do NOT move Step 7 before Step 5 — WOs must exist before querying `tabWork Order Item`.
