# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-25, chaizup_toc v0.0.10) —
#   recompute `custom_produced_qty_in_uom` for EVERY Work Order and
#   Production Plan Item row, regardless of docstatus (Draft, Submitted,
#   Cancelled) or workflow state (Open, In Process, Stopped, Completed).
#
# WHY:
#   1. The Stock Entry on_submit hook
#      (production_plan_engine.on_stock_entry_submit_refresh_produced)
#      had a purpose-name filter that returned early for Stock Entries
#      whose `stock_entry_type` is a custom-named alias of "Manufacture"
#      (e.g., "Manufacture - Plant A"). Hook fixed in same v0.0.10 commit;
#      this patch corrects the historical drift it caused.
#
#   2. The earlier `setup/install.py` back-fill skipped any WO/PPI row
#      whose `custom_uom` was already set (`WHERE custom_uom IS NULL OR
#      custom_uom = ''`). So rows with a custom_uom but a STALE produced
#      mirror were never updated when the app was migrated or reinstalled.
#
# CONFIRMED BUG (pre-patch data on chaizup-erp dev site, 2026-05-25):
#   - MFG-WO-2026-00309: produced_qty=5520, cf=60, mirror=78 (stale; mirror
#     captures a previous produced_qty=4680 snapshot, never re-synced).
#   - MFG-WO-2026-00324: produced_qty=121000, cf=1000, mirror=0 (never
#     synced; SE on_submit hook missed the entry).
#   - MFG-WO-2026-00326, 00246, 00311 — same zero-mirror symptom.
#
# WHAT THIS PATCH DOES:
#   For every Work Order WHERE custom_uom_conversion_factor > 0:
#       custom_produced_qty_in_uom = produced_qty / custom_uom_conversion_factor
#       custom_qty_in_uom          = qty          / custom_uom_conversion_factor
#   Same for every Production Plan Item.
#
#   Updates `update_modified = False` so the patch doesn't touch the
#   modified timestamp (preserves the audit trail of who last actually
#   edited the WO/PP).
#
# IDEMPOTENT: re-running the patch is a no-op (same arithmetic on same data).
#
# RESTRICTED:
#   - Do NOT scope the WHERE clause by docstatus or status. Stopped /
#     Cancelled WOs also need correct mirrors — they appear in reports,
#     ageing dashboards, and audit exports.
#   - Do NOT add a `custom_uom IS NULL` skip. The whole point of this
#     patch (vs install.py's back-fill) is to correct rows that ALREADY
#     have a custom_uom but a wrong / stale mirror.
#   - Do NOT use frappe.get_doc().save() — it would fire the validate()
#     hook for thousands of rows and could cascade-trigger TOC buffer
#     recompute on every WO. Use raw SQL UPDATE (fast + side-effect-free).
#   - Do NOT remove this patch entry from patches.txt after deployment —
#     Frappe's patch-runner uses patches.txt to know which patches have
#     run. Removing it would cause re-execution on every site that hasn't
#     tracked the patch under a different name.
#
# MEMORY: app_chaizup_toc.md § "v0.0.10 — produced_qty mirror correction (2026-05-25)"
# =============================================================================

import frappe


def execute():
    """Run by `bench migrate` (which runs automatically on every Frappe
    Cloud app deploy). Logs counts to the chaizup_toc logger."""
    log = frappe.logger("chaizup_toc")

    # ── Work Orders ─────────────────────────────────────────────────────────
    wo_total = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabWork Order`
        WHERE IFNULL(custom_uom_conversion_factor, 0) > 0
    """)[0][0]
    frappe.db.sql("""
        UPDATE `tabWork Order`
           SET custom_produced_qty_in_uom = IFNULL(produced_qty, 0)
                                          / custom_uom_conversion_factor,
               custom_qty_in_uom          = IFNULL(qty, 0)
                                          / custom_uom_conversion_factor
         WHERE IFNULL(custom_uom_conversion_factor, 0) > 0
    """)
    log.info(f"v0.0.10 patch: recomputed custom_produced_qty_in_uom on "
             f"{wo_total} Work Orders")

    # ── Production Plan Items (parent PP row aggregates per-WO produced_qty) ──
    ppi_total = frappe.db.sql("""
        SELECT COUNT(*) FROM `tabProduction Plan Item`
        WHERE IFNULL(custom_uom_conversion_factor, 0) > 0
    """)[0][0]
    frappe.db.sql("""
        UPDATE `tabProduction Plan Item`
           SET custom_produced_qty_in_uom = IFNULL(produced_qty, 0)
                                          / custom_uom_conversion_factor,
               custom_qty_in_uom          = IFNULL(planned_qty, 0)
                                          / custom_uom_conversion_factor
         WHERE IFNULL(custom_uom_conversion_factor, 0) > 0
    """)
    log.info(f"v0.0.10 patch: recomputed custom_produced_qty_in_uom on "
             f"{ppi_total} Production Plan Items")

    frappe.db.commit()
