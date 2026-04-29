# chaizup_toc/ — Frappe Module Folder

This folder is the **Frappe module folder** — the innermost `chaizup_toc/` in the triple-nested structure. It contains every Frappe-managed artifact: DocTypes, Pages, Reports, and Workspaces.

```
apps/chaizup_toc/          ← Git repository root
    chaizup_toc/           ← Python package (installed by pip)
        chaizup_toc/       ← Frappe module folder (THIS FOLDER)
            doctype/       ← DocType definitions
            page/          ← Desk pages
            report/        ← Script reports
            workspace/     ← Workspace definitions
```

---

## Module Identity

**Module name**: `Chaizup Toc`

This exact string (with capital C, T, and the space) must appear in:
- Every DocType JSON: `"module": "Chaizup Toc"`
- Every Report JSON: `"module": "Chaizup Toc"`
- Every Page JSON: `"module": "Chaizup Toc"`
- Every Workspace JSON: `"module": "Chaizup Toc"`
- `modules.txt`: `Chaizup Toc`
- Fixture filters: `[["module", "=", "Chaizup Toc"]]`

A mismatch causes DocTypes to not be found during migrate, or fixtures to not be exported.

---

## Module Registration

Registered in `chaizup_toc/modules.txt`:
```
Chaizup Toc
```

Frappe reads `modules.txt` to know which modules this app provides. Each module maps to a folder in the Python package with the same snake_case name (`chaizup_toc` → `chaizup_toc/`).

---

## What Frappe Discovers Here

During `bench migrate`, Frappe scans this folder structure:

```
bench migrate scans:
  chaizup_toc/doctype/*/  → Creates/updates DocType records
  chaizup_toc/page/*/     → Creates/updates Page records
  chaizup_toc/report/*/   → Creates/updates Report records
  chaizup_toc/workspace/* → Creates/updates Workspace records
```

All JSON files are read and their contents are inserted/updated in the site's database. Python controller files are loaded as Python modules.

---

## Subfolders

### doctype/ — Custom DocTypes

Five DocTypes providing the data model for the TOC system:

| DocType | Type | Role |
|---------|------|------|
| TOC Buffer Log | Standard | Daily snapshot archive |
| TOC Item Buffer | Child Table | Per-warehouse buffer rules on Item |
| TOC Settings | Singleton | App-wide configuration |
| TOC Warehouse Rule | Child Table | Warehouse classification (Inventory/WIP/Excluded) |
| TOC Item Group Rule | Child Table | LEGACY — removed from TOC Settings UI |

Also includes `Custom Field` and `Property Setter` fixtures that extend built-in ERPNext DocTypes (Item, Material Request, Work Order).

Full documentation: `doctype/doctype.md`

### page/ — Desk Pages

Six interactive operational interfaces:

| Page | Route | Purpose |
|------|-------|---------|
| toc_dashboard | `/app/toc-dashboard` | Live auto-refreshing buffer priority board |
| toc_item_settings | `/app/toc-item-settings` | Bulk TOC configuration per item with help panel (added 2026-04-26) |
| toc_user_guide | `/app/toc-user-guide` | Self-contained tutorial — formulas, triggers, config reference (added 2026-04-26) |
| kitting_report | `/app/kitting-report` | Production readiness and BOM component status |
| supply_chain_tracker | `/app/supply-chain-tracker` | 7-stage supply chain Kanban pipeline |
| wo_kitting_planner | `/app/wo-kitting-planner` | Work Order kitting planner (7 tabs) |

Full documentation: `page/page.md`

### report/ — Script Reports

Four Script Reports for daily operations and analysis:

| Report | Purpose |
|--------|---------|
| production_priority_board | What to produce/order today — sorted by BP%, filterable by Manufacture/Purchase/Monitor mode |
| procurement_action_list | What to buy today (Purchase-mode items) — with freight recommendations |
| buffer_status_report | Historical buffer trends from TOC Buffer Log |
| dbm_analysis_report | DBM health check — which buffers need manual review |

Full documentation: `report/report.md`

### workspace/ — Workspaces

One Frappe Workspace providing the module homepage:

| Workspace | Description |
|-----------|-------------|
| toc_buffer_management | Sidebar module page with Number Cards, shortcuts, and configuration links |

Full documentation: `workspace/workspace.md`

---

## File Count Summary

```
doctype/         5 DocTypes × 3 files each = 15 Python+JSON files
                 + 5 markdown docs
page/            2 Pages × 3 files each = 6 HTML+JS+JSON files
                 + 2 markdown docs (+ page/page.md index)
report/          4 Reports × 3 files each = 12 Python+JS+JSON files
                 + 4 markdown docs (+ report/report.md index)
workspace/       1 Workspace × 1 JSON file
                 + 1 markdown doc (+ workspace/workspace.md index)
```

---

## Naming Convention

All folders and files use `snake_case` matching the DocType/Report/Page name with spaces replaced by underscores:

```
"TOC Buffer Log"  →  toc_buffer_log/
"Production Priority Board"  →  production_priority_board/
"TOC Buffer Management"  →  toc_buffer_management/
```

The JSON `name` field uses the human-readable name (with spaces and title case). The folder name uses snake_case. Frappe derives the folder name from the `name` field automatically when creating new artifacts.

---

## Adding New Artifacts

### New DocType

```bash
bench --site your-site new-doctype "My New DocType" --module "Chaizup Toc"
# Creates: chaizup_toc/chaizup_toc/doctype/my_new_doctype/
# Files:   my_new_doctype.json, my_new_doctype.py, test_my_new_doctype.py
```

Or manually create the folder and files following the existing pattern.

### New Script Report

```bash
bench --site your-site new-report "My Report" --module "Chaizup Toc" --type "Script Report"
# Creates: chaizup_toc/chaizup_toc/report/my_report/
# Files:   my_report.json, my_report.py, my_report.js
```

### New Page

Manually create folder and three files (JSON, HTML, JS). Register in `hooks.py → page_js` if needed for global JS loading.

---

## Key Integration Points

This module folder is the center of a web of dependencies:

```
chaizup_toc/ (this folder)
  │
  ├── is called by: hooks.py scheduler_events → tasks/daily_tasks.py
  ├── is called by: hooks.py doc_events → overrides/*.py
  ├── exposes APIs via: api/toc_api.py, api/kitting_api.py (@frappe.whitelist)
  │
  ├── reads from ERPNext:
  │     Bin, Work Order, Purchase Order, Sales Order, Delivery Note,
  │     Material Request, Stock Entry, BOM, BOM Item
  │
  └── writes to ERPNext:
        Material Request (auto-generated by mr_generator)
        Work Order (auto-generated by kitting_api)
        TOC Buffer Log (daily snapshots by daily_tasks)
        TOC Item Buffer.target_buffer (DBM updates by dbm_engine)
```

The module folder's artifacts are the public face of the app. The business logic lives in the sibling folders (`toc_engine/`, `api/`, `tasks/`, `overrides/`) which are plain Python modules, not Frappe artifacts.
