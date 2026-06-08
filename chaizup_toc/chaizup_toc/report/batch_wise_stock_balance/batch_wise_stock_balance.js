// Copyright (c) 2026, chaizup_toc and contributors
// For license information, please see license.txt
/* ==========================================================================
 *  Batch-wise Stock Balance — report filters + cell rendering
 * --------------------------------------------------------------------------
 *  CONTEXT: ERPNext-style Stock Balance, per batch, in both UOMs.
 *  RESTRICT:
 *    - Warehouse / Item / Item Group / Batch are MultiSelectList (arrays sent
 *      to the server). Company is a single Link; from/to are Dates.
 *    - Item Name is rendered as a hyperlink to its Item (item_code drives the
 *      link target). Batch + Origin Voucher are auto-clickable (Link /
 *      Dynamic Link columns) — do NOT re-wrap those here.
 * ======================================================================== */
frappe.query_reports["Batch-wise Stock Balance"] = {
	filters: [
		{
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			default: frappe.defaults.get_user_default("Company"),
			reqd: 1,
		},
		{
			fieldname: "from_date",
			label: __("From Date"),
			fieldtype: "Date",
			default:
				frappe.defaults.get_user_default("year_start_date") ||
				frappe.datetime.add_months(frappe.datetime.get_today(), -12),
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("To Date"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1,
		},
		{
			fieldname: "warehouse",
			label: __("Warehouse"),
			fieldtype: "MultiSelectList",
			get_data: function (txt) {
				return frappe.db.get_link_options("Warehouse", txt, {
					company: frappe.query_report.get_filter_value("company"),
				});
			},
		},
		{
			fieldname: "item_code",
			label: __("Item"),
			fieldtype: "MultiSelectList",
			get_data: function (txt) {
				return frappe.db.get_link_options("Item", txt);
			},
		},
		{
			fieldname: "item_group",
			label: __("Item Group"),
			fieldtype: "MultiSelectList",
			get_data: function (txt) {
				return frappe.db.get_link_options("Item Group", txt);
			},
		},
		{
			fieldname: "batch_no",
			label: __("Batch"),
			fieldtype: "MultiSelectList",
			get_data: function (txt) {
				return frappe.db.get_link_options("Batch", txt);
			},
		},
		{
			fieldname: "show_zero_balance",
			label: __("Show Zero Balance Batches"),
			fieldtype: "Check",
		},
	],

	formatter: function (value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		// Item Name → hyperlink to its Item record (item_code is the target).
		if (column.fieldname === "item_name" && data && data.item_code) {
			value = `<a href="/app/item/${encodeURIComponent(data.item_code)}"
				title="${__("Open Item")}">${frappe.utils.escape_html(data.item_name || "")}</a>`;
		}
		return value;
	},
};
