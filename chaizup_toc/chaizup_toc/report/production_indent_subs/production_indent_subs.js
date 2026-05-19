// =============================================================================
// CONTEXT: Production Indent Subs — Script Report client config.
//   Filter definitions + cell formatter for visual polish.
//
// MEMORY: app_chaizup_toc.md § MRP & UOM custom fields
//
// INSTRUCTIONS:
//   - Three filters per spec: Item, Item Group, Warehouse (all optional).
//   - WO and PP cells are hyperlinks (Frappe report formatter handles this
//     automatically for Link fieldtypes; we add visual zone hint).
//
// RESTRICT:
//   - Don't add a Status filter — TOC-Pending semantics come from TOC
//     Settings (single source of truth).
// =============================================================================
frappe.query_reports["Production Indent Subs"] = {
    filters: [
        {
            fieldname:   "item",
            label:       __("Item"),
            fieldtype:   "Link",
            options:     "Item",
        },
        {
            fieldname:   "item_group",
            label:       __("Item Group"),
            fieldtype:   "Link",
            options:     "Item Group",
        },
        {
            fieldname:   "warehouse",
            label:       __("Warehouse"),
            fieldtype:   "Link",
            options:     "Warehouse",
        },
    ],

    formatter(value, row, column, data, default_formatter) {
        // Pending FG short = paint produced-MRP cell light amber if 0.
        if (column.fieldname === "produced_mrp" && (value || 0) === 0) {
            return `<span style="color:#B45309;font-style:italic">—</span>`;
        }
        return default_formatter(value, row, column, data);
    },

    onload(report) {
        report.page.add_inner_button(__("Open Item Projection View"), function () {
            frappe.set_route("Page", "item-projection-view");
        });
        report.page.add_inner_button(__("Open Item Shortage Dashboard"), function () {
            frappe.set_route("Page", "item-shortage-dashboard");
        });
    },
};
