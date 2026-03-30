# `toc_warehouse_rule/` — TOC Warehouse Rule DocType (Child Table)

## Role
Classifies every warehouse in the company for TOC buffer calculations. Lives as a child table row on `TOC Settings` under field `warehouse_rules`.

## Parent Relationship
- `istable: 1` — child table, not a standalone document.
- Parent DocType: `TOC Settings`
- Parent field: `warehouse_rules`

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `warehouse` | Link → Warehouse | ✓ | The warehouse to classify |
| `company` | Data | read_only | Auto-fetched from the warehouse |
| `warehouse_purpose` | Select | ✓ | **Inventory / WIP / Excluded** |
| `notes` | Small Text | — | Optional description (e.g. "Scrap from VFFS Line 1") |

## Purpose Values

### Inventory
Usable, QC-cleared physical stock. `Bin.actual_qty` for these warehouses counts as **on-hand** in the F2 formula.

Examples: Main FG Store, Branch Store, RM Store, Finished Goods Warehouse.

### WIP
Stock physically in-process. Counts as **WIP** in F2a (added to, not subtracted from IP):
- `Bin.actual_qty` in WIP warehouses adds to WIP component
- Work Orders with `fg_warehouse IN (Inventory + WIP warehouses)` count as WIP

Use for: companies that have a dedicated WIP warehouse where materials sit during production, especially if ERPNext Work Orders are not fully used.

Examples: Production Floor Store, Blending WIP, Staging Area.

### Excluded
Never counted in any F2 calculation. Stock here is invisible to TOC.

Use for: Scrap, Expiry, Wastage, QC Hold/Quarantine, Demo, Damaged Goods.

## How It Affects Calculations

### With warehouse rules configured (warehouse-aware mode)
```
F2a (FG/SFG):
  on_hand    = SUM(Bin.actual_qty WHERE warehouse IN Inventory warehouses)
  wip        = Work Orders targeting (Inventory + WIP) + Bin.actual_qty in WIP warehouses
  backorders = SUM(Bin.reserved_qty WHERE warehouse IN Inventory warehouses)
  IP         = on_hand + wip − backorders

F2b (RM/PM):
  on_hand    = SUM(Bin.actual_qty WHERE warehouse IN Inventory warehouses)
  on_order   = SUM(Bin.ordered_qty WHERE warehouse IN Inventory + WIP warehouses)
  committed  = SUM(Bin.reserved_qty WHERE warehouse IN Inventory warehouses)
  IP         = on_hand + on_order − committed
```

### Without warehouse rules (fallback — backward-compatible)
Uses the single `warehouse` field from each `TOC Item Buffer` rule row exactly as before.

## Setup Order
Configure warehouse rules **before** enabling TOC on items. Changing warehouse classification after go-live will immediately affect all BP% calculations.

## Validation
`toc_settings.py` validates:
- No duplicate warehouses in the table
- At least one `Inventory` warehouse if the table is non-empty (warns if none found)
