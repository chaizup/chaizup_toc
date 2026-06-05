# WO Kitting Planner

## Purpose & Architecture
The WO Kitting Planner is a production planning tool for Frappe/ERPNext, designed for food/FMCG manufacturing. It allows production managers to simulate material availability across all open Work Orders, identify shortages, and make data-driven decisions.

### Key Features
- **Simulation Engine**: Supports "Current Stock Only" and "Current & Expected" (including POs/MRs/WOs) modes.
- **Calculation Modes**: "Isolated" (each WO checked against full stock) and "Sequential" (WOs consume stock in priority order).
- **AI Advisor**: Powered by OpenAI (V3/R1), providing automated insights and a persistent chat interface for production support.
- **Dispatch Bottleneck Analysis**: Compares FG stock and production plan against Sales Order demand.
- **Item View**: FG-wise summary of all items with active WOs or pending SOs.
- **Cost Audit**: 360-degree audit comparing BOM standard cost vs. actual consumed cost.

## Development Guidelines

### 🔒 RESTRICTED AREAS (Do Not Change)
Changing these will break core features or destroy the "Tiger Theme" design system:
1.  **JS State Variables**: `this._aiSessionId`, `this._aiContext`, `this._aiInsightLoaded`, `this.rows`, `this.woOrder`.
2.  **DOM IDs**: 
    - AI: `#wkp-ai-insight-body`, `#wkp-ai-messages`, `#wkp-ai-input`, `#wkp-ai-send`, `#wkp-ai-status`.
    - Summary: `#wsum-ready`, `#wsum-partial`, `#wsum-blocked`, `#wsum-total`, `#wsum-shortage-val`.
    - Layout: `#wkp-tbody`, `#wkp-shortage-body`, `#wkp-emerg-body`, `#wkp-dispatch-body`, `#wkp-iv-body`.
3.  **CSS Variable Names**: The `:root` tokens (e.g., `--slate-50`, `--brand-500`, `--ok`, `--err`) are referenced by both CSS and JS. Change values, but NEVER rename them.
4.  **HTML Constraint**: Strictly NO SINGLE QUOTES in HTML attributes (use `&quot;` if needed).
5.  **API Schema**: 
    - `get_dispatch_bottleneck` return keys (`fg_stock`, `total_pending`, `total_reserved`, `has_pick_list`, `so_list`).
    - `get_item_wo_summary` returns historical cost data for the Item View.
    - `get_material_supply_detail` provides PO and MR context for shortages.

### ⚠️ IMPORTANT: ERPNext Field Mapping
When writing SQL queries for this application, be extremely careful with field names as they often differ from common assumptions:
- **Work Order**: Use `production_item` (NOT `item_code`) for the finished good being produced.
- **Purchase Order Item**: Use `rate` (NOT `valuation_rate`) for the purchase price.
- **Material Request Item**: Use `item_code`.
- **Stock Entry**: Use `work_order` for the link to the originating WO.

### 🔍 Dynamic Filtering (Anti-Hardcoding)
- **Item Groups**: In the Material Shortage tab, item groups must be fetched from the actual components in the simulation (`shortage_items[].item_group`), not inherited from the parent Work Order.
- **WO Statuses (LEGACY)**: The original "Show WOs" single-select is populated via `get_work_order_statuses`. The DOM id `#wkp-status-filter` is now hidden but kept for back-compat with older tests / external bookmarklets.
- **WO / SO / PO Statuses (WKP-034, 2026-05-13)** — see next section: every report on the page is now driven by three multi-select dropdowns. Universe is dynamic per the user data; SO entries include `Workflow: <state>` items when an SO Workflow is configured. NEVER hardcode ERPNext document statuses anywhere in HTML or JS.

### 🆕 Dynamic Status Filters (WKP-034, 2026-05-13)

#### Why
Hardcoded `NOT IN ('Closed','Cancelled','Completed')` clauses are wrong on sites that:
- use a custom Sales Order Workflow (Draft + workflow_state = "Confirmed" is the *real* pending signal),
- add bespoke statuses ("On Hold Waiting Quality", "Awaiting Production Slot"),
- treat "On Hold" SOs as pending (default behaviour matched Production Overview now).

The page now mirrors the Production Overview design exactly: three multi-select dropdowns in the filter bar (WO Status, SO Status, PO Status). A Load button next to them recalculates every tab when clicked. Any change to a checkbox flips the Load button into a pulsing state and emits a toast — recalculation is explicit, never per-keystroke.

#### Backend
| Symbol | Where | Purpose |
|---|---|---|
| `_DEFAULT_WKP_WO_STATUSES` | `wo_kitting_api.py` top | Default open-WO set: Not Started / In Process / Material Transferred |
| `_DEFAULT_WKP_SO_STATUSES` | top | Default pending-SO set: To Deliver and Bill / To Deliver / Partially Delivered / On Hold |
| `_DEFAULT_WKP_PO_STATUSES` | top | Default pending-PO set: To Receive and Bill / To Receive |
| `_wkp_parse_status_list(value, default)` | helper | Accepts list / JSON-string / None / "" — empty falls back to default (NOT to "no filter") |
| `_wkp_split_status_and_workflow(list)` | helper | Splits `"Workflow: <state>"` entries out into a parallel workflow_state list |
| `_wkp_so_status_clause(list, alias="so")` | helper | `(so.docstatus=1 AND so.status IN (...))  OR  (so.docstatus=0 AND so.workflow_state IN (...))` — wf branch only emitted when `frappe.db.has_column("Sales Order","workflow_state")` is true |
| `_wkp_po_status_clause(list, alias="po")` | helper | PO analogue; workflow column extremely rare in practice |
| `_wkp_wo_status_clause(list, alias="wo")` | helper | `(wo.docstatus=1 AND wo.status IN (...))  OR  (wo.docstatus=0 AND wo.workflow_state IN (...))` — wf branch only emitted when `has_column("Work Order","workflow_state")` is true. Same family of clause as SO and PO so sites with bespoke WO Workflows (e.g. "WO Quality Hold") are honoured. |
| `wkp_get_default_statuses()` | new whitelist | Returns `{wo_statuses, so_statuses, po_statuses, all_wo_statuses, all_so_statuses, all_po_statuses, *_has_workflow_column, *_workflow_states}`. Each `all_*_statuses` list includes `Workflow: <state>` entries for every doctype that has a populated `workflow_state` column. Same shape as Production Overview, extended so WO + PO custom workflows appear in the dropdown when configured. |

The four data endpoints accept the new kwargs and fall back to defaults if omitted:

```
get_open_work_orders(status_filter=None, wo_statuses=None)
simulate_kitting(work_orders_json, stock_mode, calc_mode, multi_level,
                 wo_statuses=None, po_statuses=None)
get_dispatch_bottleneck(stock_mode, so_statuses=None, po_statuses=None)
get_item_wo_summary(wo_statuses=None, so_statuses=None)
```

Supply pool builder `_build_stock_pool(stock_mode, item_codes, wo_statuses, po_statuses)` accepts both lists. `_get_open_so_detail(item_codes, so_statuses)` accepts SO list.

#### Frontend
| DOM element | Purpose |
|---|---|
| `#wkp-wo-btn` / `#wkp-wo-panel` / `#wkp-wo-status-list` / `#wkp-wo-label` | WO Status multi-select trigger + dropdown |
| `#wkp-so-btn` / `#wkp-so-panel` / `#wkp-so-status-list` / `#wkp-so-label` | SO Status multi-select |
| `#wkp-po-btn` / `#wkp-po-panel` / `#wkp-po-status-list` / `#wkp-po-label` | PO Status multi-select |
| `#wkp-load-btn` | Apply current selection; recalculates all tabs |
| `#wkp-status-filter` | LEGACY single-select, hidden via `style="display:none"`; still wired but unused |

| JS state / helper | Purpose |
|---|---|
| `this._selWo`, `this._selSo`, `this._selPo` | Arrays of currently selected statuses (subset of universe). |
| `this._statusUniverse` | Cached response of `wkp_get_default_statuses` (the universe of choices). |
| `this._statusFiltersDirty` | True if user changed any checkbox since last Load. Drives `.wkp-load-btn.dirty` pulse class + toast. |
| `_populateMsPanel(listId, panelId, labelId, options, defaults, hint?)` | Renders one panel. Workflow-state entries get a small "WF" tag chip. |
| `_toggleMsPanel(panelId, trigger)` | Open/close + close-others. |
| `_selectAllMs(panelId, checked)` | All / None button handler. |
| `_updateMsLabel(panelId, labelId)` | Label flips between "Default" (all checked), "<N> selected", or "None". |
| `_readStatusSelections()` | Snapshots checkbox states into `_selWo/_selSo/_selPo`. Called just-in-time before every API call. |
| `_markStatusFiltersDirty()` / `_clearStatusFiltersDirty()` | Maintain the dirty pulse + toast. |

#### Restricted areas (WKP-034)
- `_wkp_*` helper names are imported by tests; do not rename.
- An empty incoming status list MUST map to `_DEFAULT_WKP_*` (NOT to "no filter"). This means a user unchecking every box still gets defaults rather than silently returning everything.
- The legacy `#wkp-status-filter` `<select>` must stay in the DOM (hidden) so old bookmarklets / external test harnesses do not throw on `getElementById`.
- `frappe.db.has_column` guard on PATH A (workflow_state) is mandatory. Sites without an SO Workflow do not have that column, and direct querying raises OperationalError 1054.
- The Load button only recalculates when explicitly clicked. Do NOT auto-fire `this.load()` on every checkbox change — for sites with 200+ WOs this would hammer the server.
- HTML rule: **zero raw apostrophes in this file** (POR-023 family). Same scrubber semantics; same outcome (blank page) if violated. Use `&apos;` or rephrase.

### UI & UX Standards (Production Grade)
- **Typography**: 
    - `Geist Mono` for quantities, IDs, and costs.
    - `Oswald` for dashboard values and headings.
- **Color System**:
    - **Emerald (ok)**: Ready to Produce / In Stock.
    - **Amber (warn)**: Partial Shortage / Risk.
    - **Rose (err)**: Blocked / Overdue / Gap.
    - **Sky (buy)**: Procurement / Expected Stock.
- **UOM Display**: Always use the "Stacked" dual UOM format in tables:
    ```html
    <div class="wkp-qty-primary">1,000</div>
    <div class="wkp-qty-uom">Gram</div>
    <div class="wkp-qty-secondary">1.00 Kg</div>
    ```

### AI Advisor Prompt Rules
- **Auto-Insight**:
    - No preamble (never start with "Based on...").
    - Top 3 issues only (Item / WO / Impact / Fix).
    - Exactly 3 action steps, one verb phrase each.
    - One sentence status summary.
- **System Prompt (Chat)**:
    - Summary: 1-2 sentences max.
    - Tables: max 4 columns, max 6 rows.
    - Action steps: exactly 3, one short sentence each.
    - **Always include item_code** in parentheses when mentioning items.

## Database Connections
- **Primary**: `Work Order`, `BOM`, `Item`, `Bin`
- **Demand**: `Sales Order`, `Sales Order Item`
- **Supply**: `Purchase Order`, `Material Request`
- **Consumption**: `Stock Entry`, `Stock Entry Detail`

---

## 🔄 DEVELOPER STATE SYNC (Session 10)
**Sync Block for Context-Aware AI Development**

### Latest Logic & Architecture
- **Dynamic Filtering**: Main "Show WOs" filter is now populated via `get_work_order_statuses` API to avoid hardcoding ERPNext statuses.
- **Shortage Aggregation**: Components in the "Material Shortage Report" correctly use their own `item_group` (fetched via updated `_get_bom_items_bulk`) for accurate tab-level filtering.
- **UI Design**: Modernized "Tiger Theme" using Slate/Emerald/Rose palette. Summary cards are clickable for instant filtering.
- **Multi-level BOM**: Simulation supports recursive expansion (up to 6 levels) while preserving item metadata (`item_group`, `valuation_rate`).
- **Cost Audit**: 360-degree audit tool compares BOM standard vs actual consumed cost with variance tracking.

### Critical Implementation Details
- **Field Mapping**: WO production item is `production_item`. PO price is `rate`. SE link is `work_order`.
- **UOM Standard**: Always show "Stacked" dual UOMs in tables.
- **HTML Security**: No single quotes in `.html` template (strictly enforced).
- **AI Context**: Strip `rows` and `dispatch` keys before sending to LLM (token limit management).

### Restricted Areas (Do Not Modify)
- **JS State**: `_aiSessionId`, `_aiContext`, `rows`, `woOrder`.
- **DOM IDs**: `#wkp-ai-*`, `#wsum-*`, `#wkp-pane-*`.
- **API Return Schema**: Keyed by `item_code` for dispatch and item summary.

---

## 🔄 DEVELOPER STATE SYNC (Session WKP-039 — 2026-05-14)
**Sync Block for Context-Aware AI Development**

### WKP-039 — Modal v2 design system (color psychology + table-first content)

```
[chaizup_toc · wo_kitting_planner · WKP-039 · 2026-05-14]
- Three modals redesigned with a shared `wkp-m2-*` design system:
    • Work Order Detail (Production Plan tab) — was a 4-section info-row
      grid; now: tone-coded header stripe, status banner card, 4-card
      KPI strip (Planned / Produced / Still to Produce / Cost or
      Materials to Buy), sectioned tables with sticky headers, tone-
      coded pills for status / kit-status / pending demand.
    • Material Shortage Detail — was a header strip + flat table; now:
      tone-coded header, status banner, 4-card KPI strip
      (Items Short / Shortage Value / PO+MR Coverage / Materials in
      BOM), breakdown table wrapped in a colored section with
      pill-styled stage legend.
    • Row-Detail Modal (WKP-037 — Material Shortage + Purchase Priority
      Details) — was inline tables; now: KPI strip (Net Gap / In Stock /
      Required / Pipeline) + two parallel sections (Work Orders + Linked
      Sales Orders).
- New CSS namespace `wkp-m2-*`. Reused chrome: `wkp-overlay /
  wkp-modal / wkp-modal-head / wkp-modal-body / wkp-modal-close`.
- New HTML attribute `data-tone` on `<div class="wkp-modal" ...>`. JS
  sets it dynamically per modal context (ok / warn / err / info /
  brand). CSS resolves to a 4px colored top stripe + matching title
  icon background.
- Components: `.wkp-m2-title-row`, `.wkp-m2-title-icon`,
  `.wkp-m2-banner[data-tone]`, `.wkp-m2-kpis` (grid),
  `.wkp-m2-kpi[data-tone]` (4px colored left rail),
  `.wkp-m2-section[data-tone]`, `.wkp-m2-section-head`,
  `.wkp-m2-section-body`, `.wkp-m2-table` (sticky thead + zebra +
  hover), `.wkp-m2-pill[data-tone]`, `.wkp-m2-grid-2` (two-up layout).
- Restricted:
    * `data-tone` values: ok / warn / err / info / brand. Don't invent
      new ones without updating the CSS.
    * Tone derivation rules live in JS (`_showWOModal`,
      `_showShortageModal`, row-detail click handler). Single source
      of truth for which color goes where.
    * v2 classes are additive — the legacy `wkp-wo-grid /
      wkp-wo-section / wkp-wo-info-row` classes still exist in CSS for
      any out-of-tree caller; do not delete them.
- Verified: node --check rc=0, page wrap closes at byte 31104, HTML
  apostrophe lint clean. Engine-side: no Python changes.
```

---

## 🔄 DEVELOPER STATE SYNC (Session WKP-037 + WKP-038 — 2026-05-14)
**Sync Block for Context-Aware AI Development**

### WKP-038 — Hide/Show controls bar + visual differentiation polish

```
[chaizup_toc · wo_kitting_planner · WKP-038 · 2026-05-14]
- Added a slim 26px collapse strip `.wkp-cmd-strip` pinned above
  `#wkp-cmd`. Single Hide / Show button toggles `.wkp-cmd-hidden` on
  `#wkp-cmd`; CSS animates max-height + opacity + padding so the
  cmd bar "rolls up" smoothly. State persisted in sessionStorage key
  `wkp.cmd.hidden`. Hard refresh resets it (intentional — a teammate
  opening the page fresh should see the full UI).
- New JS method `_initCmdToggle` wired from `_bindControls`.
- DOM ids that JS reads: #wkp-cmd, #wkp-cmd-toggle, #wkp-cmd-toggle-icon,
  #wkp-cmd-toggle-label, #wkp-cmd-strip-label, #wkp-cmd-strip.
- Visual hierarchy: cmd (white surface, sh-sm) → cmd-strip (slate-50,
  26px) → hint-bar (soft brand gradient) → summary (slate-100 + lifted
  white cards) → tab-bar (white + brand 3px underline on active) →
  content (white). Restraint over palette overhaul.
- When hidden, the strip turns brand-50 and the toggle button outlines
  in brand orange — a soft visual cue that "controls are tucked away".
- Restricted: strip stays visible always (only way back); state key
  scope is per-tab (sessionStorage), not per-user (localStorage);
  CSS max-height transition value (600px) caps cmd height so the
  animation duration is predictable.
- Live verified: JS rc=0, HTML apostrophe lint clean, page wrap closes
  at byte 30580.
```

### WKP-037 — Material Shortage + Purchase Priority Details now open in a modal

```
[chaizup_toc · wo_kitting_planner · WKP-037 · 2026-05-14]
- Material Shortage and Purchase Priority "Details" no longer expand
  inline rows inside the table. Click → opens new modal
  #wkp-row-detail-modal. Body is cloned from a hidden per-row
  `.wkp-row-detail-source` div that lives OUTSIDE the table (in a
  separate `.wkp-row-detail-source-container`), so page-level filters
  (search, item-group, tab-sum click filter) physically cannot touch
  the modal content.
- Details buttons now carry data-detail-source / -title / -sub
  attributes. Delegated click in `_bindControls` matches
  `.wkp-sr-detail-btn, .wkp-pp-detail-btn`, copies the source div's
  innerHTML into #wkp-row-detail-body, opens the modal.
- New _openModal(id) helper paired with existing _closeModal.
- Item-group filter loop in shortage tab simplified — no more paired
  detail-row sync (details aren't inline anymore).
- Restricted: Detail button data-* attribute names are part of the
  click handler contract; the source div id MUST equal
  data-detail-source.
```

---

## 🔄 DEVELOPER STATE SYNC (Session TS-001 — 2026-05-14)
**Sync Block for Context-Aware AI Development**

### TS-001 — TOC Settings = single source of truth; report status pickers removed

```
[chaizup_toc · WKP + POR · TS-001 · 2026-05-14]
- Removed per-report SO/WO/PO multi-select pickers from WO Kitting Planner
  and Production Overview. Replaced with a read-only "Active Pending Filter"
  banner sourced from a NEW shared whitelist
  chaizup_toc.api.wo_kitting_api.get_toc_pending_filters which returns
  {wo, so, po, edit_route} read from TOC Settings.
- New backend helpers _toc_settings_wo/so/po_statuses resolve defaults
  from TOC Settings. Every WKP/POR fallback path switched from
  _DEFAULT_WKP_* constants to these helpers, so blank kwargs now resolve
  to TOC Settings. Explicit API kwarg overrides still win.
- WKP JS: deleted multi-select internals (populate/toggle/selectAll/
  updateLabel/readMs/readSelections/markDirty/clearDirty). Kept
  this._selWo/_selSo/_selPo as empty arrays for back-compat with the
  JSON.stringify(this._selWo || []) round-trips in every existing
  frappe.call.
- POR JS: same treatment. Warehouse multi-select retained (per-report
  filter, not status). _renderPendingBanner added on both controllers.
- CSS: .wkp-pending-banner / .por-pending-banner with three chip groups
  (Workflow: chips styled with indigo .wf modifier).
- Two new top-level docs: apps/chaizup_toc/chaizup_toc.md (app root —
  navigation, feature index, scenario matrix) + apps/chaizup_toc/FORMULAS.md
  (every engine formula with file:function references).
- Verified live: banner payload correct; Calc SO + Calc Action + get_open_work_orders
  + simulate_kitting + get_production_overview all return identical numbers to
  pre-TS-001 because TOC Settings has the same defaults.
- Restricted: never re-introduce per-report status pickers; banner endpoint
  name is shared between WKP and POR (rename requires both JS files
  updated in lockstep); keep this._selWo/_selSo/_selPo as empty arrays
  on both controllers; keep production_overview_api.get_default_statuses
  whitelist for back-compat with other endpoints.
```

---

## 🔄 DEVELOPER STATE SYNC (Session BTP-001 — 2026-05-14)
**Sync Block for Context-Aware AI Development**

### BTP-001 — Buffer-type purge + configurable WO/PO pending statuses

```
[chaizup_toc · production_plan_engine · BTP-001 · 2026-05-14]
- FG/SFG/RM/PM classification fully retired. Two new patches drop the
  Item Custom Field and the legacy TOC Item Group Rule doctype. Engine
  result dict no longer carries "buffer_type" — "mr_type" is canonical.
  Reports + pipeline_api + daily_tasks + mr_generator log all coalesce
  on `data.get("mr_type") or data.get("buffer_type") or ""`.
- Saved Report Views keep the filter fieldname `buffer_type` (renaming
  breaks user bookmarks). Internal dispatch uses `mr_type`.
- TOC Buffer Log.buffer_type column kept for migration safety + DBM
  weekly evaluator. Engine writes the `mr_type` value into it.
- 4 new TOC Settings fields under a new section "Pending Work Order &
  Purchase Order Statuses": pending_wo_statuses, pending_wo_workflow_states,
  pending_po_statuses, pending_po_workflow_states. Defaults match the
  previously hardcoded clauses so existing sites see no behaviour
  change when the fields are blank.
- New engine helpers: _parse_wo_statuses, _parse_po_statuses,
  _wo_has_workflow_column / _po_has_workflow_column (cached), _toc_*
  readers, _wo_eligibility_sql / _po_eligibility_sql.
- Threaded into _pending_wo_qty, _open_po_qty,
  _wo_required_component_qty. No more hardcoded WO/PO status IN clauses
  in those three.
- WKP + POR pages already have their own user-controllable WO/SO/PO
  multi-selects (WKP-034); BTP-001 only refactored the engine helpers.
- Restricted: keep the Script-Report filter fieldname `buffer_type` for
  saved-view compat; keep TOC Buffer Log.buffer_type column; do NOT add
  hardcoded `status IN (...)` in new engine code (use _wo/_po
  _eligibility_sql); workflow branches must stay has_column-gated;
  _parse_* fallbacks MUST return the canonical defaults, not [].
- Live verified: Custom Field + doctype gone; _pending_wo_qty + 
  _open_po_qty return real numbers via the new helpers; Calc SO re-run
  unchanged.
```

---

## 🔄 DEVELOPER STATE SYNC (Session SPA-001 — 2026-05-14)
**Sync Block for Context-Aware AI Development**

### SPA-001 — Action-aware Shortage Cover + Shortage Action

```
[chaizup_toc · Item Minimum Manufacture · SPA-001 · 2026-05-14]
- Schema: action_type (Select Manufacture/Purchase, default Manufacture),
  auto_on_shortage (Check), auto_on_max_level (Check),
  max_level_threshold_pct (Percent, default 50). Wider columns.
- Calc SO is now action-aware: row.action_type=Manufacture -> existing PP
  path (status "Created (PP)"); row.action_type=Purchase ->
  _create_purchase_mr_for_shortage writes an MR (status "Created (MR)").
  Dedup split between _so_shortage_pp_exists and
  _shortage_cover_artifact_exists("Purchase").
- New engine run_shortage_action_automation: iterates min-mfg rows with
  auto_on_shortage=1 OR auto_on_max_level=1. Shortage mode
  (demand-supply>0) and Max-Level mode (cover_pct<threshold), Shortage
  mode evaluated first. Same artifact creator via action_type. Reason
  text marker [Calc Action]. Dedup via _shortage_action_artifact_exists.
- New helpers: _build_min_mfg_index, _open_po_qty,
  _wo_required_component_qty (scoped by source_warehouse),
  _pending_so_eligibility_sql.
- Run Log/Item Selects bumped: triggered_by += shortage_action_*;
  calc_used += "Calc Action"; status += "Created (PP)", "Created (MR)",
  "Skipped - MR Exists".
- TOC Settings: new Button "Run Shortage Action Now" wired in
  toc_settings.js (_wire_shortage_action_run_button).
- Live: seeded FG (stock=0, max_level=10000, threshold=90%) -> Calc
  Action created MFG-PP-2026-00068 qty=10000; dedup re-run -> Skipped
  (PP Exists).
- Restricted: WO required-component query must filter source_warehouse;
  MR helper must divide by Item.purchase_uom conversion_factor;
  Shortage mode evaluated before Max-Level mode (single artifact per
  row per run); dedup markers [Calc SO] vs [Calc Action] must stay
  distinct; do not bulk-dispatch min_manufacturing_qty; do not remove
  the new Run Item Select options.
```

---

## 🔄 DEVELOPER STATE SYNC (Session SPE-001 — 2026-05-13)
**Sync Block for Context-Aware AI Development**

### SPE-001 — Manual run-log fix + standalone Sales-Order Shortage Engine

```
[chaizup_toc · production_plan_engine · SPE-001 · 2026-05-13]
- run_production_plan_automation (v1 SP-form whitelist) now delegates to
  _run_for_projection so the manual SP-form button writes a TOC Production
  Plan Run Log. Return shape changed: list[dict] -> { ok, run_log, summary,
  message }; sales_projection.js handles both shapes.
- NEW: run_so_shortage_automation(triggered_by) — standalone Sales-Order
  Shortage engine. Scans every pending SO (PATH A workflow_state + PATH B
  status, same as Calc B), aggregates pending qty in stock UOM
  (soi.stock_qty - delivered_qty * conversion_factor), groups by
  (item, COALESCE(soi.warehouse, so.set_warehouse, default_so_warehouse)).
  Creates a PP per pair where pending - stock - pending_wo > 0.
  qty = max(shortage, minmfg_per_warehouse_stock_uom).
- New helpers: _discover_pending_so_pairs, _so_shortage_pp_exists.
- Schema additions: triggered_by Select += {so_shortage_manual,
  so_shortage_cron}; calc_used Select += "Calc SO"; status Select +=
  "Error - See Log"; TOC Settings += Button run_so_shortage_automation_now.
- JS: toc_settings.js adds _wire_so_shortage_run_button (mirrors the
  existing Run Now button). sales_projection.js renders v2 summary +
  Run Log link.
- Live: 45 pairs discovered; first run 18 created / 27 skipped; second
  run 0 created / 45 skipped (dedup correctly blocks re-creation).
- Restricted: pending-qty SQL must use stock_qty - delivered_qty *
  conversion_factor; dedup must exclude Completed/Closed PPs; do NOT
  call from daily_production_plan_automation; do NOT collapse Calc SO
  with Calc A/B; do NOT remove _process_item v1 (mr_generator still
  uses it); do NOT reintroduce per-iteration counter save.
```

---

## 🔄 DEVELOPER STATE SYNC (Session IMM-003 — 2026-05-13)
**Sync Block for Context-Aware AI Development**

### IMM-003 — Auto-ADU toggle + history gate + bulk UI (layered on IMM-002)

```
[chaizup_toc · Item Minimum Manufacture · IMM-003 · 2026-05-13]
- New column auto_adu (Check, default 1). Default = engine-managed; toggle OFF
  to enter ADU manually. adu is no longer read_only=1 in doctype JSON; the
  form-side _toggle_adu_readonly toggles editability per row via
  grid_row.toggle_editable("adu", !auto).
- Daily task update_min_mfg_adu_levels gained two guards:
    1. Skip auto_adu=0 rows entirely (no writes, including last_updated_on).
    2. Warm-up gate — skip if MIN(SLE.posting_date) > today - lookback_days.
       Prevents systematic ADU understatement on items with short history.
  Log message now reports 4 counters: updated / manual / warming-up / errors.
- toc_item_settings Bulk Configuration modal: 3 new APPLY rows
  (minmfg_auto_adu, minmfg_lead_time_days, minmfg_safety_factor) → server
  dispatches to _bulk_set_minmfg_field = single UPDATE per item.
- Explicitly NOT bulk-settable: adu (engine or row-specific),
  min_manufacturing_qty (warehouse-specific batch sizing).
- Live verified: schema column present; manual row untouched; bulk endpoint
  wrote auto_adu=0, lead=14, safety=1.75 across all rows of seeded item.
- Restricted: warm-up gate; manual-row skip; bulk excluded fields; use
  toggle_editable not set_df_property for per-row read-only.
```

---

## 🔄 DEVELOPER STATE SYNC (Session IMM-001 — 2026-05-13)
**Sync Block for Context-Aware AI Development**

### IMM-001 — Item Minimum Manufacture: UOM gate + 3 new columns + max_level auto-calc

This is technically an Item Master change, but it directly feeds the WKP Production Plan engine&apos;s MINMFG floor and the buffer-cap inputs that the Purchase Priority tab will consume.

**Sync Block (cross-AI continuity)**

```
[chaizup_toc · Item Minimum Manufacture · IMM-001 · 2026-05-13]
- Child doctype Item Minimum Manufacture (parent Item.custom_minimum_manufacture)
  gained 3 columns: lead_time_days (Int), safety_factor (Float, default 1.0),
  max_level (Float, read-only, auto = qty × lead × safety, rounded 3dp).
- UOM Link in each row is now gated to Item.uoms[].uom ∪ Item.stock_uom.
  Adding rows is blocked until parent UOMs are configured AND the Item is
  saved (visible hint explains why).
- Client formula + dropdown gate in public/js/item_toc.js:
    _setup_min_mfg_grid(frm) called from refresh / after_save / uoms_on_form_rendered.
    _recompute_max_level(cdt, cdn) wired to min_manufacturing_qty /
    lead_time_days / safety_factor handlers.
- Server formula + UOM validation in overrides/item.py _validate_min_mfg_rows
  (called at TOP of on_item_validate, BEFORE the TOC-enabled early-return).
- Child doctype controller (ItemMinimumManufacture.validate) re-recomputes
  max_level so writers that bypass the Item form (REST, bench console) still
  persist a correct value.
- Verified live: schema columns present; max_level computes correctly for
  qty=100/lead=7/safety=1.5 -> 1050; safety=0 defaults to 1.0; disallowed
  UOM rejected; no-UOM-but-has-rows rejected.
- Restricted: _validate_min_mfg_rows position above early-return; max_level
  stays read_only; no handler on max_level field (infinite loop); UOM
  set_query must guard against empty list; field names are hardcoded in
  _build_min_mfg_map SQL — coordinate any rename.
```

---

## 🔄 DEVELOPER STATE SYNC (Session WKP-035 / WKP-036 — 2026-05-13)
**Sync Block for Context-Aware AI Development**

### WKP-035 — Global Search vs. Detail-Row interaction (bug fix)

**Symptom**
On the Purchase Priority tab, with `czmat/1278` typed in the global search, clicking the row&apos;s Details button showed nothing. Clearing the search and clicking Details on the same row worked normally.

**Root cause**
- `_applyGlobalSearch` skipped detail rows (`.wkp-sr-detail-row`) for class assignment, but did not synchronise their visibility with their paired main row. Worse, the inline `onclick` toggle for Details used a fragile string check on `r.style.display` that, depending on prior state, could land in the wrong branch of the ternary and hide instead of showing.
- When the user had previously expanded a row, then started typing in search, the detail row carried stale visible state, and CSS interactions with the search-active highlight caused the toggle to read an unexpected `style.display` value.

**Fix (WKP-035)**
1. `_applyGlobalSearch` was generalised:
   - Detail rows are detected by class `wkp-sr-detail-row` OR by id prefix (`wkp-sr-d-`, `wkp-pp-d-`, `wkp-iv-d-`). All three tabs share the rule.
   - After classifying main rows, the loop walks each main row, derives the paired detail id from its `data-item` attribute, and:
     - When the main row is `wkp-search-match`, the detail row gets the same class so the CSS hide rule never applies.
     - When the main row is `wkp-search-no-match`, the detail row is force-collapsed (`style.display = "none"`) and its Details button text is reset to `▼ Details`.
2. The Details onclick toggle was rewritten to be deterministic:
   ```js
   var open = (r.style.display !== "none") && (r.offsetHeight > 0);
   r.style.display = open ? "none" : "table-row";
   this.textContent = open ? "▼ Details" : "▲ Hide";
   ```
   `offsetHeight > 0` is the source of truth for "currently visible" regardless of whether visibility came from inline style or CSS, eliminating the prior ambiguity.

**Restricted areas (WKP-035)**
- Detail-row id prefixes (`wkp-sr-d-`, `wkp-pp-d-`, `wkp-iv-d-`) are used by `_applyGlobalSearch` to pair main rows with detail rows. Adding a new tab with detail rows MUST follow the same prefix convention.
- The Details onclick toggle must use the `offsetHeight > 0` check. Reverting to the pre-WKP-035 `r.style.display === ''` ternary reintroduces the czmat/1278 bug.
- `_applyGlobalSearch` MUST set `wkp-search-match` on detail rows whose main row matches, AND `wkp-search-no-match` (+ `style.display=none`) on detail rows whose main row does not match. Skipping either side leaves orphan content visible after the user clears a search.

---

### WKP-036 — Tab-relevant chrome + clickable tab-scoped summary cards

**Why**
Two complaints on small / low-PPI screens:
1. The global filter bar and 5-card summary strip were always visible, eating ~140 px of vertical space, leaving the table cramped on Dispatch / Item View / Purchase Priority where those cards are WO-plan-derived and irrelevant.
2. Only the WO Plan cards were clickable to filter the table. Other tabs had no equivalent affordance.

**What changed (WKP-036)**
1. `_switchTab` now consults a `chromePerTab` map and toggles `#wkp-filter-bar` and `#wkp-summary` visibility per active tab:
   - WO Plan: filter bar + summary visible.
   - Shortage Report: summary visible (WO-derived numbers are still meaningful for the same simulation), filter bar hidden.
   - Emergency / Dispatch / AI / Item View / Purchase Priority: both hidden — the table claims the recovered vertical space.
2. Each table-driven tab now renders its OWN clickable summary strip at the top of its pane via JS at render time:
   - **Dispatch** (`_renderDispatchBottleneck`): 4 cards — Critical / At Risk / On Track / Surplus, keyed to `dsp_status`.
   - **Item View** (`_renderItemView`): 4 cards — Blocked WO / Active WO / SO No WO / On Track, computed from `kitByItem` and `item.wo_count`/`so_count`.
   - **Purchase Priority** (`_renderPurchasePriority`): 4 cards — Critical Gap / In Procurement / Fully Covered / Urgent SO, derived from `net_gap`, `open_po_qty`, `open_mr_qty`, and `urgency`.
3. Each row gets `data-cat="<bucket>"` (and `data-urgent="0|1"` on PP) at render time.
4. A single delegated click handler in `_bindControls` wires every `.wkp-tab-sum-card` click:
   - Toggles the card&apos;s `.active` state (other cards in the same strip clear).
   - Sets `data-cat-match="1"` on matching `tbody tr[data-cat]` and `""` on the rest.
   - Toggles `.wkp-tab-sum-active` on the sibling table.
   - CSS rule `.wkp-tab-sum-active tbody tr[data-cat]:not([data-cat-match="1"]) { display:none; }` enforces the visibility.
   - Any detail rows paired with a hidden main row are force-collapsed (`style.display = "none"`) and their Details button text reset.

**Restricted areas (WKP-036)**
- `data-cat` values per tab MUST match the keys used in the card strip&apos;s `data-cat` attributes. Misalignment yields a silent always-empty filter.
- The PP "urgent" card is special — it filters by `data-urgent="1"` rather than `data-cat`. Do NOT collapse the two attributes.
- `chromePerTab` MUST stay synchronous with the actual content of each pane. If a future tab adds its own internal filter / summary, set `summary:false` AND `filterBar:false` to avoid double-rendering.
- `.wkp-tab-sum` (strip) MUST be the IMMEDIATE previous sibling of the table (or its wrapping `<div>`). The click handler uses `strip.nextElementSibling` and falls back to `querySelector("table")` for one level of `<div>` wrap. Two levels of wrap will break the binding.
- The same global click handler also dismisses the strip&apos;s active state when the user clicks the same card again. Do NOT add a separate "clear" button — that breaks the toggle UX.
- HTML rule (POR-023 family): zero raw apostrophes in `wo_kitting_planner.html` outside HTML comments. Verified at commit time.

### Sync Block (cross-AI continuity, WKP-035 + WKP-036)

```
[chaizup_toc · wo_kitting_planner · WKP-035 + WKP-036 · 2026-05-13]
- Fixed: search + Details interaction (czmat/1278 repro). _applyGlobalSearch
  now pairs main rows with their detail rows by id prefix (wkp-sr-d- /
  wkp-pp-d- / wkp-iv-d-). Matching: detail row also gets wkp-search-match.
  No-match: detail row force-collapsed + button reset. Inline Details
  toggle rewritten to use `offsetHeight > 0` instead of the fragile
  `r.style.display === ''` ternary.
- Chrome trimmed per tab: chromePerTab map in _switchTab hides
  #wkp-filter-bar and #wkp-summary on tabs where they are not meaningful
  (Emergency, Dispatch, AI, Item View, Purchase Priority). Table claims
  the freed vertical space — helps low-PPI / small-screen users.
- Tab-scoped clickable summary strips: Dispatch / Item View / Purchase
  Priority each render a .wkp-tab-sum strip with 4 cards at the top of
  their pane. Each card has data-cat; rows have data-cat. Single
  delegated click handler in _bindControls toggles .active +
  data-cat-match attributes; CSS hides non-matching rows.
- WO Plan retains its original cards via #wkp-fbar-status (unchanged).
- Restricted: detail id prefix convention, the offsetHeight toggle,
  data-cat alignment between cards and rows, chromePerTab consistency,
  strip+table sibling relationship, HTML zero-apostrophe lint.
```

---

## 🔄 DEVELOPER STATE SYNC (Session WKP-034 — 2026-05-13)
**Sync Block for Context-Aware AI Development**

### Latest Logic & Architecture (WKP-034)
- **User-selectable SO / WO / PO statuses** — three multi-select dropdowns in the page filter bar drive every tab. Universe per `wkp_get_default_statuses` (dynamic — `SELECT DISTINCT status FROM tab<DocType>`).
- **Workflow state surfacing** — SO panel includes `Workflow: <state>` entries when `tabSales Order` has a `workflow_state` column. Backend splits these out via `_wkp_split_status_and_workflow` and routes them into a separate `(so.docstatus=0 AND so.workflow_state IN (...))` branch.
- **Explicit Load button** — recalculates with current selections. Any checkbox change pulses the button and toasts the user; nothing fires per-keystroke.
- **End-to-end status propagation** — `get_open_work_orders`, `simulate_kitting` (supply pool), `get_dispatch_bottleneck` (SO universe + PO inbound), `get_item_wo_summary` (WO + SO scope) all accept JSON-list kwargs. Empty list falls back to `_DEFAULT_WKP_*` constants — NEVER to unfiltered SQL.
- **HTML safety** — full pass for raw apostrophes (POR-023). Added CSS comment uses no apostrophes. 0 raw apostrophes outside HTML comments at commit time.

### Restricted Areas (WKP-034 — DO NOT change without review)
- `_DEFAULT_WKP_WO_STATUSES` / `_DEFAULT_WKP_SO_STATUSES` / `_DEFAULT_WKP_PO_STATUSES` constants — every helper falls back to these.
- `_wkp_parse_status_list` empty → default fallback (NOT 1=0). Critical so legacy callers omitting the kwarg behave identically to pre-WKP-034.
- `_wkp_so_status_clause` / `_wkp_po_status_clause` empty/blank → `1=0` (match nothing) — this is the safe default when the user unchecks everything via UI.
- `frappe.db.has_column("Sales Order","workflow_state")` guard MUST stay around any reference to `so.workflow_state`. Otherwise sites without an SO Workflow throw OperationalError 1054.
- `#wkp-status-filter` legacy hidden `<select>` MUST stay in the DOM for back-compat.
- Multi-select labels: "Default" when all-checked OR none-changed, "<N> selected" when a strict subset is checked, "None" when explicitly all-unchecked. The label state drives the active border colour on the button.

## Phase A — Editable Filters + Warehouse Context + Table-First UI (2026-06-05)

Phase A **reverses TS-001** (2026-05-14, which had removed the per-report pickers
in favour of a read-only TOC-Settings banner) and **restores the WKP-034 editable
SO/WO/PO `Status : Workflow` multi-selects**, adding three things on top:
warehouse/company scoping, an inline column sort, and a slimmed table-first layout.
The driving principle was the user's: *"the calculation and filter will be like
item-short-surplus"* and *"make sure the old user should not [be] confused"* — so the
pickers pre-fill from TOC Settings on load and the warehouse/company scope defaults to
"all" (today's view) until the user narrows it.

### What changed
- **Read-only banner → editable filter row.** `#wkp-pending-banner` was replaced by
  `#wkp-filter-row` containing five pickers — SO/WO/PO `Status : Workflow` multi-selects,
  a **Warehouses** multi-select, and a **Company** single-select — plus an explicit
  **Load** button. Selections only mark Load *dirty* (`.wkp-load-dirty` pulse); heavy
  recompute is gated behind an explicit Load click (WKP-034 RESTRICT preserved). The
  legacy hidden `#wkp-status-filter` `<select>` is kept for back-compat.
- **New endpoint `wkp_get_filter_universe()`** (one round-trip that seeds the whole bar):
  returns `statuses` (delegates to `wkp_get_default_statuses` — single source of truth),
  `warehouses` (enabled non-group), `wh_default` (the TOC Settings `warehouse_rules`
  rows whose `warehouse_purpose == "Inventory"`), `companies`, and `company_default`
  (Global Defaults). A **blank** `wh_default` means the page loads across ALL warehouses.
- **Warehouse / company scoping** threaded as optional `warehouses` (JSON list) + `company`
  kwargs through `get_open_work_orders`, `_build_stock_pool`, `simulate_kitting`,
  `get_dispatch_bottleneck`, `get_item_wo_summary`, `_get_open_so_detail`, and the new
  helper `_get_fg_stock`. Resolution is centralised in `_wkp_resolve_wh_scope(warehouses,
  company) → (wh_list, wh_active)`: explicit warehouses ∩ company's warehouses; only
  company ⇒ its warehouses; neither ⇒ `active=False`. **Every** warehouse predicate (and
  its `%(whs)s` param) is appended **only when `wh_active`** — blank scope ⇒ byte-identical
  to today's SQL (the no-surprise guarantee). Warehouse columns used:
  `Work Order.fg_warehouse`, `Bin.warehouse`, and
  `COALESCE(NULLIF(line.warehouse,''), NULLIF(header.set_warehouse,''))` for SO/PO/MR lines.
- **Inline column sort** (`#wkp-sortbar`, ported from item-short-surplus). Because WKP
  renders one plain HTML `<table>` per `.wkp-tab-pane` (NOT a single Tabulator), the sort
  operates on the **active pane's** rendered `<tbody>` rows: numeric-aware comparator
  (`data-sort` attr → else parsed cell text → else case-insensitive string), detail/expand
  rows kept paired with their main row, column list re-sourced on every `_switchTab`, and
  the active sort cleared on tab switch / re-render.
- **Slim summary.** `.wkp-summary` compacted to a single-line chip strip (`.wkp-sum-hint`
  hidden) so vertical space goes to the table.

### Behaviour note (intended, verified) — default WO/SO/PO filtering model
Under TS-001 the page sent empty selections, so the **server** fell back to
`_toc_settings_wo_statuses()` — the **compound `Status|WorkflowState` AND-pair** model
(e.g. `Not Started|Taken In Production`). Phase A's pickers instead seed from
`wkp_get_default_statuses()` (plain-status defaults `['Not Started','In Process']` +
separate `Workflow: <state>` tokens) and send them explicitly — the **separable** model
that **Production Overview** (`get_default_statuses`) and **item-short-surplus**
(`_wo_eligibility_sql_local`) already use. On `development.localhost` this moved the
default WO list from **0** (compound pairs match no dev WO workflow_states) to **11**
(`status IN ('Not Started','In Process')`, `docstatus=1` — verified equal to a direct DB
count). This is the **intended migration** the user asked for ("filter like
item-short-surplus") and makes WKP **consistent with its sibling reports**, not a
regression. Edge case left as a follow-up: if a user clears *all* picker tokens, the
server still falls back to the compound-pair `_toc_settings_*` model (`1=0` for SO/PO via
`_wkp_*_status_clause`); harmonising the cleared-state fallback with the separable model
is a future cleanup, not a Phase-A requirement.

### Restricted Areas (Phase A — DO NOT change without review)
- **Conditional predicate rule:** never emit a warehouse SQL fragment or its `whs` param
  unless `wh_active` is True. Breaking this changes results for users who pick no
  warehouse — the exact no-surprise violation Phase A guards against.
- `wkp_get_filter_universe` MUST keep delegating statuses to `wkp_get_default_statuses`
  (single source) and read the Inventory default from `warehouse_rules` /
  `warehouse_purpose == "Inventory"` in lockstep with `buffer_calculator.py` and
  `item_short_surplus_api.py`. Rename the child schema in all three together.
- `wo_kitting_planner.html` MUST stay free of raw single quotes outside HTML comments
  (POR-023) — a single `'` blanks the page. Use `&apos;` / `&quot;`.
- Load is explicit: pickers call `_markLoadDirty()` on change, never auto-`load()`.
- The five picker mount points (`#wkp-so-ms`/`-wo-ms`/`-po-ms`/`-wh-ms`/`-company-ms`) and
  every `wkp-ms-*` / `wkp-sort*` class must keep JS↔CSS parity (verified by grep `comm`).

### Sync Block (cross-AI continuity, WKP-034 + WKP-034.1)

```
[chaizup_toc · wo_kitting_planner · WKP-PhaseA · 2026-06-05]
- Reverses TS-001: read-only banner -> editable #wkp-filter-row with five pickers
  (SO/WO/PO Status:Workflow multi-selects + Warehouses multi + Company single) +
  explicit #wkp-load-btn (pulses .wkp-load-dirty; never auto-loads).
- New endpoint wkp_get_filter_universe(): {statuses (delegates wkp_get_default_statuses),
  warehouses, wh_default (TOC warehouse_rules purpose=Inventory), companies,
  company_default (Global Defaults)}. Blank wh_default = load all warehouses.
- Warehouse/company scope via _wkp_parse_warehouses, _wkp_company_warehouses,
  _wkp_resolve_wh_scope(warehouses,company)->(wh_list,wh_active). Threaded (all
  CONDITIONAL on wh_active, blank=identical-to-today) into get_open_work_orders
  (fg_warehouse filter), _build_stock_pool (Bin.warehouse, PO/MR COALESCE line/header),
  simulate_kitting (pass-through), get_dispatch_bottleneck (+_get_fg_stock new helper,
  +PO inbound), get_item_wo_summary (WO + inline SO), _get_open_so_detail (both branches).
- Columns: Work Order.fg_warehouse; Bin.warehouse;
  COALESCE(NULLIF(line.warehouse,''),NULLIF(header.set_warehouse,'')) for SO/PO/MR.
- Inline sort #wkp-sortbar ported from item-short-surplus; operates on active
  .wkp-tab-pane's HTML <table> tbody (not Tabulator); numeric-aware; pairs detail rows;
  re-sourced + cleared on _switchTab. Slim .wkp-summary chip strip.
- BEHAVIOUR (intended): default WO/SO/PO filtering migrated from server compound
  Status|Workflow AND-pairs (_toc_settings_*; old empty-send -> 0 WOs on dev) to the
  separable plain-status + Workflow: token model (wkp_get_default_statuses; -> 11 WOs,
  == direct DB count status IN defaults). Now consistent with Production Overview +
  item-short-surplus. Cleared-all-tokens still hits compound fallback = future cleanup.
- JS state added: this._selWh, this._selCompany, this._filterUniverse; builders
  _wkpPairMulti/_wkpLinkMulti/_wkpSingleLink (wkp-ms-* classes); _loadDynamicFilters
  seeds all five then fires the single first load(); _markLoadDirty/_clearLoadDirty.
- Verified: JS↔CSS class parity (comm empty), node --check OK, all endpoints run
  blank+scoped (both stock modes), warehouses=[] == no-arg, scoped <= all, build clean.
```
- Extends WKP-034: WO and PO panels now also surface "Workflow: <state>"
  entries (previously only SO did). When a site adds a custom Workflow to
  Work Order or Purchase Order, every distinct workflow_state value appears
  as a tickable option alongside the regular ERPNext statuses.
- Backend now returns wo_has_workflow_column, wo_workflow_states,
  po_has_workflow_column, po_workflow_states in addition to the SO ones.
- _wkp_wo_status_clause extended to (docstatus=1 AND status IN ...) OR
  (docstatus=0 AND workflow_state IN ...) — same shape as SO/PO; wf branch
  is silently dropped on sites without the workflow_state column on Work Order.
- JS _populateMsPanel now takes a `hint` arg per panel and renders the
  "Includes Workflow: …" sub-header when that doctype has at least one
  workflow_state value in user data.

[chaizup_toc · wo_kitting_planner · WKP-034 · 2026-05-13]
- Brought Production Overview's SO/WO/PO multi-select with workflow_state surfacing to WO Kitting Planner.
- New endpoint: chaizup_toc.api.wo_kitting_api.wkp_get_default_statuses
  Returns {wo_statuses, so_statuses, po_statuses (defaults),
           all_wo_statuses, all_so_statuses (with "Workflow: …" entries),
           all_po_statuses, so_has_workflow_column, so_workflow_states}.
- New helpers in wo_kitting_api.py: _DEFAULT_WKP_*, _wkp_parse_status_list,
  _wkp_split_status_and_workflow, _wkp_sql_in, _wkp_so_status_clause,
  _wkp_po_status_clause, _wkp_wo_status_clause.
- Threaded into: get_open_work_orders, simulate_kitting (via _build_stock_pool
  signature change), get_dispatch_bottleneck (+ PO inbound), get_item_wo_summary
  (+ _get_open_so_detail SO list).
- UI: 3 .wkp-ms-* multi-select panels + #wkp-load-btn (pulses .dirty when filter
  changes). Hidden #wkp-status-filter kept for back-compat.
- JS state: this._selWo, _selSo, _selPo, _statusUniverse, _statusFiltersDirty.
  _readStatusSelections() snapshots checkbox state JIT before every API call.
- Empty status list at the engine MUST fall back to _DEFAULT_WKP_* not to
  unfiltered SQL; SO/PO clauses on an empty plain+wf set return "1=0".
- HTML body: zero raw apostrophes (POR-023 family). CSS uses `&apos;`-free
  wording in comments to keep the wrap valid.
- Browser test required: hard-reload /app/wo-kitting-planner; click filter
  buttons → checklists open; uncheck/check → Load button pulses; click Load
  → all tabs recalculate; switch to Dispatch tab → SO list scoped; toggle a
  Workflow: <state> entry on SO panel → drafts in that state appear.
```
