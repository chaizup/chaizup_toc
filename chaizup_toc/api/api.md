# `api/` — Public API Endpoints & Utilities

## Purpose
All Python-callable API methods exposed to the Frappe frontend (JS `frappe.call`), REST clients, and internal services. Every function here is decorated with `@frappe.whitelist()`.

## Files

| File | Role |
|------|------|
| `toc_api.py` | Core buffer query + action APIs |
| `permissions.py` | App-level and DocType-level permission helpers |
| `demo_data.py` | Admin-only test data creation/deletion |

---

## `toc_api.py` — Core API

### URL Pattern
```
/api/method/chaizup_toc.api.toc_api.<function_name>
```

### Methods

#### `get_priority_board(buffer_type, company, warehouse)`
Returns the full priority-sorted buffer board. Delegates to `calculate_all_buffers()`.
- Sorted by BP% descending (most urgent first), T/CU as tie-breaker.
- Used by: TOC Dashboard, Production Priority Board report, Item form "Buffer Status" button.

#### `get_single_buffer(item_code, warehouse)`
Returns buffer status for one item-warehouse pair. Returns `None` if not found.

#### `trigger_manual_run(buffer_type, zone_filter)`
Manually triggers Material Request generation.
- **Restricted to**: `System Manager`, `Stock Manager`, `TOC Manager`
- Calls `generate_material_requests()` with optional zone filter (JSON list).
- Used by: Production Priority Board "Generate MRs Now" button.

#### `recalculate_item_buffers(item_code)`
Recalculates `target_buffer` and `adjusted_buffer` for all rules of one item.
- Applies F1 (`ADU × RLT × VF`) and F6 (DAF) inline.
- **Restricted to**: `System Manager`, `Stock Manager`, `TOC Manager`

#### `apply_global_daf(daf_value, event_name)`
Applies a Demand Adjustment Factor to ALL enabled buffer rules.
- Updates `TOC Item Buffer.daf` and `adjusted_buffer = target_buffer × daf`.
- Stores current DAF on `TOC Settings` (`default_daf`, `daf_event_name`).
- **Restricted to**: `System Manager`, `TOC Manager`
- DAF range: 0.1 – 5.0 (throws outside this range).

#### `reset_global_daf()`
Calls `apply_global_daf(1.0, "Normal Operations")`.

#### `get_buffer_summary()`
Returns zone counts + `avg_bp_pct` across all items. Used by Dashboard summary cards.

#### `check_bom(item_code, qty)`
R3: Calls `check_bom_availability()` and returns multi-level BOM component availability.

#### Number Card Methods (workspace widgets)
All four are `@frappe.whitelist()` and return a single integer. They count `TOC Buffer Log` records for **today's** date.

| Method | Returns |
|--------|---------|
| `nc_red_zone_count()` | Items in Red or Black zone today |
| `nc_yellow_zone_count()` | Items in Yellow zone today |
| `nc_green_zone_count()` | Items in Green zone today |
| `nc_open_mr_count()` | Draft MRs created by TOC System |

> **Why custom methods instead of standard Number Card filters?** Frappe's date filter with `"Today"` causes parsing errors in some versions. These methods avoid that issue entirely by handling the date logic in Python.

---

## `permissions.py`

### `has_buffer_log_permission(doc, ptype, user)`
Used in `hooks.py → has_permission["TOC Buffer Log"]`.
- **Read**: everyone (returns True).
- **Write/Create/Delete**: `TOC Manager`, `Stock Manager`, `System Manager` only.

### `has_app_permission()`
Used in `hooks.py → add_to_apps_screen[has_permission]`.
- Returns True if user has any of: `System Manager`, `Administrator`, `TOC Manager`, `TOC User`, `Stock Manager`, `Stock User`, `Purchase Manager`, `Purchase User`, `Manufacturing Manager`, `Manufacturing User`.
- Controls visibility of the Chaizup TOC tile on the Frappe home screen.

---

## `demo_data.py`

Admin-only utility for creating a complete test dataset. All documents are prefixed with `TOC-DEMO-`.

### `create_demo_data()`
Creates:
- 7 Items: 3 FG, 1 SFG, 2 RM, 1 PM — each with a TOC buffer rule and initial stock entry
- 1 BOM: FG-MASALA-1KG → SFG-MASALA-BLEND + RM-TEA-DUST + PM-POUCH-1KG
- Delivery Notes (historical ADU data for FG items)
- A demo Warehouse and Customer
- Saves a manifest JSON to `TOC Settings.demo_data_manifest` for cleanup tracking

### `delete_demo_data()`
Reads the manifest, cancels + deletes all tracked documents in reverse dependency order.

### `get_demo_status()`
Returns `{ exists: bool, count: int, manifest: dict }`.

### Demo Item Configuration (expected zones)
| Item | BP% | Zone |
|------|-----|------|
| FG-MASALA-1KG (stock 200, target 900) | 78% | 🔴 Red |
| FG-GINGER-500G (stock 450, target 810) | 44% | 🟡 Yellow |
| FG-CARDAMOM-200G (stock 1100, target 1260) | 13% | 🟢 Green |
| RM-TEA-DUST (stock 1800, target 7200) | 75% | 🔴 Red |
| RM-SUGAR (stock 8000, target 9750) | 18% | 🟢 Green |
| PM-POUCH-1KG (stock 3000, target 5400) | 44% | 🟡 Yellow |

---

## Known Bugs in `api/`

None in this folder directly. See bugs noted in `toc_engine/` and `tasks/`.
