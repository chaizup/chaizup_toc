# `chaizup_toc/` — Python Package Root

This is the installed Python package for the Chaizup TOC app. All app logic lives here.

## App Identity (`hooks.py`)
```python
app_name        = "chaizup_toc"
app_title       = "Chaizup TOC"
app_publisher   = "Chaizup"
app_version     = "1.0.0"
required_apps   = ["frappe", "erpnext"]
```

## Package Structure

```
chaizup_toc/
├── hooks.py                   ← Master wiring: all hooks, events, schedules
├── modules.txt                ← "Chaizup Toc"
│
├── api/                       ← @frappe.whitelist() API endpoints
│   ├── toc_api.py             ← Buffer queries, DAF, MR trigger, number cards
│   ├── permissions.py         ← has_buffer_log_permission, has_app_permission
│   └── demo_data.py           ← Admin: create/delete test data
│
├── toc_engine/                ← Core TOC business logic (pure Python)
│   ├── buffer_calculator.py   ← F1-F5 calculations, zone logic, BOM check
│   ├── dbm_engine.py          ← F7/F8: TMR/TMG buffer auto-adjustment
│   └── mr_generator.py        ← Material Request creation from buffer data
│
├── overrides/                 ← ERPNext DocType lifecycle overrides
│   ├── item.py                ← Item validate: ADU, T/CU, BOM, mutual exclusion
│   ├── material_request.py    ← MR validate: TOC compliance warning
│   └── reorder_override.py    ← Intercepts ERPNext default auto reorder
│
├── tasks/
│   └── daily_tasks.py         ← Scheduled jobs (06:30, 07:00, 07:30, 08:00, Sunday)
│
├── setup/
│   └── install.py             ← after_install / before_uninstall hooks
│
├── patches/
│   ├── patches.txt            ← Patch execution order
│   └── v1_0/                  ← Version 1.0 patches
│       ├── fix_date_filters.py
│       ├── fix_old_field_refs.py
│       └── fix_workspace_icon.py
│
├── config/
│   └── desktop.py             ← Legacy module tile registration
│
├── public/
│   ├── js/                    ← Client-side JS files
│   │   ├── desk_branding.js   ← Zone colours, realtime alerts, Ctrl+Shift+T
│   │   ├── item_toc.js        ← Item form TOC tab JS
│   │   ├── material_request_toc.js ← MR form zone badge
│   │   └── stock_entry_toc.js ← Stock Entry buffer check
│   ├── css/
│   │   └── toc.css            ← Global TOC styling
│   └── images/
│       └── *.svg              ← Logo/icon assets
│
└── chaizup_toc/               ← Frappe module folder
    ├── doctype/               ← TOC Buffer Log, TOC Item Buffer, TOC Settings
    ├── page/                  ← toc-dashboard
    ├── report/                ← 4 Script Reports
    └── workspace/             ← TOC Buffer Management workspace
```

## hooks.py — Master Wiring Overview

### Lifecycle
| Hook | Target | Purpose |
|------|--------|---------|
| `after_install` | `setup.install.after_install` | Install custom fields, roles, cards |
| `before_uninstall` | `setup.install.before_uninstall` | Re-enable ERPNext auto-reorder |

### Scheduler Events
| Time | Task | Description |
|------|------|-------------|
| 06:30 daily | `daily_adu_update` | Auto-calculate ADU |
| 07:00 daily | `daily_production_run` | Generate MRs for all types |
| 07:30 daily | `daily_procurement_run` | Monitor RM/PM Red/Black (log only) |
| 08:00 daily | `daily_buffer_snapshot` | Archive buffer states |
| 08:00 Sunday | `weekly_dbm_check` | TMR/TMG auto-adjustment |

### Doc Events
| DocType | Event | Handler |
|---------|-------|---------|
| Stock Ledger Entry | after_insert | `buffer_calculator.on_stock_movement` |
| Sales Order | on_submit, on_cancel | `buffer_calculator.on_demand_change` |
| Work Order | on_submit, on_cancel, on_update_after_submit | `buffer_calculator.on_supply_change` |
| Purchase Order | on_submit, on_cancel | `buffer_calculator.on_supply_change` |
| Material Request | validate | `material_request.validate_toc_compliance` |
| Item | validate | `item.on_item_validate` |

### TOC Settings — Inventory Classification (configure first)
| Setting | Purpose |
|---------|---------|
| `warehouse_rules` (child table) | Classify warehouses as Inventory / WIP / Excluded |
| `item_group_rules` (child table) | Map item groups to FG/SFG/RM/PM buffer types |

### Client-Side
| Hook | Asset | Scope |
|------|-------|-------|
| `app_include_js` | `desk_branding.js` | All desk pages |
| `app_include_css` | `toc.css` | All desk pages |
| `doctype_js["Item"]` | `item_toc.js` | Item form |
| `doctype_js["Material Request"]` | `material_request_toc.js` | MR form |
| `doctype_js["Stock Entry"]` | `stock_entry_toc.js` | Stock Entry form |

### Overrides
| Original | Replacement |
|---------|-------------|
| `erpnext.stock.reorder_item.reorder_item` | `overrides.reorder_override.toc_reorder_item` |

---

## Bug Inventory (All Fixed)

| ID | Severity | Location | Status | Description |
|----|----------|----------|--------|-------------|
| BUG-001 | CRITICAL | `hooks.py` + `overrides/item.py` | ✅ Fixed | `on_buffer_rule_validate` referenced in hooks but didn't exist. Removed the entire `"TOC Item Buffer"` doc_event entry. |
| BUG-002 | Medium | `hooks.py` + `tasks/daily_tasks.py` | ✅ Fixed | `daily_procurement_run()` comment falsely claimed it generated Purchase MRs. Updated comment and docstring to say "monitoring-only". |
| BUG-003 | Medium | `toc_dashboard.js` | ✅ Fixed | `_openMR()` confirm dialog was misleading about scope. Now clearly states MRs are created for all Red/Yellow items of that type. |
| BUG-004 | Medium | `toc_dashboard.js` | ✅ Fixed | "Action Now" button visible to users without permission. Added `frappe.user.has_role()` gate — unauthorized users see text indicator only. |
| BUG-005 | Low | `toc_dashboard.js` + `.html` | ✅ Fixed | "On Hand" column showed `inventory_position` (IP). Changed to `r.on_hand`, updated header to "On-Hand". |
| BUG-006 | Low | `toc_engine/buffer_calculator.py` | ✅ Fixed | `_check_sfg_availability()` was defined but never called. Removed dead function. |
| BUG-007 | Low | `toc_item_buffer.py` | ✅ Fixed | `yel_pct` computed in `calculate_zone_thresholds()` but never used. Removed dead variable. |
| BUG-008 | Low | `buffer_status_report.py` | ✅ Fixed | Correlated subquery for `item_name` replaced with `LEFT JOIN \`tabItem\``. |
| BUG-009 | Low | `toc_item_buffer.py` | ✅ Fixed | `frappe.get_cached_doc("TOC Settings")` had no fallback. Added try/except with `yellow_threshold = 33.0` default. |
| BUG-010 | Low | `public/js/stock_entry_toc.js` | ✅ Fixed | "Check Buffer Impact" only checked first item. Now fetches all buffer data and shows table for all TOC-managed items in the entry. |
