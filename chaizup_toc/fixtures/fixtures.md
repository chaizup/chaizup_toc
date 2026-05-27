# fixtures — Data Records Shipped with the App

Doctype records that `chaizup_toc` installs alongside its code. Frappe re-imports these on every `bench install-app chaizup_toc`, `bench --site … migrate`, and `bench --site … restore`. Treat them as part of the schema, not as runtime data.

## What's exported, and how it's selected

Configured in `hooks.py` → `fixtures = […]`:

| File                       | Doctype              | Filter                                            | What it ships                                                                  |
| -------------------------- | -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `custom_field.json`        | Custom Field         | `module = "Chaizup Toc"`                          | Every Custom Field whose **Module** is `Chaizup Toc`                           |
| `property_setter.json`     | Property Setter      | `module = "Chaizup Toc"`                          | Every Property Setter whose **Module** is `Chaizup Toc`                        |
| `list_view_settings.json`  | List View Settings   | `name in ["Work Order", "BOM"]`                   | Opinionated default list-view columns for those two ERPNext doctypes          |

The first two are filtered by module — keep new custom fields/property setters scoped to the `Chaizup Toc` module and they'll auto-export.

The third is filtered by `name` because `List View Settings` has no `module` field (each row's `name` is the DocType it configures, e.g. `"Work Order"`). Add a new doctype to the `name in [...]` list only if `chaizup_toc` genuinely owns the list-view defaults for it.

## Re-exporting after a UI edit

When you change a Custom Field, Property Setter, or List View Settings record via the Desk UI on the dev site, the live DB is updated but the fixture JSON is not. Re-export with:

```shell
bench --site development.localhost export-fixtures --app chaizup_toc
```

The three JSON files get rewritten from the current DB state. Commit them so other environments get the same defaults on next migrate.

## list_view_settings.json — default columns

Frappe's `List View Settings` doctype is a singleton-per-doctype (`name` is the DocType being configured). The `fields` Code field stores a JSON array of `{fieldname, label}` objects that REORDER the list-view columns built by `setup_columns()` in `frappe/list_view.js`.

**Important caveat (Frappe v15/v16 source):** `reorder_listview_fields()` (list_view.js:498-522) only reorders columns that ALREADY exist in `this.columns`. It cannot ADD new columns. Sources for `this.columns`:

1. `meta.title_field` or `name` (Subject column, always present)
2. Status indicator (if `frappe.has_indicator(doctype)`)
3. `meta.fields` filtered by `in_list_view=true` (`get_fields_in_list_view`, base_list.js:93)

So a fieldname in `List View Settings.fields` that is NOT in one of those three sources is **silently dropped**. Standard audit fields (`creation`, `owner`, `modified`, `modified_by`) are columns on the underlying SQL table but NOT docfields — they cannot be enabled via this mechanism alone.

For audit columns we use the **`doctype_list_js`** hook + `frappe.listview_settings[doctype].add_fields` instead (see "Default view + audit columns" below).

### Work Order — 9 columns

| # | Field                    | Label                |
| - | ------------------------ | -------------------- |
| 1 | `name`                   | Work Order ID        |
| 2 | `production_item`        | Item Code            |
| 3 | `item_name`              | Item Name            |
| 4 | `custom_qty_in_uom`      | Qty in UOM [TOC]     |
| 5 | `custom_uom`             | UOM [TOC]            |
| 6 | `production_plan`        | Production Plan      |
| 7 | `custom_toc_recorded_by` | Recorded By          |
| 8 | `creation`               | Created Time         |
| 9 | `owner`                  | Created By           |

The two `custom_*` UOM fields are populated by:
- the `Work Order.validate → stamp_uom_fields_on_wo_validate` hook (manual edits),
- the `ChaizupProductionPlan.make_work_order` override (PP→WO button), and
- the engine auto-PP path's explicit `_stamp_toc_fields_on_work_orders` call.

See `../overrides/overrides.md` for details. `custom_toc_recorded_by` is `By System` for engine-created WOs and blank for user-driven ones.

### BOM — 7 columns

| # | Field          | Label              |
| - | -------------- | ------------------ |
| 1 | `item_name`    | Item Name          |
| 2 | `item`         | Item Code          |
| 3 | `name`         | BOM ID             |
| 4 | `creation`     | Created Time       |
| 5 | `owner`        | Created By         |
| 6 | `modified`     | Last Modified Date |
| 7 | `modified_by`  | Last Modified By   |

## Default view + audit columns (2026-05-19)

Work Order and BOM lists are configured to land in **Report View** by default. Mechanism:

| Property                          | Set on        | Value     | Rationale                                                                                       |
| --------------------------------- | ------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `default_view`                    | Work Order, BOM | `"Report"` | `router.js:222-230` honors `meta.default_view` for the `/app/<doctype>` route.                 |
| `force_re_route_to_default_view`  | Work Order, BOM | `1`        | Forces users to Report View even if their per-user `last_view` was List.                       |
| `in_list_view`                    | WO.custom_qty_in_uom, WO.custom_uom, BOM.item_name | `1` | `set_default_fields` in `report_view.js:884-892` picks up `in_list_view` docfields as default Report View columns. |
| `in_list_view`                    | WO.qty, WO.sales_order, WO.process_loss_qty, BOM.is_active, BOM.is_default, BOM.total_cost, BOM.has_variants | `0` | ERPNext defaults the user didn't ask for — suppressed so they don't pollute the default column set. |
| `report_hide`                     | WO.custom_toc_zone | `1` | The field has `in_standard_filter=1` (filter sidebar). `set_default_fields` also adds in_standard_filter docfields to default columns unless `report_hide=1`. Keeps the filter, hides the column. |

All of these ship as Property Setters in `property_setter.json`.

### Audit columns via `doctype_list_js`

`creation` / `owner` / `modified` / `modified_by` are SQL columns on every `tab<DocType>` but NOT docfields, so they can't be enabled via `in_list_view`. The only app-installable injection point for them in Report View is `frappe.listview_settings[doctype].add_fields` (read by `set_default_fields` at `report_view.js:908`).

Two new JS shims live in `public/js/`:

- `work_order_list_extras.js` — overrides `frappe.listview_settings["Work Order"].add_fields = ["creation", "owner"]`.
- `bom_list_extras.js` — overrides `frappe.listview_settings["BOM"].add_fields = ["creation", "owner", "modified", "modified_by"]`.

Wired in `hooks.py` via `doctype_list_js`. These files load AFTER ERPNext's `work_order_list.js` / `bom_list.js`, so they completely **replace** the ERPNext `add_fields` (not concat). Why replace:

- ERPNext WO ships add_fields = `[bom_no, status, sales_order, qty, produced_qty, expected_delivery_date, planned_start_date, planned_end_date]`. Concatenating leaves all 8 as default Report View columns and contradicts the 9-column spec.
- ERPNext BOM ships add_fields = `[is_active, is_default, total_cost, has_variants]`. Same problem.

**Side-effects of REPLACING add_fields:**

- **WO Status indicator** still works because `status` is a real docfield and is auto-fetched by `get_fields_in_list_view()` regardless of add_fields.
- **BOM badge** (ERPNext's "Template / Default / Active / Not active") becomes muted in Report View because `get_indicator` reads `doc.is_active` / `doc.is_default` / `doc.has_variants`, which are no longer in the row data. Users who need that badge can re-add the columns via the column picker, or toggle to List view where Frappe auto-fetches in_list_view fields. We keep the `get_indicator` callback in place so it can revive in either of those cases.

### Final Report View column set

| Work Order (9 user-spec) | BOM (7 user-spec) |
| ------------------------ | ----------------- |
| `name` (Work Order ID)   | `name` (BOM ID)   |
| `production_item` (Item Code, also `title_field`) | `item` (Item Code) |
| `item_name`              | `item_name`       |
| `custom_qty_in_uom` (Qty in UOM [TOC]) | `creation` (Created Time) |
| `custom_uom` (UOM [TOC]) | `owner` (Created By) |
| `production_plan`        | `modified` (Last Modified Date) |
| `custom_toc_recorded_by` (Recorded By) | `modified_by` (Last Modified By) |
| `creation` (Created Time) | |
| `owner` (Created By)     | |

Two framework cosmetic columns are also rendered by Frappe and can't be suppressed via fixtures:
- `docstatus` — small Status badge derived from the submit lifecycle.
- `image` — auto-added from `meta.image_field`; renders blank when no image is attached (common for WO/BOM).

Users can hide them via the column picker — their per-user choice persists in `__UserSettings`.

## Restrictions

- **Do not edit the JSON files by hand.** Make the change via the UI (or directly in the DB) and re-export. Hand-edits are easy to drift from what Frappe actually persists.
- **Do not drop fields from `custom_field.json` without a `before_uninstall`/migration plan.** The columns on `tab<DocType>` already exist; removing the Custom Field row without dropping the SQL column leaves a dangling column. The engine and JS controllers reference these field names directly — see `app_chaizup_toc.md` memory for the load-bearing list.
- **Do not add unrelated DocTypes to the `List View Settings` filter.** `name in ["Work Order", "BOM"]` is intentionally narrow. Adding more (e.g. `"Production Plan"`) would silently override sites that have customised their own list views.
- The `[TOC]` label suffix on the custom-field columns is a deliberate brand marker — don't strip it on rename.

## Fixture update gotcha — INSERT-only importer (CRITICAL)

Frappe's `install_fixtures` mechanism (run by `bench install-app` + `bench migrate`) is **INSERT-only for existing rows**. Changing a row that's already present in the target table is a silent no-op — the file on disk diverges from production state forever.

This applies to BOTH `List View Settings` and `Property Setter`. Editing the JSON without a paired patch is the most common source of "I updated the fixture but live sites still show the old behaviour" bugs.

**Always pair a fixture mutation with a one-shot patch:**

| Fixture changed | Pair with |
|---|---|
| `custom_field.json` | usually self-syncs (Frappe handles column add/modify) |
| `property_setter.json` | `patches/sync_property_setters.py` (force-rewrites) |
| `list_view_settings.json` for `Work Order` | `patches/v1_0/sync_wo_list_view_settings.py` (2026-05-27, v0.0.12) |
| `list_view_settings.json` for `BOM` | `patches/v1_0/sync_bom_list_view_settings.py` (2026-05-27, v0.0.11) |

When in doubt: write a patch that `frappe.db.set_value`s the changed columns on the affected row(s), commit, register in `patches.txt`.

## BOM list-view 8-column layout (2026-05-27, v0.0.17 — supersedes v0.0.11)

| # | Column | Field | Notes |
|---|---|---|---|
| 1 | ID | `name` | docname |
| 2 | **Status** (coloured pill) | `status_field` (synthetic) | ERPNext `get_indicator` — Template / Default / Active / Not active |
| 3 | Item To Manufacture | `item` | rendered as `<bold>code</bold> : <muted>item_name</muted>` via JS formatter |
| 4 | Is Active ? | `is_active` | |
| 5 | Is Default ? | `is_default` | |
| 6 | Created By | `owner` | framework column |
| 7 | Created On | `creation` | framework column |
| 8 | **Work Orders** (hyperlink) | `custom_wo_count` | Int Custom Field, count of non-cancelled WOs (`docstatus < 2`); cell hyperlinks to `/app/work-order/view/list?bom_no=<bom>` (new tab) |

`custom_wo_count` auto-maintained via doc_events on Work Order: `after_insert` + chained `on_cancel` + `on_trash`. Refresh helper is SSOT (`SELECT COUNT(*)` recount, never +1/-1). Backfilled once for historical BOMs (173 of 647 had ≥1 WO on chaizup-erp 2026-05-27).

## CRITICAL — List view vs Report view (lesson learned 2026-05-27, v0.0.13)

`List View Settings.fields` (this fixture) and `frappe.listview_settings[dt].get_indicator` (in our `*_list_extras.js`) **only render in LIST view**. Report view ignores both — it builds columns from `meta.fields where in_list_view=1` + `add_fields` + per-user `__UserSettings`.

Before changing list-view appearance, verify the doctype's `default_view` Property Setter. If it's set to `Report` (with `force_re_route_to_default_view = 1`), the list-view fixture is invisible to users until the default is flipped back to List (see v0.0.13 patch).

| Doctype | default_view | Reasoning |
|---|---|---|
| **Work Order** | `List` (flipped from Report in v0.0.13) | combined "Work Order Actual Status" pill only renders in List view |
| **BOM** | `List` (flipped from Report in v0.0.17) | combined "code : name" formatter on item + Work Orders count hyperlink only render in List view |

## Work Order list-view columns + combined indicator (2026-05-27, v0.0.12)

10-column spec:

| # | Column | Field |
|---|---|---|
| 1 | ID | `name` |
| 2 | Item To Manufacture | `production_item` |
| 3 | **Work Order Actual Status** (combined indicator) | `status_field` (synthetic) |
| 4 | MRP | `custom_mrp` |
| 5 | Qty | `qty` (standard, in stock UOM) |
| 6 | Qty In UOM [TOC] | `custom_qty_in_uom` |
| 7 | UOM [TOC] | `custom_uom` |
| 8 | Manufactured Qty in UOM [TOC] | `custom_produced_qty_in_uom` |
| 9 | Created On | `custom_created_time` |
| 10 | Created By | `custom_created_by` |

Column 3 ("Work Order Actual Status") is the synthetic `{"type": "Status"}` entry. Its visual content is produced by `frappe.listview_settings["Work Order"].get_indicator`, which we override in `public/js/work_order_list_extras.js` (v0.0.12) to fuse `status` + `workflow_state` into a single coloured pill. Live combinations on chaizup-erp 2026-05-27:

| Count | Color | Label |
|---|---|---|
| 165 | green | Completed · Taken In Production |
| 31 | red | Draft · WO Rejected |
| 30 | red | Draft |
| 16 | gray | Cancelled |
| 13 | blue | Closed · Taken In Production |
| 9 | orange | Not Started · Taken In Production |
| 3 | gray | Cancelled · Taken In Production |
| 2 | red | Stopped · Taken In Production |
| 2 | orange | In Process · Taken In Production |

`production_plan` column dropped from defaults (still in meta + still filterable; just not a default Report View column per spec).

## BOM list-view column ordering (2026-05-27, v0.0.11)

The BOM List View Settings fixture defines 6 columns:
1. **Status** (synthetic `{"type": "Status"}` → renders the colored Active/Default/Template/Not-active pill from ERPNext's `get_indicator` callback)
2. Item To Manufacture (`item`)
3. Created On (`custom_created_time`)
4. Created By (`custom_created_by`)
5. Is Active ? (`is_active`)
6. Is Default ? (`is_default`)

The previous ordering had `name` (ID) as column 1. It was dropped because:
- BOM docnames look code-ish (`BOM-FG-001-001`) — operators called it "the workflow state column" because it visually resembles a status code without carrying product identity.
- Clicking the row already navigates to the BOM; the column gave zero scanning value.
- Status pill + Item are the natural identifiers; they now occupy positions 1 + 2 together.
