# chaizup_toc/ — Python Package Root

This is the installed Python package for the Chaizup TOC app. All app logic — business rules, APIs, scheduler tasks, ERPNext overrides, and Frappe artifacts — lives here.

```
apps/chaizup_toc/          ← Git repository root
    chaizup_toc/           ← Python package (THIS FOLDER — installed by pip/bench)
        hooks.py           ← Master wiring: all Frappe hooks
        modules.txt        ← Module registry
        chaizup_toc/       ← Frappe module folder (DocTypes, Reports, Pages)
        toc_engine/        ← TOC business logic (pure Python)
        api/               ← @whitelist() API endpoints
        tasks/             ← Scheduled jobs
        overrides/         ← ERPNext DocType overrides
        setup/             ← Install/uninstall hooks
        patches/           ← Database migration patches
        config/            ← Desktop/module configuration
        public/            ← Client-side assets (JS, CSS, images)
```

---

## App Identity

From `hooks.py`:

```python
app_name        = "chaizup_toc"
app_title       = "Chaizup TOC"
app_publisher   = "Chaizup"
app_description = "Theory of Constraints Buffer Management for ERPNext"
app_version     = "1.0.0"
required_apps   = ["frappe", "erpnext"]
```

The `required_apps` constraint ensures `erpnext` is installed before this app can be added to a site. The app extends ERPNext's Item, Material Request, Work Order, and Stock Settings DocTypes.

---

## Package Structure — Full Tree

```
chaizup_toc/
├── hooks.py                        ← Master wiring: ALL Frappe hooks
├── modules.txt                     ← "Chaizup Toc"
│
├── api/                            ← Whitelisted API endpoints
│   ├── toc_api.py                  ← get_priority_board, apply_global_daf, number cards, manual MR trigger
│   ├── kitting_api.py              ← Kitting report: BOM walk, WO/MR creation
│   ├── permissions.py              ← has_buffer_log_permission, has_app_permission
│   └── demo_data.py                ← Admin: seed/delete test data for demos
│
├── toc_engine/                     ← Core TOC business logic (pure Python, no Frappe UI)
│   ├── buffer_calculator.py        ← F1-F5 + F6 + zone + BOM check + real-time alerts
│   ├── dbm_engine.py               ← F7 TMR / F8 TMG auto-adjustment (runs weekly)
│   ├── mr_generator.py             ← Create Material Requests from buffer data; min order qty floor
│   └── component_mr_generator.py  ← Post-WO: BOM component shortage → Purchase MR creation
│
├── overrides/                      ← Hooks into ERPNext DocType lifecycle events
│   ├── item.py                     ← Item validate: ADU calc, T/CU, BOM check, mutual exclusion
│   ├── material_request.py         ← MR validate: compliance warning for manual MRs
│   └── reorder_override.py         ← Replaces ERPNext's default reorder_item() with TOC logic
│
├── tasks/
│   └── daily_tasks.py              ← 5 scheduled functions: ADU, MR gen, procurement, snapshot, DBM
│
├── setup/
│   └── install.py                  ← after_install, before_uninstall, custom fields, roles, cards
│
├── patches/
│   ├── patches.txt                 ← Ordered list of all patches
│   └── v1_0/
│       ├── fix_date_filters.py     ← Fix Dashboard Chart "Today" filter bug (Frappe v14+)
│       ├── fix_old_field_refs.py   ← Fix workspace shortcut referencing deleted custom field
│       ├── fix_workspace_icon.py   ← Fix broken SVG icon → "graph"
│       └── recreate_number_cards.py ← Force-recreate number cards (type: Custom + method)
│
├── config/
│   └── desktop.py                  ← Legacy module tile (Frappe v13 compatibility)
│
├── public/
│   ├── js/
│   │   ├── desk_branding.js        ← Global: zone colors, realtime alerts, Ctrl+Shift+T shortcut
│   │   ├── item_toc.js             ← Item form: TOC tab, ADU toggle, T/CU calc, buffer status button
│   │   ├── material_request_toc.js ← MR form: TOC zone banner, TOC Priority Board button
│   │   └── stock_entry_toc.js      ← Stock Entry: "Check Buffer Impact" button
│   ├── css/
│   │   └── toc.css                 ← Global TOC styling: zone pills, bar fills, dashboard layout
│   └── images/
│       └── toc_logo.png            ← App icon for Apps home screen
│
└── chaizup_toc/                    ← Frappe module folder (migrated artifacts)
    ├── doctype/                    ← TOC Buffer Log, TOC Item Buffer, TOC Settings, Item Min Order Qty + child tables
    ├── page/                       ← toc-dashboard, kitting-report
    ├── report/                     ← 4 Script Reports
    └── workspace/                  ← TOC Buffer Management workspace
```

---

## hooks.py — Master Wiring

The `hooks.py` file is the single source of truth for all Frappe integration points. Every hook type used in this app:

### App Lifecycle

```python
after_install   = "chaizup_toc.setup.install.after_install"
before_uninstall = "chaizup_toc.setup.install.before_uninstall"
```

`after_install` creates all custom fields, roles, and number cards. `before_uninstall` re-enables ERPNext's built-in auto-reorder (which this app disabled).

### Scheduler Events

```python
scheduler_events = {
    "cron": {
        "30 6 * * *": ["chaizup_toc.tasks.daily_tasks.daily_adu_update"],       # 06:30 daily
        "0 7 * * *":  ["chaizup_toc.tasks.daily_tasks.daily_production_run"],   # 07:00 daily
        "30 7 * * *": ["chaizup_toc.tasks.daily_tasks.daily_procurement_run"],  # 07:30 daily
        "0 8 * * *":  ["chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot"],  # 08:00 daily
        "0 4 * * 0":  ["chaizup_toc.tasks.daily_tasks.weekly_dbm_check"],       # 04:00 Sunday
    }
}
```

All times are relative to the server timezone (set in Site Config). Verify with `bench --site site-name show-config | grep time`.

### Doc Events (ERPNext Integration Hooks)

```python
doc_events = {
    "Stock Ledger Entry": {
        "after_insert": "chaizup_toc.toc_engine.buffer_calculator.on_stock_movement"
    },
    "Sales Order": {
        "on_submit": "chaizup_toc.toc_engine.buffer_calculator.on_demand_change",
        "on_cancel": "chaizup_toc.toc_engine.buffer_calculator.on_demand_change",
    },
    "Work Order": {
        "on_submit": "chaizup_toc.toc_engine.buffer_calculator.on_supply_change",
        "on_cancel": "chaizup_toc.toc_engine.buffer_calculator.on_supply_change",
        "on_update_after_submit": "chaizup_toc.toc_engine.buffer_calculator.on_supply_change",
    },
    "Purchase Order": {
        "on_submit": "chaizup_toc.toc_engine.buffer_calculator.on_supply_change",
        "on_cancel": "chaizup_toc.toc_engine.buffer_calculator.on_supply_change",
    },
    "Material Request": {
        "validate": "chaizup_toc.overrides.material_request.validate_toc_compliance"
    },
    "Item": {
        "validate": "chaizup_toc.overrides.item.on_item_validate"
    }
}
```

**What each hook does:**
- `on_stock_movement`: Real-time alert check when stock changes — publishes to browser if item enters Red
- `on_demand_change`: Recalculates buffer for affected items when SO submitted/cancelled
- `on_supply_change`: Recalculates buffer when WO/PO status changes
- `validate_toc_compliance`: Shows warning if user manually creates MR for a TOC-managed item
- `on_item_validate`: Validates ADU, T/CU, BOM, and mutual exclusion on item save

### ERPNext Override

```python
override_whitelisted_methods = {
    "erpnext.stock.reorder_item.reorder_item": 
        "chaizup_toc.overrides.reorder_override.toc_reorder_item"
}
```

This is the critical override that replaces ERPNext's default reorder algorithm with TOC's buffer penetration logic. Without this, ERPNext would still use Min/Max reorder levels even with TOC enabled.

### Client-Side Assets

```python
app_include_js  = ["/assets/chaizup_toc/js/desk_branding.js"]
app_include_css = ["/assets/chaizup_toc/css/toc.css"]

doctype_js = {
    "Item": "public/js/item_toc.js",
    "Material Request": "public/js/material_request_toc.js",
    "Stock Entry": "public/js/stock_entry_toc.js",
}
```

`app_include_js` files load on every Frappe desk page. `doctype_js` files load only when that specific DocType form is opened.

### Apps Home Screen

```python
add_to_apps_screen = [{
    "name": "Chaizup TOC",
    "logo": "/assets/chaizup_toc/images/toc_logo.png",
    "title": "TOC Buffer Management",
    "route": "/app/toc-dashboard",
    "has_permission": "chaizup_toc.api.permissions.has_app_permission",
}]
```

### Fixtures

```python
fixtures = [
    {"doctype": "Custom Field", "filters": [["module", "=", "Chaizup Toc"]]},
    {"doctype": "Property Setter", "filters": [["module", "=", "Chaizup Toc"]]},
]
```

Exports all Custom Fields and Property Setters tagged with this module.

---

## Dependency Map — Which Module Calls Which

```
hooks.py (wiring only)
  │
  ├── scheduler_events → tasks/daily_tasks.py
  │     ├── daily_adu_update()
  │     │     └── reads: Sales Order, Delivery Note, Stock Entry
  │     │         writes: Item.custom_toc_adu_value
  │     ├── daily_production_run()
  │     │     └── calls: mr_generator.generate_material_requests()
  │     │           └── calls: buffer_calculator.calculate_all_buffers()
  │     ├── daily_buffer_snapshot()
  │     │     └── calls: buffer_calculator.calculate_all_buffers()
  │     │         writes: TOC Buffer Log (one row per item+warehouse)
  │     └── weekly_dbm_check()
  │           └── calls: dbm_engine.evaluate_all_dbm()
  │                 reads: TOC Buffer Log (last N days)
  │                 writes: TOC Item Buffer.target_buffer, tmr_count
  │
  ├── doc_events → toc_engine/buffer_calculator.py (on_stock_movement, on_demand_change, on_supply_change)
  ├── doc_events → overrides/item.py (on_item_validate)
  ├── doc_events → overrides/material_request.py (validate_toc_compliance)
  ├── override_whitelisted_methods → overrides/reorder_override.py
  │
  └── client-side JS → public/js/*.js
        ├── desk_branding.js (global zone colors, Ctrl+Shift+T, realtime alerts)
        ├── item_toc.js (Item form buttons, T/CU calc, ADU toggle)
        ├── material_request_toc.js (MR form zone banner)
        └── stock_entry_toc.js (Stock Entry buffer check)

api/toc_api.py (@whitelist endpoints)
  ├── get_priority_board() → calls calculate_all_buffers() → returns live buffer data
  ├── apply_global_daf() → updates TOC Item Buffer.daf, adjusted_buffer for all items
  ├── reset_global_daf() → resets all DAFs to 1.0
  ├── trigger_manual_run() → calls mr_generator.generate_material_requests()
  ├── nc_red_zone_count() → counts today's Red/Black in TOC Buffer Log
  └── get_buffer_summary() → counts all zones from TOC Buffer Log

api/kitting_api.py (@whitelist endpoints)
  ├── get_kitting_summary() → reads SO, DN, Bin, Stock Entry, BOM
  ├── get_item_kitting_detail() → walks BOM tree recursively
  ├── create_purchase_requests() → creates Purchase MR from component shortages
  └── create_work_order_from_kitting() → creates Work Order for FG/SFG
```

---

## Frappe HTML Template Critical Rule

All pages use `frappe.render_template("page_name", {})` which caches the HTML inside a
single-quoted JS string:
```
frappe.templates["page_name"] = '...HTML...'
```
**Any raw single quote `'` inside an onclick/oninput attribute causes SyntaxError.**
This crashed the entire `toc-item-settings` page on 2026-04-26.

Rule: always use `&quot;` for string arguments in HTML event handlers:
- ✅ `onclick="tisApp.switchTab(&quot;enable&quot;, this)"`
- ❌ `onclick="tisApp.switchTab('enable', this)"`

After any `.html` template change: `redis-cli -h redis-cache -p 6379 FLUSHALL`

---

## Bug Inventory — All Known Bugs (18 Total, All Fixed)

| ID | Severity | Location | Description |
|----|----------|----------|-------------|
| BUG-001 | **CRITICAL** | `hooks.py` | `on_buffer_rule_validate` doc_event referenced non-existent function. Every Item save failed. **Fixed**: removed the doc_event entry. |
| BUG-002 | Medium | `hooks.py` comment + `daily_tasks.py` | `daily_procurement_run()` docstring falsely claimed it generated Purchase MRs. It only logs monitoring data. **Fixed**: updated comments. |
| BUG-003 | Medium | `toc_dashboard.js._openMR()` | Confirm dialog said "Create MR for [item]" but created MRs for ALL Red/Yellow items of that type. **Fixed**: dialog text now explicitly states the scope. |
| BUG-004 | Medium | `toc_dashboard.js` | "Action Now" button visible to `Stock User`/`Purchase Manager` who lack permission for `trigger_manual_run`. **Fixed**: `frappe.user.has_role()` gate. |
| BUG-005 | Low | `toc_dashboard.js` + HTML | "On Hand" column showed `inventory_position` (F2 calculated value) not `on_hand` (physical stock). **Fixed**: reads `r.on_hand` now. |
| BUG-006 | Low | `buffer_calculator.py` | `_check_sfg_availability()` defined but never called (dead code from pre-BOM integration). **Fixed**: removed. |
| BUG-007 | Low | `toc_item_buffer.py` | Dead variable `yel_pct` computed but not used. **Fixed**: removed. |
| BUG-008 | Low | `buffer_status_report.py` | Correlated subquery for `item_name` (O(n) queries). **Fixed**: replaced with `LEFT JOIN tabItem`. |
| BUG-009 | Low | `toc_item_buffer.py` | `frappe.get_cached_doc("TOC Settings")` crashed on fresh install before settings saved. **Fixed**: try/except with `yellow_threshold = 33.0` fallback. |
| BUG-010 | Low | `stock_entry_toc.js` | "Check Buffer Impact" only showed first item's buffer. **Fixed**: fetches all buffer data, filters by all item codes in the Stock Entry. |
| BUG-011 | **HIGH** | `api/toc_api.py` — `get_priority_board` | Missing `item_code` parameter — the Item form "Buffer Status" button always showed the globally most-urgent item instead of the current item's data. **Fixed**: added `item_code=None` parameter and passed it to `calculate_all_buffers`. |
| BUG-012 | **HIGH** | `page/toc_dashboard/toc_dashboard.js` — `_openMR` | `zone_filter` excluded Black zone — stockout items (BP%≥100) never received MRs when "Action Now" was clicked. **Fixed**: `["Red","Black","Yellow"]` in zone_filter; dialog text updated to state "Red/Black/Yellow". |
| BUG-013 | Medium | `api/kitting_api.py` — `_component_stage` + `_open_mrs_for_item` | Both MR queries used `mr.docstatus = 1` (Submitted). All TOC auto-MRs are Draft (docstatus=0) — they were invisible in kitting stage and drill-down. **Fixed**: changed to `mr.docstatus < 2` in both functions. |
| BUG-014 | Medium | `tasks/daily_tasks.py` — `daily_buffer_snapshot` | Inner exception handler had a bare `pass` — any per-item snapshot failure (e.g. missing warehouse field) was silently swallowed with no Error Log entry. **Fixed**: replaced with `frappe.log_error(...)`. |
| BUG-015 | Medium | `api/toc_api.py` — `apply_global_daf` | Used `frappe.db.set_value("TOC Settings", "TOC Settings", {...})` to update the Singleton — this is incorrect API for Singleton DocTypes and does not update `singles` table correctly. **Fixed**: replaced with `frappe.db.set_single_value()` calls. |
| BUG-016 | Medium | `toc_engine/buffer_calculator.py` — `_calculate_single` 
|
| BUG-017 | Low | `hooks.py` — `scheduler_events` | `daily_buffer_snapshot` (08:00 AM daily) and `weekly_dbm_check` (08:00 AM Sunday) fired simultaneously on Sundays. DBM reads from today's Buffer Log — if snapshot hadn't fully committed, DBM could miss entries. **Fixed**: DBM cron moved to `"0 9 * * 0"` (09:00 AM Sunday). |
| BUG-018 | **CRITICAL** | `toc_item_settings.html` — modal tab buttons | Raw single quotes in `onclick="tisApp.switchTab('enable', this)"` broke Frappe template caching. Frappe wraps HTML templates in a single-quoted JS string — any `'` inside the attribute value terminates the string, causing `SyntaxError: Unexpected identifier 'enable'`. **Fixed** 2026-04-26: replaced all `'value'` with `&quot;value&quot;` in onclick handlers. Same rule applied to `toc_user_guide.html` nav links. |

---

## Deployment Checklist

New site setup order:

```
1. bench --site site install-app erpnext
2. bench --site site install-app chaizup_toc      # triggers after_install
3. Open TOC Settings → configure:
     a. Warehouse Rules (Inventory/WIP/Excluded)
     b. Zone Thresholds (default 67/33 is fine)
     c. MR Generation settings
4. Enable custom_toc_enabled=1 on 2-3 test items
5. Set ADU/RLT/VF on their TOC Item Buffer rules
6. Run: bench --site site execute chaizup_toc.tasks.daily_tasks.daily_adu_update
7. Open Production Priority Board → verify items appear with correct BP%
8. Run: bench --site site execute chaizup_toc.tasks.daily_tasks.daily_production_run
9. Verify Material Requests were created for Red/Black/Yellow items
10. Enable remaining items after verification
11. Wait 30 days, then enable DBM (enable_dbm = 1 in TOC Settings)
12. Configure Min Order Qty (optional): on each purchased item → TOC tab → "Min Order Qty Rules"
    → add rows per warehouse with warehouse, uom, min_order_qty
    → stock_uom / conversion_factor / stock_uom_qty auto-populate on save
```

---

## Sync Block — Session 2026-04-27 (Component Shortage MRs + Min Order Qty)

### New: `Item Min Order Qty` Child Table

**DocType**: `Item Min Order Qty` (istable=1, module=Chaizup Toc)
**Location**: `chaizup_toc/doctype/item_min_order_qty/`
**Custom field on Item**: `custom_min_order_qty` (Table), insert after `custom_toc_buffer_rules`

| Field | User Input | Auto-populated |
|---|---|---|
| `warehouse` | Yes | No |
| `uom` | Yes | No |
| `min_order_qty` | Yes | No |
| `stock_uom` | No | From Item.stock_uom |
| `conversion_factor` | No | From UOM Conversion Detail |
| `stock_uom_qty` | No | `min_order_qty × conversion_factor` |

**Min order floor rule** (applied in two places):
```
order_qty = max(shortage_in_stock_uom, min_order_qty_in_stock_uom)
```

### New: `component_mr_generator.py`

**Location**: `chaizup_toc/toc_engine/component_mr_generator.py`
**Called as**: Step 7 in `production_plan_engine._submit_pp_and_create_work_orders()`
**Controlled by**: `TOC Settings.auto_create_component_mrs` (default ON)

**Flow**: After WOs are created from a PP:
1. Aggregate all WO Item net_required across all BOM levels (all WOs of the PP)
2. Filter to `custom_toc_auto_purchase = 1` items
3. Compare against Bin.actual_qty to find shortages
4. Apply min order qty floor from `Item Min Order Qty`
5. Dedup: skip if open Purchase MR exists for item+warehouse
6. Create one Purchase MR per item+warehouse (in purchase_uom with conversion)

### Min Order Qty Floor Applied to Buffer MRs

`mr_generator.generate_material_requests()` now calls `build_min_order_map()` for all purchase-mode actionable items and applies `order_qty = max(buffer_order_qty, min_order_qty)` before calling `_create_mr()`.

### TOC Settings New Field

`auto_create_component_mrs` (Check, default ON) — controls Step 7.

### Fixtures

`custom_field.json` now has 53 fields (added `custom_min_order_qty_section` + `custom_min_order_qty` on Item).

### Deployment Note

After deploy, if custom fields are not created by `bench migrate`:
```python
# bench console
doc1 = frappe.get_doc({
    "doctype": "Custom Field", "dt": "Item",
    "fieldname": "custom_min_order_qty_section",
    "fieldtype": "Section Break",
    "insert_after": "custom_toc_buffer_rules",
    "label": "6. Min Order Qty (Purchase / Production)",
    "module": "Chaizup Toc"
})
doc1.insert(ignore_permissions=True)
doc2 = frappe.get_doc({
    "doctype": "Custom Field", "dt": "Item",
    "fieldname": "custom_min_order_qty",
    "fieldtype": "Table",
    "insert_after": "custom_min_order_qty_section",
    "label": "Min Order Qty Rules [TOC App]",
    "module": "Chaizup Toc",
    "options": "Item Min Order Qty"
})
doc2.insert(ignore_permissions=True)
frappe.db.commit()
```
