# toc_engine/ (Frappe module scope) — Production & Projection Engines

This folder contains Python modules that handle production planning automation
and sales projection processing. These are distinct from the core buffer calculation
engines in the outer `chaizup_toc/toc_engine/` folder.

```
chaizup_toc/chaizup_toc/toc_engine/   ← THIS FOLDER (Frappe module scope)
├── production_plan_engine.py  ← Calc 1/2, SO eligibility, BOM walk, WO creation
├── projection_engine.py       ← Sales Projection → WO automation, notifications
├── production_plan_engine.md  ← Full formula reference and logic docs
└── projection_engine.md       ← Projection automation docs

chaizup_toc/toc_engine/               ← OUTER FOLDER (core TOC engine)
├── buffer_calculator.py       ← F1–F5 core formulas
├── dbm_engine.py              ← F7/F8 dynamic buffer management
├── mr_generator.py            ← Material Request creation and routing
└── toc_engine.md              ← Full formula reference F1–F8
```

## Why Two toc_engine Folders?

Frappe modules must reside inside the triple-nested module folder to be discoverable
by Frappe's module system. The outer `toc_engine/` has pure Python business logic
(no Frappe artifacts), while this inner folder holds modules that are called from
hooks.py and need to be importable from the Frappe module path.

## Modules

### production_plan_engine.py

**Purpose**: Converts Sales Projection items into Draft Work Orders, walking the
BOM tree for sub-assemblies.

**Called by**:
- `tasks.daily_tasks.daily_projection_automation` at 06:00 daily
- `@frappe.whitelist` `run_projection_automation` (manual button on submitted Sales Projection)

**Key functions**:
- `run_projection_automation(projection_name, triggered_by)` — whitelist entry point
- `daily_projection_automation()` — scheduler entry, finds current month projection
- `_calc_net_required(item, projection_doc)` — Calc 1 / Calc 2 net demand logic
- `_create_work_order(item_code, qty, reason)` — creates Draft WO with custom fields
- `_walk_bom_for_subassemblies(bom_name, depth)` — recursive sub-WO creation (max depth 10)

**Net Required Formula**:
```
Net = (projected_qty + prev_month_pending_SO) - curr_month_pending_SO - (stock + open_WO)
```

**SO Eligibility**: PATH A (docstatus=0 + workflow states) OR PATH B (docstatus=1 + delivery statuses).
SO date filter uses `delivery_date` — NOT `transaction_date`.

**Doc Events**:
- `on_sales_projection_update` → sends edit notification (docstatus=0 only)
- `on_sales_projection_submit` → sends submit notification

Full documentation: `production_plan_engine.md`

### projection_engine.py

**Purpose**: Handles the notification and trigger flow for Sales Projection document events.

**Called by**: `hooks.py` doc_events for Sales Projection on_update and on_submit.

Full documentation: `projection_engine.md`

## Dependencies

- `frappe` (Document, db, publish_realtime, sendmail)
- `erpnext` (Work Order, BOM, Sales Order DocTypes)
- `chaizup_toc.chaizup_toc.doctype.sales_projection` (Sales Projection DocType)
- `chaizup_toc.chaizup_toc.doctype.toc_settings` (TOC Settings singleton for config)

## Database Connections

| Operation | DocType | How |
|-----------|---------|-----|
| Read projection | Sales Projection + Sales Projected Items | `frappe.get_doc` |
| Read Sales Orders | Sales Order | SQL with `delivery_date` filter |
| Read BOM | BOM + BOM Item | `frappe.get_doc` + recursive walk |
| Read stock | Bin | `frappe.db.get_value` |
| Create WOs | Work Order | `frappe.new_doc` + save |
| Update WO status | Sales Projected Items | `doc.wo_status`, `doc.wo_name` |
| Stamp last run | Sales Projection | `doc.last_auto_run` + save |

## RESTRICT

- `_MAX_BOM_DEPTH = 10` in production_plan_engine.py — prevents infinite BOM loop
- `frappe.only_for()` in `run_projection_automation` — security gate, do not remove
- `docstatus == 0` check in `on_update` handler — prevents double-notification on submit
- `delivery_date` in SO SQL — do NOT change to `transaction_date`
- Empty `pending_statuses` guard — `IN ()` crashes MariaDB; always check len > 0
