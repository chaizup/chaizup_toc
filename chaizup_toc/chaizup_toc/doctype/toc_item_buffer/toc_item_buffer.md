# `toc_item_buffer/` — TOC Item Buffer DocType (Child Table)

## Role
Per-warehouse buffer rule for an item. Lives as a child table row on the `Item` DocType under field `custom_toc_buffer_rules`. One row = one warehouse buffer rule.

## Parent Relationship
- `istable: 1` — this is a child table, never a standalone document.
- Parent DocType: `Item`
- Parent field: `custom_toc_buffer_rules`

## Fields

### Core Buffer Inputs (F1)
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `warehouse` | Link→Warehouse | ✓ | — | Target warehouse for this rule |
| `adu` | Float | ✓ | — | Average Daily Usage (units/day) |
| `rlt` | Float | ✓ | — | Replenishment Lead Time (days) |
| `variability_factor` | Float | ✓ | 1.5 | VF: 1.0–1.3 stable, 1.3–1.6 moderate, 1.6–2.0 volatile |

### Calculated Buffers (read-only, auto-set by validate)
| Field | Type | Description |
|-------|------|-------------|
| `target_buffer` | Float | F1: ADU × RLT × VF |
| `daf` | Float | F6: Demand Adjustment Factor (default 1.0) |
| `adjusted_buffer` | Float | F6: Target × DAF (0 if DAF = 1.0) |
| `red_zone_qty` | Float | Stock threshold for Red zone (target × 33%) |
| `yellow_zone_qty` | Float | Stock threshold for Yellow zone entry (target × 67%) |

### DBM Tracking (collapsible section, read-only)
| Field | Type | Description |
|-------|------|-------------|
| `tmr_count` | Int | Consecutive TMR (Too Much Red) increases |
| `tmg_green_days` | Int | Consecutive Green days counter |
| `last_dbm_date` | Date | Date of last DBM check |

### Status
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | Check | 1 | Uncheck to disable rule without deleting |

## Controller (`toc_item_buffer.py`)

### `validate()`
Runs all four calculation methods in order:
1. `calculate_target_buffer()` — F1: `ADU × RLT × VF`
2. `calculate_adjusted_buffer()` — F6: `Target × DAF` (or 0 if DAF = 1.0)
3. `calculate_zone_thresholds()` — computes `red_zone_qty` and `yellow_zone_qty`
4. `validate_inputs()` — input validation with throws/warnings

### `calculate_target_buffer()`
```python
self.target_buffer = round(adu × rlt × variability_factor)
```

### `calculate_adjusted_buffer()`
```python
if daf != 1.0:
    self.adjusted_buffer = round(target_buffer × daf)
else:
    self.adjusted_buffer = 0  # means "use target_buffer as-is"
```
In `buffer_calculator._calculate_single()`:
```python
target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
# If adjusted_buffer = 0, falls back to target_buffer
```

### `calculate_zone_thresholds()`
Uses `TOC Settings` to compute zone boundaries. Falls back to `yellow_threshold = 33.0` if settings not yet saved (fresh install):
```python
try:
    settings = frappe.get_cached_doc("TOC Settings")
    yellow_threshold = flt(settings.yellow_zone_threshold)
except Exception:
    yellow_threshold = 33.0

# Red zone: stock below 33% of target
red_zone_qty = effective × (yellow_threshold / 100)   # = effective × 0.33

# Yellow zone: stock below 67% of target (upper bound of yellow)
yellow_zone_qty = effective × (1 - yellow_threshold / 100)  # = effective × 0.67
```

### `validate_inputs()`
| Condition | Response |
|-----------|----------|
| `adu <= 0` | frappe.throw() |
| `rlt <= 0` | frappe.throw() |
| `vf < 1.0` | frappe.throw() |
| `vf > 3.0` | frappe.msgprint() (warning, non-blocking) |
| `daf < 0.1 or daf > 5.0` | frappe.throw() |

## How the Effective Buffer Is Chosen
```
adjusted_buffer != 0 → use adjusted_buffer (DAF applied)
adjusted_buffer = 0  → use target_buffer (normal operations)
```

## DBM Auto-Update (weekly)
The DBM engine writes directly to `TOC Item Buffer` via `frappe.db.set_value()` after TMR/TMG:
- TMR increase: `target_buffer = new_target`, `tmr_count += 1`, `tmg_green_days = 0`
- TMG decrease: `target_buffer = new_target`, `tmr_count = 0`, `tmg_green_days = 0`

## Bug History

### ~~BUG-1 (FIXED): Missing hook target function~~
`hooks.py` referenced `on_buffer_rule_validate` in `overrides/item.py` which didn't exist. Caused every Item save with buffer rules to fail. **Fixed**: removed `"TOC Item Buffer"` entry from `doc_events` in `hooks.py`.

### ~~BUG-2 (FIXED): Dead code `yel_pct`~~
In `calculate_zone_thresholds()`, variable `yel_pct` was computed but never used. **Fixed**: removed.

### ~~BUG-3 (FIXED): No fallback if `TOC Settings` doesn't exist~~
`calculate_zone_thresholds()` called `frappe.get_cached_doc("TOC Settings")` without a try/except. **Fixed**: wrapped in try/except with `yellow_threshold = 33.0` default fallback.
