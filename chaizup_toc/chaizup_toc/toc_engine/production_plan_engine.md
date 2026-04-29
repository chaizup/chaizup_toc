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
