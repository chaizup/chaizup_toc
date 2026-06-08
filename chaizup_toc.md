# chaizup_toc — App Root Reference

**Generated: 2026-05-14 (TS-001)** &nbsp;|&nbsp; **Maintainer note:** this file is the single canonical entry point for the whole TOC app. It covers feature index, formulas, navigation, scenarios, and the jargon glossary. The Python package at `chaizup_toc/chaizup_toc/` has its own deeper module-level docs.

---

## 1. Why this app exists

Chaizup TOC is a Theory-of-Constraints add-on for ERPNext that automates four jobs the standard manufacturing flow does poorly:

1. **Demand-driven Material Requests** — keep inventory in dynamic buffers instead of fixed reorder points.
2. **Production planning at the item × warehouse level** — turn submitted *Sales Projections* and pending *Sales Orders* into Draft Production Plans automatically.
3. **One source of truth for "what counts as pending"** — Sales Order / Work Order / Purchase Order status filters are configured once in TOC Settings and shared across every report and scheduled job.
4. **Audit-grade run logs** — every automation run writes one `TOC Production Plan Run Log` row per pass with per-item child rows so a missed PP can always be traced.

---

## 2. Top-level navigation (post TS-001)

| Path | Purpose | UI Module |
|---|---|---|
| `/app/toc-settings` | **Single source of truth** for pending SO/WO/PO statuses, projection automation, AI key, demo data | `TOC Settings` (singleton DocType) |
| `/app/toc-item-settings` | Bulk Item TOC configuration (TOC enable, ADU period, BOM check, Min-Mfg fields) | Page |
| `/app/toc-dashboard` | TOC zone + buffer board (Mode column = Manufacture / Purchase / Monitor) | Page |
| `/app/wo-kitting-planner` | WO Kitting Planner — 7 tabs (Production Plan, Material Shortage, Emergency, Dispatch, AI, Item View, Purchase Priority) | Page |
| `/app/production-overview` | Production Overview — 3 tabs (Overview, AI Advisor, Charts) | Page |
| `/app/sales-projection` | Sales Projection DocType + "Run Production Plan Automation" button (per-projection) | DocType |
| `/app/toc-production-plan-run-log` | Audit log of every automation run | DocType |
| `/app/toc-user-guide` | End-user help (calculators, glossary, change log) | Page |
| `/app/supply-chain-tracker` | End-to-end MR → RFQ → SQ → PO → PR / WO → JC pipeline | Page |
| `/app/item-projection-view` | **Item Projection View** — Higher-UOM stock + inflows − demand grid; per-cell formula tooltip + voucher drill-down; branded multi-sheet XLSX (added 2026-05-18) | Page |
| `/app/item-short-surplus` | **Item Short / Surplus** — item-wise shortage/surplus with multi-select pending-status + workflow_state filters, warehouse + company scope, 6 boolean toggles (active/no SO/WO/PO), sortable + sticky-header + word-wrap table, per-cell drill-down to voucher detail, 4-sheet XLSX export. LIVE filters (no stored mirrors). (added 2026-05-27, v0.0.22) | Page |
| `/app/query-report/Production Indent Subs` | **Production Indent Subs** — per-WO bill of components for TOC-Pending WOs. Higher + stock UOM qty; FG identity, MRP, group; component identity, group; PP link. (added 2026-05-18) | Script Report |

---

## 3. Feature index — entry points + triggers + run-log marker

This table is the canonical "what runs, when, and how" reference. Update it whenever a new automation lands.

| Feature | Entry point | Trigger | Run-Log marker | Where it writes |
|---|---|---|---|---|
| **Calc A** (forecast shortage) | `production_plan_engine.run_projection_automation_for_all_warehouses` (cron+button) | 02:00 AM daily + manual via Sales Projection form | `[Calc A]` in `Production Plan.custom_creation_reason` | Production Plan (Draft → Submitted) + Work Orders + TOC Production Plan Run Log |
| **Calc B** (SO over-projection safety net) | same — runs after Calc A commit per item | same | `[Calc B]` | same |
| **Calc SO** (Shortage Cover — independent of projection) | `run_so_shortage_automation` | TOC Settings *Run Sales Order Shortage Now* button | `[Calc SO]` | PP (Manufacture) **or** MR Purchase (Purchase) per `Item Minimum Manufacture.action_type` |
| **Calc Action** (Shortage Action — auto-monitor per Item Min-Mfg row) | `run_shortage_action_automation` | TOC Settings *Run Shortage Action Now* button | `[Calc Action]` | PP **or** MR Purchase per `action_type` |
| **Daily ADU update** (Item TOC) | `tasks.daily_tasks.daily_adu_update` | 06:30 AM cron | n/a | `Item.custom_toc_adu_value`, `custom_toc_adu_last_updated` |
| **Daily MinMfg ADU + Max Level** | `tasks.daily_tasks.update_min_mfg_adu_levels` | 06:35 AM cron | n/a | `Item Minimum Manufacture.adu / adu_lookback_days / max_level / last_updated_on` |
| **Daily Production Run** (TOC buffer MRs) | `tasks.daily_tasks.daily_production_run` → `mr_generator.generate_material_requests` | 07:00 AM cron | n/a | Material Request (Purchase or Manufacture) per TOC buffer zone |
| **Procurement Monitoring** | `tasks.daily_tasks.daily_procurement_run` | 07:30 AM cron | n/a | Logger only |
| **Buffer snapshot** | `tasks.daily_tasks.daily_buffer_snapshot` | 08:00 AM cron | n/a | `TOC Buffer Log` |
| **Weekly DBM** | `tasks.daily_tasks.weekly_dbm_check` | Sun 09:00 AM cron | n/a | `Item.custom_toc_target_buffer` adjustments |
| **Min Order Sync** | `toc_engine.min_order_sync.daily_min_order_sync` | 00:00 cron | n/a | `Item.custom_min_order_qty` |

---

## 4. Formulas

### 4.1 TOC buffer (the F-series)

```
F1  Target Buffer        = ADU × RLT × VF
F2  Inventory Position   = OnHand + WIP + OnOrder − Backorders − Committed
F3  Buffer Penetration%  = (Target − IP) / Target × 100
F4  Order Qty            = max(Target − IP, 0)
F5  T/CU                 = (Selling Price − TVC) × Constraint Speed       (priority tie-break)
F6  Demand Adj. Factor   = global DAF in TOC Settings (e.g. 1.6 for Diwali)
F7  DBM up-shift         = if BP > Red threshold for N days → Target × 1.2
F8  DBM down-shift       = if BP < Green threshold for M days → Target × 0.85
```

Zones (post-F3):
- Green: BP% < TOC Settings.green_threshold (default 33%)
- Yellow: green ≤ BP% < red (default 33–67%)
- Red: red ≤ BP% < black (default 67–100%)
- Black: BP% ≥ 100

### 4.2 Sales Projection — Calc A (forecast shortage, per projection row)

```
ITMWSTK = Bin.actual_qty at projection.source_warehouse
ITMWO   = Σ open WO (qty − produced_qty) at fg_warehouse=source_warehouse
            (eligibility from TOC Settings.pending_wo_statuses + pending_wo_workflow_states)
PRVSO   = Σ pending SO qty (stock_qty − delivered_qty × cf)
            where delivery_date < month_start AND warehouse matches
CURRALSO = Σ ALL current-month SO qty (no status filter)
SPOW    = Sales Projected Items.qty_in_stock_uom for THIS projection row

Qty_of_shortage_A = (SPOW + PRVSO) − (CURRALSO + ITMWO + ITMWSTK)
if A > 0 → production_qty = max(A, MINMFG_per_warehouse)
       → create Production Plan + Work Orders (custom_creation_reason starts "[Calc A]")
```

### 4.3 Sales Projection — Calc B (SO safety net, per projection row, runs after Calc A commits)

```
ITMWO ← re-read (Calc A's just-created WO is now visible)
ITMWSTK ← re-read

Qty_of_shortage_B = (PRVSO + CURRSO) − (ITMWSTK + ITMWO)
if B > 0 → production_qty = max(B, MINMFG)
       → create PP (reason starts "[Calc B]")
```

### 4.4 Sales Order Shortage — Calc SO (Shortage Cover, no projection)

For every (item × warehouse) pair with pending SO qty:

```
pending_so_qty  = Σ (soi.stock_qty − delivered_qty × cf)
                     over SO lines matching TOC Settings pending SO statuses
                     scoped by COALESCE(soi.warehouse, so.set_warehouse, default_so_warehouse)
stock           = Bin.actual_qty at that warehouse
open_wo         = Σ open WO (qty − produced_qty) at fg_warehouse

shortage = pending_so − stock − open_wo

if shortage > 0:
   qty = max(shortage, MINMFG_in_stock_uom)
   if action_type = Purchase  → MR Purchase via _create_purchase_mr_for_shortage
                                   (qty / Item.purchase_uom conversion_factor)
   if action_type = Manufacture → PP via _create_production_plan + WOs
```

### 4.5 Item Min-Mfg auto-trigger — Calc Action (Shortage Action)

Iterates `Item Minimum Manufacture` rows where `auto_on_shortage = 1` OR `auto_on_max_level = 1`. Two modes (Shortage first, then Max-Level if not fired):

```
# Mode 1 — Shortage
supply = stock + open_wo_output
demand = pending_so + wo_required_components       # WO comp req filtered by source_warehouse
shortage = demand − supply
if shortage > 0:  qty = max(shortage, MOQ)  → create artifact per action_type

# Mode 2 — Max Level
cover = (stock + open_wo + open_po) − (pending_so + wo_required)
cover_pct = cover / max_level × 100
if cover_pct < row.max_level_threshold_pct:
   qty = max(max_level − cover, MOQ)  → create artifact per action_type
```

`max_level` itself: `ADU × lead_time_days × safety_factor`, refreshed by the 06:35 AM cron when `auto_adu = 1` AND `MIN(SLE.posting_date) ≤ today − adu_lookback_days`.

### 4.6 Min Order Qty (MOQ) floor — stock-UOM resolution

```
For each Item Minimum Manufacture row:
  if row.uom == Item.stock_uom: MINMFG_stock_uom = row.min_manufacturing_qty
  else: MINMFG_stock_uom = row.min_manufacturing_qty × UOM Conversion Detail.conversion_factor
                                                       (parent=item, uom=row.uom)
```

Used by Calc A / B / SO / Action so a row configured as "50 Kg" is correctly compared against shortages computed in the item's stock UOM ("Gram").

---

## 5. Pending-status semantics (post TS-001 — 2026-05-14)

TOC Settings is the SINGLE source of truth for pending Sales Order / Work Order / Purchase Order eligibility. Every report (WKP, Production Overview, scheduled runs, Reports) reads from the same 6 fields:

| Field | Default | Read by |
|---|---|---|
| `projection_pending_so_statuses` | `To Deliver and Bill / To Deliver / On Hold` | All SO-pending queries |
| `projection_confirmed_so_workflow_states` | `Confirmed` | Same; only when `tabSales Order` has a `workflow_state` column |
| `pending_wo_statuses` | `Not Started / In Process / Material Transferred` | `_pending_wo_qty`, `_wo_required_component_qty`, WKP supply pool, POR incoming-WO column |
| `pending_wo_workflow_states` | empty | Same; only when WO has `workflow_state` |
| `pending_po_statuses` | `To Receive / To Receive and Bill` | `_open_po_qty`, Calc Action max-level mode, POR "Incoming (Purchase)" column |
| `pending_po_workflow_states` | empty | Same; only when PO has `workflow_state` |

The WKP and Production Overview pages **no longer expose status pickers**. Each page shows a read-only "Active Pending Filter" banner (3 chip groups + an "Edit in TOC Settings" link) populated by the shared whitelist `chaizup_toc.api.wo_kitting_api.get_toc_pending_filters`.

---

## 6. Jargon glossary (short forms)

| Abbrev | Full name | Meaning |
|---|---|---|
| **ADU** | Average Daily Usage | Daily consumption rate over a lookback window |
| **BP%** | Buffer Penetration % | How deep into the target buffer the stock has fallen |
| **DAF** | Demand Adjustment Factor | Global multiplier on F1 for seasonal demand swings |
| **DBM** | Dynamic Buffer Management | Weekly target buffer auto-tuning (F7 / F8) |
| **IP** | Inventory Position | OnHand + WIP + OnOrder − Backorders − Committed |
| **MOQ** | Minimum Order Quantity | Floor on PP / MR qty per warehouse |
| **MR** | Material Request | ERPNext doc, type Purchase or Manufacture |
| **PP** | Production Plan | ERPNext doc that spawns Work Orders |
| **POR** | Production Overview | Page `/app/production-overview` |
| **RLT** | Replenishment Lead Time | Days from order to receipt at warehouse |
| **SR%** | Stock Remaining % | IP ÷ Target |
| **T/CU** | Throughput per Constraint Unit | F5 priority tie-break for manufactured items |
| **TVC** | Totally Variable Cost | Per-unit material + variable processing cost |
| **VF** | Variability Factor | Safety multiplier in F1 |
| **WIP** | Work In Process | Items consumed in open WOs, not yet finished |
| **WKP** | WO Kitting Planner | Page `/app/wo-kitting-planner` |
| **WO** | Work Order | ERPNext doc for one manufacturing run |

---

## 7. Scenario matrix

Symbols: ✓ = live-verified in dev replica · ⏳ = pending (next session) · ↻ = idempotent (dedup re-run).

| # | Scenario | Engine | Expected outcome | Status |
|---|---|---|---|---|
| 1 | Submit a Sales Projection for current month, click "Run Production Plan Automation" | Calc A + Calc B | Run Log written with per-item rows, PP + WO created for forecast shortage | ✓ |
| 2 | Same projection but actual SOs > projected (over-projection bug-fix test) | Calc A skips, Calc B creates PP for residual | ✓ |
| 3 | TOC Settings *Run Sales Order Shortage Now* with no min-mfg rows configured | Calc SO | Defaults Manufacture; PPs created for items with `pending − stock − open_wo > 0`, else `Skipped - No Shortage` | ✓ |
| 4 | Same row but `Item Minimum Manufacture.action_type = Purchase` | Calc SO | Material Request (Purchase) written with `qty / Item.purchase_uom.cf` | ↻ (engine path verified; live MR seeded under SPA-001 smoke) |
| 5 | Calc SO re-run | Dedup | All previously created artifacts skipped via `[Calc SO]` marker | ✓ |
| 6 | TOC Settings *Run Shortage Action Now* with `auto_on_shortage=1` on a stockless item | Calc Action shortage mode | PP / MR created at `max(shortage, MOQ)` | ⏳ (helper path verified; no current seed row) |
| 7 | Same but `auto_on_max_level=1, threshold=90%, max_level=10000` | Calc Action max-level mode | PP / MR created at `max(max_level − cover, MOQ)` | ✓ (SPA-001 smoke `MFG-PP-2026-00068`) |
| 8 | Calc Action re-run | Dedup | `Skipped - PP Exists` / `Skipped - MR Exists` | ✓ |
| 9 | Add a custom WO status "Awaiting QC" to `pending_wo_statuses`; run Calc A | Engine | WOs in that status now count toward `ITMWO` | ⏳ (helper verified; not seeded with a "Awaiting QC" WO) |
| 10 | Daily 06:30 ADU update on Item with `custom_toc_custom_adu=0` | Universal SLE outflows | `custom_toc_adu_value` updated, `custom_toc_adu_last_updated` stamped | ↻ (production cadence; helper smoke-tested) |
| 11 | Daily 06:35 MinMfg ADU + Max Level refresh | Engine | `adu / adu_lookback_days / max_level / last_updated_on` updated only for `auto_adu=1` rows with full history | ✓ (IMM-003 smoke) |
| 12 | UOM gate on Item Minimum Manufacture | validate | Reject row with UOM not in `Item.uoms` | ✓ (IMM-001) |
| 13 | Cancel a Sales Projection that already produced PPs | doc_event | PP `before_cancel` clears SP child `wo_name` / `wo_status` so SP cancel does not deadlock | ✓ |

Lines marked ⏳ require seeding specific Item / Warehouse / WO combinations that don't currently exist on the dev replica. The engine code path is exercised by the helper-level smoke tests already in `/tmp/_*smoke*.py`.

---

## 8. Restricted areas (do not change)

These call-outs are absolute. Every change request that touches one should be cross-checked against this list.

- **`buffer_calculator.py` result dict** — `"mr_type"` is canonical, `"buffer_type"` key is gone (BTP-001). Adding it back re-enables dead FG/SFG/RM/PM paths.
- **TOC Settings as single source of truth** (TS-001) — never re-add per-report status pickers. The 6 status fields in TOC Settings drive every report.
- **Calc-SO / Calc-Action dedup markers** — `[Calc SO]` vs `[Calc Action]` MUST stay distinct (different lifecycles). Reusing one marker breaks dedup.
- **Sales-Order pending-qty SQL** — always `soi.stock_qty − delivered_qty × conversion_factor`. Substituting `soi.qty` mixes transaction UOMs.
- **WO-required-component query** — must filter `source_warehouse` (else multi-warehouse double-count).
- **`_create_purchase_mr_for_shortage`** — must divide qty by `UOM Conversion Detail.conversion_factor` to write the MR in `Item.purchase_uom`.
- **MOQ floor** — must convert `row.min_manufacturing_qty × cf` to stock UOM before comparing with shortages.
- **PP `skip_available_sub_assembly_item = 0`** — TOC formula is the SoT for sub-assembly qty; turning the flag back on double-counts via `Bin.projected_qty`.
- **`update_modified=False`** on every daily-task write — keeps audit history clean. Removing it bumps `Item.modified` on every cron tick.
- **HTML: zero raw apostrophes** in any Frappe Page HTML body (POR-023). One escaped apostrophe in a `<style>` CSS comment terminates the JS wrap and blanks the page.
- **`pending_*_status` `_parse_*` helpers must fall back to canonical defaults**, never `[]`. Empty list at the SQL helper short-circuits to `1=0` (safe), but the per-call default is the back-compat contract.
- **Workflow-state branches** in `_so_status_clause / _wo_eligibility_sql / _po_eligibility_sql` must stay `has_column`-gated. Sites without an SO/WO/PO Workflow do not have the column.
- **Run-Log per-iteration counter save** in shortage engines must be ONE closing save (SPE-001 fix). Per-iteration save inside `try/except` is bypassed by `continue` in skip branches and produces counter desync.

---

## 9. Where to look when something is wrong

| Symptom | Open this first |
|---|---|
| Daily PPs not appearing | `TOC Production Plan Run Log` for today's date, filter `triggered_by = cron` |
| MR not created for a known shortage | `Item Minimum Manufacture.action_type` for that item/warehouse; check if `auto_on_*` is on |
| Counts diverge between reports | Verify TOC Settings status fields; remember TS-001 makes those the only authoritative source |
| Page blank after click (POR-023 / SyntaxError) | `production_plan_engine.md` POR-023 section — find the rogue apostrophe |
| Negative cover_pct on Calc Action | `max_level = ADU × lead × safety` may be 0 if ADU still in warm-up; force-set ADU or wait for full history |
| Calc SO creates MR but in wrong UOM | `Item.purchase_uom` + `UOM Conversion Detail` for the item; `_create_purchase_mr_for_shortage` divides by conversion_factor |

---

## 10. Cross-reference — deep docs by module

- **Engine**: `chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.md` — formulas, run-log shape, all RESTRICT lists
- **WKP**: `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.MD`
- **POR**: `chaizup_toc/chaizup_toc/page/production_overview/production_overview.md`
- **User Guide**: `chaizup_toc/chaizup_toc/page/toc_user_guide/toc_user_guide.html` (rendered) + `.md`
- **TOC Item Settings**: `chaizup_toc/chaizup_toc/page/toc_item_settings/toc_item_settings.md`
- **Top-level package**: `chaizup_toc/chaizup_toc.md` (internal API surface)
- **Memory (per-AI)**: `/workspace/development/frappe-bench/.claude/memory/app_chaizup_toc.md` + `/home/frappe/.claude/projects/-workspace/memory/app_chaizup_toc.md`

---

## 11. Change log of cross-feature changes (Sync Blocks)

Recent cross-feature change sets that touch ≥3 layers. Each row points at the deep doc that holds the full story.

| Tag | Date | Headline | Deep doc |
|---|---|---|---|
| ADU-PW | 2026-06-02 | Item-level ADU fields removed; ADU per-warehouse only (Item Minimum Manufacture), single 01:00 cron | `tasks/tasks.md` |
| PHASE2 | 2026-06-03 | Replenishment-mode + Min-Qty gate on every voucher engine; Calc A/B purchase → consolidated MR; Shortage Action/Calc SO supply += open PO; every job writes a run log | `production_plan_engine.md` + `tasks/tasks.md` + `doctype/doctype.md` |
| TS-001 | 2026-05-14 | TOC Settings as single source of truth; WKP+POR status pickers removed → read-only banners | this file + `production_plan_engine.md` |
| BTP-001 | 2026-05-14 | FG/SFG/RM/PM "buffer_type" fully retired; configurable WO/PO pending statuses added | `production_plan_engine.md` |
| SPA-001 | 2026-05-14 | Action-aware Shortage Cover + new Shortage Action engine (Calc Action) | `production_plan_engine.md` |
| SPE-001 | 2026-05-13 | Manual SP-form run-log fix + standalone Sales Order Shortage engine (Calc SO) | `production_plan_engine.md` |
| IMM-003 | 2026-05-13 | Per-row Auto-ADU toggle + history gate + bulk UI on Item Minimum Manufacture | `production_plan_engine.md` + `toc_item_settings.md` |
| IMM-002 | 2026-05-13 | ADU-driven max_level + daily refresh; supersedes IMM-001 qty-based formula | `production_plan_engine.md` |
| IMM-001 | 2026-05-13 | UOM gate + 3 new columns on Item Minimum Manufacture | `production_plan_engine.md` |
| WKP-035 / WKP-036 | 2026-05-13 | Search × Details interaction fix + tab-relevant chrome + clickable tab-scoped cards | `wo_kitting_planner.MD` |
| WKP-034 | 2026-05-13 | (Superseded by TS-001) User-selectable WO/SO/PO statuses with workflow_state surfacing | `wo_kitting_planner.MD` |
| POR-023 | 2026-05-13 | Blank-page fix: raw apostrophe in `<style>` CSS comment terminates Frappe template wrap | `production_overview.md` |

---

## 12. Sync Block (paste this into a fresh AI session)

```
[chaizup_toc · app root · TS-001 · 2026-05-14]
- Pending SO / WO / PO eligibility is configured EXCLUSIVELY in TOC Settings.
  6 fields: projection_pending_so_statuses, projection_confirmed_so_workflow_states,
  pending_wo_statuses, pending_wo_workflow_states, pending_po_statuses,
  pending_po_workflow_states. WKP and Production Overview now show a read-only
  "Active Pending Filter" banner sourced from
  chaizup_toc.api.wo_kitting_api.get_toc_pending_filters.
- 4 distinct engine entries: Calc A/B (run_projection_automation_for_all_warehouses),
  Calc SO (run_so_shortage_automation), Calc Action (run_shortage_action_automation).
  All write one TOC Production Plan Run Log per call. Markers: [Calc A], [Calc B],
  [Calc SO], [Calc Action].
- Item Minimum Manufacture is per (item, warehouse): MOQ, UOM, lead, safety,
  auto_adu, adu, adu_lookback_days, max_level, action_type
  (Manufacture/Purchase), auto_on_shortage, auto_on_max_level,
  max_level_threshold_pct, last_updated_on.
- Buffer-type / FG/SFG/RM/PM classification is GONE (BTP-001). Engine result
  dict uses `mr_type` (Manufacture / Purchase / Monitor). Reports keep
  `buffer_type` as a fieldname for saved-Report-View back-compat.
- 6 schedulers: 00:00 min order sync, 02:00 PP automation, 06:30 ADU,
  06:35 MinMfg ADU + max_level, 07:00 TOC MR generator, 07:30 procurement
  monitor, 08:00 buffer snapshot, Sun 09:00 weekly DBM.
- Restricted areas listed in chaizup_toc.md §8.
- For debugging blank pages: production_plan_engine.md POR-023 — CSS-comment
  apostrophe terminates the Frappe template-wrap JS string.
```
