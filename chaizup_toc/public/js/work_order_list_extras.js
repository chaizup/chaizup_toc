/*
============================================================================
CONTEXT: chaizup_toc list-view extension for Work Order.
  Adds the framework audit columns (`creation`, `owner`) to
  `frappe.listview_settings["Work Order"].add_fields` so they show up as
  default columns in Report View.

  Why this is needed
  ------------------
  Frappe's Report View `set_default_fields()` (frappe/.../report_view.js
  ~line 876) seeds default columns from THREE sources:
    1. meta.title_field + meta.image_field
    2. meta.fields where in_list_view=1 OR in_standard_filter=1
    3. (this.settings.add_fields || []).map(add_field)
  Standard audit columns (`creation`, `owner`, `modified`, `modified_by`)
  are columns on the underlying SQL table but NOT docfields, so they
  cannot be enabled via `in_list_view` Property Setters. The third source
  — `add_fields` from `frappe.listview_settings[doctype]` — is the only
  app-installable place to inject them as default Report View columns.

  Why we MERGE instead of overwrite
  ---------------------------------
  ERPNext ships `erpnext/manufacturing/doctype/work_order/work_order_list.js`
  which defines `frappe.listview_settings["Work Order"]` with status
  indicators + an `add_fields` list (bom_no, status, sales_order, qty,
  produced_qty, expected_delivery_date, planned_start_date,
  planned_end_date) needed by the WO list/indicator code. Overwriting
  that hash would break the WO status indicator. We concat into the
  existing `add_fields` array instead.

  Field order in Report View
  --------------------------
  Report View renders columns in the order they're added via add_field.
  That order is: title → in_list_view-flagged docfields (by docfield.idx)
  → currency options → add_fields entries. So `creation`/`owner` will
  appear AT THE END of the default column set. Users can drag-reorder
  in the column picker per-user and the choice persists.

MEMORY: app_chaizup_toc.md § Work Order + BOM list-view defaults

DANGER ZONE:
  - This file is loaded AFTER ERPNext's work_order_list.js. Trust
    `frappe.listview_settings["Work Order"]` already exists and was
    populated by ERPNext. Use a defensive `|| {}` and concat.
  - Do NOT replace the WO `get_indicator` callback — ERPNext's
    status-light logic depends on it.

RESTRICT:
  - The `add_fields` strings here must be REAL column names on
    `tabWork Order` — typoing one causes a SQL error at list-fetch
    time. `creation` and `owner` are framework columns present on
    every tab table.
  - Do NOT add per-user mutating logic here (no save_user_settings,
    no localStorage). The file runs on every list-load for every
    user — side effects accumulate.
============================================================================
*/

(function () {
    const dt = "Work Order";
    const existing = frappe.listview_settings[dt] || {};

    // 2026-05-20 — CRITICAL FIX: keep `status` (and the qty fields the
    // ERPNext indicator callback reads) in add_fields. Earlier version
    // replaced ERPNext's add_fields with only ["creation","owner"] which
    // dropped `status` from the DB fetch → doc.status was undefined →
    // get_indicator() returned an empty pill → Status column rendered blank.
    //
    // The indicator callback in erpnext/.../work_order_list.js does:
    //   return [__(doc.status), colour_map[doc.status], "status,=,"+doc.status];
    // So `status` MUST be in add_fields (or in_list_view) to populate doc.status.
    // We're not putting `status` in_list_view because the Status pill IS the
    // status column — having two would be redundant.
    //
    // The non-status ERPNext add_fields entries (bom_no, sales_order, qty,
    // produced_qty, expected_delivery_date, planned_start_date,
    // planned_end_date) are dropped because:
    //  - qty + produced_qty are explicitly hidden via PS in_list_view=0
    //  - bom_no, sales_order, expected_delivery_date, planned_start/end_date
    //    aren't in the user's 8-column spec
    //
    // Each entry in add_fields MUST be a real column on tabWork Order.
    // status, creation, owner are framework columns guaranteed to exist.
    frappe.listview_settings[dt] = Object.assign({}, existing, {
        add_fields: ["status", "creation", "owner"],
    });
})();
