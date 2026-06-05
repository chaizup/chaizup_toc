# WO Kitting Planner — item-short-surplus-style Filters, Warehouse Context, Table-First UI

- **Date:** 2026-06-05
- **App:** `chaizup_toc`
- **Surface:** `/app/wo-kitting-planner` (page `wo_kitting_planner` + API `wo_kitting_api.py`)
- **Status:** Approved design — pending spec review
- **Reference page (patterns to port):** `/app/item-short-surplus` (`item_short_surplus.js/.css` + `item_short_surplus_api.py`)

## 1. Problem / Goal

Bring the proven **filter + calculation + UOM + export + table-first UI** paradigm from
`item-short-surplus` to the WO Kitting Planner, adapted to WKP's per-Work-Order context:

1. **Self-select status filters** — editable `SO Pending (Status:Workflow)`,
   `WO Pending (Status:Workflow)`, `PO Pending (Status:Workflow)` multiselect dropdowns
   (today WKP shows a *read-only* TOC Settings banner — TS-001).
2. **Warehouse context** — a Warehouses multiselect that *converts the whole report* to the
   selected warehouse(s) (today the API does not scope by warehouse at all).
3. **Company** filter.
4. **Sorting** — port the exact inline sort picker from `item-short-surplus` (searchable
   column dropdown + ↑/↓ + auto-scroll-to-column), not header-click.
5. **Onload defaults from TOC Settings** — the page must behave identically to today until a
   filter is changed.
6. **Table-first UI** — slim the 5 big summary cards into a compact strip so the table is the
   focus and fits any screen size.
7. **Dual UOM** (Stock + Higher) on every qty cell.
8. **Drill-down modal** with full per-voucher info in both UOMs.
9. **Best-in-class multi-sheet XLSX export** with both UOMs + well-formatted separate sheets.
10. **Bug audit + fixes** across the page/API.

## 2. Guiding principles (NON-NEGOTIABLE)

- **Do not confuse existing users.** Keep all 7 tabs, the 5 summary metrics, the Stock/Calc
  mode segments, the multi-level toggle, Refresh, and every existing modal. On load, filters
  pre-fill from TOC Settings so the page renders **exactly what it shows today**. New controls
  are additive.
- **Do not break contracts.** Preserve API method names + return schemas and the documented
  DOM IDs (`#wsum-*`, `#wkp-pane-*`, `#wkp-tbody`, `#wkp-shortage-body`, `#wkp-dispatch-body`,
  `#wkp-iv-body`, `#wkp-ai-*`). New behavior arrives via **new optional kwargs** whose default
  (omitted/empty) reproduces today's behavior.
- **Reuse the item-short-surplus patterns** (widget, sort, dual-UOM cell, drill-down, XLSX)
  rather than inventing new ones.
- **HTML rule (POR-023):** zero raw single quotes in `wo_kitting_planner.html` outside HTML
  comments — a violation blanks the page. Use `&apos;` / `&quot;`.
- **ERPNext field mapping:** WO finished good = `production_item` (NOT `item_code`); PO Item
  price = `rate` (NOT `valuation_rate`); Stock Entry → WO link = `work_order`.
- **`frappe.db.has_column(..., "workflow_state")` guard** stays on every workflow_state SQL
  branch (sites without an SO/WO/PO Workflow lack the column → OperationalError 1054).
- **Tiger Theme:** modal work uses the `wkp-m2-*` design system; `data-tone` ∈
  ok/warn/err/info/brand only; `:root` CSS tokens may change value, never rename.

## 3. Phasing

Single spec, three workstreams, sequenced so the user can review/test between phases:

- **Phase A** — Filters (editable SO/WO/PO + Warehouses + Company + Load), warehouse-context
  backend scoping, ported inline sort, slim summary strip.
- **Phase B** — Uniform dual-UOM cells, drill-down modal (both UOMs), multi-sheet XLSX export.
- **Bug audit** — cross-cutting; fixes folded into whichever phase touches the code + a final pass.

## 4. Phase A — Filters + warehouse context + table-first UI

### 4.1 Frontend (`wo_kitting_planner.html` / `.js` / `.css`)

- **Replace** the read-only `#wkp-pending-banner` (in the same location) with an editable filter
  row:
  - `SO Pending (Status:Workflow)` multiselect → `#wkp-so-*`
  - `WO Pending (Status:Workflow)` multiselect → `#wkp-wo-*`
  - `PO Pending (Status:Workflow)` multiselect → `#wkp-po-*`
  - `Warehouses` multiselect → `#wkp-wh-*`
  - `Company` single-select → `#wkp-company-*`
  - `Load` button → `#wkp-load-btn` (recalculates all tabs; pulses dirty on change, toast — same
    UX WKP-034 had before TS-001 removed it).
  - The legacy hidden `#wkp-status-filter` `<select>` stays in the DOM (back-compat).
- **Multiselect widget:** port the `item-short-surplus` pair widget (chip strip + fixed-position
  dropdown + search + select-all/clear + **selected-first ordering** + `change`-event checkboxes —
  i.e. include the 2026-06-05 fixes from that page so the same bugs don't reappear). `wkp-` class
  prefix.
- **Status options source:** `wkp_get_default_statuses` already returns the universe
  (`all_*_statuses` incl. `Workflow: <state>` entries) + TOC-Settings-derived defaults. Reuse it.
  Warehouse + Company option lists come from a small extension (see 4.2).
- **Onload:** check the TOC-Settings defaults (from `get_toc_pending_filters` /
  `wkp_get_default_statuses`); default Warehouses = TOC Settings inventory warehouses (blank ⇒
  all); default Company = Global Defaults default_company. State arrays: `this._selWo/_selSo/_selPo`
  (re-activated, no longer empty stubs), `this._selWh`, `this._selCompany`.
- **Inline sort:** port `item-short-surplus`'s `.iss-sortbar/.iss-sortpicker` as `.wkp-sortbar`,
  wired to the active tab's table; searchable column list built from the active table's columns;
  ↑/↓ toggle; auto-scroll the chosen column into view. Header-click sorting may remain as-is.
- **Slim summary:** keep the 5 metrics + their IDs (`#wsum-ready/partial/blocked/total/
  shortage-val`) and the click-to-filter behavior, but restyle `.wkp-summary` into a compact
  single-line chip strip (smaller padding/font, no tall cards). Responsive: wraps on narrow
  screens; the table claims the freed vertical space.

### 4.2 Backend (`wo_kitting_api.py`)

- Add optional kwargs **`warehouses=None`** and **`company=None`** (JSON list / string) to:
  `get_open_work_orders`, `simulate_kitting`, `get_dispatch_bottleneck`, `get_item_wo_summary`,
  and the internal helpers `_build_stock_pool`, `_get_open_so_detail`, the PO/MR inbound builders.
- **Warehouse-scope SQL** (all blank ⇒ no warehouse predicate ⇒ today's behavior):
  - Stock pool: `Bin.warehouse IN (%(wh)s)`.
  - Work Orders: `wo.fg_warehouse IN (%(wh)s)`.
  - Purchase Orders: `COALESCE(NULLIF(poi.warehouse,''), NULLIF(po.set_warehouse,'')) IN (...)`.
  - Material Requests: `COALESCE(NULLIF(mri.warehouse,''), NULLIF(mr.set_warehouse,'')) IN (...)`.
  - Sales Orders: `COALESCE(NULLIF(soi.warehouse,''), NULLIF(so.set_warehouse,'')) IN (...)`.
  - (COALESCE pattern matches the engine's direct-PO/MR netting fix so user-created vouchers with
    only a header warehouse are still counted.)
- **Company-scope:** resolve `company` → its warehouses and AND into the above (or filter the
  parent docs' `company` column directly where present). A warehouse selection and a company
  selection compose (intersection).
- New whitelist (or extend `wkp_get_default_statuses`) returning the **Warehouse + Company option
  lists** and their TOC-Settings defaults, so the frontend seeds the new pickers in one call.
- Defensive: empty status list still falls back to the TOC-Settings/`_DEFAULT_WKP_*` resolution
  (NOT "no filter"); warehouse/company empty ⇒ no predicate.

### 4.3 Restricted (Phase A)

- Keep API method names + return schemas; only ADD kwargs with safe defaults.
- Keep `#wsum-*`, `#wkp-pane-*`, table-body IDs, `#wkp-status-filter` (hidden).
- Empty status list ⇒ TOC-Settings defaults, never unfiltered.
- `has_column` guard on every `workflow_state` branch.
- Re-introducing editable pickers reverses TS-001 **intentionally** (user-approved 2026-06-05).
  Note it in the page `.md`; the read-only banner is removed, not duplicated.

## 5. Phase B — Dual UOM + drill-down + XLSX

### 5.1 Dual UOM (Stock + Higher)
- Apply the stacked cell (`primary number` / `unit` / `secondary in higher UOM`) consistently to
  every qty column on every tab. Higher UOM = largest `UOM Conversion Detail` with CF>1, falling
  back to stock UOM (same picker as `item-short-surplus` `_pick_higher_uoms`). Backend ships both
  values per cell; JS renders the stack.

### 5.2 Drill-down modal
- Clicking any qty cell opens a modal (built on `wkp-m2-*`) with the full per-voucher breakdown
  (planned vs actual; per WO / SO / PO / MR) in **both UOMs**. Reuse/extend the existing
  `get_material_supply_detail` / `get_voucher_drilldown`-style endpoint; keep cell-click (not
  row-click) per the existing DANGER note.

### 5.3 XLSX export (new, openpyxl)
- New `@frappe.whitelist export_xlsx_kitting(filters)` producing a branded multi-sheet workbook
  (model on `item_short_surplus_api.export_xlsx`):
  - **Main** — the active simulation rows, every qty in BOTH UOMs (separate columns).
  - **Filters & Run Info** — the chosen statuses/warehouses/company + run timestamp.
  - **Material Shortage (sorted)** — shortage components, both UOMs.
  - **Dispatch** — FG vs SO demand, both UOMs.
  - Formatting: branded header band, frozen header row, sensible column widths, number formats,
    zebra. Keep the existing CSV / PDF / email buttons unchanged.

### 5.4 Restricted (Phase B)
- Dual-UOM math = Higher = Stock ÷ CF; never invent a different conversion.
- Drill-down stays cell-click; modal uses `wkp-m2-*` + `data-tone` ∈ the fixed set.
- XLSX is additive; do not remove CSV/PDF/email.

## 6. Bug audit (cross-cutting)

Focused pass; fix clear issues, report each, document in the page `.md`. Candidate areas:
- ERPNext field mapping mistakes (`production_item` / `rate` / `work_order`).
- Missing `has_column` guards on `workflow_state`.
- Warehouse/company scoping consistency once added (no half-scoped tab).
- Dual-UOM gaps (columns showing only one UOM).
- Modal / global-search edge cases (WKP-035 detail-row pairing; `offsetHeight>0` toggle).
- Status-resolution drift now that editable pickers return (ensure blank ⇒ TOC Settings).

## 7. Files touched

**Modify**
- `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html` (filter row, sort bar, slim summary)
- `.../wo_kitting_planner.js` (multiselect widget port, sort port, state, kwargs threading, dual-UOM render, drill-down, XLSX button)
- `.../wo_kitting_planner.css` (filter row, sort bar, slim summary, dual-UOM cells)
- `.../wo_kitting_planner.MD` (TS-001 reversal note, warehouse-context, new sync block, bug log)
- `chaizup_toc/api/wo_kitting_api.py` (warehouse/company kwargs + scoping, options endpoint, XLSX export, drill-down)

**New (optional)**
- A small CSS/JS shared helper is NOT created; patterns are ported inline to keep WKP self-contained (it already vendors its own widget chrome).

## 8. Testing / Verification

- **Onload parity:** with no filter change, every tab returns the SAME numbers as today
  (TOC-Settings defaults). Capture before/after for a sample of WOs.
- **Warehouse scope:** pick one warehouse → WO list, stock pool, shortage, dispatch all narrow to
  it; pick all/none → identical to today.
- **Status pickers:** unchecking a status changes eligibility; blank ⇒ TOC Settings defaults.
- **Sort:** column picker sorts the active table + scrolls the column into view.
- **Dual UOM:** every qty cell shows both; drill-down modal shows both.
- **XLSX:** opens, multi-sheet, both UOMs, formatting intact.
- `node --check` on JS; HTML zero-apostrophe lint; `bench build`; hard-reload page.
- Bug-audit findings each verified fixed.

## 9. Out of scope (YAGNI)

- No change to the AI Advisor tab logic, Stock/Calc mode semantics, or multi-level BOM engine.
- No re-theming beyond slimming the summary strip.
- No removal of CSV/PDF/email exports.
- TOC Settings remains the *default* source; this does not change TOC Settings or other reports.
