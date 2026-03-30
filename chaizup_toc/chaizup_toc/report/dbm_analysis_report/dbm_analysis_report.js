frappe.query_reports["DBM Analysis Report"] = {
    filters: [],
    formatter(value,row,column,data,df){
        value=df(value,row,column,data);
        if(data&&column.fieldname==="status"&&data.status.includes("TMR")){
            value=`<span style="color:#E74C3C;font-weight:bold">${data.status}</span>`;
        }
        return value;
    },
};