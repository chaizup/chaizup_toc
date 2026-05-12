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
(DocType: `Item Minimum Manufacture`). Columns: Warehouse, Min Manufacturing Qty, UOM.

**UOM Conversion**: `min_qty_in_stock_uom = min_manufacturing_qty × conversion_factor`
from `UOM Conversion Detail {parent: item_code, uom: min_uom}`. Falls back to 1.0.

**Final production qty**: `max(shortage, min_mfg_qty_in_stock_uom)`

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
`mr_generator.py` — checks for existing non-cancelled PPs with blank projection reference.

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
