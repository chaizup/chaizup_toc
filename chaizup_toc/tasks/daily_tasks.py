"""
Scheduled Tasks
================
# =============================================================================
# CONTEXT: Scheduled task runner for TOC daily operations.
# MEMORY: app_chaizup_toc.md § Scheduled Tasks
# INSTRUCTIONS:
#   - ADU is universal: reads ALL stock outflows from Stock Ledger Entry
#     (actual_qty < 0) for every item, regardless of item type/category.
#   - No FG/SFG/RM/PM branching anywhere in this file.
#   - Procurement run now filters by auto_purchase flag, not buffer_type.
# DANGER ZONE:
#   - Do NOT re-add FG/SFG/RM/PM branching to daily_adu_update().
#   - Universal SLE query captures: sales, production consumption, transfers,
#     WO component draw-downs — all in one query per item.
# =============================================================================
12:00 AM — Min Order Qty Sync (purchase from ERPNext field; manufacture from WO history) + missing alert
06:30 AM — ADU Auto-Calculate (R1: skips items with Custom ADU checked)
07:00 AM — Production Priority Run
07:30 AM — Procurement Alert Run (Purchase-mode items only)
08:00 AM — Buffer Snapshot Logging
Sunday 08:00 AM — Weekly DBM
"""

import frappe
from frappe.utils import today, add_days, flt, now_datetime


def daily_min_order_sync():
    """
    12:00 AM — Sync Item Min Order Qty (purchase) and Item Minimum Manufacture (manufacture)
    from ERPNext built-in fields / Work Order history. Notifies on missing configuration.
    """
    try:
        from chaizup_toc.toc_engine.min_order_sync import daily_min_order_sync as _sync
        _sync()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Min Order Sync FAILED")


def daily_adu_update():
    """
    06:30 AM — Universal ADU auto-calculate for all TOC items.

    R1: Items with custom_toc_custom_adu checked are skipped entirely.
    Universal: ADU = total stock outflows (SLE.actual_qty < 0) ÷ days.
    Captures ALL outflow types: sales, production consumption, transfers, WO draw-down.
    No item-type branching — same query for every item.
    """
    try:
        frappe.logger("chaizup_toc").info(f"=== ADU Auto-Update: {today()} ===")

        items = frappe.get_all("Item",
            filters={"custom_toc_enabled": 1, "disabled": 0},
            fields=["name", "custom_toc_adu_period", "custom_toc_custom_adu"])

        period_map = {"Last 30 Days": 30, "Last 90 Days": 90, "Last 180 Days": 180, "Last 365 Days": 365}
        updated = 0
        skipped = 0

        for item in items:
            if item.custom_toc_custom_adu:
                skipped += 1
                continue

            try:
                days = period_map.get(item.custom_toc_adu_period or "Last 90 Days", 90)
                from_date = add_days(today(), -days)

                # Universal: sum ALL stock outflows from SLE (negative qty = item left stock)
                result = frappe.db.sql("""
                    SELECT COALESCE(ABS(SUM(actual_qty)), 0) AS total_out
                    FROM `tabStock Ledger Entry`
                    WHERE item_code = %s
                      AND actual_qty < 0
                      AND posting_date >= %s
                      AND posting_date <= %s
                      AND is_cancelled = 0
                """, (item.name, from_date, today()), as_dict=True)

                adu = round(flt(result[0].total_out) / days, 4) if result else 0.0

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
    07:30 AM — Purchase-mode item monitoring. Logs Red/Black for operator awareness.
    Filters by mr_type == "Purchase" (auto_purchase flag) — no buffer_type needed.
    """
    try:
        from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
        purchase_items = [b for b in calculate_all_buffers() if b["mr_type"] == "Purchase"]
        red = [b for b in purchase_items if b["zone"] in ("Red", "Black")]
        if red:
            frappe.logger("chaizup_toc").warning(f"Procurement: {len(red)} purchase items in Red/Black")
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
