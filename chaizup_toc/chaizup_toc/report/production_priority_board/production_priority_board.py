"""
Production Priority Board — Script Report
===========================================
THE daily report. Every morning at 7:00 AM the supervisor opens this.
Shows ALL TOC-enabled items sorted by Buffer Penetration % — highest urgency first.
No item-type filter — every item is shown regardless of category.

Formulas shown in every row:
  F2: IP = On-Hand + WIP − Backorders
  F3: BP% = (Target − IP) ÷ Target × 100
  F4: Order Qty = Target − IP
  F5: T/CU for tie-breaking (manufactured items)
"""

import frappe
from frappe import _
from frappe.utils import flt


def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data)
    summary = get_summary(data)

    return columns, data, None, chart, summary


def get_columns():
    return [
        {"fieldname": "rank", "label": _("Rank"), "fieldtype": "Int", "width": 60},
        {"fieldname": "item_code", "label": _("Item Code"), "fieldtype": "Link",
         "options": "Item", "width": 140},
        {"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 180},
        {"fieldname": "stock_uom", "label": _("UOM"), "fieldtype": "Link",
         "options": "UOM", "width": 60},
        {"fieldname": "buffer_type", "label": _("Mode"), "fieldtype": "Data", "width": 90},
        {"fieldname": "warehouse", "label": _("Warehouse"), "fieldtype": "Link",
         "options": "Warehouse", "width": 140},
        {"fieldname": "target_buffer", "label": _("Target Buffer<br><small>F1: ADU×RLT×VF</small>"),
         "fieldtype": "Float", "width": 120},
        {"fieldname": "on_hand", "label": _("On-Hand"), "fieldtype": "Float", "width": 90},
        {"fieldname": "wip_or_on_order", "label": _("WIP/On-Order"), "fieldtype": "Float", "width": 100},
        {"fieldname": "backorders_or_committed", "label": _("Backorders/<br>Committed"),
         "fieldtype": "Float", "width": 100},
        {"fieldname": "inventory_position", "label": _("IP<br><small>F2: OH+WIP−BO</small>"),
         "fieldtype": "Float", "width": 100},
        {"fieldname": "bp_pct", "label": _("BP%<br><small>F3: (T−IP)÷T</small>"),
         "fieldtype": "Percent", "width": 100},
        {"fieldname": "sr_pct", "label": _("SR%<br><small>IP÷Target</small>"),
         "fieldtype": "Percent", "width": 80},
        {"fieldname": "zone", "label": _("Zone"), "fieldtype": "Data", "width": 80},
        {"fieldname": "order_qty", "label": _("Order Qty<br><small>F4: Target−IP</small>"),
         "fieldtype": "Float", "width": 110},
        {"fieldname": "tcu", "label": _("T/CU<br><small>F5: ₹/min</small>"),
         "fieldtype": "Currency", "width": 100},
        {"fieldname": "zone_action", "label": _("Action"), "fieldtype": "Data", "width": 150},
        {"fieldname": "sfg_message", "label": _("SFG Status"), "fieldtype": "Data", "width": 180},
    ]


def get_data(filters):
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers

    kwargs = {}
    if filters:
        for k in ("company", "warehouse", "item_code"):
            if filters.get(k):
                kwargs[k] = filters[k]

    buffers = calculate_all_buffers(**kwargs)

    if filters and filters.get("zone"):
        buffers = [b for b in buffers if b["zone"] == filters["zone"]]

    if filters and filters.get("buffer_type"):
        buffers = [b for b in buffers if b.get("buffer_type") == filters["buffer_type"]]

    data = []
    for i, b in enumerate(buffers):
        data.append({
            "rank": i + 1,
            "item_code": b["item_code"],
            "item_name": b["item_name"],
            "stock_uom": b.get("stock_uom", ""),
            "buffer_type": b["buffer_type"],
            "warehouse": b["warehouse"],
            "target_buffer": b["target_buffer"],
            "on_hand": b["on_hand"],
            "wip_or_on_order": b["wip_or_on_order"],
            "backorders_or_committed": b["backorders_or_committed"],
            "inventory_position": b["inventory_position"],
            "bp_pct": b["bp_pct"],
            "sr_pct": b["sr_pct"],
            "zone": b["zone"],
            "order_qty": b["order_qty"],
            "tcu": b["tcu"],
            "zone_action": b["zone_action"],
            "sfg_message": b.get("sfg_status", {}).get("message", "") if b.get("sfg_status") else "",
        })

    return data


def get_chart(data):
    """Zone distribution pie chart."""
    if not data:
        return None

    zone_counts = {"Green": 0, "Yellow": 0, "Red": 0, "Black": 0}
    for d in data:
        zone_counts[d["zone"]] = zone_counts.get(d["zone"], 0) + 1

    return {
        "data": {
            "labels": list(zone_counts.keys()),
            "datasets": [{"name": "Items", "values": list(zone_counts.values())}]
        },
        "type": "pie",
        "colors": ["#27AE60", "#F39C12", "#E74C3C", "#2C3E50"],
        "height": 280,
    }


def get_summary(data):
    """Summary cards at the top of the report."""
    if not data:
        return []

    total = len(data)
    red = len([d for d in data if d["zone"] in ("Red", "Black")])
    yellow = len([d for d in data if d["zone"] == "Yellow"])
    green = len([d for d in data if d["zone"] == "Green"])
    avg_bp = round(sum(d["bp_pct"] for d in data) / total, 1) if total else 0

    return [
        {"value": total, "label": _("Total Buffers"), "datatype": "Int", "indicator": "blue"},
        {"value": red, "label": _("Red/Black (Urgent)"), "datatype": "Int", "indicator": "red"},
        {"value": yellow, "label": _("Yellow (Plan)"), "datatype": "Int", "indicator": "orange"},
        {"value": green, "label": _("Green (OK)"), "datatype": "Int", "indicator": "green"},
        {"value": avg_bp, "label": _("Avg BP%"), "datatype": "Percent", "indicator": "blue"},
    ]
