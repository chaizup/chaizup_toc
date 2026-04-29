"""
Buffer Status Report — Historical Trend View
==============================================
Shows buffer penetration trends over time from TOC Buffer Log.
Used for DBM analysis and management review.
"""

import frappe
from frappe import _
from frappe.utils import add_days, today, getdate


def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    chart = get_chart(data, filters)
    summary = get_summary(data)
    return columns, data, None, chart, summary


def get_columns():
    return [
        {"fieldname": "log_date", "label": _("Date"), "fieldtype": "Date", "width": 100},
        {"fieldname": "item_code", "label": _("Item"), "fieldtype": "Link", "options": "Item", "width": 140},
        {"fieldname": "item_name", "label": _("Item Name"), "fieldtype": "Data", "width": 160},
        {"fieldname": "stock_uom", "label": _("UOM"), "fieldtype": "Link", "options": "UOM", "width": 60},
        {"fieldname": "warehouse", "label": _("Warehouse"), "fieldtype": "Link", "options": "Warehouse", "width": 140},
        {"fieldname": "buffer_type", "label": _("Mode"), "fieldtype": "Data", "width": 90},
        {"fieldname": "target_buffer", "label": _("Target<br><small>F1</small>"), "fieldtype": "Float", "width": 90},
        {"fieldname": "on_hand_qty", "label": _("On-Hand"), "fieldtype": "Float", "width": 80},
        {"fieldname": "wip_qty", "label": _("WIP"), "fieldtype": "Float", "width": 80},
        {"fieldname": "inventory_position", "label": _("IP<br><small>F2</small>"), "fieldtype": "Float", "width": 80},
        {"fieldname": "buffer_penetration_pct", "label": _("BP%<br><small>F3</small>"), "fieldtype": "Percent", "width": 80},
        {"fieldname": "zone", "label": _("Zone"), "fieldtype": "Data", "width": 80},
        {"fieldname": "order_qty_suggested", "label": _("Suggested Qty<br><small>F4</small>"), "fieldtype": "Float", "width": 100},
        {"fieldname": "mr_created", "label": _("MR Created"), "fieldtype": "Link", "options": "Material Request", "width": 130},
    ]


def get_data(filters):
    conditions = "1=1"
    values = {}

    if filters:
        if filters.get("item_code"):
            conditions += " AND tbl.item_code = %(item_code)s"
            values["item_code"] = filters["item_code"]
        if filters.get("warehouse"):
            conditions += " AND tbl.warehouse = %(warehouse)s"
            values["warehouse"] = filters["warehouse"]
        if filters.get("zone"):
            conditions += " AND tbl.zone = %(zone)s"
            values["zone"] = filters["zone"]
        if filters.get("from_date"):
            conditions += " AND tbl.log_date >= %(from_date)s"
            values["from_date"] = filters["from_date"]
        if filters.get("to_date"):
            conditions += " AND tbl.log_date <= %(to_date)s"
            values["to_date"] = filters["to_date"]

    return frappe.db.sql(f"""
        SELECT tbl.log_date, tbl.item_code,
            i.item_name, i.stock_uom,
            tbl.warehouse, tbl.buffer_type, tbl.target_buffer,
            tbl.on_hand_qty, tbl.wip_qty, tbl.inventory_position,
            tbl.buffer_penetration_pct, tbl.zone,
            tbl.order_qty_suggested, tbl.mr_created
        FROM `tabTOC Buffer Log` tbl
        LEFT JOIN `tabItem` i ON i.name = tbl.item_code
        WHERE {conditions}
        ORDER BY tbl.log_date DESC, tbl.buffer_penetration_pct DESC
        LIMIT 500
    """, values, as_dict=True)


def get_chart(data, filters):
    if not data or not filters or not filters.get("item_code"):
        return None

    # Time series of BP% for selected item
    dates = sorted(set(d.log_date for d in data))[-30:]  # Last 30 entries
    bp_values = []
    for date in dates:
        rows = [d for d in data if d.log_date == date]
        bp_values.append(rows[0].buffer_penetration_pct if rows else 0)

    return {
        "data": {
            "labels": [str(d) for d in dates],
            "datasets": [{"name": "BP%", "values": bp_values}]
        },
        "type": "line",
        "colors": ["#E74C3C"],
        "height": 250,
        "axisOptions": {"xIsSeries": True},
    }


def get_summary(data):
    if not data:
        return []
    zones = {}
    for d in data[:50]:  # Use recent entries
        zones[d.zone] = zones.get(d.zone, 0) + 1
    return [
        {"value": zones.get("Red", 0) + zones.get("Black", 0), "label": "Red/Black Entries", "indicator": "red"},
        {"value": zones.get("Yellow", 0), "label": "Yellow Entries", "indicator": "orange"},
        {"value": zones.get("Green", 0), "label": "Green Entries", "indicator": "green"},
    ]
