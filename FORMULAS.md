# Chaizup TOC — Formula Reference

**Last updated: 2026-05-14 (TS-001)** &nbsp;|&nbsp; Single source of truth for every quantity the engine computes. If a formula isn't here, it isn't authoritative — read the code (`chaizup_toc/toc_engine/production_plan_engine.py`) and add the missing row.

Companion to `chaizup_toc.md` (app root). This page is one screen tall on a 1080p monitor so it's printable / shareable with operations.

---

## Conventions

- All quantities are in **stock UOM** unless explicitly noted.
- `IFNULL(x, 0)` is the default for every nullable numeric field unless the formula needs `NULL` semantics.
- "Pending status / workflow state" eligibility is **always** read from TOC Settings (post TS-001 / 2026-05-14). The 6 fields are:
  - `projection_pending_so_statuses` (Sales Order Submitted)
  - `projection_confirmed_so_workflow_states` (Sales Order Draft + workflow_state)
  - `pending_wo_statuses` / `pending_wo_workflow_states`
  - `pending_po_statuses` / `pending_po_workflow_states`

---

## A. TOC Buffer (F-series)

| ID | Name | Formula | Where |
|---|---|---|---|
| **F1** | Target Buffer | `ADU × RLT × VF` | `buffer_calculator._target_buffer()` |
| **F2** | Inventory Position (IP) | `on_hand + wip + on_order − backorders − committed` | `buffer_calculator._position()` |
| **F3** | Buffer Penetration % | `(Target − IP) / Target × 100` | engine result dict `bp_pct` |
| **F4** | Order Qty | `max(Target − IP, 0)` | result dict `order_qty` |
| **F5** | T/CU (priority tie-break) | `(Selling Price − TVC) × Constraint Speed` | result dict `tcu` |
| **F6** | Demand Adjustment Factor (DAF) | constant from `TOC Settings.default_daf` multiplied into F1 | `_target_buffer` (multiplied via DAF) |
| **F7** | DBM up-shift | if BP% ≥ red threshold for ≥ N days → `target × 1.20` | `dbm_engine.weekly_dbm_check` |
| **F8** | DBM down-shift | if BP% < green threshold for ≥ M days → `target × 0.85` | same |

### Zone classification (from F3)

```
F3 = bp_pct
Green:  bp_pct < TOC Settings.green_threshold       (default 33%)
Yellow: green ≤ bp_pct < TOC Settings.red_threshold (default 67%)
Red:    red   ≤ bp_pct < 100%
Black:  bp_pct ≥ 100%
```

---

## B. ADU & Max Level (per Item Minimum Manufacture row)

Two ADU writers:

| Writer | Scope | When | Field set |
|---|---|---|---|
| `tasks.daily_tasks.daily_adu_update` | Item-level (`custom_toc_adu_value`) | 06:30 cron | `Item.custom_toc_adu_value`, `Item.custom_toc_adu_last_updated` |
| `tasks.daily_tasks.update_min_mfg_adu_levels` | Per `Item Minimum Manufacture` row | 06:35 cron | row `adu`, `adu_lookback_days`, `max_level`, `last_updated_on` |

### B.1 Daily ADU (universal, item-level)

```
period = Item.custom_toc_adu_period or "Last 90 Days"
days   = {30, 90, 180, 365} per period
from_date = today - days

ADU = ABS(SUM(SLE.actual_qty where actual_qty < 0 AND posting_date in [from_date, today])) / days
```

Skipped when `Item.custom_toc_custom_adu = 1` (user enters value manually).

### B.2 MinMfg ADU (per row, per warehouse)

```
lookback = TOC Settings.adu_lookback_days   (default 90)
from_date = today - lookback

For each row where warehouse IS NOT NULL AND auto_adu = 1:
  earliest = MIN(SLE.posting_date) for (item, warehouse, actual_qty<0, not cancelled)
  if earliest IS NULL OR earliest > from_date:
      skip — "warming up" (row left untouched)

  total_out = ABS(SUM(SLE.actual_qty where (item, warehouse, actual_qty<0, not cancelled, posting_date in [from_date, today])))
  adu       = total_out / lookback
  row.adu               = round(adu, 4)
  row.adu_lookback_days = lookback
  row.max_level         = round(adu × lead_time_days × safety_factor, 3)
  row.last_updated_on   = now()
```

`safety_factor` defaults to 1.0 when blank.

### B.3 MOQ floor conversion (stock UOM)

```
For each Item Minimum Manufacture row:
  if row.uom == Item.stock_uom: MINMFG_stock_uom = row.min_manufacturing_qty
  else: cf = UOM Conversion Detail.conversion_factor (parent=item, uom=row.uom) or 1.0
        MINMFG_stock_uom = row.min_manufacturing_qty × cf
```

---

## C. Sales Projection automation — Calc A + Calc B

Per `Sales Projected Items` row, scoped to `(item, source_warehouse)`. Calc A runs first → commit → Calc B re-reads ITMWO / ITMWSTK fresh.

> **PHASE 2 gate (2026-06-03) — applies to Calc A/B, Calc SO and Calc Action.**
> Before creating ANY voucher the engine checks the Item-master replenishment
> mode and the per-warehouse Minimum Qty:
> 1. **Replenishment mode** from `Item.custom_toc_auto_manufacture` /
>    `custom_toc_auto_purchase`. Neither set → skip + log
>    *"Skipped - No Replenishment Mode"* (monitor-only item, no voucher).
>    The flag decides the voucher TYPE (not the per-row `action_type`).
> 2. **Per-warehouse Min Qty** from `Item Minimum Manufacture.min_manufacturing_qty`
>    for that `(item, warehouse)`. 0/unset → skip + log *"Skipped - Min Qty Not Set"*.
>
> **Manufacture mode** → Production Plan + Work Orders (per item).
> **Purchase mode** → the purchased item's shortage is added to ONE consolidated
> Material Request raised per run (all purchase-mode items pooled). Purchase-mode
> supply = `stock + open PO`; shortage = `max(Calc A, Calc B)`; qty = `max(shortage, MOQ)`.

### Variable definitions (stock UOM)

| Symbol | Meaning | Source |
|---|---|---|
| `SPOW` | Sales Projection of warehouse | `Sales Projected Items.qty_in_stock_uom` |
| `PRVSO` | Previous-month pending SO qty | SOI sum where delivery_date < month_start AND warehouse=sp.source_warehouse AND status ∈ pending |
| `CURRSO` | Current-month pending SO qty | SOI sum where delivery_date ∈ month AND warehouse=sp.source_warehouse AND status ∈ pending |
| `CURRALSO` | Current-month ALL SO qty (excl. Cancelled/Closed) | SOI sum where delivery_date ∈ month AND warehouse=sp.source_warehouse |
| `ITMWO` | Pending WO qty at fg_warehouse | Σ `wo.qty − produced_qty` where pending per TOC Settings |
| `ITMWSTK` | Current stock | `Bin.actual_qty` for (item, warehouse) |
| `MINMFG` | MOQ floor in stock UOM | B.3 |

Pending qty in SO sums always uses `soi.stock_qty − delivered_qty × conversion_factor` (stock UOM safe — multi-UOM lines on the same item sum correctly).

### Calc A (forecast shortage)

```
Qty_of_shortage_A = (SPOW + PRVSO) − (CURRALSO + ITMWO + ITMWSTK)
if A > 0:
  production_qty = max(A, MINMFG)
  create Production Plan (custom_creation_reason starts "[Calc A]")
  → submit PP → make_work_order() for FG + sub-assembly levels
else:
  log Skipped - No Shortage
```

### Calc B (SO over-projection safety net)

```
# Re-read ITMWO and ITMWSTK after Calc A commit
Qty_of_shortage_B = (PRVSO + CURRSO) − (ITMWSTK + ITMWO)
if B > 0:
  production_qty = max(B, MINMFG)
  create PP (reason starts "[Calc B]") → submit → WOs
else:
  log Skipped - No Shortage
```

**Critical**: the `frappe.db.commit()` between Calc A and Calc B is load-bearing — without it Calc B sees stale `ITMWO` and double-creates the shortage.

### Dedup (Calc A and Calc B)

Per (projection × item × calc): match `custom_creation_reason LIKE '%[Calc A]%'` (or `[Calc B]`) on non-cancelled PPs. Already-existing → `Skipped - PP Exists`.

---

## D. Sales Order Shortage — Calc SO (Shortage Cover)

Independent of any Sales Projection. Scans EVERY pending SO across the company.

### D.1 Pair discovery

```
pairs = SELECT
  soi.item_code, soi.item_name,
  COALESCE(NULLIF(soi.warehouse,''), NULLIF(so.set_warehouse,''), default_so_warehouse) AS warehouse,
  SUM(soi.stock_qty − delivered_qty × conversion_factor) AS pending_qty
FROM tabSales Order Item soi
JOIN tabSales Order so ON so.name = soi.parent
WHERE (PATH A: docstatus=0 AND workflow_state IN configured_states  -- only if workflow_state column exists
       OR PATH B: docstatus=1 AND status IN configured_pending)
  AND soi.stock_qty > delivered_qty × conversion_factor
GROUP BY soi.item_code, <warehouse expression>
HAVING pending_qty > 0
```

`pending_qty` is **already in stock UOM** because the SQL uses `stock_qty` (= qty × cf).

### D.2 Per-pair logic

```
For each pair (item × warehouse):
  stock     = Bin.actual_qty at warehouse
  open_wo   = pending_wo_qty (per TOC Settings)
  open_po   = open_po_qty   (per TOC Settings)            # added 2026-06-03
  shortage  = pending_qty − stock − open_wo − open_po     # supply now incl PO
  minmfg    = _build_min_mfg_index(item)[warehouse].min_qty_stock_uom or 0

  if shortage ≤ 0:
      log Skipped - No Shortage; continue

  # PHASE 2 gate (2026-06-03) — voucher type from Item master, not action_type:
  action = Manufacture if Item.custom_toc_auto_manufacture
           else Purchase if Item.custom_toc_auto_purchase
           else None
  if action is None:  log Skipped - No Replenishment Mode; continue
  if minmfg ≤ 0:      log Skipped - Min Qty Not Set;       continue

  qty = max(shortage, minmfg)

  if action == "Purchase":
      if _shortage_cover_artifact_exists(item, wh, "Purchase"): Skipped - MR Exists
      else: _create_purchase_mr_for_shortage(item, qty, wh, ...) → log Created (MR)

  if action == "Manufacture":
      bom = active default submitted BOM for item
      if not bom: Skipped - No BOM
      elif _so_shortage_pp_exists(item, wh): Skipped - PP Exists
      else: _create_production_plan + _submit_pp_and_create_work_orders → log Created (PP)
```

### D.3 MR Purchase UOM conversion (`_create_purchase_mr_for_shortage`)

```
purchase_uom = Item.purchase_uom or stock_uom
cf           = UOM Conversion Detail.conversion_factor (parent=item, uom=purchase_uom) or 1.0
if cf > 0 and cf != 1.0:
  mr_qty = qty_in_stock_uom / cf
  unit   = purchase_uom
else:
  mr_qty = qty_in_stock_uom
  unit   = stock_uom

MR line: { qty=mr_qty, uom=unit, stock_uom=stock_uom, conversion_factor=cf, warehouse, ... }
mr.schedule_date = today + max(1, lead_time_days)
mr.custom_toc_recorded_by = "By System"   # so existing TOC reports recognise the doc
```

---

## E. Shortage Action — Calc Action (per Item Min-Mfg row)

Iterates `tabItem Minimum Manufacture` rows where `auto_on_shortage=1 OR auto_on_max_level=1`. Two modes, evaluated in order — first fires wins.

### E.1 Per-row inputs

```
stock        = Bin.actual_qty at row.warehouse
open_wo      = pending_wo_qty       (engine: TOC Settings WO eligibility)
open_po      = pending_po_qty       (engine: TOC Settings PO eligibility)
wo_required  = SUM(GREATEST(woi.required_qty − transferred_qty, 0))
                  from tabWork Order Item woi
                  filtered by source_warehouse=row.warehouse AND parent WO eligibility
pending_so   = stock-UOM-safe pending SO qty at row.warehouse (Calc B style)
max_level    = row.max_level   (B.2 — engine-owned)
minmfg       = row.min_qty_stock_uom
threshold    = row.max_level_threshold_pct
```

### E.2 Mode 1 — Shortage (only when `auto_on_shortage=1`)

```
supply   = stock + open_wo + open_po          # open_po added 2026-06-02
demand   = pending_so + wo_required
shortage = demand − supply
if shortage > 0:
    qty = max(shortage, minmfg)
    mode_used = "Shortage"
```

### E.3 Mode 2 — Max Level (only when Mode 1 did NOT fire AND `auto_on_max_level=1` AND `max_level > 0`)

```
cover      = (stock + open_wo + open_po) − (pending_so + wo_required)
cover_pct  = cover / max_level × 100
if cover_pct < threshold:
    qty = max(max_level − cover, minmfg)
    mode_used = "Max Level"
```

### E.4 Dispatch (when `mode_used` is set)

```
If _shortage_action_artifact_exists(item, wh, action_type): Skipped - (PP|MR) Exists
Else:
  If action_type == "Purchase": _create_purchase_mr_for_shortage(...)
  If action_type == "Manufacture":
      bom = active default submitted BOM
      if not bom: Skipped - No BOM
      else: _create_production_plan(...) → _submit_pp_and_create_work_orders(...)

Stamp Item Minimum Manufacture.last_updated_on = now() on every evaluated row
(including no-fire rows — so users see engine activity without checking the Run Log).
```

---

## F. Engine SQL eligibility builders (TS-001 / BTP-001)

The engine no longer hardcodes status sets. The four predicates are:

### F.1 Sales Order eligibility (`_so_status_clause`)

```sql
PATH B: (so.docstatus = 1 AND so.status IN (pending_statuses))
   OR
PATH A: (so.docstatus = 0 AND so.workflow_state IN (confirmed_states))
        -- only when frappe.db.has_column("Sales Order", "workflow_state")

empty → "1=0"
```

### F.2 Work Order eligibility (`_wo_eligibility_sql`)

```sql
(wo.docstatus = 1 AND wo.status IN (pending_wo_statuses))
   OR
(wo.docstatus = 0 AND wo.workflow_state IN (pending_wo_workflow_states))
        -- only when has_column("Work Order", "workflow_state")

empty → "1=0"
```

### F.3 Purchase Order eligibility (`_po_eligibility_sql`)

```sql
(po.docstatus = 1 AND po.status IN (pending_po_statuses))
   OR
(po.docstatus = 0 AND po.workflow_state IN (pending_po_workflow_states))
        -- only when has_column("Purchase Order", "workflow_state")

empty → "1=0"
```

### F.4 Defaults when TOC Settings field is blank

| Predicate | Default list |
|---|---|
| SO pending | `To Deliver and Bill / To Deliver / On Hold` |
| SO workflow | `Confirmed` |
| WO pending | `Not Started / In Process / Material Transferred` |
| WO workflow | empty |
| PO pending | `To Receive / To Receive and Bill` |
| PO workflow | empty |

Match the historical hardcoded lists so existing sites see no behaviour change.

---

## G. Connected docs by trigger

When `<trigger>` fires, these docs may be written. Use this when auditing "what just changed?"

| Trigger | Docs created / updated |
|---|---|
| 02:00 cron Projection Automation | Production Plan, Work Order, Material Request (sub-assembly only via PP submit), TOC Production Plan Run Log + Item, Sales Projected Items (`wo_name`, `wo_status`), Sales Projection (`last_auto_run`) |
| 06:30 cron Daily ADU | Item (`custom_toc_adu_value`, `custom_toc_adu_last_updated`) |
| 06:35 cron MinMfg ADU + Max Level | Item Minimum Manufacture (`adu`, `adu_lookback_days`, `max_level`, `last_updated_on`) |
| 07:00 cron TOC MR generator | Material Request (Purchase / Manufacture), TOC Buffer Log |
| 08:00 cron Buffer snapshot | TOC Buffer Log |
| Sun 09:00 Weekly DBM | Item (`custom_toc_target_buffer`) |
| Manual Run Now (Projection) | Same as 02:00 cron |
| Manual Run Sales Order Shortage Now | Production Plan / Material Request (action-aware), Work Order (only if PP), TOC Production Plan Run Log + Item |
| Manual Run Shortage Action Now | Same as Calc SO + stamps `Item Minimum Manufacture.last_updated_on` |
| Production Plan submit | Work Order (FG + sub-assembly), via ERPNext pipeline |
| Production Plan cancel | `Sales Projected Items.wo_name / wo_status` cleared (PP→SP back-link) |
| Sales Projection cancel | `flags.ignore_links = True` skips the SP→PP back-link guard |

---

## H. Where to read each formula in code

| Section | File: function |
|---|---|
| F1 Target Buffer | `toc_engine/buffer_calculator.py:_target_buffer` |
| F2 IP | `:_position` |
| F3 BP%, zone | `:_zone_and_bp` |
| F4 Order Qty | `:_order_qty` |
| F5 T/CU | computed inline in `chaizup_toc.overrides.item.on_item_validate` |
| F7/F8 DBM | `toc_engine/dbm_engine.py` |
| B.1 Daily ADU | `tasks/daily_tasks.py:daily_adu_update` |
| B.2 MinMfg ADU | `tasks/daily_tasks.py:update_min_mfg_adu_levels` |
| B.3 MOQ stock-UOM | `toc_engine/production_plan_engine.py:_build_min_mfg_map` + `_build_min_mfg_index` |
| C Calc A / Calc B | `toc_engine/production_plan_engine.py:_process_item_v2` |
| D Calc SO | `:_discover_pending_so_pairs` + `:run_so_shortage_automation` |
| E Calc Action | `:run_shortage_action_automation` |
| F.1 SO eligibility | `:_so_conditions_and_params` + `:_so_status_clause` |
| F.2 WO eligibility | `:_wo_eligibility_sql` |
| F.3 PO eligibility | `:_po_eligibility_sql` |
| D.3 MR Purchase UOM conv. | `:_create_purchase_mr_for_shortage` |
| TS-001 Banner endpoint | `api/wo_kitting_api.py:get_toc_pending_filters` |
