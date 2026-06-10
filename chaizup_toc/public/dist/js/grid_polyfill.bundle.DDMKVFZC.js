(() => {
  // ../chaizup_toc/chaizup_toc/public/js/grid_polyfill.bundle.js
  var gridPatched = false;
  function patchGridProto(grid) {
    if (gridPatched)
      return;
    const proto = Object.getPrototypeOf(grid);
    if (typeof proto.set_column_disp_in_list_view === "function") {
      gridPatched = true;
      return;
    }
    const _origSetupFields = proto.setup_fields;
    proto.setup_fields = function() {
      _origSetupFields.apply(this, arguments);
      const overrides = this.column_disp_overrides;
      if (!overrides || !Object.keys(overrides).length)
        return;
      this.docfields = this.docfields.map((df) => {
        if (!(df.fieldname in overrides))
          return df;
        return Object.assign({}, df, { hidden: overrides[df.fieldname] });
      });
    };
    proto.set_column_disp_in_list_view = function(fieldname, show) {
      if (!this.column_disp_overrides) {
        this.column_disp_overrides = {};
      }
      const fieldnames = Array.isArray(fieldname) ? fieldname : [fieldname];
      for (const fn of fieldnames) {
        this.column_disp_overrides[fn] = show ? 0 : 1;
      }
      this.visible_columns = [];
      this.grid_rows = [];
      $(this.parent).find(".grid-body .grid-row").remove();
      this.debounced_refresh();
    };
    gridPatched = true;
  }
  var _origSetup = frappe.ui.form.ScriptManager.prototype.setup;
  frappe.ui.form.ScriptManager.prototype.setup = function() {
    if (!gridPatched && this.frm && this.frm.fields_dict) {
      const fields = this.frm.fields_dict;
      for (const key in fields) {
        if (fields[key] && fields[key].grid) {
          patchGridProto(fields[key].grid);
          break;
        }
      }
    }
    return _origSetup.apply(this, arguments);
  };
})();
//# sourceMappingURL=grid_polyfill.bundle.DDMKVFZC.js.map
