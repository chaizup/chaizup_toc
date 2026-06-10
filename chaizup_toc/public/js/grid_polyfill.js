/**
 * Grid.set_column_disp_in_list_view polyfill
 * ───────────────────────────────────────────
 * ERPNext v16.22.0 calls grid.set_column_disp_in_list_view() in work_order.js,
 * but the method was added to Frappe in a commit not yet released to version-16.
 * This polyfill bridges the gap until Frappe is updated.
 *
 * Loaded via hooks.py → app_include_js (before any form JS).
 */
(function () {
	"use strict";

	// Wait until frappe.ui.form.Grid is available
	var _interval = setInterval(function () {
		if (!frappe || !frappe.ui || !frappe.ui.form || !frappe.ui.form.Grid) return;
		clearInterval(_interval);

		var Grid = frappe.ui.form.Grid;

		// Don't overwrite if Frappe already ships it
		if (typeof Grid.prototype.set_column_disp_in_list_view === "function") return;

		// Initialise the override map when it's missing (older Grid constructor)
		var _origSetup = Grid.prototype.setup_fields;
		Grid.prototype.setup_fields = function () {
			_origSetup.apply(this, arguments);

			var overrides = this.column_disp_overrides;
			if (!overrides || !Object.keys(overrides).length) return;

			this.docfields = this.docfields.map(function (df) {
				if (!(df.fieldname in overrides)) return df;
				return Object.assign({}, df, { hidden: overrides[df.fieldname] });
			});
		};

		Grid.prototype.set_column_disp_in_list_view = function (fieldname, show) {
			if (!this.column_disp_overrides) {
				this.column_disp_overrides = {};
			}

			var fieldnames = Array.isArray(fieldname) ? fieldname : [fieldname];
			for (var i = 0; i < fieldnames.length; i++) {
				this.column_disp_overrides[fieldnames[i]] = show ? 0 : 1;
			}

			// Rebuild the grid layout so column widths are recalculated
			this.visible_columns = [];
			this.grid_rows = [];
			$(this.parent).find(".grid-body .grid-row").remove();

			this.debounced_refresh();
		};
	}, 50);
})();
