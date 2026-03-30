# `production_priority_board/` — Production Priority Board Report

## Role
THE primary daily operational report. Shows all TOC-managed items sorted by Buffer Penetration % (most urgent first). The production supervisor runs this every morning to decide what the bottleneck machine (VFFS) runs today.

Type: **Script Report** (Query Report with Python backend)

## Filters (`production_priority_board.js`)

| Filter | Type | Description |
|--------|------|-------------|
| `company` | Link | Defaults to user's default company |
| `buffer_type` | Select | FG / SFG / RM / PM or blank (all) |
| `warehouse` | Link | Filter to specific warehouse |
| `zone` | Select | Green / Yellow / Red / Black or blank |
| `item_code` | Link→Item | Filter to one item (only shows `custom_toc_enabled=1` items) |

## Columns

| Column | Formula | Width |
|--------|---------|-------|
| Rank | Sequential | 60 |
| Item Code | Link | 140 |
| Item Name | | 180 |
| Type | | 60 |
| Warehouse | Link | 140 |
| Target Buffer | F1: ADU×RLT×VF | 120 |
| On-Hand | | 90 |
| WIP/On-Order | | 100 |
| Backorders/Committed | | 100 |
| IP | F2: OH+WIP−BO | 100 |
| BP% | F3: (T−IP)÷T | 100 |
| SR% | IP÷Target | 80 |
| Zone | | 80 |
| Order Qty | F4: Target−IP | 110 |
| T/CU | F5: ₹/min | 100 |
| Action | | 150 |
| SFG Status | BOM check message | 180 |

## Row Formatting (`production_priority_board.js`)
- **Zone column**: Colored pill (Green/Yellow/Red/Black).
- **BP% column**: Red bold if >= 67%, orange bold if >= 33%.
- **Order Qty**: Orange bold if > 0.
- **Action**: Colored by zone.

## Action Buttons (report toolbar)

### "Generate MRs Now"
Calls `trigger_manual_run()` (requires Stock Manager/TOC Manager/System Manager).
Shows links to all created MRs in confirmation.

### "Apply DAF"
Opens a dialog with DAF presets:
- Diwali (1.6x), Trade Promotion (1.8x), Year-End (1.3x), Monsoon (0.85x), Summer (0.7x), Normal (1.0x)
- Custom float input with event name
- Calls `apply_global_daf(daf_value, event_name)`

### "Reset DAF"
Calls `reset_global_daf()` → sets all buffers back to DAF = 1.0.

### "TOC Guide"
Opens `/toc-guide` in new tab.

## Summary Cards
| Card | Value | Indicator |
|------|-------|-----------|
| Total Buffers | count | blue |
| Red/Black (Urgent) | count | red |
| Yellow (Plan) | count | orange |
| Green (OK) | count | green |
| Avg BP% | average | blue |

## Chart
Pie chart showing zone distribution (Green/Yellow/Red/Black counts).

## Data Source
Calls `calculate_all_buffers(**kwargs)` from `toc_engine.buffer_calculator`. Returns live data (not from buffer log table). Always shows current state.

## Usage
- Run daily at 7:05 AM (after `daily_production_run` MRs are created).
- Production planner uses BP% rank to schedule VFFS orders.
- Red zone items = run FIRST.
- Equal BP% → use T/CU to decide (higher T/CU = more revenue per minute).
