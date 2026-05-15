# Production Plan Engine — Developer Documentation

## File

`chaizup_toc/chaizup_toc/toc_engine/production_plan_engine.py`

## Purpose

Converts submitted Sales Projections into Production Plans (auto-submitted, with Work Orders).
Runs daily at **02:00 AM** (scheduler) or on-demand via the
"Run Production Plan Automation" button on the Sales Projection form.

Also called by `mr_generator.py` for buffer-triggered FG/SFG items (no Sales Projection link).

---

## Architecture

```
daily_production_plan_automation()      ← 02:00 AM cron entry point
         │
         └─► for each sp_name:
               run_production_plan_automation(sp_name)   ← also @frappe.whitelist for JS btn
                    │
                    ├─ _build_min_mfg_map([item_codes])   ← reads Item Master child table
                    │
                    ├─ for each row in sp_doc.table_mibv:
                    │      _process_item(row, ...)
                    │           ├─ Gate 1: active default BOM exists
                    │           ├─ Calc 1 (forecast > 0): shortage formula with pending_PP
                    │           ├─ Calc 2 (forecast = 0): all_pending_SO + pending_PP
                    │           ├─ Gate 2: no demand at all (Calc 2 edge case)
                    │           ├─ Gate 3: shortage ≤ 0
                    │           ├─ Apply min_mfg_qty floor
                    │           ├─ Gate 4: dedup check (_pp_exists_for_item)
                    │           ├─ _create_production_plan(...)   ← Draft PP
                    │           └─ _submit_pp_and_create_work_orders(pp_name)
                    │                   ├─ pp_doc.get_sub_assembly_items()
                    │                   ├─ get_items_for_material_requests()
                    │                   ├─ pp_doc.save()
                    │                   ├─ pp_doc.submit()
                    │                   └─ pp_doc.make_work_order()  ← DOCUMENT METHOD
                    │
                    ├─ frappe.db.set_value(row.name, {wo_status, wo_name → pp_name})
                    ├─ frappe.db.set_value(sp_name, {last_auto_run})
                    ├─ frappe.db.commit()
                    └─ _send_pp_notification(...)

on_production_plan_before_insert(doc)   ← doc_event: before_insert on Production Plan
                                           sets custom_created_by = "User" if blank
```

---

## Two Calculation Scenarios

### Calc 1 — Forecast exists (`projected_qty > 0`)

```
shortage = (projected_qty + prev_pending_SO_qty + pending_PP_qty − curr_month_SO_qty)
           − warehouse_stock
```

Reason text prefix: `"Forecast shortage"`

### Calc 2 — No forecast (`projected_qty = 0`) but pending SOs exist

```
shortage = (all_pending_SO_qty + pending_PP_qty) − warehouse_stock
```

`all_pending_SO_qty` = ALL pending SOs for item+warehouse (no delivery_date restriction).

Reason text prefix: `"No forecast (projection qty = 0) but pending Sales Orders exist"`

If `projected_qty = 0` AND no pending SOs → **Skipped - No Demand**

---

## Formula Components

**All quantities are in `stock_uom`.**

| Term | Source | SQL Field | UOM |
|------|--------|-----------|-----|
| `projected_qty` | `Sales Projected Items.qty_in_stock_uom` | Direct | stock_uom |
| `prev_pending_SO_qty` | SO Items, `delivery_date < month_start` | `soi.stock_qty − delivered_qty × cf` | stock_uom |
| `curr_month_SO_qty` | SO Items, `delivery_date` in projection month | `soi.stock_qty − delivered_qty × cf` | stock_uom |
| `all_pending_SO_qty` | ALL pending SOs (no date filter) | `soi.stock_qty − delivered_qty × cf` | stock_uom |
| `pending_PP_qty` | Production Plan Items `planned_qty` | `ppi.planned_qty` | stock_uom (BOM UOM = stock_uom for mfg items) |
| `warehouse_stock` | `Bin.actual_qty` | `Bin.actual_qty` | stock_uom |

### UOM Conversion in SO Queries

```sql
-- CORRECT: stock_uom
COALESCE(SUM(
    soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
), 0)

-- WRONG (do not use): transaction UOM
COALESCE(SUM(soi.qty - soi.delivered_qty), 0)
```

- `soi.qty` = ordered qty in transaction UOM (e.g. Box, Case)
- `soi.stock_qty` = `soi.qty × soi.conversion_factor` = in stock_uom ← **USE THIS**
- `soi.delivered_qty` = delivered in transaction UOM → multiply by `conversion_factor` to get stock_uom
- Guard clause must also use stock fields: `soi.stock_qty > IFNULL(soi.delivered_qty,0) * IFNULL(soi.conversion_factor,1)`

### RESTRICT — UOM
- **Never** use `soi.qty` in shortage calculations — it is in transaction UOM.
- **Never** use `soi.qty > soi.delivered_qty` as the "not fully delivered" guard — use `soi.stock_qty > delivered_qty * cf`.
- `warehouse_stock` is `Bin.actual_qty` (stock_uom) — do not substitute `Bin.ordered_qty` or `Bin.reserved_qty`.

### RESTRICT — Production Plan Item Column Name
- **Never** use `ppi.qty` — that column does not exist in `tabProduction Plan Item`. The correct column is `ppi.planned_qty`.
- ERPNext Production Plan Item schema (confirmed): `planned_qty`, `pending_qty`, `produced_qty`, `ordered_qty`. There is no `qty` column.

### RESTRICT — Circular Cancel Deadlock Fix (added 2026-05-12)
- The doc_event `before_cancel` on Production Plan is hooked to
  `on_production_plan_before_cancel(doc, method)` in this module. It clears
  `Sales Projected Items.wo_name` and `.wo_status` for every SPI row pointing
  at the PP being cancelled, so Frappe's back-link guard does not block.
- This is the PP-side half of the SP↔PP circular cancel deadlock fix. The
  SP-side half lives in `SalesProjection.before_cancel` and uses
  `self.flags.ignore_links = True` (full bypass, safe because the only
  inbound link to SP is `PP.custom_projection_reference`).
- **Do NOT** use `flags.ignore_links` on the PP side. PP has legitimate
  inbound links from Work Order / Material Request / Stock Entry / Purchase
  Order that MUST still block cancel when those linked docs are active.
- The hook uses `update_modified=False` so cancelling a PP does NOT bump the
  parent SP's `modified` timestamp. The SP audit trail stays clean —
  cancellation of a child PP is not a "change to the SP".
- The hook does NOT clear `Production Plan.custom_projection_reference`.
  Cancelling the PP preserves the source-projection link for audit. Engine
  dedup queries already filter out cancelled PPs, so this stale-on-cancelled
  reference is benign.

### RESTRICT — stock_uom on po_items (added 2026-05-12)
- `Production Plan Item.stock_uom` is `reqd=1` and `read_only=1` in ERPNext v16. ERPNext's own `get_items()` always passes it (`item_details.stock_uom`).
- `_create_production_plan()` MUST fetch `Item.stock_uom` and pass it in the `po_items.append({...})` dict. Without this:
    - The PP Items grid shows an empty UOM column.
    - `validate_uom_is_integer(self, "stock_uom", "planned_qty")` becomes a no-op (no UOM → no integer check).
    - Sub-assembly + MR rows generated downstream inherit the blank UOM, breaking unit display in `tabWork Order` and component shortage MRs.
- The qty arriving into `_create_production_plan` is ALREADY in stock_uom (the formula resolves shortage + minmfg in stock_uom). **Do not** apply a second conversion at PP creation time.

---

## Pending Sales Order Eligibility

Two paths OR-ed. Configured in **TOC Settings → Sales Projection Automation**.

### Path A — Draft + Configured Workflow States

```sql
so.docstatus = 0 AND so.workflow_state IN (projection_confirmed_so_workflow_states)
```

Default: `workflow_state = 'Confirmed'`. Configurable in TOC Settings — one state per line.
Included regardless of the `pending_statuses` configuration.

**Guard — `workflow_state` column existence**: Frappe only adds the `workflow_state` column
to a DocType's table when a Workflow is actually assigned to it. On sites with no Sales Order
Workflow, querying `so.workflow_state` raises `OperationalError: (1054, "Unknown column
'so.workflow_state'")`. The code guards this via `_so_has_workflow_column()` (uses
`frappe.db.has_column("Sales Order", "workflow_state")`, result cached at module level).
PATH A is skipped entirely if the column does not exist — only PATH B runs.

### Path B — Submitted + Pending Status

```sql
so.docstatus = 1 AND so.status IN (projection_pending_so_statuses)
```

Default: `To Deliver and Bill`, `To Deliver`, `On Hold`. Configurable in TOC Settings.

**Recommended statuses:**

| Status | Include? | Reason |
|--------|----------|--------|
| `To Deliver and Bill` | ✅ Yes | Pending delivery + billing |
| `To Deliver` | ✅ Yes | Delivery pending |
| `On Hold` | ✅ Yes | Temporarily paused |
| `To Bill` | ❌ No | Delivery done |
| `Completed` | ❌ No | Fully delivered |
| `Closed` | ❌ No | No dispatch expected |

### Always Excluded

| Condition | Why |
|-----------|-----|
| `docstatus = 0` with state not in configured list | Pure draft |
| `docstatus = 2` | Cancelled |
| `soi.stock_qty <= delivered_qty × conversion_factor` | Fully delivered (stock_uom comparison) |
| SO with blank `set_warehouse` | Cannot be warehouse-scoped |

---

## Min Manufacturing Qty

Defined on the **Item Master** in the `custom_minimum_manufacture` child table
(DocType: `Item Minimum Manufacture`). Columns (post IMM-001, 2026-05-13):

| Column                 | Type   | Purpose |
|------------------------|--------|---------|
| `warehouse`            | Link   | Warehouse-specific override. Engine matches item × warehouse. |
| `min_manufacturing_qty`| Float  | The MINMFG floor (in `uom`). |
| `uom`                  | Link   | UOM. **Gated** to UOMs configured in the parent `Item.uoms` + `stock_uom`. |
| `lead_time_days`       | Int    | Replenishment lead time. Feeds `max_level` and Purchase Priority urgency. |
| `safety_factor`        | Float  | Buffer multiplier (default 1.0). 1.5 = 50% cushion, 2.0 = full cushion. |
| `max_level`            | Float, read-only | Auto: `min_manufacturing_qty × lead_time_days × safety_factor`. Computed in both client JS and server `validate()`. |

**UOM Conversion**: `min_qty_in_stock_uom = min_manufacturing_qty × conversion_factor`
from `UOM Conversion Detail {parent: item_code, uom: min_uom}`. Falls back to 1.0.

**Final production qty**: `max(shortage, min_mfg_qty_in_stock_uom)`

### IMM-002 — ADU-driven max-level + daily refresh (supersedes IMM-001) (2026-05-13)

**Formula change**

The IMM-001 formula `max_level = min_manufacturing_qty × lead × safety` was wrong: the cap measures replenishment cover, which depends on the **consumption rate** (ADU), not the batch size. Corrected:

```
max_level = ADU × lead_time_days × safety_factor      (safety defaults to 1.0)
```

**New columns**

| Column              | Type     | Owner   | Description |
|---------------------|----------|---------|-------------|
| `adu`               | Float    | Engine  | Average Daily Usage for this item × warehouse, computed daily from `tabStock Ledger Entry` outflows over the lookback window. Read-only. |
| `adu_lookback_days` | Int      | Engine  | Snapshot of `TOC Settings.adu_lookback_days` at the moment ADU was computed. Lets historical readers interpret an old ADU value even after the global setting changes. Read-only. |
| `last_updated_on`   | Datetime | Engine  | Wall-clock timestamp of the last daily refresh. Empty until the scheduler first touches the row. Read-only. |
| `max_level`         | Float    | Auto    | `ADU × lead × safety`, rounded to 3 dp. Recomputed (a) by the daily task and (b) on every Item save (so lead/safety edits take effect immediately). Read-only. |

**Daily refresh**

`chaizup_toc.tasks.daily_tasks.update_min_mfg_adu_levels`, scheduled at **06:35 AM** (5 minutes after `daily_adu_update` which runs at 06:30):

1. Reads `TOC Settings.adu_lookback_days` (single source of truth, default 90).
2. For each row in `tabItem Minimum Manufacture` with a non-empty `warehouse`:
   - Sums `abs(SLE.actual_qty)` where `actual_qty < 0`, `posting_date` in the lookback window, `is_cancelled = 0`, scoped by `(item_code, warehouse)`.
   - Writes `adu = total_out / lookback_days` rounded to 4 dp.
   - Writes `adu_lookback_days` = lookback (snapshot).
   - Recomputes `max_level = adu × lead × safety` (safety floor 1.0).
   - Stamps `last_updated_on = now()`.
   - All writes via `frappe.db.set_value(..., update_modified=False)` so the parent Item's `modified` is not bumped daily.
3. One `frappe.db.commit()` at the end.

**Live verification (one row)**

```
seed: item=CZMAT/1585 warehouse=Work In Progress - CCP (599 SLE rows in last 90 days)
after task:  adu=131.506   lookback=90   max_level=789.036   ts=2026-05-14 00:52:27
expected:    131.506 × 5 × 1.2 = 789.036                                            OK
```

### Invariants (IMM-002)

| Invariant | Where enforced | Failure mode |
|---|---|---|
| Rows cannot be added when `Item.uoms` is empty or the Item is unsaved | `item_toc.js _setup_min_mfg_grid` hides Add-Row + shows hint; `form_render` auto-deletes any stray row | Without this, the daily task could not compute ADU for unresolvable UOMs |
| Row UOM must be in `Item.uoms[].uom` ∪ `Item.stock_uom` | Client `frm.set_query`; child `uom` handler; server `_validate_min_mfg_rows` at top of `on_item_validate` | Bad UOM → silent stock_uom conversion failure |
| `adu`, `adu_lookback_days`, `last_updated_on`, `max_level` are engine-owned | `read_only=1` on the doctype JSON; `update_modified=False` in the daily writer | Manual overwrites get clobbered on next 06:35 run |
| `max_level = adu × lead × safety` (safety → 1.0 when blank) | Client `_recompute_max_level`; server `ItemMinimumManufacture.validate()`; server `_validate_min_mfg_rows`; daily `update_min_mfg_adu_levels` | Discrepancy between the four sites = drift; recompute everywhere is intentional |
| Daily task scopes SLE by **warehouse** | `update_min_mfg_adu_levels` SQL `AND sle.warehouse = %s` | Without this, two warehouses for the same item share one global ADU and the per-warehouse cap loses meaning |

### RESTRICT — IMM-002

- Do NOT remove the `_validate_min_mfg_rows` call from the **top** of `on_item_validate`. It must run before the `if not doc.custom_toc_enabled: return` because the engine reads `custom_minimum_manufacture` for every BOM-having item regardless of TOC mode.
- Do NOT make `adu_lookback_days` / `last_updated_on` / `max_level` writable. They are engine-owned. Removing `read_only=1` lets users persist values that the next 06:35 AM run will overwrite, and silently breaks downstream buffer-cap / Purchase Priority readers.
- Do NOT bind a client recompute on `max_level` itself — infinite loop, because `_recompute_max_level` writes back via `set_value`.
- Do NOT filter the UOM dropdown without first verifying `configured_uoms.length > 0`. Frappe silently drops empty `["UOM","name","in",[]]` filters and would let every UOM through.
- Do NOT change `update_modified=False` in the daily task. Otherwise every Item with a min-mfg row gets its `modified` bumped daily, contaminating audit history.
- Do NOT drop the `warehouse` scope from the SLE query. Per-warehouse ADUs are the whole point of having multiple rows per item.

### TS-001 — TOC Settings as single source of truth; reports become read-only (2026-05-14)

The user-facing rule: **TOC Settings is the one place that decides which Sales Order / Work Order / Purchase Order statuses count as "pending" anywhere in the app.** Every TOC report now reads from those 6 fields; per-report status pickers (WKP-034 / POR equivalents) are removed.

#### What changed

1. **WKP page** (`wo_kitting_planner.html` + `.js` + `.css`)
   - Removed the three `.wkp-ms-*` panels (WO Status / SO Status / PO Status) and the *Load* button.
   - Replaced with a single read-only banner `#wkp-pending-banner` with three chip groups + an "Edit in TOC Settings" link.
   - `_loadDynamicFilters()` rewritten to call the new whitelist `get_toc_pending_filters` and feed `_renderPendingBanner()`.
   - All the multi-select internals (`_populateMsPanel`, `_toggleMsPanel`, `_selectAllMs`, `_updateMsLabel`, `_readMsSelections`, `_readStatusSelections`, `_markStatusFiltersDirty`, `_clearStatusFiltersDirty`) were deleted.
   - `this._selWo / _selSo / _selPo` kept on the controller as **always-empty arrays** so every existing `frappe.call(...args: { wo_statuses: JSON.stringify(this._selWo), ... })` round-trips correctly — the server resolves the empty list to TOC Settings on the back end.

2. **Production Overview page** (`production_overview.html` + `.js`)
   - Same treatment: removed the three `.por-ms-*` SO/WO/PO panels.
   - Added `_renderPendingBanner` on the controller.
   - `getDefaultStatuses` (initial bootstrap) replaced by the shared `get_toc_pending_filters` call.
   - The Warehouse multi-select is untouched (per-report filter; not a status filter).

3. **Backend** (`wo_kitting_api.py`)
   - **New whitelist** `get_toc_pending_filters()` returns `{wo, so, po, edit_route}`. Source: TOC Settings → workflow-state entries pre-formatted with the `Workflow: ` prefix when the column exists.
   - **New helpers** `_toc_settings_wo_statuses` / `_toc_settings_so_statuses` / `_toc_settings_po_statuses` resolve the defaults from TOC Settings.
   - **Fallback path** in every WKP/POR endpoint switched: `_wkp_parse_status_list(arg, _toc_settings_*())` instead of `_wkp_parse_status_list(arg, _DEFAULT_WKP_*)`. Explicit overrides via API kwargs still win; the default for "blank kwarg" is now TOC Settings.
   - Production Overview API got three thin shims `_por_default_wo_statuses / _so / _po` that read the shared helpers and strip `Workflow:` entries where the relevant SQL helper doesn't yet handle them (POR's WO + PO branches do not, by design — only SO has `_so_status_clause`).

4. **Engine** (`production_plan_engine.py`) — already wired in BTP-001. `_pending_wo_qty`, `_open_po_qty`, `_wo_required_component_qty` all consult TOC Settings via `_toc_wo_statuses_and_wf` / `_toc_po_statuses_and_wf`. No further change.

#### Live verification

```
get_toc_pending_filters →
  so = ['To Deliver and Bill', 'To Deliver', 'On Hold', 'Confirmed', 'Workflow: Confirmed']
  wo = ['Not Started', 'In Process', 'Material Transferred']
  po = ['To Receive and Bill', 'To Receive']

Smoke after removal:
  Calc SO re-run:            0 created / 45 skipped — unchanged
  Calc Action (0 opted-in):  evaluated=0 — clean exit
  get_open_work_orders:      22 rows (using TOC Settings defaults)
  simulate_kitting on 1 WO:  kit_status="partial" — engine path intact
  get_production_overview:   91 items — uses TOC Settings defaults
```

#### Restricted — TS-001

- Do NOT re-introduce per-report status pickers anywhere in the TOC app. The user-facing contract is now "TOC Settings is the only place to change pending semantics".
- The shared whitelist `chaizup_toc.api.wo_kitting_api.get_toc_pending_filters` is the contract for every banner. Renaming it requires updating both `wo_kitting_planner.js` and `production_overview.js`.
- WKP's `this._selWo / _selSo / _selPo` stay on the controller as always-empty arrays. Removing the field declarations would break the `JSON.stringify(this._selWo || [])` calls in every existing `frappe.call`.
- Do NOT delete `production_overview_api.get_default_statuses`. The POR page no longer calls it but other endpoints (e.g. `get_so_detail_for_item`) may rely on the same shape; keep the whitelist for back-compat.

---

### BTP-001 — Buffer-type final removal + configurable WO / PO pending statuses (2026-05-14)

Two intertwined cleanups that ship together.

#### Part A — Final removal of "Buffer Type" (FG / SFG / RM / PM)

The FG / SFG / RM / PM classification was already decommissioned in spirit (the Item Custom Field had been `hidden=1, read_only=1` for weeks; the result dict carried `mr_type` as the canonical key). BTP-001 removes the last vestiges:

| What | Where | Action |
|---|---|---|
| `Item-custom_toc_buffer_type` Custom Field | `Item` doctype | New patch `chaizup_toc.patches.v1_0.drop_item_buffer_type_field` deletes the Custom Field and (defensively) drops the column if it lingers. |
| `TOC Item Group Rule` doctype | `chaizup_toc/doctype/toc_item_group_rule/` | Folder removed from the repo. New patch `chaizup_toc.patches.v1_0.drop_toc_item_group_rule` runs `frappe.delete_doc("DocType", ...)` and drops `tabTOC Item Group Rule`. No Python or table reference remained. |
| `"buffer_type"` key in engine result dict | `buffer_calculator.py` | Removed. The dict now carries only `mr_type` (Manufacture / Purchase / Monitor). |
| Engine-dict consumers (reports + pipeline_api + daily_tasks + mr_generator log writer) | various | Updated to read `mr_type` first, falling back to `buffer_type` only for round-trip safety against any out-of-tree caller. |
| `buffer_type` filter fieldname in saved Report Views | `production_priority_board.py`, `procurement_action_list.py` | Kept (renaming would invalidate user-saved filters / bookmarks). Filter value dispatches against `mr_type` internally. |
| `TOC Buffer Log.buffer_type` column | DB schema | Kept (migration safety; column stores Manufacture / Purchase / Monitor — same set the rest of the app uses). Engine writes via `data.get("mr_type") or data.get("buffer_type") or ""`. |

The result: there is no longer any FG/SFG/RM/PM-style classification anywhere in the user-facing surface. Replenishment routing is fully expressed by:
- `Item.custom_toc_auto_purchase` / `custom_toc_auto_manufacture` (single-item flags)
- `Item Minimum Manufacture.action_type` (per-warehouse routing)

#### Part B — Configurable WO + PO pending statuses

The engine used to hardcode `('Not Started', 'In Process', 'Material Transferred')` for Work Orders and `NOT IN ('Closed', 'Cancelled', 'Completed')` for Purchase Orders. SO statuses were already user-configurable in TOC Settings — BTP-001 brings WO and PO to parity.

**New TOC Settings fields** (under a new section "Pending Work Order &amp; Purchase Order Statuses"):

| Field | Default | Purpose |
|---|---|---|
| `pending_wo_statuses` | `Not Started\nIn Process\nMaterial Transferred` | Submitted ($docstatus=1$) WO statuses counted as "open WO output" |
| `pending_wo_workflow_states` | empty | Workflow states on Draft WOs to also count as open (when WO has a Workflow assigned) |
| `pending_po_statuses` | `To Receive\nTo Receive and Bill` | Submitted PO statuses counted as "incoming supply" |
| `pending_po_workflow_states` | empty | Same on Draft POs |

**New engine helpers** (`production_plan_engine.py`):

```
_parse_wo_statuses(raw_text)            → list[str]   default = pending defaults
_parse_wo_workflow_states(raw_text)     → list[str]
_parse_po_statuses(raw_text)            → list[str]
_parse_po_workflow_states(raw_text)     → list[str]
_wo_has_workflow_column()               → bool (cached at module level)
_po_has_workflow_column()               → bool (cached)
_toc_wo_statuses_and_wf()               → (statuses, wf) from TOC Settings cache
_toc_po_statuses_and_wf()               → (statuses, wf) from TOC Settings cache
_wo_eligibility_sql(statuses, wf, alias)→ "({alias}.docstatus=1 AND … IN (…)) OR (…wf…)"  / "1=0"
_po_eligibility_sql(statuses, wf, alias)→ "({alias}.docstatus=1 AND … IN (…)) OR (…wf…)"  / "1=0"
```

**Threaded into**: `_pending_wo_qty`, `_open_po_qty`, `_wo_required_component_qty`. Every downstream report / calculation that consumes these helpers picks up the user-configured statuses for free.

**Defaults preserve old behaviour**: if a site leaves the new fields blank, `_parse_wo_statuses(None)` / `_parse_po_statuses(None)` return the exact same lists that were previously hardcoded. No site sees an unexpected number change.

#### Restricted — BTP-001

- Do NOT re-introduce `Item-custom_toc_buffer_type`, `TOC Item Group Rule`, or a `buffer_type` key in the engine result dict. The retirement is by design — replenishment routing lives on the Item / Item Minimum Manufacture row.
- The `buffer_type` filter fieldname on the legacy Script Reports MUST stay. Renaming invalidates every saved Report View / dashboard user has bookmarked. The value dispatches against `mr_type` internally.
- The `TOC Buffer Log.buffer_type` column stays for migration safety. Renaming the column would break historical buffer logs and the DBM weekly evaluator.
- WO / PO eligibility SQL is built dynamically from TOC Settings. Do NOT add hardcoded `status IN (...)` clauses in new engine code — call `_wo_eligibility_sql` / `_po_eligibility_sql` so the user's TOC Settings choice always wins.
- Empty status list at the engine MUST resolve to `1=0` (match nothing), NOT to unfiltered SQL. The `_parse_*` helpers fall back to a non-empty default to avoid this trap, but `_wo_eligibility_sql` / `_po_eligibility_sql` also short-circuit to `1=0` defensively.
- Workflow-state branches MUST stay gated by `_wo_has_workflow_column()` / `_po_has_workflow_column()`. Sites that have no Workflow on Work Order / Purchase Order do not have the column and the query raises `OperationalError 1054` otherwise.

#### Live verification

```
Item-custom_toc_buffer_type Custom Field:  GONE
TOC Item Group Rule doctype:               GONE
TOC Settings new fields present:           pending_wo_statuses / _workflow_states / pending_po_statuses / _workflow_states
_parse_wo_statuses(None):                  ['Not Started', 'In Process', 'Material Transferred']
_parse_po_statuses(None):                  ['To Receive', 'To Receive and Bill']
_wo_eligibility_sql(['In Process'], [], 'wo'):  (wo.docstatus = 1 AND wo.status IN (%s))
_pending_wo_qty(CZPFG621 @ WAREHOUSE 1.9 (CZWH-5) - CCP) = 360.0
_open_po_qty (CZMAT/909 @ WAREHOUSE 1.9 (CZWH-5) - CCP) = 750000.0
run_so_shortage_automation re-run:         created=0  skipped=45  errors=0   (unchanged)
```

### SPA-001 — Action-aware Shortage Cover + Shortage Action engine (2026-05-14)

Builds on SPE-001. Two related shipments:

#### Shortage Cover is now Action-Type aware

`run_so_shortage_automation` now reads `action_type` from each (item × warehouse) row of `Item Minimum Manufacture` (via the new `_build_min_mfg_index` helper) and branches:
- `action_type = "Manufacture"` → existing Production Plan path (unchanged behaviour, with a new status `"Created (PP)"`).
- `action_type = "Purchase"` → new `_create_purchase_mr_for_shortage` helper writes a Material Request of type `Purchase`. UOM conversion is identical to `mr_generator._create_mr` — `Item.purchase_uom` is resolved, the qty (which arrives in stock UOM) is divided by `UOM Conversion Detail.conversion_factor` to land in the supplier-facing purchase UOM. Status on the Run Item: `"Created (MR)"`.
- Items with no min-mfg row default to `Manufacture` (matches the pre-SPA-001 behaviour).
- Dedup splits: `_so_shortage_pp_exists` (PPs marked `[Calc SO]`) for Manufacture, new `_shortage_cover_artifact_exists(..., "Purchase")` (MRs whose `description` carries `[Calc SO]`) for Purchase.

#### New "Shortage Action" engine (Calc Action)

`run_shortage_action_automation(triggered_by="shortage_action_manual")` is a separate auto-monitoring engine. It iterates every `Item Minimum Manufacture` row where `auto_on_shortage = 1` OR `auto_on_max_level = 1`. Two evaluation modes:

| Mode | Formula | Trigger |
|---|---|---|
| Shortage | `demand = pending_so + wo_required_components`; `supply = stock + open_wo_output`; `shortage = demand − supply` | `shortage > 0` → create PP / MR for `max(shortage, MOQ)` |
| Max Level | `cover = (stock + open_wo + open_po) − (pending_so + wo_required_components)`; `cover_pct = cover / max_level × 100` | `cover_pct < row.max_level_threshold_pct` → create PP / MR for `max(max_level − cover, MOQ)` |

Shortage mode is checked first; max-level mode is only evaluated if the shortage branch did not fire (so they never compound into duplicate artifacts on the same run). Reason text carries the marker `[Calc Action]` plus `[Shortage Mode]` / `[Max Level Mode]` plus `[Manufacture]` / `[Purchase]` so the Run Log is fully self-describing.

#### New helpers (engine internal)

| Helper | Purpose |
|---|---|
| `_build_min_mfg_index(item_codes)` | Richer per-row dict keyed by `(item, warehouse)` carrying `min_qty_stock_uom, action_type, auto_on_shortage, auto_on_max_level, max_level_threshold_pct, max_level, lead_time_days, safety_factor, row_name`. Used by both Calc SO (action-aware) and Calc Action. Legacy `_build_min_mfg_map` retained for Calc A / B / v1 `_process_item`. |
| `_create_purchase_mr_for_shortage(item, name, qty_stock_uom, wh, reason, company, lead_time_days)` | Standalone MR writer. Resolves `Item.purchase_uom` + `UOM Conversion Detail.conversion_factor` and writes the MR line in the supplier-facing UOM. Distinct from `mr_generator._create_mr` (which encodes TOC buffer-zone metadata not relevant here). |
| `_shortage_cover_artifact_exists(item, wh, action_type)` | Dedup for Calc SO Purchase branch (MR matched by `[Calc SO]` in description). Manufacture branch still uses `_so_shortage_pp_exists`. |
| `_shortage_action_artifact_exists(item, wh, action_type)` | Dedup for Calc Action — independent of Calc SO so each engine tracks its own active artifacts. PPs matched by `[Calc Action]` in `custom_creation_reason`; MRs matched by `[Calc Action]` in description. |
| `_open_po_qty(item, wh)` | Sum `(qty − received_qty) × conversion_factor` for open POs at the warehouse (stock UOM). |
| `_wo_required_component_qty(item, wh)` | Sum `GREATEST(required_qty − transferred_qty, 0)` from `Work Order Item` where the item is consumed at this `source_warehouse` and the parent WO is open. |
| `_pending_so_eligibility_sql(pending_statuses, confirmed_states)` | SQL fragment factory shared between `_discover_pending_so_pairs` and the per-row SO query in Calc Action. |

#### Schema additions on `Item Minimum Manufacture`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `action_type` | Select (Manufacture / Purchase) | `Manufacture` | drives PP vs MR creation in both Calc SO and Calc Action |
| `auto_on_shortage` | Check | `0` | enable Shortage-mode in Calc Action |
| `auto_on_max_level` | Check | `0` | enable Max-Level-mode in Calc Action |
| `max_level_threshold_pct` | Percent | `50` | threshold for Max-Level-mode |

Plus widened column widths and richer HTML descriptions per requirement.

#### Run Log / Run Item Select extensions

- `TOC Production Plan Run Log.triggered_by` += `shortage_action_manual`, `shortage_action_cron`.
- `TOC Production Plan Run Item.calc_used` += `Calc Action`.
- `TOC Production Plan Run Item.status` += `Created (PP)`, `Created (MR)`, `Skipped - MR Exists` (existing Select would have rejected these strings, breaking the run-log writer).

#### TOC Settings

New `Button` field `run_shortage_action_automation_now` rendered after the existing Run Sales Order Shortage button. JS wiring `_wire_shortage_action_run_button` follows the same disabled-while-running guard pattern, links to the Run Log on completion.

#### Live verification

```
Schema: action_type, auto_on_shortage, auto_on_max_level, max_level_threshold_pct  → OK
Calc SO re-run after SPA-001:  created=0  skipped=45  errors=0   (dedup intact across action type split)
Calc Action with 0 opted-in rows:  evaluated=0  created=0
Calc Action seeded row (Manufacture, max_level=10000, threshold=90%, stock=0):
  → Created (PP) MFG-PP-2026-00068  qty=10000
  → reason: cover_pct 0.00% < threshold 90.00% → max_level - cover = 10000
Dedup re-run:  Skipped - PP Exists  (correct)
```

#### Restricted — SPA-001

- `_build_min_mfg_index` MUST be the dispatch source for Calc SO and Calc Action. Reading the doctype directly inside the engine loop misses the action_type fallback and the stock-UOM conversion.
- `_create_purchase_mr_for_shortage` MUST resolve `Item.purchase_uom` and divide qty by `conversion_factor`. Skipping the conversion writes the MR in stock UOM and confuses suppliers (e.g. "5000 Gram" instead of "5 KG").
- Shortage Action evaluates Shortage mode FIRST, Max-Level mode SECOND, with `if mode_used is None and …` gating. Do NOT change to `if … OR …` — that would create two artifacts on a single run.
- WO component query MUST filter `source_warehouse = row.warehouse`. Aggregating across warehouses double-counts demand on multi-warehouse items.
- Dedup keys are split: `[Calc SO]` for Shortage Cover, `[Calc Action]` for Shortage Action. Do NOT merge them — they track different lifecycles.
- Do NOT include `min_manufacturing_qty` in the bulk dispatch (toc_item_settings) — it is per-warehouse batch sizing and meaningless to bulk across items. Same rule as IMM-003.
- Do NOT remove the `Created (PP)` / `Created (MR)` / `Skipped - MR Exists` Select options. The engine writes these strings; reverting the schema makes every Calc-SO / Calc-Action row fail Frappe Select validation and the run-log write rolls back.

### SPE-001 — Run-Log on Manual SP + Standalone Sales-Order Shortage Engine (2026-05-13)

Two fixes shipped together because they touch the same `_run_for_projection` / Run-Log infrastructure.

#### Fix 1 — Manual Sales-Projection button now writes a Run Log

The whitelist `run_production_plan_automation(projection_name, triggered_by)` (legacy v1 path, called by the *Sales Projection* form button) previously called `_process_item` directly and never produced a `TOC Production Plan Run Log`. Only the *TOC Settings → Run Now* button (v2 path) wrote logs. Manual runs from the SP form looked like they did nothing because no log row appeared.

Fix: `run_production_plan_automation` now delegates to `_run_for_projection(sp_doc, triggered_by, settings)` — the same v2 entry the TOC Settings runner uses. Cron and both manual paths now share one log writer.

Side effects:
- Return shape changed from `list[dict]` (per row) to `dict({ok, run_log, summary, message})`. The SP form JS (`sales_projection.js`) was updated to render the new shape with a link to the Run Log. The legacy array shape is also tolerated so older callers don't break.
- The v1 `_process_item` is still exported for `mr_generator.py` (buffer-triggered FG/SFG items). Do NOT delete.

#### Fix 2 — Standalone Sales-Order Shortage Engine (Calc SO)

New whitelist `run_so_shortage_automation(triggered_by="so_shortage_manual")` scans **every pending Sales Order across the whole company** (no Sales Projection required) and creates a Production Plan per (item × warehouse) where:

```
pending_so_qty_stock_uom − bin_actual_qty − open_wo_qty > 0
```

`production_qty = max(shortage, MINMFG_per_warehouse_in_stock_uom)`.

**Key invariants and why they matter**

1. **UOM safety.** Pending qty is summed as `soi.stock_qty − soi.delivered_qty × soi.conversion_factor`. This converts every SO line to **stock UOM** before aggregation, so two SOs that punch the same item in different transaction UOMs (kg vs 25-kg bag, dozen vs pieces, …) are summed correctly. `min_mfg_map` is resolved the same way (`min_qty × UOM Conversion Detail.conversion_factor`).
2. **Warehouse resolution** per SO line uses `COALESCE(NULLIF(soi.warehouse,''), NULLIF(so.set_warehouse,''), default_so_warehouse)`. Lines that still resolve to NULL are dropped (can't plan against a phantom warehouse).
3. **Eligibility** uses the **same SO status + workflow_state filter** as Calc B (`projection_pending_so_statuses` + `projection_confirmed_so_workflow_states` from TOC Settings, with `_so_has_workflow_column()` guard). Workflow_state path is opt-in and never throws on sites without an SO Workflow.
4. **Dedup**: `_so_shortage_pp_exists(item, warehouse)` blocks a second SO-shortage PP for the same pair while the prior one is still active (docstatus != 2 AND status NOT IN Completed/Closed). Matched by the `[Calc SO]` marker in `custom_creation_reason`.
5. **Run Log shape**: one log per call, `sales_projection` blank, `triggered_by` ∈ {`so_shortage_manual`, `so_shortage_cron`}, `calc_used = "Calc SO"` on every child row. Counters re-use `calc_b_created` / `calc_b_skipped` / `errors` so the existing list view + email helper keep working without a schema change.
6. **One closing save** for counters. Earlier draft kept a per-iteration save block AFTER the `try/except`; every `continue` in the skip branches bypassed it, leaving the persisted skipped counter trailing the returned counter by 1 when the last iteration was a skip. The single closing save eliminates the desync.

**Schema additions (one-time migrate)**

- `TOC Production Plan Run Log.triggered_by` options extended with `so_shortage_manual`, `so_shortage_cron`.
- `TOC Production Plan Run Item.calc_used` options extended with `Calc SO`.
- `TOC Production Plan Run Item.status` options extended with `Error - See Log` (existing engine code was already writing this string; the Select was rejecting it silently before SPE-001 hit it).
- `TOC Settings` field order + button:
  - Field `run_so_shortage_automation_now` (Button) inserted after `run_projection_automation_now`. JS handler `_wire_so_shortage_run_button` mirrors `_wire_projection_run_button`: confirm dialog → `frappe.call` → message with Run Log link.

**Live verification**

```
[1] _discover_pending_so_pairs → 45 pairs, e.g. CZPFG607 @ WAREHOUSE 1.9 (CZWH-5) - CCP = 19440.000 (stock UOM)
[3] First run:  created=18  skipped=27  errors=0  pairs=45
[run-log RUN-2026-05-14-0004] triggered_by='so_shortage_manual'  calc_b_created=18  calc_b_skipped=27 (after fix)
[3] Second run (dedup): created=0  skipped=45  errors=0  ✓ counters match response
```

**Restricted — SPE-001**

- The SQL in `_discover_pending_so_pairs` MUST use `soi.stock_qty − delivered_qty × conversion_factor`. Substituting `soi.qty − delivered_qty` mixes transaction UOMs across SOs and silently distorts shortage by the conversion factor.
- The dedup query MUST exclude Completed / Closed PPs (`status NOT IN`), otherwise the engine cannot re-plan an item even after its previous PP is consumed.
- Do NOT call `run_so_shortage_automation` from `daily_production_plan_automation`. The 02:00 cron is projection-driven; SO-shortage is currently opt-in (manual button only). If you add a cron entry later, use `triggered_by="so_shortage_cron"`.
- Do NOT collapse `run_so_shortage_automation` and `run_projection_automation_for_all_warehouses` into one entry. They share helpers (`_warehouse_stock`, `_pending_wo_qty`, `_create_production_plan`, `_submit_pp_and_create_work_orders`, `_append_run_item`) but their dedup keys and run-log markers (`[Calc A] / [Calc B]` vs `[Calc SO]`) are intentionally distinct.
- Do NOT remove the `_process_item` v1 function from the engine. `mr_generator.py` still calls it for buffer-triggered FG/SFG items. The legacy whitelist `run_production_plan_automation` now delegates to v2 but the v1 helper is still used elsewhere.

### IMM-003 — Per-row Auto-ADU toggle + history gate + bulk UI (2026-05-13)

**New column**

| Column     | Type    | Default | Owner | Description |
|------------|---------|---------|-------|-------------|
| `auto_adu` | Check   | `1`     | User  | Decides who owns the `adu` field for THIS row. ON ⇒ engine writes ADU at 06:35 AM (subject to the history gate); OFF ⇒ user enters ADU manually and the engine never touches the row. |

`adu` itself is no longer `read_only=1` in the doctype JSON — the form-side JS toggles its editability per row based on `auto_adu` via `grid_row.toggle_editable("adu", !auto)`.

**Sufficient-history gate** (engine, `update_min_mfg_adu_levels`)

For every `auto_adu = 1` row, the task SKIPS the write (and does NOT stamp `last_updated_on`) unless the earliest SLE outflow for `(item, warehouse)` is on or before `today - lookback_days`. Reason: with only 5 days of history and a 90-day lookback, `adu = total_out / 90` is ~5% of the real consumption rate, and the resulting `max_level` cap is artificially tiny — silently undersizing safety stock. A "warm-up" row stays empty until coverage arrives, which is the safer signal.

The daily-task log message now reports four buckets:
```
MinMfg ADU Done: <N updated>, <K manual (auto_adu off)>, <W warming up (insufficient history)>, <E errors>, lookback=<L>d
```

**Bulk UI** (page `toc-item-settings`)

The existing Bulk Configuration modal gains three rows (all under the same `APPLY ↔ field` pattern as the existing fields):
- **Min Manufacture — Auto ADU** (radio ON/OFF) → bulk-sets `auto_adu` on every `Item Minimum Manufacture` row of the selected items.
- **Min Manufacture — Lead Time (days)** (Int) → bulk-sets `lead_time_days`.
- **Min Manufacture — Safety Factor** (Float, default 1.0) → bulk-sets `safety_factor`.

Backend handler is the existing `chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.bulk_save_toc_settings` with three new field keys: `minmfg_auto_adu`, `minmfg_lead_time_days`, `minmfg_safety_factor`. Each is dispatched to `_bulk_set_minmfg_field(item, fieldname, value)` which runs ONE `UPDATE tabItem Minimum Manufacture SET <field> = %s WHERE parent = %s AND parentfield = 'custom_minimum_manufacture'`. Items with no rows are silently no-op&apos;d.

**Restricted (IMM-003)**

- The bulk endpoint MUST NOT include `adu` or `min_manufacturing_qty` in the writable field set. `adu` is either engine-owned (auto_adu=1) or per-row (auto_adu=0) and `min_manufacturing_qty` is warehouse-specific batch sizing — neither is meaningful to cross-item bulk.
- The daily-task history gate MUST NOT be relaxed to "any data present". A short-history row with a wide lookback understates ADU by orders of magnitude.
- `auto_adu = 0` rows MUST be skipped entirely by the daily task. Even writing `last_updated_on` would mislead the user about ownership.
- `_toggle_adu_readonly` in `public/js/item_toc.js` MUST use `grid_row.toggle_editable("adu", !auto)`. Setting `read_only` via `set_df_property` does not update the per-row cell editability in a child grid.

**Live verification (IMM-003)**

```
Schema:         auto_adu column present                                                  OK
Manual row:     auto_adu=0, adu=42  →  daily task leaves it untouched                    OK
Auto + covered: auto_adu=1, history >= lookback  →  daily task writes adu / ts / max    OK
Auto + warmup:  auto_adu=1, history < lookback   →  daily task SKIPS (warming up)        OK*
Bulk:           bulk_save_toc_settings(item, {minmfg_auto_adu:0, lead:14, safety:1.75},
                fields_to_apply=[3 minmfg_*]) → both rows updated                        OK
```

(* Verified at lookback=90 against a dataset whose deepest history is ~10 days; every row was correctly placed into the warm-up bucket per the log counter.)

---

## Post-PP-Creation Flow

After every PP is created (both projection-triggered and buffer-triggered),
`_submit_pp_and_create_work_orders(pp_name)` runs these steps in order:

| Step | ERPNext API | Purpose |
|------|-------------|---------|
| 1 | `pp_doc.get_sub_assembly_items()` | Traverse multi-level BOM; populate `sub_assembly_items` table. Uses `pp_doc.sub_assembly_warehouse` (= source warehouse) for stock availability scoping. |
| 2 | `get_items_for_material_requests(frappe._dict(pp_doc.as_dict()))` | Calculate raw material requirements for all BOM levels; populate `pp_doc.mr_items`. Uses `pp_doc.for_warehouse` (= source warehouse). Informational — TOC does NOT auto-create MRs from the PP here; buffer calculator handles RM/PM separately. |
| 3 | `pp_doc.save()` | Persist sub-assemblies and material requirements to DB. |
| 4 | `pp_doc.submit()` | Submit PP (docstatus → 1, status → "Not Started"). |
| 5 | `pp_doc.make_work_order()` | **Document method** (NOT module-level import). Creates Work Orders for FG items (`make_work_order_for_finished_goods`) and every sub-assembly level (`make_work_order_for_subassembly_items`). Each level gets its own WO with `use_multi_level_bom = 0`. |

Each step is wrapped in its own `try/except`. A failed step is logged and the next
step continues. If sub-assembly fetch fails, the PP still gets saved, submitted, and WOs
are created for FG only. If WO creation fails, the PP remains submitted and the error
is in Error Log.

### Warehouse Scoping (set in `_create_production_plan`)

| PP field | Set to | Used by |
|----------|--------|---------|
| `for_warehouse` | `source_warehouse` from projection, SO, or buffer | `get_items_for_material_requests` — which warehouse's stock to check for raw material shortages |
| `sub_assembly_warehouse` | same as `for_warehouse` | `get_sub_assembly_items` — which warehouse's sub-assembly stock to consider |

---

## Gates (Skip Conditions)

| Gate | Condition | Status written to child row |
|------|-----------|-----------------------------|
| BOM | No active default submitted BOM | Skipped - No BOM |
| No demand | projected_qty=0 AND no pending SOs | Skipped - No Demand |
| No shortage | formula result ≤ 0 | Skipped - No Shortage |
| Dedup | System PP already exists for same projection + item | Skipped - PP Exists |
| Exception | Unexpected error | Error - See Log |

---

## Production Plan Custom Fields (via fixtures/custom_field.json)

| Fieldname | Type | Purpose |
|-----------|------|---------|
| `custom_created_by` | Select (User/System) | User = manual, System = automation |
| `custom_creation_reason` | Long Text | Formula breakdown and scenario description |
| `custom_projection_reference` | Link → Sales Projection | Source projection; dedup key (blank for buffer-triggered PPs) |

### Prerequisite: Custom Fields Must Be Applied

These columns only exist in `tabProduction Plan` **after** the fixtures have been imported.
If they are missing, the dedup check (`_pp_exists_for_item`) raises:
```
OperationalError: (1054, "Unknown column 'pp.custom_projection_reference' in 'WHERE'")
```

**To apply:**

`bench migrate` alone may not import fixtures on all setups. Use bench console:
```python
import frappe.utils.fixtures
frappe.utils.fixtures.sync_fixtures(app='chaizup_toc')
frappe.db.commit()
```
If `sync_fixtures` produces no output and the columns still don't exist, insert manually:
```python
import json
with open('apps/chaizup_toc/chaizup_toc/chaizup_toc/fixtures/custom_field.json') as f:
    data = json.load(f)
for d in [x for x in data if x.get('dt') == 'Production Plan']:
    if not frappe.db.exists("Custom Field", {"dt": "Production Plan", "fieldname": d['fieldname']}):
        frappe.get_doc({"doctype": "Custom Field", **d}).insert(ignore_permissions=True)
frappe.db.commit()
```
Verify: `frappe.db.has_column("Production Plan", "custom_projection_reference")` → `True`

## Item Master Custom Fields (via fixtures/custom_field.json)

| Fieldname | Type | Purpose |
|-----------|------|---------|
| `custom_minimum_manufacture_section` | Section Break | Groups the table below |
| `custom_minimum_manufacture` | Table → Item Minimum Manufacture | Per-warehouse min batch sizes |

---

## Dedup Logic

Before creating a PP, `_pp_exists_for_item(projection_name, item_code)` runs:

```sql
SELECT pp.name
FROM `tabProduction Plan` pp
JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
WHERE pp.custom_projection_reference = {projection_name}
  AND pp.custom_created_by = 'System'
  AND pp.docstatus != 2
  AND ppi.item_code = {item_code}
LIMIT 1
```

Draft (0) and Submitted (1) PPs both block re-creation. Only Cancelled (2) are excluded.

Buffer-triggered PPs (`custom_projection_reference` is blank) use `_has_open_pp` in
`mr_generator.py`.

### ARM-001 update (2026-05-14)

The `_has_open_pp` dedup query was broadened in two ways:

1. **Drops the `blank-projection_reference` filter.** Before ARM-001, the buffer engine only
   considered PPs with empty `custom_projection_reference` as blocking — so a projection-
   triggered PP from yesterday was invisible to today's buffer engine and a duplicate PP
   could be created. The query now matches ANY PP for the item × warehouse regardless of
   origin (buffer / projection / Calc SO / Calc Action).
2. **Adds a terminal-status filter.** Imports `PP_TERMINAL_STATUSES` from
   `chaizup_toc.toc_engine.auto_remarks` (= `['Completed', 'Closed', 'Cancelled']`) and
   excludes those statuses. A PP that has reached Completed / Closed correctly does NOT
   block a fresh PP — the buffer cycle is allowed to restart.

The same terminal-list helper is consumed by `_so_shortage_pp_exists`,
`_shortage_cover_artifact_exists`, and `_shortage_action_artifact_exists` so every dedup
query in the app reads from one source of truth.

### Creation reason auto-enrichment

`_create_production_plan` now auto-appends the canonical pending-status block (from
`auto_remarks.format_pending_check_block("PP")`) to whatever `reason` the caller passed
— UNLESS the caller already routed the reason through `format_auto_creation_remark`
(detected by the `[Auto-Generated by ` sentinel). The result lands in
`Production Plan.custom_creation_reason`, and `_stamp_toc_fields_on_work_orders` then
copies it into every child Work Order's `description` (only when currently blank, so
operator edits are never overwritten).

---

## Scheduler Registration (hooks.py)

```python
"0 2 * * *": [
    "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.daily_production_plan_automation"
],
```

---

## Doc Event (hooks.py)

```python
"Production Plan": {
    "before_insert": "...production_plan_engine.on_production_plan_before_insert"
}
```

---

## Email Notifications

Sent via `frappe.sendmail(now=False)` (queue mode) after each automation run.
Recipients: TOC Settings → Notification Users with `notify_on_wo_create` flag checked.

Subject format:
`PP Automation — {month} {year} / {warehouse}: N/M Production Plans Created [{trigger}]`

The call to `_send_pp_notification` is wrapped in `try/except` inside `run_production_plan_automation`.
Email failures are logged to Error Log but never propagate to the caller.

### Why `now=True` is Forbidden Here

`frappe.sendmail(now=True)` registers an `after_commit` callback that sends the email
synchronously during `db.commit()`. If the email account's encrypted password cannot be
decrypted (e.g. `cryptography.fernet.InvalidToken` — encryption key mismatch after a
site migration or key rotation), the exception bubbles up through the commit chain and
returns **HTTP 500 to the user even though PP + WO creation already succeeded**.

Queue mode (`now=False`) writes to Email Queue and lets the background worker handle
delivery. Email failures appear in Email Queue (retryable) and Error Log — they never
affect the web request or the scheduler job.

---

## DANGER ZONE

| Risk | Detail |
|------|--------|
| Confirmed workflow states | Configurable in TOC Settings → `projection_confirmed_so_workflow_states`. Default: `Confirmed`. Blank field falls back to `['Confirmed']`. Update if your workflow state is renamed. |
| `so.set_warehouse` filter | SOs with blank `set_warehouse` are excluded. Intentional. |
| `frappe.db.commit()` per item | Multiple commits in `_process_item` — after PP insert and after submit+WO. Do NOT remove. |
| `Item Minimum Manufacture` DocType name | `_build_min_mfg_map` uses `frappe.db.get_all("Item Minimum Manufacture", ...)`. If renamed, update. |
| `custom_projection_reference` pre-set | Automation sets this before insert. Without it, dedup breaks silently. |
| `flags.ignore_mandatory = True` on PP | Allows creating PPs without all ERPNext required fields. Remove only if all fields guaranteed. |
| MONTH_NAMES ordering | Index-matched to `datetime.month - 1`. Do NOT reorder. |
| Empty `pending_statuses` | PATH B is skipped. PATH A (configured states) still runs if workflow column exists. |
| `so.workflow_state` column may not exist | Frappe only creates this column when a Workflow is assigned to Sales Order. Querying it on a site with no SO Workflow raises `OperationalError 1054`. Always use `_so_has_workflow_column()` guard before PATH A. DO NOT remove this guard. |
| `_so_workflow_column_cache` | Module-level bool cache. Resets on worker restart. Safe to cache — workflow assignment changes are rare and require a deploy anyway. |
| `pp_doc.make_work_order()` is a DOCUMENT METHOD | Do NOT import as `from erpnext.manufacturing.doctype.production_plan.production_plan import make_work_order`. That module-level import does NOT exist. Only callable as `pp_doc.make_work_order()` on a loaded Production Plan document. |
| `get_items_for_material_requests` IS a standalone function | Import from `erpnext.manufacturing.doctype.production_plan.production_plan`. Pass `frappe._dict(pp_doc.as_dict())` — it modifies a local dict, returns the mr_items list. Append results to `pp_doc.mr_items` manually. |
| `for_warehouse` + `sub_assembly_warehouse` must be set on PP | Both are set in `_create_production_plan` to the `source_warehouse`. Without them, sub-assembly fetch is not warehouse-scoped and material requirements calculation uses no warehouse filter. |
| `_submit_pp_and_create_work_orders` per-step try/except | Each step has its own try/except. Do NOT collapse to a single outer try/except — that would skip steps 2–5 if step 1 fails. |
| `frappe.sendmail now=True` | FORBIDDEN in `_send_pp_notification`. Causes HTTP 500 via the after_commit chain if the email account password decryption fails (`InvalidToken`). Use `now=False` (queue). |
| `_send_pp_notification` try/except wrapper | Do NOT remove the try/except around the call in `run_production_plan_automation`. Email failures must never crash the automation response. |

## RESTRICT

- Do NOT remove `frappe.only_for()` in `run_production_plan_automation`.
- Do NOT call `frappe.sendmail` inside the item loop.
- Do NOT remove the BOM gate.
- Do NOT remove the dedup check.
- Do NOT change `delivery_date` to `transaction_date` in Calc 1 SO queries.
- Do NOT merge PATH A and PATH B into a single `docstatus IN (0,1)` check.
- Do NOT read from `sp_doc.minimum_manufacture` — moved to Item Master in v3.
- Do NOT import `make_work_order` from the erpnext production_plan module — it is a class method, only callable as `pp_doc.make_work_order()`.
- Do NOT call `pp_doc.make_material_request()` from automation — TOC buffer calculator handles RM/PM Material Requests. Calling it here creates duplicate MRs.
- Do NOT remove `for_warehouse` and `sub_assembly_warehouse` from `_create_production_plan` — without them the multi-level BOM fetch and material requirements are not warehouse-scoped.
- Do NOT pass `now=True` to `frappe.sendmail` in `_send_pp_notification` — causes HTTP 500 on email account decryption failure even when PP + WO creation succeeded.
- Do NOT remove the `try/except` wrapper around `_send_pp_notification(...)` in `run_production_plan_automation`.
- Do NOT query `so.workflow_state` directly without first calling `_so_has_workflow_column()` — the column does not exist on sites with no SO Workflow, causing OperationalError 1054.
- Do NOT remove `_so_has_workflow_column()` guard from `_so_conditions_and_params` — it prevents PATH A from crashing on sites without a Sales Order Workflow.

---

## 2026-05-08 Update — Calc A + Calc B Dual-Run Architecture (Phase 1 schema landed; Phase 2 engine refactor pending)

### Why the rewrite

The earlier Calc 1 / Calc 2 mutually-exclusive (`if has_forecast: ... else: ...`) logic had a known limitation: when actual Sales Orders punched in the current month exceed the projection, Calc 1 produces a negative shortage and silently skips the item — the over-shoot becomes a future stockout. Production team has no visibility unless they manually compute SO vs projection per item.

The new design runs **two independent calcs sequentially per item**, with explicit logging:

- **Calc A (forecast-driven)** — confirms Production Plans exist for the projection itself.
- **Calc B (SO-driven)** — confirms Production Plans exist for *all* pending Sales Orders, regardless of projection.

Both fire for every item. Calc B reads ITMWO **after Calc A's PP+WO commit**, so Calc B's view of supply already includes anything Calc A just created — preventing duplicate PPs while catching any residual shortage from over-projected SOs.

### Variable definitions (canonical names — match user spec)

| Symbol | Definition | Source |
|---|---|---|
| **SPOW** | Sales Projection of specific warehouse for the running month | `Sales Projected Items.qty_in_stock_uom` for the Sales Projection row |
| **PRVSO** | Previous month pending Sales Order qty (item × warehouse) | Sum of `Sales Order Item.qty` where SO `transaction_date < current_month_start` AND status ∈ pending statuses |
| **CURRSO** | Current month pending Sales Order qty | Sum where `transaction_date IN current_month` AND status ∈ pending statuses |
| **CURRALSO** | Current month ALL Sales Order qty (completed + incomplete) | Sum where `transaction_date IN current_month` regardless of status (excludes only Cancelled / Closed) |
| **ITMWO** | Pending Work Order qty for item × warehouse | Sum of `qty − produced_qty` across submitted Work Orders with status ∈ {Not Started, In Process, Material Transferred, Open, Draft (PP)} |
| **ITMWSTK** | Current actual stock at warehouse | `tabBin.actual_qty` for item × warehouse |
| **MINMFG** | Minimum manufacturing / purchase qty floor (in stock UOM) | `Item.custom_minimum_manufacture` row matching warehouse, converted from row UOM → stock UOM |

### Formulas

#### Calc A — Forecast Shortage (per Sales Projection row)

```text
Qty_of_shortage_A = (SPOW + PRVSO) − (CURRALSO + ITMWO + ITMWSTK)

IF Qty_of_shortage_A > 0:
    production_qty = max(Qty_of_shortage_A, MINMFG)
    create Production Plan (purpose: Manufacture, source: SP warehouse, item, BOM=default-active-submitted)
    auto-submit PP → ERPNext PP-submit hook creates Work Order(s)
    log row: calc_used = "Calc A", status = "Created"
ELSE:
    log row: calc_used = "Calc A", status = "Skipped - No Shortage"
    (proceed to Calc B for the same item)
```

#### Calc B — SO-Driven Safety Net (after Calc A commits)

```text
# Re-read ITMWO and ITMWSTK so Calc A's just-created WO is reflected.
Qty_of_shortage_B = (PRVSO + CURRSO) − (ITMWSTK + ITMWO)

IF Qty_of_shortage_B > 0:
    production_qty = max(Qty_of_shortage_B, MINMFG)
    create Production Plan (purpose: Manufacture, source: SP warehouse, item, BOM=default-active-submitted)
    auto-submit PP → ERPNext PP-submit hook creates Work Order(s)
    log row: calc_used = "Calc B", status = "Created"
ELSE:
    log row: calc_used = "Calc B", status = "Skipped - No Shortage"
```

### Why both calcs run

- **Calc A confirms** "PP exists for the projection." If projection = 5,000 and SOs match, Calc A creates the right PP.
- **Calc B confirms** "PP exists for actual demand." If actual SOs = 6,500 (over-projection), Calc A handles the projected 5,000 and Calc B handles the residual 1,500 — preventing the silent-skip bug.

### Critical sequencing rule

Per item, the order MUST be:

1. Run Calc A → if shortage, insert+submit PP → `frappe.db.commit()`
2. Re-read ITMWO and ITMWSTK fresh (Calc A's WO may have just landed)
3. Run Calc B → if shortage, insert+submit PP → `frappe.db.commit()`
4. Insert one row in TOC Production Plan Run Item per calc (always two rows per item — never zero)

If Calc B runs WITHOUT the intermediate commit, it will see stale ITMWO and double-create the same shortage. This is the single most important invariant.

### Work Order creation route — MUST go through Production Plan

Per spec: **Work Orders are NEVER created directly.** Always:

1. Insert `Production Plan` (with `prod_plan_references[].sales_order` linking back to a representative SO if available).
2. Run `_submit_pp_and_create_work_orders(pp_name)` which calls Frappe's standard PP submit pipeline.
3. The PP submit hook walks the BOM and creates main + sub-assembly Work Orders.

This preserves:
- Standard ERPNext WO ↔ PP linkage (used by existing dashboards).
- Sub-assembly auto-creation logic.
- The `custom_toc_recorded_by = "By System"` flag (set by `chaizup_toc.toc_engine.production_plan_engine._stamp_toc_fields_on_work_orders`).

### Skip / decision matrix

| Status | When |
|---|---|
| `Created` | Shortage > 0; PP+WO created |
| `Skipped - No Shortage` | Shortage ≤ 0 (typical happy path) |
| `Skipped - No BOM` | Item has no active default submitted BOM |
| `Skipped - No Demand` | Calc B path with PRVSO + CURRSO ≤ 0 |
| `Skipped - PP Exists` | A non-cancelled "System" PP already exists for this projection × item × calc (dedup) |
| `Skipped - No Warehouse` | Sales Projection has no `source_warehouse` AND `TOC Settings.default_so_warehouse` is blank |
| `Error` | Engine raised an exception; details in `engine_log` field |

### TOC Settings — new field

**`default_so_warehouse`** (Link → Warehouse) added under "Sales Projection Automation" section.

Used when:
- Computing PRVSO / CURRSO / CURRALSO across Sales Orders whose Sales Order Item has blank `warehouse`. The engine treats those SO Items as "demand against the default warehouse" instead of dropping them.
- Resolving stock for items mapped against a warehouse that doesn't exist on the projection (rare; manual SO with custom warehouse).

If both the SO Item's warehouse AND `default_so_warehouse` are blank, the SO line is excluded from PRVSO/CURRSO/CURRALSO with a warning logged.

### TOC Production Plan Run Log — audit doctype

Every run (manual button or 02:00 AM cron) inserts ONE `TOC Production Plan Run Log` (parent) plus N `TOC Production Plan Run Item` (children, one per item × calc).

Parent fields snapshotted at run time (frozen for audit reproducibility):
- `pending_so_statuses_used` — what statuses the engine treated as "pending"
- `default_so_warehouse_used` — the fallback warehouse value
- `sales_projection`, `warehouse` — context
- `triggered_by` — `manual_button`, `cron`, etc.
- Summary counts: `calc_a_created`, `calc_a_skipped`, `calc_b_created`, `calc_b_skipped`, `errors`

Child row fields per (item × warehouse × calc):
- All formula inputs: SPOW, PRVSO, CURRSO, CURRALSO, ITMWO, ITMWSTK, MINMFG
- `qty_of_shortage` (raw formula output, may be negative)
- `production_qty` (after MINMFG floor; 0 if Skipped)
- `production_plan` (link)
- `work_orders` (Long Text — comma-separated WO names, parent + sub-assembly)
- `reason` (formula breakdown, human-readable)

### Manual-trigger button

Located in TOC Settings → "Sales Projection Automation" section → right column. Calls whitelisted method `chaizup_toc.toc_engine.production_plan_engine.run_projection_automation_for_all_warehouses`. Behaves identically to the 02:00 AM cron (same engine entry point), differing only in the `triggered_by` value written to the Run Log.

Confirmation dialog must be accepted before run (prevents accidental clicks). While running, the button is disabled and shows "Running…".

### RESTRICTED AREAS — do NOT change without explicit review

| Restricted item | Why |
|---|---|
| Sequencing of Calc A → commit → Calc B | Without the commit, Calc B sees stale ITMWO and double-creates PPs |
| Direct Work Order creation (forbidden) | Must always go through PP submit pipeline so sub-assemblies auto-create and TOC stamping fires |
| `custom_minimum_manufacture` fieldname | Hardcoded in engine `_build_min_mfg_map` (line ~717). Renaming the Custom Field breaks the floor lookup |
| `MONTH_NAMES` list | Index-based mapping to `projection_month` Select DB value — reordering breaks the cron |
| Dedup gate (`_pp_exists_for_item`) | Without it, every cron run creates duplicate PPs |
| `frappe.db.commit()` calls | Required after PP insert AND after PP submit + WO creation; removing them risks transactional inconsistency |
| `chaizup_toc.toc_engine.buffer_calculator.on_stock_movement` SLE hook | Fires on every PP-created SLE; touching it breaks every other TOC feature. To temporarily disable during bulk runs, use `frappe.conf.disable_toc_buffer_recalc` (added per Q10 of erpnext query.md) |
| Field naming `currALso` (mixed case) on TOC Production Plan Run Item | Intentional spec-literal; engine writer expects this exact name |
| `TOC Settings.default_so_warehouse` snapshot in Run Log | Prevents historical log mutation when the setting changes; do not rely on live setting reads at log-render time |

### Phase status (2026-05-08)

- ✅ **Phase 1 Schema** complete and verified live:
  - `TOC Settings.default_so_warehouse` (Link → Warehouse)
  - `TOC Settings.run_projection_automation_now` (Button)
  - `Item.custom_toc_sec_minmfg` (Section Break) + `Item.custom_minimum_manufacture` (Table → Item Minimum Manufacture)
  - `Item Minimum Manufacture.min_manufacturing_qty.columns = 5`, label = "Min Purchase / Production Qty"
  - `TOC Production Plan Run Log` (parent doctype)
  - `TOC Production Plan Run Item` (child doctype)
  - Patch `chaizup_toc.patches.sync_min_mfg_custom_fields` registered
- ⏳ **Phase 2 Engine** — refactor `_process_item` to run Calc A then Calc B with intermediate commit; engine writes Run Log rows; whitelisted entry point `run_projection_automation_for_all_warehouses`. **Not yet implemented.**
- ⏳ **Phase 3 Tests** — pytest cases for each calc path, dedup, MINMFG floor, default-warehouse fallback, over-projection scenario.
- ⏳ **Phase 4 Docs** — update `toc_user_guide` page + Claude/Gemini memory.

### Test plan (Phase 3)

For each of these scenarios, build a synthetic site state and assert the Run Log + GL/SLE outcome:

1. **Happy path** — SPOW=5000, PRVSO=0, CURRSO=2000, CURRALSO=2000, ITMWO=0, ITMWSTK=1000 → Calc A: shortage = (5000+0) − (2000+0+1000) = 2000 → PP@2000. Calc B: (0+2000) − (1000+2000) = -1000 → Skip.
2. **Over-projection** — SPOW=5000, PRVSO=0, CURRSO=4000, CURRALSO=4000, ITMWO=0, ITMWSTK=1500 → Calc A: shortage = (5000+0) − (4000+0+1500) = -500 → Skip. Calc B: (0+4000) − (1500+0) = 2500 → PP@2500. ✓ The bug-fix scenario.
3. **MINMFG floor** — Calc A shortage = 200, MINMFG=500 → PP@500.
4. **No BOM** — Skipped - No BOM in both calcs.
5. **No demand** — SPOW=0, all SO=0 → Calc A skipped (no demand); Calc B skipped.
6. **Default warehouse fallback** — SO Item has blank warehouse; with `default_so_warehouse` set, demand counted; without, line excluded with log warning.
7. **Dedup** — Run twice; second run finds existing PP and skips.
8. **Sub-assembly** — Item has 2-level BOM → expect 1 parent WO + N sub-assembly WOs in Run Item `work_orders` field.

### Sync block (for cross-AI continuity)

```
[chaizup_toc · 2026-05-08]
- Schema changes: TOC Settings (default_so_warehouse + button), Item (sec + table custom field for custom_minimum_manufacture), 2 new doctypes (TOC Production Plan Run Log + Item).
- Engine: production_plan_engine.py — Calc A and Calc B both run per item, with `frappe.db.commit()` between them so Calc B sees fresh ITMWO. WO creation MUST go through Production Plan submit (never direct).
- Audit: every run writes one TOC Production Plan Run Log + N items. Snapshot pending_so_statuses + default_so_warehouse for reproducibility.
- Restricted: don't rename custom_minimum_manufacture; don't toggle the chaizup_toc SLE hook globally — use frappe.conf.disable_toc_buffer_recalc per Q10.
- Pending: Phase 2 engine refactor (run_projection_automation_for_all_warehouses entry, dual-calc loop), Phase 3 tests, Phase 4 user-guide + memory update.
```

---

## 2026-05-08 · Phase 2 implementation + live test results

Phase 2 engine refactor is **complete and tested on the dev replica**. Implementation summary:

### Files touched (Phase 1 + 2)

| File | What changed |
|---|---|
| `chaizup_toc/doctype/toc_settings/toc_settings.json` | + `default_so_warehouse` (Link Warehouse), + `run_projection_automation_now` (Button), + entries in `field_order` |
| `chaizup_toc/doctype/toc_settings/toc_settings.js` | + click handler for `run_projection_automation_now` button (calls the whitelisted entry, opens Run Log on success) |
| `chaizup_toc/doctype/item_minimum_manufacture/item_minimum_manufacture.json` | qty column width 2 → 5; label "Min Manufacturing Qty" → "Min Purchase / Production Qty" |
| `chaizup_toc/doctype/toc_production_plan_run_log/*` | NEW parent doctype |
| `chaizup_toc/doctype/toc_production_plan_run_item/*` | NEW child doctype |
| `chaizup_toc/fixtures/custom_field.json` | + `Item-custom_toc_sec_minmfg` Section Break + `Item-custom_minimum_manufacture` Table |
| `chaizup_toc/patches/sync_min_mfg_custom_fields.py` | NEW one-shot patch — imports the two new Item custom fields from fixture |
| `chaizup_toc/patches/sync_pp_custom_fields.py` | NEW one-shot patch — imports `custom_created_by` / `custom_creation_reason` / `custom_projection_reference` on Production Plan (pre-existed in fixture but never landed on existing sites) |
| `chaizup_toc/patches.txt` | + both new patch entries |
| `chaizup_toc/toc_engine/production_plan_engine.py` | + helpers `_so_warehouse_filter`, `_prev_month_so_qty_v2`, `_curr_month_so_qty_v2`, `_curr_month_all_so_qty`, `_pending_wo_qty`, `_pp_exists_for_calc`, `_wo_names_for_pp`, `_append_run_item`. + `_process_item_v2` (dual-calc with intermediate commit). + `_run_for_projection`. + whitelisted `run_projection_automation_for_all_warehouses`. `daily_production_plan_automation` rewired to delegate to v2. |
| `page/toc_user_guide/toc_user_guide.html` | Updated S07 with dual-calc formulas + variable table + Run Log audit trail explanation + default-warehouse fallback explanation |

### How it was tested (live on dev replica · 2026-05-08)

A test setup patch (`chaizup_toc.patches.phase2_test_full.execute`) that:

1. Cancels prior test artefacts (PPs, SOs, Sales Projections).
2. Sets `TOC Settings.default_so_warehouse = WAREHOUSE 1.9`.
3. Adds MINMFG rows to 3 items (CZMAT/754=5000, CZMAT/1593=80000, CZPFG640=10000).
4. Submits a Sales Order for 200,000 of CZPFG640 (forces over-projection scenario).
5. Submits a Sales Projection covering 4 items.
6. Calls `run_projection_automation_for_all_warehouses(triggered_by="manual")`.
7. Asserts the Run Log shape: 8 rows = 4 items × 2 calcs.

### Observed Run Log (RUN-2026-05-08-0005)

| Item | Calc | Status | Shortage | Production | PP |
|---|---|---|---:|---:|---|
| CZMAT/1593 | Calc A | Created | 66,500 | 80,000 (MINMFG floor) | MFG-PP-2026-00020 |
| CZMAT/1593 | Calc B | Skipped — No Demand | -333,500 | 0 | — |
| CZMAT/748 | Calc A | Skipped — No Shortage | -359,500 | 0 | — |
| CZMAT/748 | Calc B | Skipped — No Demand | -364,500 | 0 | — |
| CZMAT/754 | Calc A | Skipped — No Shortage | -235,500 | 0 | — |
| CZMAT/754 | Calc B | Skipped — No Demand | -245,500 | 0 | — |
| CZPFG640 | Calc A | Skipped — No Shortage | -256,200 | 0 | — |
| CZPFG640 | Calc B | **Created** | 112,880 | 112,880 | MFG-PP-2026-00021 |

### Sub-assembly auto-creation verified

`MFG-PP-2026-00021` (CZPFG640, Calc B) created **two** Work Orders via the standard Production Plan submit pipeline — `MFG-WO-2026-00175` for CZPFG640 and `MFG-WO-2026-00176` for sub-assembly CZMAT/1296. ✓

### Dedup verified

Re-running the engine immediately after first run → both PPs detected via `custom_creation_reason LIKE '%[Calc A]%'` and `'%[Calc B]%'` markers; corresponding rows flipped to `Skipped - PP Exists`. Zero new PPs created on the second run. ✓

### Sync Block (cross-AI continuity, 2026-05-08)

```
[chaizup_toc · production_plan_engine v2 · 2026-05-08]
- Status: Phase 1 schema + Phase 2 engine LANDED and TESTED on dev replica.
- Engine entry: run_projection_automation_for_all_warehouses(triggered_by) — whitelisted; called by TOC Settings 'Run Now' button + 02:00 cron.
- Per item: Calc A then frappe.db.commit() then Calc B (with fresh ITMWO read). One PP per calc per item max.
- WO creation route: Production Plan submit → ERPNext standard pipeline → main + sub-assembly WOs.
- Audit: TOC Production Plan Run Log (parent) + TOC Production Plan Run Item (child, 2 rows per item per run).
- Snapshots pinned per run: pending_so_statuses_used, default_so_warehouse_used.
- Dedup key: pp.custom_creation_reason LIKE '%[Calc A]%' or '%[Calc B]%' (markers literal).
- Restricted: don't remove the inter-calc commit; don't direct-create WOs; don't rename custom_minimum_manufacture; don't change MONTH_NAMES order.
- For mass-cancel / migration windows: set frappe.conf.disable_toc_buffer_recalc=1 to suppress the on_stock_movement enqueue storm (per Q10 of erpnext query.md). Then bench restart.
- Custom field sync — chaizup_toc fixtures don't auto-import after install. Use chaizup_toc.patches.sync_min_mfg_custom_fields and chaizup_toc.patches.sync_pp_custom_fields patches to land them on existing sites.
- Live verification done: scenarios 1 (MINMFG floor), 2 (oversupplied via WO), 3 (oversupplied via stock), 4 (over-projection bug fix), 5 (dedup re-run) all PASS.
```

---

## 2026-05-08 (afternoon) · Phase 3 UX additions

Five UX/audit improvements landed and tested on the dev replica.

### Changes

| # | Change | File(s) | Test result |
|---|---|---|---|
| 1 | `skip_available_sub_assembly_item = 0` on every TOC-created PP | `production_plan_engine.py:_create_production_plan` | ✓ PPs created at MFG-PP-2026-00026 / 00027 confirmed value = 0 |
| 2 | Run Item grid: `item_name` (cols 6), `production_plan` (cols 6), `reason` Long Text — all `in_list_view=1`. `item_code` and `warehouse` removed from grid (still in form). | `chaizup_toc/doctype/toc_production_plan_run_item/toc_production_plan_run_item.json` | ✓ DocField in_list_view confirmed |
| 3 | Production Plan list shows `Created By` column (`custom_created_by` Custom Field already had `in_list_view=1` in fixture; patch synced it) | `chaizup_toc/fixtures/custom_field.json` + `patches/sync_pp_custom_fields.py` | ✓ Column visible |
| 4 | Work Order list shows `Item Name` via Property Setter (`in_list_view=1`, `columns=4`) | `chaizup_toc/fixtures/property_setter.json` + `patches/sync_property_setters.py` | ✓ Property Setter rows confirmed |
| 5 | Run-log summary email (HTML, multi-section, with per-item formula table) sent to TOC notification users where `notify_on_wo_create=1`. Queued (not synchronous) so mail-server failures cannot crash the engine. | `production_plan_engine.py:_send_run_log_email` (called from `_run_for_projection`) | ✓ Email Queue row `p3k9pa29nl` reference_name=RUN-2026-05-08-0009 |

### CRITICAL: ERPNext label↔fieldname divergence

The PP UI shows a checkbox **"Consider Projected Qty in Calculation"** (default checked).
Its INTERNAL `fieldname` is `skip_available_sub_assembly_item` (NOT `consider_projected_qty`).
TOC sets it to **0** so ERPNext's `get_sub_assembly_items()` walks against `Bin.actual_qty` alone.
The TOC formula already nets ITMWO, CURRSO, PRVSO into the planned qty — letting ERPNext deduct
`Bin.projected_qty` again would double-count and silently shrink sub-assembly demand.

### RESTRICTED — added 2026-05-08

- `pp.skip_available_sub_assembly_item = 0` MUST stay. Removing reintroduces double-count drift.
- Run Item grid widths sum to ~22 (`item_name 6 + calc_used 2 + status 2 + production_plan 6 + reason ~6`). Frappe distributes proportionally; do not switch to a fixed-grid framework.
- Email recipient filter: only `notify_on_wo_create=1` rows. Other flags (`notify_on_edit`, `notify_on_submit`) belong to the v1 SP-edit/submit notification path; never broadcast engine summaries to those users.
- `now=False` on `frappe.sendmail` is mandatory. `now=True` would propagate MTA failures back through `frappe.db.commit()` and fail the engine even though PPs were created correctly.

### Sync block update (2026-05-08 afternoon)

```
[chaizup_toc · production_plan_engine v2 + Phase 3 · 2026-05-08]
- All 5 UX additions LANDED and TESTED on dev replica.
- TOC PPs always set skip_available_sub_assembly_item=0 (UI label "Consider Projected Qty in Calculation" unchecked) — TOC formula is the single source of truth for planned qty.
- Run Item grid: item_name (6), calc_used (2), status (2), production_plan (6), reason (Long Text) all in_list_view=1.
- Run Item grid intentionally hides item_code + warehouse from grid; both still in form view.
- PP list view: Created By column visible (Custom Field).
- WO list view: Item Name column visible (Property Setter, in_list_view=1, columns=4).
- Email helper _send_run_log_email queued from _run_for_projection at end of each projection. HTML body has 4 KPI tiles + per-item table with formula breakdown + truncation guard at 200 rows. Recipients = TOC Settings → projection_notification_users where notify_on_wo_create=1. now=False (queued, not synchronous).
- New patch: chaizup_toc.patches.sync_property_setters (registered in patches.txt).
- All five fixes verified by phase3_test.execute against MFG-PP-2026-00026 / 00027 + Email Queue row p3k9pa29nl.
```
