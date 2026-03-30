"""
TOC Material Request Generator
===============================
Creates MRs based on buffer penetration analysis.
Replaces erpnext.stock.reorder_item.reorder_item()

Key difference from default ERPNext:
  Default: static reorder_level → fixed reorder_qty
  TOC:     dynamic BP% zones → exact (Target − IP) quantity, priority-sorted
"""

import frappe
from frappe.utils import flt, today, add_days, cint
from frappe import _


def generate_material_requests(buffer_type=None, zone_filter=None, company=None):
    """
    Main entry point. Creates Material Requests for actionable zones.

    Args:
        buffer_type: 'FG', 'RM', 'PM', 'SFG' or None (all)
        zone_filter: list of zones e.g. ['Red', 'Black'] or None (from settings)
        company: filter by company

    Returns:
        list of created Material Request names
    """
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers

    settings = frappe.get_cached_doc("TOC Settings")
    if not cint(settings.auto_generate_mr):
        frappe.logger("chaizup_toc").info("MR generation skipped — auto_generate_mr is OFF in TOC Settings")
        return []

    buffers = calculate_all_buffers(buffer_type=buffer_type, company=company)

    # Determine which zones to act on
    if not zone_filter:
        if settings.mr_zones == "Red and Black Only":
            zone_filter = ["Red", "Black"]
        else:
            zone_filter = ["Red", "Black", "Yellow"]

    actionable = [b for b in buffers if b["zone"] in zone_filter and b["order_qty"] > 0]

    created_mrs = []
    errors = []

    for item_data in actionable:
        try:
            # Skip if open MR already exists
            if _has_open_mr(item_data["item_code"], item_data["warehouse"], item_data["mr_type"]):
                continue

            # For FG items with SFG dependency — check SFG availability
            if item_data.get("sfg_status") and not item_data["sfg_status"]["available"]:
                # Create MR for SFG blending first if SFG is also in this batch
                frappe.logger("chaizup_toc").info(
                    f"SFG shortfall for {item_data['item_code']}: "
                    f"{item_data['sfg_status']['message']}")

            mr_name = _create_mr(item_data, settings)
            if mr_name:
                _log_snapshot(item_data, mr_name)
                created_mrs.append(mr_name)

        except Exception:
            errors.append(item_data["item_code"])
            frappe.log_error(frappe.get_traceback(),
                f"TOC MR Error: {item_data['item_code']}")

    frappe.db.commit()

    # Send Red zone email alerts
    if cint(settings.notify_on_red):
        _send_alerts(
            [b for b in actionable if b["zone"] in ("Red", "Black") and b["item_code"] not in errors],
            created_mrs, settings)

    frappe.logger("chaizup_toc").info(
        f"TOC MR Generation: {len(created_mrs)} created, {len(errors)} errors, "
        f"{len(actionable) - len(created_mrs) - len(errors)} skipped (existing MR)")

    return created_mrs


def _has_open_mr(item_code, warehouse, mr_type):
    """Check for existing draft/submitted MR for this item+warehouse."""
    return frappe.db.sql("""
        SELECT mr.name FROM `tabMaterial Request` mr
        JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
        WHERE mr.docstatus < 2
        AND mr.material_request_type = %s
        AND mr.status NOT IN ('Stopped', 'Cancelled')
        AND mri.item_code = %s AND mri.warehouse = %s
        LIMIT 1
    """, (mr_type, item_code, warehouse))


def _create_mr(data, settings):
    """Create a single Material Request from buffer data."""
    mr = frappe.new_doc("Material Request")
    mr.material_request_type = data["mr_type"]
    mr.transaction_date = today()
    mr.company = data.get("company") or frappe.db.get_value("Warehouse", data["warehouse"], "company")
    mr.schedule_date = add_days(today(), max(1, int(data.get("rlt") or 3)))

    # TOC metadata fields
    mr.custom_toc_recorded_by = "By System"
    mr.custom_toc_zone = data["zone"]
    mr.custom_toc_bp_pct = data["bp_pct"]
    mr.custom_toc_target_buffer = data["target_buffer"]
    mr.custom_toc_inventory_position = data["inventory_position"]
    mr.custom_toc_sr_pct = data["sr_pct"]

    mr.append("items", {
        "item_code": data["item_code"],
        "item_name": data["item_name"],
        "qty": data["order_qty"],
        "uom": data["stock_uom"],
        "stock_uom": data["stock_uom"],
        "warehouse": data["warehouse"],
        "schedule_date": mr.schedule_date,
        "description": (
            f"TOC Replenishment | Zone: {data['zone']} | "
            f"BP: {data['bp_pct']}% | Target: {data['target_buffer']} | "
            f"IP: {data['inventory_position']} | "
            f"Formula: F4 Order Qty = {data['target_buffer']} − {data['inventory_position']} = {data['order_qty']}"
        ),
    })

    mr.flags.ignore_permissions = True
    mr.insert()

    frappe.logger("chaizup_toc").info(
        f"MR {mr.name}: {data['item_code']} | {data['zone']} | "
        f"BP:{data['bp_pct']}% | Qty:{data['order_qty']} | {data['mr_type']}")

    return mr.name


def _log_snapshot(data, mr_name):
    """Record buffer state in TOC Buffer Log for DBM analysis."""
    try:
        log = frappe.new_doc("TOC Buffer Log")
        log.item_code = data["item_code"]
        log.warehouse = data["warehouse"]
        log.log_date = today()
        log.buffer_type = data["buffer_type"]
        log.company = data.get("company")
        log.on_hand_qty = data.get("on_hand", 0)
        log.wip_qty = data.get("wip_or_on_order", 0)
        log.reserved_qty = data.get("backorders_or_committed", 0)
        log.inventory_position = data["inventory_position"]
        log.target_buffer = data["target_buffer"]
        log.buffer_penetration_pct = data["bp_pct"]
        log.stock_remaining_pct = data["sr_pct"]
        log.zone = data["zone"]
        log.order_qty_suggested = data["order_qty"]
        log.mr_created = mr_name
        log.flags.ignore_permissions = True
        log.insert()
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"TOC Log Error: {data['item_code']}")


def _send_alerts(red_items, created_mrs, settings):
    """Send email alerts for Red/Black zone items."""
    if not red_items:
        return

    try:
        # Get recipients from roles
        roles = (settings.red_alert_roles or "Stock Manager").split("\n")
        recipients = set()
        for role in roles:
            role = role.strip()
            if role:
                users = frappe.get_all("Has Role",
                    filters={"role": role, "parenttype": "User"},
                    fields=["parent"], limit=20)
                for u in users:
                    if frappe.utils.validate_email_address(u.parent):
                        recipients.add(u.parent)

        if not recipients:
            return

        rows = "".join(
            f"<tr style='color:{item['zone_color']}'>"
            f"<td><b>{item['item_code']}</b></td>"
            f"<td>{item['item_name']}</td>"
            f"<td>{item['zone']}</td>"
            f"<td><b>{item['bp_pct']}%</b></td>"
            f"<td>{item['order_qty']}</td>"
            f"<td>{item['zone_action']}</td></tr>"
            for item in red_items
        )

        frappe.sendmail(
            recipients=list(recipients),
            subject=f"🔴 TOC Alert: {len(red_items)} items in Red/Black zone — {today()}",
            message=f"""
            <h3 style="color:#E74C3C">TOC Buffer Alert — Immediate Action Required</h3>
            <table border="1" cellpadding="8" style="border-collapse:collapse;font-size:13px">
            <tr style="background:#1B4F72;color:white">
                <th>Item</th><th>Name</th><th>Zone</th><th>BP%</th><th>Order Qty</th><th>Action</th>
            </tr>{rows}</table>
            <p style="color:#7F8C8D;font-size:12px;margin-top:16px">
            Generated by Chaizup TOC Buffer Management at {frappe.utils.now_datetime()}<br>
            {len(created_mrs)} Material Requests created.
            </p>""",
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Alert Email Failed")
