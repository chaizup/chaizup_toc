# `toc_buffer_management/` — TOC Buffer Management Workspace

## Role
The Frappe Workspace (sidebar module home page) for the Chaizup TOC app. Provides navigation, live number cards, zone distribution chart, and quick links.

## Workspace Metadata (`toc_buffer_management.json`)
```json
{
    "name": "TOC Buffer Management",
    "title": "TOC Buffer Management",
    "module": "Chaizup Toc",
    "icon": "graph",
    "public": 1,
    "sequence_id": 25
}
```

## Layout Sections

### Header
```
🏭 TOC Buffer Management
Theory of Constraints — Replenish what was consumed. No forecasting needed.
```

### Live Buffer Dashboard
Shortcut → `toc-dashboard` page.
Shortcut → User Guide `/toc-user-guide`.

### Live Status (Number Cards)
4 number cards in a row (col=3 each):
| Card | Method |
|------|--------|
| TOC - Items in Red Zone | `nc_red_zone_count` |
| TOC - Items in Yellow Zone | `nc_yellow_zone_count` |
| TOC - Items in Green Zone | `nc_green_zone_count` |
| TOC - Open Material Requests | `nc_open_mr_count` |

### Buffer Zone Distribution
Dashboard Chart: "TOC - Zone Distribution" (Donut, Group By zone on `TOC Buffer Log`).

### Daily Operations
3 report shortcuts:
- Production Priority Board
- Procurement Action List
- Buffer Status Report

### Quick Access
4 shortcuts:
- TOC Managed Items (Item list, filter: `custom_toc_enabled=1`)
- TOC Auto Material Requests (MR list, filter: `custom_toc_recorded_by=By System`)
- TOC Buffer Logs
- DBM Analysis Report

### Recent Buffer Snapshots
- TOC Buffer Logs list
- TOC Auto Material Requests list

### Configuration Cards
- Setup & Settings: TOC Settings, Stock Settings, Item, Warehouse
- Reports: Production Priority Board, Procurement Action List, Buffer Status Report, DBM Analysis
- Stock Masters: Material Request, TOC Buffer Log, Bin, Work Order

### Reference Cards
- TOC Formulas & Guide: User Guide (URL), TOC Settings, Production Priority Board, Buffer Status Report
- System Monitoring: Scheduled Job Log, Error Log, Email Queue, Role Permission Manager

## Shortcuts
| Label | Target | Type |
|-------|--------|------|
| TOC Live Dashboard | toc-dashboard | Page |
| TOC Complete User Guide | /toc-user-guide | URL |
| Production Priority Board | Production Priority Board | Report |
| Procurement Action List | Procurement Action List | Report |
| Buffer Status Report | Buffer Status Report | Report |
| TOC Managed Items | Item (custom_toc_enabled=1) | DocType |
| TOC Auto Material Requests | Material Request (custom_toc_recorded_by=By System) | DocType |
| TOC Buffer Logs | TOC Buffer Log | DocType |
| DBM Analysis Report | DBM Analysis Report | Report |

## Workspace Update History
- Initial: workspace icon was SVG path (broken in sidebar) → fixed by `patches/v1_0/fix_workspace_icon.py` → now `"graph"`
- Initial: workspace shortcuts referenced old field `custom_toc_generated` → fixed by `patches/v1_0/fix_old_field_refs.py` → now `custom_toc_recorded_by`

## Patching Pattern
When changes are needed to this JSON during development:
1. Edit the JSON file.
2. Run `bench --site your-site migrate` to sync the workspace.
3. If migration doesn't pick up the change: add a patch that calls `frappe.delete_doc("Workspace", "TOC Buffer Management", force=True)` — Frappe will recreate from JSON on the same migrate run.
