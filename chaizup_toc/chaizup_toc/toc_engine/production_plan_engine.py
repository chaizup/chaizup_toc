# =============================================================================
# CONTEXT: Sales Projection → Production Plan Automation Engine (v3).
#   Runs daily at 02:00 AM. For every submitted Sales Projection of the current
#   month, calculates warehouse-specific demand shortage per item and creates
#   Production Plans — auto-submitted with Work Orders for FG + sub-assemblies.
#   Also callable on-demand via "Projection Automation" button on Sales Projection form.
#
# MEMORY: production_plan_engine.md (same folder — read before editing)
#
# ─── TWO CALCULATION SCENARIOS ───────────────────────────────────────────────
#
#   Calc 1 — Forecast exists (projection_qty > 0):
#     shortage = (projected_qty + prev_pending_SO + pending_PP_qty)
#                − curr_month_SO − warehouse_stock
#     reason_type = "Calc 1 — Forecast Shortage"
#
#   Calc 2 — No forecast (projection_qty = 0) but pending SOs exist:
#     shortage = (all_pending_SO + pending_PP_qty) − warehouse_stock
#     (all_pending_SO = ALL warehouse-scoped SOs, no delivery_date split)
#     reason_type = "Calc 2 — No Forecast, SO Demand"
#
#   If projection_qty = 0 AND no pending SOs → skip (Skipped - No Demand).
#
# ─── FORMULA COMPONENTS (ALL in stock_uom) ───────────────────────────────────
#   projected_qty       = Sales Projected Items.qty_in_stock_uom (stock_uom)
#   prev_pending_SO_qty = SUM(soi.stock_qty - delivered_qty * conversion_factor)
#                         WHERE delivery_date < month_start AND so.set_warehouse = warehouse
#   curr_month_SO_qty   = same formula, delivery_date in projection month
#   all_pending_SO_qty  = same formula, NO delivery_date filter (Calc 2 only)
#   pending_PP_qty      = SUM(ppi.planned_qty) from non-cancelled PPs for item+warehouse
#                         NOTE: column is planned_qty NOT qty — tabProduction Plan Item
#                         has no qty column. Confirmed schema: planned_qty, pending_qty,
#                         produced_qty, ordered_qty.
#   warehouse_stock     = Bin.actual_qty WHERE warehouse = source_warehouse (stock_uom)
#   production_qty      = max(shortage, min_mfg_qty_in_stock_uom)
#
# ─── UOM STANDARD ─────────────────────────────────────────────────────────────
#   soi.qty          = transaction UOM (Box/Case/etc.) — NEVER USE for calculations
#   soi.stock_qty    = qty × conversion_factor = qty in stock_uom ← USE THIS
#   soi.delivered_qty = delivered in transaction UOM
#   soi.delivered_qty × soi.conversion_factor = delivered in stock_uom
#   Guard: soi.stock_qty > delivered_qty * conversion_factor (NOT soi.qty > delivered_qty)
#   sed.transfer_qty = stock entry detail in stock_uom (NOT sed.qty)
#
# ─── PENDING SO ELIGIBILITY — TWO PATHS (OR logic) ───────────────────────────
#   PATH A — Draft + Configured Workflow States (docstatus=0):
#     so.workflow_state IN projection_confirmed_so_workflow_states
#     Default: ['Confirmed']. Configurable in TOC Settings.
#     GUARD: PATH A is only included when tabSales Order has a workflow_state column.
#     Frappe only creates this column when a Workflow is assigned to the DocType.
#     Sites with no SO Workflow must skip PATH A — querying workflow_state on those
#     sites raises OperationalError 1054 (Unknown column). Use _so_has_workflow_column().
#   PATH B — Submitted + status in pending list (docstatus=1):
#     so.status IN projection_pending_so_statuses
#     Default: ["To Deliver and Bill", "To Deliver", "On Hold"]
#
# ─── PRODUCTION PLAN CUSTOM FIELDS ───────────────────────────────────────────
#   custom_created_by           = "System" (automation) or "User" (manual)
#   custom_creation_reason      = Full formula breakdown text
#   custom_projection_reference = Link to Sales Projection (dedup key)
#   These are defined in chaizup_toc fixtures/custom_field.json.
#   IMPORTANT: These columns in tabProduction Plan only exist AFTER fixtures are
#   applied (bench migrate + manual fixture import or frappe.utils.fixtures.sync_fixtures).
#   If missing → OperationalError 1054 on custom_projection_reference query in dedup.
#   Fix: import fixtures via bench console or Setup → Custom Fields.
#
# ─── POST-PP-CREATION FLOW ────────────────────────────────────────────────────
#   1. pp_doc.get_sub_assembly_items()     — multi-level BOM, scoped to source_warehouse
#   2. get_items_for_material_requests()   — raw material requirements (informational)
#   3. pp_doc.save()
#   4. pp_doc.submit()
#   5. pp_doc.make_work_order()            — DOCUMENT METHOD: creates WOs for FG + sub-levels
#
# ─── EMAIL NOTIFICATION ───────────────────────────────────────────────────────
#   Sent after each run via frappe.sendmail(now=False) — queue mode only.
#   now=True is FORBIDDEN: it sends in the after_commit hook chain; a decryption
#   failure (InvalidToken) propagates as HTTP 500 even after successful PP creation.
#   The call is wrapped in try/except — email failures never crash the automation.
#
# ─── INSTRUCTIONS ─────────────────────────────────────────────────────────────
#   - run_production_plan_automation() is @frappe.whitelist — called by JS button.
#   - daily_production_plan_automation() is the 02:00 AM cron entry point.
#   - on_production_plan_before_insert() is a doc_event hooked in hooks.py.
#   - Dedup: non-cancelled System PP for same projection + item_code blocks re-creation.
#
# ─── DANGER ZONE ──────────────────────────────────────────────────────────────
#   - workflow_state column may not exist on tabSales Order — guard with _so_has_workflow_column().
#   - custom_projection_reference column must exist on tabProduction Plan — requires fixture import.
#   - SO warehouse filter uses so.set_warehouse. Blank set_warehouse SOs excluded intentionally.
#   - frappe.db.commit() called multiple times in _process_item — do NOT remove.
#   - _submit_pp_and_create_work_orders: each step in its own try/except — do NOT collapse.
#   - pp_doc.make_work_order() is a DOCUMENT METHOD — NOT importable at module level.
#   - frappe.sendmail must use now=False (queue). now=True → HTTP 500 on decryption failure.
#
# ─── RESTRICT ─────────────────────────────────────────────────────────────────
#   - Do NOT remove docstatus != 1 guard in run_production_plan_automation.
#   - Do NOT remove frappe.only_for guard — whitelisted, callable by any user via API.
#   - Do NOT change delivery_date to transaction_date in Calc 1 SO queries.
#   - Do NOT remove the dedup check (_pp_exists_for_item).
#   - Do NOT remove the BOM gate (Gate 1).
#   - Do NOT collapse PATH A + PATH B into one docstatus IN query.
#   - Do NOT call frappe.sendmail inside the item loop — one email per run only.
#   - Do NOT pass now=True to frappe.sendmail in _send_pp_notification.
#   - Do NOT remove the try/except wrapper around _send_pp_notification call.
#   - Do NOT query ppi.qty — column does not exist. Use ppi.planned_qty.
#   - Do NOT query so.workflow_state without _so_has_workflow_column() guard.
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import datetime

import frappe
from frappe import _
from frappe.utils import cint, flt, now_datetime, today

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# =============================================================================
# PUBLIC API — @frappe.whitelist, called by JS "Run Production Plan Automation"
# CONTEXT: Validates the projection is submitted, then processes all items.
#   Returns a list of result dicts for the JS dialog to display.
# DANGER ZONE:
#   - docstatus check MUST stay — prevents running on unconfirmed draft projections.
#   - frappe.only_for MUST stay — whitelisted methods are callable by any user via API.
# =============================================================================
@frappe.whitelist()
def run_production_plan_automation(projection_name, triggered_by="manual"):
    """Create Production Plans for all items in the given submitted Sales Projection.

    SPE-001 (2026-05-13) — RUN-LOG FIX
    ----------------------------------
    The legacy v1 path (this function) used to call `_process_item` directly
    and never created a `TOC Production Plan Run Log`. The TOC Settings
    "Run Now" button has used v2 (`_run_for_projection`) since 2026-05-08
    and DID create a log; the per-Sales-Projection form button (handled by
    this function) silently did not.

    To eliminate that divergence we now delegate to the SAME v2 entry
    point (`_run_for_projection`) for both paths. Side effects:

      - A Run Log + Run Items are always created on a manual run.
      - The v1 `_process_item` is no longer called from this entry — but
        it is still exported and used by `mr_generator.py` for buffer-
        triggered FG/SFG items (per the legacy contract). Do NOT delete it.
      - The legacy email helper `_send_pp_notification` is replaced by the
        v2 `_send_run_log_email` invoked inside `_run_for_projection`.
        Result format returned to JS is a small dict (was: list of results)
        — the form-side handler tolerates both shapes (it shows a generic
        success toast).
    """
    frappe.only_for(["Manufacturing Manager", "TOC Manager", "System Manager"])

    settings = frappe.get_cached_doc("TOC Settings")
    if not settings.enable_projection_automation:
        frappe.throw(_(
            "Projection Automation is disabled. "
            "Enable it in TOC Settings → Sales Projection Automation."
        ))

    sp_doc = frappe.get_doc("Sales Projection", projection_name)
    if sp_doc.docstatus != 1:
        frappe.throw(_("Production Plan Automation can only run on a Submitted Sales Projection."))

    summary, log_name = _run_for_projection(sp_doc, triggered_by, settings)

    frappe.db.set_value(
        "Sales Projection", projection_name,
        "last_auto_run", now_datetime(),
        update_modified=False,
    )
    frappe.db.commit()

    return {
        "ok": True,
        "run_log": log_name,
        "summary": summary,
        "message": (
            f"Run Log {log_name} created. "
            f"{summary.get('calc_a_created',0) + summary.get('calc_b_created',0)} PPs created, "
            f"{summary.get('errors', 0)} errors."
        ),
    }


# =============================================================================
# SCHEDULER ENTRY POINT — registered in hooks.py as 02:00 AM daily cron
# CONTEXT: Finds ALL submitted Sales Projections for the current month (one per
#   warehouse) and runs the automation on each. Silently exits if none found.
# DANGER ZONE:
#   - Uses MONTH_NAMES list (index = month - 1) to match the Select field DB value.
#     January → index 0, December → index 11. Do NOT reorder MONTH_NAMES.
# =============================================================================
def daily_production_plan_automation():
    """02:00 AM daily — runs the v2 dual-calc engine (Calc A + Calc B) for every
    current-month submitted Sales Projection.

    DESIGN (2026-05-08): delegates to run_projection_automation_for_all_warehouses
    so cron and the TOC Settings 'Run Now' button share identical behaviour,
    including TOC Production Plan Run Log writes and per-calc dedup. Do NOT
    re-implement the loop here — divergence between cron and manual paths has
    historically caused duplicate PPs.
    """
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        if not settings.enable_projection_automation:
            return

        frappe.set_user("Administrator")
        run_projection_automation_for_all_warehouses(triggered_by="cron")

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC PP Automation daily runner FAILED")


# =============================================================================
# DOC EVENT — fires before every Production Plan insert (hooked in hooks.py)
# CONTEXT: Auto-sets custom_created_by = "User" when the field is blank.
#   The automation always sets "System" before insert, so this only triggers
#   for manually created Production Plans where the field is empty.
# =============================================================================
def on_production_plan_before_insert(doc, method):
    """Auto-set custom_created_by = 'User' for manually created Production Plans."""
    if not getattr(doc, "custom_created_by", None):
        doc.custom_created_by = "User"


# =============================================================================
# DOC EVENT — Production Plan: before_cancel
# CONTEXT (CIRCULAR CANCEL DEADLOCK FIX — 2026-05-12):
#   `Sales Projected Items.wo_name` is a Link → Production Plan (set by the
#   automation engine after PP creation). When the user tries to cancel a PP,
#   Frappe's `check_no_back_links_exist` finds those SP child rows and throws
#   "Cannot cancel — linked with Sales Projection". This is the PP-side half of
#   the SP↔PP circular cancel deadlock (the SP side is fixed in
#   `SalesProjection.before_cancel` via `self.flags.ignore_links = True`).
#
#   Approach (asymmetric, intentional):
#     - SP side: full back-link bypass via flags.ignore_links. Safe because the
#       ONLY inbound link to SP is `PP.custom_projection_reference`, which is
#       benign to leave hanging.
#     - PP side (THIS HOOK): TARGETED clear of just the
#       Sales Projected Items.wo_name + .wo_status fields for rows pointing to
#       this PP. We do NOT use flags.ignore_links here — that would also bypass
#       the legitimate Work Order / Material Request / Stock Entry guards.
#       Cancelling a PP that has active Work Orders against it MUST still be
#       blocked by ERPNext's standard guard.
#
# DANGER ZONE:
#   - This runs `frappe.db.set_value` on a Sales Projected Items child row
#     of a (likely submitted) Sales Projection parent. Direct DB write
#     bypasses Frappe document validation — which is exactly what we want
#     here, because both wo_name and wo_status are read_only display fields
#     that the engine itself writes via the same db.set_value path AFTER
#     submit. Do NOT switch to `doc.save()` — that would touch the parent's
#     modified timestamp and re-trigger SP.validate().
#   - update_modified=False on the SP child write so the parent SP's
#     "modified" timestamp does not shift just because a PP underneath it
#     got cancelled. Audit trail on the SP stays clean.
#   - This hook runs BEFORE Frappe's own back-link existence check (which
#     fires inside `_cancel`). By the time the check runs, the child rows
#     no longer have `wo_name = doc.name`, so the check passes.
# RESTRICT:
#   - Do NOT widen the cleared field set. Only `wo_name` is the Link field
#     that triggers Frappe's back-link guard; `wo_status` is cleared as a
#     paired cosmetic update so the SP doesn't show a misleading "Created"
#     status pointing at a now-cancelled PP.
#   - Do NOT remove this hook even if the SP-side fix alone seems to work.
#     The deadlock is symmetric — both sides are needed to keep ALL
#     operator-cancel paths green (SP-first AND PP-first).
#   - Hook signature `(doc, method)` is fixed by Frappe — the `method` arg
#     comes from the doc_event registration and equals "before_cancel" here.
# =============================================================================
def on_production_plan_before_cancel(doc, method=None):
    """Clear SP child-row wo_name references before PP cancel, so Frappe's
    back-link guard does not block. Keeps WO/MR/SE inbound link checks intact."""
    linked_rows = frappe.get_all(
        "Sales Projected Items",
        filters={"wo_name": doc.name},
        fields=["name", "parent"],
    )
    for row in linked_rows:
        frappe.db.set_value(
            "Sales Projected Items",
            row["name"],
            {"wo_name": None, "wo_status": None},
            update_modified=False,
        )


# =============================================================================
# CORE ITEM PROCESSOR
# CONTEXT: Runs BOM gate, shortage formula (Calc 1 or Calc 2), min-mfg floor,
#   dedup check, PP creation, then auto-submit + Work Order creation.
#
# GATE ORDER:
#   1. BOM gate — skip if no active default BOM.
#   2. Demand check (Calc 2 only) — skip if no forecast AND no pending SOs.
#   3. Shortage formula — skip if existing supply covers demand.
#   4. Dedup check — skip if non-cancelled System PP already exists.
#   5. Create PP → auto-submit → create Work Orders.
#
# FORMULAS:
#   Calc 1 (projected_qty > 0):
#     shortage = (projected_qty + prev_SO + pending_PP) - curr_SO - stock
#
#   Calc 2 (projected_qty = 0, pending SOs exist):
#     shortage = (all_pending_SO + pending_PP) - stock
#
# DANGER ZONE:
#   - Do NOT remove dedup check. Without it, re-running creates duplicate PPs.
#   - frappe.db.commit() must remain after PP creation AND after submit+WO.
# =============================================================================
def _process_item(row, sp_doc, pending_statuses, confirmed_states,
                  month_start, next_month_start, company, min_mfg_map):
    item_code = row.item
    item_name = row.item_name or item_code
    projected_qty = flt(row.qty_in_stock_uom)
    warehouse = sp_doc.source_warehouse

    try:
        # ── Gate 1: Active Default BOM ───────────────────────────────────────
        bom_no = frappe.db.get_value(
            "BOM",
            {"item": item_code, "is_default": 1, "is_active": 1, "docstatus": 1},
            "name",
        )
        if not bom_no:
            return {
                "item_code": item_code, "item_name": item_name,
                "status": "Skipped - No BOM",
                "reason": (
                    f"Item {item_code} has no active default submitted BOM. "
                    f"Create a BOM, mark it Default + Active, and submit it."
                ),
            }

        # ── Shared demand components ─────────────────────────────────────────
        stock      = _warehouse_stock(item_code, warehouse)
        pending_pp = _pending_pp_qty(item_code, warehouse)
        has_forecast = projected_qty > 0

        if has_forecast:
            # ── Calc 1: Forecast Shortage ─────────────────────────────────────
            prev_so  = _prev_month_so_qty(item_code, pending_statuses, confirmed_states, month_start, warehouse)
            curr_so  = _curr_month_so_qty(item_code, pending_statuses, confirmed_states, month_start, next_month_start, warehouse)
            shortage = (projected_qty + prev_so + pending_pp) - curr_so - stock
            calc_label = "Calc 1 — Forecast Shortage"
            reason_prefix = "Forecast shortage"
            breakdown = (
                f"Formula: ({projected_qty:.2f} projected + {prev_so:.2f} carryover SO "
                f"+ {pending_pp:.2f} pending PP) − {curr_so:.2f} curr-month SO "
                f"− {stock:.2f} stock in {warehouse} = {shortage:.2f} shortage."
            )
        else:
            # ── Gate 2: No forecast — check all pending SOs ───────────────────
            all_so = _all_pending_so_qty(item_code, pending_statuses, confirmed_states, warehouse)
            if all_so <= 0:
                return {
                    "item_code": item_code, "item_name": item_name,
                    "status": "Skipped - No Demand",
                    "reason": (
                        f"Projection qty is 0 and no pending Sales Orders found for "
                        f"warehouse {warehouse}. No production required."
                    ),
                }
            # ── Calc 2: No Forecast, SO Demand ───────────────────────────────
            prev_so = curr_so = 0.0
            shortage = (all_so + pending_pp) - stock
            calc_label = "Calc 2 — No Forecast, SO Demand"
            reason_prefix = "No forecast (projection qty = 0) but pending Sales Orders exist"
            breakdown = (
                f"Formula: ({all_so:.2f} all pending SO + {pending_pp:.2f} pending PP) "
                f"− {stock:.2f} stock in {warehouse} = {shortage:.2f} shortage."
            )

        # ── Gate 3: No shortage ──────────────────────────────────────────────
        if shortage <= 0:
            return {
                "item_code": item_code, "item_name": item_name,
                "status": "Skipped - No Shortage",
                "reason": (
                    f"No shortage [{calc_label}]. {breakdown} Stock already covers demand."
                ),
                "prev_so": prev_so, "curr_so": curr_so, "stock": stock,
            }

        # ── Min Manufacturing Qty Floor ──────────────────────────────────────
        min_in_stock_uom = min_mfg_map.get((item_code, warehouse), 0.0)
        production_qty   = max(shortage, min_in_stock_uom)

        # ── Gate 4: Dedup — skip if PP already exists for this projection+item
        existing_pp = _pp_exists_for_item(sp_doc.name, item_code)
        if existing_pp:
            return {
                "item_code": item_code, "item_name": item_name,
                "status": "Skipped - PP Exists",
                "reason": (
                    f"Production Plan {existing_pp} already exists for {item_code} "
                    f"under projection {sp_doc.name}. Skipped to prevent duplicate."
                ),
            }

        # ── Build Reason Text ────────────────────────────────────────────────
        reason = (
            f"{reason_prefix}. Created by PP Automation ({sp_doc.name}) "
            f"for {sp_doc.projection_month} {sp_doc.projection_year} / {warehouse}. "
            f"{breakdown}"
        )
        if min_in_stock_uom > 0 and production_qty > shortage:
            reason += (
                f" Raised from {shortage:.2f} to {production_qty:.2f} (min mfg floor)."
            )

        # ── Create Production Plan ────────────────────────────────────────────
        pp_name = _create_production_plan(
            item_code, bom_no, production_qty, warehouse, reason, company, sp_doc.name,
        )
        frappe.db.commit()  # commit PP insert before sub-assembly/submit/WO

        # ── Auto-submit PP and create Work Orders ─────────────────────────────
        _submit_pp_and_create_work_orders(pp_name)
        frappe.db.commit()

        return {
            "item_code": item_code, "item_name": item_name,
            "status": "Created", "pp_name": pp_name,
            "production_qty": production_qty,
            "projected_qty": projected_qty,
            "shortage": shortage,
            "min_mfg_qty": min_in_stock_uom,
            "prev_so": prev_so, "curr_so": curr_so, "stock": stock,
        }

    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"TOC PP Automation: Error processing item {item_code}",
        )
        return {
            "item_code": item_code, "item_name": item_name,
            "status": "Error - See Log",
            "reason": "Unexpected error. Check ERPNext Error Log for full traceback.",
        }


# =============================================================================
# PRODUCTION PLAN FACTORY
# CONTEXT: Creates a single Draft Production Plan with one po_items row.
#   Sets all three TOC custom fields: created_by, creation_reason, projection_ref.
#   Sets for_warehouse and sub_assembly_warehouse so the subsequent
#   sub-assembly fetch and material requirements calculation are scoped to the
#   correct warehouse (projection warehouse, SO warehouse, or TOC buffer warehouse).
#
# DANGER ZONE:
#   - flags.ignore_mandatory = True bypasses ERPNext required-field validation on
#     fields that may be blank (e.g. get_items_from). Without this, insert may fail.
#   - Do NOT call frappe.db.commit() here. Caller (_process_item) commits after insert.
#   - for_warehouse drives get_items_for_material_requests warehouse scope.
#   - sub_assembly_warehouse drives get_sub_assembly_items availability check.
#     If skip_available_sub_assembly_item is ever enabled, sub_assembly_warehouse
#     MUST be set (already done here) — ERPNext throws otherwise.
#
# RESTRICT:
#   - Always pass custom_projection_reference when called from projection automation.
#     It is the dedup key used by _pp_exists_for_item(). Blank for buffer-triggered PPs.
# =============================================================================
def _create_production_plan(item_code, bom_no, qty, warehouse, reason, company, projection_ref):
    """Insert a Draft Production Plan for one item. Returns the new PP document name.

    CRITICAL (2026-05-08): the PP field LABELLED "Consider Projected Qty in Calculation"
    is INTERNALLY named `skip_available_sub_assembly_item` — the label and fieldname
    diverge in ERPNext v16. We force it to 0 so ERPNext's get_sub_assembly_items runs
    against Bin.actual_qty alone, NOT Bin.projected_qty. Without this:

      - Bin.projected_qty already nets out Sales Order pending qty + open WO + open PO.
      - TOC's dual-calc engine ALSO accounts for those (via ITMWO, CURRSO, PRVSO).
      - Result: double-counted supply → zero or negative sub-assembly demand → BOM
        components silently skipped → operator sees "no sub-assembly WO needed" when
        in fact the line will starve.

    Forcing the flag to 0 keeps TOC's formula as the SINGLE source of truth for what
    qty to plan; ERPNext's sub-assembly tree just walks the BOM at the qty TOC chose.

    # =========================================================================
    # CONTEXT (UOM CAPTURE — 2026-05-12):
    #   Production Plan Item.stock_uom is reqd=1 + read_only=1 in ERPNext.
    #   When ERPNext's own get_items() builds po_items from SO/MR, it passes
    #   `item_details.stock_uom` (see production_plan.py:531). Our automation
    #   bypasses that path and used to leave stock_uom blank, which caused:
    #     - PP form showed empty UOM column on the Items table
    #     - Downstream sub_assembly_items / mr_items inherited blank UOM
    #     - validate_uom_is_integer() in PP.validate could not enforce integer
    #       qty rule because it had no UOM to look up
    #   Fix: fetch Item.stock_uom and pass it explicitly to the po_items append.
    # DANGER ZONE:
    #   - `qty` arriving into this function is ALREADY in stock_uom — both
    #     _process_item (formula `production_qty = max(shortage, min_in_stock_uom)`)
    #     and _process_item_v2 (`production_qty = max(qty_a, minmfg)`) compute
    #     in stock_uom. Do NOT apply a second conversion here.
    #   - Item.stock_uom is mandatory on the Item DocType, so the fetch is safe.
    #     If item_code is invalid the get_value returns None and PP.validate will
    #     surface the error before insert.
    # RESTRICT:
    #   - Always pass stock_uom on the po_items dict — leaving it blank silently
    #     breaks the PP Items grid display AND ERPNext's UOM-integer validation.
    # =========================================================================
    """
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""

    # 2026-05-14: ALWAYS append the canonical pending-check block so the
    # operator reading the PP sees BOTH the specific narrative the caller
    # built (formula breakdown, MOQ floor, source projection / buffer zone)
    # AND the exact statuses the dedup gate considered "still pending" the
    # last time the engine ran. The block is short and read-only, so the
    # duplicated context across PPs is intentional — auditability beats
    # brevity here. Skip the append if the caller already routed the reason
    # through format_auto_creation_remark() (recognised by the "[Auto-
    # Generated by " sentinel string).
    enriched_reason = reason or ""
    if "[Auto-Generated by " not in enriched_reason:
        try:
            from chaizup_toc.toc_engine.auto_remarks import format_pending_check_block
            enriched_reason = (
                (enriched_reason.rstrip() + "\n\n" + format_pending_check_block("PP"))
                if enriched_reason
                else format_pending_check_block("PP")
            )
        except Exception:
            # Helper not available (fresh checkout, fixtures not synced) —
            # fall back to whatever the caller passed.
            pass

    pp = frappe.new_doc("Production Plan")
    pp.company = company
    pp.planned_start_date = today()
    pp.custom_created_by = "System"
    pp.custom_creation_reason = enriched_reason
    pp.custom_projection_reference = projection_ref or ""

    # Warehouse scope — used by get_sub_assembly_items and get_items_for_material_requests
    pp.for_warehouse = warehouse
    pp.sub_assembly_warehouse = warehouse

    # Sub-assembly calculation flags (forced for TOC determinism).
    # skip_available_sub_assembly_item is the INTERNAL fieldname for the UI checkbox
    # labelled "Consider Projected Qty in Calculation". 0 = ignore Bin.projected_qty.
    # See `apps/erpnext/.../production_plan.json:411` for the label↔fieldname divergence.
    pp.skip_available_sub_assembly_item = 0

    # 2026-05-18 — MRP propagation: stamp Item.custom_mrp + source on every
    # auto-created PP row so downstream WOs and reports carry the MRP for
    # free. Source = "Auto from Item" so operators see (and can change to
    # Manual) the price in the form UI. Defensive try/except — if the
    # field doesn't exist (older site without fixtures synced) we skip
    # silently rather than blocking PP creation.
    _mrp = 0.0
    try:
        _mrp = flt(frappe.db.get_value("Item", item_code, "custom_mrp") or 0)
    except Exception:
        pass

    pp.append("po_items", {
        "item_code": item_code,
        "qty": flt(qty),
        "planned_qty": flt(qty),
        "pending_qty": flt(qty),
        "stock_uom": stock_uom,
        "bom_no": bom_no or "",
        "warehouse": warehouse,
        "planned_start_date": today(),
        "custom_mrp": _mrp,
        "custom_mrp_source": "Auto from Item",
    })

    pp.flags.ignore_mandatory = True
    pp.insert()
    return pp.name


# =============================================================================
# POST-PP FLOW: Multi-Level BOM → Material Requirements → Save → Submit → Work Orders
#
# CONTEXT: Called immediately after _create_production_plan. Implements the full
#   ERPNext Production Plan lifecycle programmatically:
#
#   Step 1 — get_sub_assembly_items():
#     Fetches the complete multi-level BOM sub-assembly tree into pp_doc.sub_assembly_items.
#     Scoped to pp_doc.sub_assembly_warehouse (set to the projection/SO/buffer warehouse
#     in _create_production_plan). Only sub-assemblies not already available in that
#     warehouse are included (if skip_available_sub_assembly_item is ON — default OFF).
#
#   Step 2 — get_items_for_material_requests():
#     Calculates raw material requirements for all BOM levels and populates pp_doc.mr_items.
#     Scoped to pp_doc.for_warehouse (same warehouse as sub_assembly_warehouse).
#     This is a standalone @frappe.whitelist() function — pass pp_doc.as_dict() as input
#     and append the returned list to pp_doc.mr_items. This is the "Get Raw Materials"
#     button in the ERPNext PP form. Informational only — TOC does NOT auto-create MRs
#     from the PP (buffer calculator handles RM/PM MRs separately).
#
#   Step 3 — pp_doc.save():
#     Persists sub_assembly_items and mr_items to DB before submit.
#
#   Step 4 — pp_doc.submit():
#     Submits the PP (docstatus → 1). ERPNext PP status transitions to "Not Started".
#
#   Step 5 — pp_doc.make_work_order():
#     DOCUMENT METHOD (not standalone function) — calls make_work_order_for_finished_goods
#     and make_work_order_for_subassembly_items. Creates WOs for FG + every sub-assembly
#     level. Sub-assembly WOs have use_multi_level_bom = 0 (each level is its own WO).
#
#   Step 6 — _stamp_toc_fields_on_work_orders(pp_name, toc_data):
#     Stamps TOC metadata (zone, BP%, target, IP, SR%) on every WO created by the PP.
#     Skipped silently on failure — never blocks PP/WO creation.
#
#   Step 7 — create_component_shortage_mrs(pp_name, company):
#     Walks ALL tabWork Order Item rows across the full multi-level BOM tree
#     (all WOs of the PP), checks Bin.actual_qty per component+warehouse, and
#     creates Purchase MRs for components with shortages where
#     custom_toc_auto_purchase = 1. Applies min order qty floor from Item Min
#     Order Qty child table: order_qty = max(shortage, min_order_qty_in_stock_uom).
#     Guarded by TOC Settings.auto_create_component_mrs (default ON).
#     Imported from chaizup_toc.toc_engine.component_mr_generator.
#
# DANGER ZONE:
#   - pp_doc.make_work_order() is a DOCUMENT METHOD on ProductionPlan class (line 775
#     in erpnext/manufacturing/doctype/production_plan/production_plan.py). Do NOT
#     attempt to import it as a standalone function — it does not exist at module level.
#   - get_items_for_material_requests IS a standalone @frappe.whitelist() function.
#     Pass frappe._dict(pp_doc.as_dict()) and append results to pp_doc.mr_items.
#   - Each step is wrapped in its own try/except. A failed step is logged and skipped;
#     later steps continue. A failed sub-assembly fetch still submits the PP.
#   - frappe.msgprint() calls inside ERPNext methods are safe in scheduler context —
#     messages are silently queued, not shown to any user.
#   - frappe.db.commit() is called after save and after WO creation. Do NOT remove.
#
# RESTRICT:
#   - Do NOT import make_work_order from erpnext module level — it is a class method.
#   - Do NOT remove the per-step try/except blocks. The outer try/except alone is
#     insufficient — an error in step 1 would skip steps 2–5 entirely without it.
#   - Do NOT call make_material_request() from the PP here — TOC buffer calculator
#     handles RM/PM Material Requests independently. Double-creation would result.
#   - Do NOT remove Step 7 try/except — component MR failures must never crash PP/WO flow.
#   - Do NOT move Step 7 before Step 5 — WOs must exist before component MR check runs.
# =============================================================================
def _submit_pp_and_create_work_orders(pp_name, toc_data=None):
    """
    Full post-insert PP lifecycle:
    multi-level BOM → material requirements → save → submit → create Work Orders
    → stamp TOC fields on all created WOs.

    toc_data (optional dict): buffer snapshot to stamp on created Work Orders.
      Keys: zone, bp_pct, target_buffer, inventory_position, sr_pct.
      Pass from mr_generator for buffer-triggered PPs. Leave None for projection PPs
      (zone/bp% not applicable; WOs will only get custom_toc_recorded_by = "By System").
    """
    try:
        pp_doc = frappe.get_doc("Production Plan", pp_name)

        # ── Step 1: Fetch multi-level BOM sub-assemblies (warehouse-scoped) ──
        try:
            pp_doc.get_sub_assembly_items()
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"PP Sub-assembly fetch failed for {pp_name} — continuing to material requirements",
            )

        # ── Step 2: Get material requirements for the target warehouse ────────
        # get_items_for_material_requests is a standalone @frappe.whitelist() function.
        # Pass the doc as a plain dict; append returned mr_items to the document.
        try:
            from erpnext.manufacturing.doctype.production_plan.production_plan import (
                get_items_for_material_requests,
            )
            mr_items = get_items_for_material_requests(frappe._dict(pp_doc.as_dict())) or []
            pp_doc.set("mr_items", [])
            for mr_item in mr_items:
                pp_doc.append("mr_items", mr_item)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"PP material requirements fetch failed for {pp_name} — continuing to save",
            )

        # ── Step 2.5: Stamp the new UOM custom fields on every child row ─────
        # 2026-05-19 — populates custom_uom, custom_uom_conversion_factor,
        # and the corresponding *_in_uom fields on po_items + sub_assembly_items
        # so the row looks coherent on form-open even when the user has not
        # explicitly picked a UOM. Defensive — never blocks PP save.
        try:
            _stamp_uom_fields_on_pp(pp_doc)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"UOM-field stamp failed for {pp_name} — continuing to save",
            )

        # ── Step 3: Save with sub-assemblies and material requirements ────────
        pp_doc.flags.ignore_mandatory = True
        pp_doc.save()
        frappe.db.commit()

        # ── Step 4: Submit ────────────────────────────────────────────────────
        pp_doc.submit()
        frappe.db.commit()

        # ── Step 5: Create Work Orders for FG + all sub-assembly levels ───────
        # pp_doc.make_work_order() is a DOCUMENT METHOD — do NOT import from module.
        try:
            pp_doc.make_work_order()
            frappe.db.commit()
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"WO creation failed for submitted PP {pp_name}",
            )

        # ── Step 6: Stamp TOC fields on all WOs created by this PP ───────────
        # Wrapped in try/except — field population must never block PP/WO creation.
        try:
            _stamp_toc_fields_on_work_orders(pp_name, toc_data)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC field stamp failed for WOs of {pp_name}",
            )

        # ── Step 7: Create Purchase MRs for component shortages ──────────────
        # Walks all WO Items across the full multi-level BOM, checks Bin.actual_qty,
        # creates individual Purchase MRs for items with custom_toc_auto_purchase=1.
        # Applies min order qty floor from Item Min Order Qty child table:
        #   order_qty = max(shortage_in_stock_uom, min_order_qty_in_stock_uom)
        # Guarded by TOC Settings auto_create_component_mrs toggle (default ON).
        # Wrapped in try/except — component MR failures never crash PP/WO flow.
        try:
            settings_doc = frappe.get_cached_doc("TOC Settings")
            from frappe.utils import cint as _cint
            if _cint(getattr(settings_doc, "auto_create_component_mrs", 1)):
                from chaizup_toc.toc_engine.component_mr_generator import (
                    create_component_shortage_mrs,
                )
                pp_company = frappe.db.get_value("Production Plan", pp_name, "company") or ""
                component_mrs = create_component_shortage_mrs(pp_name, pp_company)
                if component_mrs:
                    frappe.logger("chaizup_toc").info(
                        f"PP {pp_name}: {len(component_mrs)} component shortage Purchase MRs created"
                    )
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"Component shortage MR creation failed for PP {pp_name}",
            )

    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"PP post-insert flow failed for {pp_name}",
        )


# =============================================================================
# TOC FIELD STAMPER — Work Orders
# CONTEXT: Stamps TOC metadata (zone, BP%, target, IP, SR%) on every Work Order
#   created by a Production Plan so users can see which buffer zone triggered
#   production. Called as Step 6 of _submit_pp_and_create_work_orders.
#
# INSTRUCTIONS:
#   - Queries tabWork Order by production_plan = pp_name to find all WOs.
#   - Uses frappe.db.set_value (no doc load) to avoid triggering WO validation.
#   - toc_data=None is valid (projection-triggered PPs don't have zone/bp%):
#     only custom_toc_recorded_by is set in that case.
#
# DANGER ZONE:
#   - Wrapped in try/except at call site — WO field failures must never crash PP creation.
#   - Uses db.set_value with update_modified=False to avoid bumping WO modified timestamp.
#   - tabWork Order must have the TOC custom fields (custom_toc_zone etc.) applied before
#     this runs. Fields are created via chaizup_toc fixtures/custom_field.json.
#
# RESTRICT:
#   - Do NOT load the full WO doc here — that triggers all WO validators.
#   - Do NOT call frappe.db.commit() here — caller commits after this step.
# =============================================================================
def _stamp_uom_fields_on_pp(pp_doc):
    """
    Stamp the chaizup_toc UOM custom fields on every po_items +
    sub_assembly_items row of `pp_doc`. Idempotent + respects user choices.

    Behaviour per row:
       custom_uom                    — if BLANK, auto-pick item's largest-CF
                                       UOM. If user already chose one, keep it.
       custom_uom_conversion_factor  — always (re)computed from custom_uom
       custom_qty_in_uom             — recomputed as planned_qty / CF
                                       (po_items)
       custom_required_qty_in_uom    — recomputed as required_qty / CF
       custom_projected_qty_in_uom   — recomputed as projected_qty / CF
       custom_qty_to_order_in_uom    — recomputed as qty / CF
                                       (Qty to Order on sub_assembly_items)

    Idempotent: safe to call on every PP save. Recomputes the *_in_uom
    fields from the standard qty fields, so the displayed value stays in
    sync after ERPNext writes (BOM explosion, "Get Sub-Assemblies" button,
    scheduler back-fills). User-set custom_uom values are PRESERVED — we
    only auto-pick when the field is blank.

    2026-05-19 — refactored to be idempotent. Used to overwrite custom_uom
    on every call which clobbered user choices.
    """
    # Collect all the item codes we need ladders for in a single batch.
    item_codes = set()
    for r in (pp_doc.get("po_items") or []):
        if r.get("item_code"):
            item_codes.add(r.item_code)
    for r in (pp_doc.get("sub_assembly_items") or []):
        if r.get("production_item"):
            item_codes.add(r.production_item)
    if not item_codes:
        return

    # Largest-CF UOM per item via one query.
    ladders = frappe.db.sql(
        """
        SELECT parent AS item_code, uom, conversion_factor
        FROM `tabUOM Conversion Detail`
        WHERE parent IN %(c)s AND parenttype = 'Item'
          AND IFNULL(conversion_factor, 0) > 0
        ORDER BY conversion_factor DESC
        """, {"c": tuple(item_codes)}, as_dict=True)
    stock_uoms = {
        r.name: r.stock_uom for r in frappe.db.sql(
            """SELECT name, stock_uom FROM `tabItem` WHERE name IN %(c)s""",
            {"c": tuple(item_codes)}, as_dict=True)
    }
    by_item = {}
    for r in ladders:
        by_item.setdefault(r.item_code, []).append(
            (r.uom, flt(r.conversion_factor)))

    def pick_default(item_code):
        """Auto-pick: largest non-stock UOM; fall back to stock UOM if none."""
        rows = by_item.get(item_code) or []
        s_uom = stock_uoms.get(item_code) or ""
        for uom, cf in rows:
            if uom != s_uom and cf > 1.0:
                return uom, cf
        return s_uom, 1.0

    def cf_for(item_code, uom):
        """Look up CF for a specific (item, uom) — used when user has
        already picked custom_uom and we just need its CF."""
        for u, cf in (by_item.get(item_code) or []):
            if u == uom:
                return flt(cf)
        return 1.0

    # ── po_items (Items to Manufacture) ──────────────────────────────────
    for r in (pp_doc.get("po_items") or []):
        if not r.get("item_code"):
            continue
        if r.get("custom_uom"):
            cf = cf_for(r.item_code, r.custom_uom) or 1.0
        else:
            uom, cf = pick_default(r.item_code)
            r.custom_uom = uom
        r.custom_uom_conversion_factor = flt(cf)
        # Recompute in-UOM display from the (possibly updated) standard qty.
        r.custom_qty_in_uom = (flt(r.planned_qty) / flt(cf)) if cf else 0
        # 2026-05-19 — Produced Qty mirror (read-only). Standard
        # `produced_qty` is updated by ERPNext when a Manufacture-purpose
        # Stock Entry posts; we recompute the in-UOM display here.
        r.custom_produced_qty_in_uom = (flt(r.produced_qty) / flt(cf)) if cf else 0

    # ── sub_assembly_items ───────────────────────────────────────────────
    for r in (pp_doc.get("sub_assembly_items") or []):
        if not r.get("production_item"):
            continue
        if r.get("custom_uom"):
            cf = cf_for(r.production_item, r.custom_uom) or 1.0
        else:
            uom, cf = pick_default(r.production_item)
            r.custom_uom = uom
        r.custom_uom_conversion_factor = flt(cf)
        r.custom_required_qty_in_uom  = (flt(r.required_qty)  / flt(cf)) if cf else 0
        r.custom_projected_qty_in_uom = (flt(r.projected_qty) / flt(cf)) if cf else 0
        r.custom_qty_to_order_in_uom  = (flt(r.qty)           / flt(cf)) if cf else 0


# =============================================================================
# DOC EVENT — Production Plan validate
#   Fires on every PP save (draft and submitted). Calls _stamp_uom_fields_on_pp
#   so the TOC custom fields auto-populate based on the standard qty fields
#   ERPNext has just written.
#
#   Common trigger paths covered:
#     - User clicks "Get Sub-Assemblies" button → sub_assembly_items rows
#       added → user clicks Save → validate fires → fields populated.
#     - Engine auto-creates PP via _save_and_submit_production_plan → the
#       explicit call at Step 2.5 still works (idempotent), AND the validate
#       hook fires again on pp_doc.save() for belt-and-braces.
#     - User manually edits a row → save → validate → fields stay in sync.
#
#   2026-05-19 — added per user requirement: "when user fetch sub assembly,
#   the toc fields automatically update as per qty system populate".
# =============================================================================
def stamp_uom_fields_on_pp_validate(doc, method=None):
    """Frappe doc_event hook called on Production Plan.validate."""
    try:
        _stamp_uom_fields_on_pp(doc)
    except Exception:
        # Never block a PP save because of UOM stamping. Log + continue.
        frappe.log_error(
            frappe.get_traceback(),
            f"UOM stamp failed for Production Plan {doc.name or '(new)'}",
        )


# =============================================================================
# Generic UOM sync for single-doc forms (Work Order + BOM)
#
# CONTEXT: Bidirectional sync between the standard qty field and the TOC
#   custom UOM trio (custom_uom + custom_uom_conversion_factor +
#   custom_qty_in_uom). Forward (custom → standard) is handled by the JS
#   controllers. Reverse (standard → custom) is handled here, server-side,
#   on every validate. This catches:
#     - User typed value in standard qty field (admin only — locked
#       otherwise) — UI handler keeps custom in sync, validate confirms.
#     - Programmatic writes by ERPNext / scripts / scheduler — UI handler
#       doesn't fire here; validate is the only sync gate.
#     - Form save after JS controller failed to load — validate ensures
#       data is coherent regardless.
#
#   Idempotent + user-safe (mirrors _stamp_uom_fields_on_pp):
#     - If custom_uom set: keep it, look up CF
#     - If custom_uom blank AND production_item/item is set: auto-pick
#       largest-CF non-stock UOM
#     - custom_qty_in_uom always = standard_qty / CF
#
#   2026-05-19 — added per user requirement: "all custom uom and qty
#   field should proper both ways or bidirectional sync with in build
#   field. If the inbuild field some changes, the changes will don on
#   the toc custom fields."
# =============================================================================
def _sync_uom_on_single_doc(doc, item_field, std_qty_field, qiu_field="custom_qty_in_uom",
                             extra_mirrors=None):
    """
    Recompute the TOC UOM trio on `doc` based on the value of
    `doc[std_qty_field]`. Works for any single-document form (WO, BOM)
    where `doc[item_field]` is the production item.

    `extra_mirrors` — optional list of (std_field, mirror_field) tuples to
    additionally back-fill. Used by Work Order to mirror `produced_qty`
    into `custom_produced_qty_in_uom`. Each mirror = std / CF.

    Idempotent. Never overwrites a user-picked custom_uom; only auto-picks
    when blank.
    """
    item_code = doc.get(item_field)
    if not item_code:
        return    # no item → can't look up a UOM ladder

    std_qty = flt(doc.get(std_qty_field) or 0)

    # Resolve the chosen UOM (or auto-pick).
    custom_uom = (doc.get("custom_uom") or "").strip()
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""

    if custom_uom:
        # User has a UOM picked. Look up its CF (might be 0 if user typed
        # a UOM not in the item's ladder — defensive fallback to 1).
        cf = flt(frappe.db.get_value(
            "UOM Conversion Detail",
            {"parent": item_code, "parenttype": "Item", "uom": custom_uom},
            "conversion_factor",
        ) or 1.0)
    else:
        # Auto-pick largest non-stock UOM. If none, fall back to stock.
        row = frappe.db.sql(
            """
            SELECT uom, conversion_factor
            FROM `tabUOM Conversion Detail`
            WHERE parent = %(item)s AND parenttype = 'Item'
              AND uom != %(s)s
              AND IFNULL(conversion_factor, 0) > 1
            ORDER BY conversion_factor DESC LIMIT 1
            """, {"item": item_code, "s": stock_uom}, as_dict=True)
        if row:
            doc.custom_uom = row[0].uom
            cf = flt(row[0].conversion_factor)
        else:
            # No alt UOM exists — leave custom_uom blank, CF=1.
            cf = 1.0

    doc.custom_uom_conversion_factor = cf
    # Always recompute the in-UOM display from the (possibly updated)
    # standard qty. This is the REVERSE sync direction.
    doc.set(qiu_field, (std_qty / cf) if cf else 0)
    # 2026-05-19 — extra mirrors (e.g., WO.produced_qty → WO.custom_produced_qty_in_uom)
    for std_f, mirror_f in (extra_mirrors or []):
        std_val = flt(doc.get(std_f) or 0)
        doc.set(mirror_f, (std_val / cf) if cf else 0)


def stamp_uom_fields_on_wo_validate(doc, method=None):
    """
    Frappe doc_event hook called on Work Order.validate.

    Keeps WO.custom_uom + CF + custom_qty_in_uom in sync with the
    standard `qty` field. Runs on every save (draft, submit, edits).

    2026-05-19 — Also mirrors WO.produced_qty (label "Manufactured Qty")
    into WO.custom_produced_qty_in_uom via the extra_mirrors arg.

    2026-05-19 (later) — Also mirrors the SYSTEM fields `creation` and
    `owner` into custom_created_time + custom_created_by. Reason: Frappe's
    standard List View only renders columns from `meta.fields`; system
    fields aren't there. The mirrors enter the pool as proper Custom
    Fields and render as ordinary columns.
    """
    try:
        _sync_uom_on_single_doc(doc,
                                item_field="production_item",
                                std_qty_field="qty",
                                extra_mirrors=[
                                    ("produced_qty", "custom_produced_qty_in_uom"),
                                ])
        # Mirror system fields → custom fields for list-view rendering
        if doc.get("creation"):
            doc.custom_created_time = doc.creation
        if doc.get("owner"):
            doc.custom_created_by = doc.owner
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"WO UOM stamp failed for {doc.name or '(new)'}",
        )


def refresh_produced_qty_mirrors(wo_name):
    """
    Recompute `custom_produced_qty_in_uom` on a Work Order AND on its
    parent Production Plan Item row, using each row's own CF.

    Called from the Stock Entry submit/cancel hook because ERPNext writes
    `produced_qty` via direct `frappe.db.set_value` calls inside
    `update_status` / `update_produced_qty`, which bypasses validate.
    Without this refresh, the in-UOM mirror would lag behind the standard
    field after a production entry posts.

    Idempotent. Reads existing CF on each row; doesn't touch custom_uom.
    """
    if not wo_name:
        return

    # ── 1. Work Order mirror ──
    try:
        wo = frappe.db.get_value(
            "Work Order", wo_name,
            ["produced_qty", "custom_uom_conversion_factor",
             "production_plan", "production_item"],
            as_dict=True) or {}
        cf = flt(wo.get("custom_uom_conversion_factor") or 0)
        if cf > 0:
            mirror = flt(wo.get("produced_qty") or 0) / cf
            frappe.db.set_value(
                "Work Order", wo_name,
                "custom_produced_qty_in_uom", mirror,
                update_modified=False)
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Produced-qty mirror refresh failed for WO {wo_name}",
        )

    # ── 2. Linked Production Plan Item rows ──
    pp_name = (wo or {}).get("production_plan")
    item_code = (wo or {}).get("production_item")
    if not pp_name or not item_code:
        return
    try:
        # ERPNext's PP Item.produced_qty is the SUM of WO.produced_qty for
        # all WOs created from this PP row. After this Stock Entry posts
        # against `wo_name`, ERPNext updates the PP Item row directly.
        rows = frappe.db.sql("""
            SELECT name, produced_qty, custom_uom_conversion_factor
            FROM `tabProduction Plan Item`
            WHERE parent = %(pp)s AND item_code = %(item)s
        """, {"pp": pp_name, "item": item_code}, as_dict=True)
        for r in rows:
            cf = flt(r.custom_uom_conversion_factor or 0)
            if cf > 0:
                mirror = flt(r.produced_qty or 0) / cf
                frappe.db.set_value(
                    "Production Plan Item", r.name,
                    "custom_produced_qty_in_uom", mirror,
                    update_modified=False)
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Produced-qty mirror refresh failed for PP {pp_name}",
        )


def refresh_wo_batch_fields(wo_name):
    """
    v0.0.15 (2026-05-27) — Mirror the produced Batch's identity + dates
    onto the Work Order's 4 list-view custom fields:
        custom_batch_no            ← Batch.name
        custom_manufacturing_date  ← Batch.manufacturing_date
        custom_batch_date          ← DATE(Batch.creation)
        custom_best_before_date    ← Batch.expiry_date

    Single-batch-per-WO assumption (chaizup site policy — every WO's
    Manufacture Stock Entry produces exactly one batch). If a WO ever
    produces >1 batch, we pick the EARLIEST one by Batch.creation so
    the displayed values are stable across the WO's lifetime.

    Reads from `tabBatch` where `reference_doctype = "Work Order"`
    AND `reference_name = wo_name`. Frappe's standard manufacturing
    flow writes this reference on every batch auto-created from a
    Manufacture Stock Entry — see ERPNext's
    `serial_and_batch_bundle.SerialandBatchBundle.create_batch_no` and
    the auto-generated Batch from `stock_entry.update_work_order`.

    Idempotent — re-running on a WO with already-mirrored values is a
    no-op (frappe.db.set_value short-circuits identical writes).

    RESTRICT:
        - The single-batch assumption is a SITE POLICY. If chaizup ever
          allows >1 batch per WO, this function must change to write a
          comma-separated list OR show the latest batch. Don't silently
          aggregate (e.g., MIN/MAX dates) — losing batch identity breaks
          the audit chain.
        - Don't change `reference_doctype = "Work Order"` to a different
          join (e.g., via Stock Entry Detail). ERPNext's Batch reference
          is the canonical "this batch was born from this WO" link.
    """
    if not wo_name:
        return
    try:
        row = frappe.db.sql("""
            SELECT name, manufacturing_date, expiry_date, DATE(creation) AS batch_date
              FROM `tabBatch`
             WHERE reference_doctype = 'Work Order'
               AND reference_name = %(wo)s
             ORDER BY creation ASC
             LIMIT 1
        """, {"wo": wo_name}, as_dict=True)
        if not row:
            return  # no batch yet — WO hasn't manufactured anything
        b = row[0]
        frappe.db.set_value("Work Order", wo_name, {
            "custom_batch_no":           b["name"],
            "custom_manufacturing_date": b["manufacturing_date"],
            "custom_batch_date":         b["batch_date"],
            "custom_best_before_date":   b["expiry_date"],
        }, update_modified=False)
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"WO batch-fields refresh failed for {wo_name}",
        )


def on_stock_entry_submit_refresh_produced(doc, method=None):
    """
    Frappe doc_event hook called on Stock Entry submit/cancel/amend.

    When the Stock Entry is tied to a Work Order, refresh the produced-qty
    mirror on that WO + its parent PP row. ERPNext writes `produced_qty`
    outside the validate path (via direct frappe.db.set_value in
    Work Order.update_status / update_produced_qty), so this hook is the
    only sync point on the production-entry side.

    Idempotent + safe — wraps the refresh in try/except so a Stock Entry
    submit never fails due to mirror recomputation.

    2026-05-19 — added per user requirement: "On production entry this
    should also update properly".

    2026-05-25 (v0.0.10) — Trigger logic SIMPLIFIED. Previous condition
    only refreshed when stock_entry_type == "Manufacture" or "Material
    Transfer for Manufacture". But:
      - Custom Stock Entry Types named e.g. "Manufacture - Plant A" carry
        the right purpose internally but failed the literal name check.
      - The nested `if purpose != "Material Transfer for Manufacture":
        return` was logically wrong — it always returned for unknown
        purposes, including Manufacture-purpose entries with a custom
        stock_entry_type name. This is the root cause of MFG-WO-2026-*
        rows showing 0 or stale custom_produced_qty_in_uom while
        produced_qty has advanced (e.g., WO 00309: produced_qty=5520,
        mirror=78 corresponds to old produced_qty=4680 × cf=60).

    The new condition: if doc.work_order is set, refresh. The mirror
    computation reads CURRENT produced_qty from the DB, so it's harmless
    to refresh on entries that didn't actually advance produced_qty (it
    just re-writes the same value).

    RESTRICT: do NOT re-add a purpose-name filter here. The work_order
    field is itself the gate — it's only set on entries that affect WO
    state. Any name-based filter risks reintroducing the same drift.
    """
    try:
        wo_name = doc.get("work_order")
        if wo_name:
            refresh_produced_qty_mirrors(wo_name)
            # v0.0.15 — also refresh the 4 batch-identity custom fields
            # so the list view's Batch No / Manufacture Date / Batch Date /
            # Best Before columns stay in sync with the produced Batch row.
            refresh_wo_batch_fields(wo_name)
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"Stock Entry produced-qty mirror hook failed for {doc.name}",
        )


def stamp_uom_fields_on_bom_validate(doc, method=None):
    """
    Frappe doc_event hook called on BOM.validate.

    Keeps BOM.custom_uom + CF + custom_qty_in_uom in sync with the
    standard `quantity` field.

    2026-05-19 (later) — Also mirrors the SYSTEM fields `creation` and
    `owner` into custom_created_time + custom_created_by. Same reason as
    Work Order: standard List View can't render system fields directly,
    so the mirrors enter meta.fields and become proper columns.
    """
    try:
        _sync_uom_on_single_doc(doc,
                                item_field="item",
                                std_qty_field="quantity")
        if doc.get("creation"):
            doc.custom_created_time = doc.creation
        if doc.get("owner"):
            doc.custom_created_by = doc.owner
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"BOM UOM stamp failed for {doc.name or '(new)'}",
        )


def _stamp_toc_fields_on_work_orders(pp_name, toc_data=None, recorded_by="By System"):
    """
    Stamp TOC buffer metadata on all Work Orders produced by pp_name.

    toc_data:    buffer snapshot dict with keys zone/bp_pct/target_buffer/
                 inventory_position/sr_pct. Set by the engine path for
                 buffer-triggered PPs; left None for projection PPs and
                 user-initiated PP→Make Work Order flows.
    recorded_by: value to write into custom_toc_recorded_by.
                 - "By System" (default): used by the engine auto-PP path
                   (`_save_and_submit_production_plan`) — these WOs ARE
                   system-created, and downstream PO/MR overrides gate on
                   this value to recognise TOC-automation docs.
                 - None: skip the recorded_by write entirely. Used by the
                   user-initiated PP→Make Work Order override
                   (`ChaizupProductionPlan.make_work_order`) — those WOs
                   were spawned by a button click, not by the engine, so
                   they should NOT be tagged "By System".

    2026-05-14: Also copies the PP's custom_creation_reason into every WO's
    `description` field (only if the WO description is blank — never overwrite
    a manually edited description) so any operator opening the WO can see the
    auto-creation rationale + the configured pending-status rule without
    drilling back into the parent Production Plan.

    2026-05-19: Added `recorded_by` param so the user-initiated PP→WO
    override can reuse this stamper for UOM + MRP defaults without
    mis-tagging button-driven WOs as "By System".
    """
    wo_names = frappe.get_all(
        "Work Order",
        filters={"production_plan": pp_name},
        pluck="name",
    )
    if not wo_names:
        return

    fields = {}
    if recorded_by:
        fields["custom_toc_recorded_by"] = recorded_by
    if toc_data:
        fields.update({
            "custom_toc_zone":               toc_data.get("zone", ""),
            "custom_toc_bp_pct":             flt(toc_data.get("bp_pct", 0)),
            "custom_toc_target_buffer":      flt(toc_data.get("target_buffer", 0)),
            "custom_toc_inventory_position": flt(toc_data.get("inventory_position", 0)),
            "custom_toc_sr_pct":             flt(toc_data.get("sr_pct", 0)),
        })

    # Pull the PP's creation reason once — same string gets stamped on every WO.
    pp_reason = frappe.db.get_value("Production Plan", pp_name, "custom_creation_reason") or ""
    auto_wo_description = ""
    if pp_reason:
        try:
            from chaizup_toc.toc_engine.auto_remarks import format_auto_creation_remark
            # Build a per-WO description that names the WO scope explicitly,
            # then inlines the PP-level reason for traceability.
            auto_wo_description = format_auto_creation_remark(
                doc_type="Work Order",
                item_code="(see WO header)",
                warehouse="(see WO header)",
                qty="(see WO header)",
                reason_summary=f"Auto-created by Production Plan {pp_name}.",
                source_engine="TOC Engine (via PP)",
            )
            auto_wo_description += "\n\n── Production Plan reason ──\n" + pp_reason
        except Exception:
            auto_wo_description = pp_reason

    for wo_name in wo_names:
        # 2026-05-19 — Skip the buffer/recorded_by UPDATE entirely if `fields`
        # is empty. Empty dict → empty SET clause → MySQL 1065 ("Query was
        # empty") on `frappe.db.set_value`. Hit when this function is called
        # by the user-initiated PP→Make Work Order override with
        # `recorded_by=None` AND no toc_data — both are skipped so `fields`
        # is `{}`. Without this guard the error propagates up and bypasses
        # the inner UOM/MRP stamping inside the try block below.
        if fields:
            frappe.db.set_value("Work Order", wo_name, fields, update_modified=False)
        # 2026-05-18 — MRP propagation: every auto-created WO gets MRP from
        # its production_item. Source = "Auto from Item" so the WO form
        # shows the value as read-only by default; user can switch to
        # Manual to override.
        # 2026-05-19 — Also stamp the UOM trio: custom_uom (largest-CF UOM
        # of the production item), custom_uom_conversion_factor, and
        # custom_qty_in_uom = qty / CF. Keeps the WO's new "MRP & UOM"
        # section coherent on first paint.
        try:
            pi, wo_qty = frappe.db.get_value(
                "Work Order", wo_name, ["production_item", "qty"]) or (None, 0)
            if pi:
                wo_mrp = flt(frappe.db.get_value("Item", pi, "custom_mrp") or 0)
                # Pick largest-CF non-stock UOM from the item ladder.
                stock_uom = frappe.db.get_value("Item", pi, "stock_uom") or ""
                row = frappe.db.sql(
                    """
                    SELECT uom, conversion_factor
                    FROM `tabUOM Conversion Detail`
                    WHERE parent = %(item)s AND parenttype = 'Item'
                      AND uom != %(s)s
                      AND IFNULL(conversion_factor, 0) > 1
                    ORDER BY conversion_factor DESC LIMIT 1
                    """, {"item": pi, "s": stock_uom}, as_dict=True)
                uom = row[0].uom if row else ""
                cf  = flt(row[0].conversion_factor) if row else 1.0
                frappe.db.set_value(
                    "Work Order", wo_name,
                    {
                        "custom_mrp":                   wo_mrp,
                        "custom_mrp_source":            "Auto from Item",
                        "custom_uom":                   uom,
                        "custom_uom_conversion_factor": cf,
                        "custom_qty_in_uom":            (flt(wo_qty) / cf) if cf else 0,
                    },
                    update_modified=False,
                )
        except Exception:
            # Don't block stamping if Custom Fields aren't synced yet.
            pass
        if auto_wo_description:
            # Only stamp description when currently blank — preserve operator edits.
            current = frappe.db.get_value("Work Order", wo_name, "description") or ""
            if not current.strip():
                frappe.db.set_value(
                    "Work Order", wo_name, "description",
                    auto_wo_description, update_modified=False,
                )


# =============================================================================
# DEDUP HELPER
# CONTEXT: Checks whether a non-cancelled System PP already exists for the
#   given projection + item_code combination (via Production Plan Item join).
# RETURNS: PP name (str) if duplicate found, else None.
# DANGER ZONE:
#   - docstatus != 2 excludes only Cancelled plans. Draft (0) and Submitted (1)
#     both block re-creation because they represent live/active plans.
#   - Queries pp.custom_projection_reference — this column only exists after
#     chaizup_toc fixtures are imported to tabProduction Plan. If the column is
#     missing, this query raises OperationalError 1054. Fix by importing the
#     fixtures via bench console: frappe.utils.fixtures.sync_fixtures(app='chaizup_toc')
#     + manual insert if sync_fixtures silently fails (known issue on some sites).
# =============================================================================
def _pp_exists_for_item(projection_name, item_code):
    """Return existing PP name if a System PP already exists for this projection+item."""
    result = frappe.db.sql(
        """
        SELECT pp.name
        FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
        WHERE pp.custom_projection_reference = %s
          AND pp.custom_created_by = 'System'
          AND pp.docstatus != 2
          AND ppi.item_code = %s
        LIMIT 1
        """,
        [projection_name, item_code],
        as_dict=True,
    )
    return result[0].name if result else None


# =============================================================================
# MIN MANUFACTURING MAP BUILDER
# CONTEXT: Reads each item's custom_minimum_manufacture child table on Item Master
#   (Custom Field: Item.custom_minimum_manufacture → Item Minimum Manufacture).
#   Returns {(item_code, warehouse): qty_in_stock_uom} lookup dict.
#   UOM conversion: min_qty × conversion_factor from UOM Conversion Detail.
#
# DANGER ZONE:
#   - If no UOM Conversion Detail row exists for the specified UOM, factor
#     defaults to 1.0. Silent fallback — configure correct UOM on Item Master.
#   - Reads from "Item Minimum Manufacture" child table. If DocType is ever
#     renamed, update both this function and the fixtures/custom_field.json.
# RESTRICT:
#   - Do NOT read from sp_doc.minimum_manufacture (moved to Item Master in v3).
# =============================================================================
def _build_min_mfg_index(item_codes):
    """SPA-001 (2026-05-14): richer per-row index for Shortage Cover + Shortage Action.

    Returns a dict keyed by `(item_code, warehouse)` whose value is a
    `frappe._dict` carrying:
      - min_qty_stock_uom    : Min Qty converted from row.uom → stock UOM
      - action_type          : "Manufacture" | "Purchase"
      - auto_on_shortage     : 0 / 1
      - auto_on_max_level    : 0 / 1
      - max_level_threshold_pct : Float (0..100)
      - max_level            : Float (already in stock UOM — engine-owned)
      - lead_time_days       : Int
      - safety_factor        : Float
      - row_name             : DB name of the Item Minimum Manufacture child
                                (needed when the engine wants to stamp
                                `last_updated_on` after evaluating).

    The legacy `_build_min_mfg_map` returns just the float MOQ map and is
    kept for back-compat (Calc A / Calc B / v1 _process_item still call
    it). All new flows (Calc SO action-aware, Calc Action) MUST use this
    index instead so they pick up the new columns.

    DANGER:
      - Hardcoded fieldnames map directly to columns in
        `tabItem Minimum Manufacture`. Renaming any field here OR in the
        doctype JSON without coordinating both sides silently drops the
        action_type to None and the engine defaults to Manufacture.
    """
    index = {}
    if not item_codes:
        return index
    rows = frappe.db.get_all(
        "Item Minimum Manufacture",
        filters={
            "parent": ["in", list(item_codes)],
            "parentfield": "custom_minimum_manufacture",
        },
        fields=[
            "name", "parent", "warehouse",
            "min_manufacturing_qty", "uom",
            "action_type", "auto_on_shortage", "auto_on_max_level",
            "max_level_threshold_pct", "max_level",
            "lead_time_days", "safety_factor",
        ],
    )
    # Cache stock_uom per item to avoid N+1 queries.
    stock_uoms = {
        r["name"]: r["stock_uom"]
        for r in frappe.db.get_all(
            "Item",
            filters={"name": ["in", list({r["parent"] for r in rows})]} if rows else {"name": ["in", []]},
            fields=["name", "stock_uom"],
        )
    } if rows else {}

    for row in rows:
        if not row.warehouse:
            continue
        item_code = row.parent
        stock_uom = stock_uoms.get(item_code) or ""
        min_qty   = flt(row.min_manufacturing_qty or 0)
        if min_qty <= 0:
            qty_in_stock = 0.0
        elif not row.uom or row.uom == stock_uom:
            qty_in_stock = min_qty
        else:
            cf = flt(
                frappe.db.get_value(
                    "UOM Conversion Detail",
                    {"parent": item_code, "uom": row.uom},
                    "conversion_factor",
                ) or 1.0
            )
            qty_in_stock = min_qty * cf

        index[(item_code, row.warehouse)] = frappe._dict({
            "row_name":               row.name,
            "min_qty_stock_uom":      qty_in_stock,
            "action_type":            (row.action_type or "Manufacture"),
            "auto_on_shortage":       int(row.auto_on_shortage or 0),
            "auto_on_max_level":      int(row.auto_on_max_level or 0),
            "max_level_threshold_pct": flt(row.max_level_threshold_pct or 0),
            "max_level":              flt(row.max_level or 0),
            "lead_time_days":         int(row.lead_time_days or 0),
            "safety_factor":          flt(row.safety_factor or 0) or 1.0,
        })
    return index


def _build_min_mfg_map(item_codes):
    """Build {(item_code, warehouse): min_qty_in_stock_uom} from Item Master child table."""
    mfg_map = {}
    for item_code in item_codes:
        try:
            rows = frappe.db.get_all(
                "Item Minimum Manufacture",
                filters={"parent": item_code, "parentfield": "custom_minimum_manufacture"},
                fields=["warehouse", "min_manufacturing_qty", "uom"],
            )
            if not rows:
                continue

            stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""

            for row in rows:
                if not row.warehouse or not row.min_manufacturing_qty:
                    continue
                min_qty = flt(row.min_manufacturing_qty)
                if min_qty <= 0:
                    continue

                if not row.uom or row.uom == stock_uom:
                    qty_in_stock = min_qty
                else:
                    cf = flt(
                        frappe.db.get_value(
                            "UOM Conversion Detail",
                            {"parent": item_code, "uom": row.uom},
                            "conversion_factor",
                        ) or 1.0
                    )
                    qty_in_stock = min_qty * cf

                mfg_map[(item_code, row.warehouse)] = qty_in_stock

        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC PP: min_mfg_map build error for item {item_code}",
            )

    return mfg_map


# =============================================================================
# SQL HELPERS — Warehouse-Scoped Demand Components
#
# CONTEXT: SQL queries for SO demand components.
#   PATH A — Draft + Configured Workflow States (docstatus=0):
#     workflow_state IN confirmed_states (read from TOC Settings, default ['Confirmed']).
#     ONLY included when a Workflow is assigned to Sales Order — Frappe adds the
#     workflow_state column dynamically. If no workflow exists, PATH A is skipped.
#   PATH B — Submitted + status in configured pending list (docstatus=1):
#     status IN pending_statuses (read from TOC Settings).
#   ALWAYS EXCLUDED:
#     - docstatus=2 (Cancelled)
#     - Lines where soi.stock_qty <= delivered_qty * conversion_factor (fully delivered)
#     - SOs with blank set_warehouse
#
# INSTRUCTIONS:
#   - SQL uses positional %s — never f-string user values into SQL.
#   - delivery_date used for demand scheduling (not transaction_date).
#   - All queries filter by so.set_warehouse = warehouse.
#
# DANGER ZONE:
#   - confirmed_states is read from TOC Settings at runtime. If the field is
#     blank, _parse_confirmed_states falls back to ['Confirmed'].
#   - If pending_statuses is empty, PATH B is skipped. PATH A still runs (if workflow exists).
#   - so.set_warehouse may be blank on some SOs → excluded. Intentional.
#   - workflow_state column only exists when a Workflow is assigned to Sales Order.
#     Querying it on a site with no SO Workflow causes OperationalError 1054.
#     Always guard PATH A with _so_has_workflow_column() before adding that condition.
# =============================================================================

_so_workflow_column_cache = None  # module-level cache; resets on worker restart


def _so_has_workflow_column():
    """
    Return True if tabSales Order has a workflow_state column.
    Frappe only adds this column when a Workflow is assigned to the DocType.
    Result is cached at module level to avoid repeated INFORMATION_SCHEMA lookups.
    """
    global _so_workflow_column_cache
    if _so_workflow_column_cache is None:
        _so_workflow_column_cache = frappe.db.has_column("Sales Order", "workflow_state")
    return _so_workflow_column_cache


def _so_conditions_and_params(item_code, pending_statuses, confirmed_states):
    """
    Build the WHERE clause fragments and params list for SO eligibility.
    Returns (so_conditions: list[str], params: list) with item_code pre-added.
    Caller appends warehouse/date params after.
    """
    so_conditions = []
    params = [item_code]

    # PATH A: Draft + configured workflow states.
    # Guard: skip entirely if workflow_state column does not exist (no SO Workflow assigned).
    if confirmed_states and _so_has_workflow_column():
        states_ph = ", ".join(["%s"] * len(confirmed_states))
        so_conditions.append(f"(so.docstatus = 0 AND so.workflow_state IN ({states_ph}))")
        params.extend(confirmed_states)

    # PATH B: Submitted + status in configured pending list
    if pending_statuses:
        ph = ", ".join(["%s"] * len(pending_statuses))
        so_conditions.append(f"(so.docstatus = 1 AND so.status IN ({ph}))")
        params.extend(pending_statuses)

    return so_conditions, params


def _prev_month_so_qty(item_code, pending_statuses, confirmed_states, month_start, warehouse):
    """
    SUM pending SO qty where delivery_date < month_start AND SO warehouse = projected warehouse.
    Used in Calc 1 as carryover demand from prior months.

    UOM: returns qty in stock_uom.
      soi.stock_qty                                  = ordered qty in stock_uom
      soi.delivered_qty * soi.conversion_factor      = delivered qty in stock_uom
      Pending (stock_uom) = stock_qty - delivered_qty * conversion_factor
    """
    so_conditions, params = _so_conditions_and_params(item_code, pending_statuses, confirmed_states)
    if not so_conditions:
        return 0.0

    params.extend([month_start, warehouse])

    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(
            soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        ), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND ({" OR ".join(so_conditions)})
          AND so.delivery_date < %s
          AND soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND so.set_warehouse = %s
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _curr_month_so_qty(item_code, pending_statuses, confirmed_states,
                       month_start, next_month_start, warehouse):
    """
    SUM pending SO qty where delivery_date falls within the projection month.
    Used in Calc 1 as demand already being served within the projection window.

    UOM: returns qty in stock_uom (soi.stock_qty - delivered_qty * conversion_factor).
    """
    so_conditions, params = _so_conditions_and_params(item_code, pending_statuses, confirmed_states)
    if not so_conditions:
        return 0.0

    params.extend([month_start, next_month_start, warehouse])

    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(
            soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        ), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND ({" OR ".join(so_conditions)})
          AND so.delivery_date >= %s
          AND so.delivery_date < %s
          AND soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND so.set_warehouse = %s
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _all_pending_so_qty(item_code, pending_statuses, confirmed_states, warehouse):
    """
    SUM ALL pending SO qty for item+warehouse with NO delivery_date restriction.
    Used in Calc 2 (no forecast) to determine if any SO demand exists at all.

    UOM: returns qty in stock_uom (soi.stock_qty - delivered_qty * conversion_factor).
    """
    so_conditions, params = _so_conditions_and_params(item_code, pending_statuses, confirmed_states)
    if not so_conditions:
        return 0.0

    params.append(warehouse)

    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(
            soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        ), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND ({" OR ".join(so_conditions)})
          AND soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND so.set_warehouse = %s
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _pending_pp_qty(item_code, warehouse):
    """
    SUM planned_qty from non-cancelled Production Plans for this item+warehouse.
    Counts Draft (0) and Submitted (1) PPs — represents production commitments
    already in the pipeline (planned but not yet produced).

    Column: ppi.planned_qty (NOT ppi.qty — that column does not exist in ERPNext).
    The Production Plan Item table uses 'planned_qty' for the planned production quantity.
    """
    result = frappe.db.sql(
        """
        SELECT COALESCE(SUM(ppi.planned_qty), 0) AS qty
        FROM `tabProduction Plan Item` ppi
        JOIN `tabProduction Plan` pp ON pp.name = ppi.parent
        WHERE ppi.item_code = %s
          AND ppi.warehouse = %s
          AND pp.docstatus != 2
        """,
        [item_code, warehouse],
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _warehouse_stock(item_code, warehouse):
    """Get Bin.actual_qty for a specific item in a specific warehouse only."""
    result = frappe.db.sql(
        """
        SELECT COALESCE(SUM(actual_qty), 0) AS qty
        FROM `tabBin`
        WHERE item_code = %s AND warehouse = %s
        """,
        [item_code, warehouse],
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


# =============================================================================
# UTILITY HELPERS
# =============================================================================

def _parse_statuses(raw_text):
    """Convert newline-separated SO statuses string from TOC Settings into a list."""
    if not raw_text:
        return ["To Deliver and Bill", "To Deliver", "On Hold"]
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


def _parse_confirmed_states(raw_text):
    """Convert newline-separated workflow state names from TOC Settings into a list."""
    if not raw_text:
        return ["Confirmed"]
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


# BTP-001 (2026-05-14): WO + PO status parsers — read from TOC Settings.
# Defaults match the legacy hardcoded engine clauses so behaviour is
# unchanged when the new fields are left blank on existing sites.

def _parse_wo_statuses(raw_text):
    """Pending Work Order statuses (submitted, status IN this set)."""
    if not raw_text:
        return ["Not Started", "In Process", "Material Transferred"]
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


def _parse_wo_workflow_states(raw_text):
    """Workflow states on Draft WOs to count as open (optional)."""
    if not raw_text:
        return []
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


def _parse_po_statuses(raw_text):
    """Pending Purchase Order statuses (submitted, status IN this set)."""
    if not raw_text:
        return ["To Receive", "To Receive and Bill"]
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


def _parse_po_workflow_states(raw_text):
    """Workflow states on Draft POs to count as open (optional)."""
    if not raw_text:
        return []
    return [s.strip() for s in raw_text.strip().split("\n") if s.strip()]


def _wo_has_workflow_column():
    """Cached check — has tabWork Order got a workflow_state column?"""
    global _wo_workflow_column_cache
    try:
        return _wo_workflow_column_cache
    except NameError:
        pass
    _wo_workflow_column_cache = bool(frappe.db.has_column("Work Order", "workflow_state"))
    return _wo_workflow_column_cache


def _po_has_workflow_column():
    """Cached check — has tabPurchase Order got a workflow_state column?"""
    global _po_workflow_column_cache
    try:
        return _po_workflow_column_cache
    except NameError:
        pass
    _po_workflow_column_cache = bool(frappe.db.has_column("Purchase Order", "workflow_state"))
    return _po_workflow_column_cache


def _toc_wo_statuses_and_wf():
    """Return (statuses, workflow_states) for Work Orders from TOC Settings.

    Reads from the cached TOC Settings doc. Both lists are guaranteed
    non-None (default lists used when blank).
    """
    s = frappe.get_cached_doc("TOC Settings")
    return (
        _parse_wo_statuses(s.get("pending_wo_statuses")),
        _parse_wo_workflow_states(s.get("pending_wo_workflow_states")),
    )


def _toc_po_statuses_and_wf():
    """Return (statuses, workflow_states) for Purchase Orders from TOC Settings."""
    s = frappe.get_cached_doc("TOC Settings")
    return (
        _parse_po_statuses(s.get("pending_po_statuses")),
        _parse_po_workflow_states(s.get("pending_po_workflow_states")),
    )


def _wo_eligibility_sql(wo_statuses, wo_workflow_states, alias="wo"):
    """Build the SQL fragment for an `open WO` filter.

    Submitted + status IN (...) OR Draft + workflow_state IN (...) when
    the workflow column exists. Returns SQL text only; the caller binds
    the params in this order: wo_statuses..., wo_workflow_states... (only
    when the workflow column exists).
    """
    parts = []
    if wo_statuses:
        ph = ", ".join(["%s"] * len(wo_statuses))
        parts.append(f"({alias}.docstatus = 1 AND {alias}.status IN ({ph}))")
    if wo_workflow_states and _wo_has_workflow_column():
        ph = ", ".join(["%s"] * len(wo_workflow_states))
        parts.append(f"({alias}.docstatus = 0 AND {alias}.workflow_state IN ({ph}))")
    if not parts:
        return "1=0"
    return " OR ".join(parts)


def _po_eligibility_sql(po_statuses, po_workflow_states, alias="po"):
    """Same shape as `_wo_eligibility_sql` but for Purchase Orders."""
    parts = []
    if po_statuses:
        ph = ", ".join(["%s"] * len(po_statuses))
        parts.append(f"({alias}.docstatus = 1 AND {alias}.status IN ({ph}))")
    if po_workflow_states and _po_has_workflow_column():
        ph = ", ".join(["%s"] * len(po_workflow_states))
        parts.append(f"({alias}.docstatus = 0 AND {alias}.workflow_state IN ({ph}))")
    if not parts:
        return "1=0"
    return " OR ".join(parts)


def _month_boundaries(sp_doc):
    """Return (month_start, next_month_start) as 'YYYY-MM-DD' strings."""
    month_idx = MONTH_NAMES.index(sp_doc.projection_month) + 1
    year = int(sp_doc.projection_year)
    month_start = datetime.date(year, month_idx, 1)
    if month_idx == 12:
        next_month_start = datetime.date(year + 1, 1, 1)
    else:
        next_month_start = datetime.date(year, month_idx + 1, 1)
    return str(month_start), str(next_month_start)


def _get_company():
    """Resolve the default company for PP creation."""
    return (
        frappe.defaults.get_user_default("Company")
        or frappe.db.get_single_value("Global Defaults", "default_company")
        or ""
    )


# =============================================================================
# EMAIL NOTIFICATION
# CONTEXT: Sends one consolidated summary email per automation run.
#   Uses the TOC Settings notification users list (notify_on_wo_create flag).
#   Called inside a try/except in run_production_plan_automation so that email
#   failures never crash the automation response or the daily scheduler.
# DANGER:
#   - NEVER pass now=True to frappe.sendmail here. now=True sends synchronously
#     inside the after_commit hook chain. If the email account password decryption
#     fails (InvalidToken / key mismatch), the exception propagates back through
#     db.commit() and returns HTTP 500 to the caller even though PP + WO creation
#     already succeeded. Use the default queue mode (now=False) so failures are
#     isolated to the background email worker and appear in Email Queue, not 500s.
# RESTRICT:
#   - Do NOT call inside the item loop — one email per run, not one per item.
#   - Do NOT remove the try/except wrapper at the call site.
# =============================================================================

def _get_emails(users_list, flag_field):
    """Return email addresses from the notification users list where the given flag is set."""
    emails = []
    for row in (users_list or []):
        if not getattr(row, flag_field, 0):
            continue
        email = frappe.db.get_value("User", row.user, "email")
        if email:
            emails.append(email)
    return emails


def _send_pp_notification(sp_doc, results, triggered_by, settings):
    """Send a summary email after each Production Plan automation run."""
    if not settings.projection_notification_users:
        return
    recipients = _get_emails(settings.projection_notification_users, "notify_on_wo_create")
    if not recipients:
        return

    created = [r for r in results if r["status"] == "Created"]
    skipped = [r for r in results if r["status"] != "Created"]

    trigger_label = "Daily Scheduler (02:00 AM)" if triggered_by == "system" else "Manual Trigger"
    subject = (
        f"PP Automation — {sp_doc.projection_month} {sp_doc.projection_year} "
        f"/ {sp_doc.source_warehouse}: "
        f"{len(created)}/{len(results)} Production Plans Created [{trigger_label}]"
    )

    site_url = frappe.utils.get_url()
    sp_link = f"{site_url}/app/sales-projection/{sp_doc.name}"

    td = "padding:6px 10px;border:1px solid #ddd"
    th = f"{td};background:#f5f5f5;font-weight:bold"

    created_rows = ""
    for r in created:
        pp_link = f"{site_url}/app/production-plan/{r['pp_name']}"
        created_rows += (
            f"<tr>"
            f"<td style='{td}'><a href='{pp_link}'>{r['pp_name']}</a></td>"
            f"<td style='{td}'>{r['item_code']}</td>"
            f"<td style='{td}'>{r.get('item_name','')}</td>"
            f"<td style='{td};text-align:right'>{r.get('production_qty',0):.2f}</td>"
            f"<td style='{td};text-align:right'>{r.get('shortage',0):.2f}</td>"
            f"<td style='{td};text-align:right'>{r.get('prev_so',0):.2f}</td>"
            f"<td style='{td};text-align:right'>{r.get('curr_so',0):.2f}</td>"
            f"<td style='{td};text-align:right'>{r.get('stock',0):.2f}</td>"
            f"</tr>"
        )

    skipped_rows = ""
    for r in skipped:
        color = "#e74c3c" if "Error" in r["status"] else "#e67e22"
        skipped_rows += (
            f"<tr>"
            f"<td style='{td}'>{r['item_code']}</td>"
            f"<td style='{td}'>{r.get('item_name','')}</td>"
            f"<td style='{td};color:{color};font-weight:bold'>{r['status']}</td>"
            f"<td style='{td};color:#666;font-size:12px'>{r.get('reason','')}</td>"
            f"</tr>"
        )

    created_section = ""
    if created:
        created_section = f"""
        <h3 style="color:#27ae60;margin-top:20px">Production Plans Created ({len(created)})</h3>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <thead><tr>
            <th style="{th}">Production Plan</th><th style="{th}">Item Code</th>
            <th style="{th}">Item Name</th><th style="{th}">PP Qty</th>
            <th style="{th}">Shortage</th><th style="{th}">Carryover SO</th>
            <th style="{th}">Curr Month SO</th><th style="{th}">In Stock</th>
          </tr></thead>
          <tbody>{created_rows}</tbody>
        </table>"""

    skipped_section = ""
    if skipped:
        skipped_section = f"""
        <h3 style="color:#e67e22;margin-top:20px">Items Skipped ({len(skipped)})</h3>
        <table style="border-collapse:collapse;width:100%;font-size:13px">
          <thead><tr>
            <th style="{th}">Item Code</th><th style="{th}">Item Name</th>
            <th style="{th}">Skip Reason</th><th style="{th}">Details</th>
          </tr></thead>
          <tbody>{skipped_rows}</tbody>
        </table>"""

    message = f"""
    <div style="font-family:DM Sans,Arial,sans-serif;max-width:800px">
      <div style="background:#2980b9;color:#fff;padding:14px 20px;border-radius:6px 6px 0 0">
        <h2 style="margin:0;font-size:18px">Sales Projection → Production Plan Automation</h2>
        <p style="margin:4px 0 0;font-size:13px">
          {sp_doc.projection_month} {sp_doc.projection_year} / {sp_doc.source_warehouse}
          — {trigger_label}
        </p>
      </div>
      <div style="background:#fff;padding:20px;border:1px solid #eee;border-radius:0 0 6px 6px">
        <p>Projection: <a href="{sp_link}">{sp_doc.name}</a>
           &nbsp;|&nbsp; Items: {len(results)}
           &nbsp;|&nbsp; PPs created: {len(created)}
           &nbsp;|&nbsp; Skipped: {len(skipped)}</p>
        {created_section}
        {skipped_section}
        <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">
          Sent automatically by Chaizup TOC.<br>
          Manage notifications: TOC Settings → Sales Projection Automation → Notification Users.
        </p>
      </div>
    </div>"""

    # DANGER: Do NOT pass now=True — that sends synchronously in the after_commit hook.
    # If the email account password decryption fails (InvalidToken), now=True propagates
    # the exception back through db.commit() chain and returns a 500 to the caller even
    # though the automation already succeeded. Queue mode (default, now=False) isolates
    # email failures in the background worker — they appear in Email Queue, not as 500s.
    frappe.sendmail(recipients=recipients, subject=subject, message=message, now=False)


# =============================================================================
# 2026-05-08 · DUAL-CALC ENGINE (Calc A + Calc B)
# =============================================================================
#
# CONTEXT: New per-item driver that runs TWO sequential formulas:
#
#   Calc A — Forecast-driven (confirms PP exists for the projection):
#       Qty_A = (SPOW + PRVSO) − (CURRALSO + ITMWO + ITMWSTK)
#
#   Calc B — SO-driven safety net (catches over-projection silent-skip bug):
#       Qty_B = (PRVSO + CURRSO) − (ITMWSTK + ITMWO)
#
#   Both run per item; Calc A commits its PP+WO before Calc B reads ITMWO,
#   so Calc B sees fresh supply and never double-creates.
#
#   Variables:
#     SPOW      — Sales Projection of specific warehouse (Sales Projected Items.qty_in_stock_uom)
#     PRVSO     — Previous-month pending Sales Order qty (delivery_date < month_start)
#     CURRSO    — Current-month pending Sales Order qty (delivery_date in current month)
#     CURRALSO  — Current-month ALL Sales Order qty (completed + incomplete)
#     ITMWO     — Pending Work Order qty (qty - produced_qty) for item × FG warehouse
#     ITMWSTK   — Bin actual_qty for item × warehouse
#     MINMFG    — Item Minimum Manufacture row for warehouse, in stock UOM
#
# RESTRICT (do NOT change without review):
#   - Sequencing: Calc A → frappe.db.commit() → re-read ITMWO/ITMWSTK → Calc B.
#     Without the commit, Calc B sees stale supply and double-creates PPs.
#   - WO creation MUST go through Production Plan submit. Direct WO creation is forbidden.
#   - Field name `currALso` (mixed case) on TOC Production Plan Run Item is intentional
#     spec-literal; do NOT rename without updating the writer.
#   - default_so_warehouse fallback only activates when projection.source_warehouse equals
#     the configured default — never broadcast to other warehouses.
#   - Each per-item exception is caught and logged as one Run Item row with status="Error"
#     so a single bad item does not abort the whole run.
#   - frappe.db.commit() between Calc A and Calc B; Run Log parent updated atomically
#     after each per-item processing so partial run survives a worker timeout.
# =============================================================================


def _so_warehouse_filter(projection_warehouse, default_so_warehouse):
    """
    Build the warehouse-side WHERE fragment + params for SO queries.
    If projection's warehouse matches the configured default, we ALSO include
    SOs with blank set_warehouse (the fallback the user spec'd).
    """
    if default_so_warehouse and default_so_warehouse == projection_warehouse:
        clause = "(so.set_warehouse = %s OR COALESCE(NULLIF(so.set_warehouse, ''), '') = '')"
    else:
        clause = "so.set_warehouse = %s"
    return clause, [projection_warehouse]


def _prev_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                          month_start, warehouse, default_so_warehouse=None):
    """PRVSO with default-warehouse fallback. Pending qty (stock_uom)."""
    so_conditions, params = _so_conditions_and_params(item_code, pending_statuses, confirmed_states)
    if not so_conditions:
        return 0.0
    wh_clause, wh_params = _so_warehouse_filter(warehouse, default_so_warehouse)
    params.append(month_start)
    params.extend(wh_params)
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(
            soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        ), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND ({" OR ".join(so_conditions)})
          AND so.delivery_date < %s
          AND soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND {wh_clause}
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _curr_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                          month_start, next_month_start, warehouse, default_so_warehouse=None):
    """CURRSO with default-warehouse fallback. Pending qty (stock_uom)."""
    so_conditions, params = _so_conditions_and_params(item_code, pending_statuses, confirmed_states)
    if not so_conditions:
        return 0.0
    wh_clause, wh_params = _so_warehouse_filter(warehouse, default_so_warehouse)
    params.extend([month_start, next_month_start])
    params.extend(wh_params)
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(
            soi.stock_qty - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        ), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND ({" OR ".join(so_conditions)})
          AND so.delivery_date >= %s
          AND so.delivery_date < %s
          AND soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND {wh_clause}
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _curr_month_all_so_qty(item_code, month_start, next_month_start, warehouse, default_so_warehouse=None):
    """
    CURRALSO — All current-month Sales Order qty (completed + pending), in stock UOM.

    Excludes only Cancelled (docstatus=2). Sums soi.stock_qty (gross ordered, no
    delivered subtraction) so completed orders count too — CURRALSO is "demand
    that's already booked / consumed" within the month per the user spec.
    """
    wh_clause, wh_params = _so_warehouse_filter(warehouse, default_so_warehouse)
    params = [item_code, month_start, next_month_start] + wh_params
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(soi.stock_qty), 0) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code = %s
          AND so.docstatus IN (0, 1)
          AND so.delivery_date >= %s
          AND so.delivery_date < %s
          AND {wh_clause}
        """,
        params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _pending_wo_qty(item_code, warehouse):
    """
    ITMWO — Pending Work Order qty (qty - produced_qty) for item × fg_warehouse.

    BTP-001 (2026-05-14): Pending WO statuses are now read from
    `TOC Settings.pending_wo_statuses` (+ optional draft workflow states
    from `pending_wo_workflow_states`). Defaults match the legacy
    hardcoded clause so existing sites with the field blank see no
    change. See `_wo_eligibility_sql` for the predicate shape.
    """
    wo_statuses, wo_wf = _toc_wo_statuses_and_wf()
    eligibility = _wo_eligibility_sql(wo_statuses, wo_wf, alias="wo")
    params = list(wo_statuses)
    if wo_wf and _wo_has_workflow_column():
        params += list(wo_wf)
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(GREATEST(wo.qty - IFNULL(wo.produced_qty, 0), 0)), 0) AS qty
        FROM `tabWork Order` wo
        WHERE wo.production_item = %s
          AND wo.fg_warehouse = %s
          AND ({eligibility})
        """,
        [item_code, warehouse] + params,
        as_dict=True,
    )
    return flt(result[0].qty if result else 0)


def _pp_exists_for_calc(projection_name, item_code, calc_label):
    """
    Per-calc dedup. Distinct from the v1 _pp_exists_for_item — we allow ONE PP per
    (projection, item, calc), so Calc A's PP doesn't block Calc B from creating its own.
    Looks at custom_creation_reason field to tell calcs apart.
    """
    if not projection_name:
        return None
    rows = frappe.db.sql(
        """
        SELECT pp.name
        FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
        WHERE pp.docstatus != 2
          AND pp.custom_projection_reference = %s
          AND ppi.item_code = %s
          AND pp.custom_creation_reason LIKE %s
        LIMIT 1
        """,
        [projection_name, item_code, f"%[{calc_label}]%"],
    )
    return rows[0][0] if rows else None


def _wo_names_for_pp(pp_name):
    """Return a comma-separated string of Work Order names linked to this PP."""
    if not pp_name:
        return ""
    rows = frappe.db.sql_list(
        """
        SELECT name FROM `tabWork Order`
        WHERE production_plan = %s AND docstatus != 2
        ORDER BY production_item
        """,
        pp_name,
    )
    return ", ".join(rows) if rows else ""


def _append_run_item(run_log_doc, payload):
    """Insert one TOC Production Plan Run Item row on the parent."""
    run_log_doc.append("items", {
        "item_code": payload.get("item_code"),
        "item_name": payload.get("item_name"),
        "warehouse": payload.get("warehouse"),
        "calc_used": payload.get("calc_used"),
        "status": payload.get("status"),
        "spow": flt(payload.get("spow")),
        "prvso": flt(payload.get("prvso")),
        "currso": flt(payload.get("currso")),
        "currALso": flt(payload.get("currALso")),
        "itmwo": flt(payload.get("itmwo")),
        "itmwstk": flt(payload.get("itmwstk")),
        "minmfg": flt(payload.get("minmfg")),
        "qty_of_shortage": flt(payload.get("qty_of_shortage")),
        "production_qty": flt(payload.get("production_qty")),
        "production_plan": payload.get("production_plan") or "",
        "work_orders": payload.get("work_orders") or "",
        "reason": payload.get("reason") or "",
    })


def _process_item_v2(row, sp_doc, settings, run_log_doc,
                    pending_statuses, confirmed_states,
                    month_start, next_month_start, company,
                    min_mfg_map, default_so_warehouse):
    """
    Run Calc A then (after commit) Calc B for a single item.
    Writes one or two rows to run_log_doc.items and returns summary counts.
    """
    item_code = row.item
    item_name = row.item_name or item_code
    warehouse = sp_doc.source_warehouse
    spow_qty  = flt(row.qty_in_stock_uom)
    summary = {"calc_a_created": 0, "calc_a_skipped": 0,
               "calc_b_created": 0, "calc_b_skipped": 0, "errors": 0}

    if not warehouse:
        if default_so_warehouse:
            warehouse = default_so_warehouse
        else:
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": "", "calc_used": "Calc A — Forecast",
                "status": "Skipped - No Warehouse",
                "spow": spow_qty,
                "reason": ("Sales Projection has no source_warehouse and "
                           "TOC Settings.default_so_warehouse is blank. "
                           "Cannot resolve which warehouse to plan for."),
            })
            summary["calc_a_skipped"] += 1
            summary["calc_b_skipped"] += 1
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": "", "calc_used": "Calc B — SO-driven",
                "status": "Skipped - No Warehouse",
                "spow": spow_qty,
                "reason": "Same as Calc A — no warehouse to plan for.",
            })
            return summary

    # ── BOM gate (applies to both calcs) ─────────────────────────────────────
    bom_no = frappe.db.get_value(
        "BOM",
        {"item": item_code, "is_default": 1, "is_active": 1, "docstatus": 1},
        "name",
    )
    if not bom_no:
        msg = (f"Item {item_code} has no active default submitted BOM. "
               f"Create a BOM, mark it Default + Active, and submit it.")
        for calc_label in ("Calc A — Forecast", "Calc B — SO-driven"):
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": calc_label,
                "status": "Skipped - No BOM",
                "spow": spow_qty,
                "reason": msg,
            })
        summary["calc_a_skipped"] += 1
        summary["calc_b_skipped"] += 1
        return summary

    minmfg = flt(min_mfg_map.get((item_code, warehouse), 0.0))

    # ── Compute Calc A inputs ────────────────────────────────────────────────
    try:
        prvso    = _prev_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                                         month_start, warehouse, default_so_warehouse)
        currso   = _curr_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                                         month_start, next_month_start, warehouse,
                                         default_so_warehouse)
        currALso = _curr_month_all_so_qty(item_code, month_start, next_month_start,
                                          warehouse, default_so_warehouse)
        itmwo    = _pending_wo_qty(item_code, warehouse)
        itmwstk  = _warehouse_stock(item_code, warehouse)

        qty_a = (spow_qty + prvso) - (currALso + itmwo + itmwstk)
        breakdown_a = (
            f"Calc A: ({spow_qty:.2f} SPOW + {prvso:.2f} PRVSO) − "
            f"({currALso:.2f} CURRALSO + {itmwo:.2f} ITMWO + {itmwstk:.2f} ITMWSTK) "
            f"= {qty_a:.2f}"
        )

        if qty_a <= 0:
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc A — Forecast",
                "status": "Skipped - No Shortage",
                "spow": spow_qty, "prvso": prvso, "currso": currso,
                "currALso": currALso, "itmwo": itmwo, "itmwstk": itmwstk,
                "minmfg": minmfg, "qty_of_shortage": qty_a,
                "reason": breakdown_a + " — projection met or oversupplied.",
            })
            summary["calc_a_skipped"] += 1
        elif _pp_exists_for_calc(sp_doc.name, item_code, "Calc A"):
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc A — Forecast",
                "status": "Skipped - PP Exists",
                "spow": spow_qty, "prvso": prvso, "currso": currso,
                "currALso": currALso, "itmwo": itmwo, "itmwstk": itmwstk,
                "minmfg": minmfg, "qty_of_shortage": qty_a,
                "reason": (f"{breakdown_a} — but a PP for [Calc A] already "
                           f"exists for this projection × item. Dedup."),
            })
            summary["calc_a_skipped"] += 1
        else:
            production_qty = max(qty_a, minmfg)
            reason_text = (
                f"[Calc A] {breakdown_a}. Floor (MINMFG) = {minmfg:.2f}. "
                f"Production qty = max(shortage, MINMFG) = {production_qty:.2f}. "
                f"Created from projection {sp_doc.name} for "
                f"{sp_doc.projection_month} {sp_doc.projection_year}."
            )
            pp_name = _create_production_plan(
                item_code, bom_no, production_qty, warehouse,
                reason_text, company, sp_doc.name,
            )
            frappe.db.commit()
            _submit_pp_and_create_work_orders(pp_name)
            frappe.db.commit()
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc A — Forecast",
                "status": "Created",
                "spow": spow_qty, "prvso": prvso, "currso": currso,
                "currALso": currALso, "itmwo": itmwo, "itmwstk": itmwstk,
                "minmfg": minmfg, "qty_of_shortage": qty_a,
                "production_qty": production_qty,
                "production_plan": pp_name,
                "work_orders": _wo_names_for_pp(pp_name),
                "reason": reason_text,
            })
            summary["calc_a_created"] += 1
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"TOC PP Automation v2: Calc A error for {item_code}",
        )
        _append_run_item(run_log_doc, {
            "item_code": item_code, "item_name": item_name,
            "warehouse": warehouse, "calc_used": "Calc A — Forecast",
            "status": "Error",
            "spow": spow_qty,
            "reason": f"Calc A raised: {str(frappe.get_traceback()[:500])}",
        })
        summary["errors"] += 1

    # ── Calc B — re-read ITMWO/ITMWSTK so Calc A's WO is reflected ──────────
    try:
        prvso_b    = _prev_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                                           month_start, warehouse, default_so_warehouse)
        currso_b   = _curr_month_so_qty_v2(item_code, pending_statuses, confirmed_states,
                                           month_start, next_month_start, warehouse,
                                           default_so_warehouse)
        itmwo_b    = _pending_wo_qty(item_code, warehouse)        # FRESH read
        itmwstk_b  = _warehouse_stock(item_code, warehouse)       # FRESH read

        qty_b = (prvso_b + currso_b) - (itmwstk_b + itmwo_b)
        breakdown_b = (
            f"Calc B: ({prvso_b:.2f} PRVSO + {currso_b:.2f} CURRSO) − "
            f"({itmwstk_b:.2f} ITMWSTK + {itmwo_b:.2f} ITMWO) = {qty_b:.2f}"
        )

        if (prvso_b + currso_b) <= 0:
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc B — SO-driven",
                "status": "Skipped - No Demand",
                "spow": spow_qty, "prvso": prvso_b, "currso": currso_b,
                "itmwo": itmwo_b, "itmwstk": itmwstk_b, "minmfg": minmfg,
                "qty_of_shortage": qty_b,
                "reason": (f"{breakdown_b} — no pending Sales Order demand "
                           f"(PRVSO + CURRSO = 0)."),
            })
            summary["calc_b_skipped"] += 1
        elif qty_b <= 0:
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc B — SO-driven",
                "status": "Skipped - No Shortage",
                "spow": spow_qty, "prvso": prvso_b, "currso": currso_b,
                "itmwo": itmwo_b, "itmwstk": itmwstk_b, "minmfg": minmfg,
                "qty_of_shortage": qty_b,
                "reason": (f"{breakdown_b} — stock + WO already cover SO demand "
                           f"(possibly because Calc A just created a WO)."),
            })
            summary["calc_b_skipped"] += 1
        elif _pp_exists_for_calc(sp_doc.name, item_code, "Calc B"):
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc B — SO-driven",
                "status": "Skipped - PP Exists",
                "spow": spow_qty, "prvso": prvso_b, "currso": currso_b,
                "itmwo": itmwo_b, "itmwstk": itmwstk_b, "minmfg": minmfg,
                "qty_of_shortage": qty_b,
                "reason": (f"{breakdown_b} — but a PP for [Calc B] already "
                           f"exists for this projection × item. Dedup."),
            })
            summary["calc_b_skipped"] += 1
        else:
            production_qty_b = max(qty_b, minmfg)
            reason_text = (
                f"[Calc B] {breakdown_b}. Floor (MINMFG) = {minmfg:.2f}. "
                f"Production qty = max(shortage, MINMFG) = {production_qty_b:.2f}. "
                f"Safety net for SO demand not covered by Calc A."
            )
            pp_name_b = _create_production_plan(
                item_code, bom_no, production_qty_b, warehouse,
                reason_text, company, sp_doc.name,
            )
            frappe.db.commit()
            _submit_pp_and_create_work_orders(pp_name_b)
            frappe.db.commit()
            _append_run_item(run_log_doc, {
                "item_code": item_code, "item_name": item_name,
                "warehouse": warehouse, "calc_used": "Calc B — SO-driven",
                "status": "Created",
                "spow": spow_qty, "prvso": prvso_b, "currso": currso_b,
                "itmwo": itmwo_b, "itmwstk": itmwstk_b, "minmfg": minmfg,
                "qty_of_shortage": qty_b,
                "production_qty": production_qty_b,
                "production_plan": pp_name_b,
                "work_orders": _wo_names_for_pp(pp_name_b),
                "reason": reason_text,
            })
            summary["calc_b_created"] += 1
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"TOC PP Automation v2: Calc B error for {item_code}",
        )
        _append_run_item(run_log_doc, {
            "item_code": item_code, "item_name": item_name,
            "warehouse": warehouse, "calc_used": "Calc B — SO-driven",
            "status": "Error",
            "spow": spow_qty,
            "reason": f"Calc B raised: {str(frappe.get_traceback()[:500])}",
        })
        summary["errors"] += 1

    return summary


def _run_for_projection(sp_doc, triggered_by, settings):
    """
    Drive one Sales Projection through Calc A + Calc B for every row.
    Creates ONE TOC Production Plan Run Log; returns the summary dict.
    """
    pending_statuses = _parse_statuses(settings.projection_pending_so_statuses)
    confirmed_states = _parse_confirmed_states(settings.projection_confirmed_so_workflow_states)
    month_start, next_month_start = _month_boundaries(sp_doc)
    company = _get_company()
    default_so_warehouse = settings.get("default_so_warehouse") or None
    min_mfg_map = _build_min_mfg_map([row.item for row in sp_doc.table_mibv])

    run_log = frappe.new_doc("TOC Production Plan Run Log")
    run_log.run_started = now_datetime()
    run_log.triggered_by = triggered_by
    run_log.company = company
    run_log.sales_projection = sp_doc.name
    run_log.warehouse = sp_doc.source_warehouse or default_so_warehouse or ""
    run_log.pending_so_statuses_used = "\n".join(pending_statuses) if pending_statuses else ""
    run_log.default_so_warehouse_used = default_so_warehouse or ""
    run_log.calc_a_created = 0
    run_log.calc_a_skipped = 0
    run_log.calc_b_created = 0
    run_log.calc_b_skipped = 0
    run_log.errors = 0
    run_log.flags.ignore_mandatory = True
    run_log.insert(ignore_permissions=True)

    summary = {"calc_a_created": 0, "calc_a_skipped": 0,
               "calc_b_created": 0, "calc_b_skipped": 0, "errors": 0}

    for row in sp_doc.table_mibv:
        item_summary = _process_item_v2(
            row, sp_doc, settings, run_log,
            pending_statuses, confirmed_states,
            month_start, next_month_start, company,
            min_mfg_map, default_so_warehouse,
        )
        for k in summary:
            summary[k] += item_summary.get(k, 0)

        # Persist incremental state per item so a later worker timeout
        # leaves a partial-but-correct log.
        run_log.calc_a_created = summary["calc_a_created"]
        run_log.calc_a_skipped = summary["calc_a_skipped"]
        run_log.calc_b_created = summary["calc_b_created"]
        run_log.calc_b_skipped = summary["calc_b_skipped"]
        run_log.errors = summary["errors"]
        run_log.save(ignore_permissions=True)
        frappe.db.commit()

    run_log.run_completed = now_datetime()
    run_log.save(ignore_permissions=True)
    frappe.db.commit()

    # Email the run summary to opted-in TOC notification users (notify_on_wo_create=1).
    # Wrapped in its own try/except inside _send_run_log_email so a mail failure
    # cannot mask a successful run.
    _send_run_log_email(run_log, sp_doc, triggered_by, settings)

    return summary, run_log.name


@frappe.whitelist()
def run_projection_automation_for_all_warehouses(triggered_by="manual_button"):
    """
    PUBLIC API — entry point for both the TOC Settings 'Run Now' button and
    the 02:00 AM daily cron. Iterates every submitted Sales Projection of the
    current month and runs Calc A + Calc B per item.

    Returns aggregated summary dict {calc_a_created, calc_a_skipped, ...}.
    """
    frappe.only_for(["Manufacturing Manager", "TOC Manager", "System Manager"])

    settings = frappe.get_cached_doc("TOC Settings")
    if not settings.enable_projection_automation:
        frappe.throw(_(
            "Projection Automation is disabled. "
            "Enable it in TOC Settings → Sales Projection Automation."
        ))

    now_dt = now_datetime()
    month_name = MONTH_NAMES[now_dt.month - 1]
    year = now_dt.year

    sp_names = frappe.get_all(
        "Sales Projection",
        filters={
            "projection_month": month_name,
            "projection_year": year,
            "docstatus": 1,
        },
        pluck="name",
    )

    aggregated = {"calc_a_created": 0, "calc_a_skipped": 0,
                  "calc_b_created": 0, "calc_b_skipped": 0, "errors": 0,
                  "run_logs": []}

    if not sp_names:
        aggregated["message"] = (
            f"No submitted Sales Projection found for {month_name} {year}."
        )
        return aggregated

    for sp_name in sp_names:
        try:
            sp_doc = frappe.get_doc("Sales Projection", sp_name)
            summary, log_name = _run_for_projection(sp_doc, triggered_by, settings)
            for k in ("calc_a_created", "calc_a_skipped",
                      "calc_b_created", "calc_b_skipped", "errors"):
                aggregated[k] += summary.get(k, 0)
            aggregated["run_logs"].append(log_name)
            # Stamp last_auto_run on the projection
            frappe.db.set_value(
                "Sales Projection", sp_name,
                "last_auto_run", now_datetime(),
                update_modified=False,
            )
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC PP Automation v2: projection {sp_name} failed",
            )
            aggregated["errors"] += 1

    frappe.db.commit()
    return aggregated


# =============================================================================
# SPE-001 · 2026-05-13 — Sales-Order Shortage Engine
# =============================================================================
#
# CONTEXT:
#   A second automation path, independent of any Sales Projection.
#   The engine scans EVERY pending Sales Order (PATH A workflow_state +
#   PATH B status, same eligibility as Calc B), aggregates pending qty per
#   (item_code, warehouse) in STOCK UOM, and creates a Production Plan
#   when (pending_so − bin_actual − open_wo) > 0.
#
#   `pending_qty_stock_uom` is the canonical pre-converted figure:
#     soi.stock_qty - soi.delivered_qty * soi.conversion_factor
#   so multiple SOs on the same item with different transaction UOMs are
#   summed correctly. No second conversion happens anywhere.
#
#   The PP qty for each shortage is:
#     production_qty = max(shortage, MINMFG_in_stock_uom)
#   where MINMFG is the per-warehouse floor from
#   `Item.custom_minimum_manufacture` resolved via `_build_min_mfg_map`.
#
# DEDUP:
#   `_so_shortage_pp_exists(item, warehouse)` blocks a second SO-shortage
#   PP for the same (item × warehouse) while the prior one is still active
#   (docstatus != 2 AND status NOT IN Completed/Closed). Cancelled and
#   completed PPs are NOT considered active, so the engine can re-create
#   if needed on the next run.
#
# RUN LOG:
#   One `TOC Production Plan Run Log` per call. `sales_projection` is left
#   blank (this path is not projection-driven). `triggered_by` carries one
#   of `so_shortage_manual` / `so_shortage_cron`. Each (item, warehouse)
#   pair produces ONE TOC Production Plan Run Item row.
#
# DANGER:
#   - The SQL MUST sum `soi.stock_qty - delivered_qty * conversion_factor`.
#     Substituting `soi.qty - delivered_qty` mixes transaction UOMs across
#     SOs and silently distorts the shortage by the conversion factor.
#   - `SO Item.warehouse` is per-line. When blank, fall back to
#     `so.set_warehouse` and then to TOC Settings `default_so_warehouse`.
#     SOs that have none of the three are excluded.
#   - The dedup MUST exclude completed and cancelled PPs, otherwise the
#     engine can never refill an item even after the previous PP is done.
#
# RESTRICT:
#   - Do NOT call this from `daily_production_plan_automation` unless a
#     separate cron entry has been added — the projection-driven daily
#     runner is currently 02:00 AM. The SO-shortage runner is opt-in via
#     the TOC Settings button (manual) or a hooks.py scheduler entry.
#   - Do NOT collapse this entry with `run_projection_automation_for_all_warehouses`.
#     The two paths share helpers but they are distinct features with
#     distinct dedup keys and run-log markers.
# =============================================================================

def _discover_pending_so_pairs(pending_statuses, confirmed_states, default_so_warehouse):
    """
    Return a list of dicts:
       {item_code, item_name, warehouse, pending_qty}   (qty in stock UOM)
    aggregating every pending Sales Order line in the user-configured
    `pending_statuses` / `confirmed_states` eligibility set.

    Pending qty per SO line:
       soi.stock_qty - soi.delivered_qty * soi.conversion_factor
    summed across all eligible lines, grouped by (item, warehouse).

    Warehouse resolution per line:
       COALESCE(NULLIF(soi.warehouse, ''), NULLIF(so.set_warehouse, ''),
                <default_so_warehouse if set>)
    Lines that resolve to NULL warehouse are dropped (cannot be planned).
    """
    so_conditions = []
    params = []
    if confirmed_states and _so_has_workflow_column():
        states_ph = ", ".join(["%s"] * len(confirmed_states))
        so_conditions.append(f"(so.docstatus = 0 AND so.workflow_state IN ({states_ph}))")
        params.extend(confirmed_states)
    if pending_statuses:
        ph = ", ".join(["%s"] * len(pending_statuses))
        so_conditions.append(f"(so.docstatus = 1 AND so.status IN ({ph}))")
        params.extend(pending_statuses)
    if not so_conditions:
        return []

    # Per-line warehouse with the same precedence as the projection engine.
    if default_so_warehouse:
        wh_expr = (
            "COALESCE("
            "  NULLIF(soi.warehouse, ''),"
            "  NULLIF(so.set_warehouse, ''),"
            "  %s"
            ")"
        )
        params.append(default_so_warehouse)
    else:
        wh_expr = "COALESCE(NULLIF(soi.warehouse, ''), NULLIF(so.set_warehouse, ''))"

    rows = frappe.db.sql(
        f"""
        SELECT
            soi.item_code,
            soi.item_name,
            {wh_expr} AS warehouse,
            COALESCE(SUM(
                soi.stock_qty
                - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
            ), 0) AS pending_qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE ({" OR ".join(so_conditions)})
          AND soi.stock_qty
              > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
        GROUP BY soi.item_code, {wh_expr}
        HAVING pending_qty > 0
        ORDER BY pending_qty DESC
        """,
        params,
        as_dict=True,
    )
    return [
        {
            "item_code": r["item_code"],
            "item_name": r.get("item_name") or r["item_code"],
            "warehouse": r["warehouse"],
            "pending_qty": flt(r["pending_qty"]),
        }
        for r in rows
        if r.get("warehouse")
    ]


def _so_shortage_pp_exists(item_code, warehouse):
    """
    Returns the active SO-shortage PP name for (item, warehouse) if one
    exists, else None. "Active" = docstatus != 2 AND status not terminal.
    Matched by the marker `[Calc SO]` in `custom_creation_reason`.

    2026-05-14: terminal list pulled from chaizup_toc.toc_engine.auto_remarks
    so every dedup query in this app uses the same exclusion set.
    """
    from chaizup_toc.toc_engine.auto_remarks import PP_TERMINAL_STATUSES
    ph = ", ".join(["%s"] * len(PP_TERMINAL_STATUSES))
    rows = frappe.db.sql(
        f"""
        SELECT pp.name
        FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
        WHERE pp.docstatus != 2
          AND COALESCE(pp.status, '') NOT IN ({ph})
          AND ppi.item_code = %s
          AND COALESCE(pp.for_warehouse, '') = %s
          AND pp.custom_creation_reason LIKE %s
        LIMIT 1
        """,
        PP_TERMINAL_STATUSES + [item_code, warehouse, "%[Calc SO]%"],
    )
    return rows[0][0] if rows else None


@frappe.whitelist()
def run_so_shortage_automation(triggered_by="so_shortage_manual"):
    """PUBLIC API — Sales-Order shortage automation.

    Scans every pending Sales Order (eligibility = TOC Settings pending
    statuses + workflow states), computes shortage per (item, warehouse)
    in STOCK UOM, and creates a Production Plan for each positive
    shortage. PP qty = max(shortage, MINMFG per-warehouse). One TOC
    Production Plan Run Log per call captures every decision.

    Triggered by:
      - `so_shortage_manual` — button on TOC Settings.
      - `so_shortage_cron`   — optional scheduled entry (not registered by
                                default; opt-in).
    """
    frappe.only_for(["Manufacturing Manager", "TOC Manager", "System Manager"])

    settings = frappe.get_cached_doc("TOC Settings")
    pending_statuses = _parse_statuses(settings.projection_pending_so_statuses)
    confirmed_states = _parse_confirmed_states(settings.projection_confirmed_so_workflow_states)
    default_so_warehouse = settings.get("default_so_warehouse") or None
    company = _get_company()

    pairs = _discover_pending_so_pairs(pending_statuses, confirmed_states, default_so_warehouse)
    if not pairs:
        return {
            "ok": True, "run_log": None,
            "created": 0, "skipped": 0, "errors": 0, "pairs": 0,
            "message": "No pending Sales Orders match the configured eligibility.",
        }

    item_codes = sorted({p["item_code"] for p in pairs})
    # SPA-001 (2026-05-14): use the richer index so we can branch on
    # action_type per (item × warehouse). Legacy map kept available via
    # `idx[k].min_qty_stock_uom`.
    idx = _build_min_mfg_index(item_codes)

    run_log = frappe.new_doc("TOC Production Plan Run Log")
    run_log.run_started = now_datetime()
    run_log.triggered_by = triggered_by
    run_log.company = company
    run_log.sales_projection = ""
    run_log.warehouse = default_so_warehouse or ""
    run_log.pending_so_statuses_used = "\n".join(pending_statuses) if pending_statuses else ""
    run_log.default_so_warehouse_used = default_so_warehouse or ""
    run_log.calc_a_created = 0
    run_log.calc_a_skipped = 0
    run_log.calc_b_created = 0
    run_log.calc_b_skipped = 0
    run_log.errors = 0
    run_log.flags.ignore_mandatory = True
    run_log.insert(ignore_permissions=True)

    created = 0
    skipped = 0
    errors  = 0

    for p in pairs:
        item_code  = p["item_code"]
        warehouse  = p["warehouse"]
        item_name  = p["item_name"]
        pending_so = flt(p["pending_qty"])      # already in stock UOM

        try:
            stock = flt(_warehouse_stock(item_code, warehouse))
            wo    = flt(_pending_wo_qty(item_code, warehouse))
            shortage = round(pending_so - stock - wo, 4)
            row_idx = idx.get((item_code, warehouse))
            minmfg = flt(row_idx.min_qty_stock_uom) if row_idx else 0.0
            # SPA-001: Default action_type is Manufacture when the item has
            # no min-mfg row configured for this warehouse (matches v1
            # behaviour). Configured rows drive Manufacture vs Purchase.
            action_type = (row_idx.action_type if row_idx else "Manufacture")

            base_payload = {
                "item_code": item_code,
                "item_name": item_name,
                "warehouse": warehouse,
                "calc_used": "Calc SO",
                "currALso": pending_so,
                "itmwo":    wo,
                "itmwstk":  stock,
                "minmfg":   minmfg,
                "qty_of_shortage": shortage,
            }

            if shortage <= 0:
                skipped += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Skipped - No Shortage",
                    "production_qty": 0,
                    "reason": (
                        f"[Calc SO][{action_type}] No shortage at {warehouse}: "
                        f"pending SO {pending_so:.3f} − stock {stock:.3f} − open WO {wo:.3f} "
                        f"= {shortage:.3f} (stock UOM)."
                    ),
                })
                continue

            # SPA-001: action_type decides the artifact we create.
            qty = max(shortage, minmfg)

            if action_type == "Purchase":
                existing = _shortage_cover_artifact_exists(item_code, warehouse, "Purchase")
                if existing:
                    skipped += 1
                    _append_run_item(run_log, {
                        **base_payload,
                        "status": "Skipped - MR Exists",
                        "production_qty": 0,
                        "production_plan": existing,  # field reused for cross-link
                        "reason": (
                            f"[Calc SO][Purchase] Active Material Request {existing} "
                            f"already covers {item_code} at {warehouse}."
                        ),
                    })
                    continue
                reason = (
                    f"[Calc SO][Purchase] Sales Order Shortage at {warehouse}\n"
                    f"Cause: pending sales orders exceed stock + open work orders.\n"
                    f"  Pending SO (stock UOM): {pending_so:.3f}\n"
                    f"  Current Stock         : {stock:.3f}\n"
                    f"  Open WO Qty           : {wo:.3f}\n"
                    f"  Shortage              : {shortage:.3f}\n"
                    f"  MINMFG floor          : {minmfg:.3f}\n"
                    f"  Order Qty (stock UOM) : {qty:.3f}"
                )
                mr_name = _create_purchase_mr_for_shortage(
                    item_code, item_name, qty, warehouse, reason, company,
                    lead_time_days=(row_idx.lead_time_days if row_idx else 0),
                )
                frappe.db.commit()
                created += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Created (MR)",
                    "production_qty": qty,
                    "production_plan": mr_name,
                    "reason": reason,
                })
                continue

            # action_type == "Manufacture"
            bom_no = frappe.db.get_value(
                "BOM",
                {"item": item_code, "is_default": 1, "is_active": 1, "docstatus": 1},
                "name",
            )
            if not bom_no:
                skipped += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Skipped - No BOM",
                    "production_qty": 0,
                    "reason": (
                        f"[Calc SO][Manufacture] {item_code} has no active default submitted BOM; "
                        f"cannot create a Production Plan. Switch Action Type to Purchase if this "
                        f"item is bought, not made."
                    ),
                })
                continue

            existing = _so_shortage_pp_exists(item_code, warehouse)
            if existing:
                skipped += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Skipped - PP Exists",
                    "production_qty": 0,
                    "production_plan": existing,
                    "reason": (
                        f"[Calc SO][Manufacture] Active Production Plan {existing} "
                        f"already covers {item_code} at {warehouse}."
                    ),
                })
                continue

            reason = (
                f"[Calc SO][Manufacture] Sales Order Shortage at {warehouse}\n"
                f"Cause: pending sales orders exceed stock + open work orders.\n"
                f"  Pending SO (stock UOM): {pending_so:.3f}\n"
                f"  Current Stock         : {stock:.3f}\n"
                f"  Open WO Qty           : {wo:.3f}\n"
                f"  Shortage              : {shortage:.3f}\n"
                f"  MINMFG floor          : {minmfg:.3f}\n"
                f"  Production Qty        : {qty:.3f}"
            )

            pp_name = _create_production_plan(
                item_code, bom_no, qty, warehouse,
                reason, company, projection_ref="",
            )
            _submit_pp_and_create_work_orders(pp_name)
            frappe.db.commit()
            created += 1

            _append_run_item(run_log, {
                **base_payload,
                "status": "Created (PP)",
                "production_qty": qty,
                "production_plan": pp_name,
                "work_orders": _wo_names_for_pp(pp_name),
                "reason": reason,
            })

        except Exception:
            errors += 1
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC SO Shortage automation: {item_code} @ {warehouse}",
            )
            _append_run_item(run_log, {
                "item_code": item_code,
                "item_name": item_name,
                "warehouse": warehouse,
                "calc_used": "Calc SO",
                "status": "Error - See Log",
                "currALso": pending_so,
                "qty_of_shortage": 0,
                "production_qty": 0,
                "reason": (
                    "[Calc SO] Engine exception while processing this pair. "
                    "Open the Error Log for the full traceback."
                ),
            })

    # SPE-001 (2026-05-13): one closing save with final counters.
    # An earlier draft kept a per-iteration save inside the loop, but that
    # block sat AFTER the `try/except` and so was bypassed by every `continue`
    # in the skip branches. Result: when the last iteration was a skip, the
    # persisted skipped counter trailed the returned counter by 1. Removing
    # the per-iteration save fixes the desync. The "partial log on worker
    # timeout" property is preserved by `_append_run_item` itself + the
    # closing save below — every successful Create branch already
    # `frappe.db.commit()`s its PP insert, so individual PPs are durable
    # even if the run log later fails to save.
    run_log.calc_b_created = created
    run_log.calc_b_skipped = skipped
    run_log.errors = errors
    run_log.run_completed = now_datetime()
    run_log.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "ok":       True,
        "run_log":  run_log.name,
        "created":  created,
        "skipped":  skipped,
        "errors":   errors,
        "pairs":    len(pairs),
        "message":  (
            f"Sales Order Shortage Run complete: {created} artifact(s) created, "
            f"{skipped} skipped, {errors} errors across {len(pairs)} pair(s)."
        ),
    }


# =============================================================================
# SPA-001 · 2026-05-14 — Action-aware Shortage Cover helpers + Shortage Action engine
# =============================================================================
#
# CONTEXT (Shortage Cover):
#   `run_so_shortage_automation` was extended to branch on `action_type`:
#     - "Manufacture" → existing Production Plan path
#     - "Purchase"    → new `_create_purchase_mr_for_shortage` (MR of type
#                        Purchase, with stock_uom → purchase_uom conversion).
#
# CONTEXT (Shortage Action):
#   A separate auto-monitoring engine that iterates Item Minimum Manufacture
#   rows where `auto_on_shortage = 1` OR `auto_on_max_level = 1`. Two modes:
#
#     auto_on_shortage:
#       supply = stock + open_wo_output
#       demand = pending_so + wo_required_component_qty
#       shortage = demand − supply
#       trigger if shortage > 0 → create PP / MR for max(shortage, MOQ)
#
#     auto_on_max_level:
#       cover     = stock + open_wo_output + open_po − pending_so − wo_required_component_qty
#       cover_pct = cover / max_level * 100
#       trigger if cover_pct < max_level_threshold_pct
#       qty       = max(max_level − cover, MOQ)
#
# Both modes converge on the same artifact creator
# (`_perform_shortage_action`) so we never have two code paths writing
# Production Plans / Material Requests.
#
# Why a separate engine instead of folding into run_so_shortage_automation?
#   - Shortage Cover (Calc SO) runs on EVERY pending SO; Shortage Action
#     only runs on min-mfg rows where the user opted in via a checkbox.
#   - Shortage Action also considers WO component requirements and open
#     POs, which Calc SO ignores by design.
#   - Distinct run-log marker ([Calc Action]) keeps the audit trail clear.
#
# DANGER:
#   - WO component query MUST filter `source_warehouse = row.warehouse`.
#     Aggregating across all warehouses double-counts the same component
#     against unrelated warehouse rules.
#   - MR purchase-UOM conversion MUST round to the Item Purchase UOM
#     using `UOM Conversion Detail.conversion_factor` per item. Hardcoding
#     stock_uom on the MR line silently breaks supplier ordering — same
#     bug `mr_generator._create_mr` originally had (see its comment).
#
# RESTRICT:
#   - Do NOT call `_create_purchase_mr_for_shortage` outside of the
#     SPA-001 / SPE-001 entry points. The TOC zone-based buffer engine
#     uses `mr_generator._create_mr` which encodes zone metadata; mixing
#     the two writes confuses the buffer-status reports.
#   - Do NOT remove the "Skipped - MR Exists" branch. Without dedup the
#     engine creates a new MR every run.
# =============================================================================

def _create_purchase_mr_for_shortage(item_code, item_name, qty_in_stock_uom,
                                     warehouse, reason, company,
                                     lead_time_days=0):
    """Create a Material Request (type=Purchase) for the given shortage.

    The qty arriving here is ALREADY in the item's stock UOM. We resolve
    `Item.purchase_uom` and its conversion factor and write the MR line
    in the purchase UOM (so suppliers see e.g. "5 KG" not "5000 Gram").

    Args:
        item_code:  Item being short.
        item_name:  Display name (used in MR line).
        qty_in_stock_uom: Order qty in stock UOM (the engine has already
                          applied `max(shortage, MINMFG)`).
        warehouse:  Target warehouse for receipt.
        reason:     Multi-line text written to the MR description so the
                    PP/MR forms reveal the source calculation.
        company:    Company name.
        lead_time_days: Drives schedule_date (today + lead).

    Returns:
        str — name of the inserted MR (docstatus = 0).

    Safety:
        Items with no purchase_uom configured fall back to stock_uom +
        conversion_factor=1.0 (same fallback as `mr_generator._create_mr`).
    """
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""
    purchase_uom = frappe.db.get_value("Item", item_code, "purchase_uom") or stock_uom
    conversion_factor = 1.0
    if purchase_uom and purchase_uom != stock_uom:
        cf = frappe.db.get_value(
            "UOM Conversion Detail",
            {"parent": item_code, "uom": purchase_uom},
            "conversion_factor",
        )
        conversion_factor = flt(cf) if cf else 1.0
    if conversion_factor > 0 and conversion_factor != 1.0:
        mr_qty = flt(qty_in_stock_uom) / conversion_factor
    else:
        mr_qty = flt(qty_in_stock_uom)
        purchase_uom = stock_uom

    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    mr.transaction_date = today()
    mr.company = company or frappe.db.get_value("Warehouse", warehouse, "company")
    mr.schedule_date = add_days(today(), max(1, int(lead_time_days or 3)))
    # Match `mr_generator._create_mr` metadata so the existing list view
    # / TOC reports continue to recognise this MR as system-generated.
    try:
        mr.custom_toc_recorded_by = "By System"
    except Exception:
        pass

    # 2026-05-14: enrich the caller's reason text with the canonical pending-
    # check block + auto-creation header so the resulting MR matches the
    # format of buffer-triggered MRs created by mr_generator._create_mr.
    enriched_description = reason or ""
    if "[Auto-Generated by " not in enriched_description:
        try:
            from chaizup_toc.toc_engine.auto_remarks import format_auto_creation_remark
            # Detect the source engine from the existing [Calc X] marker.
            src = "TOC Calc SO/Action"
            if "[Calc SO]" in enriched_description:
                src = "TOC Calc SO Shortage"
            elif "[Calc Action]" in enriched_description:
                src = "TOC Calc Action"
            enriched_description = format_auto_creation_remark(
                doc_type="Material Request",
                item_code=item_code,
                warehouse=warehouse,
                qty=f"{flt(qty_in_stock_uom):.3f} {stock_uom} ({mr_qty:.3f} {purchase_uom})",
                reason_summary=enriched_description.splitlines()[0] if enriched_description else "Shortage cover",
                source_engine=src,
            ) + "\n\n── Formula breakdown ──\n" + (reason or "")
        except Exception:
            pass

    mr.append("items", {
        "item_code":        item_code,
        "item_name":        item_name,
        "qty":              mr_qty,
        "uom":              purchase_uom,
        "stock_uom":        stock_uom,
        "conversion_factor": conversion_factor,
        "warehouse":        warehouse,
        "schedule_date":    mr.schedule_date,
        "description":      enriched_description,
    })
    mr.flags.ignore_mandatory = True
    mr.flags.ignore_permissions = True
    mr.insert()
    return mr.name


def _shortage_cover_artifact_exists(item_code, warehouse, action_type):
    """Return the name of an active SO-shortage artifact for this pair, or None.

    Mirrors `_so_shortage_pp_exists` for Production but for Material
    Requests. Active = docstatus != 2 AND status NOT IN
    Completed/Cancelled/Stopped/Issued. Matched by the `[Calc SO]`
    marker present in the MR line description.

    NOTE: for action_type == "Manufacture" the caller should still use
    `_so_shortage_pp_exists` directly. This helper covers the Purchase
    branch only.
    """
    if action_type != "Purchase":
        return _so_shortage_pp_exists(item_code, warehouse)
    from chaizup_toc.toc_engine.auto_remarks import MR_TERMINAL_STATUSES
    ph = ", ".join(["%s"] * len(MR_TERMINAL_STATUSES))
    rows = frappe.db.sql(
        f"""
        SELECT mr.name
        FROM `tabMaterial Request` mr
        JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
        WHERE mr.docstatus != 2
          AND COALESCE(mr.status, '') NOT IN ({ph})
          AND mr.material_request_type = 'Purchase'
          AND mri.item_code = %s
          AND mri.warehouse = %s
          AND mri.description LIKE %s
        LIMIT 1
        """,
        MR_TERMINAL_STATUSES + [item_code, warehouse, "%[Calc SO]%"],
    )
    return rows[0][0] if rows else None


def _open_po_qty(item_code, warehouse):
    """Sum (qty - received_qty) on open Purchase Orders for item × warehouse.

    Returns qty in stock UOM (multiplied by `poi.conversion_factor` so two
    POs with different purchase UOMs are summed correctly).

    BTP-001 (2026-05-14): Pending PO statuses are now read from
    `TOC Settings.pending_po_statuses` (+ optional Draft workflow states
    from `pending_po_workflow_states`). Defaults match the legacy
    hardcoded clause so existing sites with the field blank see no
    change. See `_po_eligibility_sql`.
    """
    po_statuses, po_wf = _toc_po_statuses_and_wf()
    eligibility = _po_eligibility_sql(po_statuses, po_wf, alias="po")
    params = list(po_statuses)
    if po_wf and _po_has_workflow_column():
        params += list(po_wf)
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(GREATEST(
            (poi.qty - IFNULL(poi.received_qty, 0)) * IFNULL(poi.conversion_factor, 1),
            0
        )), 0) AS qty
        FROM `tabPurchase Order Item` poi
        JOIN `tabPurchase Order` po ON po.name = poi.parent
        WHERE poi.item_code = %s
          AND poi.warehouse = %s
          AND ({eligibility})
        """,
        [item_code, warehouse] + params,
    )
    return flt(result[0][0] if result else 0)


def _wo_required_component_qty(item_code, warehouse):
    """Sum required-but-not-yet-transferred qty on open Work Orders where
    `item_code` is a component picked from `warehouse`.

    `Work Order Item.source_warehouse` is the warehouse the component is
    consumed from. We scope by that so a component required at WH-A does
    not depress the cover signal at WH-B.

    Returns qty in stock UOM (WO Item required_qty is already in stock
    UOM of the component per ERPNext).

    BTP-001 (2026-05-14): Pending WO statuses are now read from TOC
    Settings via `_toc_wo_statuses_and_wf` so the cover/shortage signal
    matches whatever the user configures globally.
    """
    wo_statuses, wo_wf = _toc_wo_statuses_and_wf()
    eligibility = _wo_eligibility_sql(wo_statuses, wo_wf, alias="wo")
    params = list(wo_statuses)
    if wo_wf and _wo_has_workflow_column():
        params += list(wo_wf)
    result = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM(GREATEST(
            woi.required_qty - IFNULL(woi.transferred_qty, 0), 0
        )), 0) AS qty
        FROM `tabWork Order Item` woi
        JOIN `tabWork Order` wo ON wo.name = woi.parent
        WHERE woi.item_code = %s
          AND woi.source_warehouse = %s
          AND ({eligibility})
        """,
        [item_code, warehouse] + params,
    )
    return flt(result[0][0] if result else 0)


def _shortage_action_artifact_exists(item_code, warehouse, action_type):
    """Same as `_shortage_cover_artifact_exists` but matches the
    `[Calc Action]` marker so Shortage Action and Shortage Cover dedup
    independently of each other.
    """
    from chaizup_toc.toc_engine.auto_remarks import (
        MR_TERMINAL_STATUSES, PP_TERMINAL_STATUSES,
    )
    if action_type == "Purchase":
        ph = ", ".join(["%s"] * len(MR_TERMINAL_STATUSES))
        rows = frappe.db.sql(
            f"""
            SELECT mr.name
            FROM `tabMaterial Request` mr
            JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
            WHERE mr.docstatus != 2
              AND COALESCE(mr.status, '') NOT IN ({ph})
              AND mr.material_request_type = 'Purchase'
              AND mri.item_code = %s
              AND mri.warehouse = %s
              AND mri.description LIKE %s
            LIMIT 1
            """,
            MR_TERMINAL_STATUSES + [item_code, warehouse, "%[Calc Action]%"],
        )
    else:
        ph = ", ".join(["%s"] * len(PP_TERMINAL_STATUSES))
        rows = frappe.db.sql(
            f"""
            SELECT pp.name
            FROM `tabProduction Plan` pp
            JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
            WHERE pp.docstatus != 2
              AND COALESCE(pp.status, '') NOT IN ({ph})
              AND ppi.item_code = %s
              AND COALESCE(pp.for_warehouse, '') = %s
              AND pp.custom_creation_reason LIKE %s
            LIMIT 1
            """,
            PP_TERMINAL_STATUSES + [item_code, warehouse, "%[Calc Action]%"],
        )
    return rows[0][0] if rows else None


@frappe.whitelist()
def run_shortage_action_automation(triggered_by="shortage_action_manual"):
    """SPA-001 (2026-05-14) — Shortage Action automation.

    Iterates every `Item Minimum Manufacture` row whose `auto_on_shortage`
    or `auto_on_max_level` flag is set. For each row evaluates the mode(s),
    creates a Production Plan / Material Request (per `action_type`) and
    writes one TOC Production Plan Run Item.

    Returns:
        dict {ok, run_log, created, skipped, errors, evaluated, message}
    """
    frappe.only_for(["Manufacturing Manager", "TOC Manager", "System Manager"])

    settings = frappe.get_cached_doc("TOC Settings")
    pending_statuses = _parse_statuses(settings.projection_pending_so_statuses)
    confirmed_states = _parse_confirmed_states(settings.projection_confirmed_so_workflow_states)
    default_so_warehouse = settings.get("default_so_warehouse") or None
    company = _get_company()

    # Pull every row that opted in to at least one mode.
    rows = frappe.db.sql(
        """
        SELECT name, parent AS item_code, warehouse,
               action_type,
               auto_on_shortage,
               auto_on_max_level,
               max_level_threshold_pct,
               max_level,
               lead_time_days,
               safety_factor,
               min_manufacturing_qty,
               uom,
               adu
        FROM `tabItem Minimum Manufacture`
        WHERE warehouse IS NOT NULL AND warehouse != ''
          AND (COALESCE(auto_on_shortage, 0) = 1
               OR COALESCE(auto_on_max_level, 0) = 1)
        """,
        as_dict=True,
    )

    if not rows:
        return {
            "ok": True, "run_log": None,
            "created": 0, "skipped": 0, "errors": 0, "evaluated": 0,
            "message": "No Item Minimum Manufacture rows have Auto on Shortage or Auto on Max Level enabled.",
        }

    # Item names for nicer logs.
    item_names = {
        r["name"]: r["item_name"]
        for r in frappe.db.get_all(
            "Item",
            filters={"name": ["in", list({r.item_code for r in rows})]},
            fields=["name", "item_name"],
        )
    }
    # MOQ index for the same items so we re-use the same per-row stock-UOM conversion.
    idx = _build_min_mfg_index(list({r.item_code for r in rows}))

    run_log = frappe.new_doc("TOC Production Plan Run Log")
    run_log.run_started = now_datetime()
    run_log.triggered_by = triggered_by
    run_log.company = company
    run_log.sales_projection = ""
    run_log.warehouse = default_so_warehouse or ""
    run_log.pending_so_statuses_used = "\n".join(pending_statuses) if pending_statuses else ""
    run_log.default_so_warehouse_used = default_so_warehouse or ""
    run_log.calc_a_created = 0
    run_log.calc_a_skipped = 0
    run_log.calc_b_created = 0
    run_log.calc_b_skipped = 0
    run_log.errors = 0
    run_log.flags.ignore_mandatory = True
    run_log.insert(ignore_permissions=True)

    created   = 0
    skipped   = 0
    errors    = 0

    for row in rows:
        item_code = row.item_code
        warehouse = row.warehouse
        item_name = item_names.get(item_code) or item_code
        action_type = (row.action_type or "Manufacture")
        row_idx     = idx.get((item_code, warehouse))
        minmfg      = flt(row_idx.min_qty_stock_uom) if row_idx else 0.0
        threshold   = flt(row.max_level_threshold_pct or 0)
        max_level   = flt(row.max_level or 0)

        try:
            # Pending SO qty in stock UOM at this warehouse (Calc B pattern).
            pending_so_rows = frappe.db.sql(
                f"""
                SELECT COALESCE(SUM(
                    soi.stock_qty - IFNULL(soi.delivered_qty, 0)
                                  * IFNULL(soi.conversion_factor, 1)
                ), 0) AS qty
                FROM `tabSales Order Item` soi
                JOIN `tabSales Order` so ON so.name = soi.parent
                WHERE soi.item_code = %s
                  AND COALESCE(NULLIF(soi.warehouse, ''),
                               NULLIF(so.set_warehouse, ''),
                               %s) = %s
                  AND ({_pending_so_eligibility_sql(pending_statuses, confirmed_states)})
                  AND soi.stock_qty
                      > IFNULL(soi.delivered_qty, 0)
                        * IFNULL(soi.conversion_factor, 1)
                """,
                [item_code, default_so_warehouse or warehouse, warehouse]
                + list(pending_statuses)
                + list(confirmed_states if confirmed_states and _so_has_workflow_column() else []),
            )
            pending_so = flt(pending_so_rows[0][0] if pending_so_rows else 0)
            stock      = flt(_warehouse_stock(item_code, warehouse))
            open_wo    = flt(_pending_wo_qty(item_code, warehouse))
            open_po    = flt(_open_po_qty(item_code, warehouse))
            wo_req     = flt(_wo_required_component_qty(item_code, warehouse))

            mode_used = None      # "Shortage" | "Max Level"
            qty       = 0.0
            reason    = ""
            cover_pct_val = None

            if int(row.auto_on_shortage or 0) == 1:
                supply = stock + open_wo
                demand = pending_so + wo_req
                short  = round(demand - supply, 4)
                if short > 0:
                    mode_used = "Shortage"
                    qty       = max(short, minmfg)
                    reason = (
                        f"[Calc Action][Shortage Mode] {action_type} action at {warehouse}\n"
                        f"  Demand = pending SO ({pending_so:.3f}) + WO component req ({wo_req:.3f}) "
                        f"= {demand:.3f}\n"
                        f"  Supply = stock ({stock:.3f}) + open WO output ({open_wo:.3f}) "
                        f"= {supply:.3f}\n"
                        f"  Shortage = Demand − Supply = {short:.3f} (stock UOM)\n"
                        f"  MOQ floor = {minmfg:.3f}\n"
                        f"  Order Qty = max(shortage, MOQ) = {qty:.3f}"
                    )

            if mode_used is None and int(row.auto_on_max_level or 0) == 1 and max_level > 0:
                cover = (stock + open_wo + open_po) - (pending_so + wo_req)
                cover_pct_val = round((cover / max_level) * 100.0, 2) if max_level else 0
                if cover_pct_val < threshold:
                    mode_used = "Max Level"
                    needed = max(max_level - cover, 0)
                    qty    = max(needed, minmfg)
                    reason = (
                        f"[Calc Action][Max Level Mode] {action_type} action at {warehouse}\n"
                        f"  Supply = stock ({stock:.3f}) + open WO ({open_wo:.3f}) "
                        f"+ open PO ({open_po:.3f}) = {(stock+open_wo+open_po):.3f}\n"
                        f"  Demand = pending SO ({pending_so:.3f}) + WO component req ({wo_req:.3f}) "
                        f"= {(pending_so+wo_req):.3f}\n"
                        f"  Cover  = Supply − Demand = {cover:.3f}\n"
                        f"  Cover % of max_level ({max_level:.3f}) = {cover_pct_val:.2f}% "
                        f"(threshold {threshold:.2f}%)\n"
                        f"  Refill Qty = max(max_level − cover, MOQ) = {qty:.3f}"
                    )

            base_payload = {
                "item_code": item_code,
                "item_name": item_name,
                "warehouse": warehouse,
                "calc_used": "Calc Action",
                "currALso": pending_so,
                "itmwo":    open_wo,
                "itmwstk":  stock,
                "minmfg":   minmfg,
                "qty_of_shortage": (qty if mode_used else 0),
            }

            if mode_used is None:
                skipped += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Skipped - No Shortage",
                    "production_qty": 0,
                    "reason": (
                        f"[Calc Action] {action_type} at {warehouse}: neither mode fired. "
                        f"Shortage-mode: demand {pending_so+wo_req:.3f} vs supply {stock+open_wo:.3f}. "
                        + (f"Max-level mode: cover_pct {cover_pct_val:.2f}% >= threshold {threshold:.2f}%."
                           if cover_pct_val is not None else "Max-level mode disabled or max_level=0.")
                    ),
                })
                # Stamp last_updated_on so the user can see the engine ran.
                if row_idx:
                    frappe.db.set_value(
                        "Item Minimum Manufacture", row.name,
                        "last_updated_on", now_datetime(),
                        update_modified=False,
                    )
                continue

            # Dedup against any active Shortage Action artifact for this pair.
            existing = _shortage_action_artifact_exists(item_code, warehouse, action_type)
            if existing:
                skipped += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": (
                        "Skipped - MR Exists" if action_type == "Purchase"
                        else "Skipped - PP Exists"
                    ),
                    "production_qty": 0,
                    "production_plan": existing,
                    "reason": (
                        f"[Calc Action] Active {('Material Request' if action_type=='Purchase' else 'Production Plan')} "
                        f"{existing} already covers {item_code} at {warehouse} (mode={mode_used})."
                    ),
                })
                continue

            if action_type == "Purchase":
                mr_name = _create_purchase_mr_for_shortage(
                    item_code, item_name, qty, warehouse,
                    reason.replace("[Calc Action]", "[Calc Action][Calc SO surrogate]"),
                    company,
                    lead_time_days=int(row.lead_time_days or 0),
                )
                frappe.db.commit()
                created += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Created (MR)",
                    "production_qty": qty,
                    "production_plan": mr_name,
                    "reason": reason,
                })
            else:
                bom_no = frappe.db.get_value(
                    "BOM",
                    {"item": item_code, "is_default": 1, "is_active": 1, "docstatus": 1},
                    "name",
                )
                if not bom_no:
                    skipped += 1
                    _append_run_item(run_log, {
                        **base_payload,
                        "status": "Skipped - No BOM",
                        "production_qty": 0,
                        "reason": (
                            f"[Calc Action][Manufacture] {item_code} has no active default submitted BOM. "
                            f"Switch Action Type to Purchase if this item is bought, not made."
                        ),
                    })
                    continue
                pp_name = _create_production_plan(
                    item_code, bom_no, qty, warehouse,
                    reason, company, projection_ref="",
                )
                _submit_pp_and_create_work_orders(pp_name)
                frappe.db.commit()
                created += 1
                _append_run_item(run_log, {
                    **base_payload,
                    "status": "Created (PP)",
                    "production_qty": qty,
                    "production_plan": pp_name,
                    "work_orders": _wo_names_for_pp(pp_name),
                    "reason": reason,
                })

            # Stamp last_updated_on on the source row so the user sees activity.
            frappe.db.set_value(
                "Item Minimum Manufacture", row.name,
                "last_updated_on", now_datetime(),
                update_modified=False,
            )

        except Exception:
            errors += 1
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC Shortage Action automation: {item_code} @ {warehouse}",
            )
            _append_run_item(run_log, {
                "item_code": item_code,
                "item_name": item_name,
                "warehouse": warehouse,
                "calc_used": "Calc Action",
                "status": "Error - See Log",
                "qty_of_shortage": 0,
                "production_qty": 0,
                "reason": (
                    "[Calc Action] Engine exception while processing this row. "
                    "Open the Error Log for the full traceback."
                ),
            })

    # Final counter save (mirror SPE-001 closing pattern).
    run_log.calc_b_created = created
    run_log.calc_b_skipped = skipped
    run_log.errors = errors
    run_log.run_completed = now_datetime()
    run_log.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "ok": True,
        "run_log": run_log.name,
        "created": created,
        "skipped": skipped,
        "errors":  errors,
        "evaluated": len(rows),
        "message": (
            f"Shortage Action Run complete: {created} artifact(s) created, "
            f"{skipped} skipped, {errors} errors across {len(rows)} row(s) evaluated."
        ),
    }


def _pending_so_eligibility_sql(pending_statuses, confirmed_states):
    """Build the boolean fragment used inside `WHERE (…)` to match an SO line
    against the user-configured PATH A workflow_state + PATH B status set.

    Returns the SQL text only; params are appended by the caller in this
    order: pending_statuses…, confirmed_states… (only when workflow_state
    column exists).
    """
    parts = []
    if pending_statuses:
        ph = ", ".join(["%s"] * len(pending_statuses))
        parts.append(f"(so.docstatus = 1 AND so.status IN ({ph}))")
    if confirmed_states and _so_has_workflow_column():
        ph = ", ".join(["%s"] * len(confirmed_states))
        parts.append(f"(so.docstatus = 0 AND so.workflow_state IN ({ph}))")
    if not parts:
        return "1=0"
    return " OR ".join(parts)


# =============================================================================
# 2026-05-08 · RUN LOG EMAIL NOTIFIER (v2)
# =============================================================================
#
# CONTEXT: After each Sales Projection processing pass, compose a single HTML
#   email summarising the per-item × per-calc decisions and send to every user
#   in TOC Settings → projection_notification_users where notify_on_wo_create=1.
#
# DESIGN:
#   - Identical recipient list to the v1 _send_pp_notification (consistent UX).
#   - Sent from the run-log writer (_run_for_projection) ONCE per projection.
#   - Email body lifts directly off the run log — no DB re-read.
#   - HTML template uses Frappe email-friendly inline styles (no class deps).
#   - Wrapped in try/except so a mail server failure cannot break the engine.
#   - frappe.sendmail(..., now=False) so the email queue absorbs failures.
#
# RESTRICT:
#   - Do NOT call now=True. If email password decryption fails, now=True
#     bubbles a 500 back to the engine even though PPs were created correctly.
#   - Do NOT include items table for runs with > 200 item-calc rows. Email
#     bodies above ~500 KB get rejected by some MTAs. Truncate gracefully.
#   - Recipient list MUST be filtered by notify_on_wo_create — we do NOT spam
#     "On Edit" subscribers with engine summaries.
# =============================================================================


def _format_qty(v):
    """Render a Float for HTML email — comma-thousands, 2 dp, blank if 0."""
    if v is None or v == 0:
        return "—"
    return f"{flt(v):,.2f}"


def _row_color_for_status(status):
    if not status:
        return "#f8fafc"
    if status == "Created":
        return "#ecfdf5"  # green-50
    if status == "Error":
        return "#fef2f2"  # red-50
    return "#f8fafc"


def _send_run_log_email(run_log_doc, sp_doc, triggered_by, settings):
    """Compose and queue one summary email per Sales Projection run."""
    try:
        recipients = [
            row.user for row in (settings.projection_notification_users or [])
            if row.user and cint(row.notify_on_wo_create)
        ]
        if not recipients:
            return

        # Re-read child rows from DB so we get persisted state (the in-memory
        # run_log_doc has them too but DB is canonical).
        rows = frappe.db.sql("""
            SELECT item_code, item_name, warehouse, calc_used, status,
                   spow, prvso, currso, currALso, itmwo, itmwstk, minmfg,
                   qty_of_shortage, production_qty, production_plan,
                   work_orders, reason
            FROM `tabTOC Production Plan Run Item`
            WHERE parent=%s
            ORDER BY item_code, calc_used
        """, (run_log_doc.name,), as_dict=True)

        site_url = frappe.utils.get_url()
        log_url = f"{site_url}/app/toc-production-plan-run-log/{run_log_doc.name}"
        sp_url  = f"{site_url}/app/sales-projection/{sp_doc.name}"

        summary_color = "#dc2626" if run_log_doc.errors else (
            "#16a34a" if (run_log_doc.calc_a_created + run_log_doc.calc_b_created) else "#64748b"
        )

        rows_html = []
        max_rows = 200
        for r in rows[:max_rows]:
            color = _row_color_for_status(r.status)
            pp_link = (
                f'<a href="{site_url}/app/production-plan/{r.production_plan}" '
                f'style="color:#1e40af;text-decoration:none">{r.production_plan}</a>'
                if r.production_plan else "—"
            )
            wo_html = ""
            if r.work_orders:
                wos = [w.strip() for w in r.work_orders.split(",") if w.strip()]
                wo_html = " · ".join(
                    f'<a href="{site_url}/app/work-order/{wo}" '
                    f'style="color:#1e40af;text-decoration:none">{wo}</a>'
                    for wo in wos
                )

            rows_html.append(f"""
              <tr style="background:{color};border-bottom:1px solid #e2e8f0">
                <td style="padding:8px 10px;font-size:13px;font-weight:600">{r.item_code}<br><span style="color:#64748b;font-weight:400;font-size:11px">{r.item_name or ''}</span></td>
                <td style="padding:8px 10px;font-size:12px;color:#475569">{r.calc_used or '-'}</td>
                <td style="padding:8px 10px;font-size:12px;font-weight:600">{r.status or '-'}</td>
                <td style="padding:8px 10px;font-size:11px;font-family:Menlo,monospace;color:#1e293b">{r.reason or ''}</td>
                <td style="padding:8px 10px;font-size:12px;text-align:right">{_format_qty(r.qty_of_shortage)}</td>
                <td style="padding:8px 10px;font-size:12px;text-align:right;font-weight:600">{_format_qty(r.production_qty)}</td>
                <td style="padding:8px 10px;font-size:12px">{pp_link}</td>
                <td style="padding:8px 10px;font-size:11px;color:#475569">{wo_html or '—'}</td>
              </tr>
            """)
        if len(rows) > max_rows:
            rows_html.append(f"""
              <tr><td colspan="8" style="padding:8px 10px;font-size:12px;color:#94a3b8;text-align:center;font-style:italic">
                … {len(rows) - max_rows} more rows truncated. View full log →
                <a href="{log_url}" style="color:#1e40af">{run_log_doc.name}</a>
              </td></tr>
            """)

        subject = (
            f"[TOC] Production Plan Automation — {sp_doc.name} · "
            f"{sp_doc.projection_month} {sp_doc.projection_year} · "
            f"{run_log_doc.calc_a_created + run_log_doc.calc_b_created} created"
        )

        message = f"""
        <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1f2937;max-width:880px">
          <div style="border-left:4px solid {summary_color};padding:14px 18px;background:#f8fafc;border-radius:0 6px 6px 0;margin-bottom:18px">
            <div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#64748b">
              TOC Production Plan Automation Run
            </div>
            <div style="font-size:18px;font-weight:700;color:#0f172a;margin-top:4px">
              <a href="{log_url}" style="color:#1e3a8a;text-decoration:none">{run_log_doc.name}</a>
            </div>
            <div style="font-size:13px;color:#475569;margin-top:6px">
              Sales Projection &nbsp;<a href="{sp_url}" style="color:#1e40af;text-decoration:none">{sp_doc.name}</a>
              &nbsp;·&nbsp; {sp_doc.projection_month} {sp_doc.projection_year}
              &nbsp;·&nbsp; Warehouse <strong>{sp_doc.source_warehouse or '—'}</strong>
              &nbsp;·&nbsp; Triggered by <strong>{triggered_by}</strong>
            </div>
          </div>

          <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
            <tr>
              <td style="padding:10px;background:#ecfdf5;border:1px solid #d1fae5;border-radius:6px;text-align:center;width:25%">
                <div style="font-size:11px;text-transform:uppercase;color:#047857;letter-spacing:.05em">Calc A Created</div>
                <div style="font-size:22px;font-weight:700;color:#065f46;margin-top:4px">{run_log_doc.calc_a_created}</div>
              </td>
              <td style="width:8px"></td>
              <td style="padding:10px;background:#fef9c3;border:1px solid #fef08a;border-radius:6px;text-align:center;width:25%">
                <div style="font-size:11px;text-transform:uppercase;color:#854d0e;letter-spacing:.05em">Calc A Skipped</div>
                <div style="font-size:22px;font-weight:700;color:#713f12;margin-top:4px">{run_log_doc.calc_a_skipped}</div>
              </td>
              <td style="width:8px"></td>
              <td style="padding:10px;background:#dbeafe;border:1px solid #bfdbfe;border-radius:6px;text-align:center;width:25%">
                <div style="font-size:11px;text-transform:uppercase;color:#1e40af;letter-spacing:.05em">Calc B Created</div>
                <div style="font-size:22px;font-weight:700;color:#1e3a8a;margin-top:4px">{run_log_doc.calc_b_created}</div>
              </td>
              <td style="width:8px"></td>
              <td style="padding:10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;text-align:center;width:25%">
                <div style="font-size:11px;text-transform:uppercase;color:#475569;letter-spacing:.05em">Calc B Skipped</div>
                <div style="font-size:22px;font-weight:700;color:#0f172a;margin-top:4px">{run_log_doc.calc_b_skipped}</div>
              </td>
            </tr>
          </table>

          {f'<div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 14px;border-radius:6px;font-size:13px;margin-bottom:14px"><strong>{run_log_doc.errors} error(s)</strong> during this run. See engine log on the run document.</div>' if run_log_doc.errors else ''}

          <div style="font-size:13px;color:#0f172a;margin-bottom:8px;font-weight:600">Per-item decisions</div>
          <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:6px">
            <table style="width:100%;border-collapse:collapse;background:white">
              <thead>
                <tr style="background:#0f172a;color:#f8fafc">
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Item</th>
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Calc</th>
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Status</th>
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Formula / Reason</th>
                  <th style="padding:9px 10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Shortage</th>
                  <th style="padding:9px 10px;text-align:right;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Prod Qty</th>
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Production Plan</th>
                  <th style="padding:9px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em">Work Orders</th>
                </tr>
              </thead>
              <tbody>
                {''.join(rows_html)}
              </tbody>
            </table>
          </div>

          <div style="font-size:12px;color:#64748b;margin-top:14px;padding-top:12px;border-top:1px dashed #cbd5e1">
            Snapshot at run time: pending SO statuses = <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px">{(run_log_doc.pending_so_statuses_used or '').replace(chr(10), ', ')}</code>
            &nbsp;·&nbsp; Default SO warehouse = <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px">{run_log_doc.default_so_warehouse_used or '—'}</code>
            &nbsp;·&nbsp; Engine v2 (Calc A + Calc B dual-run, intermediate commit guarantees no double-count).
            <br>
            <a href="{log_url}" style="color:#1e40af;text-decoration:none">→ Open the full run log on the site</a>
          </div>
        </div>
        """

        # NOTE: now=False → email is queued. Email Queue absorbs MTA failures so
        # they do not bubble back into the engine. See DANGER ZONE on
        # _send_pp_notification (v1) for the full rationale.
        frappe.sendmail(
            recipients=recipients,
            subject=subject,
            message=message,
            now=False,
            reference_doctype="TOC Production Plan Run Log",
            reference_name=run_log_doc.name,
        )
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            f"TOC PP Automation v2: email failed for {run_log_doc.name}",
        )
