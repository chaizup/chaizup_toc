# Item Short / Surplus — page architecture

**Path:** `/app/item-short-surplus`
**Module:** Chaizup Toc
**Version:** v0.0.22 (2026-05-27)
**Backend:** `chaizup_toc.api.item_short_surplus_api`

## In-depth use case

Answers, for every item that has stock or pending vouchers: "Will today's supply (current stock + pending WO output + pending PO receipts) cover today's demand (pending Sales Orders + remaining WO consumption)?"

For each item, classifies as **Shortage** (supply < demand) or **Surplus** (supply ≥ demand) with the magnitude in both Stock UOM and Higher UOM.

Real-world ops scenarios:
- **Buyer's morning review** — opens the page, filters by Item Group "Raw Materials", checks the Shortage column → list of components to chase POs for.
- **Sales planning** — filters by Item Group "Finished Goods" + "Active SO" toggle → list of FGs with confirmed demand that needs production planning.
- **Cycle-count prep** — exports XLSX, opens Sheet 4 "Surplus (sorted)" → items with stock above any committed demand → first candidates to inventory-count for accuracy.

## Dependencies

- **Frappe** ≥ v15 — Page DocType + `frappe.call` + `frappe.ui.Dialog`
- **ERPNext** — Item, Bin, Sales Order + Sales Order Item, Work Order + Work Order Item, Purchase Order + Purchase Order Item, UOM Conversion Detail
- **chaizup_toc** — `production_plan_engine` (status/workflow parsers), `TOC Settings` (default pending lists + warehouse classification)
- **Tabulator 6.3.1** (CDN) — table rendering
- **openpyxl** (Frappe-bundled) — XLSX export

## Reasoning

ERPNext has standard "Stock Projected Qty" + "Stock Ageing" reports but none of them:
1. Combine FG + RM perspectives on one row (this report scopes by item regardless of item type)
2. Use a **live, user-configurable** definition of "pending" — different operators have different opinions about whether a SO in "On Hold" should count as demand. The multi-select filter chips let each user answer this for themselves per session.
3. Drill into per-voucher planned-vs-actual splits with both UOMs on click

This report exists for the daily ops huddle question "what are we short on?" with a single screen that answers it without requiring SQL skills.

## Database connections

| Table | How this report reads it |
|---|---|
| `tabItem` | `_resolve_items` (item_group filter is LIVE — never reads a fetched mirror); `_get_item_meta` (group + name display); `_pick_higher_uoms` JOIN |
| `tabUOM Conversion Detail` | `_pick_higher_uoms` to find largest non-stock UOM per item |
| `tabBin` | `_agg_current_stock` — Σ actual_qty per item, scoped by warehouse + company |
| `tabSales Order` + `tabSales Order Item` | `_agg_pending_so` — Σ(qty − delivered_qty), scoped + eligibility-checked |
| `tabWork Order` | `_agg_pending_wo` — Σ(qty − produced_qty) on FG side; `_agg_remain_wo_consumption` joins parent for eligibility |
| `tabWork Order Item` | `_agg_remain_wo_consumption` — Σ(required_qty − transferred_qty) for component demand |
| `tabPurchase Order` + `tabPurchase Order Item` | `_agg_pending_po` — Σ(qty − received_qty), scoped + eligibility-checked |
| `tabWarehouse` | company filter resolves to "all warehouses where Warehouse.company = X" |
| `TOC Settings` (singleton) | default pending status / workflow lists + default warehouses (from `warehouse_rules` child table). Read once via `get_filter_options`. |

## Computational contract

| Output | Formula |
|---|---|
| Higher UOM | Largest UOM in Item.UOM Conversion Detail with CF > 1; falls back to stock_uom (CF=1) |
| Current Stock | Σ Bin.actual_qty (scoped) |
| Pending SO | Σ MAX(0, soi.qty − soi.delivered_qty) where SO eligible AND status not in (Closed, Cancelled) |
| Pending WO | Σ MAX(0, wo.qty − wo.produced_qty) where WO eligible AND status not in (Closed, Cancelled, Stopped) |
| Pending Received PO | Σ MAX(0, poi.qty − poi.received_qty) where PO eligible AND status not in (Closed, Cancelled) |
| Remain WO Consumption | Σ MAX(0, woi.required_qty − woi.transferred_qty) where parent WO eligible AND woi.item_code = X |
| Total Demand | Pending SO + Remain WO Consumption |
| Supply | Current Stock + Pending WO + Pending Received PO |
| Net | Supply − Demand |
| Demand Status | Surplus if Net ≥ 0, else Shortage |
| Short Fall | abs(Net) when Net < 0, else 0 |
| Surplus | Net when Net ≥ 0, else 0 |

**UOM conversion**: every numeric column is rendered in both Stock UOM and Higher UOM. Higher = Stock ÷ Conversion Factor. Both stored on the row so sort + filter work on whichever the user clicks.

## Eligibility semantics — "pending"

A voucher is **pending** when EITHER:
- `docstatus = 1` (submitted) AND `status` IN user-chosen list, EXCLUDING the always-blocked set (Closed / Cancelled / Stopped)
- `docstatus = 0` (draft) AND `workflow_state` IN user-chosen list (only when the workflow column exists on that doctype)

This is the same OR-tuple pattern used by the TOC production planning engine — keeps semantics consistent across all reports.

## Filter accuracy (LOCKED — see `feedback_filter_accuracy_principle`)

Every filter resolves LIVE at query time. The Item Group filter, for example, runs `tabItem.item_group IN (X)` at SELECT time — never reads a fetched mirror. Item Group reclassifications propagate to the next refresh, not the next save.

The default pending lists are seeded from TOC Settings BUT every user-edit in the filter bar takes precedence per session.

## Restricted areas (CANNOT change without breaking core features)

1. **No caching of aggregates between requests.** The user expects "current state at this moment". A 5-minute Redis cache would silently lie about Bin levels right after a Stock Entry. See `feedback_filter_accuracy_principle.md`.
2. **The (status / workflow_state) OR-tuple is one logical predicate.** Don't split into two queries — risks double-counting if ERPNext ever stores both fields on the same row.
3. **The "active wo / active po / active so / no" boolean filters are POST-aggregation.** They look at the computed qty, not at EXISTS in source tables. Pre-filtering could miss items that should still appear with zero in other columns.
4. **"Closed", "Cancelled", "Stopped" are ALWAYS excluded** regardless of user list. The defensive filter is in both `_agg_*` queries and in `get_report`.
5. **WO consumption scopes by WO.fg_warehouse, not WO.source_warehouse.** The demand the component represents belongs to the warehouse that owns the FG production, not the warehouse the component will be physically pulled from. Changing this changes the meaning of the report.
6. **Multi-sheet XLSX has exactly 4 sheets** per user spec: Main, Filters & Run Info, Shortage sorted, Surplus sorted. Adding more would violate the "no extra summary chip" directive.
7. **Word-wrap CSS on `.tabulator-col-title` and `.tabulator-cell` MUST stay** (`white-space: normal; word-break: break-word`). User explicitly required full visibility — no truncation, no ellipsis.
8. **Per-cell drill-down clicks MUST stay wired** for all qty cells with a `source` attribute. That's the report's primary "tell me why" affordance.
9. **DO NOT add a stored Custom Field to back any filter** — see filter accuracy principle. Item Group filter resolves via Live SQL.
10. **`page.json` roles list MUST stay narrow** (System Manager / TOC Manager / TOC User / Stock Manager / Purchase Manager / Manufacturing Manager). Other roles get no permission — matches sibling page conventions.

## Verification

- Hard-reload `/app/item-short-surplus` after `bench build --app chaizup_toc`
- Filter bar shows 10 multi-select chips + 6 boolean toggles + 3 action buttons
- Default state (no filters) → loads items with any stock or pending voucher
- Click any qty cell → drill-down modal opens with per-voucher rows
- Sort any column → header click toggles direction
- Export XLSX → 4-sheet workbook downloads

## Sync block

```
PAGE:        item-short-surplus @ v0.0.22 (2026-05-27)
URL:         /app/item-short-surplus
BACKEND:     chaizup_toc.api.item_short_surplus_api (5 endpoints)
PRINCIPLE:   LIVE filters only — no stored mirrors, no caches, no fetch_from backing any filter chip
COLUMNS:     21 (item_group, item, higher_uom, stock_uom, current_stock × 2, pending_so × 2, pending_wo × 2, pending_po × 2, remain_wo_consume × 2, total_demand × 2, demand_status pill, shortfall × 2, surplus × 2)
FORMULA:     supply = stock + pending_wo + pending_po; demand = pending_so + remain_wo_consume; net = supply − demand
FILTERS:     item, item_group, warehouses (multi), company, SO/WO/PO statuses + workflow states (multi), 6 booleans (active_X / no_X)
DRILLDOWN:   per-cell click → modal with per-voucher rows in both UOMs
EXPORT:      4-sheet XLSX (Main, Filters & Run Info, Shortage sorted, Surplus sorted)
RESTRICTED:  see § "Restricted areas"
```
