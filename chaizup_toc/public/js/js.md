# `public/js/` — Client-Side JavaScript Files

## `desk_branding.js` — Global Desk Enhancements

Loaded on every Frappe desk page via `hooks.py → app_include_js`.

### What It Does

#### 1. Zone Colour in List Views
Targets cells with `data-field="zone"` or `data-field="custom_toc_zone"`.
- Not already styled (`not(.toc-styled)`).
- Applies background colour, text colour, pill shape, bold font.
- Runs on: initial load, `page-change` events (500ms delay), and MutationObserver on `document.body`.

Zone colours:
| Zone | Background | Text |
|------|-----------|------|
| Red | #FADBD8 | #E74C3C |
| Yellow | #FEF9E7 | #F39C12 |
| Green | #D5F5E3 | #27AE60 |
| Black | #D5D8DC | #2C3E50 |

#### 2. Real-Time Buffer Alerts
Listens to `frappe.realtime.on("toc_buffer_alert", ...)`.
Published by `check_realtime_alert()` in `buffer_calculator.py` via background job.

Shows `frappe.show_alert()` (10-second toast) with item code, zone, and BP%.

#### 3. Keyboard Shortcut: Ctrl+Shift+T
Opens TOC Buffer Management workspace via `frappe.set_route("Workspaces", "TOC Buffer Management")`.

---

## `item_toc.js` — Item Form TOC Tab

Loaded via `hooks.py → doctype_js["Item"]`.

### Form Events

#### `refresh`
- Calls `_toggle_adu(frm)` — sets ADU field read-only state.
- If TOC enabled, adds buttons under **TOC** button group:
  - **Buffer Status**: Calls `get_priority_board(item_code)` and shows modal with zone, BP%, IP, order qty, BOM status.
  - **Check BOM** (shown only if `custom_toc_default_bom` + `custom_toc_check_bom_availability`): Calls `check_bom()` and shows component availability table.
  - **Priority Board**: Routes to Production Priority Board report.

#### `custom_toc_custom_adu`
Toggles ADU field read-only state via `_toggle_adu()`.

#### `custom_toc_auto_purchase` / `custom_toc_auto_manufacture`
Enforces mutual exclusion on the client side (unchecks the other if both are checked). The server also enforces this in `overrides/item.py`.

#### `custom_toc_selling_price` / `custom_toc_tvc` / `custom_toc_constraint_speed`
All three trigger `_calc_tcu(frm)`:
```js
T/CU = (selling_price - tvc) × constraint_speed
```
Sets `custom_toc_tcu` immediately on the form.

### Helper Functions

#### `_toggle_adu(frm)`
- Custom ADU checked → `adu_value` is editable, hides `adu_period` and `adu_last_updated`.
- Custom ADU unchecked → `adu_value` is read-only (auto-calculated), shows `adu_period` and `adu_last_updated`.

#### `_calc_tcu(frm)`
Client-side T/CU calculation. If `price > 0 && speed > 0`, computes and sets `custom_toc_tcu`.

---

## `material_request_toc.js` — MR Form

Loaded via `hooks.py → doctype_js["Material Request"]`.

### `refresh`
If `custom_toc_recorded_by === "By System"`:
- Sets intro banner (colored by zone) showing zone, BP%, target, IP, and formula explanation.
- Colors: Red/Black=red, Yellow=orange, Green=green.

Always adds **TOC Priority Board** button under **View** group → routes to Production Priority Board report.

---

## `stock_entry_toc.js` — Stock Entry Form

Loaded via `hooks.py → doctype_js["Stock Entry"]`.

### `refresh`
On draft Stock Entries, adds **Check Buffer Impact** button (under **TOC** group):
- Collects all unique item codes from the form's items table.
- Calls `get_priority_board()` (no filter — returns all TOC items).
- Filters the results to only items present in this Stock Entry.
- Shows a formatted table with zone, BP%, and Inventory Position for all matching TOC-managed items.
- If no items are TOC-managed, shows an informational message.

---

## Bug History

### ~~BUG (FIXED): `_openMR()` in dashboard creates MRs for ALL items~~
Confirm dialog was misleading — said "[item]" but created MRs for all Red/Yellow items of that buffer type. **Fixed**: dialog text now accurately communicates this behavior.

### ~~BUG (FIXED): `_openMR()` permission mismatch~~
"Action Now" button was visible to `Stock User`/`Purchase Manager` but `trigger_manual_run` requires `Stock Manager`/`TOC Manager`/`System Manager`. **Fixed**: `frappe.user.has_role()` gate added — unauthorized users see a plain text zone indicator instead.

### ~~BUG (FIXED): `stock_entry_toc.js` only checked first item~~
When a Stock Entry had multiple items, only the first item's buffer was shown. **Fixed**: now fetches all buffer data and filters by all item codes in the entry, showing a full table for all TOC-managed items.
