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

## Sync Block — Session 2026-05-01 #9 (Cover Sheet Filter Display Fix)

### Bug fixed
The Cover sheet was rendering `WO Statuses` / `SO Statuses` / `PO Statuses`
/ `Warehouses` as JSON-string CHARACTER LISTS, e.g.
`[, ", I, n,  , P, r, o, c, e, s, s, ", ]`.

**Root cause**: the URL form (`window.location.href = ...export_excel?...`)
encodes lists as JSON strings (`'["In Process","Not Started"]'`).
`get_production_overview` parses them internally, but `export_excel`
itself was passing the RAW string to `", ".join(...)` for the Cover sheet —
which iterates the string char-by-char.

**Fix**: added a local `_as_list(v, default)` helper at the top of
`export_excel` that:
- Returns the default if value is None/empty.
- Calls `frappe.parse_json` if the value is a string.
- Returns lists as-is.
- Falls back to wrapping a single value in a 1-elem list, or to default.
Then used the parsed lists everywhere — both for `get_production_overview`
call AND for the Cover sheet rendering.

### Restricted areas (added)
- `_as_list` is the canonical parser for these URL params inside
  `export_excel`. Don't bypass it — every list-shaped param coming through
  the URL will arrive JSON-encoded.

## Sync Block — Session 2026-05-01 #8 (Sheet Guide + Simple Report)

### What changed
The Excel export now ships **8 sheets** (was 6).

**New: Sheet Guide** (tab #2, between Cover and Overview).
A workbook map. One row per sheet with its purpose, real-world use case,
and key columns. Helps non-technical readers know which tab to open. Indigo
header, alt-row shading, wrap text on the description columns.

**New: Simple Report** (tab #3, between Sheet Guide and Overview).
The planner's daily quick-look. Eleven columns:

| Column | Source / Formula |
|--------|------------------|
| Item Code, Item Name, Item Group, Stock UOM | Item master |
| Total Pending SO         | NEW backend helper `_get_all_pending_so_qty` — sum of `stock_qty − delivered × cf` clamped ≥0 across ALL pending SOs (any month), filtered by selected SO Status + Warehouses. |
| Open WO Pending Qty      | `Σ (Work Order.qty − produced_qty)` on open WOs (already exposed as `pending_wo_qty`). |
| Total Projection         | `qty_in_stock_uom` from this month's Sales Projection. |
| Stock on Hand (Physical) | `Bin.actual_qty` only. **Always physical** on this sheet, regardless of the page-level Stock View toggle. |
| Target Production        | `max(Sales Projection, Total Curr Sales)`. |
| Shortage vs Physical Stock      | `max(Target − Stock, 0)` — pure firefight view. |
| Shortage vs (Stock + Pending WO)| `max(Target − (Stock + Pending WO), 0)` — gap after open WOs land. |

A pre-header row (row 2) lists every formula in plain English. Frozen
panes at C5 (so item code + name remain visible while scrolling). Row tint:
red if Shortage vs (Stock+WO) > 0, amber if only Shortage vs Physical > 0,
zebra otherwise. AutoFilter on rows 4:end (skips the formula note row).

### Restricted areas (added)
- The Simple Report sheet uses **physical stock only** (independent
  `_get_stock(..., "physical")` call). Don't honour the page Stock View
  here — the user explicitly asked for "with physical stock" math.
- Pre-header row in Simple Report (row 2) holds the formulas. AutoFilter
  starts at row 4 to skip it. If you reposition headers, update both.
- `_get_all_pending_so_qty` clamps to `>= 0` (over-delivered SOs go to 0,
  not negative). Same convention as `production_plan_engine`. Don't drop
  the GREATEST clause.
- Sheet ORDER for the workbook is now: Cover → Sheet Guide → Simple
  Report → Overview → UOM Comparison → Item Master → Group Pivot →
  Shortage Drivers. Cover stays leftmost; Sheet Guide is the second tab so
  the reader hits the workbook map immediately.

## Sync Block — Session 2026-05-01 #7 (Counts-not-Qty Cards, Excel Export Overhaul)

### What changed

**Summary cards now show ITEM COUNTS, never aggregated qty.**
Reason: items use heterogeneous UOMs (Pcs / Kg / Gram / Master Carton).
Summing `qty` across items with different UOMs is mathematically wrong.

The 8 cards now show:
1. Total Items
2. With Shortage
3. No Shortage
4. Items w/ Open WO
5. Items w/ Curr Month SO
6. Items Dispatched
7. Blocked (short + 0 possible)
8. Target Hit (≥100%)

Each card label now ends in "(count)" and has a descriptive tooltip.
The aggregate qty fields (`total_planned_qty` etc.) are still in the
summary dict but now feed only the Excel "Cover" sheet, which clearly
labels them and warns about UOM mixing.

**Excel export overhauled — now 6 sheets:**

| Sheet | Purpose |
|-------|---------|
| Cover           | Title + which filters were applied + counts table. The reading guide. |
| Overview        | All 30 columns including Description; alt rows; conditional tints (red shortage / pink open SO); frozen panes (C2); autofilter on every column. |
| UOM Comparison  | One row per (item, metric, UOM). Stock UOM rows highlighted indigo. Lets a planner look up any qty in any UOM without manual conversion. |
| Item Master     | NEW. Reference catalogue: code / name / group / stock_uom / description / standard_rate / valuation_rate / TOC flags / All UOM Conversions string. |
| Group Pivot     | NEW. Pre-aggregated by Item Group: counts of items with shortage / WO / PP / curr SO / dispatch / projection / target hit / blocked / sub-assembly. Bottom TOTAL row in indigo. |
| Shortage Drivers| NEW. Procurement priority list. Components blocking the most parents (red tint if blocks ≥5, amber if ≥2). |

Each sheet:
- Indigo header (#4F46E5) with white bold text
- Alternate-row shading (zebra) on body rows that aren't tinted by status
- Frozen panes (typically `B2` or `C2`)
- AutoFilter on the header row across the whole data range
- Borders on every cell

**Google Sheets compatibility**:
- AutoFilter ranges are written via `ws.auto_filter.ref` (preserved on import).
- Pre-aggregated "pivot-style" data sheet replaces real pivot tables (real
  pivots flatten unpredictably during Sheets import).
- Static fills (PatternFill) instead of named table styles — colour
  survives the import.
- Frozen panes are honoured.

### Restricted areas (added)
- Cards MUST stay as counts. If a future change wants a qty card, it MUST
  be per-UOM (e.g. "Total Planned Qty in KG only") — never a mixed-UOM sum.
- Sheet ORDER in the workbook matters: Cover first acts as the reading guide.
  Reorder only if the Cover stays the leftmost tab.
- AutoFilter on Group Pivot excludes the TOTAL row (`max_row - 1`). Don't
  remove this; including TOTAL in the filter range corrupts the sort.
- Item Master "All UOM Conversions" column is a single string of the form
  `"<UOM> (×<factor>); <UOM> (×<factor>); ..."`. Don't split into multiple
  columns — that exploded the row count and broke the reference catalogue.
- Shortage Drivers tint thresholds are 2 (amber) and 5 (red). These are
  not configurable through TOC Settings yet — change with care; they map
  to mental categories ("worth chasing" vs "drop everything").

## Sync Block — Session 2026-05-01 #6 (Production-team Charts, Filter Toasts, All-tab Filter Sync)

### What changed

**New production-team chart series (backend `get_chart_data`)**:

| Key | Type | What it answers for the floor |
|-----|------|------------------------------|
| `bar_priority_action`  | horizontal stacked bar | "What's the gap I have to chase TODAY?" Stacks Stock + Pending WO + Gap (red) per item, top 10 by Target Gap. |
| `bar_daily_need`       | horizontal grouped bar | "How much do I need to produce per day to hit Target?" Remaining + per-day need (Sundays excluded). |
| `readiness_pie`        | doughnut | Items split into Ready / Partial / Blocked / No Demand. |
| `bar_coverage_health`  | bar | Distribution of items across Coverage % buckets (<50, 50–99, 100–149, ≥150, No Sales). |
| `bar_shortage_drivers` | horizontal bar | Top 10 components blocking the most parents. Procurement priority list. |
| `working_days_left`    | int | Remaining working days in the period (excludes Sunday). Drives daily-need calc. |

The Charts tab now renders 9 charts in 5 logical sections:
"Today's Priority", "Daily Need", "Readiness Mix", "Shortage Status",
"Coverage Health", "Shortage Drivers", "Top by Demand",
"Projection vs Sales", "Open WOs by Group". Every card has a `[i]` tip.

**Filter tooltips**: every filter group label and most controls now have a
title= explaining what the filter affects across tabs (Overview / AI / Charts).

**Filter-change toast + Load-button pulse**:
- Any change to Company, Month, Year, Stock View, or any multi-select status
  triggers `frappe.show_alert({ indicator: 'blue' }, 5)` describing the change.
- The Load button gets `.por-load-pulse` (CSS keyframe ring) so the user
  notices the pending refresh.
- Clicking Load clears the pulse and shows a green confirmation toast:
  "Loaded N items for Month YYYY. All tabs (Overview, AI, Charts) will use
  this dataset."
- `_loadData` invalidates `_chartsLoaded` and `_aiInsightLoaded` so the next
  view of either tab refetches automatically.

**Chart filter parity**: `_loadCharts` now passes `pp_statuses` and
`po_statuses` in addition to wo/so/warehouses/stock_mode. Same parameter
set as the Overview tab — guarantees identical scoping across tabs.

### Restricted areas (added)
- Working-days-left calculation uses `weekday() < 6` (Mon=0..Sun=6 → keeps
  Mon..Sat as working). If the factory has different weekly off days,
  expose this through TOC Settings rather than hard-coding.
- `bar_priority_action` data series — `stock`, `wo_pending`, `gap` MUST sum
  to ≤ `target` per item. The clamping logic is intentional so the stack
  chart renders without overshoot. Don't simplify to raw values.
- `frappe.show_alert` is the only toast mechanism used. Don't introduce a
  parallel notification system; users get confused.
- The Load-button pulse class is `por-load-pulse`. CSS keyframe is
  `por-load-pulse`. Don't rename either independently — they're paired.
- `_aiInsightLoaded` flag is reset on every `_loadData` call. Removing this
  reset re-introduces stale-AI-insight bug after filter change.

## Sync Block — Session 2026-05-01 #5 (Qualifying Items Tightened, Custom Tooltips, Shortage Detail with Name+Stock)

### What changed

**Qualifying items narrowed to exactly the 4 conditions the user specified**.
`_get_qualifying_items` now returns ONLY items that match at least one of:

  1. `Item.custom_toc_auto_manufacture = 1` (TOC App flag)
  2. Item is the `production_item` of an open Work Order
     OR appears in `Production Plan Item.item_code` of an open Production Plan
  3. Sub-assembly proper — item has its own open WO AND is consumed by a parent
     WO via the same Production Plan link
  4. Item has at least one OPEN PENDING Sales Order line (any month)

  Dropped (intentional, per spec): items only present in Sales Projection;
  items used purely as plain BOM components without their own WO. Result on
  the test bench: 785 → 344 items.

**Shortage materials now show item code + name + current stock everywhere.**
Backend `_get_shortage_summary` now returns each short component with
`item_code`, `item_name`, `required`, `in_stock` (alias `stock`), `shortage`,
`uom`. Frontend renders this richer line in:
  - Item-detail modal "components short" inline strip — now a 6-column table
  - Shortage modal "Breakdown by WO" — now a 6-column table
  - Shortage chip hover tooltip — multi-line list of top short components
  - PP Tree (already showed name + stock from earlier work)

**Custom hover tooltip system replaces native `title=`.**
Reason: native `title=` tooltips have a 700ms+ browser delay AND are styled
by the OS (inconsistent across Mac/Win/Linux). User said "tooltips not
working" — they were firing, just very late.

Mechanism — see `_setupTooltips()` in JS:
- Single global `#por-tooltip` div appended to `<body>`.
- Delegated `mouseover` on `#por-root` reads any `[title]` or `[data-tip]`
  on the hovered element, copies the text into the tooltip div, hides the
  native tooltip by stashing `title` into `data-orig-title`, restores on mouseout.
- `mousemove` repositions, edge-aware so the tip never overflows the viewport.
- `scroll` and window `blur` clear stale tips.
- All existing `title="..."` attributes work without HTML edits — zero
  migration cost.

CSS classes added: `.por-tooltip` (dark indigo bg, white text, monospace-friendly
multi-line). Cursor hint added: `[title], [data-tip] { cursor:help }`.

### Restricted areas (added)
- `_get_qualifying_items` is the gatekeeper for everything downstream — every
  item displayed in the table, charts, AI context, Excel export. Adding a
  new "qualifying" condition without user sign-off broadens the dashboard
  and reverts the 2026-05-01 spec.
- `_get_shortage_summary` short_components MUST include `item_name` and `in_stock`.
  The frontend assumes both fields. Removing them re-introduces the
  "code-only shortage" complaint.
- The custom tooltip system removes `title` and re-attaches it. Do NOT also
  bind a competing tooltip handler — race conditions cause flickering.
- `data-orig-title` is the swap field. Renaming it breaks the restoration
  on `mouseout` and leaves elements without their tooltip permanently after
  the first hover.
- `#por-tooltip` is appended to `document.body`, not `#por-root`, so the
  z-index works above all modals and the page header. Don't move it.

## Sync Block — Session 2026-05-01 #4 (Blank-page Fix: WKP-001 Apostrophe Escape)

### What broke
After Pass #3, the page rendered blank. Browser console showed the Page doc
returning a `script` field beginning with
`frappe.templates["production_overview"] = ' <li ...` — i.e. Frappe had
wrapped the HTML in a single-quoted JS string, and one of the apostrophes
inside an HTML *tooltip* prematurely terminated that string. Result: the
generated page script was a SyntaxError, eval failed, page rendered blank.

### Root cause
TWO raw apostrophes inside HTML — neither in an `onclick` handler:
1. `title="... 'Workflow: <state>' ..."` (literal apostrophes around text)
2. Plain-content tooltip text: `"this month's demand"` (possessive).

The well-known WKP-001 rule originally said "no single quotes in event
handlers", but the actual constraint is much stronger — Frappe wraps the
ENTIRE HTML inside a single-quoted JS string, so a raw apostrophe ANYWHERE
in the HTML breaks the wrapping. Tooltip text, alt text, plain content
between tags — all of it is in the wrapped string.

### Fix (one line each)
Line 908 — `'Workflow: <state>'` → `&quot;Workflow: <state>&quot;`
Line 1120 — `month's` → `month&apos;s`

### Hardening (already in #3 carried forward)
Every `getElementById` lookup in `_bindEvents` is now wrapped in `$on(id, ev, fn)`
which silently no-ops on null — even if cached HTML lags behind the JS, the
bootstrap will not abort.

### Restricted Areas (added)
- **HTML apostrophe count must be zero.** Run before every commit:
  ```
  grep -c "'" apps/chaizup_toc/chaizup_toc/chaizup_toc/page/production_overview/production_overview.html
  ```
  must return `0`. Same rule for any Frappe Page HTML — `wo_kitting_planner.html`,
  `toc_item_settings.html`, `toc_user_guide.html` etc.
- Audit the live generated page script after any HTML change:
  ```python
  from frappe.desk.desk_page import get
  out = get("production-overview")
  ```
  Then grep the `script` field for unescaped apostrophes inside the
  `frappe.templates[...] = '...';` wrapper. `node --check` on the dumped
  script must exit 0.

### Sync handoff
For ALL Frappe pages in this app (and any future ones):
1. NO raw apostrophes in HTML. Use `&apos;` for possessives, `&quot;` for
   string args inside event handlers / templates.
2. NO `%}` in CSS without a preceding `;` (Jinja2 collision).
3. Every new DOM lookup should be guarded — null-safety prevents one missing
   element from blanking the entire page.

## Sync Block — Session 2026-04-30 #3 (Warehouse, Target, PP Tree, Sort+Search, Hyperlinks)

### What changed

**Removed**
- "Type" column (FG/SFG/RM/PM badge) — discontinued. The classification is still
  computed server-side and present in API output / Excel, just not rendered.

**Added**
- **Sequence #** column — for Priority Planning Mode. Row index of the current
  sort/filter view; persists into `_recalcPriorityPossibleQty` so item priority
  follows whatever order the user sees.
- **Target Production** column — `max(Sales Projection, Total Sales)` with a
  "Projection / Order" pill showing which side wins. All UOMs in tooltip.
- **% Target Achieved** column — uses the user formula
  `gap = max(curr_so − (pending_wo + stock), 0)` then
  `achieved = max(target − gap, 0)`; warehouse-scoped.

**Hyperlinks everywhere**
- Item Code, Active BOM, WO names, MR names, PO names, PP names, sub-asm
  parent WOs — all open `/app/<doctype>/<name>` in a new tab via the new
  `_dl(doctype, name)` helper.

**Warehouse-aware queries**
- `_get_planned_qty`, `_get_actual_qty`, `_get_so_qty`, `_get_dispatch_qty`,
  `_get_total_sales_qty`, `_get_projection_qty`, `_get_has_open_so_map`,
  `_get_wo_counts` all accept a `warehouses` parameter now.
- WO scoping uses `wo.fg_warehouse`. STE uses `sed.t_warehouse`. SO uses
  `COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse)`. DN uses
  `dni.warehouse`. Sales Projection uses `sp.source_warehouse`. Bin already
  was warehouse-scoped.

**PP Tree modal (drill-into PP)**
- New `get_pp_tree(pp_name)` endpoint — returns parent + sub-assembly WOs,
  each with BOM components and supply/shortage data.
- Component rows show:
  required, consumed (from STEs of that WO), remaining, stock,
  will-be-received-from PO/WO/MR, shortage.
- Detail row beneath each component lists open WO/PO/MR documents (each is
  a hyperlink to its `/app/<doctype>/<name>`).

**Column sort + universal search**
- Every header is `data-sort=<key>` clickable; toggles asc/desc. Indicator
  shown via `.por-sort-asc` / `.por-sort-desc` chevron.
- New search input on the tab bar; substring matches on item code/name,
  item group, active BOM, and parent PP names. `Esc` clears.

**Item name wrap**
- `.por-in` overridden to `white-space:normal`; `.por-col-item` widened to
  240px. Full names visible without truncation.

**PO Status filter**
- New multi-select on the filter bar, populated from
  `get_default_statuses().all_po_statuses` (dynamic — not hardcoded).
- Sent to backend as `po_statuses`; accepted by `get_production_overview`
  and `export_excel`.

**Excel export updated**
- Sheet 1 columns: Type column removed; Pending WO Qty, Target Production,
  Target Gap, % Target Achieved added.

### Restricted areas (do NOT change)
- `_get_so_qty` warehouse clause uses BOTH `soi.warehouse` AND
  `so.set_warehouse` via COALESCE — legacy SOs that only set the header
  warehouse must still match. Removing one half re-introduces the
  warehouse-leakage bug.
- WO warehouse column is `fg_warehouse` (NOT `wip_warehouse` — that's
  different semantics). Don't swap.
- STE warehouse column for finished item is `t_warehouse` (target). Don't
  use `s_warehouse` (source) here.
- Excel sheet1 column list is the source of truth — JS `_buildRow`, HTML
  `<th>` order, and the openpyxl headers must all stay in lock-step.
- `_dl(doctype, name)` always opens a NEW TAB (`target="_blank"`). Don't
  remove `rel="noopener noreferrer"` — required for security.
- `_recalcPriorityPossibleQty(rows)` MUST be called with the same rows that
  are about to render; calling it without the visible rows reverts to global
  order and breaks the sequence column meaning.
- `get_pp_tree` joins on `Work Order.production_plan` — it does NOT scope
  by `production_item`. The whole plan tree is returned for every parent WO
  in the plan because the user explicitly asked for "tree parent production
  with sub assembly".
- The Type column is gone but `item_type` is still computed server-side
  (used by AI context + Excel sheet 2 metadata). Don't remove the field
  from the API response or the AI prompt context will break.

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
