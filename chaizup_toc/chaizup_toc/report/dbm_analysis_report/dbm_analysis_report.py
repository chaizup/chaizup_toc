"""DBM Analysis — Shows TMR/TMG trigger history and buffer size changes over time."""
import frappe
from frappe import _
from frappe.utils import add_days, today

def execute(filters=None):
    columns = [
        {"fieldname":"item_code","label":"Item","fieldtype":"Link","options":"Item","width":140},
        {"fieldname":"warehouse","label":"Warehouse","fieldtype":"Link","options":"Warehouse","width":140},
        {"fieldname":"current_target","label":"Current Target (F1)","fieldtype":"Float","width":110},
        {"fieldname":"adu","label":"ADU","fieldtype":"Float","width":70},
        {"fieldname":"rlt","label":"RLT","fieldtype":"Float","width":70},
        {"fieldname":"vf","label":"VF","fieldtype":"Float","width":60},
        {"fieldname":"tmr_count","label":"TMR Count (F7)","fieldtype":"Int","width":100},
        {"fieldname":"tmg_green_days","label":"Green Days (F8)","fieldtype":"Int","width":100},
        {"fieldname":"last_dbm_date","label":"Last DBM Check","fieldtype":"Date","width":110},
        {"fieldname":"red_pct","label":"% Days in Red","fieldtype":"Percent","width":100},
        {"fieldname":"green_pct","label":"% Days in Green","fieldtype":"Percent","width":100},
        {"fieldname":"status","label":"DBM Status","fieldtype":"Data","width":140},
    ]

    items = frappe.get_all("Item", filters={"custom_toc_enabled":1}, fields=["name"])
    data = []
    for item in items:
        rules = frappe.get_all("TOC Item Buffer",
            filters={"parent":item.name,"enabled":1},fields=["*"])
        for r in rules:
            # Get last 30 days of logs
            logs = frappe.get_all("TOC Buffer Log",
                filters={"item_code":item.name,"warehouse":r.warehouse,
                    "log_date":[">=",add_days(today(),-30)]},
                fields=["zone"])
            total = len(logs) or 1
            red = len([l for l in logs if l.zone in ("Red","Black")])
            green = len([l for l in logs if l.zone == "Green"])
            status = "Normal"
            if r.tmr_count and r.tmr_count >= 3: status = "⚠️ TMR Safeguard Hit"
            elif red/total > 0.3: status = "🔴 Trending Red — TMR likely"
            elif green/total > 0.8: status = "🟢 Trending Green — TMG possible"
            data.append({"item_code":item.name,"warehouse":r.warehouse,
                "current_target":r.target_buffer,"adu":r.adu,"rlt":r.rlt,"vf":r.variability_factor,
                "tmr_count":r.tmr_count,"tmg_green_days":r.tmg_green_days,
                "last_dbm_date":r.last_dbm_date,"red_pct":round(red/total*100,1),
                "green_pct":round(green/total*100,1),"status":status})
    return columns, data
