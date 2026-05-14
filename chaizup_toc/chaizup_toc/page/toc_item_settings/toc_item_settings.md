# TOC Item Settings — Developer Documentation

Route: `/app/toc-item-settings`

Centralized dashboard for configuring TOC Buffer Management settings across all items. Uses a
filterable grid + modal pattern, plus bulk-action tooling for managing large item catalogs efficiently.

---

## File Structure

```
toc_item_settings/
├── __init__.py                  ← empty
├── toc_item_settings.json       ← Page metadata (roles: TOC Manager, System Manager)
├── toc_item_settings.py         ← Backend API (@frappe.whitelist methods)
├── toc_item_settings.html       ← CSS + page skeleton + modals
├── toc_item_settings.js         ← TOCItemSettings class controller
└── toc_item_settings.md         ← This file
```

---

## Features

### 1. Filterable Item Grid

Paginated table (50/page). Columns: checkbox, item details, group, TOC status badge, auto-mode badge, ADU, buffer rule count, Edit button.

Filter bar fields:
| Filter | Type | Effect |
|--------|------|--------|
| TOC Status | Select | All / Active / Inactive |
| Item Group | Link | Frappe Item Group |
| Search | Data | Searches item_code + item_name (LIKE) |

Stats bar: Total / TOC Active / TOC Inactive / Manufacture / Purchase (loaded as a full-list count call).

### 2. Single-Item Settings Modal (5 tabs)

| Tab | Fields |
|-----|--------|
| Setup | TOC Enable checkbox, Auto Purchase, Auto Manufacture, ⚡ Auto-Detect button |
| ADU | Custom ADU toggle, Lookback Period select, ADU Value input |
| T/CU | Selling Price, TVC, Constraint Speed → live T/CU display |
| BOM | Default BOM input, Check BOM Availability checkbox |
| Buffer Rules | Inline-editable warehouse table with datalist search; RLT, VF, Target (auto), DAF, Enabled |

Saved via `save_item_toc_settings` → `item.save()` (fires `on_item_validate`).

### 3. Bulk Configure Modal (field-level apply)

Select rows → "Bulk Configure" → apply 8 field categories independently.
Calls `bulk_save_toc_settings` (`frappe.db.set_value` — fast, no `on_item_validate`).

| Category | Field keys | Scope | Notes |
|---|---|---|---|
| TOC Enable | `toc_enabled` | Item scalar | radio ON/OFF |
| Replenishment Mode | `replenishment_mode` | Item scalars (`custom_toc_auto_purchase`, `custom_toc_auto_manufacture`) | radio |
| ADU Period | `adu_period` | Item scalar | select |
| Custom ADU | `custom_adu` | Item scalars | number; blank → auto |
| BOM Check | `check_bom_availability` | Item scalar | radio |
| **Min Mfg — Auto ADU (IMM-003)** | `minmfg_auto_adu` | Every child row of `custom_minimum_manufacture` | radio ON/OFF — flips `auto_adu` on EVERY existing warehouse row of each selected Item. Items without rows are silently skipped. |
| **Min Mfg — Lead Time (IMM-003)** | `minmfg_lead_time_days` | Every child row | Int — uniform write across rows. Engine uses this in `max_level = ADU × lead × safety`. |
| **Min Mfg — Safety Factor (IMM-003)** | `minmfg_safety_factor` | Every child row | Float — defaults to 1.0 when blank. |

The three IMM-003 fields go through `_bulk_set_minmfg_field(item, fieldname, value)` — a single `UPDATE tabItem Minimum Manufacture SET <field> = %s WHERE parent = %s AND parentfield = 'custom_minimum_manufacture'` per item. Deliberately excluded from bulk: `adu` (engine-owned or row-specific), `min_manufacturing_qty` (warehouse-specific batch sizing).

### 4. ⚡ Auto-Enable TOC (Bulk Auto-Configure) — added 2026-04-29

Select 1+ rows → **"⚡ Auto-Enable TOC"** button (yellow) → calls `bulk_auto_configure_toc`.

**Per-item logic:**
1. **Mode detection** (first match wins):
   - Active default BOM (docstatus=1, is_active=1, is_default=1) → **Manufacture**
   - `is_purchase_item=1` AND NOT `is_manufacture_item=1` → **Purchase**
   - Latest SLE `voucher_type`: Purchase Receipt/Invoice → **Purchase**; Work Order/Manufacturing → **Manufacture**
   - Flag fallback / no signals → **Monitor**
2. **Selling price**: latest submitted Quotation rate → SO with 0% discount → `standard_rate`
3. **Sets**: `toc_enabled=1`, `auto_purchase`/`auto_manufacture`, `selling_price`
4. **Buffer rules** (ONLY if item has zero existing rules):
   - Warehouses from `tabBin` where `actual_qty > 0` (top 5)
   - Fallback: first enabled non-group warehouse
   - RLT default: 14d (Purchase) / 7d (Manufacture); VF = 1.5; DAF = 1.0
5. **Saves** via `doc.save()` — `on_item_validate` fires (mutual exclusion, T/CU recompute)

**Result dialog** shows per-item: mode badge, detection reason, detected price, rules created count. Failed items show error reason (non-blocking — batch continues).

**Safety**: existing buffer rules are NEVER overwritten. Users should review RLT/VF via the individual Settings modal after auto-configure.

---

## Python API

| Method | Auth | Notes |
|--------|------|-------|
| `get_items_for_bulk_settings` | Any | Paginated grid listing |
| `get_item_toc_details` | Any | Full TOC fields + buffer_rules for modal |
| `save_item_toc_settings` | TOC Manager | Single-item save via doc.save() |
| `get_warehouses` | Any | Non-group, enabled warehouses for datalist |
| `auto_detect_toc_settings` | Any | READ-ONLY single-item mode+price detection |
| `bulk_save_toc_settings` | TOC Manager | Bulk scalar set_value (fast, no validation) |
| `bulk_auto_configure_toc` | TOC Manager | **WRITES** auto-detect+enable+rules per item |

---

## JS `TOCItemSettings` — Key Methods

| Method | Description |
|--------|-------------|
| `_esc(s)` | Inline HTML escape (no `frappe.dom.escape` dependency) |
| `_renderGrid(items)` | Build tbody rows; uses `&quot;` for onclick string args |
| `openModal(code)` | Load details, populate 5 tabs, switch to Setup tab |
| `saveModal()` | Collect form data → `save_item_toc_settings` |
| `autoDetectSettings()` | Single-item read-only suggest → sets DOM only (no save) |
| `bulkAutoEnable()` | Multi-item WRITE → `bulk_auto_configure_toc`, shows result table |
| `_showAutoEnableResults(res)` | Render per-item result in `frappe.msgprint` |
| `selectRow(code, checked)` | Maintain `selectedItems` Set |
| `saveBulk()` | Collect apply-checked fields → `bulk_save_toc_settings` |

---

## DANGER ZONE

| Risk | Detail |
|------|--------|
| **`frappe.dom.escape` unreliable** | Not guaranteed across Frappe versions. `_esc()` uses inline entity-replacement. DO NOT revert. |
| **`&quot;` in onclick in HTML template** | HTML template is Frappe-JS-cached in single-quoted string. Raw `'` in attribute values → `SyntaxError`. Always use `&quot;` in `.html` file onclick args. |
| **Clear-and-replace on buffer_rules** | `save_item_toc_settings` does `item.set("custom_toc_buffer_rules", [])`. Incomplete JS row list → permanent data loss. All rows must be sent. |
| **`bulk_auto_configure_toc` doc.save()** | Slow (~1-2s per item). JS warns user before proceeding if >50 items selected. |
| **Never overwrite existing rules** | `bulk_auto_configure_toc` skips rule creation if item already has rules. This must NOT be changed. |

## RESTRICT

- Do NOT skip `on_item_validate` in `save_item_toc_settings`.
- Do NOT remove `frappe.only_for()` guards from any write method.
- Do NOT overwrite existing buffer rules in `bulk_auto_configure_toc`.
- Do NOT replace inline `_esc()` with `frappe.dom.escape`.
- Do NOT add raw single quotes to attribute values in `toc_item_settings.html`.

---

## Sync Block — 2026-04-30

**Modified**: `toc_item_settings.js`
- Removed Default BOM (`f-default-bom`) input from `_buildBomTab()` — BOM is auto-detected by TOC engine
- Removed `default_bom` from `saveModal()` data collection
- Replaced HTML5 `<datalist>` + `<input list="tis-wh-datalist">` with native `<select>` in `_buildRuleRow()` — warehouse select populated from `this.warehouses`; preserves saved warehouse even if not in current list
- Expanded `HELP_CONTENT` with full names, rich explanations, real-world examples for all fields: toc_enabled, auto_purchase, auto_manufacture, custom_adu, adu_period, adu_value, selling_price, tvc, constraint_speed, check_bom_availability, rlt, vf, daf
- Updated `showHelp()` to render new `example` field in a green callout box
- Improved `_buildEnableTab()`: card-style replenishment mode selectors with descriptions, ⚡ button tooltip
- Improved `_buildAduTab()`: full name "ADU — Average Daily Usage", formula subtitle, UOM in label, tooltips, helper text
- Improved `_buildTcuTab()`: full labels "TVC — Truly Variable Cost", "Constraint Speed (units/min)", formula explainer box, helper text
- Improved `_buildBomTab()`: removed Default BOM input, added info callout "BOM is detected automatically by the TOC engine"
- Updated `_buildRulesTab()`: removed `<datalist>`, full column headers with abbreviation + full name + ⓘ help buttons (RLT, VF, DAF)
- Updated `_buildRuleRow()`: `title` tooltips on all inputs, `<select>` for warehouse with fallback for saved-but-disabled warehouses

**Modified**: `toc_item_settings.py`
- Removed `item.custom_toc_default_bom = toc_data.get("default_bom") or None` from `save_item_toc_settings` — page no longer writes to this field; the Item Master retains whatever BOM was set there

**Modified**: `toc_item_settings.html`
- Added `.tis-rule-input` CSS class definition (border, padding, focus ring, readonly state, select cursor)
- Added `.tis-rules-wrap { overflow-x: auto }` for responsive buffer rules table

---

## Sync Block — 2026-04-29

**Modified**: `toc_item_settings.js`
- Fixed `_esc()`: inline HTML entity replace (removed `frappe.dom.escape`)
- Fixed `_renderGrid()`: uses `&quot;` pattern for onclick string args (was `\\'`)
- Fixed `selectRow()`: removed backslash-unescape; uses `_esc()` for data-code selector
- Added `bulkAutoEnable()`: calls `bulk_auto_configure_toc`, warns on >50 items
- Added `_showAutoEnableResults(res)`: mode badges + reason + price + rules count table

**Modified**: `toc_item_settings.py`
- Added `bulk_auto_configure_toc(item_codes)`:
  - Mode: BOM → is_purchase_item → SLE voucher_type → fallback
  - Price: Quotation → SO (0% discount) → standard_rate
  - Sets toc_enabled=1, mode flags, selling_price
  - Auto-creates buffer rules from Bin (top 5 by qty) if none exist
  - Default RLT: 14d/7d; VF=1.5; saves via doc.save()
  - Per-item try/except; failures logged, batch continues
  - Returns `{success, results[], updated, total}`

**Modified**: `toc_item_settings.html`
- Added "⚡ Auto-Enable TOC" yellow accent button to bulk action bar
- Added `.tis-btn-bulk-accent`, `.tis-ae-table`, `.tis-ae-mode-*` styles

**Sync Block — 2026-04-28** (previous session)
- Added `auto_detect_toc_settings` (single-item read-only), `get_warehouses` Python APIs
- Added `autoDetectSettings()` JS method, warehouse `<datalist>`, stock_uom display in buffer rules

**Sync Block — 2026-04-27** (previous session)
- Multi-select bulk configure, Bulk Configure modal, `bulk_save_toc_settings` Python
- Removed FG/SFG/RM/PM buffer type — replenishment mode from auto flags only
