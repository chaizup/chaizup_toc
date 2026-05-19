# Item Projection View — Page

Route: **`/app/item-projection-view`**

A procurement / planning surface that answers one question per item:

> *"Given my current stock, the inflows in the pipeline (PO + WO production),
> and the demand on the books (WO consumption + pending SO dispatch), how
> much do I have available, and where am I short?"*

Created: **2026-05-18** &nbsp;|&nbsp; Module: **Chaizup Toc** &nbsp;|&nbsp;
Architecture: same as `item_shortage_dashboard` (Tabulator grid + page-facing
API shim + compute layer)

---

## 1. Why this page exists

Existing surfaces overlap but don't cover this specific angle:

| Existing surface | Lens | Audience |
|---|---|---|
| Item Shortage Dashboard (`/app/item-shortage-dashboard`) | TOC buffer health (Max Level vs current + monthly metrics) | TOC ops manager |
| Production Priority Board (`/app/query-report/Production Priority Board`) | Buffer-penetration ranking for *production* | Production supervisor |
| Procurement Action List (`/app/query-report/Procurement Action List`) | Buffer ranking for *purchase* | Procurement officer |

What was missing: a single grid that shows **stock + will-receive − demand**
at item × warehouse granularity in **Higher UOM**, with every numeric cell
explaining the back-end formula and a click-through to the contributing
vouchers.

---

## 2. Architecture

```
Page          chaizup_toc/page/item_projection_view/
   ├── item_projection_view.json         ← Page metadata + roles
   ├── item_projection_view.py           ← Stub (Frappe requirement)
   ├── item_projection_view.html         ← Toolbar / banner / filters / grid host
   ├── item_projection_view.js           ← Tabulator controller
   ├── item_projection_view.css          ← Page styles (native Frappe look)
   └── item_projection_view.md           ← This file

API (page-facing, whitelisted)
   chaizup_toc/api/item_projection_api.py
     • get_dashboard_data(filters)       ← single refresh endpoint
     • get_breakdown(column, item, wh)   ← cell drill-down
     • get_filter_options()              ← bootstrap
     • export_xlsx(filters)              ← branded 7-sheet workbook

Compute (data + math)
   chaizup_toc/api/item_projection_compute.py
     • _pick_higher_uoms(item_codes)
     • _resolve_candidate_items(filters)
     • _build_row(...) → per-row dict with parallel `_tooltips` payload
     • _aggregate_group_rows(rows) → group headers for tree view
     • execute(filters)
```

The compute module **imports** the proven SQL helpers from
`item_shortage_compute.py` (Bin, WO, PO, SO) so the pending-status
semantics never drift between pages. Any fix in those helpers benefits
both pages.

---

## 3. Column set

| # | Field | Type | Source / Math |
|---|---|---|---|
| 1 | Item Code | Link | `Bin.item_code` |
| 2 | Item Name | Data | `Item.item_name` |
| 3 | Item Group | Link | `Item.item_group` |
| 4 | Warehouse | Link | `Bin.warehouse` |
| 5 | Stock UOM | Data | `Item.stock_uom` |
| 6 | Current Stock (Stock UOM) | Float | `Σ Bin.actual_qty` |
| 7 | Higher UOM | Data | UOM with the **largest** `conversion_factor` in `tabUOM Conversion Detail` for this Item. Fallback = stock_uom. |
| 8 | Current Stock (Higher UOM) | Float | `stock ÷ CF` |
| 9 | **Shortage — Physical** | Float | `max(0, demand − stock) ÷ CF` |
| 10 | **Shortage — Projected** | Float | `max(0, demand − (stock + WillReceive)) ÷ CF` |
| 11 | WO Remaining Production | Float | `Σ (WO.qty − produced_qty)` for WOs in TOC-Pending state, this item is FG, matched on `fg_warehouse` |
| 12 | PO Remaining | Float | `Σ (POI.qty − received_qty) × CF` for POs in TOC-Pending state |
| 13 | Will Consume — Open WOs | Float | `Σ (WOI.required_qty − transferred_qty)` for WO Items in TOC-Pending state |
| 14 | Will Dispatch — Pending SO | Float | `Σ (SOI.stock_qty − delivered_qty × CF)` for SOs in TOC-Pending state |
| 15 | Net Available | Float | `stock + WillReceive − Demand` (in Higher UOM) |
| 16 | Days of Cover | Float | `stock ÷ Item.custom_toc_adu_value` |

Where:
- `demand        = WO Consumption + SO Dispatch`
- `WillReceive   = PO Remaining + WO Production`

---

## 4. Pending-status semantics — single source of truth

Pending WO / PO / SO statuses come from **TOC Settings** via
`chaizup_toc.api.wo_kitting_api.get_toc_pending_filters()`. Workflow-state
entries are prefixed `Workflow: <name>` and are only honoured if the
target DocType has a `workflow_state` column.

The chip strip at the top of the page surfaces the current values with a
link to TOC Settings for editing.

---

## 5. Drill-down (`get_breakdown`)

Click any of these numeric cells → opens a `frappe.ui.Dialog` with
hyperlinked contributing vouchers:

| Cell | Dialog content |
|---|---|
| Shortage — Physical | Composite: Stock (per Bin), WO Production, PO, WO Consumption, SO. Shows how each side contributed. |
| Shortage — Projected | Same as Physical. |
| Net Available | Same composite. |
| WO Remaining Production | Per-WO row (this item as FG): planned, produced, remaining, status, planned_start. |
| PO Remaining | Per-PO Item row: ordered, received, CF, remaining in Stock + Higher UOM, supplier, schedule_date. |
| Will Consume — Open WOs | Per-WO row (this item as component): required, transferred, remaining, parent FG. |
| Will Dispatch — Pending SO | Per-SO Item row: stock_qty, delivered, remaining, customer, delivery_date. |
| Days of Cover | Scalar: stock, ADU, ADU period, computed cover. |

Every voucher name is hyperlinked to its desk form.

---

## 6. Tooltip-on-every-number contract

Every numeric cell ships with a parallel `_tooltips` payload (`{fieldname: [lines]}`) computed server-side. The JS controller renders it via a fixed-position custom tooltip on hover. The first line is the formula in plain text; subsequent lines show the actual component values that produced the displayed number.

This is intentionally not a JS-derived display — only the server knows
which pending statuses are active, what the contributing voucher counts
are, and what the conversion factor was for that item.

---

## 7. Filters

| Filter | Type | Notes |
|---|---|---|
| Company | Select | Defaults to user's default company. |
| Item | Multi-chip | Remote autocomplete via `frappe.db.get_link_options`. |
| Item Group | Multi-chip | Pool: all `Item Group` names. |
| Warehouse | Multi-chip | Pool: enabled, non-group `Warehouse`. |
| Only shortage rows | Toggle | OFF by default. ON drops rows where both shortages are 0. |
| Group by Item Group | Toggle | ON by default. Tabulator `dataTree` mode shows expandable group headers. |

When grouped, each header carries summed numeric fields. When the group
contains items with **different** Higher UOMs, the header's Higher UOM
column shows "mixed" and the group tooltip warns that the sum is coarse.

---

## 8. Row + cell highlighting

| Condition | Visual |
|---|---|
| `current_stock < 0` | full row light-red (`ipv-row--negative-stock`) |
| `shortage_physical > 0` | full row pale-red (`ipv-row--shortage-physical`) |
| `shortage_projected > 0` (and physical OK) | full row pale-amber (`ipv-row--shortage-projected`) |
| `days_of_cover < 7` | cell red text (`ipv-cell--alert`) |
| `net_available < 0` | cell red text |

Tabulator's row formatter applies these classes after every data load and
after sort changes.

---

## 9. Roles

`Page.roles`:
- System Manager
- TOC Manager
- TOC User
- Stock Manager
- Purchase Manager
- Manufacturing Manager

(Purchase Manager is explicitly added — the missing role in the existing
Procurement Action List.)

---

## 10. Branded multi-sheet XLSX

`export_xlsx(filters)` builds an `openpyxl` workbook with 7 sheets:

1. **Cover** — KPIs + active pending-status snapshot + filters applied + sheet guide.
2. **Items** — full grid, frozen header, auto-filter, data bars on shortage columns, row-tints mirroring the page.
3. **Shortage Drivers** — items with `shortage_projected > 0`, sorted desc.
4. **Pending WO Production** — per-WO list (this item is FG).
5. **Pending WO Consumption** — per-WO list (this item is component).
6. **Pending PO** — per-PO list.
7. **Pending SO** — per-SO list.
8. **UOM Ladder** — Item × alt UOM × CF matrix (full ladder, not just the chosen Higher UOM).

Frappe streams the bytes via `frappe.local.response` — the browser
downloads it directly, no File doctype involved.

---

## 11. Restricted areas (do NOT change without architectural review)

1. **Pending-status definitions** — must always come from
   `wo_kitting_api.get_toc_pending_filters()`. TS-001 single-source-of-truth.
2. **SQL helpers** — re-used from `item_shortage_compute`. Don't fork them
   here. If you need to change a query, fix it there and both pages benefit.
3. **Tooltip payload schema** — `_tooltips` is a flat dict keyed by
   fieldname (or `_group` for header rows), value is `list[str]`. Don't
   nest. Don't switch to HTML — the JS escapes lines as text.
4. **Higher UOM picker** — largest conversion factor per item. Don't
   change to "first in ladder" or per-item-group override without updating
   the docs and the drill-down (which assumes a single CF per item).
5. **Days of Cover** — only meaningful at LEAF rows (per item × warehouse).
   Group headers MUST set `days_of_cover = None`.
6. **`Tabulator` is loaded from jsdelivr in the HTML template**. Don't
   inline a different CDN or version without retesting the dataTree
   + rowFormatter combo (subtle differences between 5.x and 6.x).
7. **Branded XLSX shape mirrors Item Shortage Dashboard**. Keep parity so
   procurement teams have a consistent reading experience across pages.

---

## 12. Hotfix log

### 2026-05-18 (later same day) — Polish pass after first user run

Four fixes shipped after the page went live:

1. **Loading overlay never hid** — `_refresh()` chained `.finally()` on the jQuery Deferred returned by `frappe.call()`. When the inner `.then()` render code threw synchronously (e.g., a transient column shape mismatch), the deferred entered rejected state and `.finally()` didn't always fire. Switched to jQuery's canonical `.always()` hook + wrapped the render body in `try/catch` so the overlay hides unconditionally and render failures surface as a red toast. Added a fallback `setTimeout(hide, 12000)` for the worst-case scenario.

2. **Filter text wrap** — Company select was clipping long company names ("CHAIZUP CONSUMER PRODUCTS PRIVATE LIMITED"). Native `<select>` cannot wrap, so we apply `text-overflow: ellipsis` + a `title` attribute on both the `<select>` and each `<option>` so the full name appears on hover. Widened the Company column from `1fr` to `1.4fr`. For multi-select **chip pills** (item / item-group / warehouse), added `white-space: normal` + `word-break: break-word` + `max-width: 100%` so long item names wrap onto two lines within their pill instead of overflowing the filter card.

3. **Tooltip not firing** — Per-cell `mouseenter`/`mouseleave`/`mousemove` listeners attached inside the formatter were wiped by Tabulator's row pooling on every sort/scroll/dataTree-expand. Replaced with **event delegation**: a single `mousemove` listener on `#ipv-grid` reads `event.target.closest("[data-ipv-tt-key]")`. The tooltip payload now lives on the span itself via `data-ipv-tt-data`, so the delegated handler doesn't need to climb back to the row data. Survives every Tabulator re-render.

4. **Professional font** — Dropped Fraunces variable serif entirely (too editorial for a procurement / planning tool). Switched to **Inter Variable** (body + title + KPIs) + **IBM Plex Mono** (numerics). Simplified the hero title from three styled spans to a single `<h1>` element with Inter 700 weight. KPI values now use Inter 700 / 1.7 rem with tabular-nums instead of the 2 rem Fraunces variable axis. Numerics in the grid + tooltip + dialog tables continue using mono.

5. **Table not populating** — With `dataTreeStartExpanded: false`, a single group header `▾ Packaging Material (866 items)` rendered with no leaf rows visible — looked empty. Combined with `layout: "fitDataStretch"`, columns auto-sized past the viewport width. Fixes: `dataTreeStartExpanded: true` so leaves are visible on first paint; `layout: "fitDataFill"` so columns fill the visible area (horizontal scroll only when data legitimately exceeds); added a `console.info` diagnostic on every render with payload row count + leaf count + group-by flag for future debugging.

6. **Weird native checkbox UI** — Native `<input type="checkbox">` with `accent-color: var(--ipv-brand)` rendered inconsistently across browsers (especially older Chrome / Safari). Replaced with a custom iOS-style **toggle switch** using `appearance: none` + `::before` for the thumb. 38 × 22 px pill, 18 × 18 px thumb that animates with `transform: translateX(16px)` on `:checked`, brand-soft focus ring on `:focus-visible`, full dark-theme parity. Markup unchanged (`<input type="checkbox">` + `<span>`) — purely CSS-driven.

7. **Table still blank — switch from dataTree to Tabulator native groupBy** — The custom `_children` / dataTree path was producing edge-case empty renders on some browsers. **Backend now always returns flat leaf rows**; grouping happens client-side via Tabulator's well-tested native `groupBy: "item_group"` config with a custom `groupHeader` formatter that shows item count + Σ Shortage (Phys) + Σ Shortage (Proj) + Σ Net Available with traffic-light colour coding. Eliminates the dataTree state machine entirely. Also added two defensive in-host error displays: (a) if `window.Tabulator !== "function"` (CDN blocked / offline), show "Grid library failed to load" with the row count the server returned; (b) if `_rows.length === 0`, show "No items in the current scope" with hints. (c) `try/catch` around `new Tabulator(...)` — any init crash surfaces an explicit message instead of a blank box. A console.info diagnostic line per render prints row count + column count + groupBy flag + `typeof window.Tabulator` for future triage.

### Restricted (additions from this pass)

- Do NOT revert the delegation pattern. Per-cell hover listeners do NOT survive Tabulator v6 row pooling. Always use a single delegated listener on the host with `data-ipv-tt-*` attributes.
- Do NOT change `_refresh` back to `.finally()` only. The `.always()` + `try/catch` + `setTimeout` belt-and-braces is required because Frappe's `frappe.call` returns a jQuery Deferred (not a native Promise) in v15+ and behaviour around catch-then-finally can vary.
- Do NOT re-introduce Fraunces or any other variable serif on the hero/KPIs. The professional Inter/Plex pairing is the brand for this page.
- Do NOT remove the `title` attribute on company options. It's the only way native `<select>` reveals the full company name to a user who sees only the truncated text.
- Do NOT switch the grid back to `fitDataStretch`. That layout's "fill the remaining width with the last column" behaviour combined with our 16 wide columns produced a 2500+ px grid that pushed data off-screen. Use `fitDataFill` so columns size by content but never exceed the visible host.
- Do NOT set `dataTreeStartExpanded: false` again without adding a count-based switch. Tabulator v6 handles ~1000 expanded rows comfortably; collapsing by default made the page look empty on first paint.
- Do NOT revert the toggle switch to `accent-color: var(--ipv-brand)` on a native checkbox. The cross-browser rendering of native checkboxes — especially in dark theme — is inconsistent. The CSS-only iOS-style switch is the brand surface for boolean filters on this page.
- Do NOT reintroduce the `_children` / dataTree path on the backend. Group rendering is a CLIENT concern (Tabulator native `groupBy`). The backend always returns flat leaf rows. If a future site has 50k items and group-by needs server pre-aggregation for performance, add a separate aggregated endpoint — don't change the existing `execute` shape.
- Do NOT remove the in-host error displays. They are the ONLY way a non-developer user can self-diagnose "blank table" issues (CDN blocked, zero-row scope, Tabulator init crash).

## 13. Open ideas (for future iterations)

- Per-item ABC classification colour (A-class items get a left-accent strip).
- "Suggest MR" inline button — would call `mr_generator` to draft a Material Request from the row's `decision_qty`.
- Time-series projection: optional small sparkline showing 30-day projected_qty path.
- Email-to-supplier composer for the Pending PO sheet.
- Slack/Raven push for items that flip to `net_available < 0` between two snapshots.
