# Production Indent Subs — Script Report

Route: **`/app/query-report/Production Indent Subs`**

One row per **(Work Order × Component)** for every TOC-Pending Work Order. "Indent Subs" = the sub-components (raw materials / packing materials) that need to be issued to feed each pending production run.

Created: **2026-05-18** · Module: **Chaizup Toc** · ref_doctype: **Work Order**

---

## 1. Why this report exists

Pending Work Orders carry a list of components in `tabWork Order Item`. Operators need a flat, filterable view of:
- Which components are needed?
- How many planned vs already consumed?
- Across which WOs?
- In what UOM (Carton vs Pcs)?
- Linked to which Production Plan?

Existing surfaces cover demand or supply individually; this is the **per-WO bill of materials** for the pending pipeline.

---

## 2. Columns (per user spec)

| # | Field | Source |
|---|---|---|
| 1 | Warehouse | `Work Order.fg_warehouse` |
| 2 | Work Order (link) | `Work Order.name` |
| 3 | WO Status | `Work Order.status` |
| 4 | Produced Item (link) | `Work Order.production_item` |
| 5 | Produced Item Name | `Item.item_name` |
| 6 | Produced Item Group | `Item.item_group` |
| 7 | Produced Item MRP | `Work Order.custom_mrp` (or `Item.custom_mrp` fallback) |
| 8 | Higher UOM (FG) | largest-CF row in `tabUOM Conversion Detail` for the FG |
| 9 | Default UOM (FG) | `Item.stock_uom` |
| 10 | FG Qty Planned (Higher UOM) | `Work Order.qty ÷ FG_CF` |
| 11 | FG Qty Produced (Higher UOM) | `Work Order.produced_qty ÷ FG_CF` |
| 12 | Component (link) | `Work Order Item.item_code` |
| 13 | Component Name | `Item.item_name` |
| 14 | Component Group | `Item.item_group` |
| 15 | Comp Qty Planned (Higher UOM) | `Work Order Item.required_qty ÷ Comp_CF` |
| 16 | Comp Qty Consumed (Higher UOM) | `Work Order Item.consumed_qty ÷ Comp_CF` (falls back to `transferred_qty`) |
| 17 | Comp Qty Consumed (Stock UOM) | `Work Order Item.consumed_qty` |
| 18 | Higher UOM (Comp) | largest-CF row in `tabUOM Conversion Detail` for the component |
| 19 | Stock UOM (Comp) | `Item.stock_uom` |
| 20 | Production Plan (link) | `Work Order.production_plan` |

---

## 3. Filters

| Filter | Notes |
|---|---|
| Item | Single Link → Item. Matches FG OR component (OR-join). |
| Item Group | Single Link → Item Group. Matches FG group OR component group (OR-join). |
| Warehouse | Single Link → Warehouse. Matches FG warehouse OR component source warehouse. |

---

## 4. Pending semantics — single source of truth

Pending statuses for Work Orders come from **TOC Settings** via `chaizup_toc.api.wo_kitting_api.get_toc_pending_filters()`. Workflow-state entries (prefixed `Workflow: …`) are honoured only if `Work Order.workflow_state` column exists.

---

## 5. Higher UOM picker

For each unique item across the result (FG + components), look up `tabUOM Conversion Detail` rows and pick the alt UOM with the **largest** conversion factor. Falls back to `stock_uom` (CF = 1) if no alt UOMs exist. Computed in a **single batched query** for all items in the result set — N+1 lookups would kill report runtime when hundreds of pending WOs join.

---

## 6. Roles

System Manager · Manufacturing Manager · Manufacturing User · TOC Manager · TOC User · Stock Manager.

---

## 7. Restricted (do NOT change without architectural review)

1. **Pending-status definitions** must come from `wo_kitting_api.get_toc_pending_filters()` — never hard-code. (TS-001 single source of truth.)
2. **Higher UOM picker** must remain a single batched query — N+1 kills runtime.
3. **Column shape** is referenced by procurement teams; don't reorder or rename without updating `chaizup_toc.md` AND the toc_user_guide change log.
4. **Component qty source field**: prefer `consumed_qty`, fall back to `transferred_qty` when `consumed_qty IS NULL`. ERPNext's `Work Order Item.consumed_qty` is the post-Manufacture STE figure; `transferred_qty` is the post-Material-Transfer-for-Manufacture figure.

---

## 8. Live test (2026-05-18 dev)

```
columns: 20 cols
rows:    147 component rows
summary: Component Rows=147, Pending WOs=22, Production Plans=4, Distinct Components=100

Sample first row:
  work_order        = MFG-WO-2026-00059  (Not Started)
  warehouse         = WAREHOUSE 1.9 (CZWH-5) - CCP
  produced_item     = CZPFG267 (CTC ELAICHI DUST 1 KG)
  produced_higher_uom = "CFC / Master"
  produced_default_uom = "Pcs"
  fg_qty_planned_higher = 75.0 (Cartons)
  component_item    = CZMAT/1418 (Mastercarton)
  comp_qty_planned_higher = 900.0 Pcs
```
