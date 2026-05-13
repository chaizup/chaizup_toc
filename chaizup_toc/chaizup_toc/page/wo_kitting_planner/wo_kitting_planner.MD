# WO Kitting Planner

## Purpose & Architecture
The WO Kitting Planner is a production planning tool for Frappe/ERPNext, designed for food/FMCG manufacturing. It allows production managers to simulate material availability across all open Work Orders, identify shortages, and make data-driven decisions.

### Key Features
- **Simulation Engine**: Supports "Current Stock Only" and "Current & Expected" (including POs/MRs/WOs) modes.
- **Calculation Modes**: "Isolated" (each WO checked against full stock) and "Sequential" (WOs consume stock in priority order).
- **AI Advisor**: Powered by DeepSeek (V3/R1), providing automated insights and a persistent chat interface for production support.
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

### Sync Block (cross-AI continuity, WKP-034 + WKP-034.1)

```
[chaizup_toc · wo_kitting_planner · WKP-034.1 · 2026-05-13]
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
