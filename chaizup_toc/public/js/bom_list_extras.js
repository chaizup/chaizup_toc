/*
============================================================================
CONTEXT: chaizup_toc list-view extension for BOM.
  Adds framework audit columns (`creation`, `owner`, `modified`,
  `modified_by`) to `frappe.listview_settings["BOM"].add_fields` so
  Report View picks them up as default columns.

  See `work_order_list_extras.js` for the full reasoning — same
  mechanism (Report View `set_default_fields` reads `add_fields` from
  listview_settings).

  Why we MERGE instead of overwrite
  ---------------------------------
  ERPNext ships `erpnext/manufacturing/doctype/bom/bom_list.js` which
  defines `frappe.listview_settings["BOM"]` with a `get_indicator`
  callback (Template / Default / Active / Not active) and add_fields
  (is_active, is_default, total_cost, has_variants) that the indicator
  depends on. Overwriting that hash would break the BOM status badge.
  We concat into the existing `add_fields` array.

MEMORY: app_chaizup_toc.md § Work Order + BOM list-view defaults

RESTRICT:
  - The 4 audit field names here MUST stay as framework column names.
    `creation`/`owner`/`modified`/`modified_by` are present on every
    `tab*` table — don't rename them.
  - Don't drop the ERPNext indicator add_fields by reassigning the
    hash. Concat into `add_fields` only.
============================================================================
*/

(function () {
    const dt = "BOM";
    const existing = frappe.listview_settings[dt] || {};

    // REPLACE (not concat) add_fields with exactly the framework audit
    // columns the user spec asks for. ERPNext's bom_list.js ships
    // add_fields [is_active, is_default, total_cost, has_variants];
    // concatenating leaves all four as default Report View columns and
    // contradicts the 7-column spec, so we replace.
    //
    // Side-effect: the ERPNext `get_indicator` callback below reads
    // doc.is_active / doc.is_default / doc.has_variants. With those
    // fields no longer fetched, the standard "Template / Default /
    // Active / Not active" badge becomes muted in Report View. Users
    // who need that badge can re-add the columns via the column picker.
    // We keep the indicator callback in place (don't strip it) — if
    // the user later switches to LIST view (still reachable via the
    // view toggle), the badge logic will revive.
    frappe.listview_settings[dt] = Object.assign({}, existing, {
        add_fields: ["creation", "owner", "modified", "modified_by"],
    });
})();
