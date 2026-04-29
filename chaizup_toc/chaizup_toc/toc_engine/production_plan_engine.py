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
from frappe.utils import flt, now_datetime, today

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
    """Create Production Plans for all items in the given submitted Sales Projection."""
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

    pending_statuses = _parse_statuses(settings.projection_pending_so_statuses)
    confirmed_states = _parse_confirmed_states(settings.projection_confirmed_so_workflow_states)
    month_start, next_month_start = _month_boundaries(sp_doc)
    company = _get_company()
    min_mfg_map = _build_min_mfg_map([row.item for row in sp_doc.table_mibv])

    results = []
    for row in sp_doc.table_mibv:
        result = _process_item(
            row, sp_doc, pending_statuses, confirmed_states,
            month_start, next_month_start,
            company, min_mfg_map,
        )
        results.append(result)

        # Write per-row PP status back to child table without re-triggering parent validate()
        update_fields = {"wo_status": result["status"]}
        if result.get("pp_name"):
            update_fields["wo_name"] = result["pp_name"]
        frappe.db.set_value(
            "Sales Projected Items", row.name,
            update_fields, update_modified=False,
        )

    frappe.db.set_value(
        "Sales Projection", projection_name,
        "last_auto_run", now_datetime(),
        update_modified=False,
    )
    frappe.db.commit()

    try:
        _send_pp_notification(sp_doc, results, triggered_by, settings)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "PP Automation — email notification failed")
    return results


# =============================================================================
# SCHEDULER ENTRY POINT — registered in hooks.py as 02:00 AM daily cron
# CONTEXT: Finds ALL submitted Sales Projections for the current month (one per
#   warehouse) and runs the automation on each. Silently exits if none found.
# DANGER ZONE:
#   - Uses MONTH_NAMES list (index = month - 1) to match the Select field DB value.
#     January → index 0, December → index 11. Do NOT reorder MONTH_NAMES.
# =============================================================================
def daily_production_plan_automation():
    """02:00 AM daily — create Production Plans for ALL current-month submitted projections."""
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        if not settings.enable_projection_automation:
            return

        now = now_datetime()
        month_name = MONTH_NAMES[now.month - 1]
        year = now.year

        sp_names = frappe.get_all(
            "Sales Projection",
            filters={
                "projection_month": month_name,
                "projection_year": year,
                "docstatus": 1,
            },
            pluck="name",
        )

        if not sp_names:
            frappe.logger("chaizup_toc").info(
                f"PP Automation: No submitted projections for {month_name} {year} — skipping."
            )
            return

        frappe.set_user("Administrator")
        for sp_name in sp_names:
            frappe.logger("chaizup_toc").info(f"PP Automation: Starting for {sp_name}")
            try:
                run_production_plan_automation(sp_name, triggered_by="system")
            except Exception:
                frappe.log_error(
                    frappe.get_traceback(),
                    f"TOC PP Automation FAILED for projection {sp_name}",
                )

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
    """Insert a Draft Production Plan for one item. Returns the new PP document name."""
    pp = frappe.new_doc("Production Plan")
    pp.company = company
    pp.planned_start_date = today()
    pp.custom_created_by = "System"
    pp.custom_creation_reason = reason
    pp.custom_projection_reference = projection_ref or ""

    # Warehouse scope — used by get_sub_assembly_items and get_items_for_material_requests
    pp.for_warehouse = warehouse
    pp.sub_assembly_warehouse = warehouse

    pp.append("po_items", {
        "item_code": item_code,
        "qty": flt(qty),
        "planned_qty": flt(qty),
        "bom_no": bom_no or "",
        "warehouse": warehouse,
        "planned_start_date": today(),
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
def _stamp_toc_fields_on_work_orders(pp_name, toc_data=None):
    """
    Stamp TOC buffer metadata on all Work Orders produced by pp_name.
    toc_data: buffer snapshot dict with keys zone/bp_pct/target_buffer/inventory_position/sr_pct.
    """
    wo_names = frappe.get_all(
        "Work Order",
        filters={"production_plan": pp_name},
        pluck="name",
    )
    if not wo_names:
        return

    fields = {"custom_toc_recorded_by": "By System"}
    if toc_data:
        fields.update({
            "custom_toc_zone":               toc_data.get("zone", ""),
            "custom_toc_bp_pct":             flt(toc_data.get("bp_pct", 0)),
            "custom_toc_target_buffer":      flt(toc_data.get("target_buffer", 0)),
            "custom_toc_inventory_position": flt(toc_data.get("inventory_position", 0)),
            "custom_toc_sr_pct":             flt(toc_data.get("sr_pct", 0)),
        })

    for wo_name in wo_names:
        frappe.db.set_value("Work Order", wo_name, fields, update_modified=False)


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
