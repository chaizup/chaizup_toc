# =============================================================================
# CONTEXT: Production Overview Page — full backend API.
#   Serves the 3-tab Production Overview page:
#   Tab 1 → item-level production metrics (plan vs actual, orders, dispatch,
#            sales projection, shortage check, possible qty, cost breakup).
#   Tab 2 → DeepSeek AI advisor (same key hierarchy as wo_kitting_api).
#   Tab 3 → Chart data (aggregated summaries for pie + bar charts).
#
# MEMORY: app_chaizup_toc.md § Production Overview Page
#
# INSTRUCTIONS:
#   - Items included: auto_manufacture=1 OR in open WO OR in open SO OR in
#     current Sales Projection OR appearing as component in active BOM.
#   - All quantities returned in stock_uom. UOM conversions returned alongside.
#   - Month/Year identify current period. Prev month = month-1 (handles Jan→Dec).
#   - Projection month uses string names ("April") matching Sales Projection.projection_month.
#   - "Sub Assembly" = appears as component in any active BOM (tabBOM Item).
#   - Cost breakup = BOM standard vs actual STE consumed vs 6-month historical avg.
#   - AI: shares DEEPSEEK_API_KEY + helper functions from wo_kitting_api.
#   - Session Redis key prefix: "por:chat:" (distinct from wkp: prefix).
#
# DANGER ZONE:
#   - Joining tabBOM Item can return many rows — always filter is_active=1 BOMs.
#   - Sales Projected Items uses field "item" (Link→Item), NOT "item_code".
#   - projection_month is a string ("April"), not an integer.
#   - Do NOT call _execute_chat_with_tools with "rows" key in system message.
#   - Warehouse list can be empty = all warehouses; never crash on None.
#   - tabWork Order column for "Qty To Manufacture" is `qty` (label only is the
#     long form). Using `qty_to_manufacture` in SQL → OperationalError 1054.
#     Convention here: `SELECT qty AS qty_to_manufacture` so Python attribute
#     access stays descriptive while SQL stays correct.
#     (Bug 2026-04-30: _get_planned_qty crashed page load.)
#   - Production Plan Item DOES expose `qty_to_manufacture` — ONLY Work Order
#     uses the short `qty` column. Do not assume one schema based on the other.
#
# RESTRICT:
#   - Do NOT bypass frappe.only_for() on any write endpoint.
#   - Do NOT hardcode month names — use _MONTH_NAMES list for indexing.
#   - Do NOT add frappe.db.commit() inside loops — single commit at end.
#   - Do NOT replace `qty AS qty_to_manufacture` aliasing with raw `qty` unless
#     you also rename every `wo.qty_to_manufacture` / `r.qty_to_manufacture`
#     reader and the output dict key in the same change.
# =============================================================================

import json
import frappe
from frappe.utils import cint, flt, getdate, today

# Month name → number and reverse
_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
]
_MONTH_MAP = {name: i + 1 for i, name in enumerate(_MONTH_NAMES)}

# Default pending statuses per DocType
_DEFAULT_WO_STATUSES   = ["Not Started", "In Process", "Material Transferred"]
_DEFAULT_SO_STATUSES   = ["To Deliver and Bill", "To Deliver", "To Bill", "Partially Delivered"]
_DEFAULT_PP_STATUSES   = ["Submitted", "In Process"]
_DEFAULT_PO_STATUSES   = ["To Receive and Bill", "To Receive"]

# ── Shared DeepSeek helpers (imported from existing integration) ──
from chaizup_toc.api.wo_kitting_api import (   # noqa: E402
    _get_api_key,
    _call_deepseek,
    _execute_chat_with_tools,
    DEEPSEEK_MODELS,
    _AI_SESSION_TTL,
    _AI_MAX_HISTORY,
)

_POR_AI_SESSION_PREFIX = "por:chat:"

# =============================================================================
# MAIN DATA API
# =============================================================================

@frappe.whitelist()
def get_production_overview(
    company=None,
    month=None,
    year=None,
    warehouses=None,
    wo_statuses=None,
    so_statuses=None,
    pp_statuses=None,
    stock_mode="physical",
    planning_mode=0,
):
    """
    Main data for Production Overview Tab 1.

    Returns:
        {
          "items": [ { ...per-item metrics... } ],
          "summary": { total_items, items_with_shortage, ... },
          "period": { month_name, month_num, year, prev_month_name, prev_month_num, prev_year }
        }
    """
    # ── Parse inputs ──
    if isinstance(warehouses, str):
        warehouses = frappe.parse_json(warehouses) or []
    if isinstance(wo_statuses, str):
        wo_statuses = frappe.parse_json(wo_statuses) or _DEFAULT_WO_STATUSES
    if isinstance(so_statuses, str):
        so_statuses = frappe.parse_json(so_statuses) or _DEFAULT_SO_STATUSES
    if isinstance(pp_statuses, str):
        pp_statuses = frappe.parse_json(pp_statuses) or _DEFAULT_PP_STATUSES

    wo_statuses  = wo_statuses  or _DEFAULT_WO_STATUSES
    so_statuses  = so_statuses  or _DEFAULT_SO_STATUSES
    pp_statuses  = pp_statuses  or _DEFAULT_PP_STATUSES
    warehouses   = warehouses   or []

    today_date   = getdate(today())
    curr_month   = cint(month)  if month  else today_date.month
    curr_year    = cint(year)   if year   else today_date.year

    if curr_month < 1 or curr_month > 12:
        curr_month = today_date.month

    prev_month = curr_month - 1 if curr_month > 1 else 12
    prev_year  = curr_year if curr_month > 1 else curr_year - 1

    curr_month_name = _MONTH_NAMES[curr_month - 1]
    prev_month_name = _MONTH_NAMES[prev_month - 1]

    period = {
        "month_name":      curr_month_name,
        "month_num":       curr_month,
        "year":            curr_year,
        "prev_month_name": prev_month_name,
        "prev_month_num":  prev_month,
        "prev_year":       prev_year,
    }

    company_filter = f"AND i.company = {frappe.db.escape(company)}" if company else ""
    wh_sql, wh_params = _build_wh_filter(warehouses)

    # ═══════════════════════════════════════════════════════
    # STEP 1 — Collect all qualifying item codes
    # ═══════════════════════════════════════════════════════
    qualifying_items = _get_qualifying_items(
        wo_statuses, so_statuses, curr_month, curr_year,
        prev_month, prev_year, company
    )
    if not qualifying_items:
        return {"items": [], "summary": _empty_summary(), "period": period}

    items_sql = _sql_in(qualifying_items)

    # ═══════════════════════════════════════════════════════
    # STEP 2 — Fetch item master details
    # ═══════════════════════════════════════════════════════
    item_rows = frappe.db.sql(f"""
        SELECT
            i.name           AS item_code,
            i.item_name,
            i.item_group,
            i.stock_uom,
            i.description,
            COALESCE(i.custom_toc_auto_manufacture, 0) AS auto_manufacture,
            COALESCE(i.custom_toc_auto_purchase, 0)    AS auto_purchase,
            COALESCE(i.is_purchase_item, 0)            AS is_purchase_item,
            i.standard_rate
        FROM `tabItem` i
        WHERE i.name IN {items_sql}
          AND i.disabled = 0
        ORDER BY i.item_name
    """, as_dict=True)

    if not item_rows:
        return {"items": [], "summary": _empty_summary(), "period": period}

    all_codes = [r.item_code for r in item_rows]
    codes_sql  = _sql_in(all_codes)

    # ═══════════════════════════════════════════════════════
    # STEP 3 — Bulk queries (all return dicts keyed by item_code)
    # ═══════════════════════════════════════════════════════
    uom_map          = _get_uom_conversions(all_codes)
    sub_asm_map      = _get_sub_assembly_info(all_codes, wo_statuses)
    wo_count_map     = _get_wo_counts(all_codes, wo_statuses)
    planned_qty_map  = _get_planned_qty(all_codes, wo_statuses)
    actual_qty_map   = _get_actual_qty(all_codes, curr_month, curr_year)
    prev_order_map   = _get_so_qty(all_codes, so_statuses, prev_month, prev_year)
    curr_order_map   = _get_so_qty(all_codes, so_statuses, curr_month, curr_year)
    dispatch_map     = _get_dispatch_qty(all_codes, curr_month, curr_year)
    prev_dispatch_map= _get_dispatch_qty(all_codes, prev_month, prev_year)
    projection_map   = _get_projection_qty(all_codes, curr_month_name, curr_year)
    total_sales_map  = _get_total_sales_qty(all_codes, curr_month, curr_year)
    stock_map        = _get_stock(all_codes, warehouses, stock_mode)
    bom_map          = _get_active_bom(all_codes)
    shortage_map     = _get_shortage_summary(all_codes, bom_map, stock_map)
    possible_map     = _get_possible_qty(all_codes, bom_map, stock_map)
    cost_summary_map = _get_cost_summary(all_codes, curr_month, curr_year, bom_map)
    pp_count_map     = _get_active_pp_count(all_codes, pp_statuses)
    has_open_so_map  = _get_has_open_so_map(all_codes, so_statuses)

    # ═══════════════════════════════════════════════════════
    # STEP 4 — Assemble output rows
    # ═══════════════════════════════════════════════════════
    items_out = []
    for r in item_rows:
        code = r.item_code
        uoms = uom_map.get(code, [])
        plan  = flt(planned_qty_map.get(code, 0))
        act   = flt(actual_qty_map.get(code, 0))
        prev_o = flt(prev_order_map.get(code, 0))
        curr_o = flt(curr_order_map.get(code, 0))
        disp  = flt(dispatch_map.get(code, 0))
        prev_disp = flt(prev_dispatch_map.get(code, 0))
        proj  = flt(projection_map.get(code, 0))
        total_s = flt(total_sales_map.get(code, 0))
        proj_vs = round(total_s / proj, 3) if proj > 0 else 0

        # Coverage = how much of the current-month sales is "covered" by the
        # combined demand inputs (Sales Projection + Previous Month carryover).
        # Anchored at total_curr_sales so that >=100% means inputs exceed
        # actual demand and <100% means demand will outstrip planning inputs.
        coverage_input = proj + prev_o
        coverage_pct   = round((coverage_input / total_s) * 100, 1) if total_s > 0 else 0

        item_type = _classify_item_type(r, sub_asm_map.get(code, {}).get("is_sub_assembly", False))

        items_out.append({
            "item_code":         code,
            "item_name":         r.item_name,
            "item_group":        r.item_group,
            "stock_uom":         r.stock_uom,
            "item_type":         item_type,
            "is_sub_assembly":   sub_asm_map.get(code, {}).get("is_sub_assembly", False),
            "sub_assembly_wos":  sub_asm_map.get(code, {}).get("wo_list", []),
            "open_wo_count":     wo_count_map.get(code, 0),
            "planned_qty":       plan,
            "actual_qty":        act,
            "prev_month_order":  prev_o,
            "curr_month_order":  curr_o,
            "curr_dispatch":     disp,
            "prev_dispatch":     prev_disp,
            "curr_projection":   proj,
            "total_curr_sales":  total_s,
            "projection_vs_sales": proj_vs,
            "coverage_pct":      coverage_pct,
            "coverage_input":    coverage_input,
            "stock":             flt(stock_map.get(code, 0)),
            "has_shortage":      shortage_map.get(code, {}).get("has_shortage", False),
            "shortage_components": shortage_map.get(code, {}).get("short_components", []),
            "possible_qty":      flt(possible_map.get(code, 0)),
            "uom_conversions":   uoms,
            "active_bom":        bom_map.get(code, ""),
            "cost_summary":      cost_summary_map.get(code, {}),
            "pp_count":          pp_count_map.get(code, 0),
            "has_open_so":       has_open_so_map.get(code, False),
        })

    # ═══════════════════════════════════════════════════════
    # STEP 5 — Summary stats
    # ═══════════════════════════════════════════════════════
    summary = {
        "total_items":         len(items_out),
        "items_with_shortage": sum(1 for x in items_out if x["has_shortage"]),
        "items_no_shortage":   sum(1 for x in items_out if not x["has_shortage"]),
        "total_planned_qty":   sum(x["planned_qty"] for x in items_out),
        "total_actual_qty":    sum(x["actual_qty"] for x in items_out),
        "total_curr_orders":   sum(x["curr_month_order"] for x in items_out),
        "total_dispatch":      sum(x["curr_dispatch"] for x in items_out),
        "total_projection":    sum(x["curr_projection"] for x in items_out),
    }

    return {"items": items_out, "summary": summary, "period": period}


# =============================================================================
# ITEM DETAIL MODAL
# =============================================================================

@frappe.whitelist()
def get_item_detail(item_code, company=None, month=None, year=None,
                    warehouses=None, stock_mode="physical", wo_statuses=None):
    """
    Full detail for the item click modal.
    Returns: active WOs with sub-assemblies, component shortage, material batch consumption.
    """
    if isinstance(warehouses, str):
        warehouses = frappe.parse_json(warehouses) or []
    if isinstance(wo_statuses, str):
        wo_statuses = frappe.parse_json(wo_statuses) or _DEFAULT_WO_STATUSES

    today_date = getdate(today())
    curr_month = cint(month) if month else today_date.month
    curr_year  = cint(year)  if year  else today_date.year

    # Active work orders for this item
    # NOTE: ERPNext Work Order column is `qty` (label "Qty To Manufacture").
    # We alias to `qty_to_manufacture` so downstream Python keeps the descriptive name.
    wo_rows = frappe.db.sql("""
        SELECT wo.name, wo.status, wo.qty AS qty_to_manufacture, wo.produced_qty,
               wo.bom_no, wo.production_item, wo.planned_start_date, wo.planned_end_date,
               wo.production_plan, wo.company
        FROM `tabWork Order` wo
        WHERE wo.production_item = %s
          AND wo.docstatus = 1
        ORDER BY wo.planned_start_date ASC
        LIMIT 20
    """, item_code, as_dict=True)

    stock_map = _get_stock([item_code], warehouses, stock_mode)

    wo_details = []
    for wo in wo_rows:
        # BOM components with shortage
        components = _walk_bom_shallow(wo.bom_no, flt(wo.qty_to_manufacture), warehouses, stock_mode)
        # Batch consumption from completed STEs
        batch_data = _get_batch_consumption(wo.name)
        # Sub-assembly WOs if this is linked to a production plan
        sub_asm_wos = _get_sub_assembly_wos(wo.production_plan) if wo.production_plan else []

        wo_details.append({
            "wo_name":           wo.name,
            "status":            wo.status,
            "qty_to_manufacture": flt(wo.qty_to_manufacture),
            "produced_qty":      flt(wo.produced_qty),
            "bom_no":            wo.bom_no,
            "planned_start":     str(wo.planned_start_date or ""),
            "planned_end":       str(wo.planned_end_date or ""),
            "production_plan":   wo.production_plan or "",
            "components":        components,
            "batch_consumption": batch_data,
            "sub_assembly_wos":  sub_asm_wos,
        })

    uom_conversions = _get_uom_conversions([item_code]).get(item_code, [])
    item_doc        = frappe.db.get_value("Item", item_code,
        ["item_name", "item_group", "stock_uom", "description", "standard_rate"],
        as_dict=True) or {}

    return {
        "item_code":      item_code,
        "item_name":      item_doc.get("item_name", ""),
        "item_group":     item_doc.get("item_group", ""),
        "stock_uom":      item_doc.get("stock_uom", ""),
        "description":    item_doc.get("description", ""),
        "current_stock":  flt(stock_map.get(item_code, 0)),
        "uom_conversions":uom_conversions,
        "work_orders":    wo_details,
    }


# =============================================================================
# SHORTAGE DETAIL (View button)
# =============================================================================

@frappe.whitelist()
def get_shortage_detail(item_code, warehouses=None, stock_mode="physical", wo_statuses=None):
    """
    Full shortage breakdown across all work order + sub-assembly combinations.
    Called when user clicks 'View' in the Overall Shortage column.
    """
    if isinstance(warehouses, str):
        warehouses = frappe.parse_json(warehouses) or []
    if isinstance(wo_statuses, str):
        wo_statuses = frappe.parse_json(wo_statuses) or _DEFAULT_WO_STATUSES

    # NOTE: Work Order column is `qty`; aliased to `qty_to_manufacture` for clarity.
    wo_rows = frappe.db.sql("""
        SELECT name, qty AS qty_to_manufacture, bom_no, status, production_plan
        FROM `tabWork Order`
        WHERE production_item = %s AND docstatus = 1
        LIMIT 20
    """, item_code, as_dict=True)

    shortage_by_wo = []
    all_shortage_items = {}  # item_code → aggregated shortage

    for wo in wo_rows:
        components = _walk_bom_deep(wo.bom_no, flt(wo.qty_to_manufacture), warehouses, stock_mode, depth=0)
        short_comps = [c for c in components if c["shortage"] > 0]

        for comp in short_comps:
            c = comp["item_code"]
            if c not in all_shortage_items:
                all_shortage_items[c] = {
                    "item_code":   c,
                    "item_name":   comp["item_name"],
                    "stock_uom":   comp["uom"],
                    "total_required": 0,
                    "in_stock":    comp["in_stock"],
                    "shortage":    0,
                    "wo_count":    0,
                    "open_docs":   comp.get("open_docs", []),
                }
            all_shortage_items[c]["total_required"] += comp["required"]
            all_shortage_items[c]["shortage"] += comp["shortage"]
            all_shortage_items[c]["wo_count"] += 1

        shortage_by_wo.append({
            "wo_name":       wo.name,
            "qty_to_manufacture": flt(wo.qty_to_manufacture),
            "status":        wo.status,
            "short_components": short_comps,
        })

    aggregated = sorted(
        all_shortage_items.values(),
        key=lambda x: x["shortage"] * _get_valuation_rate(x["item_code"]),
        reverse=True
    )

    # Add UOM conversions + open docs per aggregated item
    agg_codes = [x["item_code"] for x in aggregated]
    uom_map   = _get_uom_conversions(agg_codes) if agg_codes else {}
    for item in aggregated:
        item["uom_conversions"] = uom_map.get(item["item_code"], [])
        item["open_docs"]       = _get_open_docs_for_item(item["item_code"])

    return {
        "by_wo":     shortage_by_wo,
        "aggregated":aggregated,
    }


# =============================================================================
# COST BREAKUP (3-way comparison)
# =============================================================================

@frappe.whitelist()
def get_cost_breakup(item_code, company=None, month=None, year=None):
    """
    3-way cost comparison:
      1. BOM Standard Cost  — BOM item qty × valuation_rate
      2. Actual STE Cost    — current month manufacture STEs
      3. Historical Average — last 6 months STE average
    """
    today_date = getdate(today())
    curr_month = cint(month) if month else today_date.month
    curr_year  = cint(year)  if year  else today_date.year

    bom = _get_active_bom([item_code]).get(item_code, "")

    # 1. BOM standard cost
    bom_components = []
    bom_total = 0.0
    if bom:
        bom_items = frappe.db.sql("""
            SELECT bi.item_code, bi.item_name, bi.qty, bi.stock_qty,
                   bi.uom, bi.rate, bi.amount
            FROM `tabBOM Item` bi
            WHERE bi.parent = %s AND bi.parenttype = 'BOM'
            ORDER BY bi.idx
        """, bom, as_dict=True)
        for bi in bom_items:
            bom_components.append({
                "item_code": bi.item_code,
                "item_name": bi.item_name,
                "qty":       flt(bi.stock_qty),
                "uom":       bi.uom,
                "rate":      flt(bi.rate),
                "amount":    flt(bi.amount),
            })
            bom_total += flt(bi.amount)

    # 2. Actual STE cost (current month)
    actual_components = []
    actual_total = 0.0
    actual_qty_produced = 0.0
    ste_rows = frappe.db.sql("""
        SELECT sed.item_code, sed.item_name, SUM(sed.qty) AS total_qty,
               AVG(sed.valuation_rate) AS avg_rate, SUM(sed.basic_amount) AS total_amount,
               sed.uom
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type = 'Manufacture'
          AND sed.is_finished_item = 0
          AND MONTH(se.posting_date) = %s
          AND YEAR(se.posting_date) = %s
          AND se.work_order IN (
              SELECT name FROM `tabWork Order`
              WHERE production_item = %s AND docstatus = 1
          )
        GROUP BY sed.item_code, sed.uom
    """, (curr_month, curr_year, item_code), as_dict=True)

    # Get produced qty for per-unit cost calc
    prod_qty_row = frappe.db.sql("""
        SELECT SUM(sed.qty) AS produced
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type = 'Manufacture'
          AND sed.is_finished_item = 1
          AND sed.item_code = %s
          AND MONTH(se.posting_date) = %s
          AND YEAR(se.posting_date) = %s
    """, (item_code, curr_month, curr_year))
    actual_qty_produced = flt(prod_qty_row[0][0]) if prod_qty_row else 0

    for row in ste_rows:
        actual_components.append({
            "item_code": row.item_code,
            "item_name": row.item_name,
            "qty":       flt(row.total_qty),
            "uom":       row.uom or "Nos",
            "rate":      flt(row.avg_rate),
            "amount":    flt(row.total_amount),
        })
        actual_total += flt(row.total_amount)

    # 3. Historical average (last 6 months)
    hist_total = 0.0
    hist_runs  = 0
    hist_data = frappe.db.sql("""
        SELECT MONTH(se.posting_date) AS mo, YEAR(se.posting_date) AS yr,
               SUM(sed.basic_amount) AS total_cost
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type = 'Manufacture'
          AND sed.is_finished_item = 0
          AND se.posting_date >= DATE_SUB(%s, INTERVAL 6 MONTH)
          AND se.work_order IN (
              SELECT name FROM `tabWork Order`
              WHERE production_item = %s AND docstatus = 1
          )
        GROUP BY MONTH(se.posting_date), YEAR(se.posting_date)
    """, (f"{curr_year}-{curr_month:02d}-01", item_code), as_dict=True)

    for h in hist_data:
        hist_total += flt(h.total_cost)
        hist_runs  += 1
    hist_avg = round(hist_total / hist_runs, 2) if hist_runs else 0

    bom_per_unit   = round(bom_total, 2)
    actual_per_unit = round(actual_total / actual_qty_produced, 2) if actual_qty_produced > 0 else 0
    variance_pct   = round((actual_per_unit - bom_per_unit) / bom_per_unit * 100, 1) if bom_per_unit else 0

    # Per-UOM cost breakdown (BOM std + actual) for every UOM the item supports.
    # Lets the user see "₹/Kg vs ₹/Pcs" without manual math.
    uom_conv = _get_uom_conversions([item_code]).get(item_code, [])
    item_stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""
    cost_per_uom = []
    # Stock UOM row (factor 1)
    cost_per_uom.append({
        "uom":           item_stock_uom,
        "factor":        1.0,
        "bom_std":       round(bom_per_unit, 4),
        "actual":        round(actual_per_unit, 4),
        "variance_pct":  variance_pct,
    })
    for u in uom_conv:
        f = flt(u["factor"])
        if f > 0 and (u.get("uom") or "") and u.get("uom") != item_stock_uom:
            cost_per_uom.append({
                "uom":           u["uom"],
                "factor":        f,
                "bom_std":       round(bom_per_unit * f, 4),
                "actual":        round(actual_per_unit * f, 4),
                "variance_pct":  variance_pct,
            })

    return {
        "item_code":           item_code,
        "stock_uom":           item_stock_uom,
        "bom":                 bom,
        "bom_standard": {
            "components": bom_components,
            "total":      round(bom_total, 2),
            "per_unit":   bom_per_unit,
        },
        "actual_consumed": {
            "components":     actual_components,
            "total":          round(actual_total, 2),
            "qty_produced":   actual_qty_produced,
            "per_unit":       actual_per_unit,
        },
        "historical_avg": {
            "avg_per_run": hist_avg,
            "months_data": hist_runs,
            "period":      "Last 6 months",
        },
        "variance_pct":    variance_pct,
        "variance_amount": round(actual_per_unit - bom_per_unit, 2) if bom_per_unit else 0,
        # NEW — per-UOM display
        "cost_per_uom":    cost_per_uom,
    }


# =============================================================================
# PENDING STATUSES (for filter population)
# =============================================================================

@frappe.whitelist()
def get_default_statuses():
    """
    Return all distinct statuses that actually exist in the user's data plus
    sensible "pending" defaults. Nothing is hardcoded — the universe of
    selectable values comes from `SELECT DISTINCT status FROM tab<DocType>`,
    union the active workflow states (if a Workflow is assigned to that doc).

    This handles two real-world cases the user explicitly called out:
      1. Custom workflow on Sales Order ("Draft + workflow_state = Confirmed")
         is treated as pending — workflow states are surfaced as
         "Workflow: <state>" entries that the JS can pass back to the
         backend. The backend interprets these in `_status_filter_clause`.
      2. Sites with custom statuses not in the ERPNext default list still
         appear in the dropdown.
    """
    def _distinct_status(doctype):
        try:
            rows = frappe.db.sql(
                f"SELECT DISTINCT status FROM `tab{doctype}` WHERE status IS NOT NULL"
            )
            return sorted({r[0] for r in rows if r[0]})
        except Exception:
            return []

    def _distinct_workflow(doctype):
        # Workflow states only exist if a Workflow is assigned to that DocType.
        if not frappe.db.has_column(doctype, "workflow_state"):
            return []
        try:
            rows = frappe.db.sql(
                f"SELECT DISTINCT workflow_state FROM `tab{doctype}` "
                f"WHERE workflow_state IS NOT NULL AND workflow_state != ''"
            )
            return sorted({r[0] for r in rows if r[0]})
        except Exception:
            return []

    all_so_status = _distinct_status("Sales Order")
    so_workflow   = _distinct_workflow("Sales Order")
    all_wo_status = _distinct_status("Work Order")
    all_pp_status = _distinct_status("Production Plan")
    all_po_status = _distinct_status("Purchase Order")
    all_mr_status = _distinct_status("Material Request")

    # "Pending" defaults — intersect existing data with our preferred set so we
    # never offer a tick-box that maps to zero rows.
    def _intersect(actual, preferred):
        actual_set = set(actual)
        return [s for s in preferred if s in actual_set]

    so_pending_default = _intersect(all_so_status, _DEFAULT_SO_STATUSES) \
                          or [s for s in all_so_status
                              if s not in ("Cancelled", "Completed", "Closed", "Draft")]
    wo_pending_default = _intersect(all_wo_status, _DEFAULT_WO_STATUSES) \
                          or [s for s in all_wo_status
                              if s not in ("Cancelled", "Completed", "Stopped", "Draft", "Closed")]
    pp_pending_default = _intersect(all_pp_status, _DEFAULT_PP_STATUSES) \
                          or [s for s in all_pp_status
                              if s not in ("Cancelled", "Completed", "Closed")]
    po_pending_default = _intersect(all_po_status, _DEFAULT_PO_STATUSES) \
                          or [s for s in all_po_status
                              if s not in ("Cancelled", "Completed", "Closed", "Draft")]

    # Surface workflow states as parallel "Workflow: <state>" entries so the
    # user can flag draft-but-confirmed orders as pending without contradicting
    # the docstatus model.
    so_universe = list(all_so_status) + [f"Workflow: {w}" for w in so_workflow]

    return {
        # Defaults JS pre-checks on load
        "wo_statuses":  wo_pending_default,
        "so_statuses":  so_pending_default,
        "pp_statuses":  pp_pending_default,
        "po_statuses":  po_pending_default,
        # Universe of choices the multi-select shows (dynamic, never hardcoded)
        "all_wo_statuses": all_wo_status,
        "all_so_statuses": so_universe,
        "all_pp_statuses": all_pp_status,
        "all_po_statuses": all_po_status,
        "all_mr_statuses": all_mr_status,
        # Diagnostic — JS can show "(includes workflow states)" hint
        "so_has_workflow_column": frappe.db.has_column("Sales Order", "workflow_state"),
        "so_workflow_states":     so_workflow,
    }


def _split_status_and_workflow(status_list):
    """
    Split an incoming status list into (plain_statuses, workflow_states).
    Workflow states arrive as "Workflow: Confirmed" entries from JS.
    """
    plain, wf = [], []
    for s in (status_list or []):
        if isinstance(s, str) and s.startswith("Workflow: "):
            wf.append(s[len("Workflow: "):])
        else:
            plain.append(s)
    return plain, wf


def _so_status_clause(so_statuses):
    """
    Build a SQL fragment that matches:
      (so.docstatus = 1 AND so.status IN (plain_statuses))
      OR (so.docstatus = 0 AND so.workflow_state IN (wf_states))   ← only if column exists
    Returns SQL text — caller embeds inside an existing WHERE.
    """
    plain, wf = _split_status_and_workflow(so_statuses)
    parts = []
    if plain:
        parts.append(f"(so.docstatus = 1 AND so.status IN {_sql_in(plain)})")
    if wf and frappe.db.has_column("Sales Order", "workflow_state"):
        parts.append(f"(so.docstatus = 0 AND so.workflow_state IN {_sql_in(wf)})")
    if not parts:
        # No usable filter — match nothing rather than everything (safe default).
        return "1=0"
    return "(" + " OR ".join(parts) + ")"


# =============================================================================
# EXPORT DATA (for CSV/Excel)
# =============================================================================

@frappe.whitelist()
def get_export_data(company=None, month=None, year=None, warehouses=None,
                    wo_statuses=None, so_statuses=None, stock_mode="physical"):
    """
    Returns flat rows suitable for CSV/Excel export.
    UOM conversions are included as extra columns.
    """
    result = get_production_overview(
        company=company, month=month, year=year,
        warehouses=warehouses, wo_statuses=wo_statuses,
        so_statuses=so_statuses, stock_mode=stock_mode
    )

    rows = []
    for item in result.get("items", []):
        code = item["item_code"]
        row = {
            "Item Code":          code,
            "Item Name":          item["item_name"],
            "Item Group":         item["item_group"],
            "Item Type":          item["item_type"],
            "Stock UOM":          item["stock_uom"],
            "Is Sub Assembly":    "Yes" if item["is_sub_assembly"] else "No",
            "Open WO Count":      item["open_wo_count"],
            "Planned Qty":        item["planned_qty"],
            "Actual Qty":         item["actual_qty"],
            "Prev Month Orders":  item["prev_month_order"],
            "Curr Month Orders":  item["curr_month_order"],
            "Curr Dispatch":      item["curr_dispatch"],
            "Curr Projection":    item["curr_projection"],
            "Total Curr Sales":   item["total_curr_sales"],
            "Projection vs Sales (%)": round(item["projection_vs_sales"] * 100, 1),
            "Stock":              item["stock"],
            "Has Shortage":       "Yes" if item["has_shortage"] else "No",
            "Possible Qty":       item["possible_qty"],
            "BOM Standard Cost":  item.get("cost_summary", {}).get("bom_total", 0),
            "Actual Cost":        item.get("cost_summary", {}).get("actual_total", 0),
            "Cost Variance %":    item.get("cost_summary", {}).get("variance_pct", 0),
        }
        # Append UOM conversions as extra columns
        for uom in item.get("uom_conversions", []):
            col_pfx = uom["uom"]
            factor  = flt(uom["factor"])
            if factor > 0:
                row[f"Planned Qty ({col_pfx})"]   = round(item["planned_qty"] / factor, 3)
                row[f"Actual Qty ({col_pfx})"]    = round(item["actual_qty"] / factor, 3)
                row[f"Curr Orders ({col_pfx})"]   = round(item["curr_month_order"] / factor, 3)
                row[f"Curr Dispatch ({col_pfx})"] = round(item["curr_dispatch"] / factor, 3)
        rows.append(row)

    return {"rows": rows, "period": result.get("period", {})}


# =============================================================================
# EXCEL EXPORT (server-side, multi-sheet, formatted)
# =============================================================================

@frappe.whitelist()
def export_excel(company=None, month=None, year=None, warehouses=None,
                 wo_statuses=None, so_statuses=None, pp_statuses=None,
                 stock_mode="physical"):
    """
    Server-side Excel export with three sheets and basic colour coding.
    Frappe's `build_xlsx_response` writes the file directly into the HTTP
    response, so JS just needs `window.location = "/api/method/..."`.
    """
    from openpyxl import Workbook
    from openpyxl.styles import PatternFill, Font, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    result = get_production_overview(
        company=company, month=month, year=year,
        warehouses=warehouses, wo_statuses=wo_statuses,
        so_statuses=so_statuses, pp_statuses=pp_statuses,
        stock_mode=stock_mode,
    )
    items   = result.get("items", [])
    summary = result.get("summary", {})
    period  = result.get("period", {})

    wb = Workbook()

    HEAD_FILL  = PatternFill("solid", fgColor="4F46E5")
    HEAD_FONT  = Font(bold=True, color="FFFFFF", size=11)
    SUB_FILL   = PatternFill("solid", fgColor="EEF2FF")
    OK_FILL    = PatternFill("solid", fgColor="D1FAE5")
    WARN_FILL  = PatternFill("solid", fgColor="FEF3C7")
    ERR_FILL   = PatternFill("solid", fgColor="FEE2E2")
    SO_FILL    = PatternFill("solid", fgColor="FFF1F2")
    THIN       = Side(border_style="thin", color="E2E8F0")
    BORDER     = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
    CENTRE     = Alignment(horizontal="center", vertical="center")

    def _fmt_header(ws, row, headers):
        for col_idx, h in enumerate(headers, start=1):
            cell = ws.cell(row=row, column=col_idx, value=h)
            cell.fill      = HEAD_FILL
            cell.font      = HEAD_FONT
            cell.alignment = CENTRE
            cell.border    = BORDER

    def _autosize(ws, headers, sample_count=15):
        for col_idx, h in enumerate(headers, start=1):
            max_len = len(str(h))
            for row in range(2, min(2 + sample_count, ws.max_row + 1)):
                v = ws.cell(row=row, column=col_idx).value
                if v is not None:
                    max_len = max(max_len, len(str(v)))
            ws.column_dimensions[get_column_letter(col_idx)].width = min(max_len + 2, 42)

    # ── Sheet 1: Overview ─────────────────────────────────────────────
    ws1 = wb.active
    ws1.title = "Overview"
    headers = [
        "Item Code", "Item Name", "Item Group", "Type", "Stock UOM",
        "Sub-Assembly", "Has Open SO", "Open WOs", "Active PPs",
        "Planned Qty", "Produced",
        "Prev Month SO", "Curr Month SO",
        "Prev Month Dispatch", "Curr Month Dispatch",
        "Sales Projection", "Total Curr Sales",
        "Proj vs Sales %", "Coverage %",
        "Stock on Hand", "Possible Qty",
        "Has Shortage", "Active BOM",
        "BOM Std Cost", "Actual Cost", "Variance %",
    ]
    _fmt_header(ws1, 1, headers)
    for i, item in enumerate(items, start=2):
        row = [
            item["item_code"], item["item_name"], item.get("item_group", ""),
            item["item_type"], item["stock_uom"],
            "Yes" if item["is_sub_assembly"] else "No",
            "Yes" if item.get("has_open_so") else "No",
            item["open_wo_count"], item.get("pp_count", 0),
            item["planned_qty"], item["actual_qty"],
            item["prev_month_order"], item["curr_month_order"],
            item.get("prev_dispatch", 0), item["curr_dispatch"],
            item["curr_projection"], item["total_curr_sales"],
            round(item["projection_vs_sales"] * 100, 1) if item["projection_vs_sales"] else 0,
            item.get("coverage_pct", 0),
            item["stock"], item["possible_qty"],
            "Yes" if item["has_shortage"] else "No",
            item.get("active_bom", ""),
            item.get("cost_summary", {}).get("bom_total", 0),
            item.get("cost_summary", {}).get("actual_total", 0),
            item.get("cost_summary", {}).get("variance_pct", 0),
        ]
        for col_idx, val in enumerate(row, start=1):
            cell = ws1.cell(row=i, column=col_idx, value=val)
            cell.border = BORDER
            if col_idx >= 8 and isinstance(val, (int, float)):
                cell.alignment = Alignment(horizontal="right")
        # Row tinting
        if item["has_shortage"]:
            for col_idx in range(1, len(headers) + 1):
                ws1.cell(row=i, column=col_idx).fill = ERR_FILL
        elif item.get("has_open_so"):
            for col_idx in range(1, len(headers) + 1):
                ws1.cell(row=i, column=col_idx).fill = SO_FILL
    ws1.freeze_panes = "C2"
    _autosize(ws1, headers)

    # ── Sheet 2: UOM Comparison ───────────────────────────────────────
    ws2 = wb.create_sheet("UOM Comparison")
    uom_headers = ["Item Code", "Item Name", "Stock UOM", "Field", "Stock UOM Qty", "UOM", "Factor", "Converted Qty"]
    _fmt_header(ws2, 1, uom_headers)
    fields = [
        ("Planned Qty",     "planned_qty"),
        ("Produced",        "actual_qty"),
        ("Curr Month SO",   "curr_month_order"),
        ("Curr Dispatch",   "curr_dispatch"),
        ("Sales Projection","curr_projection"),
        ("Stock on Hand",   "stock"),
        ("Possible Qty",    "possible_qty"),
    ]
    r = 2
    for item in items:
        uom_list = item.get("uom_conversions") or [{"uom": item["stock_uom"], "factor": 1.0}]
        for label, key in fields:
            qty = flt(item.get(key, 0))
            for u in uom_list:
                f = flt(u.get("factor"))
                if f <= 0:
                    continue
                ws2.append([
                    item["item_code"], item["item_name"], item["stock_uom"],
                    label, qty, u.get("uom") or item["stock_uom"], f,
                    round(qty / f, 4),
                ])
                for col_idx in range(1, len(uom_headers) + 1):
                    ws2.cell(row=r, column=col_idx).border = BORDER
                if u.get("uom") == item["stock_uom"]:
                    for col_idx in range(1, len(uom_headers) + 1):
                        ws2.cell(row=r, column=col_idx).fill = SUB_FILL
                r += 1
    ws2.freeze_panes = "B2"
    _autosize(ws2, uom_headers)

    # ── Sheet 3: Summary ──────────────────────────────────────────────
    ws3 = wb.create_sheet("Summary")
    ws3["A1"] = f"Production Overview — {period.get('month_name','')} {period.get('year','')}"
    ws3["A1"].font = Font(bold=True, size=14, color="0F172A")
    ws3.merge_cells("A1:D1")

    summary_rows = [
        ("Total Items",          summary.get("total_items", 0)),
        ("With Shortage",        summary.get("items_with_shortage", 0)),
        ("No Shortage",          summary.get("items_no_shortage", 0)),
        ("Total Planned Qty",    summary.get("total_planned_qty", 0)),
        ("Total Actual Qty",     summary.get("total_actual_qty", 0)),
        ("Total Curr Orders",    summary.get("total_curr_orders", 0)),
        ("Total Dispatch",       summary.get("total_dispatch", 0)),
        ("Total Projection",     summary.get("total_projection", 0)),
    ]
    _fmt_header(ws3, 3, ["Metric", "Value"])
    for i, (k, v) in enumerate(summary_rows, start=4):
        ws3.cell(row=i, column=1, value=k).border = BORDER
        c = ws3.cell(row=i, column=2, value=v)
        c.border = BORDER
        c.alignment = Alignment(horizontal="right")
    ws3.column_dimensions["A"].width = 28
    ws3.column_dimensions["B"].width = 18

    # ── Save into Frappe response ─────────────────────────────────────
    fname = f"production_overview_{period.get('month_name','')}_{period.get('year','')}.xlsx"
    from io import BytesIO
    bio = BytesIO()
    wb.save(bio)
    frappe.response.filename     = fname
    frappe.response.filecontent  = bio.getvalue()
    frappe.response.type         = "binary"
    frappe.response.display_content_as = "attachment"


# =============================================================================
# CHART DATA (Tab 3)
# =============================================================================

@frappe.whitelist()
def get_chart_data(company=None, month=None, year=None, warehouses=None,
                   wo_statuses=None, so_statuses=None, stock_mode="physical"):
    """
    Aggregated data for pie + bar charts in Tab 3.
    """
    result = get_production_overview(
        company=company, month=month, year=year,
        warehouses=warehouses, wo_statuses=wo_statuses,
        so_statuses=so_statuses, stock_mode=stock_mode
    )
    items = result.get("items", [])

    # Pie 1: Item type distribution
    type_counts = {}
    for item in items:
        t = item["item_type"]
        type_counts[t] = type_counts.get(t, 0) + 1

    # Pie 2: Shortage distribution
    shortage_yes = sum(1 for x in items if x["has_shortage"])
    shortage_no  = len(items) - shortage_yes

    # Bar 1: Top 10 items by Curr Month Order qty
    top_order = sorted(items, key=lambda x: x["curr_month_order"], reverse=True)[:10]
    bar_orders = {
        "labels":  [x["item_code"] for x in top_order],
        "planned": [x["planned_qty"] for x in top_order],
        "actual":  [x["actual_qty"] for x in top_order],
        "orders":  [x["curr_month_order"] for x in top_order],
        "dispatch":[x["curr_dispatch"] for x in top_order],
    }

    # Bar 2: Projection vs Dispatch (top 10 by projection)
    top_proj = sorted(items, key=lambda x: x["curr_projection"], reverse=True)[:10]
    bar_proj = {
        "labels":     [x["item_code"] for x in top_proj],
        "projection": [x["curr_projection"] for x in top_proj],
        "sales":      [x["total_curr_sales"] for x in top_proj],
        "stock":      [x["stock"] for x in top_proj],
    }

    # Bar 3: WO count per item group
    group_wo = {}
    for item in items:
        g = item["item_group"] or "Other"
        group_wo[g] = group_wo.get(g, 0) + item["open_wo_count"]
    group_wo_sorted = sorted(group_wo.items(), key=lambda x: x[1], reverse=True)[:10]

    return {
        "type_pie":     type_counts,
        "shortage_pie": {"Yes": shortage_yes, "No": shortage_no},
        "bar_orders":   bar_orders,
        "bar_projection": bar_proj,
        "bar_wo_by_group": {
            "labels": [x[0] for x in group_wo_sorted],
            "values": [x[1] for x in group_wo_sorted],
        },
        "summary":      result.get("summary", {}),
    }


# =============================================================================
# AI ADVISOR (Tab 2) — DeepSeek Integration
# =============================================================================

_POR_AI_SYSTEM_PROMPT = (
    "You are a production planning advisor for an ERPNext-based factory.\n"
    "Data covers Work Orders, Sales Orders, Sales Projections, stock, "
    "BOM-derived shortages, and cost variances.\n\n"
    "STRICT RULES (do not break):\n"
    " - NO greetings. NO 'Hi', 'Hello', 'Sure', 'Certainly', 'Of course'.\n"
    " - NO preamble. NO 'Based on the data...', 'Here is...'.\n"
    " - Lead with the answer or action. Skip everything before it.\n"
    " - Output is ALWAYS HTML (never plain Markdown, never plain text).\n"
    " - Be direct, factual, and actionable. The reader is a factory manager.\n\n"
    "OUTPUT FORMAT (HTML ONLY):\n"
    " - For status text:\n"
    "   <span class=\"por-ai-ok\">good / on track</span>\n"
    "   <span class=\"por-ai-warn\">warning</span>\n"
    "   <span class=\"por-ai-err\">critical</span>\n"
    " - For data: WRAP every table in a scroll container so wide tables\n"
    "   never overflow the chat bubble:\n"
    "   <div class=\"por-ai-tablewrap\" style=\"overflow:auto; max-height:340px;\">\n"
    "     <table class=\"por-ai-table\"><thead>...</thead><tbody>...</tbody></table>\n"
    "   </div>\n"
    "   Tables: keep to <=6 columns and <=20 rows; if more rows are needed,\n"
    "   sort by impact (descending) and append a footer row 'Top N of M shown'.\n"
    " - For action steps:\n"
    "   <ol class=\"por-ai-actions\"><li>verb-led sentence</li>...</ol>\n"
    "   Use 3 steps unless the question explicitly asks for more or fewer.\n"
    " - For lists with sub-detail use <details><summary>...</summary>...</details>.\n\n"
    "VALUE FORMATTING:\n"
    " - ALWAYS include item_code in parentheses: 'Masala Blend (MBLND-500G)'.\n"
    " - Show qty with both UOMs when conversion is meaningful: '5,000 Gram (5 Kg)'.\n"
    " - Currency is INR. Use ₹ symbol. Two decimals max.\n"
    " - Projection vs Sales ratio: >1.0 = outperforming, <1.0 = below projection.\n"
    " - Shortage = active BOM components are short to meet demand.\n"
    " - Coverage % = (Projection + Prev Month SO) / Total Curr Sales * 100.\n\n"
    "RESPONSE LENGTH:\n"
    " - One-sentence questions get one-sentence answers (no table).\n"
    " - 'Top N' / 'Which items' / 'List' questions get a wrapped table.\n"
    " - 'Plan' / 'What should I do' questions end with the action ordered list.\n"
)


@frappe.whitelist()
def get_deepseek_models_por():
    """Return available DeepSeek models for the model selector."""
    return {
        model_id: {
            "name":             cfg["name"],
            "description":      cfg["description"],
            "est_cost_per_call":cfg["est_cost_per_call"],
        }
        for model_id, cfg in DEEPSEEK_MODELS.items()
    }


@frappe.whitelist()
def get_ai_overview_insight(context_json, model=None):
    """
    Auto-insight: run once after data loads.
    Returns a structured briefing (no session, no tool calling).
    """
    if isinstance(context_json, str):
        context = frappe.parse_json(context_json) or {}
    else:
        context = context_json or {}

    api_key = _get_api_key()
    if not api_key:
        return {
            "insight": "<span class='por-ai-warn'>DeepSeek API key not configured. "
                       "Set it in TOC Settings → AI Advisor → DeepSeek API Key.</span>",
            "is_html": True,
        }

    summary = context.get("summary", {})
    items   = context.get("items", [])[:20]  # top 20 only to stay within token budget

    insight_prompt = (
        "Analyse this production overview data and give a structured briefing.\n\n"
        f"SUMMARY: {json.dumps(summary)}\n"
        f"TOP ITEMS (by curr month order qty): {json.dumps(items)}\n\n"
        "OUTPUT FORMAT (HTML):\n"
        "1. One sentence overall status.\n"
        "2. Table of top 3 critical issues: Item | Issue | Impact | Recommended Action\n"
        "3. Exactly 3 action steps as <ol class='por-ai-actions'>.\n"
        "No preamble. Lead with status."
    )

    messages = [
        {"role": "system",  "content": _POR_AI_SYSTEM_PROMPT},
        {"role": "user",    "content": insight_prompt},
    ]

    try:
        resp   = _call_deepseek(messages, api_key=api_key, model=model)
        reply  = resp["choices"][0]["message"]["content"] or ""
    except Exception as exc:
        frappe.log_error(str(exc), "POR AI Auto-Insight")
        reply  = "<span class='por-ai-warn'>AI insight unavailable. Check Error Log → POR AI.</span>"

    return {"insight": reply, "is_html": True}


@frappe.whitelist()
def chat_with_overview_advisor(message, session_id, context_json, model=None):
    """
    Session-persistent AI chat for the Production Overview Advisor.
    Redis key: por:chat:{user}:{session_id}
    """
    if isinstance(context_json, str):
        context = frappe.parse_json(context_json) or {}
    else:
        context = context_json or {}

    api_key = _get_api_key()
    if not api_key:
        return {
            "reply":      "<span class='por-ai-warn'>DeepSeek API key not configured.</span>",
            "session_id": session_id,
            "is_html":    True,
        }

    user      = frappe.session.user or "Guest"
    redis_key = f"{_POR_AI_SESSION_PREFIX}{user}:{session_id}"

    # Load or initialise session
    history_raw = frappe.cache().get_value(redis_key)
    history = json.loads(history_raw) if history_raw else []

    # Build system context (strip large keys before sending to LLM)
    ctx_for_ai = {k: v for k, v in context.items() if k not in ("items", "raw_rows")}
    system_content = (
        f"{_POR_AI_SYSTEM_PROMPT}\n\n"
        f"CURRENT PRODUCTION CONTEXT:\n{json.dumps(ctx_for_ai, default=str)}"
    )

    messages = (
        [{"role": "system", "content": system_content}]
        + history[-_AI_MAX_HISTORY:]
        + [{"role": "user", "content": message}]
    )

    reply_text, updated_messages, _ = _execute_chat_with_tools(
        messages, context, api_key, model=model
    )

    # Save only user + assistant turns
    new_history = [m for m in updated_messages if m.get("role") in ("user", "assistant")]
    frappe.cache().set_value(redis_key, json.dumps(new_history[-_AI_MAX_HISTORY:]),
                             expires_in_sec=_AI_SESSION_TTL)

    return {"reply": reply_text, "session_id": session_id, "is_html": True}


@frappe.whitelist()
def test_ai_connection_por():
    """Diagnostic: verify API key and DeepSeek connectivity."""
    api_key = _get_api_key()
    if not api_key:
        return {"ok": False, "message": "No API key found. Configure in TOC Settings."}
    try:
        resp = _call_deepseek(
            [{"role": "user", "content": "Reply: ok"}],
            api_key=api_key, model="deepseek-chat"
        )
        reply = resp["choices"][0]["message"]["content"]
        return {"ok": True, "message": reply, "model": "deepseek-chat"}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


# =============================================================================
# PRIVATE HELPERS
# =============================================================================

def _empty_summary():
    return {
        "total_items": 0, "items_with_shortage": 0, "items_no_shortage": 0,
        "total_planned_qty": 0, "total_actual_qty": 0,
        "total_curr_orders": 0, "total_dispatch": 0, "total_projection": 0,
    }


def _sql_in(lst):
    """Build a safe SQL IN(...) clause string from a list."""
    if not lst:
        return "('')"
    escaped = ", ".join(frappe.db.escape(str(x)) for x in lst)
    return f"({escaped})"


def _build_wh_filter(warehouses):
    if not warehouses:
        return "", {}
    sql = _sql_in(warehouses)
    return f"AND warehouse IN {sql}", {}


def _get_qualifying_items(wo_statuses, so_statuses, curr_month, curr_year,
                          prev_month, prev_year, company):
    """Return set of item_codes that qualify for the overview."""
    codes = set()
    wo_sql = _sql_in(wo_statuses)
    so_clause = _so_status_clause(so_statuses)

    # 1. Auto TOC manufacture items
    rows = frappe.db.sql_list("""
        SELECT name FROM `tabItem`
        WHERE disabled = 0 AND custom_toc_auto_manufacture = 1
    """)
    codes.update(rows)

    # 2. Items in open Work Orders
    rows = frappe.db.sql_list(f"""
        SELECT DISTINCT production_item FROM `tabWork Order`
        WHERE docstatus = 1 AND status IN {wo_sql}
    """)
    codes.update(rows)

    # 3. Items in open Sales Orders (curr + prev month)
    rows = frappe.db.sql_list(f"""
        SELECT DISTINCT soi.item_code
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE {so_clause}
          AND (
            (MONTH(soi.delivery_date) = {curr_month} AND YEAR(soi.delivery_date) = {curr_year})
            OR
            (MONTH(soi.delivery_date) = {prev_month} AND YEAR(soi.delivery_date) = {prev_year})
          )
    """)
    codes.update(rows)

    # 4. Items in current Sales Projection
    month_name = _MONTH_NAMES[curr_month - 1]
    rows = frappe.db.sql_list(f"""
        SELECT DISTINCT spi.item
        FROM `tabSales Projected Items` spi
        JOIN `tabSales Projection` sp ON sp.name = spi.parent
        WHERE sp.projection_month = {frappe.db.escape(month_name)}
          AND sp.projection_year = {curr_year}
          AND sp.docstatus IN (0, 1)
    """)
    codes.update(rows)

    # 5. Sub-assemblies in active BOMs
    rows = frappe.db.sql_list("""
        SELECT DISTINCT bi.item_code
        FROM `tabBOM Item` bi
        JOIN `tabBOM` b ON b.name = bi.parent
        WHERE b.is_active = 1 AND b.docstatus = 1
          AND bi.item_code IN (
              SELECT name FROM `tabItem` WHERE disabled = 0
          )
    """)
    codes.update(rows)

    return list(codes)


def _get_uom_conversions(item_codes):
    """Returns {item_code: [{uom, factor}, ...]} for all conversions."""
    if not item_codes:
        return {}
    sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT parent AS item_code, uom, conversion_factor AS factor
        FROM `tabUOM Conversion Detail`
        WHERE parent IN {sql}
          AND conversion_factor > 0
        ORDER BY conversion_factor ASC
    """, as_dict=True)
    result = {}
    for r in rows:
        result.setdefault(r.item_code, []).append({
            "uom": r.uom, "factor": flt(r.factor)
        })
    return result


def _get_sub_assembly_info(item_codes, wo_statuses):
    """
    Sub-assembly detection — strict definition per user requirement:

      "the item is a child of a parent work order but it itself has open
       work order (identify from production planning doctype with connection)"

    Two qualifying conditions joined together:

      (A) Item is produced by an open child WO that links to a Production Plan
          (`Work Order.production_plan` is not null, status open, docstatus=1).
      (B) The same Production Plan also has a parent WO whose `production_item`
          differs from this item — i.e. there's a real parent → child chain
          via PP, not a stand-alone WO.

    The returned `wo_list` contains the PARENT WOs (the ones consuming this item
    as a sub-assembly) along with shortage qty estimated from BOM × parent qty
    minus current stock — so the user can see "Will be used in PARENT_WO with
    shortage 1200 g".

    Independent (own BOM, no parent linkage) WOs are intentionally NOT marked
    as sub-assembly.
    """
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    wo_sql    = _sql_in(wo_statuses)

    # 1. Find PP-linked open WOs grouped by Production Plan.
    pp_wo_rows = frappe.db.sql(f"""
        SELECT wo.name AS wo_name, wo.production_plan, wo.production_item,
               wo.bom_no, wo.qty AS planned_qty, wo.status
        FROM `tabWork Order` wo
        WHERE wo.docstatus = 1
          AND wo.status IN {wo_sql}
          AND IFNULL(wo.production_plan, '') != ''
    """, as_dict=True)

    pp_groups = {}
    for r in pp_wo_rows:
        pp_groups.setdefault(r.production_plan, []).append(r)

    # 2. For each item, find PPs where this item is a CHILD WO and there is at
    #    least one OTHER WO in the same PP with a different production_item
    #    (= the parent).
    sub_asm_set = set()
    parent_wo_map = {ic: [] for ic in item_codes}

    for pp, wos in pp_groups.items():
        items_in_pp = {w.production_item for w in wos}
        for w in wos:
            if w.production_item in item_codes and len(items_in_pp - {w.production_item}) > 0:
                sub_asm_set.add(w.production_item)
                # Record parent WOs for this sub-assembly
                for parent in wos:
                    if parent.production_item != w.production_item:
                        parent_wo_map[w.production_item].append({
                            "wo_name":         parent.wo_name,
                            "bom_no":          parent.bom_no,
                            "parent_item":     parent.production_item,
                            "parent_qty":      flt(parent.planned_qty),
                            "production_plan": pp,
                            "status":          parent.status,
                        })

    # 3. Estimate "shortage qty in this sub-assembly required by each parent WO".
    #    Uses BOM Item.stock_qty × parent_qty / bom.quantity − current stock map
    #    is computed lazily by caller (we just supply the required component qty).
    if sub_asm_set:
        # Bulk fetch BOM line for this component in each parent BOM.
        sub_codes_sql = _sql_in(list(sub_asm_set))
        bom_lines = frappe.db.sql(f"""
            SELECT bi.parent AS bom_no, bi.item_code, bi.stock_qty AS qty_per_unit
            FROM `tabBOM Item` bi
            WHERE bi.item_code IN {sub_codes_sql}
        """, as_dict=True)
        bom_qty_map = {(b.bom_no, b.item_code): flt(b.qty_per_unit) for b in bom_lines}

        # Annotate parent WO entries with required_qty for the sub-assembly.
        for ic, parents in parent_wo_map.items():
            for p in parents:
                qpu = bom_qty_map.get((p["bom_no"], ic), 0)
                p["required_qty"] = round(qpu * p["parent_qty"], 3)

    result = {}
    for code in item_codes:
        result[code] = {
            "is_sub_assembly": code in sub_asm_set,
            "wo_list": parent_wo_map.get(code, []),
        }
    return result


def _get_pp_list(item_code, pp_statuses=None):
    """
    Native ERPNext call: list active Production Plans containing this item
    as a Production Plan Item, plus all child Work Orders for the same plan.
    Used by `get_active_production_plans` modal.
    """
    pp_statuses = pp_statuses or _DEFAULT_PP_STATUSES
    pp_sql      = _sql_in(pp_statuses)
    pps = frappe.db.sql(f"""
        SELECT DISTINCT pp.name, pp.status, pp.posting_date,
               pp.custom_created_by, pp.custom_creation_reason
        FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
        WHERE pp.docstatus = 1
          AND pp.status IN {pp_sql}
          AND ppi.item_code = %s
        ORDER BY pp.posting_date DESC
        LIMIT 25
    """, item_code, as_dict=True)

    if not pps:
        return []
    pp_names_sql = _sql_in([p.name for p in pps])
    wo_rows = frappe.db.sql(f"""
        SELECT name, production_item, qty AS planned_qty, produced_qty,
               status, production_plan, bom_no, planned_start_date
        FROM `tabWork Order`
        WHERE docstatus = 1
          AND production_plan IN {pp_names_sql}
        ORDER BY production_plan, planned_start_date
    """, as_dict=True)

    by_pp = {}
    for w in wo_rows:
        by_pp.setdefault(w.production_plan, []).append({
            "wo_name":            w.name,
            "production_item":    w.production_item,
            "planned_qty":        flt(w.planned_qty),
            "produced_qty":       flt(w.produced_qty),
            "status":             w.status,
            "bom_no":             w.bom_no,
            "is_target_item":     w.production_item == item_code,
            "planned_start_date": str(w.planned_start_date or ""),
        })

    out = []
    for pp in pps:
        out.append({
            "pp_name":          pp.name,
            "status":           pp.status,
            "posting_date":     str(pp.posting_date or ""),
            "created_by":       pp.custom_created_by or "User",
            "creation_reason":  pp.custom_creation_reason or "",
            "work_orders":      by_pp.get(pp.name, []),
        })
    return out


@frappe.whitelist()
def get_active_production_plans(item_code, pp_statuses=None):
    """
    Returns active Production Plans containing this item (as PPI) AND all WOs
    of those plans grouped by parent/child. Used by the "View Plan" modal.
    """
    if isinstance(pp_statuses, str):
        pp_statuses = frappe.parse_json(pp_statuses) or _DEFAULT_PP_STATUSES
    return {"item_code": item_code, "plans": _get_pp_list(item_code, pp_statuses)}


def _get_wo_counts(item_codes, wo_statuses):
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    wo_sql    = _sql_in(wo_statuses)
    rows = frappe.db.sql(f"""
        SELECT production_item, COUNT(*) AS cnt
        FROM `tabWork Order`
        WHERE docstatus = 1 AND status IN {wo_sql}
          AND production_item IN {codes_sql}
        GROUP BY production_item
    """, as_dict=True)
    return {r.production_item: r.cnt for r in rows}


def _get_planned_qty(item_codes, wo_statuses):
    """Sum of planned manufacturing qty for open WOs.

    DANGER: ERPNext Work Order's "Qty To Manufacture" column is named `qty`
    in the database (label only is "Qty To Manufacture"). Do NOT use
    `qty_to_manufacture` in SQL on `tabWork Order` — that column does not exist
    and raises OperationalError 1054. The fieldname `qty_to_manufacture` exists
    on Production Plan Item, NOT on Work Order.
    """
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    wo_sql    = _sql_in(wo_statuses)
    rows = frappe.db.sql(f"""
        SELECT production_item, SUM(qty) AS total
        FROM `tabWork Order`
        WHERE docstatus = 1 AND status IN {wo_sql}
          AND production_item IN {codes_sql}
        GROUP BY production_item
    """, as_dict=True)
    return {r.production_item: flt(r.total) for r in rows}


def _get_actual_qty(item_codes, month, year):
    """Sum of finished item qty from Manufacture STEs in the given month."""
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT sed.item_code, SUM(sed.transfer_qty) AS total
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type = 'Manufacture'
          AND sed.is_finished_item = 1
          AND MONTH(se.posting_date) = {cint(month)}
          AND YEAR(se.posting_date) = {cint(year)}
          AND sed.item_code IN {codes_sql}
        GROUP BY sed.item_code
    """, as_dict=True)
    return {r.item_code: flt(r.total) for r in rows}


def _get_so_qty(item_codes, so_statuses, month, year):
    """
    Sum of pending qty in stock_uom from open SOs with delivery_date in given month.

    Uses ERPNext-native UOM convention:
      pending_stock = soi.stock_qty - delivered_qty * conversion_factor
    (matches `production_plan_engine.py` and `wo_kitting_api.py`.)
    """
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    so_clause = _so_status_clause(so_statuses)
    rows = frappe.db.sql(f"""
        SELECT soi.item_code,
               SUM(soi.stock_qty - IFNULL(soi.delivered_qty,0) * IFNULL(soi.conversion_factor,1)) AS total
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE {so_clause}
          AND MONTH(soi.delivery_date) = {cint(month)}
          AND YEAR(soi.delivery_date) = {cint(year)}
          AND soi.item_code IN {codes_sql}
        GROUP BY soi.item_code
    """, as_dict=True)
    return {r.item_code: flt(r.total) for r in rows}


def _get_has_open_so_map(item_codes, so_statuses):
    """Returns {item_code: True} for items with at least one pending SO line (any month)."""
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    so_clause = _so_status_clause(so_statuses)
    rows = frappe.db.sql(f"""
        SELECT DISTINCT soi.item_code
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE {so_clause}
          AND soi.item_code IN {codes_sql}
          AND (soi.stock_qty - IFNULL(soi.delivered_qty,0) * IFNULL(soi.conversion_factor,1)) > 0
    """)
    return {r[0]: True for r in rows}


def _get_dispatch_qty(item_codes, month, year):
    """Sum of stock_qty from submitted Delivery Notes in given month."""
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT dni.item_code, SUM(dni.stock_qty) AS total
        FROM `tabDelivery Note Item` dni
        JOIN `tabDelivery Note` dn ON dn.name = dni.parent
        WHERE dn.docstatus = 1
          AND MONTH(dn.posting_date) = {cint(month)}
          AND YEAR(dn.posting_date) = {cint(year)}
          AND dni.item_code IN {codes_sql}
        GROUP BY dni.item_code
    """, as_dict=True)
    return {r.item_code: flt(r.total) for r in rows}


def _get_projection_qty(item_codes, month_name, year):
    """Sum of qty_in_stock_uom from current Sales Projection."""
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT spi.item, SUM(spi.qty_in_stock_uom) AS total
        FROM `tabSales Projected Items` spi
        JOIN `tabSales Projection` sp ON sp.name = spi.parent
        WHERE sp.projection_month = {frappe.db.escape(month_name)}
          AND sp.projection_year = {cint(year)}
          AND sp.docstatus IN (0, 1)
          AND spi.item IN {codes_sql}
        GROUP BY spi.item
    """, as_dict=True)
    return {r.item: flt(r.total) for r in rows}


def _get_total_sales_qty(item_codes, month, year):
    """
    Total sales qty (dispatched + pending) booked for the given month.
    Submitted SOs only (docstatus = 1) — Drafts are not "sales" yet even if
    the workflow says Confirmed; that's intentional and matches ERPNext semantics.
    """
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT soi.item_code, SUM(soi.stock_qty) AS total
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE so.docstatus = 1
          AND MONTH(soi.delivery_date) = {cint(month)}
          AND YEAR(soi.delivery_date) = {cint(year)}
          AND soi.item_code IN {codes_sql}
        GROUP BY soi.item_code
    """, as_dict=True)
    return {r.item_code: flt(r.total) for r in rows}


def _get_active_pp_count(item_codes, pp_statuses=None):
    """
    Count of active Production Plans per item — joins via
    `tabProduction Plan Item.item_code` (ERPNext native child table).
    """
    if not item_codes:
        return {}
    pp_statuses = pp_statuses or _DEFAULT_PP_STATUSES
    codes_sql = _sql_in(item_codes)
    pp_sql    = _sql_in(pp_statuses)
    rows = frappe.db.sql(f"""
        SELECT ppi.item_code, COUNT(DISTINCT pp.name) AS cnt
        FROM `tabProduction Plan Item` ppi
        JOIN `tabProduction Plan` pp ON pp.name = ppi.parent
        WHERE pp.docstatus = 1
          AND pp.status IN {pp_sql}
          AND ppi.item_code IN {codes_sql}
        GROUP BY ppi.item_code
    """, as_dict=True)
    return {r.item_code: cint(r.cnt) for r in rows}


def _get_stock(item_codes, warehouses, stock_mode="physical"):
    """
    Returns {item_code: qty} for current stock.
    stock_mode='physical'  → actual_qty only
    stock_mode='expected'  → actual_qty + ordered_qty + planned_qty
    """
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    wh_clause = ""
    if warehouses:
        wh_sql    = _sql_in(warehouses)
        wh_clause = f"AND warehouse IN {wh_sql}"

    if stock_mode == "expected":
        qty_expr = "SUM(actual_qty + ordered_qty + planned_qty)"
    else:
        qty_expr = "SUM(actual_qty)"

    rows = frappe.db.sql(f"""
        SELECT item_code, {qty_expr} AS stock
        FROM `tabBin`
        WHERE item_code IN {codes_sql}
          {wh_clause}
        GROUP BY item_code
    """, as_dict=True)
    return {r.item_code: flt(r.stock) for r in rows}


def _get_active_bom(item_codes):
    """Returns {item_code: bom_name} for the active default BOM."""
    if not item_codes:
        return {}
    codes_sql = _sql_in(item_codes)
    rows = frappe.db.sql(f"""
        SELECT item, name AS bom_name
        FROM `tabBOM`
        WHERE item IN {codes_sql}
          AND is_active = 1 AND is_default = 1 AND docstatus = 1
        ORDER BY modified DESC
    """, as_dict=True)
    # one BOM per item (first match wins)
    result = {}
    for r in rows:
        if r.item not in result:
            result[r.item] = r.bom_name
    return result


def _get_shortage_summary(item_codes, bom_map, stock_map):
    """
    Shallow BOM walk — check if any component is short.
    Returns {item_code: {has_shortage: bool, short_components: [...]}}
    """
    result = {}
    for code in item_codes:
        bom = bom_map.get(code, "")
        if not bom:
            result[code] = {"has_shortage": False, "short_components": []}
            continue
        # Shallow: only 1 level to keep it fast for the overview
        components = _bom_one_level(bom)
        short = []
        for comp in components:
            req_qty = flt(comp["qty"])
            in_stk  = flt(stock_map.get(comp["item_code"], 0))
            if in_stk < req_qty:
                short.append({
                    "item_code": comp["item_code"],
                    "required":  req_qty,
                    "in_stock":  in_stk,
                    "shortage":  round(req_qty - in_stk, 3),
                    "uom":       comp["uom"],
                })
        result[code] = {
            "has_shortage":    len(short) > 0,
            "short_components":short[:5],  # top 5 for overview
        }
    return result


def _get_possible_qty(item_codes, bom_map, stock_map):
    """
    For each item with a BOM, compute max producible qty from current stock
    (shallow BOM walk — immediate components only).
    """
    result = {}
    for code in item_codes:
        bom = bom_map.get(code, "")
        if not bom:
            result[code] = 0
            continue
        components = _bom_one_level(bom)
        if not components:
            result[code] = 0
            continue
        max_units = float("inf")
        for comp in components:
            req_per_unit = flt(comp["qty"])
            if req_per_unit <= 0:
                continue
            in_stk = flt(stock_map.get(comp["item_code"], 0))
            supportable = in_stk / req_per_unit
            max_units = min(max_units, supportable)
        result[code] = round(max_units if max_units != float("inf") else 0, 2)
    return result


def _get_cost_summary(item_codes, curr_month, curr_year, bom_map):
    """Lightweight cost summary for display in main table."""
    result = {}
    for code in item_codes:
        bom = bom_map.get(code, "")
        bom_total = 0.0
        if bom:
            row = frappe.db.sql("""
                SELECT SUM(amount) FROM `tabBOM Item` WHERE parent = %s
            """, bom)
            bom_total = flt(row[0][0]) if row else 0

        act_row = frappe.db.sql("""
            SELECT SUM(sed.basic_amount)
            FROM `tabStock Entry Detail` sed
            JOIN `tabStock Entry` se ON se.name = sed.parent
            WHERE se.docstatus = 1
              AND se.stock_entry_type = 'Manufacture'
              AND sed.is_finished_item = 0
              AND MONTH(se.posting_date) = %s
              AND YEAR(se.posting_date) = %s
              AND se.work_order IN (
                  SELECT name FROM `tabWork Order`
                  WHERE production_item = %s AND docstatus = 1
              )
        """, (curr_month, curr_year, code))
        act_total = flt(act_row[0][0]) if act_row else 0

        var_pct = 0
        if bom_total > 0:
            var_pct = round((act_total - bom_total) / bom_total * 100, 1)

        result[code] = {
            "bom_total":    round(bom_total, 2),
            "actual_total": round(act_total, 2),
            "variance_pct": var_pct,
        }
    return result


def _bom_one_level(bom_name):
    """Fetch immediate (1-level) BOM components."""
    if not bom_name:
        return []
    rows = frappe.db.sql("""
        SELECT bi.item_code, bi.item_name, bi.stock_qty AS qty, bi.stock_uom AS uom
        FROM `tabBOM Item` bi
        WHERE bi.parent = %s
          AND bi.parenttype = 'BOM'
        ORDER BY bi.idx
    """, bom_name, as_dict=True)
    return [{
        "item_code": r.item_code,
        "item_name": r.item_name,
        "qty":       flt(r.qty),
        "uom":       r.uom or "Nos",
    } for r in rows]


def _walk_bom_shallow(bom_name, qty_to_produce, warehouses, stock_mode, max_depth=3, depth=0):
    """Recursive BOM walk returning flat component list with shortage info."""
    if not bom_name or depth > max_depth:
        return []
    components = _bom_one_level(bom_name)
    result = []
    all_codes = [c["item_code"] for c in components]
    stock_map  = _get_stock(all_codes, warehouses, stock_mode) if all_codes else {}

    for comp in components:
        required = flt(comp["qty"]) * flt(qty_to_produce)
        in_stk   = flt(stock_map.get(comp["item_code"], 0))
        shortage = max(0, required - in_stk)
        sub_bom  = _get_active_bom([comp["item_code"]]).get(comp["item_code"], "")

        # Determine if this is itself an SFG with sub-components
        sub_comps = []
        if sub_bom and depth < max_depth:
            sub_comps = _walk_bom_shallow(sub_bom, required, warehouses, stock_mode,
                                          max_depth, depth + 1)

        open_docs = _get_open_docs_for_item(comp["item_code"])

        result.append({
            "item_code":  comp["item_code"],
            "item_name":  comp["item_name"],
            "uom":        comp["uom"],
            "required":   round(required, 3),
            "in_stock":   round(in_stk, 3),
            "shortage":   round(shortage, 3),
            "open_docs":  open_docs,
            "sub_comps":  sub_comps,
            "depth":      depth,
        })
    return result


def _walk_bom_deep(bom_name, qty_to_produce, warehouses, stock_mode, depth=0, max_depth=4):
    """Full BOM walk for shortage detail modal."""
    return _walk_bom_shallow(bom_name, qty_to_produce, warehouses, stock_mode,
                              max_depth=max_depth, depth=depth)


def _get_open_docs_for_item(item_code):
    """Returns open POs and MRs for a component item (for stage badge)."""
    docs = []
    # Open POs
    po_rows = frappe.db.sql("""
        SELECT poi.parent AS doc, 'Purchase Order' AS type,
               poi.qty, poi.received_qty, poi.uom
        FROM `tabPurchase Order Item` poi
        JOIN `tabPurchase Order` po ON po.name = poi.parent
        WHERE po.docstatus = 1
          AND po.status IN ('To Receive and Bill', 'To Receive', 'Partially Received')
          AND poi.item_code = %s
        LIMIT 5
    """, item_code, as_dict=True)
    docs.extend([{
        "type": "Purchase Order",
        "name": r.doc,
        "qty":  flt(r.qty),
        "received": flt(r.received_qty),
        "uom":  r.uom,
    } for r in po_rows])

    # Open MRs
    mr_rows = frappe.db.sql("""
        SELECT mri.parent AS doc, mri.qty, mri.uom
        FROM `tabMaterial Request Item` mri
        JOIN `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE mr.docstatus = 1
          AND mr.status IN ('Submitted', 'Partially Ordered')
          AND mri.item_code = %s
        LIMIT 5
    """, item_code, as_dict=True)
    docs.extend([{
        "type": "Material Request",
        "name": r.doc,
        "qty":  flt(r.qty),
        "uom":  r.uom,
    } for r in mr_rows])

    return docs


def _get_batch_consumption(wo_name):
    """Return batch-level consumption detail for a Work Order."""
    rows = frappe.db.sql("""
        SELECT sed.item_code, sed.item_name, sed.batch_no,
               SUM(sed.qty) AS qty, sed.uom, AVG(sed.valuation_rate) AS rate
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type IN ('Manufacture', 'Material Transfer for Manufacture')
          AND se.work_order = %s
          AND sed.is_finished_item = 0
        GROUP BY sed.item_code, sed.batch_no, sed.uom
        ORDER BY sed.item_code, sed.batch_no
    """, wo_name, as_dict=True)
    return [{
        "item_code": r.item_code,
        "item_name": r.item_name,
        "batch_no":  r.batch_no or "—",
        "qty":       flt(r.qty),
        "uom":       r.uom,
        "rate":      flt(r.rate),
        "amount":    round(flt(r.qty) * flt(r.rate), 2),
    } for r in rows]


def _get_sub_assembly_wos(production_plan_name):
    """Return child Work Orders linked via Production Plan."""
    if not production_plan_name:
        return []
    # NOTE: Work Order column is `qty`; aliased to `qty_to_manufacture` for clarity.
    rows = frappe.db.sql("""
        SELECT name, production_item, qty AS qty_to_manufacture, status, produced_qty
        FROM `tabWork Order`
        WHERE production_plan = %s AND docstatus = 1
        LIMIT 10
    """, production_plan_name, as_dict=True)
    return [{
        "wo_name":           r.name,
        "production_item":   r.production_item,
        "qty_to_manufacture":flt(r.qty_to_manufacture),
        "status":            r.status,
        "produced_qty":      flt(r.produced_qty),
    } for r in rows]


def _get_valuation_rate(item_code):
    """Get current valuation rate for an item (for sorting shortages by value)."""
    return flt(frappe.db.get_value("Item", item_code, "standard_rate") or 0)


def _classify_item_type(item_row, is_sub_assembly):
    """Classify item as FG, SFG, RM, PM, or Other."""
    if cint(item_row.auto_manufacture):
        return "SFG" if is_sub_assembly else "FG"
    if cint(item_row.is_purchase_item):
        if "packaging" in (item_row.item_group or "").lower():
            return "PM"
        return "RM"
    return "Other"
