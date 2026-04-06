# toc_warehouse_rule — TOC Warehouse Rule DocType (Child Table)

Classifies every warehouse in the company as **Inventory**, **WIP**, or **Excluded** for TOC buffer calculations. This classification directly determines which stock counts in the F2 Inventory Position formula.

`istable: 1` — child table, not a standalone document. Parent: `TOC Settings`, field: `warehouse_rules`.

---

## Why This Exists

ERPNext companies typically have multiple warehouses for different purposes:
- Main stock store (usable stock)
- Production floor store (material in process)
- QC Hold warehouse (stock pending clearance)
- Scrap/Expiry warehouse (unusable stock)
- Demo/Marketing warehouse (not for sale)

Without warehouse classification, `calculate_all_buffers()` would include ALL stock in F2 — including scrap, expired goods, and quarantined stock. This would artificially inflate the Inventory Position and make buffers appear healthier than they are.

**Correct behavior:**
```
F2 = Inventory stock + WIP stock − demand
     ↑ not: expired + scrap + QC Hold + everything else
```

---

## Fields

| Fieldname | Type | Required | Description |
|-----------|------|----------|-------------|
| `warehouse` | Link → Warehouse | ✓ | The warehouse to classify |
| `company` | Data | read_only | Auto-fetched from the Warehouse record |
| `warehouse_purpose` | Select | ✓ | **Inventory** / **WIP** / **Excluded** |
| `notes` | Small Text | — | Optional label (e.g., "Post-QC scrap from VFFS Line 1") |

---

## Purpose Values — Detailed Semantics

### Inventory

**Definition**: Usable, quality-cleared physical stock ready for sale or production.

**How it enters F2:**
```
F2a (FG/SFG): on_hand = SUM(Bin.actual_qty WHERE warehouse IN Inventory warehouses)
              backorders = SUM(Bin.reserved_qty WHERE warehouse IN Inventory warehouses)

F2b (RM/PM):  on_hand = SUM(Bin.actual_qty WHERE warehouse IN Inventory warehouses)
              committed = SUM(Bin.reserved_qty WHERE warehouse IN Inventory warehouses)
```

**Examples**: Main Finished Goods Store, Branch Dispatch Store, Raw Material Store, Primary RM Warehouse.

**Configure as Inventory**: Any warehouse where stock is ready to use without further processing or clearance.

### WIP

**Definition**: Stock physically in-process. Counts toward the supply pipeline (adds to IP) but is not available as finished product yet.

**How it enters F2:**
```
F2a (FG/SFG): wip = SUM(Bin.actual_qty WHERE warehouse IN WIP warehouses)
                  + SUM(open Work Order.pending_qty WHERE fg_warehouse IN Inventory+WIP)

F2b (RM/PM):  on_order includes Bin.ordered_qty from WIP warehouses
              (i.e., POs targeting a WIP warehouse are counted as On-Order)
```

**Examples**: Production Floor Store, Blending WIP Warehouse, Staging Area, QC In-Progress.

**Configure as WIP**: Use when ERPNext Work Orders move stock to a WIP warehouse during production, and you want that in-process stock to count toward IP (reducing urgency).

**When to leave blank**: If your company runs production without a dedicated WIP warehouse (common in small operations), leave WIP empty. Work Orders open against Inventory warehouses will still count as WIP through the Work Order query path.

### Excluded

**Definition**: Stock that should never appear in any buffer calculation.

**How it enters F2**: It doesn't. Excluded warehouses are completely invisible to `calculate_all_buffers()`.

**Examples:**
- Scrap Warehouse (damaged/defective material)
- Expiry/Dead Stock (past shelf life)
- QC Hold / Quarantine (pending test results — may be returned to stock or scrapped)
- Demo / Marketing (reserved for non-sale purposes)
- Transit Warehouse (stock between locations — count only when received)
- Customer Consignment (belongs to customer, not the company)

**Why QC Hold is Excluded** (not Inventory): QC hold stock might fail inspection and be scrapped. Counting it as on-hand would make buffers appear healthier than they are, delaying replenishment. Only count it after QC clearance moves it to an Inventory warehouse.

---

## How Classification Affects Calculations — Full Example

**Setup:**
```
FG Store           → Inventory
Production Floor   → WIP
QC Hold            → Excluded
Scrap Warehouse    → Excluded
```

**Bin data for FG-MASALA-1KG:**
```
Warehouse          actual_qty   reserved_qty
FG Store           42           8    (reserved for 2 SOs)
Production Floor   18           0    (WIP batch in process)
QC Hold            15           0    (pending quality test)
Scrap Warehouse    7            0    (rejected from last batch)
```

**Open Work Order:**
```
WO-001: producing 30 units of FG-MASALA-1KG, fg_warehouse=FG Store
        produced_qty=18 (already transferred to Production Floor)
        pending_qty = 30 - 18 = 12 units
```

**F2a Calculation (warehouse-aware mode):**
```
on_hand     = 42          (FG Store — Inventory)
wip         = 18          (Production Floor — WIP bin) 
            + 12          (WO-001 pending qty, fg_warehouse=FG Store is Inventory/WIP)
            = 30
backorders  = 8           (FG Store — Inventory reserved_qty)
NOT counted = 15 + 7 = 22 (QC Hold + Scrap — Excluded)

IP = 42 + 30 − 8 = 64
```

**Without warehouse classification (fallback mode):**
```
on_hand     = 42 + 18 + 15 + 7 = 82   (all warehouses summed)
backorders  = 8
IP = 82 + 12 − 8 = 86                  (artificially inflated by QC + Scrap)
```

The difference: IP of 64 (correct) vs 86 (wrong). With Target=168, that's BP% of 61.9% (Yellow) vs 48.8% (Yellow but lower urgency). If QC Hold passes and gets transferred to FG Store, the correct IP would rise to 79. If it fails and is scrapped, the correct IP stays at 64.

---

## Fallback Mode — When No Rules Are Configured

If `warehouse_rules` table is empty, `buffer_calculator._get_warehouse_lists()` returns empty sets, and `_calculate_single()` falls back to single-warehouse mode:

```python
if not inv_warehouses:
    # Fallback: read from the specific warehouse in the TOC Item Buffer rule
    actual_qty = frappe.db.get_value("Bin",
        {"item_code": item_code, "warehouse": rule.warehouse},
        "actual_qty") or 0
    ...
```

This backward-compatible fallback ensures items with warehouse-specific rules still work even without global warehouse classification.

**Limitation of fallback**: No WIP consolidation, no multi-warehouse aggregation, and crucially — no exclusion of scrap/expiry warehouses. Stock in all warehouses for that specific item+warehouse combination is read.

---

## Validation in toc_settings.py

```python
def _validate_warehouse_rules(self):
    seen = set()
    has_inventory = False
    
    for row in (self.warehouse_rules or []):
        if row.warehouse in seen:
            frappe.throw(f"Warehouse '{row.warehouse}' appears more than once in rules.")
        seen.add(row.warehouse)
        
        if row.warehouse_purpose == "Inventory":
            has_inventory = True
    
    if self.warehouse_rules and not has_inventory:
        frappe.msgprint(
            "No warehouse is classified as 'Inventory'. "
            "On-hand quantities will show as 0 for all items.",
            indicator="orange", alert=True
        )
    
    if not self.warehouse_rules:
        frappe.msgprint(
            "Warehouse Rules is empty. Using single-warehouse fallback mode. "
            "Scrap and expiry stock will not be excluded.",
            indicator="orange", alert=True
        )
```

Duplicate warehouse: **throws** (blocking error). No Inventory warehouse: **warns** (non-blocking).

---

## Setup Order

Configure warehouse rules **before** enabling any items for TOC:

```
1. Open TOC Settings
2. In Warehouse Rules table, add every warehouse:
   - Classify usable stock warehouses as "Inventory"
   - Classify production staging areas as "WIP"
   - Classify scrap, expiry, QC Hold as "Excluded"
3. Save TOC Settings
4. Enable custom_toc_enabled=1 on test items
5. Open Production Priority Board — verify IP values match expectations
6. Compare against manual calculation: FG Store actual_qty + WIP - backorders
```

---

## Accessing Rules in Python

```python
settings = frappe.get_cached_doc("TOC Settings")

inventory_warehouses = set()
wip_warehouses = set()
excluded_warehouses = set()

for row in (settings.warehouse_rules or []):
    if row.warehouse_purpose == "Inventory":
        inventory_warehouses.add(row.warehouse)
    elif row.warehouse_purpose == "WIP":
        wip_warehouses.add(row.warehouse)
    else:  # Excluded
        excluded_warehouses.add(row.warehouse)
```

This is exactly what `buffer_calculator._get_warehouse_lists()` does.

---

## Common Configuration Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| QC Hold classified as Inventory | IP inflated; Red items appear Yellow | Reclassify QC Hold → Excluded |
| No warehouses in table | All items use single-warehouse fallback; Scrap counted | Add all warehouses |
| Production floor not added | WIP stock not counted; items appear more urgent than they are | Add Production Floor → WIP |
| Same warehouse twice | Save throws validation error | Remove duplicate |
| Transit warehouse as Inventory | Stock in transit counted as available | Classify Transit → Excluded or WIP |
