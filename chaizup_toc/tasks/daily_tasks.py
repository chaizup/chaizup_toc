"""
Scheduled Tasks
================
06:30 AM — ADU Auto-Calculate (R1: skips items with Custom ADU checked)
07:00 AM — Production Priority Run
07:30 AM — Procurement Alert Run
08:00 AM — Buffer Snapshot Logging
Sunday 08:00 AM — Weekly DBM

R4 CLARITY: ADU is calculated here at 6:30 AM. It reads:
  - For FG: Delivery Note submitted qty (what was shipped)
  - For RM/PM: Stock Entry consumed qty (what was used in production)
  - For SFG: Stock Entry consumed qty (what was packed into FG)
  Then: ADU = total_qty / number_of_days_in_period
  Result is written to Item.custom_toc_adu_value
"""

import frappe
from frappe.utils import today, add_days, flt, now_datetime
from chaizup_toc.toc_engine.buffer_calculator import _resolve_buffer_type, _get_settings


def daily_adu_update():
    """
    06:30 AM — Auto-calculate ADU for all TOC items.

    R1: If "Custom ADU [TOC App]" is checked → SKIP that item entirely.
    R4: Sources explained:
      FG  → SUM(Delivery Note Item.qty) WHERE dn.docstatus=1 AND dn.posting_date in period
      RM  → SUM(Stock Entry Detail.qty) WHERE se.docstatus=1 AND type in (Material Issue, Manufacture)
      PM  → Same as RM
      SFG → SUM(Stock Entry Detail.qty) WHERE consumed from source warehouse
    """
    try:
        frappe.logger("chaizup_toc").info(f"=== ADU Auto-Update: {today()} ===")

        items = frappe.get_all("Item",
            filters={"custom_toc_enabled": 1, "disabled": 0},
            fields=["name", "item_group", "custom_toc_adu_period", "custom_toc_custom_adu"])

        period_map = {"Last 30 Days": 30, "Last 90 Days": 90, "Last 180 Days": 180, "Last 365 Days": 365}
        updated = 0
        skipped = 0
        _settings = _get_settings()

        for item in items:
            # R1: Skip if Custom ADU is checked — user entered manual value
            if item.custom_toc_custom_adu:
                skipped += 1
                continue

            try:
                days = period_map.get(item.custom_toc_adu_period or "Last 90 Days", 90)
                from_date = add_days(today(), -days)
                btype = _resolve_buffer_type(item.name, item.item_group, _settings) or ""
                adu = 0.0

                if btype == "FG":
                    # FG: How many units were SHIPPED to customers?
                    result = frappe.db.sql("""
                        SELECT COALESCE(SUM(dni.qty), 0) as total
                        FROM `tabDelivery Note Item` dni
                        JOIN `tabDelivery Note` dn ON dn.name = dni.parent
                        WHERE dni.item_code = %s AND dn.docstatus = 1
                        AND dn.posting_date >= %s AND dn.posting_date <= %s
                    """, (item.name, from_date, today()), as_dict=True)
                    adu = round(flt(result[0].total) / days, 2) if result else 0

                elif btype in ("RM", "PM"):
                    # RM/PM: How many units were CONSUMED in production?
                    result = frappe.db.sql("""
                        SELECT COALESCE(SUM(sed.qty), 0) as total
                        FROM `tabStock Entry Detail` sed
                        JOIN `tabStock Entry` se ON se.name = sed.parent
                        WHERE sed.item_code = %s AND se.docstatus = 1
                        AND se.posting_date >= %s AND se.posting_date <= %s
                        AND se.stock_entry_type IN ('Material Issue', 'Manufacture',
                            'Material Transfer for Manufacture')
                        AND sed.s_warehouse IS NOT NULL
                    """, (item.name, from_date, today()), as_dict=True)
                    adu = round(flt(result[0].total) / days, 2) if result else 0

                elif btype == "SFG":
                    # SFG: How many units were consumed when packed into FG?
                    result = frappe.db.sql("""
                        SELECT COALESCE(SUM(sed.qty), 0) as total
                        FROM `tabStock Entry Detail` sed
                        JOIN `tabStock Entry` se ON se.name = sed.parent
                        WHERE sed.item_code = %s AND se.docstatus = 1
                        AND se.posting_date >= %s AND se.posting_date <= %s
                        AND sed.s_warehouse IS NOT NULL
                    """, (item.name, from_date, today()), as_dict=True)
                    adu = round(flt(result[0].total) / days, 2) if result else 0

                frappe.db.set_value("Item", item.name, {
                    "custom_toc_adu_value": adu,
                    "custom_toc_adu_last_updated": now_datetime(),
                }, update_modified=False)
                updated += 1

            except Exception:
                frappe.log_error(frappe.get_traceback(), f"TOC ADU Error: {item.name}")

        frappe.db.commit()
        frappe.logger("chaizup_toc").info(
            f"ADU Done: {updated} updated, {skipped} skipped (Custom ADU), {len(items)} total")

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC ADU FAILED")


def daily_production_run():
    """07:00 AM — Generate Material Requests for Yellow/Red zone items."""
    try:
        from chaizup_toc.toc_engine.mr_generator import generate_material_requests
        mrs = generate_material_requests()
        frappe.logger("chaizup_toc").info(f"Production Run: {len(mrs)} MRs created")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Production Run FAILED")


def daily_procurement_run():
    """
    07:30 AM — RM/PM monitoring run. Logs Red/Black items for operator awareness.

    NOTE: Material Requests for RM/PM are already created by daily_production_run()
    at 07:00 AM, which calls generate_material_requests() without a buffer_type filter
    (covers FG, SFG, RM, and PM). This run is monitoring-only — no MRs created here.
    """
    try:
        from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
        rm_pm = calculate_all_buffers(buffer_type="RM") + calculate_all_buffers(buffer_type="PM")
        red = [b for b in rm_pm if b["zone"] in ("Red", "Black")]
        if red:
            frappe.logger("chaizup_toc").warning(f"Procurement: {len(red)} RM/PM in Red/Black")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Procurement FAILED")


def daily_buffer_snapshot():
    """08:00 AM — Log all buffer states for DBM analysis."""
    try:
        from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
        buffers = calculate_all_buffers()
        for b in buffers:
            try:
                log = frappe.new_doc("TOC Buffer Log")
                log.item_code = b["item_code"]; log.warehouse = b["warehouse"]
                log.log_date = today(); log.buffer_type = b["buffer_type"]
                log.company = b.get("company"); log.on_hand_qty = b.get("on_hand", 0)
                log.wip_qty = b.get("wip_or_on_order", 0)
                log.reserved_qty = b.get("backorders_or_committed", 0)
                log.inventory_position = b["inventory_position"]
                log.target_buffer = b["target_buffer"]
                log.buffer_penetration_pct = b["bp_pct"]
                log.stock_remaining_pct = b["sr_pct"]
                log.zone = b["zone"]; log.order_qty_suggested = b["order_qty"]
                log.flags.ignore_permissions = True; log.insert()
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"TOC Snapshot: {b['item_code']}")
        frappe.db.commit()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Snapshot FAILED")


def weekly_dbm_check():
    """Sunday 08:00 AM — DBM evaluation."""
    try:
        from chaizup_toc.toc_engine.dbm_engine import evaluate_all_dbm
        evaluate_all_dbm()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC DBM FAILED")
