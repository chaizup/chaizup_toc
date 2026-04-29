# Sales Projection — Developer Documentation

## Purpose

Captures the minimum production target per item for a given calendar month, year, and warehouse.
Unique key: `projection_month + projection_year + source_warehouse` (one document per combination).

Once submitted, it serves as the input for the Production Plan Automation engine which runs daily
at 02:00 AM and creates Draft Production Plans for items with unmet demand.

---

## DocType Summary

| Property | Value |
|----------|-------|
| Submittable | Yes |
| Naming | Auto (Frappe hash) |
| Module | Chaizup Toc |
| Unique Key | projection_month + projection_year + source_warehouse |
| Child Table (items) | `table_mibv` → Sales Projected Items |
| Child Table (min mfg) | `minimum_manufacture` → SP Minimum Manufacture |

---

## Fields

| Fieldname | Type | Description |
|-----------|------|-------------|
| `projection_month` | Select | Calendar month (January–December). Required. |
| `projection_year` | Int | 4-digit year (e.g., 2026). Required. |
| `source_warehouse` | Link → Warehouse | Warehouse this projection covers. Part of unique key. Required. Also used as the target warehouse in auto-created Production Plans. |
| `last_auto_run` | Datetime | Timestamp of the last PP Automation run. Read-only. |
| `table_mibv` | Table → Sales Projected Items | Projected items for this period. Required. |
| `minimum_manufacture` | Table → SP Minimum Manufacture | Optional: per-item per-warehouse minimum production qty floor. |
| `amended_from` | Link → Sales Projection | Set by Frappe on amendment. Read-only. |

---

## Validation Rules

### 1. Required Fields

`_validate_required_header_fields()`:
- projection_month, projection_year, source_warehouse must be set
- At least one row in table_mibv

### 2. No Duplicate Items in Child Table

`_validate_no_duplicate_items()`:
- Each item code must appear at most once in `table_mibv`
- JS warns (orange) live; Python blocks (red) on save/submit

### 3. Unique Month + Year + Warehouse

`_validate_unique_period_warehouse()`:
- No two non-cancelled Sales Projections with the same month+year+warehouse
- Cancelled (docstatus=2) docs do NOT block re-creation

Both duplicate-item and uniqueness rules run in `validate()` and `before_submit()`.

---

## Minimum Manufacturing Quantities (SP Minimum Manufacture)

Child table on the Sales Projection for declaring per-item per-warehouse minimum batch sizes.

| Fieldname | Type | Purpose |
|-----------|------|---------|
| `item_code` | Link → Item | Item this minimum applies to |
| `item_name` | Data (fetch_from) | Auto-fetched from item |
| `warehouse` | Link → Warehouse | Warehouse where minimum applies |
| `min_manufacturing_qty` | Float | Minimum units to produce (in `uom`) |
| `uom` | Link → UOM | UOM of min_manufacturing_qty |

The automation engine converts `min_manufacturing_qty` to stock UOM using `UOM Conversion Detail`
and applies `max(shortage, min_mfg_qty_in_stock_uom)` as the Production Plan quantity.

---

## Client-Side Logic (sales_projection.js)

### UOM Filtering

UOM dropdown in the child table is filtered per item:
- Calls `get_item_uoms()` from `sales_projected_items.py`
- Returns only UOMs in the item's UOM Conversion Detail + the item's `stock_uom`
- `get_query` must be re-registered on every `refresh()`

### Auto-Computed Fields

| Trigger | What happens |
|---------|-------------|
| Item selected | Clears `uom_unit_of_measurement`, `conversion_factor` = 1, `qty_in_stock_uom` = 0 |
| UOM selected | Fetches `conversion_factor` from UOM Conversion Detail; 1 if UOM = stock_uom |
| Qty changed | `qty_in_stock_uom = qty × conversion_factor` |
| `conversion_factor` set | Triggers qty_in_stock_uom recompute |

### "Run Production Plan Automation" Button

Shown ONLY when:
1. Document is Submitted (docstatus = 1)
2. `projection_month + projection_year` == current calendar month + year

The button:
- Shows a confirmation dialog explaining what the automation will do
- Calls `run_production_plan_automation()` via `frappe.call`
- On success: shows per-item summary table with PP links; reloads doc
- After run: `last_auto_run` and child-row `wo_status`/`wo_name` (pp_name) are updated

---

## Production Plan Automation Engine

See `toc_engine/production_plan_engine.py` and `production_plan_engine.md` for full details.

### Formula (per item)

```
shortage = (projected_qty + prev_month_pending_SO_qty_for_warehouse
            - curr_month_pending_SO_qty_for_warehouse)
           - warehouse_actual_stock

production_qty = max(shortage, min_mfg_qty_in_stock_uom)
```

Two scenarios:
- **Calc 1** — `projected_qty > 0`: normal forecast shortage
- **Calc 2** — `projected_qty = 0` but pending SOs exist: no-forecast SO demand

### Daily Schedule

Daily at **02:00 AM** — `daily_production_plan_automation()` in production_plan_engine.py.
Processes ALL submitted projections for the current month (one per warehouse).

---

## DANGER ZONE — Critical Field Names

> **Do NOT rename these without updating ALL references.**

| Name | Used in |
|------|---------|
| `table_mibv` | `sales_projection.py`, `sales_projection.js`, `production_plan_engine.py` |
| `minimum_manufacture` | `production_plan_engine._build_min_mfg_map()` reads `sp_doc.minimum_manufacture` |
| `uom_unit_of_measurement` | `sales_projection.js`, `get_item_uoms()` query |
| `projection_month` | `_validate_unique_period_warehouse()`, `production_plan_engine._month_boundaries()` |
| `projection_year` | Same as above |
| `source_warehouse` | `_validate_unique_period_warehouse()`, `production_plan_engine` SQL helpers |
| `last_auto_run` | `production_plan_engine.run_production_plan_automation()` — written via `frappe.db.set_value` |
| `wo_status` (child) | `production_plan_engine._process_item()` — updated per row (now shows PP status) |
| `wo_name` (child) | `production_plan_engine._process_item()` — set to PP name after creation |

---

## RESTRICT — Do Not Remove

| Component | Why it must stay |
|-----------|-----------------|
| `_validate_no_duplicate_items()` | Production targets per item must be unambiguous |
| `_validate_unique_period_warehouse()` | One plan per month+year+warehouse — two projections = conflicting targets |
| `before_submit()` on Python | API callers bypass JS validate |
| `get_query` on UOM field in `refresh()` | Frappe resets `get_query` on every page reload |
| `_MONTH_NAMES` array order in JS | Index-matched to `new Date().getMonth()` (0=Jan, 11=Dec) |
| Month + Year check on "Run" button | Prevents running automation on past/future projections |
| `docstatus !== 0` guard in `on_sales_projection_update` | Prevents double-notification on submit |

---

## File Map

```
sales_projection/
├── sales_projection.json       — DocType schema (fields, unique key, submittable)
├── sales_projection.py         — Controller: validate, before_submit, 3 validation methods
├── sales_projection.js         — Client: UOM filter, qty compute, dup warn, Run button
├── sales_projection.md         — This file
└── test_sales_projection.py

doctype/sp_minimum_manufacture/ — Child table for per-item per-warehouse min batch sizes

toc_engine/
├── production_plan_engine.py   — PP automation engine (2 AM scheduler + manual trigger)
├── production_plan_engine.md   — Engine developer documentation
└── projection_engine.py        — SP email notification handlers (on_update, on_submit)

fixtures/
└── custom_field.json           — Custom fields on Production Plan (Created By, Reason, Source Projection)
```
