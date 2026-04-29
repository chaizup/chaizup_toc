"""Procurement Action List — Purchase-mode items only (auto_purchase=1)."""
import frappe
from frappe import _

def execute(filters=None):
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
    kwargs = {}
    if filters:
        for k in ("company","warehouse","item_code"):
            if filters.get(k): kwargs[k] = filters[k]
    all_buffers = calculate_all_buffers(**kwargs)
    buffers = sorted([b for b in all_buffers if b["mr_type"] == "Purchase"], key=lambda x: -x["bp_pct"])
    if filters and filters.get("zone"):
        buffers = [b for b in buffers if b["zone"] == filters["zone"]]

    columns = [
        {"fieldname":"rank","label":"#","fieldtype":"Int","width":50},
        {"fieldname":"item_code","label":"Material","fieldtype":"Link","options":"Item","width":140},
        {"fieldname":"item_name","label":"Name","fieldtype":"Data","width":170},
        {"fieldname":"stock_uom","label":"UOM","fieldtype":"Link","options":"UOM","width":60},
        {"fieldname":"buffer_type","label":"Mode","fieldtype":"Data","width":90},
        {"fieldname":"target_buffer","label":"Target (F1)","fieldtype":"Float","width":90},
        {"fieldname":"on_hand","label":"On-Hand","fieldtype":"Float","width":80},
        {"fieldname":"on_order","label":"On-Order","fieldtype":"Float","width":80},
        {"fieldname":"committed","label":"Committed","fieldtype":"Float","width":80},
        {"fieldname":"ip","label":"IP (F2)","fieldtype":"Float","width":80},
        {"fieldname":"bp_pct","label":"BP% (F3)","fieldtype":"Percent","width":80},
        {"fieldname":"zone","label":"Zone","fieldtype":"Data","width":80},
        {"fieldname":"po_qty","label":"PO Qty (F4)","fieldtype":"Float","width":100},
        {"fieldname":"freight","label":"Freight","fieldtype":"Data","width":110},
        {"fieldname":"action","label":"Action","fieldtype":"Data","width":160},
    ]
    data = []
    for i, b in enumerate(buffers):
        freight = {"Green":"N/A","Yellow":"Standard","Red":"Express/Air","Black":"EMERGENCY"}
        data.append({"rank":i+1,"item_code":b["item_code"],"item_name":b["item_name"],
            "stock_uom":b.get("stock_uom",""),"buffer_type":b["buffer_type"],"target_buffer":b["target_buffer"],
            "on_hand":b["on_hand"],"on_order":b.get("wip_or_on_order",0),
            "committed":b.get("backorders_or_committed",0),"ip":b["inventory_position"],
            "bp_pct":b["bp_pct"],"zone":b["zone"],"po_qty":b["order_qty"],
            "freight":freight.get(b["zone"],""),"action":b["zone_action"]})
    red = len([d for d in data if d["zone"] in ("Red","Black")])
    summary = [{"value":len(data),"label":"Total","indicator":"blue"},{"value":red,"label":"Urgent","indicator":"red"}]
    return columns, data, None, None, summary
