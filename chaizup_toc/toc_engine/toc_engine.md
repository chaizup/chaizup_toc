# `toc_engine/` — Core TOC Calculation Engine

## Purpose
Pure business logic for Theory of Constraints buffer management. No web framework dependencies. Contains three modules: the buffer calculator, DBM (Dynamic Buffer Management) engine, and MR generator.

---

## Formulas Reference

| Formula | Expression | Description |
|---------|-----------|-------------|
| F1 | `Target = ADU × RLT × VF` | Target buffer size |
| F2 (all types) | `IP = On-Hand + WIP + On-Order − Backorders − Committed` | Universal IP — all transaction sources checked for every item |
| F3 | `BP% = (Target − IP) / Target × 100` | Buffer Penetration % (urgency) |
| F3 alt | `SR% = IP / Target × 100` | Stock Remaining % (health) |
| F4 | `Order Qty = Target − IP` | How much to replenish |
| F5 | `T/CU = (Price − TVC) × Speed` | Throughput per Constraint Unit (tie-breaker) |
| F6 | `Adjusted = Target × DAF` | Demand Adjustment for seasonal events |
| F7 | `TMR: Target × (1 + adj%)` | Too Much Red → increase buffer |
| F8 | `TMG: Target × (1 − adj%)` | Too Much Green → decrease buffer |

---

## ERPNext Data Sources

| TOC Concept | DocType | Field | When non-zero |
|-------------|---------|-------|---------------|
| On-Hand | Bin | `actual_qty` | Always |
| WIP (supply) | Work Order | `qty − produced_qty` | Item is manufactured (own WOs) |
| On-Order (supply) | Bin | `ordered_qty` | Item is purchased (open POs) |
| Backorders (demand) | Bin | `reserved_qty` | Item is sold (Sales Order demand) |
| Committed (demand) | Work Order Item | `required_qty − transferred_qty` | Item used as component in WOs |
| ADU, RLT, VF | Item child | `TOC Item Buffer` | Always |
| Buffer Type | Item | `custom_toc_buffer_type` | Always |

All four transaction sources are checked for **every item** regardless of buffer type.
A typically-produced item that is also sometimes purchased will have both `wip > 0` and `on_order > 0`.
An SFG that is occasionally sold will have `backorders > 0` counted against it.

---

## `buffer_calculator.py`

### Zone Logic

#### `get_zone(bp_pct, settings=None)`
Determines zone from BP%:
- `>= 100%` → Black (stockout)
- `>= red_zone_threshold (67%)` → Red
- `>= yellow_zone_threshold (33%)` → Yellow
- `< 33%` → Green

Thresholds are loaded from `TOC Settings` (cached).

#### `get_zone_color(zone)` / `get_zone_label(zone)`
Jinja helpers registered in `hooks.py → jinja.methods`. Used in print formats.

#### `get_zone_action(zone, buffer_type)`
Returns action text per zone+type. Example: FG+Red = "PRODUCE NOW".

### Warehouse-Aware Calculation

All position functions accept an optional `settings` parameter. When `TOC Settings.warehouse_rules` is populated, calculations aggregate across classified warehouses. When empty, they fall back to the single `warehouse` from the `TOC Item Buffer` rule (backward-compatible).

New helpers:

#### `_get_warehouse_lists(settings)`
Parses `settings.warehouse_rules` into `{"inventory": [...], "wip": [...], "excluded": [...]}`. Called once per `calculate_all_buffers()` call.

#### `_sum_bin_field(item_code, warehouses, field)`
SQL SUM of one Bin field across a list of warehouses. Used by all position calculators when warehouse-aware mode is active.

#### `_resolve_buffer_type(item_code, item_group, settings)`
Resolves FG/SFG/RM/PM for items without a manual `custom_toc_buffer_type`. Checks `settings.item_group_rules` in priority order, then walks up the ERPNext Item Group hierarchy for rules with `include_sub_groups=1`. Returns `None` if no match (item is skipped with Error Log).

### Inventory Position Calculator

#### `get_inventory_position(item_code, warehouse, settings=None)`
Universal F2: `IP = On-Hand + WIP + On-Order − Backorders − Committed`

Single function used for **all item types**. All four transaction sources are always queried — unused ones return 0.

An item may be both manufactured AND purchased, both sold AND consumed as a WO component. The buffer type label does not limit which transactions are included.

**Warehouse-aware** (when `warehouse_rules` configured):
- On-Hand / Backorders: Inventory-classified warehouses only
- WIP: Work Orders with `fg_warehouse IN (Inventory+WIP)` + `Bin.actual_qty` in WIP warehouses
- On-Order: `Bin.ordered_qty` across Inventory + WIP warehouses
- Committed: `tabWork Order Item` filtered by `source_warehouse IN (Inventory warehouses)`

**Fallback** (empty rules): single Bin lookup + global WO/WOI queries (original behavior).

Returns: `{on_hand, wip, on_order, backorders, committed, ip}`

#### `get_fg_position` / `get_sfg_position` / `get_rm_position`
Backward-compatible aliases — all delegate to `get_inventory_position`.

### Main Calculation Engine

#### `calculate_all_buffers(buffer_type, company, warehouse, item_code)`
Entry point for all buffer calculations.

1. Queries Items with `custom_toc_enabled=1, disabled=0` (no SQL buffer_type filter — type resolved in Python for items without manual type set).
2. For each item, resolves `buffer_type`:
   - Uses `custom_toc_buffer_type` if set (manual, always wins)
   - Otherwise calls `_resolve_buffer_type()` against `item_group_rules`
   - Skips item with Error Log if type cannot be resolved
3. Applies `buffer_type` parameter filter in Python after resolution.
4. Fetches all active `TOC Item Buffer` child rows.
5. Calls `_calculate_single(item, rule, settings)` for each item-rule pair.
6. Sorts result by `(-bp_pct, -tcu)` — most urgent first, T/CU tie-breaker.
7. Errors per item are logged to Error Log but don't stop the batch.

#### `_calculate_single(item, rule, settings)`
Calculates buffer status for one item+warehouse:
1. Effective target = `adjusted_buffer` if set, else `target_buffer`.
2. Calls the right F2 function by `buffer_type`.
3. Computes `BP%`, `SR%`, `zone`, `order_qty`, `T/CU`.
4. For FG items with a BOM: calls `check_bom_availability()`.
5. Returns a dict (see schema below).

**Return dict schema:**
```python
{
    "item_code", "item_name", "stock_uom", "warehouse", "company",
    "buffer_type",                  # FG / SFG / RM / PM
    "mr_type",                      # "Manufacture" or "Purchase"
    # All four IP components (universal — non-zero only when transactions exist)
    "on_hand", "wip", "on_order", "backorders", "committed",
    # Combined convenience fields
    "wip_or_on_order",              # wip + on_order (total supply pipeline)
    "backorders_or_committed",      # backorders + committed (total demand)
    "inventory_position",           # F2 result = on_hand+wip+on_order−backorders−committed
    "target_buffer",                # F1 or adjusted by DAF
    "bp_pct", "sr_pct",             # F3
    "zone", "zone_color", "zone_action",
    "order_qty",                    # F4
    "tcu",                          # F5 (FG only, else 0)
    "adu", "rlt", "vf", "daf",
    "rule_name",                    # TOC Item Buffer row name
    "sfg_item", "sfg_status",       # BOM availability result
}
```

### Doc Event Handlers (called by hooks.py)

#### `on_stock_movement(doc, method)`
Fires on every `Stock Ledger Entry` after_insert. If item is TOC-managed, enqueues `check_realtime_alert` on the `short` queue.

#### `on_demand_change(doc, method)`
Fires on `Sales Order` submit/cancel. Enqueues alert check for each FG item in the order.

#### `on_supply_change(doc, method)`
Fires on `Work Order` and `Purchase Order` events:
- Work Order: uses `doc.production_item` as `item_code`, passes `warehouse=None`.
- Purchase Order: iterates `doc.items` child table, uses `item.item_code` + `item.warehouse`.

#### `check_realtime_alert(item_code, warehouse=None)`
Called async in a background job. Recalculates buffer and publishes `toc_buffer_alert` realtime event to browser if zone is Red or Black.

### Helpers

#### `_is_toc_item(item_code, buffer_type=None)`
Checks `frappe.db.exists("Item", {name, custom_toc_enabled: 1})`.

#### `_get_settings()`
Returns `frappe.get_cached_doc("TOC Settings")`. Falls back to hardcoded defaults on exception (useful on fresh install before settings are saved).

### BOM Availability Check (R3)

#### `check_bom_availability(item_code, required_qty, warehouse=None)`
Reads `custom_toc_default_bom` and `custom_toc_check_bom_availability` from Item.
Recursively walks the BOM tree via `_walk_bom()`.

#### `_walk_bom(bom_name, parent_qty, multiplier, warehouse, results, depth, max_depth=5)`
Recursive BOM tree walker:
- Fetches `BOM Item` rows for the given BOM.
- Calculates required qty = `stock_qty × multiplier × parent_qty`.
- Checks actual stock from `Bin` (by warehouse or all warehouses).
- If a component is itself an SFG with a BOM, recurses to depth+1.
- Safety guard: stops at `max_depth=5` to prevent infinite loops.

---

## `dbm_engine.py` — Dynamic Buffer Management

### Purpose
Weekly automatic adjustment of buffer sizes based on observed zone behavior.

### `evaluate_all_dbm()`
Weekly entry point (called by `daily_tasks.weekly_dbm_check`).
1. Checks `TOC Settings.enable_dbm`.
2. Iterates all enabled `TOC Item Buffer` rules.
3. Calls `_evaluate_single()` for each rule.
4. Commits at end.

### `_evaluate_single(rule, settings)`
Evaluates TMR (Too Much Red) and TMG (Too Much Green) for one buffer rule.

**F7 TMR Logic:**
- Fetch logs from last `1 RLT` window.
- Count Red/Black days.
- If `red_days > RLT × tmr_red_pct_of_rlt (20%)` → increase target by `adj%`.
- Safeguard: If `tmr_count >= max_tmr_consecutive (3)` → log error, stop (requires manual review).
- Updates: `target_buffer`, `tmr_count +1`, `tmg_green_days → 0`, `last_dbm_date`.

**F8 TMG Logic:**
- Fetch logs from last `RLT × tmg_cycles_required (3)` days.
- If enough data points AND all days in window are Green → decrease target by `adj%`.
- Floor safeguard: Never goes below `min_buffer_floor (50)`.
- Updates: `target_buffer`, `tmr_count → 0`, `tmg_green_days → 0`, `last_dbm_date`.

**Asymmetry (intentional):** TMR fires after 20% of 1 RLT in Red (fast increase). TMG requires 3 full RLT cycles of all-Green (slow decrease). Stockout cost >> holding cost.

---

## `mr_generator.py` — Material Request Generator

### Purpose
Replaces `erpnext.stock.reorder_item.reorder_item()` with BP%-driven, exact-quantity MRs.

### `generate_material_requests(buffer_type, zone_filter, company)`
1. Checks `TOC Settings.auto_generate_mr` — returns early if disabled.
2. Calls `calculate_all_buffers()`.
3. Filters by zone (`Red, Black, Yellow` by default, or `Red, Black Only` per settings).
4. For each actionable item: checks for existing open MR (`_has_open_mr()`), skips if exists.
5. Logs SFG shortfalls but does NOT block MR creation.
6. Calls `_create_mr()` and `_log_snapshot()` for each.
7. Sends email alerts if `notify_on_red=1`.
8. Returns list of created MR names.

### `_has_open_mr(item_code, warehouse, mr_type)`
SQL check: any MR (`docstatus < 2`, not Stopped/Cancelled) with this item+warehouse+type.

### `_create_mr(data, settings)`
Creates and inserts (not submits) a single Material Request:
- `material_request_type` = "Manufacture" (FG/SFG) or "Purchase" (RM/PM).
- `schedule_date` = today + RLT (min 1 day).
- Sets all `custom_toc_*` fields from buffer data.
- Item description embeds full formula explanation.
- Uses `ignore_permissions=True`.

### `_log_snapshot(data, mr_name)`
Creates a `TOC Buffer Log` record linking to the generated MR.

### `_send_alerts(red_items, created_mrs, settings)`
Sends HTML email to all users with roles listed in `TOC Settings.red_alert_roles`.
- Uses `frappe.sendmail()`.
- Email contains colored table of all Red/Black items + formula explanation.

---

## Bug History

### ~~BUG-1 (FIXED): Dead function `_check_sfg_availability()`~~
`buffer_calculator.py` defined `_check_sfg_availability()` but it was never called anywhere. SFG checks use `check_bom_availability()` instead. **Fixed**: entire function removed.

### ~~BUG-2 (FIXED): Misleading `daily_procurement_run()` comment~~
`hooks.py` comment said "generates Purchase MRs" for the 07:30 AM task, which was wrong. **Fixed**: comment and docstring updated. See `tasks/tasks.md` for details.

### NOTE: `check_realtime_alert` and `after_commit=True` in background job
`frappe.publish_realtime(..., after_commit=True)` is called inside a background job. This should work (publishes after the job's transaction commits), but if the background worker doesn't have a DB transaction open, the realtime event may fire immediately regardless. Low severity — monitor if alerts appear before stock changes are visible.
