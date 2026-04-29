# component_mr_generator.py — Post-WO Component Shortage Purchase MR Engine (v2)

## Purpose

After a Production Plan is auto-submitted and Work Orders are created (Step 5 in `production_plan_engine._submit_pp_and_create_work_orders`), this module is invoked as **Step 7** to:

1. Aggregate ALL component requirements across the full multi-level BOM (all WOs of the PP)
2. Compare against current on-hand inventory (`Bin.actual_qty`) AND already-on-order qty (`Bin.ordered_qty`)
3. Classify items: auto_purchase items AND raw leaf-node items (no active BOM, not auto_manufacture)
4. Apply a **minimum order quantity floor**: `order_qty = max(shortage, min_order_qty_in_stock_uom)`
5. Create **ONE Purchase Material Request per warehouse** (all shortage items for that warehouse grouped into one MR)
6. Send email summary to TOC Engine notification users

---

## Why This Exists

The daily buffer engine (07:00 AM `daily_production_run`) creates Purchase MRs for Raw Material / Packaging buffers based on buffer zone analysis. But it runs ONCE per day and may not react immediately to a new Production Plan created at 02:00 AM.

This module provides **instant purchase coverage**: the moment WOs are created from a PP, the components' shelf-level shortages are checked and Purchase MRs are raised immediately. This eliminates the 5-hour gap between PP creation (02:00 AM) and buffer engine run (07:00 AM).

---

## Flow Diagram

```
_submit_pp_and_create_work_orders(pp_name)
  │
  ├── Step 5: pp_doc.make_work_order()        ← WOs created
  ├── Step 6: _stamp_toc_fields_on_work_orders
  └── Step 7: create_component_shortage_mrs(pp_name, company)  ← THIS MODULE
        │
        ├── 1. Get all submitted WOs for pp_name
        │
        ├── 2. SQL: GROUP BY item_code + source_warehouse
        │         SUM(required_qty - transferred_qty) = net_required
        │         (covers FULL multi-level BOM automatically via all WOs)
        │
        ├── 3. _classify_items(item_codes)
        │         "purchase"  → custom_toc_auto_purchase = 1
        │         "leaf"      → no active BOM AND not auto_manufacture
        │         "skip"      → auto_manufacture = 1 or has BOM with no auto flags
        │
        ├── 4. build_min_order_map(purchasable_codes)
        │         reads Item Min Order Qty child table
        │         returns {(item_code, warehouse): min_qty_in_stock_uom}
        │
        ├── 5. For each component:
        │     actual_qty  = Bin.actual_qty   (on-hand stock, stock_uom)
        │     ordered_qty = Bin.ordered_qty  (already on open POs, stock_uom)
        │     shortage = max(0, net_required - actual_qty - ordered_qty)
        │     if shortage <= 0: skip
        │     order_qty = max(shortage, min_order_map.get((item, wh), 0))
        │     if _has_open_component_mr: mark skipped, continue
        │     add to warehouse_batches[warehouse] list
        │
        ├── 6. For each warehouse group:
        │     _create_warehouse_batch_mr(items, warehouse, company, pp_name)
        │     → ONE MR with N line items (all shortage items for this warehouse)
        │
        ├── 7. _send_component_mr_summary(pp_name, created_mrs, skipped, no_min_qty)
        │     → email to toc_engine_notification_users with notify_on_component_mrs = 1
        │
        └── Return: list of created MR names (one per warehouse)
```

---

## Item Min Order Qty Child Table

Custom child table on Item Master. Added via `custom_min_order_qty` custom field (Table).

| Field | Type | Description |
|---|---|---|
| `warehouse` | Link/Warehouse | Warehouse this rule applies to |
| `uom` | Link/UOM | UOM in which the minimum is specified |
| `min_order_qty` | Float | Minimum purchase qty in UOM |
| `stock_uom` | Data (read-only) | Auto-populated from Item stock_uom |
| `conversion_factor` | Float (read-only) | 1 [UOM] = [cf] [stock_uom] |
| `stock_uom_qty` | Float (read-only) | `min_order_qty × conversion_factor` — effective floor in stock_uom |

**Controller** (`item_min_order_qty.py`): On every row validate(), `stock_uom`, `conversion_factor`, and `stock_uom_qty` are auto-populated from the parent Item.

**JS Client-side** (`item_toc.js`): On UOM change → auto-populates `conversion_factor` and `stock_uom_qty`. On `min_order_qty` change → recomputes `stock_uom_qty`. UOM list filtered to only show UOMs configured in the item's "Units of Measure" section. Row creation blocked if item is not yet saved.

---

## Min Order Qty Floor Logic

### 1. Post-WO Component Shortage MRs (`create_component_shortage_mrs`)
```python
actual_qty  = Bin.actual_qty     # on-hand stock
ordered_qty = Bin.ordered_qty    # already on open POs
shortage    = max(0, net_required - actual_qty - ordered_qty)
min_qty     = min_order_map.get((item, wh), 0.0)
order_qty   = max(shortage, min_qty)
```

### 2. Buffer-Triggered Purchase MRs (`mr_generator.generate_material_requests`)
```python
buffer_qty  = item_data["order_qty"]   # target_buffer - IP, stock_uom
min_qty     = min_order_map.get((item, wh), 0.0)
if min_qty > 0 and buffer_qty < min_qty:
    item_data["order_qty"] = min_qty   # floor applied before _create_mr()
```

**Rule**: `order_qty = max(shortage, min_order_qty)` — quantity is ALWAYS at least the configured minimum.

---

## Leaf Node Detection

Items in the WO's BOM tree that have NEITHER `custom_toc_auto_purchase = 1` nor `custom_toc_auto_manufacture = 1`, AND have no active default BOM of their own, are classified as **leaf nodes** and included in the purchase MR batch.

This covers raw materials that a company may have forgotten to flag as `auto_purchase`, preventing them from falling through the cracks.

```python
# In _classify_items():
if not auto_manufacture and not auto_purchase and code not in items_with_active_bom:
    classification = "leaf"   # → included in purchase batch
```

---

## Ordered Qty Subtraction

`Bin.ordered_qty` (quantity already on open Purchase Orders) is subtracted from the shortage calculation:

```python
shortage = max(0, net_required - actual_qty - ordered_qty)
```

This prevents over-ordering: if 100 units are needed, 30 are in stock, and 50 are already on an open PO, only 20 additional units are ordered.

---

## Warehouse-Grouped MRs

Instead of one MR per item, **one MR per warehouse** is created with all shortage items as line items:

- Better purchasing workflow: one MR → one PO per warehouse/supplier
- Dedup is still per-item: items that already have an open MR are excluded from the batch; remaining items proceed into the MR

---

## Dedup Strategy

`_has_open_component_mr(item_code, warehouse)` — checks for any open, non-stopped, non-cancelled Purchase MR for the item+warehouse. If found, that specific item is excluded from the warehouse batch (other items in the same warehouse still proceed).

---

## Email Summary

After MR creation, an HTML email is sent to `TOC Settings → toc_engine_notification_users` where `notify_on_component_mrs = 1`. The email contains three sections:

| Section | Content |
|---|---|
| ✅ MRs Created | One row per warehouse MR name |
| ⏭ Items Skipped | Items excluded because an open MR already existed |
| ⚠️ Items Without Min Order Qty | Items where MR was created at raw shortage qty without floor |

---

## Public API

```python
from chaizup_toc.toc_engine.component_mr_generator import (
    create_component_shortage_mrs,  # main entry — call after WO creation
    build_min_order_map,            # {(item_code, warehouse): min_qty_in_stock_uom}
)
```

`build_min_order_map(item_codes)` is also imported by `mr_generator.py` for the buffer-triggered purchase MR floor.

---

## TOC Settings Toggles

| Setting | Default | Effect |
|---|---|---|
| `auto_create_component_mrs` | ON | When OFF, Step 7 is entirely skipped |
| `toc_engine_notification_users` | (empty) | Add users to receive component MR email summaries |

---

## UOM Standard

| Quantity | UOM |
|---|---|
| WO Item `required_qty` / `transferred_qty` | stock_uom |
| `Bin.actual_qty` / `Bin.ordered_qty` | stock_uom |
| `Item Min Order Qty.stock_uom_qty` | stock_uom (pre-computed) |
| Purchase MR qty | purchase_uom (order_qty / conversion_factor) |

---

## Multi-Level BOM Coverage

`pp_doc.make_work_order()` creates WOs for every BOM level. By querying `tabWork Order Item WHERE parent IN (all WOs of PP)`, the component aggregation automatically covers all BOM levels without additional recursion.

---

## What Is NOT Created Here

- MRs for items with `custom_toc_auto_manufacture = 1` — they are manufactured; WOs already created
- MRs for items with an active BOM but no auto flags — manual handling required
- MRs for WO items with `source_warehouse = NULL` — no destination warehouse, silently skipped

---

## DANGER ZONE

- WO items with NULL `source_warehouse` are silently skipped — no MR without a destination warehouse
- The entire `create_component_shortage_mrs()` call is wrapped in try/except in `production_plan_engine.py` — failures NEVER abort PP/WO creation
- `build_min_order_map()` uses `stock_uom_qty` which is pre-computed. Fallback recomputes from `min_order_qty × conversion_factor`
- `Bin.ordered_qty` is the stock-UOM quantity on open POs. If Bin row doesn't exist for item+warehouse, both quantities default to 0.0

---

## RESTRICT

- Do NOT call `frappe.db.commit()` inside `create_component_shortage_mrs()` — caller owns the transaction
- Do NOT create MRs for `custom_toc_auto_manufacture = 1` items
- Do NOT remove the leaf-node classification — leaf nodes need purchase coverage
- Do NOT move Step 7 before Step 5 (WO creation) — WOs must exist first

---

## Sync Block — Created 2026-04-27 (v2 update)

**Modified**: `toc_engine/component_mr_generator.py`
- Added `_classify_items()`: "purchase" | "leaf" | "skip" classification
- Added `_get_bin_qtys()`: returns (actual_qty, ordered_qty) from Bin
- Added `_create_warehouse_batch_mr()`: one MR per warehouse with N items
- Added `_send_component_mr_summary()`: HTML email to notification users
- Added `_get_engine_notification_emails()`: reads toc_engine_notification_users
- Removed old `_create_component_mr()` (one item per MR — replaced by batch)

**New DocType**: `TOC Engine Notification User` (istable=1, module=Chaizup Toc)
- Fields: user (Link/User), user_name (fetch_from, read_only), notify_on_component_mrs (Check), notify_on_min_order_missing (Check)

**TOC Settings**: Two new fields added:
- `toc_engine_notification_section` (Section Break)
- `toc_engine_notification_users` (Table → TOC Engine Notification User)

**New file**: `toc_engine/min_order_sync.py`
- `daily_min_order_sync()`: 12 AM cron entry point
- `_sync_purchase_items_from_erpnext()`: reads Item.minimum_order_qty → Item Min Order Qty child table
- `_sync_manufacture_items_from_history()`: reads avg WO qty → Item Minimum Manufacture child table (only for items with no existing rows)
- `_notify_missing_min_order_qty()`: sends HTML email about items with no min order qty config

**hooks.py**: Added `"0 0 * * *"` cron for `daily_min_order_sync`

**daily_tasks.py**: Added `daily_min_order_sync()` wrapper function (12 AM)

**item_toc.js**: Added `Item Min Order Qty` child table handlers:
- `_setup_min_order_qty_grid(frm)`: guard (disable add row if new), UOM filter
- `frappe.ui.form.on("Item Min Order Qty", ...)`: uom change → auto-populate CF + stock_uom_qty; min_order_qty change → recompute

---

## Sync Block — 2026-04-27 (v3 — Buffer Type Removal + Sales Projection Guard)

**Removed**: `custom_toc_buffer_type` (FG/SFG/RM/PM) custom field from Item master
- Deleted from `fixtures/custom_field.json`
- Column dropped from `tabItem` in DB
- Custom Field record deleted from DB
- `toc_settings.json`: Removed `col_classification` and `item_group_rules` fields (Item Group → Buffer Type table)
- `toc_settings.py`: Removed `_validate_item_group_rules()` method
- `production_priority_board.js`: `buffer_type` filter options updated from FG/SFG/RM/PM → Manufacture/Purchase/Monitor
- `production_priority_board.py`: Added `buffer_type` filter application in `get_data()`
- All `.md` documentation files updated to remove FG/SFG/RM/PM references

**Note**: `buffer_type` field on `TOC Buffer Log` and `TOC Item Buffer` uses values **Manufacture/Purchase/Monitor** (not FG/SFG/RM/PM) — these are KEPT unchanged. Replenishment mode is derived from per-item `auto_manufacture`/`auto_purchase` flags.

**Added**: Sales Projection past-month guard
- `sales_projection.py`: New `_validate_not_past_month()` method
- Blocks save and submit for projections with `(projection_year, month_num) < (today.year, today.month)`
- Runs in both `validate()` and `before_submit()`
- `_MONTH_NUM` class constant maps month name strings to integers
