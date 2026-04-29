# =============================================================================
# CONTEXT: TOC Material Request Generator — routes buffer-triggered replenishment.
#   Creates Material Requests (Purchase mode) or Production Plans (Manufacture mode)
#   based on buffer penetration analysis from buffer_calculator.calculate_all_buffers().
#   Replaces ERPNext's static reorder_level logic with dynamic TOC zone-based ordering.
# MEMORY: toc_engine.md (same folder)
#
# INSTRUCTIONS:
#   - generate_material_requests: main entry point. Reads TOC Settings for zone thresholds.
#     Routes each actionable buffer item to _create_mr (Purchase) or
#     _create_buffer_production_plan (Manufacture).
#   - _create_mr: builds a Material Request. For Purchase-mode items, uses purchase_uom
#     (e.g., KG) with conversion_factor so the MR shows supplier-friendly units.
#     order_qty is always in stock_uom — divide by conversion_factor to get purchase qty.
#   - _log_snapshot: writes TOC Buffer Log for DBM analysis.
#   - _create_buffer_production_plan: delegates to production_plan_engine._create_production_plan
#     and _submit_pp_and_create_work_orders. PP created with blank projection_ref (buffer-triggered).
#
# PRODUCTION PLAN CUSTOM FIELD GUARD:
#   _has_open_pp() queries pp.custom_projection_reference to filter buffer-triggered PPs
#   (blank ref) from projection-triggered PPs (filled ref). This column only exists after
#   chaizup_toc fixtures are imported. If missing → OperationalError 1054.
#   Fix: _pp_has_custom_ref_column() caches frappe.db.has_column() result at module level.
#   Fallback query (when column missing) matches ANY non-cancelled PP — conservative but safe.
#
# UOM STANDARD:
#   order_qty from buffer_calculator is ALWAYS in stock_uom.
#   Purchase MRs: mr_qty = order_qty / conversion_factor; uom = purchase_uom.
#   Manufacture PPs: qty = order_qty (stock_uom, no conversion needed).
#   ERPNext MR validation recomputes stock_qty = mr_qty × conversion_factor automatically.
#
# MIN ORDER QTY FLOOR (Purchase MRs):
#   For Purchase-mode buffer items, the order_qty computed by buffer_calculator
#   (target_buffer − IP) is compared against Item Min Order Qty child table:
#     order_qty = max(buffer_order_qty, min_order_qty_in_stock_uom)
#   This ensures MRs are never created below the supplier's minimum order size.
#   build_min_order_map() is imported from component_mr_generator (shared utility).
#
# DANGER ZONE:
#   - _pp_has_custom_ref_column(): _pp_custom_ref_column_cache is module-level.
#     Resets on worker restart. If fixtures are imported mid-session, the old worker
#     still uses the fallback query until restarted — acceptable trade-off.
#   - generate_material_requests keeps buffer_type param for backward compat with
#     toc_api.py callers — but does NOT pass it to calculate_all_buffers (removed in
#     buffer_type refactor). The param is silently ignored.
#   - frappe.db.commit() is called twice in _create_buffer_production_plan (PP insert +
#     WO creation). Do not remove — WO creation reads committed PP rows.
#   - conversion_factor from UOM Conversion Detail = stock units per 1 purchase unit.
#     e.g., stock_uom=Gram, purchase_uom=KG → cf=1000; 5000g / 1000 = 5 KG on MR.
#   - If conversion_factor is 0 or missing, falls back to stock_uom to avoid ZeroDivisionError.
#   - min_order_qty floor: order_qty mutation happens BEFORE _create_mr() call.
#     The mutated value is written to item_data["order_qty"] in-place.
#     Do NOT apply it inside _create_mr — that function receives the final floored qty.
#
# RESTRICT:
#   - Do NOT pass buffer_type to calculate_all_buffers — it no longer accepts that param.
#   - Do NOT set uom = stock_uom for Purchase MRs — must use purchase_uom + conversion_factor.
#   - Do NOT skip _log_snapshot — required for DBM dashboard and audit trail.
#   - Do NOT collapse the two _has_open_pp SQL paths into one unconditional query
#     referencing custom_projection_reference — the column may not exist.
#   - Do NOT remove _pp_has_custom_ref_column() guard — prevents OperationalError 1054
#     on sites where chaizup_toc fixtures have not been imported.
#   - Do NOT apply min_order_qty floor to Manufacture-mode items — those are handled
#     by Item Minimum Manufacture child table in production_plan_engine.py.
# =============================================================================

"""
TOC Material Request Generator
===============================
Creates MRs (Purchase-mode items) or Production Plans (Manufacture-mode items) based on
buffer penetration analysis. Replaces erpnext.stock.reorder_item.reorder_item()

Routing logic:
  mr_type == "Manufacture" → Production Plan (auto-submitted + WOs created)
  mr_type == "Purchase"    → Material Request (purchase_uom with conversion_factor)

UOM handling:
  order_qty from buffer_calculator is always in stock_uom.
  Purchase MRs: qty = order_qty / conversion_factor, uom = purchase_uom
  Manufacture PPs: qty = order_qty, uom = stock_uom (no conversion needed)

Key difference from default ERPNext:
  Default: static reorder_level → fixed reorder_qty
  TOC:     dynamic BP% zones → exact (Target − IP) quantity, priority-sorted
"""

import frappe
from frappe.utils import flt, today, add_days, cint
from frappe import _


def generate_material_requests(buffer_type=None, zone_filter=None, company=None):
    """
    Main entry point. Routes actionable buffer items to MR (Purchase) or PP (Manufacture).

    Args:
        buffer_type: kept for backward compat with toc_api.py — silently ignored.
                     Routing is now derived from auto_purchase/auto_manufacture flags.
        zone_filter: list of zones e.g. ['Red', 'Black'] or None (reads from TOC Settings)
        company: filter by company

    Returns:
        list of created Material Request names (MRs only; PPs tracked separately)
    """
    from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers

    settings = frappe.get_cached_doc("TOC Settings")
    if not cint(settings.auto_generate_mr):
        frappe.logger("chaizup_toc").info("MR generation skipped — auto_generate_mr is OFF in TOC Settings")
        return []

    buffers = calculate_all_buffers(company=company)

    # Determine which zones to act on
    if not zone_filter:
        if settings.mr_zones == "Red and Black Only":
            zone_filter = ["Red", "Black"]
        else:
            zone_filter = ["Red", "Black", "Yellow"]

    actionable = [b for b in buffers if b["zone"] in zone_filter and b["order_qty"] > 0]

    # Build min order qty map for all Purchase-mode items in this run.
    # Manufacture-mode floors are handled by Item Minimum Manufacture in production_plan_engine.
    purchase_item_codes = [
        b["item_code"] for b in actionable if b.get("mr_type") != "Manufacture"
    ]
    min_order_map = {}
    if purchase_item_codes:
        try:
            from chaizup_toc.toc_engine.component_mr_generator import build_min_order_map
            min_order_map = build_min_order_map(purchase_item_codes)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "TOC MR: min_order_map build failed — skipping floor")

    created_mrs = []
    created_pps = []
    errors = []

    for item_data in actionable:
        try:
            if item_data.get("mr_type") == "Manufacture":
                # Manufacture mode → Production Plan (auto-submitted + WOs)
                if _has_open_pp(item_data["item_code"], item_data["warehouse"]):
                    continue
                pp_name = _create_buffer_production_plan(item_data)
                if pp_name:
                    _log_snapshot(item_data, pp_name)
                    created_pps.append(pp_name)
            else:
                # Purchase mode → Material Request (purchase_uom with conversion_factor)
                if _has_open_mr(item_data["item_code"], item_data["warehouse"], item_data["mr_type"]):
                    continue

                # Check component availability for items with BOM dependency
                if item_data.get("sfg_status") and not item_data["sfg_status"]["available"]:
                    frappe.logger("chaizup_toc").info(
                        f"SFG shortfall for {item_data['item_code']}: "
                        f"{item_data['sfg_status']['message']}")

                # Apply min order qty floor (stock_uom).
                # order_qty = max(buffer_shortage, min_order_qty_in_stock_uom)
                # min_order_qty comes from Item Min Order Qty child table.
                # If no row configured, min_qty = 0 → floor has no effect.
                min_qty = min_order_map.get(
                    (item_data["item_code"], item_data["warehouse"]), 0.0
                )
                if min_qty > 0 and item_data["order_qty"] < min_qty:
                    frappe.logger("chaizup_toc").info(
                        f"Min order floor applied: {item_data['item_code']} "
                        f"{item_data['order_qty']:.2f} → {min_qty:.2f} {item_data['stock_uom']}"
                    )
                    item_data["order_qty"] = min_qty

                mr_name = _create_mr(item_data, settings)
                if mr_name:
                    _log_snapshot(item_data, mr_name)
                    created_mrs.append(mr_name)

        except Exception:
            errors.append(item_data["item_code"])
            frappe.log_error(frappe.get_traceback(),
                f"TOC MR/PP Error: {item_data['item_code']}")

    frappe.db.commit()

    # Send Red zone email alerts
    if cint(settings.notify_on_red):
        _send_alerts(
            [b for b in actionable if b["zone"] in ("Red", "Black") and b["item_code"] not in errors],
            created_mrs, settings)

    frappe.logger("chaizup_toc").info(
        f"TOC Buffer Run: {len(created_mrs)} MRs, {len(created_pps)} PPs created, "
        f"{len(errors)} errors, "
        f"{len(actionable) - len(created_mrs) - len(created_pps) - len(errors)} skipped")

    return created_mrs


# Module-level cache: whether tabProduction Plan has the custom_projection_reference column.
# Frappe only creates this column after chaizup_toc fixtures are imported.
# Resets on worker restart — safe because fixture import requires a deploy.
_pp_custom_ref_column_cache = None


def _pp_has_custom_ref_column():
    """
    Return True if tabProduction Plan has the custom_projection_reference column.
    Column is added by chaizup_toc fixtures (custom_field.json). If fixtures have not been
    imported yet, querying the column raises OperationalError 1054. Cache at module level.
    """
    global _pp_custom_ref_column_cache
    if _pp_custom_ref_column_cache is None:
        _pp_custom_ref_column_cache = frappe.db.has_column("Production Plan", "custom_projection_reference")
    return _pp_custom_ref_column_cache


def _has_open_pp(item_code, warehouse):
    """
    Check for existing Draft/Submitted buffer-triggered PP for this item+warehouse.

    When custom_projection_reference column exists: only matches PPs with blank
    projection_reference (i.e. buffer-triggered, not projection-triggered).
    When column is missing (fixtures not yet imported): falls back to matching ANY
    non-cancelled PP for the item+warehouse — conservative dedup, avoids OperationalError.
    """
    if _pp_has_custom_ref_column():
        # Full dedup: only buffer-triggered PPs (blank projection reference)
        return frappe.db.sql(
            """
            SELECT pp.name FROM `tabProduction Plan` pp
            JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
            WHERE pp.docstatus < 2
              AND ppi.item_code = %s AND ppi.warehouse = %s
              AND (pp.custom_projection_reference IS NULL OR pp.custom_projection_reference = '')
            LIMIT 1
            """,
            (item_code, warehouse),
        )
    else:
        # Fallback: fixtures not imported — match any non-cancelled PP for item+warehouse.
        # Conservative: may over-block on sites before fixture import, but never crashes.
        return frappe.db.sql(
            """
            SELECT pp.name FROM `tabProduction Plan` pp
            JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
            WHERE pp.docstatus < 2
              AND ppi.item_code = %s AND ppi.warehouse = %s
            LIMIT 1
            """,
            (item_code, warehouse),
        )


def _create_buffer_production_plan(data):
    """Create a Production Plan for a buffer-triggered Manufacture-mode item (auto-submitted + WOs)."""
    from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
        _create_production_plan,
        _submit_pp_and_create_work_orders,
    )

    bom_no = frappe.db.get_value(
        "BOM",
        {"item": data["item_code"], "is_default": 1, "is_active": 1, "docstatus": 1},
        "name",
    )
    if not bom_no:
        frappe.logger("chaizup_toc").warning(
            f"Buffer PP skipped — no active default BOM for {data['item_code']}"
        )
        return None

    company = (
        data.get("company")
        or frappe.db.get_value("Warehouse", data["warehouse"], "company")
        or ""
    )
    reason = (
        f"TOC Buffer Replenishment | Zone: {data['zone']} | "
        f"BP: {data['bp_pct']}% | Target: {data['target_buffer']} | "
        f"IP: {data['inventory_position']} | Order Qty: {data['order_qty']}"
    )

    pp_name = _create_production_plan(
        item_code=data["item_code"],
        bom_no=bom_no,
        qty=data["order_qty"],
        warehouse=data["warehouse"],
        reason=reason,
        company=company,
        projection_ref=None,
    )
    frappe.db.commit()

    # Pass buffer snapshot so WOs get TOC fields stamped (zone, bp%, target, IP, sr%)
    _submit_pp_and_create_work_orders(pp_name, toc_data=data)
    frappe.db.commit()

    return pp_name


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
    # =============================================================================
    # CONTEXT: Creates a single Material Request for a Purchase-mode buffer item.
    # INSTRUCTIONS:
    #   - order_qty from buffer_calculator is always in stock_uom.
    #   - For Purchase MRs: look up item's purchase_uom and its conversion_factor
    #     (UOM Conversion Detail). If purchase_uom != stock_uom, divide order_qty
    #     by conversion_factor to get mr_qty in purchase units.
    #   - ERPNext MR validation then recomputes stock_qty = mr_qty × conversion_factor,
    #     so the warehouse receives the correct stock_uom quantity.
    # DANGER ZONE:
    #   - conversion_factor from "UOM Conversion Detail" = stock units per 1 purchase unit.
    #     e.g., for item with stock_uom=Gram and purchase_uom=KG: cf=1000,
    #     so 5000g order_qty → 5000/1000 = 5 KG on the MR.
    #   - If conversion_factor is 0 or missing, fall back to stock_uom to avoid ZeroDivisionError.
    # RESTRICT:
    #   - Do NOT set uom = stock_uom unconditionally — that was the original bug.
    # =============================================================================
    stock_uom = data["stock_uom"]

    # Resolve purchase UOM and conversion factor
    purchase_uom = frappe.db.get_value("Item", data["item_code"], "purchase_uom") or stock_uom
    conversion_factor = 1.0
    if purchase_uom and purchase_uom != stock_uom:
        cf = frappe.db.get_value(
            "UOM Conversion Detail",
            {"parent": data["item_code"], "uom": purchase_uom},
            "conversion_factor",
        )
        conversion_factor = flt(cf) if cf else 1.0

    # order_qty is in stock_uom; convert to purchase_uom for the MR line
    if conversion_factor > 0 and conversion_factor != 1.0:
        mr_qty = flt(data["order_qty"]) / conversion_factor
    else:
        mr_qty = flt(data["order_qty"])
        purchase_uom = stock_uom  # no valid conversion — use stock_uom directly

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
        "qty": mr_qty,
        "uom": purchase_uom,
        "stock_uom": stock_uom,
        "conversion_factor": conversion_factor,
        "warehouse": data["warehouse"],
        "schedule_date": mr.schedule_date,
        "description": (
            f"TOC Replenishment | Zone: {data['zone']} | "
            f"BP: {data['bp_pct']}% | Target: {data['target_buffer']} | "
            f"IP: {data['inventory_position']} | "
            f"Formula: F4 Order Qty = {data['target_buffer']} − {data['inventory_position']} = {data['order_qty']} {stock_uom}"
        ),
    })

    mr.flags.ignore_permissions = True
    mr.insert()

    frappe.logger("chaizup_toc").info(
        f"MR {mr.name}: {data['item_code']} | {data['zone']} | "
        f"BP:{data['bp_pct']}% | Qty:{mr_qty} {purchase_uom} ({data['order_qty']} {stock_uom}) | {data['mr_type']}")

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
