/*
============================================================================
CONTEXT: chaizup_toc list-view extension for BOM.

PURPOSE (post 2026-05-27 — v0.0.17):
  1. Inject framework audit columns + item_name into add_fields so the
     "code : name" formatter on `item` has data.
  2. Custom formatter for `item` → "<bold>item_code</bold> : <muted>item_name</muted>"
  3. Custom formatter for `custom_wo_count` → hyperlink to filtered Work
     Order list (?bom_no=BOM-XYZ-001).
  4. Preserve ERPNext's get_indicator callback (Template / Default /
     Active / Not active) so the synthetic Status column in the fixture
     renders the correct coloured pill.

WHY MERGE INSTEAD OF OVERWRITE
  ----------------------------------
  ERPNext ships `erpnext/manufacturing/doctype/bom/bom_list.js` which
  defines `frappe.listview_settings["BOM"]` with `add_fields`
  (is_active, is_default, total_cost, has_variants) AND a get_indicator
  callback. We MERGE via Object.assign so the indicator survives; we
  REPLACE add_fields to a narrower set that backs only the columns we
  actually render.

INDICATOR (preserved from ERPNext)
  ----------------------------------
    is_active && has_variants → "Template"     orange
    is_default               → "Default"       green
    is_active                → "Active"        blue
    !is_active               → "Not active"    gray

  The synthetic {"type": "Status"} column in the fixture surfaces this
  pill AS a Report-view column.

MEMORY: app_chaizup_toc.md § v0.0.17 — BOM list polish (2026-05-27)

DANGER ZONE — DO NOT CHANGE
  ----------------------------
  - DO NOT replace ERPNext's get_indicator. It's the visual heart of
    the Status column. Object.assign with a hash that doesn't override
    get_indicator preserves it.
  - The 6 entries in add_fields (is_active, is_default, has_variants,
    item_name, custom_wo_count, creation, owner) MUST stay. The first
    three are read by the ERPNext indicator. item_name is read by our
    combined formatter. custom_wo_count backs the hyperlink. creation/
    owner back the Created On / Created By fixture columns.
  - The Work Orders hyperlink uses `bom_no=` filter, NOT `bom=`.
    ERPNext's Work Order field is `bom_no` — typo'd as `bom` would
    yield a useless empty list.
  - Hyperlinks MUST keep target="_blank" + rel="noopener". Same
    convention as the WO list batch_no hyperlink (v0.0.16).

RESTRICT
  ----------
  - Each add_fields string MUST be a real column on tabBOM. creation +
    owner are framework columns guaranteed to exist.
  - Do NOT add per-user mutating logic here (no save_user_settings,
    no localStorage). File runs on every list-load for every user.
============================================================================
*/

(function () {
    const dt = "BOM";
    const existing = frappe.listview_settings[dt] || {};

    // v0.0.17 — formatter for the "Item To Manufacture" column.
    // Renders as <bold>code</bold> : <muted>item_name</muted>.
    // RESTRICT: never strip the escape on item code or name — both can
    // contain user-entered characters that would break the cell HTML.
    const fmt_item_code_and_name = (value, df, doc) => {
        const esc = (s) => frappe.utils.escape_html(String(s || ""));
        const code = esc(value);
        const name = esc(doc.item_name);
        if (!code) return "";
        if (!name) return `<span class="bold">${code}</span>`;
        return `<span class="bold">${code}</span>` +
               `<span class="text-muted"> : ${name}</span>`;
    };

    // v0.0.17 — Work Orders count cell → hyperlink to the filtered WO list.
    // Frappe stores the WO's BOM link in `Work Order.bom_no` (NOT `bom`).
    // We URL-encode the BOM name because it can contain "/" (e.g.,
    // "BOM-CZMAT/754-1") which would otherwise break URL routing.
    const fmt_wo_count_link = (value, df, doc) => {
        const n = Number(value || 0);
        if (!n) {
            return `<span class="text-muted">0</span>`;
        }
        const bom = encodeURIComponent(doc.name);
        return `<a href="/app/work-order/view/list?bom_no=${bom}"
                   target="_blank"
                   rel="noopener"
                   class="text-primary bold">${n}</a>`;
    };

    frappe.listview_settings[dt] = Object.assign({}, existing, {
        add_fields: ["is_active", "is_default", "has_variants",
                     "item_name", "custom_wo_count",
                     "creation", "owner"],
        formatters: Object.assign({}, existing.formatters || {}, {
            item: fmt_item_code_and_name,
            custom_wo_count: fmt_wo_count_link,
        }),
        // ERPNext's get_indicator stays untouched (preserved by Object.assign
        // because we don't override it).
    });
})();
