# `toc_buffer_log/` — TOC Buffer Log DocType

## Role
Daily snapshot archive of every item's buffer state. Powers DBM analysis, Buffer Status Report, and Number Card counts.

## Autoname
```
TOCLOG-{log_date}-{item_code}-{####}
```
Example: `TOCLOG-2026-03-30-RM-TEA-DUST-0001`

## Fields

### Header
| Field | Type | Description |
|-------|------|-------------|
| `item_code` | Link→Item | The item this snapshot belongs to (required, indexed) |
| `item_name` | Data | Fetched from `item_code.item_name`, read-only |
| `warehouse` | Link→Warehouse | Warehouse for this buffer snapshot (required, indexed) |
| `log_date` | Date | Date snapshot was taken (default: Today, indexed) |
| `buffer_type` | Select | FG / SFG / RM / PM |
| `company` | Link→Company | Company context |

### Inventory Position Section (F2)
| Field | Type | Description |
|-------|------|-------------|
| `on_hand_qty` | Float | Physical stock (`Bin.actual_qty`) |
| `wip_qty` | Float | WIP (FG) or On-Order (RM) quantity |
| `reserved_qty` | Float | Backorders (FG) or Committed (RM) quantity |
| `inventory_position` | Float | F2 result (IP = On-Hand + WIP - Backorders) |

### Buffer Status Section (F3)
| Field | Type | Description |
|-------|------|-------------|
| `target_buffer` | Float | F1: ADU × RLT × VF (or adjusted by DAF) |
| `buffer_penetration_pct` | Float | F3: (Target − IP) / Target × 100 |
| `stock_remaining_pct` | Float | F3 alt: IP / Target × 100 |
| `zone` | Select | Green / Yellow / Red / Black |
| `order_qty_suggested` | Float | F4: Target − IP |
| `mr_created` | Link→Material Request | MR auto-generated for this snapshot |

## Permissions
| Role | Read | Write | Create | Delete |
|------|------|-------|--------|--------|
| System Manager | ✓ | ✓ | ✓ | ✓ |
| Stock Manager | ✓ | — | — | — |
| TOC Manager | ✓ | ✓ | ✓ | — |
| TOC User | ✓ | — | — | — |

Custom permission function: `chaizup_toc.api.permissions.has_buffer_log_permission` (allows broader read access).

## Controller (`toc_buffer_log.py`)
Empty — passes all logic to the JSON schema. No lifecycle hooks.

## How Records Are Created
1. **Daily at 08:00 AM**: `daily_buffer_snapshot()` in `tasks/daily_tasks.py` inserts one log per active buffer rule.
2. **After MR creation**: `mr_generator._log_snapshot()` inserts a log linked to the created MR.

## Sort Order
`log_date DESC` — newest first in list view.

## Usage Patterns

### DBM Engine reads from this DocType
```python
# DBM queries last N days of logs for TMR/TMG evaluation
frappe.get_all("TOC Buffer Log",
    filters={"item_code": rule.parent, "warehouse": rule.warehouse,
             "log_date": [">=", add_days(today(), -window)]},
    fields=["zone", "log_date"])
```

### Number Cards query today's logs
```python
frappe.db.count("TOC Buffer Log", filters={"zone": "Red", "log_date": today()})
```

## Growth Considerations
With default settings (daily run, all items), this table grows at:
`items × warehouses × 365 rows/year`

For 50 items across 2 warehouses: ~36,500 rows/year. Index on `(item_code, warehouse, log_date)` is handled by `search_index=1` on those fields.

No automatic cleanup/archival is implemented. Monitor table size on long-running instances.
