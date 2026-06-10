/**
 * Grid.set_column_disp_in_list_view — Frappe/ERPNext compat polyfill
 * ═══════════════════════════════════════════════════════════════════
 *
 * PROBLEM:
 *   ERPNext v16.22.0 (commit 3f983c9e4d) added calls to
 *   grid.set_column_disp_in_list_view() in work_order.js (line 91-92).
 *   The corresponding Frappe method (commit cd5b9ad9bd) has NOT been
 *   merged to the Frappe v16 release branch. Result: Work Order form
 *   renders blank with TypeError.
 *
 * FIX:
 *   Monkey-patch Grid.prototype with the missing method + supporting
 *   infrastructure (column_disp_overrides map, setup_fields wrapper).
 *
 * STRATEGY:
 *   Grid is an ES module — NOT accessible via frappe.ui.form.Grid.
 *   Instead, we wrap ScriptManager.prototype.setup (which IS global,
 *   defined in form.bundle.js). On the first form that has a Table
 *   field, we grab Grid.prototype from the grid instance and patch it.
 *   This runs BEFORE the "setup" event fires (line 259 of script_manager.js),
 *   so ERPNext's work_order.js handler finds the method in place.
 *
 * LOADING:
 *   hooks.py → app_include_js → "grid_polyfill.bundle.js"
 *   esbuild compiles to: assets/chaizup_toc/dist/js/grid_polyfill.bundle.HASH.js
 *   Loaded as <script> tag on every desk page, AFTER form.bundle.js.
 *
 * LIFECYCLE:
 *   1. Desk page loads → this bundle executes → wraps ScriptManager.setup
 *   2. User opens any form → form.setup() calls setup_std_layout() (creates grids)
 *   3. form.setup() calls script_manager.setup() → OUR WRAPPER runs first
 *   4. Wrapper finds a grid instance → patches Grid.prototype (once)
 *   5. Original setup() fires "setup" event → ERPNext handler works
 *
 * SELF-HEALING:
 *   If Frappe later ships set_column_disp_in_list_view natively, the
 *   patchGridProto() check at line 19 detects it and skips patching.
 *   The ScriptManager wrapper remains but is a no-op (gridPatched=true).
 *
 * ── RESTRICTIONS ──────────────────────────────────────────────────
 *   - Do NOT import Grid directly — esbuild creates a separate copy
 *     that won't affect Frappe's actual Grid instances.
 *   - Do NOT use frappe.ui.form.Grid — it doesn't exist (ES module).
 *   - Do NOT move this to doctype_js — it must run before ALL forms,
 *     not just Work Order (the method could be used by other DocTypes).
 *   - Do NOT remove until Frappe v16 officially ships the method.
 *     Check: grep "set_column_disp_in_list_view" in frappe/public/js/frappe/form/grid.js
 * ──────────────────────────────────────────────────────────────────
 */

let gridPatched = false;

/**
 * Patch Grid.prototype with set_column_disp_in_list_view and its dependencies.
 * Called once, on the first form that has a Table field.
 *
 * @param {Object} grid - Any grid instance (used to access Grid.prototype)
 */
function patchGridProto(grid) {
	if (gridPatched) return;
	const proto = Object.getPrototypeOf(grid);

	// Self-healing: if Frappe already ships the method, skip patching
	if (typeof proto.set_column_disp_in_list_view === "function") {
		gridPatched = true;
		return;
	}

	// ── 1. Wrap setup_fields ─────────────────────────────────────
	// After Frappe populates this.docfields, apply any per-grid
	// column visibility overrides. Uses shallow copies to avoid
	// mutating shared meta docfields.
	const _origSetupFields = proto.setup_fields;
	proto.setup_fields = function () {
		_origSetupFields.apply(this, arguments);

		const overrides = this.column_disp_overrides;
		if (!overrides || !Object.keys(overrides).length) return;

		this.docfields = this.docfields.map((df) => {
			if (!(df.fieldname in overrides)) return df;
			return Object.assign({}, df, { hidden: overrides[df.fieldname] });
		});
	};

	// ── 2. Add the missing method ────────────────────────────────
	// Grid-local way to show/hide a column in the grid's list view
	// without mutating the shared meta docfield. Two grids of the
	// same child doctype on the same form won't affect each other.
	//
	// Matches the upstream Frappe implementation (commit cd5b9ad9bd).
	proto.set_column_disp_in_list_view = function (fieldname, show) {
		if (!this.column_disp_overrides) {
			this.column_disp_overrides = {};
		}

		const fieldnames = Array.isArray(fieldname) ? fieldname : [fieldname];
		for (const fn of fieldnames) {
			// hidden=1 means NOT shown, so invert the `show` flag
			this.column_disp_overrides[fn] = show ? 0 : 1;
		}

		// Tear down cached column layout and rendered rows so the
		// grid rebuilds with correct column widths
		this.visible_columns = [];
		this.grid_rows = [];
		$(this.parent).find(".grid-body .grid-row").remove();

		this.debounced_refresh();
	};

	gridPatched = true;
}

// ── ScriptManager.setup wrapper ──────────────────────────────────
// ScriptManager.prototype.setup is defined in form.bundle.js which
// loads BEFORE this bundle (see app_include_js order in hooks output).
//
// form.js lifecycle:
//   setup_std_layout()          → creates controls/grids (line 111)
//   new ScriptManager({frm})   → line 114
//   script_manager.setup()     → line 117 (OUR WRAPPER intercepts here)
//     └─ this.trigger("setup") → line 259 (ERPNext handlers fire here)
const _origSetup = frappe.ui.form.ScriptManager.prototype.setup;
frappe.ui.form.ScriptManager.prototype.setup = function () {
	if (!gridPatched && this.frm && this.frm.fields_dict) {
		const fields = this.frm.fields_dict;
		for (const key in fields) {
			if (fields[key] && fields[key].grid) {
				patchGridProto(fields[key].grid);
				break; // one patch covers the entire Grid.prototype
			}
		}
	}
	return _origSetup.apply(this, arguments);
};
