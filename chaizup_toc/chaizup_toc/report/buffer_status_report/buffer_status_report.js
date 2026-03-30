frappe.query_reports["Buffer Status Report"] = {
    filters: [
        {fieldname: "item_code", label: __("Item"), fieldtype: "Link", options: "Item",
         get_query: () => ({filters: {custom_toc_enabled: 1}})},
        {fieldname: "warehouse", label: __("Warehouse"), fieldtype: "Link", options: "Warehouse"},
        {fieldname: "zone", label: __("Zone"), fieldtype: "Select",
         options: "\nGreen\nYellow\nRed\nBlack"},
        {fieldname: "from_date", label: __("From Date"), fieldtype: "Date",
         default: frappe.datetime.add_days(frappe.datetime.get_today(), -30)},
        {fieldname: "to_date", label: __("To Date"), fieldtype: "Date",
         default: frappe.datetime.get_today()},
    ],
    formatter(value, row, column, data, default_formatter) {
        value = default_formatter(value, row, column, data);
        if (data && column.fieldname === "zone") {
            let colors = {Green:"#27AE60", Yellow:"#F39C12", Red:"#E74C3C", Black:"#2C3E50"};
            let bgs = {Green:"#D5F5E3", Yellow:"#FEF9E7", Red:"#FADBD8", Black:"#D5D8DC"};
            value = `<span style="background:${bgs[data.zone]||'#FFF'};color:${colors[data.zone]||'#777'};padding:3px 10px;border-radius:12px;font-weight:bold;font-size:11px">${data.zone}</span>`;
        }
        if (data && column.fieldname === "buffer_penetration_pct" && data.buffer_penetration_pct >= 67) {
            value = `<span style="color:#E74C3C;font-weight:bold">${data.buffer_penetration_pct}%</span>`;
        }
        return value;
    },
};
