# TOC User Guide — Developer Documentation

## Purpose
The `toc-user-guide` is a comprehensive, whitelisted page providing end-users and administrators with a centralized reference for the Chaizup TOC application. It covers formulas, schedules, configurations, and troubleshooting steps.

## Technical Implementation
- **Template**: `toc_user_guide.html` contains the markup and embedded CSS (standardized to Frappe Desk variables).
- **Controller**: `toc_user_guide.js` handles navigation logic, smooth scrolling, and mobile sidebar toggling.
- **Route**: Whitelisted at `/app/toc-user-guide`.

## UI Structure
### 1. Responsive Sidebar
- Collapsible navigation on mobile (<= 992px) with a dedicated toggle button.
- Smooth scrolling and active-section tracking via `IntersectionObserver`.

### 2. Decision Support (Where to Start?)
- Use-case cards to guide different user roles (Setup, Procurement, Production).
- Formula decision tree explaining when each TOC rule (F1-F8) applies.

### 3. Interactive Calculators
- Inline JS calculators for Target Buffer (F1), Inventory Position (F2), and Buffer Penetration (F3) to help users validate their configurations.

## Maintenance Guidelines
- **HTML Safety**: All event handlers in `toc_user_guide.html` must use `&quot;` for string arguments to avoid breaking the Frappe single-quoted template cache.
- **No raw apostrophes anywhere in the file body** (POR-023 / 2026-05-13). `frappe.build.scrub_html_template` strips only HTML `<!-- -->` comments — apostrophes in `<style>` CSS or markup terminate the wrap string and blank the page. Use `&apos;`, or rephrase contractions ("does not" / "did not") and possessives ("the X used by Y" instead of "Y&apos;s X").
- **Section IDs**: IDs `s00` through `s13` are hardcoded in the navigation logic; do not rename them without updating the `toc_user_guide.js` `tugScrollTo` mapping.

## Sync Block — 2026-04-27
- **UI Refactor**: Transitioned to native Frappe CSS variables and layout patterns.
- **Responsiveness**: Fixed mobile sidebar and viewport scaling.
- **Navigation Fix**: Resolved issues with section jumping and active state synchronization.
- **Ecosystem Integration**: Documented the connection between the User Guide and the modernized `toc-item-settings` page (Bulk Configuration Dashboard).

## Sync Block — 2026-05-13 (POR-023 follow-on)
- **Page-blank fix**: Removed 10 raw apostrophes from the HTML body that were terminating the wrap string `frappe.templates["toc_user_guide"] = '...'` at byte 47339 of an 85565-byte body — every byte after the first stray apostrophe was being parsed as JS, throwing SyntaxError and rendering the page blank. Wrap now closes cleanly; body length 85565 matches the HTML.
- **Same root cause as Production Overview POR-023.** `frappe/build.py:424` reads `content.replace("'", "'")` (a no-op — the escape backslash was lost long ago), and `HTML_COMMENT_PATTERN` strips only `<!-- -->` comments. So every raw apostrophe in `<style>` CSS, `<style>` CSS comments, and markup ends up wrapped verbatim and breaks the JS string literal.
- **Edits made**: rephrased possessives ("Calc A&apos;s" → "the Calc A", "ERPNext&apos;s" → "the ERPNext", etc.), replaced one possessive with `&apos;` (`item&apos;s`), and replaced "didn&apos;t" with "did not".
- **New maintenance rule**: zero raw apostrophes anywhere in `toc_user_guide.html` outside HTML `<!-- -->` comments. Same lint as Production Overview; see that page&apos;s `production_overview.md` POR-023 section for the one-liner check.

## Sync Block — 2026-05-17 (boundary note, no code change)
- For clarity to future maintainers: a separate, unrelated app named `stock_reconciliation_tracking` was added to this bench on 2026-05-17. It is **not connected to chaizup_toc** in any way — no shared DocTypes, no shared hooks, no shared fields, no cross-reads, no cross-writes. The two apps share only the same bench and the same ERPNext core.
- **No edits made to this page or to chaizup_toc** as part of that work. This sync-block entry exists only to prevent a future maintainer from assuming integration where none exists.

## Sync Block — 2026-05-18 (Item Projection View — new page)
- New Frappe Desk Page **`/app/item-projection-view`** — "Item Projection View" — added under the Chaizup Toc module. Lives next to `/app/item-shortage-dashboard`; complementary lens, not a replacement.
- **Per item × warehouse columns**: Stock (Stock UOM + Higher UOM) · Shortage — Physical · Shortage — Projected · WO Remaining Production · PO Remaining · Will Consume (open WOs) · Will Dispatch (pending SOs) · Net Available · Days of Cover.
- **Higher UOM** is auto-picked per item as the row in `tabUOM Conversion Detail` with the **largest** conversion factor (fallback = stock UOM).
- **Shortage targets**: demand = WO consumption + SO dispatch. Physical = max(0, demand − stock); Projected = max(0, demand − (stock + PO + WO production)).
- **Tooltip-on-every-number**: server-side `_tooltips` payload (dict keyed by fieldname → list of lines) renders on hover with the back-end formula + the actual component values for that cell.
- **Drill-down**: click any of 6 numeric columns → `frappe.ui.Dialog` with per-voucher rows hyperlinked to WO / PO / SO / Bin desk forms.
- **Highlights**: full-row red for negative stock, pale-red for physical-shortage rows, pale-amber for projected-shortage rows. Cell-level red for `Days of Cover < 7` and `Net Available < 0`.
- **Group-by Item Group (tree view, default ON, collapsed first paint)**: synthetic group-header rows show summed numerics; mixed-Higher-UOM groups are flagged in the tooltip.
- **Export**: branded multi-sheet XLSX (Cover + Items + Shortage Drivers + Pending WO Production + Pending WO Consumption + Pending PO + Pending SO + UOM Ladder).
- **Pending statuses** read from TOC Settings via `wo_kitting_api.get_toc_pending_filters()` — single source of truth (TS-001).
- **Restricted**: do NOT inline pending-status definitions; do NOT change the Higher UOM picker without updating the drill-down (which assumes one CF per item); do NOT switch the tooltip payload to HTML (the JS escapes lines as text); do NOT reorder the page columns without updating the XLSX writer (the writer reads `columns` from compute and matches by fieldname).

## Sync Block — 2026-05-18 (Item Projection View — polish pass)
Four fixes after the first user run:
- **Loading overlay never hid** — `_refresh()` `.finally()` on a jQuery Deferred didn't fire if the inner render threw. Switched to `.always()` + `try/catch` + `setTimeout(hide, 12000)` worst-case fallback.
- **Filter text wrap** — Company `<select>` got `text-overflow: ellipsis` + `title` attr on element AND each option (native hover reveals full name). Company column widened from `1fr` to `1.4fr`. Chip pills (item / item-group / warehouse) now use `white-space: normal` + `word-break: break-word` + `max-width: 100%` so long item names wrap inside the pill.
- **Tooltip not firing** — Per-cell mouseenter / mousemove listeners inside the formatter got wiped by Tabulator's row pooling. Replaced with **event delegation** on `#ipv-grid` using `closest("[data-ipv-tt-key]")`; payload travels on the span via `data-ipv-tt-data`. Survives every Tabulator re-render.
- **Professional font** — Dropped Fraunces variable serif (too editorial for a planning tool). Switched to **Inter Variable** for body+title+KPIs and **IBM Plex Mono** for numerics. Title simplified to a single `<h1>` Inter 700; KPI values 1.7 rem Inter 700 with tabular-nums.
- **Restricted (new)**: don't revert the delegation pattern (per-cell listeners don't survive Tabulator v6 row pooling); don't revert `.always()` to `.finally()` only (frappe.call returns jQuery Deferred); don't reintroduce serif display fonts on the hero/KPIs (Inter/Plex is the brand); don't remove the option-level `title` attribute on the company select.

### Follow-on (same day) — two more fixes
- **Table not populating** — `dataTreeStartExpanded: false` made the grid show only group headers on first paint, which looked empty when one header summarized 866 hidden items. `layout: "fitDataStretch"` also pushed columns past the viewport. Fixes: `dataTreeStartExpanded: true`; `layout: "fitDataFill"` so columns fill visible area; added a `console.info` diagnostic per render.
- **Weird checkbox UI** — Replaced native checkbox + `accent-color` with a CSS-only iOS-style toggle switch (38×22 px pill, 18 px thumb animated via `transform`, brand-soft focus ring). Same markup (`<input type="checkbox">` + label), purely CSS-driven.

### BOM List View — fix "is_default missing" via per-user cache wipe (2026-05-19, follow-up)
- User reported "Is Default ?" column was missing after the 7-col fixture went live. The fixture, `in_list_view` Property Setters, and runtime meta all confirmed `is_default` was correctly `in_list_view=1`.
- **Root cause**: Frappe stores **per-user List View column state** in the `__UserSettings` (special non-`tab` prefixed) table. When a user has previously viewed the BOM list, their browser session caches whatever `List View Settings.fields` was active at that time — subsequent fixture-side changes don't invalidate that per-user cache. The `is_default` field never made it into the cached layout for users who'd opened the list before.
- **Fix**: wiped all per-user BOM caches:
  ```sql
  DELETE FROM `__UserSettings` WHERE doctype = 'BOM';
  ```
- Plus `frappe.clear_cache(doctype="BOM")` + `bench clear-website-cache` to force fresh boot data on next page load.
- **What happens next**: when each user reopens `/app/bom`, Frappe fetches the fresh `frappe.boot.listview_settings["BOM"]` payload (now including `is_default`) and writes a new `__UserSettings` row from it.
- **Restricted**: don't rely on `bench migrate` to invalidate per-user List View caches. After publishing a new `List View Settings.fields` JSON, always run `DELETE FROM __UserSettings WHERE doctype='<DocType>'` to force every user to re-fetch on next view. Frappe v15 does NOT auto-invalidate per-user List View settings on app-level updates.

### BOM List View — 7-column spec (2026-05-19)
- New fixture-driven BOM list view:
  ```
  1. ID                     name
  2. Status                 (auto Status indicator)
  3. Item To Manufacture    item
  4. Created On             custom_created_time   (mirror of `creation`)
  5. Created By             custom_created_by     (mirror of `owner`)
  6. Is Active ?            is_active
  7. Is Default ?           is_default
  ```
- Two new BOM Custom Fields shipped via fixtures (same pattern as WO):
  - `BOM.custom_created_time` (Datetime, read-only, in_list_view=1)
  - `BOM.custom_created_by` (Link → User, read-only, in_list_view=1)
- BOM validate hook (`stamp_uom_fields_on_bom_validate`) extended to copy `doc.creation → custom_created_time` and `doc.owner → custom_created_by` on every save.
- Property Setters added: `BOM.is_active.in_list_view = 1`, `BOM.is_default.in_list_view = 1`, `BOM.item.in_list_view = 1` (some defaulted to 0 in the runtime meta).
- `chaizup_toc/setup/install.py:backfill_toc_uom_on_existing_records` extended to back-fill `custom_created_time` + `custom_created_by` on BOMs in addition to the UOM trio. Idempotent.
- **Restricted**: don't drop the BOM mirror fields or the validate-hook copies — system fields can't render as List View columns; these are the bridge.

### TOC UOM back-fill on install + migrate (2026-05-19)
- **What**: when a user runs `bench install-app chaizup_toc` on a site with existing Work Orders, Production Plans, or BOMs, the new TOC custom UOM fields auto-populate on every old record. Also runs on every `bench migrate` so legacy chaizup_toc sites get back-filled the first time they pull these changes.
- **Function**: `chaizup_toc.setup.install.backfill_toc_uom_on_existing_records()`.
- **Wired in `hooks.py`**:
  ```py
  after_install = "chaizup_toc.setup.install.after_install"   # already wired
  after_migrate = "chaizup_toc.setup.install.after_migrate"   # NEW 2026-05-19
  ```
- **What's back-filled** (per row):
  - `custom_uom` ← item's largest-CF non-stock UOM
  - `custom_uom_conversion_factor` ← that CF
  - `custom_qty_in_uom` ← standard_qty / CF
  - Work Order also: `custom_produced_qty_in_uom`, `custom_created_time`, `custom_created_by`
  - Production Plan Sub Assembly Item also: `custom_required_qty_in_uom`, `custom_projected_qty_in_uom`, `custom_qty_to_order_in_uom`
- **NOT back-filled (per user spec)**: `custom_mrp` on any DocType. MRP is a per-item commercial decision; user populates `Item.custom_mrp` manually, and the existing Auto-from-Item handler propagates from there.
- **Idempotent**: skips rows where `custom_uom IS NULL OR custom_uom = ''`. Re-runs are no-ops. Single batched UOM-ladder query.
- **Performance**: direct SQL `UPDATE` per row (no `doc.save()`) — avoids the validate hook + buffer_calculator triggers that would slow back-fill and create spurious MRs. The fields stay in sync with the standard qty via the validate hooks on subsequent saves.
- **Live verified (2026-05-19, dev replica)**: first run back-filled 250 WO + 66 PP Item + 63 Sub Assembly + 637 BOM rows. MRP sentinel value (999.99) on test WO was preserved. Second run reported 0 rows (idempotent).
- **Restricted**:
  - Don't remove the `IS NULL OR = ''` guard on the UPDATE WHERE clause — would overwrite user picks on every migrate.
  - Don't include `custom_mrp` in the UPDATE list — user spec explicitly excludes it.
  - Don't switch to `doc.save()` per row — too slow on large sites + would fire `buffer_calculator.on_supply_change` thousands of times.

### Work Order Status pill — `status` missing from add_fields (2026-05-20)
- **Final root cause** for "Status column not appearing": `public/js/work_order_list_extras.js` was overwriting ERPNext's `frappe.listview_settings["Work Order"].add_fields` with only `["creation", "owner"]`. This dropped `status` from the DB fetch.
- ERPNext's `get_indicator` callback (in `erpnext/manufacturing/doctype/work_order/work_order_list.js`) does:
  ```js
  get_indicator: function(doc) {
      return [__(doc.status), colour_map[doc.status], "status,=," + doc.status];
  }
  ```
  Without `status` in add_fields (or in_list_view), `doc.status` was `undefined` → indicator pill rendered empty → Status column appeared blank.
- **Fix**: `add_fields: ["status", "creation", "owner"]`. `status` is needed for the indicator, `creation`/`owner` for the Report View defaults.
- Note: we deliberately do NOT set `status.in_list_view = 1` — the Status pill IS the status column, and having two columns showing the same value would be redundant. The add_fields approach pulls the field into the DB result without rendering it as a separate column.
- **Restricted**: don't strip `status` from `add_fields`. The indicator pill stops working. Always include any field referenced by `get_indicator`'s callback.

### Work Order List View — Status missing fix (2026-05-19, follow-up)
- User reported Status column still didn't appear after the Status→col 3 reorder.
- **Root cause**: ERPNext ships `Work Order.title_field = "production_item"`. When `title_field` is set, Frappe excludes the title field from `meta.fields` pool AND uses it as the Subject column. So the spec entries `name` (col 1) and `production_item` (col 2) both matched NOTHING in the column pool — the Subject column was rendering `production_item`, but no separate "Item To Manufacture" column existed for the spec to match. Status's auto-injected column was visually present but unrecognised by the spec because the position didn't align.
- **Fix**: Property Setter `Work Order-main-title_field = ""` clears the title_field at runtime so:
  - Subject column renders as `{label: "ID", fieldname: "name"}`
  - `production_item` enters the regular field pool
  - Spec[1] `production_item` matches the Field column
  - Spec[2] `status_field` matches the Status indicator
- **Per-user cache wipe** also re-applied (`DELETE FROM __UserSettings WHERE doctype = 'Work Order'`).
- **Live-traced** column order confirms: ID → Item To Manufacture → **Status** → MRP → UOM trio → Production Plan.
- **Restricted**: don't delete this PS — would re-enable ERPNext's title_field=production_item default on next migrate; the Subject column would revert to showing production_item and break the spec match.

### Work Order List View — Status to col 3 + drop image thumbnail (2026-05-19)
- User: move Status from col 2 to col 3; remove the image thumbnail column.
- **Status reorder**: simple swap in `List View Settings.Work Order.fields` — Status entry moved from index 1 to index 2 (after `production_item`).
- **Image column removal**: Frappe injects an image thumbnail column whenever the DocType has `image_field` set. ERPNext's Work Order ships with `image_field = "image"`. Added Property Setter `Work Order-main-image_field = ""` (empty Data) which clears `meta.image_field` at runtime → thumbnail column disappears.
- **Per-user cache invalidation** (same lesson as BOM): `DELETE FROM __UserSettings WHERE doctype = 'Work Order'`. Without this, users who'd previously viewed the WO list keep seeing the old layout.
- Persisted: Property Setter in `fixtures/property_setter.json`, List View Settings in `fixtures/list_view_settings.json`.
- Final 8 columns: ID · Item To Manufacture · Status · MRP · Qty In UOM [TOC] · UOM [TOC] · Manufactured Qty in UOM [TOC] · Production Plan ID.
- **Restricted**: don't restore `image_field`. The DocType ships with it for the form image upload; clearing the Property Setter value is enough to suppress the list-view thumbnail without breaking the form. If you ever delete the PS row entirely (rather than clearing the value), the ERPNext default re-applies on next sync.

### Work Order List View — hide built-in qty fields (2026-05-19, latest)
- User: "Remove from work order list view: Qty to Manufactured (Built in field), Manufactured Qty (Built in field)".
- Flipped both Property Setters from `1` → `0`:
  - `Work Order-qty-in_list_view = 0`
  - `Work Order-produced_qty-in_list_view = 0`
- Runtime verified — both built-in qty fields now report `in_list_view = 0`, so they're hidden from the list view AND from the "Edit List Settings" column picker. The TOC mirrors (`custom_qty_in_uom`, `custom_produced_qty_in_uom`) handle the same use case in TOC UOM terms.
- Persisted in `chaizup_toc/fixtures/property_setter.json`.
- **Restricted**: don't re-enable `qty.in_list_view` or `produced_qty.in_list_view`. The user explicitly chose to hide them so the TOC mirrors are the single source of truth in the list view. If they're ever needed for a one-off Report View, the underlying DocFields are unchanged — only the in_list_view flag is off.

### Work Order List View — 8-column TOC-only spec (2026-05-19, latest)
- User trimmed further to 8 columns; dropped `stock_uom` (Stock UOM) and `qty` (Qty to Manufactured). Final order:
  ```
  1. ID                                  name
  2. Status                              (auto Status indicator)
  3. Item To Manufacture                 production_item
  4. MRP                                 custom_mrp
  5. Qty In UOM [TOC]                    custom_qty_in_uom
  6. UOM [TOC]                           custom_uom
  7. Manufactured Qty in UOM [TOC]       custom_produced_qty_in_uom
  8. Production Plan ID                  production_plan
  ```
- Only the `List View Settings.fields` JSON changes — underlying `in_list_view=1` Property Setters on `stock_uom` and `qty` are left in place so users can still pick them via the column-picker dialog or use them in Report View.
- Fixture: `chaizup_toc/fixtures/list_view_settings.json` Work Order entry updated to 8 cols.
- **Restricted**: don't drop the leftover `in_list_view=1` Property Setters on the removed fields — they keep the fields discoverable in Frappe's "Edit List Settings" picker without re-running setup.

### Work Order List View — 10-column compact spec (2026-05-19, latest)
- User trimmed the 14-column layout to 10 columns + added MRP. New order:
  ```
   1. ID                                     name           (subject — Frappe default)
   2. Status                                 (auto Status indicator)
   3. Item To Manufacture                    production_item
   4. MRP                                    custom_mrp     ← NEW in list view
   5. Qty In UOM [TOC]                       custom_qty_in_uom
   6. UOM [TOC]                              custom_uom
   7. Manufactured Qty in UOM [TOC]          custom_produced_qty_in_uom
   8. Production Plan ID                     production_plan
   9. Stock UOM                              stock_uom
  10. Qty to Manufactured                    qty
  ```
- Dropped columns (kept in `meta` but no longer in List View Settings JSON): Item Name, Manufactured Qty (produced_qty), Recorded By, Created Time, Created By. The underlying fields + Property Setters are preserved — only their entries in `List View Settings.fields` are removed.
- `custom_mrp` flipped `in_list_view = 1` + `columns = 2`. Was 0 previously.
- Persisted in `chaizup_toc/fixtures/list_view_settings.json`. Fresh installs ship the new layout.
- **Restricted**: don't reorder — MRP intentionally sits between the standard `production_item` and the TOC UOM trio so users see price right next to item identity. Don't strip the mirror fields (`custom_created_time`, `custom_created_by`) from `tabCustom Field` even though they're no longer in the list — they're still useful for Report View and ad-hoc queries.

### Work Order List View — full 14-column render (2026-05-19, final)
- **Root cause** (continued): Frappe's standard List View only renders columns from `meta.fields`. System fields like `creation` and `owner` are NOT in `meta.fields` — they're in `frappe.model.std_fields_list`, separately. So they could never render via the standard `List View Settings.fields` pool.
- **Fix**: added two Custom Fields that **mirror** the system fields:
  - `Work Order.custom_created_time` (Datetime, read-only, in_list_view=1) — mirrors `creation`
  - `Work Order.custom_created_by` (Link → User, read-only, in_list_view=1) — mirrors `owner`
- **Validate hook** (`stamp_uom_fields_on_wo_validate`) now also copies `doc.creation → doc.custom_created_time` and `doc.owner → doc.custom_created_by` so the mirrors stay in sync on every save.
- **Back-fill** ran for all existing WOs so legacy rows show values immediately.
- **List View Settings** updated: replaced `creation` / `owner` entries with `custom_created_time` / `custom_created_by`. Labels still "Created Time" / "Created By" — same user-facing experience.
- **`title_field` left empty (default)**: an earlier attempt to set `title_field = "name"` triggered a Frappe validator "Title field must be a valid fieldname" because `name` isn't in `meta.fields`. Reverted. With empty `title_field`, Frappe falls back to subject column = `{fieldname: "name", label: "ID"}` (column 1). The spec's column 1 label "Work Order ID" is the de-facto identifier even though the rendered label reads "ID".
- **Final runtime state** — all 12 user-driven fields have `in_list_view=1`:
  ```
  production_item              ✓  Item To Manufacture
  item_name                    ✓  Item Name
  custom_qty_in_uom            ✓  Qty in UOM [TOC]
  custom_uom                   ✓  UOM [TOC]
  custom_produced_qty_in_uom   ✓  Manufactured Qty in UOM [TOC]
  production_plan              ✓  Production Plan
  stock_uom                    ✓  Stock UOM
  qty                          ✓  Qty To Manufacture
  produced_qty                 ✓  Manufactured Qty
  custom_toc_recorded_by       ✓  Recorded By [TOC App]
  custom_created_time          ✓  Created Time
  custom_created_by            ✓  Created By
  ```
- **Restricted**:
  - Don't set `title_field` to a fieldname not in `meta.fields` — Frappe's DocType validator throws on save.
  - Don't drop the `custom_created_time` / `custom_created_by` mirror fields — system fields can't appear as standard List View columns.
  - Don't remove the validate-hook copies — without them the mirrors stay frozen at their last save value.

### Work Order List View — fix missing columns (2026-05-19, follow-up)
- **Root cause of "columns not matched"**: Frappe's `list_view.js` `reorder_listview_fields()` iterates `List View Settings.fields` BUT only renders columns whose underlying DocField/CustomField has `in_list_view = 1`. The 14 entries in our `List View Settings` were correct, but the standard fields (`production_item`, `item_name`, `production_plan`, `stock_uom`, `qty`, `produced_qty`) ship from ERPNext with `in_list_view = 0`, so Frappe silently skipped them.
- **Fix**: Added 6 new Property Setters with `in_list_view = 1` for the standard fields, plus flipped `in_list_view = 1` on `custom_produced_qty_in_uom`. All carry `module='Chaizup Toc'` so they're picked up by the fixtures filter.
- **Runtime verified**: every spec field now shows `in_list_view = 1` via `frappe.get_meta("Work Order")`.
- **Restricted**: don't drop the `in_list_view` Property Setters — they're load-bearing. Removing any breaks the corresponding column. The List View Settings JSON alone is NOT sufficient; the field-level flag is the gating condition.

### Work Order List View — 14-column TOC layout (2026-05-19)
- `List View Settings` for "Work Order" updated to a 14-column layout (exact order):
  1. Work Order ID (`name`)
  2. Work Order Status (`status_field`, type=Status — Frappe renders the coloured indicator)
  3. Item Code (`production_item`)
  4. Item Name (`item_name`)
  5. **Qty in UOM [TOC]** (`custom_qty_in_uom`)
  6. **UOM [TOC]** (`custom_uom`)
  7. **Manufactured Qty in UOM [TOC]** (`custom_produced_qty_in_uom`)
  8. Production Plan ID (`production_plan`)
  9. Stock UOM (`stock_uom`)
  10. Qty To Manufacture (`qty`)
  11. Manufactured Qty (`produced_qty`)
  12. Recorded By (`custom_toc_recorded_by`)
  13. Created Time (`creation`)
  14. Created By (`owner`)
- Persisted in `chaizup_toc/fixtures/list_view_settings.json` — fresh installs ship the layout automatically.
- The TOC fields are positioned **before** the standard Stock UOM / Qty / Manufactured Qty so users see the TOC view first; the standard columns sit alongside for cross-reference.
- **Restricted**: don't reorder columns — the TOC trio (5-7) is the user-facing primary view; the standard ERPNext qty fields (9-11) are kept side-by-side for verification but mustn't be moved before the TOC group. Don't drop `status_field` type=Status — it's the only way to keep the coloured status indicator.

### Produced Qty mirror — Work Order + PP Item (2026-05-19, follow-up)
- Two new Custom Fields:
  - `Work Order.custom_produced_qty_in_uom` — label **"Manufactured Qty in UOM [TOC]"**, read-only, mirrors `produced_qty / CF`.
  - `Production Plan Item.custom_produced_qty_in_uom` — label **"Produced Qty in UOM [TOC]"**, read-only, in_list_view=1.
- Both ship via fixtures so fresh installs get them automatically.
- **Three sync paths**:
  1. `Work Order.validate` hook (`stamp_uom_fields_on_wo_validate`) — now passes `extra_mirrors=[("produced_qty", "custom_produced_qty_in_uom")]` to `_sync_uom_on_single_doc`. Mirror recomputed on every save.
  2. `Production Plan.validate` hook (`_stamp_uom_fields_on_pp`) — adds `r.custom_produced_qty_in_uom = produced_qty / CF` per po_items row.
  3. **NEW** `Stock Entry.on_submit` / `on_cancel` hook (`on_stock_entry_submit_refresh_produced`) — catches the **production entry** path where ERPNext writes `produced_qty` via direct `frappe.db.set_value` inside `WorkOrder.update_status`, bypassing validate. Hook reads the WO's stored CF and re-stamps both the WO and its parent PP Item rows.
- **Live verified** (2026-05-19, WO `CZPRD/14994`):
  ```
  produced_qty=24000  custom_uom='Kg'  CF=1000
  custom_produced_qty_in_uom = 24.0  ✓  (24000 / 1000)
  ```
- **Restricted**:
  - Don't remove the Stock Entry hook — ERPNext writes `produced_qty` outside the validate path on Manufacture-purpose Stock Entries; without this hook the mirror lags behind reality after every production entry.
  - The Stock Entry hook only triggers refresh for Manufacture / "Material Transfer for Manufacture" purposes. Don't widen to all Stock Entries — Material Issue / Receipt / Transfer entries don't touch `produced_qty` and would just add noise.
  - `custom_produced_qty_in_uom` is read-only at the Custom Field level. Don't make it editable; it would drift from `produced_qty / CF` and break the bidirectional invariant.

### Bidirectional UOM sync (2026-05-19)
- Every TOC custom UOM trio (`custom_uom`, `custom_uom_conversion_factor`, `custom_qty_in_uom`) now syncs **both directions** with its standard ERPNext qty field:
  - **Forward** (custom → standard): user types `custom_qty_in_uom` → JS multiplies by CF → writes `qty` / `planned_qty` / `quantity` / `required_qty`.
  - **Reverse** (standard → custom): something writes the standard qty → JS reverse-fill handler **and** server-side `validate` hook recompute `custom_qty_in_uom = std_qty / CF`.
- **Server-side validate hooks**:
  - `Production Plan.validate` → `stamp_uom_fields_on_pp_validate` (existing — covers po_items + sub_assembly_items)
  - `Work Order.validate` → `stamp_uom_fields_on_wo_validate` (NEW)
  - `BOM.validate` → `stamp_uom_fields_on_bom_validate` (NEW)
- **JS reverse-fill handlers**:
  - Work Order: `qty(frm)` → `_ipv_wo_back_fill_qiu`
  - Production Plan Item: `planned_qty(frm,cdt,cdn)` (NEW handler)
  - Production Plan Sub Assembly Item: already had `_ipv_sub_back_fill` for required_qty / qty / projected_qty
  - BOM: `quantity(frm)` → `_ipv_bom_back_fill_qiu`
- **Idempotent + user-safe**: if `custom_uom` is set the user's pick is preserved (just look up CF). If blank, auto-pick item's largest-CF non-stock UOM.
- **What it covers**:
  - User typed value (admin lifts the read-only lock)
  - Programmatic writes (BOM explosion, scheduler back-fills, ERPNext "Get Sub-Assemblies" + "Get Raw Materials" flows)
  - JS-bypass paths (form save when JS controller failed to load)
- **Live verified** (2026-05-19):
  - WO `MFG-WO-2026-00251` qty=600 + blank UOM → `Kg`, CF=1000, qiu=0.6. User-set `Pcs` → preserved, qiu=600.
  - BOM `BOM-CZ/ITEM-00030-002` qty=1000 + blank UOM → `CFC / Master`, CF=12, qiu=83.33.
- **Restricted**: don't drop any validate hook — server-side sync is the only thing catching programmatic writes that bypass the JS layer. Don't make the helpers non-idempotent — would clobber user-picked custom_uom.

### Grid column widths matched to label length (2026-05-19)
- Every `in_list_view=1` Custom Field carrying `module='Chaizup Toc'` now has its `columns` (Frappe grid width unit, 1..11 scale) set to fit its heading label:
  - Heuristic: `columns = ceil((len(label) + 1) / 9)`, bounded `[1..4]`.
  - Minimum 2 for `Float / Currency / Int / Percent / Link` fields so values aren't truncated even when the label is short.
- Examples:
  - "Planned Qty in UOM [TOC]" (24 chars) → columns **3**
  - "Required Qty in UOM [TOC]" (25 chars) → columns **3**
  - "Projected Qty in UOM [TOC]" (26 chars) → columns **3**
  - "Qty to Order in UOM [TOC]" (25 chars) → columns **3**
  - "UOM [TOC]" (9 chars, Link) → columns **2** (min for Link)
  - "Recorded By [TOC App]" (21 chars) → columns **3**
- Persisted in `fixtures/custom_field.json` — fresh installs ship with correct widths.
- **Restricted**: don't shrink columns to 1 on Float/Currency/Link fields — values like "1000.000000" or "CFC / Master" exceed 1 column (~75px) and get truncated. The heuristic enforces this minimum.

### Production Plan validate hook — auto-stamp TOC UOM fields on every save (2026-05-19)
- New `doc_events["Production Plan"]["validate"]` hook in `hooks.py` calls `production_plan_engine.stamp_uom_fields_on_pp_validate`. Fires on every PP save (draft, before submit, after-edit re-save).
- The hook delegates to `_stamp_uom_fields_on_pp(doc)` which is now **idempotent + user-safe**:
  - If a row's `custom_uom` is already set → **respect the user's choice**, just look up the CF + recompute the in-UOM fields from the standard qty.
  - If `custom_uom` is blank → auto-pick the item's largest-CF non-stock UOM (falls back to stock UOM if no alt exists).
- **What it covers** (the user's "when user fetch sub assembly, the toc fields automatically update as per qty system populate"):
  1. User clicks "Get Sub-Assemblies" → ERPNext populates `sub_assembly_items` → user clicks Save → validate fires → TOC custom fields populate based on the row's standard qty.
  2. User clicks "Get Raw Materials" → similar, but `mr_items` aren't TOC-stamped (not in scope for this round).
  3. Engine auto-creates a PP via `_save_and_submit_production_plan` → explicit `_stamp_uom_fields_on_pp` call AT Step 2.5 still runs, AND the validate hook fires again on `pp_doc.save()` — both idempotent.
  4. User manually edits any row + saves → validate keeps the in-UOM fields in sync with the standard qty.
- **All TOC trigger paths now stamp UOM**:
  - `_save_and_submit_production_plan` (Calc A/B/SO/Action) — direct call.
  - `Production Plan.validate` — every save, no matter how triggered.
  - `_stamp_toc_fields_on_work_orders` — now stamps `custom_uom` + `custom_uom_conversion_factor` + `custom_qty_in_uom` on every auto-created WO alongside the existing MRP stamp.
  - `kitting_api._create_wo_single` — direct WO creation path — same UOM trio.
- **Live verified** (2026-05-19, PP `MFG-PP-2026-00066`):
  - Auto-pick: CZPFG71 → `CFC / Master` × 12; CZMAT/750 → `Kg` × 1000.
  - Idempotency: manually setting `custom_uom='Pcs'` and re-stamping preserves the user choice and recomputes CF=1, qiu=planned_qty.
- **Restricted**: do NOT remove the validate hook — it's the only thing that keeps the TOC UOM fields in sync after manual "Get Sub-Assemblies" / "Get Raw Materials" clicks. Don't make `_stamp_uom_fields_on_pp` non-idempotent again — overwriting `custom_uom` on every save would clobber user picks.

### Production Plan — Planned Qty read-only by default + WO section always expanded (2026-05-19)
- **WO "MRP & UOM" section** — set `collapsible=0` on the Section Break so the section is always expanded; no toggle, no collapse. Field: `Work Order.custom_mrp_section`.
- **Production Plan Item.planned_qty** now carries a **Property Setter** with `read_only=1` so the field is read-only at the metadata level for ALL users. The existing JS controller (`_ipv_pp_apply_qty_locks`) lifts the lock for System Manager + Administrator. Belt-and-braces: the metadata default holds even if the JS controller fails to load; admins get edit access via the JS-side lift.
- This pattern (Property Setter as the strong default + JS lift for admins) is the recommended way to lock a standard Frappe field for non-admin users. It survives JS load failures, doesn't block server-side writes (BOM explosion, scheduler), and the admin override is conditional on role at form-paint time.
- **Restricted**: don't remove the Property Setter on `Production Plan Item.planned_qty.read_only` — without it the field becomes editable for everyone the moment the JS controller fails to load (network glitch, asset cache invalidation). Don't remove the JS lift in `_ipv_pp_apply_qty_locks` either — without it admins can't edit planned_qty either.

### Label suffix [TOC] on all custom UOM/Qty fields (2026-05-19)
- Every custom field across **Work Order**, **Production Plan Item**, **Production Plan Sub Assembly Item**, and **BOM** whose fieldname matches `custom_*(uom|qty)*` now ends its display label with **` [TOC]`**. Visual cue that the column is a TOC-app addition vs an ERPNext standard column.
- 14 labels updated idempotently. Examples:
  - "Qty in UOM" → "Qty in UOM [TOC]"
  - "Planned Qty in UOM" → "Planned Qty in UOM [TOC]"
  - "Required Qty in UOM" → "Required Qty in UOM [TOC]"
  - "Projected Qty in UOM" → "Projected Qty in UOM [TOC]"
  - "Qty to Order in UOM" → "Qty to Order in UOM [TOC]"
  - "Pick UOM" → "Pick UOM [TOC]"
  - "UOM[TOC]" → "UOM [TOC]"   (fixed missing space)
  - "Conversion Factor" → "Conversion Factor [TOC]"
  - "CF" → "CF [TOC]"
- All persisted in `fixtures/custom_field.json` — fresh installs ship with the [TOC] suffix automatically.
- **Restricted**: don't strip the [TOC] suffix. Users have been trained to expect this visual cue distinguishing chaizup_toc columns from ERPNext core. The labelling pattern is part of the brand contract.

### Higher-UOM auto-default on item pick (2026-05-19)
- When a user picks a production item on Work Order, Production Plan Item (po_items row), Production Plan Sub Assembly Item, or BOM, `custom_uom` now **auto-defaults to the item's largest-CF UOM** (the "higher UOM"). The custom_uom event handler then chains: CF lookup → recompute standard qty.
- New endpoint: `chaizup_toc.api.uom_query.get_default_higher_uom(item_code)` returns `{"uom": "<top-CF UOM>", "conversion_factor": <cf>}` or `{"uom": "", "conversion_factor": 1.0}` if the item has no alt UOM (only stock UOM in the ladder). Items with no alt UOM leave the picker blank — the standard `qty`/`quantity`/`planned_qty` field stays the authoritative input.
- Wired on 4 controllers:
  - `work_order_mrp_uom.js`: `production_item` handler → `_ipv_wo_default_higher_uom(frm)`
  - `production_plan_mrp_uom.js` (PPI): `item_code` handler → `_ipv_ppi_default_higher_uom(row)`
  - `production_plan_mrp_uom.js` (Sub Assembly): `production_item` handler → `_ipv_sub_default_higher_uom(row)`
  - `bom_uom.js`: `item` handler → `_ipv_bom_default_higher_uom(frm)`
- Live verification: `get_default_higher_uom("CZPFG267")` → `{"uom": "CFC / Master", "cf": 12.0}`; stock-only item → `{"uom": "", "cf": 1.0}`.
- **Restricted**: don't extend the endpoint to return stock UOM when no alt UOM exists — JS treats `""` as "no auto-default" and the standard qty field stays authoritative. Returning stock UOM would write `quantity = qiu × 1.0` which is technically correct but confuses users (the picker fills with the same UOM as the standard column).

### Production Plan grid refactor — Items to Manufacture + Sub Assembly Items (2026-05-19)
- **Items to Manufacture (po_items)** column reorder:
  - col 1: Item Code · col 2: BOM No
  - col 3: **Planned Qty in UOM** (renamed from "Qty in UOM")
  - col 4: **UOM[TOC]** (renamed from "UOM")
  - cols 5+: warehouse, planned_start_date
  - last cols: standard `Planned Qty` + `UOM` (stock UOM)
- **Sub Assembly Items (sub_assembly_items)** — 5 new custom fields:
  - `custom_required_qty_in_uom` ("Required Qty in UOM") — col 4
  - `custom_uom` ("UOM[TOC]") — col 5
  - `custom_projected_qty_in_uom` ("Projected Qty in UOM", read-only) — auto-display `projected_qty ÷ CF`
  - `custom_qty_to_order_in_uom` ("Qty to Order in UOM") — drives the standard `qty` field
  - `custom_uom_conversion_factor` (read-only)
  - last cols: standard `required_qty`, `projected_qty`, `qty` (Qty to Order)
- **Column reorder mechanism**: Frappe does NOT honour Property Setter on `idx`. The reorder is done by **mutating `grid.docfields[*].idx` at runtime** in the parent form's `onload` + `refresh` handlers (function `_ipv_pp_reorder_grid_columns` in `production_plan_mrp_uom.js`). The standard "Planned" / "Required Qty" / "Qty to Order" columns get idx bumped past the highest current idx so they render LAST. Removed the 5 no-op idx Property Setters that were initially attempted.
- **JS controller upgraded** to handle both child tables:
  - `set_query` filters `custom_uom` per row by the row's item link (`item_code` for PPI, `production_item` for Sub Assembly).
  - One UOM picker per row on Sub Assembly drives 3 qty pairs (required + qty-to-order via × CF, projected via ÷ CF for display).
  - Qty locks on `planned_qty` (PPI) + `required_qty`/`qty` (Sub Assembly) for non-System-Manager.
  - Reverse fill on `required_qty` and `qty` writes — if ERPNext writes the standard qty (BOM explosion, scheduler), back-fill the corresponding `custom_*_in_uom` field so the row stays coherent.
- **Engine awareness**: `production_plan_engine._stamp_uom_fields_on_pp(pp_doc)` is called between `get_sub_assembly_items()` and `pp_doc.save()`. Stamps `custom_uom` (largest-CF UOM per item), `custom_uom_conversion_factor`, and all the corresponding `_in_uom` fields on every po_items + sub_assembly_items row so engine-created PPs render coherent values on first paint. Uses a single batched UOM-Conversion-Detail query for performance.
- **Restricted**: do NOT try to use Property Setter on `idx` — Frappe doesn't honour it; the JS runtime reorder is the only reliable path. Do NOT remove the engine `_stamp_uom_fields_on_pp` call; without it the auto-created PP rows would have blank UOM columns and confuse users. The `production_item` field name on Sub Assembly Item (vs `item_code` on PPI) is a deliberate ERPNext difference — branch on cdt when looking up item.

### BOM cleanup — drop MRP + reposition fields (2026-05-19, follow-up)
- **Removed `BOM.custom_mrp`** Custom Field — MRP belongs to the Item master, not the BOM (a BOM is just the recipe; MRP is a property of the FG it produces). Custom Field row deleted; orphan column `tabBOM.custom_mrp` dropped via `frappe.db.sql_ddl`. The fixture file no longer contains it.
- **Repositioned BOM fields** so the standard pair (`quantity` + `uom`) and the custom pair (`custom_qty_in_uom` + `custom_uom`) each sit together:
  - Was: `item → custom_mrp → quantity → custom_qty_in_uom → custom_uom → custom_uom_conversion_factor → uom`
  - Now: `item → quantity → uom → custom_qty_in_uom → custom_uom → custom_uom_conversion_factor`
- **JS renamed** `public/js/bom_mrp_uom.js` → `public/js/bom_uom.js` (pure UOM-picker + qty-lock controller). MRP fetch logic removed. `hooks.py:doctype_js["BOM"]` updated to point at the new filename.
- **Restricted (additions)**: do NOT re-add `BOM.custom_mrp`. MRP lives on Item master; pulling it onto BOM created redundant state with no clear owner. If a downstream report needs MRP for a BOM, read it from `Item` via the BOM's `item` link. Also: don't reorder the custom UOM trio (`custom_qty_in_uom → custom_uom → custom_uom_conversion_factor`) — the user's layout requirement is for both pairs to stay together.

### BOM UOM-picker parity (2026-05-19)
- Same UOM-picker pattern as Work Order applied to **BOM**. 3 new Custom Fields:
  - `custom_qty_in_uom` (Float) — production qty in the chosen UOM
  - `custom_uom` (Link → UOM) — filtered to the BOM's item ladder
  - `custom_uom_conversion_factor` (Float, read-only) — auto-populated
- `bom_mrp_uom.js` now: filters the UOM dropdown via `set_query` → `chaizup_toc.api.uom_query.get_item_uoms`; resolves CF via `chaizup_toc.api.uom_query.get_uom_conversion_factor`; auto-computes the standard `quantity` as `custom_qty_in_uom × CF`; **locks the standard `quantity` field for all users except System Manager** (programmatic writes from the UOM math bypass the lock).
- BOM's existing `custom_mrp` (read-only, auto-pulled from item) unchanged.
- All 17 MRP+UOM Custom Fields across Item / WO / PP Item / BOM are now in `fixtures/custom_field.json`. A fresh `bench install-app chaizup_toc` creates every field automatically. Audit script in `/tmp/audit_mrp_uom_fixtures.py` confirms zero missing.
- **Restricted**: do NOT widen the quantity lock beyond System Manager; do NOT swap CF lookup back to `frappe.client.get_list` (perm-blocked on child DocType); the 17 fixture rows are load-bearing — don't remove from `module='Chaizup Toc'`.

### Work Order MRP/UOM polish (2026-05-19) — three bugs fixed
- **UOM dropdown now restricted to item's ladder** — was showing every UOM in the system. Added `chaizup_toc/api/uom_query.py` with `get_item_uoms()` (Frappe link-query function) wired via `frm.set_query("custom_uom", …)`. Description text shows the conversion factor right in the dropdown (`× 12`). Empty `item_code` returns an empty list (no fallback to all UOMs).
- **Conversion Factor was not populating** — the prior implementation used `frappe.client.get_list` on `UOM Conversion Detail` which is perm-blocked for non-admin users (Frappe restricts direct reads on child DocTypes). Switched to a dedicated whitelisted endpoint `chaizup_toc.api.uom_query.get_uom_conversion_factor(item_code, uom)` that wraps `frappe.db.get_value` server-side. Verified live: `CZPFG267 × "CFC / Master" → 12.0`.
- **"Qty To Manufacture" now locked for non-System-Manager** — adds `frm.set_df_property("qty", "read_only", isAdmin ? 0 : 1)` in the refresh handler. Programmatic writes via `frm.set_value` (from the UOM-conversion math) bypass the lock, so the auto-compute still works; only typed edits are blocked. System Manager + Administrator get full edit rights and see a description hint explaining the lock.
- **Same three fixes applied to Production Plan Item** (per-row UOM filter, perm-safe CF endpoint, planned_qty column lock via `frm.fields_dict.po_items.grid.get_field("planned_qty").df.read_only`).
- **Restricted**: do NOT widen the qty lock beyond System Manager; do NOT swap back to `frappe.client.get_list` for the CF lookup (perm-blocked); the `get_item_uoms` link-query must return tuples `(value, description)` — Frappe's autocomplete component will break if you return dicts.

### MRP + UOM custom fields (2026-05-18)
- Added `Item.custom_mrp` (Currency) to **fixtures** so fresh installs ship with the field (it already existed on dev but wasn't exported).
- New custom-field block on **Work Order** + **Production Plan Item**: `custom_mrp_source` (Select Auto/Manual) · `custom_mrp` (Currency, read-only when source = Auto) · `custom_qty_in_uom` (Float) · `custom_uom` (Link → UOM) · `custom_uom_conversion_factor` (Float, read-only).
- New **BOM.custom_mrp** (read-only, auto-pulled from the BOM's item).
- **Client scripts**: `public/js/work_order_mrp_uom.js`, `public/js/production_plan_mrp_uom.js`, `public/js/bom_mrp_uom.js`. Auto-fetch MRP from Item, switch to Manual to override, recompute `qty` from `custom_qty_in_uom × CF` whenever the user types a qty in a chosen higher UOM. Standard `qty` remains in stock UOM so downstream reports and Stock Entries don't break.
- **Engine propagation**: `production_plan_engine._create_production_plan` and `_stamp_toc_fields_on_work_orders` now stamp `custom_mrp` + `custom_mrp_source="Auto from Item"` on every auto-created PP row and WO. `kitting_api._create_wo_single` does the same on every direct WO creation. Defensive try/except — older sites without the field don't crash.
- **New Script Report `/app/query-report/Production Indent Subs`** (20 columns × per-WO × per-component) — filters Item/Item Group/Warehouse, scoped to TOC-Pending WOs via TOC Settings. Live-verified: 147 component rows across 22 pending WOs / 4 PPs / 100 distinct components on dev.
- **Restricted**: do NOT rename `custom_mrp` / `custom_mrp_source` / `custom_qty_in_uom` / `custom_uom` / `custom_uom_conversion_factor` — they are referenced by both client scripts AND the server-side engine. Do NOT change `qty`-semantics on WO/PP (always stock UOM); the higher-UOM qty is a separate field. Do NOT hard-code pending-status definitions in the report — always read TOC Settings via `wo_kitting_api.get_toc_pending_filters`.

### Round 3 — Table still blank → Tabulator native groupBy
- **Root cause**: the custom `_children` / dataTree path on the backend was producing edge-case empty renders on some browsers.
- **Fix**: backend always returns FLAT leaf rows now. Grouping moved client-side to Tabulator's well-tested native `groupBy: "item_group"` with a custom `groupHeader` formatter showing item count + Σ Shortage (Phys) + Σ Shortage (Proj) + Σ Net Available with traffic-light colour coding.
- **In-host error displays** added: (a) "Grid library failed to load" if `window.Tabulator !== "function"`; (b) "No items in the current scope" if backend returned zero rows; (c) explicit error with stack if `new Tabulator(...)` throws. Replaces silent-empty-box failure mode.
- **Restricted (new)**: don't reintroduce the `_children` / dataTree path on the backend (group rendering is a client concern); don't remove the in-host error displays (only way a non-dev user can self-diagnose).
