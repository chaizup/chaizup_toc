"""
Scheduled Tasks
================
# =============================================================================
# CONTEXT: Scheduled task runner for Theory of Constraints (TOC) daily operations.
# MEMORY: app_chaizup_toc.md § Scheduled Tasks | § ADU-PER-WAREHOUSE (2026-06-02)
# INSTRUCTIONS:
#   - Average Daily Usage (ADU) lives ONLY in the per-warehouse child table
#     "Minimum Manufacture / Purchase Qty per Warehouse" (doctype
#     `Item Minimum Manufacture`, parent field Item.custom_minimum_manufacture).
#     The standalone item-level ADU fields (custom_toc_custom_adu /
#     custom_toc_adu_period / custom_toc_adu_value / custom_toc_adu_last_updated)
#     were REMOVED on 2026-06-02 — they duplicated the per-warehouse table.
#   - `update_min_mfg_adu_levels` is now the SOLE ADU writer. It is UNIVERSAL
#     and ITEM-GROUP-INDEPENDENT: per (item, warehouse) it reads ALL outward
#     Stock Ledger Entry movements (actual_qty < 0) — Delivery Note (sales),
#     Stock Entry (Work Order consumption / Material Issue / subcontracting),
#     and any other voucher that removes stock. NO FG/SFG/RM/PM branching.
#   - The old item-level `daily_adu_update` function + its 01:00 cron were
#     DELETED (it only wrote the now-removed item-level field).
#   - Procurement run filters by the auto_purchase flag, not buffer_type.
# REQUIREMENT PROVENANCE:
#   - 2026-06-02 (a): "ADU must NOT depend on item groups; always sum ALL
#     outward movement." -> implemented via the universal SLE query.
#   - 2026-06-02 (b): "Standalone item-level ADU fields not needed; use the
#     Minimum Manufacture / Purchase Qty per Warehouse child table instead."
#     -> item-level fields + item-level cron removed; per-warehouse table is
#     the single source of ADU for every consumer (incl. Item Projection View
#     'Days of Cover' and the Bulk Item Settings page).
# CONSIDERATION (not a bug — flagged for ops policy):
#   - The universal query also counts NEGATIVE Stock Reconciliation legs and
#     inter-warehouse Material Transfer OUT legs (corrections / relocations,
#     not true demand). Kept because the directive is literally "ALL outward".
#     For demand-only ADU, exclude those two voucher types in
#     update_min_mfg_adu_levels.
# DANGER ZONE:
#   - Do NOT re-add Item-Group / buffer-type branching to ADU.
#   - Do NOT re-introduce an item-level ADU field or cron — the per-warehouse
#     table is the single source of truth (2026-06-02).
# =============================================================================
12:00 AM — Min Order Qty Sync (purchase from ERPNext field; manufacture from WO history) + missing alert
01:00 AM — Item Minimum Manufacture ADU + Max Level refresh (per warehouse; sole ADU job)
02:00 AM — Sales Projection -> Production Plan automation
07:00 AM — Production Priority Run
07:00 AM — Sales Order Shortage Cover (Calc SO) — auto since 2026-06-04 (was opt-in)
07:30 AM — Procurement Alert Run (Purchase-mode items only)
08:00 AM — Buffer Snapshot Logging
Sunday 09:00 AM — Weekly DBM
"""

import frappe
from frappe.utils import today, add_days, flt, now_datetime


# =============================================================================
# PHASE 2 (2026-06-02) — D4: every scheduled job writes ONE audit row.
# CONTEXT:
#   Voucher-creating jobs (02:00 projection, 07:00 buffer MR, Calc SO/Action)
#   already write a full TOC Production Plan Run Log with per-item Run Items.
#   The MONITORING jobs (this file: ADU refresh, procurement scan, buffer
#   snapshot, weekly DBM, min-order sync) do not create PP/WO/MR, so they write
#   ONE header-only run-log row summarising "what action was taken" — giving a
#   single auditable trail across the whole TOC app.
# RESTRICT:
#   - Keep this header-only (no Run Items) — these jobs are not per-item voucher
#     creators; forcing item rows here would fight the mandatory item_code link.
#   - The summary text goes in `pending_so_statuses_used` (a free Text field on
#     the run log) prefixed "JOB SUMMARY"; do not repurpose calc counters.
# =============================================================================
def _write_job_log(triggered_by, summary):
    """Write one header-only TOC Production Plan Run Log row for a monitoring job."""
    try:
        rl = frappe.new_doc("TOC Production Plan Run Log")
        rl.run_started = now_datetime()
        rl.run_completed = now_datetime()
        rl.triggered_by = triggered_by
        rl.company = frappe.defaults.get_global_default("company") or ""
        rl.pending_so_statuses_used = f"JOB SUMMARY ({triggered_by}): {summary}"
        rl.flags.ignore_mandatory = True
        rl.insert(ignore_permissions=True)
        frappe.db.commit()
        return rl.name
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"TOC job-log write failed: {triggered_by}")
        return None


def daily_min_order_sync():
    """
    12:00 AM — Sync Item Min Order Qty (purchase) and Item Minimum Manufacture (manufacture)
    from ERPNext built-in fields / Work Order history. Notifies on missing configuration.
    """
    try:
        from chaizup_toc.toc_engine.min_order_sync import daily_min_order_sync as _sync
        _sync()
        _write_job_log("min_order_sync_cron", "Min Order Qty sync completed.")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Min Order Sync FAILED")
        _write_job_log("min_order_sync_cron", "FAILED — see Error Log.")


def update_min_mfg_adu_levels():
    """
    01:00 AM — Refresh per-warehouse ADU + Max Level for every row in
    `Item Minimum Manufacture` (Item.custom_minimum_manufacture child table) —
    the "Minimum Manufacture / Purchase Qty per Warehouse" table.

    This is the SOLE ADU writer in the app (2026-06-02). The standalone
    item-level ADU fields + their cron were removed; ADU is per warehouse only.
    The lookback window is taken from
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
      - 2026-06-04: BOTH the history-gate and the outflow sum EXCLUDE
        `voucher_type = 'Stock Reconciliation'`. SR negative legs are stock
        corrections, not demand. Keep the two queries in lock-step — if one
        excludes SR and the other does not, the gate and the rate disagree
        (e.g. an item whose only history is SR would pass the gate but sum
        to 0). If a future requirement also excludes inter-warehouse
        transfers, add `voucher_type != 'Stock Entry'`-with-purpose filter to
        BOTH, not just one.
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
                      AND  voucher_type != 'Stock Reconciliation'
                    """,
                    (r["parent"], r["warehouse"]),
                )
                first_out = earliest[0][0] if earliest else None
                if first_out is None or str(first_out) > str(from_date):
                    skipped_warmup += 1
                    continue

                # 2026-06-04: EXCLUDE Stock Reconciliation outward legs. A negative
                # SR leg is an inventory CORRECTION (count adjustment), not true
                # consumption/demand — counting it inflates ADU and oversizes the
                # buffer. Delivery Notes (SO), Stock Entry consumption (WO), issues
                # and transfers are still counted. See module .md "ADU exclusions".
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
                      AND  voucher_type != 'Stock Reconciliation'
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
        _write_job_log(
            "adu_cron",
            f"Per-warehouse ADU + Max Level: {updated} updated, "
            f"{skipped_manual} manual, {skipped_warmup} warming up, "
            f"{errors} errors, lookback={lookback}d.",
        )

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC MinMfg ADU FAILED (outer)")
        _write_job_log("adu_cron", "FAILED — see Error Log.")


def daily_production_run():
    """07:00 AM — Generate Material Requests for Yellow/Red zone items."""
    try:
        from chaizup_toc.toc_engine.mr_generator import generate_material_requests
        mrs = generate_material_requests()
        frappe.logger("chaizup_toc").info(f"Production Run: {len(mrs)} MRs created")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Production Run FAILED")


def daily_so_shortage_automation():
    """07:00 AM — Sales Order shortage cover (Calc SO, feature reference §5.7).

    # =========================================================================
    # CONTEXT: Calc SO scans every pending Sales Order (eligibility = TOC
    #   Settings pending statuses + workflow states), computes shortage per
    #   (item, warehouse) in stock UOM, and creates a Production Plan + Work
    #   Orders (Manufacture mode) or a Purchase Material Request (Purchase mode)
    #   for each positive shortage — floored by the per-warehouse Minimum Qty.
    # MEMORY: app_chaizup_toc.md § SPE-001 (Calc SO) | § replenishment-mode gate
    # POLICY CHANGE (2026-06-04): Calc SO was previously OPT-IN ONLY — fired from
    #   the "Run Sales Order Shortage Now" button on TOC Settings and explicitly
    #   "not part of the nightly run". Per user request it now ALSO runs
    #   automatically every day at 07:00, registered in hooks.py alongside the
    #   buffer Production Priority run. This supersedes the old SPE-001 RESTRICT
    #   note ("Do NOT call run_so_shortage_automation from a cron"); the cron
    #   path uses triggered_by="so_shortage_cron" exactly as that note prescribed
    #   for the eventual scheduled entry.
    # INSTRUCTIONS:
    #   - Delegate to run_so_shortage_automation so the cron and the TOC Settings
    #     button share identical dedup ([Calc SO] marker) + logging. Do NOT
    #     re-implement the per-pair loop here.
    #   - The engine writes its OWN TOC Production Plan Run Log (header + per-item
    #     Run Items), so this wrapper does NOT call _write_job_log — that helper
    #     is only for monitoring jobs that create no voucher / run log.
    # DANGER ZONE:
    #   - frappe.set_user("Administrator") is required: run_so_shortage_automation
    #     guards itself with frappe.only_for([...]); the scheduler user must hold
    #     System Manager for the call to pass.
    # =========================================================================
    """
    try:
        from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
            run_so_shortage_automation,
        )
        frappe.set_user("Administrator")
        result = run_so_shortage_automation(triggered_by="so_shortage_cron") or {}
        frappe.logger("chaizup_toc").info(
            "Calc SO (cron): created=%s skipped=%s errors=%s pairs=%s"
            % (
                result.get("created"),
                result.get("skipped"),
                result.get("errors"),
                result.get("pairs"),
            )
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Calc SO (cron) FAILED")


def daily_shortage_action_automation():
    """Scheduled wrapper for Shortage Action (Calc Action, feature ref §5.8).

    # =========================================================================
    # CONTEXT: Calc Action iterates Item Minimum Manufacture rows opted-in via
    #   auto_on_shortage / auto_on_max_level and creates PP+WO (manufacture) or
    #   MR (purchase). Previously button-only; this wrapper lets it run on the
    #   cron registered in hooks.py and configured via the TOC Trigger
    #   Configuration row (seeded DISABLED — opt-in).
    # MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
    # INSTRUCTIONS:
    #   - Delegate to run_shortage_action_automation; do NOT re-implement.
    #   - Administrator user so the engine's frappe.only_for guard passes.
    #   - The engine writes its own TOC Production Plan Run Log, so this wrapper
    #     does not call _write_job_log.
    # DANGER ZONE:
    #   - triggered_by MUST be "shortage_action_cron" (a valid run-log Select
    #     option); a new literal would roll back the run-log save.
    # =========================================================================
    """
    try:
        from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
            run_shortage_action_automation,
        )
        frappe.set_user("Administrator")
        result = run_shortage_action_automation(triggered_by="shortage_action_cron") or {}
        frappe.logger("chaizup_toc").info(
            "Calc Action (cron): %s"
            % ({k: result.get(k) for k in ("created", "skipped", "errors")})
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Calc Action (cron) FAILED")


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
        _write_job_log(
            "procurement_cron",
            f"Procurement scan: {len(purchase_items)} purchase items, "
            f"{len(red)} in Red/Black (monitoring only — no vouchers created).",
        )
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Procurement FAILED")
        _write_job_log("procurement_cron", "FAILED — see Error Log.")


def daily_buffer_snapshot():
    """08:00 AM — Log all buffer states for DBM analysis."""
    snap_count = 0
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
                snap_count += 1
            except Exception:
                frappe.log_error(frappe.get_traceback(), f"TOC Snapshot: {b['item_code']}")
        frappe.db.commit()
        _write_job_log("snapshot_cron", f"Buffer snapshot: {snap_count} TOC Buffer Log rows written.")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Snapshot FAILED")
        _write_job_log("snapshot_cron", "FAILED — see Error Log.")


def weekly_dbm_check():
    """Sunday 09:00 AM — DBM evaluation."""
    try:
        from chaizup_toc.toc_engine.dbm_engine import evaluate_all_dbm
        evaluate_all_dbm()
        _write_job_log("dbm_cron", "Weekly Dynamic Buffer Management evaluation completed.")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC DBM FAILED")
        _write_job_log("dbm_cron", "FAILED — see Error Log.")
