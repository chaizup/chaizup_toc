# `kitting_report/` — Full Kitting Report Page

## Purpose
Answers the operational question: **"Can we produce today's required FG items, and if not, exactly why?"**

Shows every FG/SFG item's full supply chain status — from demand (Sales Orders) through production (Work Orders), to component availability — in one interactive view. Includes one-click document creation.

**Route:** `/app/kitting-report`

---

## Columns — Main Table

| Column | Description | Source |
|--------|-------------|--------|
| Type | FG / SFG badge | `Item.custom_toc_buffer_type` |
| Item | Item name + code (link to Item form) | `Item` |
| Total SO Pending | Prev + Curr month pending SO qty | `Sales Order Item` WHERE `delivery_date` in period |
| Prev Month Pending SO | SOs due last month, not fully dispatched | Same, previous month |
| Curr Month Pending SO | SOs due this month, not fully dispatched | Same, current month |
| Curr Dispatched | Delivery Note qty posted this month | `Delivery Note Item` |
| Prev Dispatched | Delivery Note qty posted last month | `Delivery Note Item` |
| In Stock | Current on-hand (`Bin.actual_qty`) | `Bin` |
| Prod Required | Max(0, Total SO Pending − In Stock) | Calculated |
| Actual Produced | Manufacture Stock Entries this month (is_finished_item=1) | `Stock Entry Detail` |
| Should Produce | Max(0, Prod Required − Actual Produced) | Calculated |
| Kit Status | 🟢 Full / 🟡 Partial / 🔴 Cannot / ⚪ No Demand | BOM tree check |

---

## Kit Status Logic

For each FG, walks the full multi-level BOM and checks:
```
kit_qty = min over all leaf components of (component_stock / component_per_unit_required)
kit_pct = min(100, kit_qty / should_produce × 100)
```

| Status | Condition |
|--------|-----------|
| Full Kit | `kit_pct >= 100` |
| Partial Kit | `0 < kit_pct < 100` |
| Cannot Kit | `kit_pct = 0` |
| No Demand | `should_produce <= 0` |

---

## Drill-Down Panel (click any row)

Shows:
- FG summary: Should Produce / Can Kit Now / Shortage / Kit %
- Full BOM chain (multi-level, FG → SFG → SFG → RM/PM)
- Each component row:
  - Type badge, item name, required qty, in stock, shortage
  - **Stage badge** (see Stage Logic below)
  - Document count button → expands to show all linked open documents

### SFG Chain
SFG components show a **▼ chain** button. Click to expand/collapse that SFG's own sub-components. Chain can be N levels deep (max 6).

---

## Stage Logic — Per Component

| Stage | Color | When |
|-------|-------|------|
| In Stock | 🟢 Green | shortage ≤ 0 |
| In Production | 🔵 Blue | shortage > 0 + open Work Order for this item |
| Purchase Ordered | 🩵 Teal | shortage > 0 + open Purchase Order |
| MR Raised | 🟡 Orange | shortage > 0 + open Material Request (not yet PO'd) |
| Short — No Action | 🔴 Red | shortage > 0 + no active documents |

Each document shows: doc link, status, qty, received/produced qty, supplier/owner, raised date.

---

## Action Buttons

### Row-level (main table)
| Button | Condition | Action |
|--------|-----------|--------|
| ⚙️ WO | FG/SFG, should_produce > 0 | Opens confirm → creates Work Order |
| 🛒 MR | Any type, should_produce > 0 | Loads BOM, collects RM/PM shortages → creates Purchase MR |

### Drill-down panel
| Button | Action |
|--------|--------|
| ⚙️ Create Work Order (N units) | Creates WO for this FG with Should Produce qty |
| 🛒 Create Purchase MR (N items) | Creates one Purchase MR with all RM/PM shortages from the BOM tree |
| 📦 Open Item | Opens ERPNext Item form |
| 📐 Open BOM | Opens the BOM |

### Top toolbar (bulk)
| Button | Action |
|--------|--------|
| Create All Work Orders | Creates WOs for ALL FG/SFG items with should_produce > 0 and a BOM |
| Create All Purchase MRs | Guides user to use per-item MR (bulk purchase across all items is intentionally per-item to allow review) |

---

## API Methods

All in `chaizup_toc/api/kitting_api.py`:

| Method | Description |
|--------|-------------|
| `get_kitting_summary(company, month, year, buffer_type)` | Main table data |
| `get_item_kitting_detail(item_code, required_qty)` | Full BOM tree with stage tracking |
| `create_purchase_requests(items_json, company)` | Bulk create Purchase MR |
| `create_work_order_from_kitting(item_code, qty, company, bom)` | Create Work Order |

### Permissions
- `get_kitting_summary`, `get_item_kitting_detail` — all logged-in users
- `create_purchase_requests` — Stock Manager / Purchase Manager / TOC Manager / System Manager
- `create_work_order_from_kitting` — Stock Manager / Manufacturing Manager / TOC Manager / System Manager

---

## Filters

| Filter | Description |
|--------|-------------|
| Company | Filters SO, DN, Stock data by company |
| Month | Month for SO pending / dispatched / production calculations |
| Year | Year for the same |
| Type | All / FG / SFG |

---

## BOM Walking (`_walk_bom`)

Recursive, up to 6 levels deep. For each BOM component:
1. Fetches `BOM Item` rows for the BOM
2. Gets item type from `custom_toc_buffer_type` (or keyword inference via `_infer_type`)
3. Gets current stock from `Bin` (sum all warehouses)
4. Calculates shortage
5. Queries stage documents (WOs, POs, MRs) for that component
6. For SFG components: finds sub-BOM and recurses

---

## Notes

- **BOM required**: Kit status only works if items have an active BOM (`custom_toc_default_bom` or ERPNext BOM with `is_active=1, docstatus=1`). Items without a BOM show "Cannot Kit" status.
- **Stock aggregation**: Currently sums all warehouses in `Bin`. For warehouse-aware calculations, configure Warehouse Rules in TOC Settings.
- **"Should Produce = 0"**: Item has no outstanding demand this period or stock covers all demand. Shows as "No Demand" (neutral, not a problem).
- **Month filter**: "Current month" means the month/year selected in the filter, not necessarily today. Defaults to today's month.
