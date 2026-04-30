# Production Overview — Developer Documentation

## Purpose & Use Cases

Single-screen production planning console that consolidates open Work Orders, Sales
Orders, Sales Projections, dispatch, shortage status and cost variance into one
table per item. Designed for the production planner / ops manager who needs to
answer in one view:

- *Are we producing enough this month?* (Planned vs Actual)
- *Will we ship?* (Stock + Planned − Pending SO)
- *Is anything blocked?* (Shortage components + open MRs/POs)
- *Are costs drifting?* (BOM standard vs STE actual)
- *What does the AI think we should fix today?* (DeepSeek summary)

### Real-world scenarios

| Scenario | How this page answers |
|----------|----------------------|
| Morning standup — what to start today | Sort by `possible_qty desc` → list of items ready to release |
| End-of-month review — projection accuracy | Look at `projection_vs_sales` ratio per item |
| Shortage triage | Click "View" on an item → `get_shortage_detail` → BOM-walk by WO with stage colour |
| Cost drift detection | Check `cost_summary.variance_pct` — flagged items > +10% drift |
| Sub-assembly dependency check | Items marked `is_sub_assembly=1` show parent FG WOs in tooltip |

## Route

`/app/production-overview` (Page DocType, `name="production-overview"`).

## Files

```
page/production_overview/
├── production_overview.json     ← Page metadata (9 roles, standard=Yes)
├── production_overview.html     ← 1082 lines, 3-tab skeleton + Chart.js CDN
├── production_overview.js       ← 1198 lines, ProductionOverview class
├── production_overview.py       ← 8 lines (boilerplate)
└── production_overview.md       ← This file

api/production_overview_api.py   ← 1424 lines, 13 @whitelisted endpoints
```

## Tabs (HTML)

| Tab | Pane id | Source endpoint | Notes |
|-----|---------|----------------|-------|
| Overview | `#por-pane-overview` | `get_production_overview` | 18-column item table; row click → detail modal |
| AI Advisor | `#por-pane-ai` | `get_ai_overview_insight` + `chat_with_overview_advisor` | DeepSeek; session key `por:chat:{user}:{session_id}` (distinct from `wkp:`) |
| Charts | `#por-pane-charts` | `get_chart_data` | Pie + bar (Chart.js loaded from CDN) |

## API Endpoints (13 total)

```python
# ─── Overview tab ─────────────────────────────────────────────────────────
get_production_overview(company, month, year, warehouses, wo_statuses,
                        so_statuses, stock_mode, planning_mode)
  # Returns: {items[], summary{}, period{}, filters{}, wo_statuses_used[]}
  # items: 18 fields per row including planned_qty / actual_qty / curr_dispatch /
  #        curr_projection / total_curr_sales / projection_vs_sales / has_shortage /
  #        shortage_components[] / possible_qty / active_bom / cost_summary{}

get_item_detail(item_code, company, month, year, warehouses, wo_statuses,
                stock_mode)
  # Per-item drill-down: open WOs (limit 20), components per WO (with shortage),
  # batch consumption from completed STEs, sub-assembly WOs via Production Plan.

get_shortage_detail(item_code, warehouses, stock_mode, wo_statuses)
  # by_wo[] (per WO short_components) + aggregated[] (sorted by shortage_value).

get_cost_breakup(item_code, company, month, year)
  # 3-way comparison: BOM standard | actual STE consumed | 6-month historical avg.

get_default_statuses()
  # Returns _DEFAULT_WO_STATUSES, _DEFAULT_SO_STATUSES, _DEFAULT_PP_STATUSES.

get_export_data(...)
  # Flat dict suitable for Excel export (one row per item).

# ─── Charts tab ───────────────────────────────────────────────────────────
get_chart_data(...)
  # Pie: items by item_type (FG/SFG/RM/PM/Other). Bar: planned vs actual top-N.

# ─── AI tab ───────────────────────────────────────────────────────────────
get_deepseek_models_por()         # Reuses DEEPSEEK_MODELS from wo_kitting_api
get_ai_overview_insight(context_json, model)         # Stateless auto-insight
chat_with_overview_advisor(message, session_id,      # Persistent (Redis 2h TTL)
                            context_json, model)
test_ai_connection_por()
```

## Dependencies

| Source | Why |
|--------|-----|
| `chaizup_toc.api.wo_kitting_api` | Reuses `_get_api_key`, `_call_deepseek`, `_execute_chat_with_tools`, `DEEPSEEK_MODELS`, `_AI_SESSION_TTL`, `_AI_MAX_HISTORY` (single source of truth for DeepSeek integration). |
| ERPNext: `Work Order`, `BOM`, `BOM Item`, `Bin`, `Stock Entry`, `Stock Entry Detail` | Production data |
| ERPNext: `Sales Order`, `Sales Order Item`, `Delivery Note`, `Delivery Note Item` | Demand + dispatch |
| Custom: `Sales Projection`, `Sales Projected Items` | Forecast for current month |
| `Item` master | classification (auto_manufacture, is_purchase_item, item_group) for FG/SFG/RM/PM split |

## Database Connections (explicit field map)

| DocType | Column used | Purpose |
|---------|-------------|---------|
| `tabWork Order` | `qty` (label "Qty To Manufacture") | Planned qty — **NOT** `qty_to_manufacture` (does not exist) |
| `tabWork Order` | `produced_qty`, `production_item`, `production_plan`, `bom_no`, `status`, `planned_start_date`, `planned_end_date` | Open WO row data |
| `tabStock Entry` + `Detail` | `transfer_qty` (stock_uom), `is_finished_item=1`, `stock_entry_type='Manufacture'` | Actual produced qty |
| `tabSales Order Item` | `stock_qty - delivered_qty` | Pending demand (stock_uom) |
| `tabDelivery Note Item` | `stock_qty` | Dispatch this month |
| `tabSales Projected Items` | `qty_in_stock_uom`, link field is `item` (NOT `item_code`) | Current month forecast |
| `tabBOM` + `tabBOM Item` | `is_active=1`, `is_default=1` | Component shortage walk |
| `tabBin` | `actual_qty` (and `projected_qty` for Y mode) | Current stock |
| `Item` | `auto_manufacture`, `is_purchase_item`, `item_group`, `stock_uom`, `standard_rate` | Classification + valuation |

## State Variables (JS)

```javascript
this._data         = null;     // last get_production_overview response
this._period       = null;     // {month, year, ...}
this._selWh        = [];       // [] = all
this._selWo / _selSo = [];     // status filters (populated from get_default_statuses)
this._planMode     = false;    // Y/N stock_mode toggle
this._aiModel      = "deepseek-chat";
this._aiContext    = null;     // last summary fed to AI
this._charts       = {};       // Chart.js instances by id
this._chartsLoaded = false;    // lazy
```

Session storage key: `por_ai_session` (UUID for chat continuity).

## ⚠ Restricted Areas (Do NOT Modify)

| Rule | Why |
|------|-----|
| `tabWork Order` — use `qty AS qty_to_manufacture` in SQL | The DB column is `qty`. Using `qty_to_manufacture` raises **OperationalError 1054**. Bug fixed 2026-04-30. |
| `Sales Projected Items.item` is the link to Item | NOT `item_code`. Renaming/swapping breaks projection joins. |
| `projection_month` is a string ("April") | Do NOT compare against int month numbers. Use `_MONTH_NAMES`. |
| AI context payload | NEVER include full `items[]` array — only `summary{}` + top-20. Sending everything causes HTTP 400 (token limit). |
| `_esc()` in JS | Inline entity replacement; do NOT swap to `frappe.dom.escape` — that swallows undefined and breaks template strings. |
| Redis prefix `por:chat:` | Distinct from `wkp:chat:`. Sharing keys would let WO Kitting Planner and Production Overview overwrite each other's chat history. |
| HTML — no single quotes in event handlers | Frappe wraps templates in a single-quoted JS string. Use `&quot;` for string args. |
| `_get_active_bom` filters `is_active=1` | Removing this returns ALL historical BOMs and explodes the BOM walk. |

## Spec Compliance Map (Session 2026-04-30 — Full Spec Pass)

The user-supplied requirements list maps to current implementation as follows.
Use this table when triaging "is X covered?" questions.

| Requirement | Implementation Location |
|-------------|------------------------|
| Tab 1 — items: auto_manufacture OR open WO OR open SO OR Sales Projection OR sub-asm | `_get_qualifying_items` in api |
| Item Code + Item Name | `_buildRow` first frozen column |
| Item Type FG/SFG/RM/PM | `_classify_item_type` + `_typeBadgeHtml` |
| Item Group full name (no abbreviations) | new `Item Group` column, full string from `tabItem.item_group` |
| Is Sub-Assembly | `_get_sub_assembly_info` (Production-Plan-based, NOT BOM-based) |
| Parent WO list with shortage qty | hover on Sub-Asm chip → `.por-subasm-list` |
| Open WO count | `_get_wo_counts` filtered by user-selected statuses |
| Planned production qty + UOM conversions | `_fmtQ` + `cell.title` shows ALL UOMs |
| Actual production qty + UOMs | same |
| Prev Month Order Qty + UOMs | `_get_so_qty(prev_month, prev_year)` |
| Curr Month Order Qty + UOMs | `_get_so_qty(curr_month, curr_year)` |
| Curr Month Dispatch + UOMs | `_get_dispatch_qty(curr_month, curr_year)` |
| Prev Month Dispatch + UOMs | `_get_dispatch_qty(prev_month, prev_year)` (NEW) |
| Sales Projection + UOMs | `_get_projection_qty` |
| Total Sales (this month) | `_get_total_sales_qty` |
| Proj vs Total Sales | `projection_vs_sales` field |
| Sales Projection + Prev Month coverage | `coverage_pct` (NEW field) |
| Shortage Materials Yes/No | `_get_shortage_summary` |
| Shortage View modal | `get_shortage_detail` + `_openShortageModal` |
| Possible Production Qty | `_get_possible_qty` (Independent), priority sim in JS |
| Production Plans column + View Plan modal | NEW endpoint `get_active_production_plans` + `_openPpModal` |
| Cost breakup 3-way (BOM std vs actual vs hist) | `get_cost_breakup` |
| Cost per default UOM AND all available UOMs | `cost_per_uom` (NEW field on `get_cost_breakup`) |
| Item click modal: WO + sub-asm chain + batch + cost | `get_item_detail` + `_buildItemDetailHtml` |
| AI Advisor (DeepSeek + model selector) | `chat_with_overview_advisor` + `get_deepseek_models_por` |
| AI no greetings, no preamble, HTML output, scroll tables | `_POR_AI_SYSTEM_PROMPT` enforces strict rules; `.por-ai-tablewrap` CSS |
| AI FAQ chips | `.por-faq-chip` panel in HTML |
| AI captures filter changes | `_buildAIContext` includes period + stock_mode + filters |
| Charts (pie + bar) using stock UOM | `get_chart_data` + Chart.js render |
| Month/Year filter | `por-month`, `por-year` selects |
| Export CSV | `_buildCSVContent` + `_exportCSV` |
| Export Excel multi-sheet, coloured, frozen, UOM compare | `export_excel` (NEW server endpoint, openpyxl) |
| Multi-select pending statuses, no hardcode, custom workflow_state | `get_default_statuses` queries DB, surfaces "Workflow: <state>" entries; `_so_status_clause` interprets them |
| Stock View Physical / Physical+Expected | `por-stock-mode` + `_get_stock` |
| Warehouse multi-select | `por-wh-list` + `_build_wh_filter` |
| Frozen header + horizontal scroll on all tables | `.por-table thead th { position:sticky }` + `min-width:1700px` |
| UOM = unit of measurement | comments + tooltips |
| Modal opens on Item Name click | `_openItemModal` |
| Consumption cost per available UOM | `cost_per_uom` rendered in cost modal |
| Batch consumption breakdown | `_get_batch_consumption` rendered in item-detail modal |
| Planning Mode like WO Kitting Planner | `por-planning-toggle` |
| Independent vs Priority sub-mode | `por-plan-submode` + `_recalcPriorityPossibleQty` |
| Tooltip on every qty cell with calculation | `_fmtQ` injects `title=` with full calc + UOM list |
| Layman-friendly description | tooltips + this `.md` |
| Shortage column View modal | `_openShortageModal` |
| Cost column 360° per UOM | `_buildCostHtml` Cost-per-UOM table |
| Item groups not hardcoded | dynamic from `tabItem.item_group` |
| Show full item group name | direct render of `item_group` field |
| Sub-asm = item is child of parent WO via Production Plan AND has its own open WO | `_get_sub_assembly_info` (PP-based discovery) |
| Independent BOM items NOT marked sub-asm | by construction in `_get_sub_assembly_info` |
| Items with SO highlighted light red | `tr.por-has-so` CSS class via `has_open_so` flag |
| Calculation logic from Sales Projection automation + WO Kitting Planner | `_so_status_clause` mirrors `production_plan_engine`; `_get_stock` mirrors WKP |
| WO consider only not Completed/Stopped | `get_default_statuses` defaults exclude Completed/Stopped/Cancelled |
| Smooth, compact UI | DM Sans/Geist Mono/Oswald + Tiger theme |

## Bug Inventory

| ID | Date | Location | Description | Fix |
|----|------|----------|-------------|-----|
| POR-001 | 2026-04-30 | `_get_planned_qty` (and 3 other WO queries: lines ~272, 341, 1408) | Used `qty_to_manufacture` column on `tabWork Order` — column does not exist (only the label is "Qty To Manufacture"; column is `qty`). Page failed to load with `OperationalError 1054`. | Replaced with `SELECT qty AS qty_to_manufacture` so Python attribute access stays descriptive. Added DANGER ZONE note in api header + this `.md`. |

## Deployment Notes

- Page is auto-loaded from `chaizup_toc/page/production_overview/`. No migration required.
- Chart.js loads from CDN — page is **not** offline-capable.
- DeepSeek API key resolution order matches `wo_kitting_api`:
  `DEEPSEEK_API_KEY` constant → `frappe.conf.deepseek_api_key` → `TOC Settings.custom_deepseek_api_key`.
- After any HTML/JS change: `redis-cli -h redis-cache -p 6379 FLUSHALL`.

## Sync Block — Session 2026-04-30 #2 (Full-spec compliance pass)

### What changed
Full audit + gap-fill against the user-supplied spec. All additions stay on
ERPNext native tables (Item, Work Order, Sales Order, Sales Order Item,
Delivery Note, Stock Entry, BOM, BOM Item, Bin, Production Plan, Production
Plan Item, UOM Conversion Detail) — no parallel data model.

### New API endpoints / fields
- `get_default_statuses` — now fully dynamic (`SELECT DISTINCT status` per
  DocType + workflow_state surfaced as `Workflow: <state>` entries).
- `_so_status_clause(so_statuses)` — splits plain status vs workflow state and
  emits a clause matching `(docstatus=1 AND status IN ...) OR (docstatus=0 AND
  workflow_state IN ...)` (only if column exists). Mirrors the
  `production_plan_engine` workflow guard.
- `get_active_production_plans(item_code)` — returns active PPs containing
  this item (via `tabProduction Plan Item.item_code`) + parent/child WO list
  (via `tabWork Order.production_plan`).
- `export_excel(...)` — server-side openpyxl. 3 sheets, frozen header,
  colour-coded rows (red shortage, pink open SO), UOM Comparison sheet.
- New main-response fields per item:
  `prev_dispatch`, `pp_count`, `has_open_so`, `coverage_pct`, `coverage_input`.
- `cost_per_uom[]` on `get_cost_breakup` — BOM std + actual ₹/unit for
  every UOM via `tabUOM Conversion Detail`.

### New behaviour (frontend)
- New columns: Item Group, Prev Month Dispatch, Coverage %, Production Plans.
- All-UOM display: every qty cell's `title=` lists every UOM conversion plus
  the calculation that produced the value.
- Per-UOM cost table inside the Cost modal.
- Production Plans modal with Target/Other WO badges.
- Sub-Asm chip → hover-list of parent WOs with required component qty.
- Items with open SO get `tr.por-has-so` (light red row).
- Planning Mode now has Independent/Priority sub-modes; Priority does a
  client-side stock-pool deduction in row order.
- AI system prompt strict-mode: no greetings, no preamble, HTML only,
  every table wrapped in `.por-ai-tablewrap` for horizontal+vertical scroll.

### Restricted areas (do NOT modify)
- `_so_status_clause` — without the workflow_state guard, sites without a
  Sales Order workflow crash with OperationalError 1054 (matches the same
  rule from `production_plan_engine.py`).
- `get_active_production_plans` — relies on `Work Order.production_plan` link;
  do NOT swap to BOM-based discovery (would re-introduce the wrong sub-asm
  detection that the user explicitly rejected).
- `tabWork Order.qty AS qty_to_manufacture` aliasing — see POR-001.
- `cost_per_uom` calculation order: stock UOM row first, then conversions
  sorted by ascending factor — JS code expects that order.
- AI context: still must NOT include the full items[] (token-limit budget
  remains identical to WKP).
- Sales Projected Items link field is `item` (NOT `item_code`).

### Validated
- `get_production_overview` returns all new fields populated (`prev_dispatch`,
  `pp_count`, `has_open_so`, `coverage_pct`).
- `get_active_production_plans` returns `{plans: []}` for items with no PP.
- `get_cost_breakup` returns `cost_per_uom` with stock UOM + every
  conversion (e.g. Pcs + CFC/Master).
- `export_excel` writes 350KB valid `.xlsx` (PK\x03\x04 ZIP signature).
- Page route `/app/production-overview` HTTP 301 → 200.

### Sync handoff
If extending this page in a future session:
1. Always join through ERPNext native child tables — no shadow data model.
2. Status filtering MUST go through `_so_status_clause` (not raw
   `status IN ...`) so workflow-state pending stays interpretable.
3. Sub-assembly = WO has `production_plan` set AND another WO in the same PP
   produces a different item. Do NOT fall back to BOM-Item membership —
   that incorrectly flags every component item as sub-asm.
4. New columns require both the `<th>` in HTML AND `_buildRow` cell + the
   Excel sheet1 column list — keep all three in sync.
