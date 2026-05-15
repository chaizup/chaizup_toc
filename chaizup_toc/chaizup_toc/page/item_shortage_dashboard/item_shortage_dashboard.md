# Item Shortage Dashboard — Frappe Page

Modern single-pane dashboard surfacing the supply / demand balance for every
item the TOC engine watches. Same compute as the
[Item Shortage Dashboard Script Report](../../report/item_shortage_dashboard/item_shortage_dashboard.md);
this Page wraps it in a Tabulator-backed grid with multi-sort, drill-down,
CSV/XLSX export, and an email composer.

```
chaizup_toc/chaizup_toc/page/item_shortage_dashboard/
├── __init__.py
├── item_shortage_dashboard.json   ← Page metadata (9 roles)
├── item_shortage_dashboard.py     ← Empty stub (Frappe page convention)
├── item_shortage_dashboard.html   ← Template: header, filters, actions, grid
├── item_shortage_dashboard.js     ← ItemShortageDashboard controller class
└── item_shortage_dashboard.md     ← THIS FILE
```

Backed by `chaizup_toc/api/item_shortage_api.py` (whitelisted shim that
delegates to the Script Report module so column / formula definitions live in
exactly one place).

## In-depth use cases

1. **Morning planner stand-up** — open the dashboard, sort by
   `Total Shortage incl. Expected` (default), see the worst items at the top,
   click the `Curr Month Pending SO (g)` cell on a Red row to see exactly
   which customer orders are driving the shortage.
2. **Procurement decision** — filter to Item Group = Raw Material,
   Warehouse = Stores, then sort by `Need as per Max Level (p)` to see which
   RMs need to be ordered up to max level. Click `Will Receive from Purchase (k)`
   to confirm there isn't already a PO covering it.
3. **Sales projection sanity check** — set "Will Consumed In" to the next
   month, look at `Sales Projection (n)` vs `Curr Month Pending SO (g)` —
   `SP Cover %` tells the planner whether the projection covers the orders.
4. **Email weekly snapshot** — click Email, address it to the operations
   group, message gets sent with an inline HTML table of the filtered rows
   (light-red rows preserved in email for pending-SO highlighting).
5. **Export to spreadsheet** — Export XLSX gives finance a multi-sheet
   workbook (Tabulator default), and Export CSV gives a quick raw dump for
   pivot tables.

## Dependencies

- **Frappe Page framework** — registered as `item-shortage-dashboard`.
- **Tabulator 6.3.1** — CDN-loaded data grid library
  (`https://cdn.jsdelivr.net/npm/tabulator-tables@6.3.1/`).
- **xlsx 0.18.5** — lazy-loaded only when user clicks "Export XLSX" so it
  does NOT delay first paint.
- **Font Awesome 6.5.1** — icons in header / buttons.
- **chaizup_toc Script Report** at `report/item_shortage_dashboard/` —
  ALL compute (columns, row helpers, formulas) imported by the page API.
- **chaizup_toc.api.wo_kitting_api** — TOC Settings pending-status helpers
  (`_toc_settings_so_statuses`, `_toc_settings_wo_statuses`,
  `_toc_settings_po_statuses`, `get_toc_pending_filters`) for the banner
  and SQL filters.

## Reasoning — why a page when we already have a Script Report?

The Script Report is the canonical Frappe-native delivery — saved Report
Views, scheduled email subscriptions, Insights pinning all work for free.
But it has structural ceilings:

- Frozen-header CSS is fragile against Frappe DataTable upgrades.
- The default formatter / cell-click hooks fight with Frappe's anchor
  rewrite logic.
- Multi-column sort needs a plugin or full custom override.
- Tooltips on column headers and per-cell aren't first-class.

The Page route side-steps all of that by hosting Tabulator inside a clean
DOM and treats the Script Report as a pure compute layer. Both surfaces
are kept in sync because the page never re-implements columns or formulas
— it imports them.

## Database connections

| Source DocType | Field used | Role |
|----------------|-----------|------|
| Item | name, item_name, item_group, stock_uom | row identity / master |
| Item Minimum Manufacture (child of Item.custom_minimum_manufacture) | warehouse, max_level, lead_time_days, safety_factor, adu | one row per rule, parameter columns |
| UOM Conversion Detail (child of Item) | uom, conversion_factor | per-cell UOM tooltip |
| Bin | item_code, warehouse, actual_qty | current_stock (i) |
| Work Order | production_item, fg_warehouse, qty, produced_qty, status | will_recv_production (j) |
| Work Order Item | item_code, source_warehouse, required_qty, transferred_qty | will_be_used_in_open_wos (d) |
| Purchase Order Item / Purchase Order | item_code, warehouse, qty, received_qty, conversion_factor, status | will_recv_purchase (k) |
| Sales Order Item / Sales Order | item_code, warehouse, set_warehouse, stock_qty, delivered_qty, conversion_factor, status, workflow_state, delivery_date | f, g, e |
| Delivery Note Item / Delivery Note | item_code, warehouse, stock_qty, posting_date | curr_month_dispatch (h), total_dispatches |
| Stock Entry Detail / Stock Entry | item_code, t_warehouse, transfer_qty, stock_entry_type, posting_date, is_finished_item | actual_produced_qty (prod) |
| Sales Projected Items / Sales Projection | item, source_warehouse, qty_in_stock_uom, projection_month, projection_year, docstatus | sales_projection (n) |
| TOC Settings | pending_so_statuses, projection_pending_so_statuses, projection_confirmed_so_workflow_states, pending_wo_statuses, pending_wo_workflow_states, pending_po_statuses, pending_po_workflow_states | resolution of "what counts as pending" for SO / WO / PO (single source of truth — TS-001) |

Every helper in `item_shortage_dashboard.py` (the report module) is bulk by
design: one SQL per metric, indexed by `(item_code, warehouse)`. No N+1.

## Frontend architecture

- `frappe.pages["item-shortage-dashboard"].on_page_load` → mounts the page
  shell once, instantiates `ItemShortageDashboard`.
- `ItemShortageDashboard._init()` → loads filter options via
  `chaizup_toc.api.item_shortage_api.get_filter_options` (single call),
  hydrates the banner, then triggers `_refresh()`.
- `_refresh()` → calls `get_dashboard_data` with the current filter state
  and re-renders the Tabulator grid.
- Tabulator config: `layout: "fitDataStretch"`, `movableColumns: true`,
  `virtualDom: true` when row count > 250, `initialSort` set to
  `total_shortage_with_expected DESC`.
- Row formatter applies `.isd-row-pending-so` (light-red background) to
  rows whose `_has_pending_so` flag is true.
- Cell formatter dispatches by column fieldname:
  - Numeric clickable columns → wrap value in `<span class="isd-cell-click">`
    + register cellClick handler that opens the drill-down modal.
  - Link columns (item_code, item_group, warehouse, stock_uom) → render an
    `<a href="/app/...">` opening in a new tab.
  - Shortage / Max Level % columns get conditional colour classes.
  - Decision Qty rendered as a yellow pill.
- Cell tooltip: function returning the value rendered in stock UOM + every
  configured conversion (e.g. "12.00 KG  |  12000.000 g") — sourced from
  the hidden `_uom_conversions` payload attached to each row by the report.
- Header tooltip: explanatory formula caption per column.

## Filter UI

Custom **chip-style multi-select** (no jQuery select2 dependency) for
Item Group / Item Name / Warehouse. Each chip carries an `×` close button.
The dropdown for Item Name uses `frappe.client.get_list` against `Item` so
the search scales to thousands of items (server-side substring filter
against `name` and `item_name`). Item Group + Warehouse use the static
lookup payload from `get_filter_options`.

## Drill-down modal

Built with raw DOM (not `frappe.ui.Dialog`) so it can adopt the Tabulator
visual language exactly. Uses `isd-modal-bg` / `isd-modal` / `isd-modal-hdr`
classes. Body is rebuilt from the backend `get_breakdown` payload — table
with Type / Document (link) / Qty / Detail columns + formula caption.

Supported drill-down columns (matching the report):
`current_stock`, `will_recv_production`, `will_recv_purchase`,
`will_be_used_in_open_wos`, `will_dispatch_pending_so`,
`curr_month_pending_so`, `prev_month_pending_so`, `curr_month_dispatch`,
`total_dispatches`, `actual_produced_qty`, `sales_projection`.

## Export

- **CSV** — Tabulator `download("csv", filename)`. Includes all visible
  columns and respects current sort.
- **XLSX** — Tabulator `download("xlsx", filename, options)` with lazy
  `xlsx` script load on first click.

## Email

Backend builds the inline HTML server-side (in `send_email_snapshot`) so
the page never has to compose markup that could escape JS string wrapping.
The light-red row highlight for pending-SO items is preserved in the email
table via inline `style="background:#FEE2E2"`. Capped at 500 rows in the
body; larger sends are routed to the CSV/XLSX export path.

## Frappe-native look

- `frappe.ui.make_app_page` builds the standard page shell (breadcrumb +
  title area, side menu, sticky page header).
- Inner action buttons render with the existing `.btn` shapes via custom
  `.isd-btn` classes that match Frappe button proportions.
- Colour palette mirrors the Tiger Theme used by `production_overview`
  (slate + indigo brand). DM Sans body + Oswald title + Geist Mono numbers.
- Custom CSS scoped via `#isd-root` so it never leaks into Frappe global
  styles.

## Tooltip strategy

- **Header tooltip**: Tabulator's `headerTooltip` (native HTML title).
- **Cell tooltip**: Tabulator's `tooltip` function — runs per hover, no
  jQuery dependency, returns the UOM conversion ladder built from the
  row's `_uom_conversions` payload.

## Restricted areas (do NOT change without re-reading this file)

- **DOM IDs**: `#isd-root`, `#isd-grid`, `#isd-banner`, `#isd-summary`,
  `#isd-f-company`, `#isd-f-ig`, `#isd-f-in`, `#isd-f-wh`,
  `#isd-f-month`, `#isd-f-year`, `#isd-f-search` are referenced by
  `item_shortage_dashboard.js`. Renaming breaks the page.
- **Page route**: `item-shortage-dashboard` is referenced from the
  workspace JSON shortcut. Renaming breaks the workspace.
- **Frappe template single-quote rule (WKP-001)**: every onclick / title /
  data- attribute in the HTML uses `&quot;` not raw `'`. Adding a raw `'`
  anywhere blanks the page with `SyntaxError`.
- **CSS `%}` rule**: every `%` value in inline styles ends with `;`
  before `}` so Frappe's microtemplate engine doesn't read the `%}` as a
  block-close.
- **Tabulator import path**: pinned to v6.3.1. Newer versions deprecate
  `tooltip` function in favour of `tooltips` plugin — verify before bump.
- **Column compute**: NEVER redefine columns or formulas in the page JS.
  Always consume the backend `columns` payload. The report module is the
  single source of truth.
- **Pending-status helpers**: NEVER inline status defaults here. Always
  call through `chaizup_toc.api.wo_kitting_api._toc_settings_*_statuses()`
  (TS-001 invariant).

## Tested

2026-05-14 on `development.localhost`:
- `get_filter_options` → 11 item groups, 6 warehouses, default company,
  pending status payload.
- `get_dashboard_data({"item_name": ["CZPFG638"]})` → 1 row, stock 40680,
  pending SO 7560, shortage q=33120, `_has_pending_so: true`.
- `get_breakdown(column="curr_month_pending_so", item_code="CZPFG638")` →
  2 contributing SO line items with formula "Σ (SO Item.stock_qty − delivered)
  for delivery in May 2026."
- Page route registered as Frappe Page with module `Chaizup Toc`.
- Workspace shortcut added under TOC Buffer Management → Reports.

## 2026-05-14 Refinement Sync (ISD-008..ISD-015)

The Item Shortage Dashboard now ships **only as a Frappe Page** — the
Script Report surface was retired. Compute lives in
`chaizup_toc.api.item_shortage_compute` (was
`chaizup_toc/chaizup_toc/report/item_shortage_dashboard/`).

| ID | Change | Why |
|----|--------|-----|
| ISD-008 | Script Report folder + Report doc deleted. Compute relocated to `chaizup_toc/api/item_shortage_compute.py`. API shim updated to import from new path. Workspace shortcut for the report removed. | User: "Remove the report item shortage dashboard". |
| ISD-009 | Numeric quantity cells render TWO lines — primary stock UOM value + every UOM conversion as a secondary subtitle (e.g. `1000 g` over `1 kg`). Driven by the existing `_uom_conversions` payload. Percentage / integer columns stay single-line. | User: "Mention both uom Like 1000 gram / 1 kg". |
| ISD-010 | Tabulator column headers wrap onto multiple lines (`white-space: normal`, min-height 60 px, vertical centre). Numeric column widths bumped +35 px so the inline UOM ladder never clips. | User: "Heading text wrap on, and should proper apear". |
| ISD-011 | Summary stat chips redesigned as left-accent cards (3 px coloured bar + larger value glyph + drop shadow) instead of flat pills. | "Make more modern, more int [intuitive]". |
| ISD-012 | Frozen column header z-index bumped (z=8 header / z=7 cells) so during horizontal scroll other column headers scroll BEHIND the frozen item_code column instead of on top of it. Explicit opaque background on the frozen header. | User: "in horizontal scroll the heading overlap instead of hiding under item code". |
| ISD-013 | Loading spinner reworked from `innerHTML` injection (which Tabulator wiped on mount) into an **overlay element** at `.isd-loading-overlay` that sits over the grid host. Toggled via the `.isd-loading-on` class from `_showLoader(true / false)`. | User: "fix loading icon". |
| ISD-014 | New **quick-filter chip bar** between the action bar and the grid: Shortage, Open SO, Open PO, Open WO, Below 50% Max. Multi-select, AND-combined, counts displayed in each chip. Client-side via `Tabulator.setFilter(rowPredicate)` so no extra round-trip. | User: "Add more filter chips like Open so, open po, open wo, shortage". |
| ISD-015 | XLSX export switched from Tabulator's flat single-sheet dump to a **server-side openpyxl multi-sheet workbook** via `chaizup_toc.api.item_shortage_api.export_xlsx`. 5 sheets: Cover (KPIs + filters used + pending status snapshot + sheet guide), Items (full grid with data bars on shortage columns, autofilter, frozen panes), Shortage Drivers (rows where o > 0, sorted desc), Pending SO Items, UOM Conversions (item × UOM × factor matrix). | User: "The excel import format should also more creative". |

### Restricted areas (additional to the original)

- **Do NOT bring back the Script Report folder.** Compute lives in
  `chaizup_toc/api/item_shortage_compute.py` and is imported by the
  page API. A Script Report surface would now drift away from page
  features (chips, both-UOM cells, server XLSX) silently.
- **Do NOT change the Tabulator frozen-column z-index without testing
  horizontal scroll.** ISD-012 fix relies on `z-index:8` on
  `.tabulator-header .tabulator-frozen` exceeding the default scroll
  layer; Tabulator upgrades may shuffle these values.
- **Do NOT recompute UOM conversions on the client.** The factors come
  from `_uom_conversions` (UOM Conversion Detail) attached server-side.
  Recomputing on the JS side would diverge from ERPNext native UOM.
- **Do NOT inline percentage values as `0..100` in XLSX cells.** ISD-015
  divides by 100 before writing so the `0.0%` number_format renders
  correctly. Excel multiplies by 100 when displaying — passing the raw
  value would print `8400%` for a `84` input.
- **Do NOT bypass the server-side XLSX endpoint.** The Tabulator
  client-side xlsx download has been retired (ISD-015); rebuilding it
  would lose the cover + drivers + so-items + UOM sheets the user
  explicitly requested.

## Sync Block (developer state, 2026-05-14 v2)

- **Surface**: Frappe Page only — `item-shortage-dashboard`.
- **Compute**: `chaizup_toc.api.item_shortage_compute` (renamed from
  the deleted report folder). Same 11 bulk SQL helpers + 9 drill-down
  handlers + `execute()` + `get_cell_breakdown()`.
- **Page API**: `chaizup_toc.api.item_shortage_api` — 5 whitelisted
  endpoints: `get_dashboard_data`, `get_breakdown`, `get_filter_options`,
  `send_email_snapshot`, `export_xlsx`.
- **Frontend plugin**: Tabulator 6.3.1, Font Awesome 6.5.1. xlsx lib
  retired (no client-side XLSX path any more).
- **Workspace**: single shortcut "Item Shortage Dashboard" → Page.
- **CSS prefix**: `isd-`. New blocks added: `.isd-qf*` (chips),
  `.isd-loading-overlay` (loader), `.isd-num-primary` / `.isd-num-alt`
  (two-line numeric cell), `.isd-stat-*` (modern stat cards).
- **ISD rules in effect**: ISD-001..007 (carried forward) + ISD-008
  (no Script Report), ISD-009 (inline both-UOM), ISD-010 (header wrap),
  ISD-011 (modern stat cards), ISD-012 (frozen-header z-index),
  ISD-013 (overlay loader), ISD-014 (quick-filter chips),
  ISD-015 (creative XLSX export).
