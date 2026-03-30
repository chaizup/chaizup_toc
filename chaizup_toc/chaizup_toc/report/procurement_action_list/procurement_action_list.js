frappe.query_reports["Procurement Action List"] = {
    filters: [
        {fieldname:"company",label:__("Company"),fieldtype:"Link",options:"Company",default:frappe.defaults.get_user_default("Company")},
        {fieldname:"warehouse",label:__("Warehouse"),fieldtype:"Link",options:"Warehouse"},
        {fieldname:"zone",label:__("Zone"),fieldtype:"Select",options:"\nGreen\nYellow\nRed\nBlack"},
        {fieldname:"item_code",label:__("Material"),fieldtype:"Link",options:"Item"},
    ],
    formatter(value,row,column,data,df){
        value=df(value,row,column,data);
        if(data&&column.fieldname==="zone"){
            let c={Green:"#27AE60",Yellow:"#F39C12",Red:"#E74C3C",Black:"#2C3E50"}[data.zone]||"#777";
            let bg={Green:"#D5F5E3",Yellow:"#FEF9E7",Red:"#FADBD8",Black:"#D5D8DC"}[data.zone]||"#FFF";
            value=`<span style="background:${bg};color:${c};padding:3px 10px;border-radius:12px;font-weight:bold;font-size:11px">${data.zone}</span>`;
        }
        return value;
    },
};