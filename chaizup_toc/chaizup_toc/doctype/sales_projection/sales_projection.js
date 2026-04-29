// =============================================================================
// CONTEXT: Sales Projection form JS. Handles all client-side behaviour for
//   the Sales Projection DocType and its child table "Sales Projected Items".
//   Four responsibilities:
//     1. UOM dropdown filter — only show UOMs valid for the selected item.
//     2. Conversion factor auto-fetch — from tabUOM Conversion Detail on UOM change.
//     3. Qty (Stock UOM) auto-compute — qty * conversion_factor on qty/uom change.
//     4. Duplicate item warning — live orange warning; Python blocks on save.
// MEMORY:  sales_projection.md § Client-Side Logic
// INSTRUCTIONS:
//   - Child table fieldname: `table_mibv` (defined in sales_projection.json).
//     ALL frm.doc, frm.fields_dict, and refresh_field references use this name.
//   - UOM fieldname in child table: `uom_unit_of_measurement` (sales_projected_items.json).
//   - get_query for UOM calls get_item_uoms() from sales_projected_items.py.
//   - item_name and stock_uom are auto-filled by fetch_from in JSON; no JS needed.
//   - conversion_factor is NOT a fetch_from — it depends on BOTH item AND uom.
// DANGER ZONE:
//   - `table_mibv` rename: breaks frm.fields_dict["table_mibv"], frm.doc.table_mibv,
//     frm.refresh_field("table_mibv"), and _check_duplicate_items().
//   - `uom_unit_of_measurement` rename: breaks get_field(), child table event handler,
//     and _fetch_conversion_factor() event trigger.
//   - get_query MUST be re-registered in every refresh() call. Frappe discards
//     grid get_query registrations on form reload; refresh is the only safe hook.
//   - conversion_factor is read_only in JSON but writable via frappe.model.set_value().
//     Frappe read_only blocks the UI input widget, not programmatic model writes.
// RESTRICT:
//   - Do not remove _check_duplicate_items() call from the item event.
//     Python blocks duplicates on save, but JS warning gives immediate feedback.
//   - Do not remove UOM get_query — without it the field shows ALL UOMs system-wide.
//   - Do not merge _fetch_conversion_factor into the uom event inline.
//     The function handles the stock_uom == uom edge case (factor = 1) separately.
// =============================================================================

// Copyright (c) 2026, Chaizup and contributors
// For license information, please see license.txt

// =============================================================================
// UTILITY: Compute qty_in_stock_uom = qty * conversion_factor for a child row.
// CONTEXT: Called after qty OR conversion_factor changes on any child row.
// RESTRICT: Always pass frm, cdt, cdn — do not call with row object directly.
// =============================================================================
function _compute_stock_qty(frm, cdt, cdn) {
	let row = locals[cdt][cdn];
	let qty = flt(row.qty) || 0;
	let cf = flt(row.conversion_factor) || 1;
	frappe.model.set_value(cdt, cdn, "qty_in_stock_uom", flt(qty * cf, 6));
}

// =============================================================================
// UTILITY: Fetch conversion_factor from tabUOM Conversion Detail for item + UOM.
//   If the selected UOM equals the item's stock_uom, factor is 1 (no DB call).
//   Falls back to 1 when no conversion row is found (stock_uom has no row typically).
// CONTEXT: Called only from the uom_unit_of_measurement child event.
// DANGER ZONE:
//   - frappe.db.get_value on "UOM Conversion Detail" uses composite key
//     {parent: item_code, uom: selected_uom}. Do not change the filter keys.
//   - The stock_uom check (row.stock_uom === row.uom_unit_of_measurement) may fire
//     before fetch_from has populated stock_uom if the user selects UOM very quickly
//     after selecting the item. In that case the DB path handles it correctly because
//     there is no UOM Conversion Detail row for stock_uom — the fallback default of
//     1 is the correct answer.
// =============================================================================
function _fetch_conversion_factor(frm, cdt, cdn) {
	let row = locals[cdt][cdn];
	if (!row.item || !row.uom_unit_of_measurement) return;

	// Fast path: if selected UOM is the item's stock UOM, factor is always 1
	if (row.stock_uom && row.uom_unit_of_measurement === row.stock_uom) {
		frappe.model.set_value(cdt, cdn, "conversion_factor", 1);
		_compute_stock_qty(frm, cdt, cdn);
		return;
	}

	// DB path: fetch via whitelisted server method (avoids UOM Conversion Detail permission check)
	frappe.call({
		method: "chaizup_toc.chaizup_toc.doctype.sales_projected_items.sales_projected_items.get_uom_conversion_factor",
		args: { item_code: row.item, uom: row.uom_unit_of_measurement },
		callback: function(r) {
			let cf = (r && r.message) ? flt(r.message) : 1;
			frappe.model.set_value(cdt, cdn, "conversion_factor", cf);
			_compute_stock_qty(frm, cdt, cdn);
		}
	});
}

// =============================================================================
// UTILITY: Scan all child rows for duplicate item codes. Shows orange warning
//   msgprint listing each duplicate item and its offending row numbers.
//   Does NOT block the form — Python validate() blocks on save/submit.
// CONTEXT: Called from the item field event (live feedback as user selects items).
// DANGER ZONE:
//   - frm.doc.table_mibv is the child table field name. Must match JSON fieldname.
//   - row.idx is 1-based (Frappe child table convention).
// RESTRICT:
//   - Keep indicator: "orange" (not "red"). Red implies hard error; Python handles that.
// =============================================================================
function _check_duplicate_items(frm) {
	let item_rows = {};
	(frm.doc.table_mibv || []).forEach(function(row) {
		if (!row.item) return;
		if (!item_rows[row.item]) item_rows[row.item] = [];
		item_rows[row.item].push(row.idx);
	});

	let duplicates = Object.entries(item_rows).filter(([, rows]) => rows.length > 1);
	if (!duplicates.length) return;

	let lines = duplicates.map(([item, rows]) =>
		`<b>${item}</b>: rows ${rows.join(", ")}`
	).join("<br>");

	frappe.msgprint({
		title: __("Duplicate Items Detected"),
		message: __(
			"The following items appear more than once in the Projected Items table:<br>"
		) + lines,
		indicator: "orange"
	});
}

// =============================================================================
// UTILITY: Register get_query on the UOM field inside the child table grid.
//   Filters UOM dropdown to show only UOMs valid for the selected item.
//   Calls get_item_uoms() whitelisted function in sales_projected_items.py.
// CONTEXT: Must be called on every refresh — Frappe resets grid field state on reload.
// DANGER ZONE:
//   - "table_mibv" must match the Table field's fieldname in sales_projection.json.
//   - "uom_unit_of_measurement" must match the Link field's fieldname in
//     sales_projected_items.json.
//   - The dotted Python path must match the exact module path to get_item_uoms().
// RESTRICT:
//   - Do not move this into a one-time setup. get_query must survive every page reload.
// =============================================================================
function _setup_uom_query(frm) {
	if (!frm.fields_dict["table_mibv"]) return;
	frm.fields_dict["table_mibv"].grid
		.get_field("uom_unit_of_measurement").get_query = function(doc, cdt, cdn) {
		let row = locals[cdt][cdn];
		return {
			query: "chaizup_toc.chaizup_toc.doctype.sales_projected_items.sales_projected_items.get_item_uoms",
			filters: { item_code: row.item || "" }
		};
	};
}

// =============================================================================
// UTILITY: Show "Run Production Plan Automation" button on the form toolbar.
//   Conditions (ALL must be true):
//     1. Document is submitted (docstatus === 1)
//     2. projection_month + projection_year matches the CURRENT calendar month
//   The server-side function additionally checks:
//     - User has Manufacturing Manager / TOC Manager / System Manager role
//     - enable_projection_automation is ON in TOC Settings
//   If the projection is for a PAST or FUTURE month the button is hidden —
//   automation only makes sense for the current production cycle.
//
// MEMORY:  production_plan_engine.md § Manual Trigger
// DANGER ZONE:
//   - MONTH_NAMES array index must match Frappe Select option order in the JSON
//     (January=0 … December=11). Do NOT sort or reorder this array.
//   - frm.add_custom_button inside refresh() is idempotent — Frappe re-renders
//     the toolbar on every refresh, so duplicate buttons are not a risk.
// RESTRICT:
//   - Do not skip the month+year check. Running automation on a past projection
//     creates Production Plans against stale demand data.
//   - Do not call run_production_plan_automation directly — always use frappe.call
//     so the server-side role guard and settings check fire.
// =============================================================================
var _MONTH_NAMES = [
	"January","February","March","April","May","June",
	"July","August","September","October","November","December"
];

function _add_run_automation_btn(frm) {
	if (frm.doc.docstatus !== 1) return;

	var now = new Date();
	var current_month = _MONTH_NAMES[now.getMonth()];
	var current_year  = now.getFullYear();

	if (frm.doc.projection_month !== current_month ||
		parseInt(frm.doc.projection_year) !== current_year) {
		return; // not the current month — hide button
	}

	frm.add_custom_button(__("Run Production Plan Automation"), function() {
		frappe.confirm(
			__(
				"<b>Production Plan Automation — Current Month</b><br><br>" +
				"This will:<br>" +
				"<ol>" +
				"<li>For each projected item, calculate warehouse-specific demand shortage:<br>" +
				"<code>(Projected Qty + Carryover SOs) − Current Month SOs − Warehouse Stock</code></li>" +
				"<li>If shortage > 0: create a Draft Production Plan for that item</li>" +
				"<li>If 0-forecast but pending SOs exist: also create a Production Plan</li>" +
				"<li>Apply Min Manufacturing Qty floor (from the Minimum Manufacturing section)</li>" +
				"<li>Send an email summary to all configured Notification Users</li>" +
				"</ol>" +
				"<b>Safe to run multiple times</b> — existing Production Plans for the same " +
				"item and projection are detected and skipped to prevent duplicates.<br><br>" +
				"Continue?"
			),
			function() {
				frappe.call({
					method: "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_production_plan_automation",
					args: {
						projection_name: frm.doc.name,
						triggered_by: "manual",
					},
					freeze: true,
					freeze_message: __("Calculating demand shortage and creating Production Plans…"),
					callback: function(r) {
						if (!r.message) return;
						var results = r.message;
						var created = results.filter(function(x) { return x.status === "Created"; });
						var skipped = results.filter(function(x) { return x.status !== "Created"; });

						var rows = results.map(function(res) {
							var icon = res.status === "Created"
								? "<span style='color:#27ae60'>&#10003;</span>"
								: "<span style='color:#e67e22'>&#9888;</span>";
							var pp_link = res.pp_name
								? "<a href='/app/production-plan/" + res.pp_name + "' target='_blank'>" + res.pp_name + "</a>"
								: "—";
							return "<tr>" +
								"<td style='padding:5px 8px;border:1px solid #ddd'>" + icon + "</td>" +
								"<td style='padding:5px 8px;border:1px solid #ddd'>" + (res.item_code || "") + "</td>" +
								"<td style='padding:5px 8px;border:1px solid #ddd'>" + (res.item_name || "") + "</td>" +
								"<td style='padding:5px 8px;border:1px solid #ddd;color:" +
									(res.status === "Created" ? "#27ae60" : "#e67e22") + "'>" + res.status + "</td>" +
								"<td style='padding:5px 8px;border:1px solid #ddd'>" + pp_link + "</td>" +
								"<td style='padding:5px 8px;border:1px solid #ddd;text-align:right'>" +
									(res.production_qty ? res.production_qty.toFixed(2) : "—") + "</td>" +
								"</tr>";
						}).join("");

						frappe.msgprint({
							title: __(
								"PP Automation Complete — " +
								created.length + " PP(s) Created, " +
								skipped.length + " Skipped"
							),
							message: (
								"<table style='border-collapse:collapse;width:100%;font-size:13px'>" +
								"<thead><tr style='background:#f5f5f5'>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'></th>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'>Item Code</th>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'>Item Name</th>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'>Status</th>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'>Production Plan</th>" +
								"<th style='padding:5px 8px;border:1px solid #ddd'>PP Qty</th>" +
								"</tr></thead>" +
								"<tbody>" + rows + "</tbody></table>" +
								"<p style='margin-top:12px;color:#888;font-size:12px'>" +
								"An email summary has been sent to all Notification Users.</p>"
							),
							indicator: created.length > 0 ? "green" : "orange",
						});
						frm.reload_doc();
					},
				});
			},
			function() { /* cancelled */ }
		);
	}, __("Projection Automation"));
}

// =============================================================================
// PARENT FORM EVENTS: Sales Projection
// =============================================================================
frappe.ui.form.on("Sales Projection", {

	// =========================================================================
	// CONTEXT: Re-register UOM get_query on every refresh (required by Frappe).
	//   Also attaches the "Run Projection Automation" button for current-month
	//   submitted projections.
	// =========================================================================
	refresh: function(frm) {
		_setup_uom_query(frm);
		_add_run_automation_btn(frm);
	},

	// =========================================================================
	// CONTEXT: JS-side validate hook — blocks save if duplicates are found.
	//   Python validate() also blocks, but JS gives faster feedback before
	//   the round-trip to the server.
	// DANGER ZONE:
	//   - frappe.validated = false cancels the save attempt in JS only.
	//     Python validate() is the true authority on the server side.
	// =========================================================================
	validate: function(frm) {
		let item_rows = {};
		let has_duplicate = false;

		(frm.doc.table_mibv || []).forEach(function(row) {
			if (!row.item) return;
			if (!item_rows[row.item]) item_rows[row.item] = [];
			item_rows[row.item].push(row.idx);
		});

		Object.values(item_rows).forEach(function(rows) {
			if (rows.length > 1) has_duplicate = true;
		});

		if (has_duplicate) {
			frappe.validated = false;
			_check_duplicate_items(frm);
		}
	}
});

// =============================================================================
// CHILD TABLE EVENTS: Sales Projected Items
// =============================================================================
frappe.ui.form.on("Sales Projected Items", {

	// =========================================================================
	// CONTEXT: Item selected — clear UOM and computed fields, show duplicate warning.
	//   item_name and stock_uom are auto-populated by fetch_from in the JSON;
	//   no JS assignment needed for those two fields.
	// DANGER ZONE:
	//   - Must clear uom_unit_of_measurement when item changes. If left stale,
	//     the previous item's UOM may be invalid for the new item, causing
	//     an incorrect or silent conversion_factor.
	//   - conversion_factor must reset to 1 (not 0) to avoid division errors
	//     in any downstream code that reads this field.
	// RESTRICT:
	//   - Do not remove _check_duplicate_items() call. It gives live orange
	//     warning as the user adds rows, before they attempt to save.
	// =========================================================================
	item: function(frm, cdt, cdn) {
		frappe.model.set_value(cdt, cdn, "uom_unit_of_measurement", "");
		frappe.model.set_value(cdt, cdn, "conversion_factor", 1);
		frappe.model.set_value(cdt, cdn, "qty_in_stock_uom", 0);
		frm.refresh_field("table_mibv");
		_check_duplicate_items(frm);
	},

	// =========================================================================
	// CONTEXT: UOM selected — fetch conversion_factor, then recompute stock qty.
	// RESTRICT: Use _fetch_conversion_factor() — do not inline. It handles the
	//   stock_uom == uom fast path and the DB fallback in one place.
	// =========================================================================
	uom_unit_of_measurement: function(frm, cdt, cdn) {
		_fetch_conversion_factor(frm, cdt, cdn);
	},

	// =========================================================================
	// CONTEXT: Qty changed — recompute qty_in_stock_uom immediately.
	// =========================================================================
	qty: function(frm, cdt, cdn) {
		_compute_stock_qty(frm, cdt, cdn);
	},

	// =========================================================================
	// CONTEXT: conversion_factor changed (set programmatically by
	//   _fetch_conversion_factor) — trigger qty_in_stock_uom recompute.
	// RESTRICT: Do not remove. This event fires after _fetch_conversion_factor
	//   calls frappe.model.set_value("conversion_factor", ...), ensuring
	//   qty_in_stock_uom is always in sync.
	// =========================================================================
	conversion_factor: function(frm, cdt, cdn) {
		_compute_stock_qty(frm, cdt, cdn);
	}
});
