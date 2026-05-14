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


def update_min_mfg_adu_levels():
    """
    06:35 AM — Refresh per-warehouse ADU + Max Level for every row in
    `Item Minimum Manufacture` (Item.custom_minimum_manufacture child table).

    Runs 5 minutes after `daily_adu_update` so the daily ADU writer is
    finished by the time we read SLE. The lookback window is taken from
    `TOC Settings.adu_lookback_days` (single source of truth). For each row:

      1. Skip if `auto_adu = 0` — that row is user-managed; the engine
         must not touch its `adu`, `adu_lookback_days`, `last_updated_on`
         or `max_level`. (IMM-003, 2026-05-13)
      2. Skip if the SLE history for (item, warehouse) does NOT cover the
         full lookback window. Concretely: the earliest outflow posting_date
         must be on or before `today - lookback_days`. If we have only 30
         days of data and the setting is 90, dividing by 90 systematically
         understates ADU; better to leave the row untouched and log so
         the operator knows it is still in the "warm-up" period. (IMM-003)
      3. Sum stock outflows over the lookback window from
         `tabStock Ledger Entry` filtered by item_code AND warehouse (so
         two warehouses for the same item get independent ADUs).
      4. Write `adu = total_out / lookback_days`.
      5. Snapshot the lookback window into `adu_lookback_days` so future
         readers can interpret the ADU even after the global setting
         changes.
      6. Recompute `max_level = adu × lead_time_days × safety_factor`
         (safety defaults to 1.0 when blank — mirrors validate()).
      7. Set `last_updated_on = now_datetime()`.

    All writes go through `frappe.db.set_value` with `update_modified=False`
    so we do NOT bump the parent Item's `modified` timestamp on every run
    (would flood the audit trail). One commit at the end of the function.

    DANGER:
      - Hardcoded column names in the SET clause: `adu`, `adu_lookback_days`,
        `max_level`, `last_updated_on`. Renaming any of them here OR in the
        doctype JSON without coordinating both sides silently no-ops the
        writes.
      - SLE filter MUST scope by warehouse — otherwise every warehouse on
        the same item gets the same global ADU and the cap loses meaning.
      - `auto_adu = 0` rows must NEVER be touched. Even writing
        `last_updated_on` would mislead the user into thinking the engine
        owns the ADU on a manual row.

    RESTRICT:
      - Do NOT skip the safety floor of 1.0 — `flt(... or 0) or 1.0` —
        without it a row with blank safety produces max_level = 0 and
        downstream readers treat it as "no cap".
      - Do NOT change `update_modified=False` — that suppression is the
        whole reason this task can run daily without contaminating the
        Item audit history.
      - Do NOT relax the history-gate to "any data". A row with 5 days of
        history divided by a 90-day lookback yields a 0.055x understated
        ADU and an artificially low max_level cap; the buffer logic then
        sizes safety stock at ~5% of what it should be. Leaving the row
        empty for a few weeks until coverage arrives is the safer signal.
    """
    try:
        frappe.logger("chaizup_toc").info(
            f"=== Item Minimum Manufacture ADU + Max Level refresh: {today()} ==="
        )

        settings = frappe.get_cached_doc("TOC Settings")
        lookback = int(settings.adu_lookback_days or 90)
        if lookback <= 0:
            frappe.logger("chaizup_toc").warning(
                "TOC Settings.adu_lookback_days is <= 0; aborting MinMfg ADU refresh"
            )
            return

        from_date = add_days(today(), -lookback)
        rows = frappe.db.sql(
            """
            SELECT name, parent, warehouse, lead_time_days, safety_factor, auto_adu
            FROM   `tabItem Minimum Manufacture`
            WHERE  warehouse IS NOT NULL AND warehouse != ''
            """,
            as_dict=True,
        )

        now_ts          = now_datetime()
        updated         = 0
        skipped_manual  = 0
        skipped_warmup  = 0
        errors          = 0

        for r in rows:
            try:
                # IMM-003 (2026-05-13): respect the per-row Auto-ADU toggle.
                if int(r.get("auto_adu") or 0) == 0:
                    skipped_manual += 1
                    continue

                # IMM-003: sufficient-history gate. We need at least one
                # outflow on or before (today - lookback) to be sure the
                # window is fully covered; otherwise dividing by `lookback`
                # systematically understates ADU.
                earliest = frappe.db.sql(
                    """
                    SELECT MIN(posting_date) AS first_out
                    FROM   `tabStock Ledger Entry`
                    WHERE  item_code     = %s
                      AND  warehouse     = %s
                      AND  actual_qty    < 0
                      AND  is_cancelled  = 0
                    """,
                    (r["parent"], r["warehouse"]),
                )
                first_out = earliest[0][0] if earliest else None
                if first_out is None or str(first_out) > str(from_date):
                    skipped_warmup += 1
                    continue

                outflow = frappe.db.sql(
                    """
                    SELECT COALESCE(ABS(SUM(actual_qty)), 0) AS total_out
                    FROM   `tabStock Ledger Entry`
                    WHERE  item_code     = %s
                      AND  warehouse     = %s
                      AND  actual_qty    < 0
                      AND  posting_date >= %s
                      AND  posting_date <= %s
                      AND  is_cancelled  = 0
                    """,
                    (r["parent"], r["warehouse"], from_date, today()),
                )
                total_out = flt(outflow[0][0]) if outflow else 0.0
                adu = round(total_out / lookback, 4)

                lead  = int(r.get("lead_time_days") or 0)
                sf    = flt(r.get("safety_factor") or 0) or 1.0
                max_level = round(adu * lead * sf, 3)

                frappe.db.set_value(
                    "Item Minimum Manufacture", r["name"],
                    {
                        "adu":               adu,
                        "adu_lookback_days": lookback,
                        "max_level":         max_level,
                        "last_updated_on":   now_ts,
                    },
                    update_modified=False,
                )
                updated += 1

            except Exception:
                errors += 1
                frappe.log_error(
                    frappe.get_traceback(),
                    f"TOC MinMfg ADU refresh — row {r['name']} (item {r['parent']})",
                )

        frappe.db.commit()
        frappe.logger("chaizup_toc").info(
            "MinMfg ADU Done: "
            f"{updated} updated, "
            f"{skipped_manual} manual (auto_adu off), "
            f"{skipped_warmup} warming up (insufficient history), "
            f"{errors} errors, "
            f"lookback={lookback}d"
        )

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC MinMfg ADU FAILED (outer)")


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
                # BTP-001 (2026-05-14): write `mr_type` into the legacy
                # `buffer_type` column. The result dict no longer carries a
                # `buffer_type` key — Replenishment Mode is `mr_type` only.
                log.log_date = today(); log.buffer_type = b.get("mr_type") or b.get("buffer_type") or ""
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
