"""
wo_kitting_api.py -- WO Kitting Planner Backend API
=====================================================
Simulation engine for Work Order kitting feasibility.

Covers ALL open Work Orders (Not Started / In Process / Material Transferred),
regardless of whether items are TOC-enabled. This is a production planning tool,
not restricted to TOC buffer-managed items.

PUBLIC API (all @frappe.whitelist())
-------------------------------------
  get_open_work_orders(status_filter=None)
      Returns list of open WOs sorted by planned_start_date.

  simulate_kitting(work_orders_json, stock_mode, calc_mode, multi_level)
      Main simulation engine. Returns one row per WO with shortage detail.

  create_purchase_mr_for_wo_shortages(items_json, company)
      One-click: creates a Purchase MR for all shortage BOM components.

  get_dispatch_bottleneck(item_codes_json)
      FG stock vs customer order comparison per production item.

  chat_with_planner(message, session_id, context_json)
      AI chat: DeepSeek-powered advisor with session memory and function calling.

  get_ai_auto_insight(context_json)
      Stateless AI briefing: called once after each simulation to summarise situation.

SIMULATION MODES
-----------------
  stock_mode = "current_only":
      Stock pool = physical Bin.actual_qty per item.

  stock_mode = "current_and_expected":
      Stock pool = Bin.actual_qty
                 + open PO remaining qty (ordered - received)
                 + open Purchase MR remaining qty (not yet PO'd)
                 + open WO expected output (qty - produced_qty) for sub-assemblies

  calc_mode = "isolated" (Scenario A):
      Each WO evaluated against the FULL stock pool independently.
      Order does not matter; no stock is consumed between WOs.

  calc_mode = "sequential" (Scenario B):
      WOs processed in the given order (user-defined via drag-drop in UI).
      If a WO is fully feasible (kit_status="ok"), its required component
      quantities are DEDUCTED from the pool before the next WO is evaluated.
      Blocked/partial WOs do NOT consume stock (they cannot start, so stock
      remains available for lower-priority WOs that might still be feasible).

MULTI-LEVEL BOM
---------------
  multi_level = 0 (default): Use direct BOM items only (single level).
      Fast. Sub-assemblies (SFGs) appear as components; their internal
      RM/PM structure is not expanded.

  multi_level = 1: Recursively explode sub-assemblies into leaf RM/PM items.
      Slower but gives a true RM/PM footprint. Uses up to 6 levels of recursion.
      Duplicate RM/PM items across paths are merged (qty summed).

ROW RESULT SCHEMA (one per WO)
--------------------------------
  wo               str   Work Order name
  item_code        str   Production item code
  item_name        str   Production item name
  bom_no           str   BOM used for simulation
  status           str   ERPNext WO status
  planned_qty      float WO planned quantity
  produced_qty     float Already produced
  remaining_qty    float planned_qty - produced_qty (what still needs producing)
  uom              str   Stock UOM of production item
  planned_start_date str
  est_cost         float valuation_rate * remaining_qty (rough cost estimate)
  kit_status       str   "ok" | "partial" | "block" | "kitted"
  shortage_count   int   Number of BOM components with shortage
  shortage_value   float Total INR value of all shortages
  prev_month_so    float Pending SO qty (delivery_date in previous month)
  curr_month_so    float Pending SO qty (delivery_date in current month)
  total_pending_so float prev_month_so + curr_month_so
  shortage_items   list  [{item_code, item_name, uom, required, available,
                            shortage, shortage_value, stage, stage_color}]

PERFORMANCE NOTES
-----------------
- BOM items are fetched in a single bulk SQL (all BOMs at once).
- Stock pool is built in 1-4 queries (physical + optional PO/MR/WO).
- Stage classification (In Stock / In Production / PO Raised / MR Raised / Short)
  uses 3 batch queries across all shortage items (not per-item N+1 queries).
- For large installations (100+ WOs), multi_level=0 is strongly recommended
  to keep simulation time under 2 seconds.

Called by: chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js
"""

import calendar
import json
from datetime import date

import frappe
import requests as _requests
from frappe.utils import add_days, cint, flt, today


# ═══════════════════════════════════════════════════════════════════════
#  AI ADVISOR CONFIGURATION
#  ══════════════════════════════════════════════════════════════════════
#  🔑 SET YOUR DEEPSEEK API KEY HERE
#     Get a key from: https://platform.deepseek.com/api_keys
#     The key starts with "sk-"
#
#  ⚠️  DO NOT commit the real key to git. For production, store it in
#     TOC Settings (custom field) or as an environment variable.
#     This file-level constant is for development convenience only.
#
#  FALLBACK HIERARCHY (first non-empty wins):
#    1. DEEPSEEK_API_KEY constant below (edit this for dev)
#    2. frappe.conf.deepseek_api_key  (set in site_config.json)
#    3. TOC Settings → custom_deepseek_api_key field
# ═══════════════════════════════════════════════════════════════════════

DEEPSEEK_API_KEY  = "YOUR_DEEPSEEK_API_KEY_HERE"  # <-- SET THIS
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL    = "deepseek-chat"  # DeepSeek-V3: best cost/quality

# Chat session TTL in Redis cache (seconds). 2 hours.
_AI_SESSION_TTL = 7200

# Max messages to keep per session (older messages pruned to save tokens)
_AI_MAX_HISTORY = 14  # 7 exchanges

# Function-call guard: max tool calls per response to prevent loops
_AI_MAX_TOOL_CALLS = 3


# ═══════════════════════════════════════════════════════════════════════
#  PUBLIC API
# ═══════════════════════════════════════════════════════════════════════

@frappe.whitelist()
def get_open_work_orders(status_filter=None):
    """
    Fetch all open Work Orders for the planner.

    Args:
        status_filter (str, optional):
            Narrow to a specific ERPNext WO status.
            Accepted values: "Not Started", "In Process", "Material Transferred"
            Omit or pass "" to fetch all open statuses.

    Returns:
        list of dict with keys:
            name, production_item, item_name, bom_no, qty, produced_qty,
            remaining_qty, planned_start_date, status, company, stock_uom
    """
    filters = [
        ["docstatus", "=", 1],
        ["status", "not in", ["Completed", "Stopped", "Cancelled"]],
    ]
    if status_filter:
        filters.append(["status", "=", status_filter])

    wos = frappe.get_all(
        "Work Order",
        filters=filters,
        fields=[
            "name", "production_item", "bom_no", "qty", "produced_qty",
            "planned_start_date", "planned_end_date", "status", "company",
        ],
        order_by="planned_start_date asc, creation asc",
        ignore_permissions=True,
    )

    if not wos:
        return []

    # Batch-fetch item names + uom + valuation_rate
    item_codes = list({w.production_item for w in wos})
    item_meta = {
        r.name: r
        for r in frappe.get_all(
            "Item",
            filters={"name": ["in", item_codes]},
            fields=["name", "item_name", "stock_uom", "valuation_rate"],
        )
    }

    result = []
    for wo in wos:
        meta = item_meta.get(wo.production_item) or {}
        remaining = flt(wo.qty) - flt(wo.produced_qty)
        result.append({
            "name"              : wo.name,
            "production_item"   : wo.production_item,
            "item_name"         : meta.get("item_name", wo.production_item),
            "stock_uom"         : meta.get("stock_uom", ""),
            "valuation_rate"    : flt(meta.get("valuation_rate", 0)),
            "bom_no"            : wo.bom_no or "",
            "qty"               : flt(wo.qty),
            "produced_qty"      : flt(wo.produced_qty),
            "remaining_qty"     : remaining,
            "planned_start_date": str(wo.planned_start_date or ""),
            "status"            : wo.status,
            "company"           : wo.company,
        })

    return result


@frappe.whitelist()
def simulate_kitting(work_orders_json, stock_mode="current_only",
                     calc_mode="isolated", multi_level=0):
    """
    Main kitting simulation endpoint.

    Args:
        work_orders_json (str): JSON list of WO names in priority order.
            Order matters for calc_mode="sequential".
        stock_mode (str): "current_only" or "current_and_expected"
        calc_mode (str): "isolated" or "sequential"
        multi_level (int|str): 0 = single-level BOM, 1 = multi-level explosion

    Returns:
        list of row dicts (see module docstring for schema)
    """
    wo_names = (
        json.loads(work_orders_json)
        if isinstance(work_orders_json, str)
        else work_orders_json
    ) or []

    if not wo_names:
        return []

    multi_level = cint(multi_level)

    # ── Step 1: WO details ──────────────────────────────────────────────
    wos = _get_wo_details(wo_names)
    if not wos:
        return []

    # ── Step 2: BOM items for all BOMs ─────────────────────────────────
    bom_nos = list({w["bom_no"] for w in wos if w.get("bom_no")})
    bom_items = _get_bom_items_bulk(bom_nos, multi_level=multi_level)

    # ── Step 3: Stock pool ──────────────────────────────────────────────
    # Collect every component item code across all BOMs
    all_comp_codes = list({
        comp["item_code"]
        for bom_comps in bom_items.values()
        for comp in bom_comps
    })
    stock_pool = _build_stock_pool(stock_mode, all_comp_codes)

    # ── Step 4: Dispatch info (Sales Orders) ────────────────────────────
    wo_item_codes = list({w["production_item"] for w in wos})
    dispatch_map  = _get_dispatch_info(wo_item_codes)

    # ── Step 4.5: Supply detail (PO/MR qty per component for display) ───
    supply_detail = _build_supply_detail(all_comp_codes)

    # ── Step 4.6: Consumption data (Stock Entries per WO) ───────────────
    consumed_map  = _get_consumed_by_wo(wo_names)

    # ── Step 5: Simulate ────────────────────────────────────────────────
    if calc_mode == "sequential":
        results = _simulate_sequential(wos, stock_pool, bom_items, dispatch_map)
    else:
        results = _simulate_isolated(wos, stock_pool, bom_items, dispatch_map)

    # ── Step 6: Overlay supply detail + consumed qty on each component ──
    # Build item_group lookup from wos list
    ig_map = {w["name"]: w.get("item_group", "") for w in wos}

    for row in results:
        row["item_group"] = ig_map.get(row["wo"], "")
        wo_consumed = consumed_map.get(row["wo"], {})
        for comp in row.get("shortage_items", []):
            ic  = comp["item_code"]
            sd  = supply_detail.get(ic, {})
            comp["po_qty"]       = flt(sd.get("po_qty", 0))
            comp["mr_qty"]       = flt(sd.get("mr_qty", 0))
            comp["consumed_qty"] = round(flt(wo_consumed.get(ic, 0)), 4)

    return results


@frappe.whitelist()
def create_purchase_mr_for_wo_shortages(items_json, company):
    """
    One-click: Create a single Purchase Material Request covering all shortage items.

    Args:
        items_json (str): JSON list of {item_code, shortage_qty, uom, warehouse}
        company (str): Company name for the MR

    Returns:
        {"status": "success", "mr": "<MR name>", "items_count": N}
    """
    frappe.only_for([
        "System Manager", "TOC Manager", "Stock Manager",
        "Purchase Manager", "Manufacturing Manager",
    ])

    items = (
        frappe.parse_json(items_json)
        if isinstance(items_json, str)
        else items_json
    ) or []

    items = [i for i in items if flt(i.get("shortage_qty", 0)) > 0]
    if not items:
        frappe.throw("No shortage items to create a Material Request for.")

    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    mr.company               = company
    mr.transaction_date      = today()
    mr.schedule_date         = add_days(today(), 7)

    for it in items:
        uom = (
            it.get("uom")
            or frappe.db.get_value("Item", it["item_code"], "stock_uom")
            or "Nos"
        )
        mr.append("items", {
            "item_code"    : it["item_code"],
            "qty"          : flt(it["shortage_qty"]),
            "uom"          : uom,
            "warehouse"    : it.get("warehouse") or "",
            "schedule_date": add_days(today(), 7),
        })

    mr.flags.ignore_permissions = True
    mr.insert()
    frappe.db.commit()
    return {"status": "success", "mr": mr.name, "items_count": len(items)}


# ═══════════════════════════════════════════════════════════════════════
#  WO DETAIL FETCH
# ═══════════════════════════════════════════════════════════════════════

def _get_wo_details(wo_names):
    """
    Fetch full WO detail rows in one JOIN query.

    Preserves the caller-specified order (crucial for Scenario B sequential simulation).
    """
    if not wo_names:
        return []

    rows = frappe.db.sql("""
        SELECT wo.name,
               wo.production_item,
               wo.bom_no,
               wo.qty,
               wo.produced_qty,
               wo.planned_start_date,
               wo.status,
               wo.company,
               i.item_name,
               i.item_group,
               i.stock_uom,
               i.valuation_rate
        FROM   `tabWork Order` wo
        JOIN   `tabItem` i ON i.name = wo.production_item
        WHERE  wo.name IN %(names)s
    """, {"names": wo_names}, as_dict=True)

    row_map = {r.name: dict(r) for r in rows}

    ordered = []
    for name in wo_names:
        r = row_map.get(name)
        if not r:
            continue
        r["remaining_qty"] = flt(r["qty"]) - flt(r["produced_qty"])
        ordered.append(r)

    return ordered


# ═══════════════════════════════════════════════════════════════════════
#  BOM ITEMS
# ═══════════════════════════════════════════════════════════════════════

def _get_bom_items_bulk(bom_nos, multi_level=0):
    """
    Fetch BOM components for all given BOM nos in a single SQL query.

    Formula for per_unit_qty:
        per_unit_qty = BOM Item.stock_qty / BOM.quantity
        (stock_qty is already in stock UOM; BOM.quantity = batch output size)

    For example: BOM produces 100 kg; one component needs 5 kg in BOM.
        per_unit_qty = 5 / 100 = 0.05 kg per finished unit.

    Required for WO with remaining_qty = 80:
        required = 0.05 * 80 = 4.0 kg

    Args:
        bom_nos: list of BOM names
        multi_level: 0 = single-level only; 1 = recursive explosion

    Returns:
        dict: {bom_no: [{item_code, item_name, per_unit_qty, uom, valuation_rate}]}
    """
    if not bom_nos:
        return {}

    bom_nos = list(set(bom_nos))

    rows = frappe.db.sql("""
        SELECT bi.parent          AS bom_no,
               bi.item_code,
               bi.item_name,
               bi.stock_qty,
               bi.stock_uom       AS uom,
               b.quantity          AS bom_qty,
               COALESCE(i.valuation_rate, 0) AS valuation_rate
        FROM   `tabBOM Item` bi
        JOIN   `tabBOM` b       ON b.name = bi.parent
        LEFT JOIN `tabItem` i   ON i.name = bi.item_code
        WHERE  bi.parent      IN %(boms)s
          AND  bi.parenttype  = 'BOM'
          AND  b.docstatus    = 1
        ORDER BY bi.parent, bi.idx
    """, {"boms": bom_nos}, as_dict=True)

    result = {}
    for r in rows:
        bom = r.bom_no
        if bom not in result:
            result[bom] = []
        bom_qty  = flt(r.bom_qty) or 1.0
        per_unit = flt(r.stock_qty) / bom_qty
        result[bom].append({
            "item_code"     : r.item_code,
            "item_name"     : r.item_name or r.item_code,
            "per_unit_qty"  : per_unit,
            "uom"           : r.uom or "Nos",
            "valuation_rate": flt(r.valuation_rate),
        })

    if multi_level:
        result = _explode_multi_level(result)

    return result


def _explode_multi_level(bom_map, max_depth=6):
    """
    Recursively expand sub-assembly components into their RM/PM constituents.

    Algorithm:
    1. Find all component item_codes in the current bom_map.
    2. Query which of those have their own active BOM (= sub-assemblies).
    3. Fetch those sub-BOMs.
    4. For each top-level BOM: replace any sub-assembly component with its
       sub-BOM items (scaled by per_unit_qty). Recurse up to max_depth times.
    5. Merge duplicate item_codes (sum their per_unit_qty).

    Note: Items with no active BOM are treated as leaves (RM/PM) regardless.
    """
    depth = 0
    while depth < max_depth:
        depth += 1

        # Find all component codes currently in the map
        all_comp_codes = {
            comp["item_code"]
            for comps in bom_map.values()
            for comp in comps
        }

        if not all_comp_codes:
            break

        # Which of those have an active BOM? (= sub-assemblies)
        sub_bom_rows = frappe.db.sql("""
            SELECT item, name
            FROM   `tabBOM`
            WHERE  item     IN %(items)s
              AND  is_active = 1
              AND  docstatus = 1
            ORDER BY creation DESC
        """, {"items": list(all_comp_codes)}, as_dict=True)

        # Keep only the newest active BOM per item
        sub_bom_for_item = {}
        for row in sub_bom_rows:
            if row.item not in sub_bom_for_item:
                sub_bom_for_item[row.item] = row.name

        if not sub_bom_for_item:
            break  # No sub-assemblies left — we are at leaves

        # Fetch those sub-BOMs (single-level, not recursive to avoid infinite loops)
        sub_bom_names = list(set(sub_bom_for_item.values()))
        sub_boms = _get_bom_items_bulk(sub_bom_names, multi_level=0)

        # Any sub-BOM whose items are all already known (non-sub-assembly) is a leaf
        expanded_any = False

        new_map = {}
        for top_bom, comps in bom_map.items():
            flat = []
            for comp in comps:
                sub_bom_name = sub_bom_for_item.get(comp["item_code"])
                if sub_bom_name and sub_bom_name in sub_boms:
                    # Replace this sub-assembly with its constituents (scaled)
                    scale = comp["per_unit_qty"]
                    for sub_comp in sub_boms[sub_bom_name]:
                        flat.append({
                            "item_code"     : sub_comp["item_code"],
                            "item_name"     : sub_comp["item_name"],
                            "per_unit_qty"  : sub_comp["per_unit_qty"] * scale,
                            "uom"           : sub_comp["uom"],
                            "valuation_rate": sub_comp["valuation_rate"],
                        })
                    expanded_any = True
                else:
                    flat.append(comp)

            # Merge duplicates (same item_code from multiple paths)
            merged = {}
            for comp in flat:
                ic = comp["item_code"]
                if ic in merged:
                    merged[ic]["per_unit_qty"] += comp["per_unit_qty"]
                else:
                    merged[ic] = dict(comp)

            new_map[top_bom] = list(merged.values())

        bom_map = new_map

        if not expanded_any:
            break  # Nothing changed — all assemblies already expanded

    return bom_map


# ═══════════════════════════════════════════════════════════════════════
#  STOCK POOL
# ═══════════════════════════════════════════════════════════════════════

def _build_stock_pool(stock_mode, item_codes):
    """
    Build the available qty map per item code.

    X (current_only):
        Physical Bin.actual_qty only.

    Y (current_and_expected):
        Bin.actual_qty
        + open PO remaining qty (ordered_qty - received_qty)
        + open Purchase MR remaining qty (qty - ordered_qty, not yet converted to PO)
        + open WO expected output (qty - produced_qty) for sub-assembly items

    Returns:
        dict: {item_code: available_qty}
    """
    if not item_codes:
        return {}

    # ── Base: physical Bin stock ────────────────────────────────────────
    rows = frappe.db.sql("""
        SELECT item_code, SUM(actual_qty) AS qty
        FROM   `tabBin`
        WHERE  item_code IN %(items)s
        GROUP BY item_code
    """, {"items": item_codes}, as_dict=True)

    pool = {r.item_code: flt(r.qty) for r in rows}
    # Ensure all item_codes have an entry (default 0)
    for ic in item_codes:
        pool.setdefault(ic, 0.0)

    if stock_mode != "current_and_expected":
        return pool

    # ── Open PO remaining ───────────────────────────────────────────────
    po_rows = frappe.db.sql("""
        SELECT poi.item_code,
               SUM(poi.qty - COALESCE(poi.received_qty, 0)) AS expected
        FROM   `tabPurchase Order Item` poi
        JOIN   `tabPurchase Order` po ON po.name = poi.parent
        WHERE  poi.item_code IN %(items)s
          AND  po.docstatus = 1
          AND  po.status NOT IN ('Closed', 'Cancelled')
          AND  (poi.qty - COALESCE(poi.received_qty, 0)) > 0
        GROUP BY poi.item_code
    """, {"items": item_codes}, as_dict=True)

    for r in po_rows:
        pool[r.item_code] = pool.get(r.item_code, 0) + flt(r.expected)

    # ── Open Purchase MR (not yet converted to PO) ──────────────────────
    mr_rows = frappe.db.sql("""
        SELECT mri.item_code,
               SUM(mri.qty - COALESCE(mri.ordered_qty, 0)) AS expected
        FROM   `tabMaterial Request Item` mri
        JOIN   `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE  mri.item_code IN %(items)s
          AND  mr.docstatus = 1
          AND  mr.material_request_type = 'Purchase'
          AND  mr.status NOT IN ('Cancelled', 'Stopped', 'Ordered')
          AND  (mri.qty - COALESCE(mri.ordered_qty, 0)) > 0
        GROUP BY mri.item_code
    """, {"items": item_codes}, as_dict=True)

    for r in mr_rows:
        pool[r.item_code] = pool.get(r.item_code, 0) + flt(r.expected)

    # ── Open WO expected output (sub-assembly WOs) ──────────────────────
    wo_rows = frappe.db.sql("""
        SELECT production_item                                 AS item_code,
               SUM(qty - COALESCE(produced_qty, 0))           AS expected
        FROM   `tabWork Order`
        WHERE  production_item IN %(items)s
          AND  docstatus = 1
          AND  status NOT IN ('Completed', 'Stopped', 'Cancelled')
        GROUP BY production_item
    """, {"items": item_codes}, as_dict=True)

    for r in wo_rows:
        pool[r.item_code] = pool.get(r.item_code, 0) + flt(r.expected)

    return pool


# ═══════════════════════════════════════════════════════════════════════
#  SIMULATION ENGINES
# ═══════════════════════════════════════════════════════════════════════

def _simulate_isolated(wos, stock_pool, bom_items, dispatch_map):
    """
    Scenario A: Isolated simulation.

    Each WO is evaluated against the FULL stock pool.
    No stock is consumed between WOs. Order is irrelevant.
    """
    # Pre-compute requirements and shortages for all WOs
    wo_reqs = []
    for wo in wos:
        comps = _compute_requirements(wo, stock_pool, bom_items)
        wo_reqs.append((wo, comps))

    # Batch stage classification for all shortage items
    all_short_codes = list({
        c["item_code"]
        for _, comps in wo_reqs
        for c in comps
        if c["shortage"] > 0
    })
    stage_map = _batch_stage_check(all_short_codes)

    # Assemble final result rows
    results = []
    for wo, comps in wo_reqs:
        row = _assemble_result(wo, comps, stage_map, dispatch_map)
        results.append(row)

    return results


def _simulate_sequential(wos, stock_pool, bom_items, dispatch_map):
    """
    Scenario B: Sequential simulation.

    WOs are processed in given priority order.
    If a WO is fully feasible (all components available), its required
    component quantities are DEDUCTED from the mutable pool before
    the next WO is evaluated.

    Blocked or partial WOs do NOT consume stock — they cannot start,
    so their stock remains available for lower-priority WOs.
    """
    pool = dict(stock_pool)  # Mutable copy

    # First pass: compute requirements with evolving pool
    wo_reqs = []
    for wo in wos:
        comps = _compute_requirements(wo, pool, bom_items)
        # Count shortages using this iteration's pool snapshot
        short_count = sum(1 for c in comps if c["shortage"] > 0)

        if short_count == 0:
            # Fully feasible — deduct from pool
            for comp in comps:
                pool[comp["item_code"]] = max(
                    0.0,
                    flt(pool.get(comp["item_code"], 0)) - comp["required"]
                )

        wo_reqs.append((wo, comps))

    # Batch stage check
    all_short_codes = list({
        c["item_code"]
        for _, comps in wo_reqs
        for c in comps
        if c["shortage"] > 0
    })
    stage_map = _batch_stage_check(all_short_codes)

    # Assemble results
    results = []
    for wo, comps in wo_reqs:
        row = _assemble_result(wo, comps, stage_map, dispatch_map)
        results.append(row)

    return results


# ═══════════════════════════════════════════════════════════════════════
#  REQUIREMENT COMPUTATION (per WO)
# ═══════════════════════════════════════════════════════════════════════

def _compute_requirements(wo, stock_pool, bom_items):
    """
    Compute required vs available vs shortage for each BOM component.

    Uses the given stock_pool snapshot (may be a shrinking pool in Scenario B).

    Returns:
        list of component dicts with required, available, shortage computed.
        Returns empty list if WO is already completed or has no BOM.
    """
    remaining = flt(wo.get("remaining_qty", 0))
    bom_no    = wo.get("bom_no", "")

    if remaining <= 0:
        return []  # Already produced — mark as kitted

    if not bom_no or bom_no not in bom_items:
        return []  # No BOM — cannot simulate

    comps_template = bom_items[bom_no]
    result = []

    for comp in comps_template:
        required  = comp["per_unit_qty"] * remaining
        available = flt(stock_pool.get(comp["item_code"], 0))
        shortage  = round(max(0.0, required - available), 4)
        shortage_value = round(shortage * flt(comp.get("valuation_rate", 0)), 2)

        result.append({
            "item_code"     : comp["item_code"],
            "item_name"     : comp["item_name"],
            "uom"           : comp["uom"],
            "required"      : round(required, 4),
            "available"     : round(available, 4),
            "shortage"      : shortage,
            "shortage_value": shortage_value,
            # stage and stage_color filled later by _batch_stage_check
            "stage"         : "In Stock",
            "stage_color"   : "green",
        })

    return result


# ═══════════════════════════════════════════════════════════════════════
#  BATCH STAGE CLASSIFICATION
# ═══════════════════════════════════════════════════════════════════════

def _batch_stage_check(item_codes):
    """
    For each item code with a shortage, determine which supply stage it is in.

    Priority:
        In Stock     (shortage == 0, handled before calling this)
        In Production (open WO exists for this item)
        PO Raised    (open Purchase Order exists)
        MR Raised    (open Material Request exists, not yet ordered)
        Short        (no supply action in motion)

    Uses 3 queries total (not N queries per item).

    Returns:
        dict: {item_code: {"stage": str, "stage_color": str}}
    """
    if not item_codes:
        return {}

    stage_map = {ic: {"stage": "Short", "stage_color": "red"} for ic in item_codes}

    # ── Items with open Material Requests ──────────────────────────────
    mr_rows = frappe.db.sql("""
        SELECT DISTINCT mri.item_code
        FROM   `tabMaterial Request Item` mri
        JOIN   `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE  mri.item_code IN %(items)s
          AND  mr.docstatus < 2
          AND  mr.status NOT IN ('Cancelled', 'Stopped')
    """, {"items": item_codes}, as_dict=True)

    for r in mr_rows:
        stage_map[r.item_code] = {"stage": "MR Raised", "stage_color": "orange"}

    # ── Items with open Purchase Orders (overrides MR) ──────────────────
    po_rows = frappe.db.sql("""
        SELECT DISTINCT poi.item_code
        FROM   `tabPurchase Order Item` poi
        JOIN   `tabPurchase Order` po ON po.name = poi.parent
        WHERE  poi.item_code IN %(items)s
          AND  po.docstatus = 1
          AND  po.status NOT IN ('Closed', 'Cancelled')
    """, {"items": item_codes}, as_dict=True)

    for r in po_rows:
        stage_map[r.item_code] = {"stage": "PO Raised", "stage_color": "teal"}

    # ── Items with open Work Orders (overrides PO) ──────────────────────
    wo_rows = frappe.db.sql("""
        SELECT DISTINCT production_item AS item_code
        FROM   `tabWork Order`
        WHERE  production_item IN %(items)s
          AND  docstatus = 1
          AND  status NOT IN ('Completed', 'Stopped', 'Cancelled')
    """, {"items": item_codes}, as_dict=True)

    for r in wo_rows:
        stage_map[r.item_code] = {"stage": "In Production", "stage_color": "blue"}

    return stage_map


# ═══════════════════════════════════════════════════════════════════════
#  RESULT ASSEMBLY
# ═══════════════════════════════════════════════════════════════════════

def _assemble_result(wo, comps, stage_map, dispatch_map):
    """
    Combine WO metadata, computed component requirements, supply stages,
    and dispatch info into the final row dict returned to the frontend.

    kit_status logic:
        "kitted"  — remaining_qty <= 0 (already produced)
        "ok"      — no shortage on any component
        "partial" — some but not all components are short
        "block"   — all components are short (or no BOM)
    """
    remaining  = flt(wo.get("remaining_qty", 0))
    item_code  = wo.get("production_item", "")
    disp       = dispatch_map.get(item_code, {})
    prev_so    = flt(disp.get("prev_month", 0))
    curr_so    = flt(disp.get("curr_month", 0))
    val_rate   = flt(wo.get("valuation_rate", 0))
    est_cost   = round(val_rate * remaining, 2) if val_rate else 0.0

    base = {
        "wo"               : wo["name"],
        "item_code"        : item_code,
        "item_name"        : wo.get("item_name", item_code),
        "item_group"       : wo.get("item_group", ""),
        "bom_no"           : wo.get("bom_no", ""),
        "status"           : wo.get("status", ""),
        "planned_qty"      : flt(wo.get("qty", 0)),
        "produced_qty"     : flt(wo.get("produced_qty", 0)),
        "remaining_qty"    : remaining,
        "uom"              : wo.get("stock_uom", ""),
        "planned_start_date": str(wo.get("planned_start_date") or ""),
        "est_cost"         : est_cost,
        "prev_month_so"    : prev_so,
        "curr_month_so"    : curr_so,
        "total_pending_so" : prev_so + curr_so,
    }

    # Already fully produced
    if remaining <= 0:
        return {**base, "kit_status": "kitted",
                "shortage_count": 0, "shortage_value": 0.0, "shortage_items": []}

    # No BOM or no components fetched
    if not comps:
        return {**base, "kit_status": "block",
                "shortage_count": 0, "shortage_value": 0.0, "shortage_items": [],
                "note": "No active BOM or BOM has no items"}

    # Apply stage info to each component
    shortage_items   = []
    total_short_val  = 0.0
    short_count      = 0

    for comp in comps:
        is_short = comp["shortage"] > 0
        if is_short:
            short_count += 1
            total_short_val += comp["shortage_value"]
            stage_info = stage_map.get(comp["item_code"],
                                       {"stage": "Short", "stage_color": "red"})
        else:
            stage_info = {"stage": "In Stock", "stage_color": "green"}

        shortage_items.append({
            "item_code"     : comp["item_code"],
            "item_name"     : comp["item_name"],
            "uom"           : comp["uom"],
            "required"      : comp["required"],
            "available"     : comp["available"],
            "shortage"      : comp["shortage"],
            "shortage_value": comp["shortage_value"],
            "stage"         : stage_info["stage"],
            "stage_color"   : stage_info["stage_color"],
        })

    total_comps = len(comps)
    if short_count == 0:
        kit_status = "ok"
    elif short_count == total_comps:
        kit_status = "block"
    else:
        kit_status = "partial"

    return {
        **base,
        "kit_status"    : kit_status,
        "shortage_count": short_count,
        "shortage_value": round(total_short_val, 2),
        "shortage_items": shortage_items,
    }


# ═══════════════════════════════════════════════════════════════════════
#  SUPPLY DETAIL (PO / MR open quantities per component)
# ═══════════════════════════════════════════════════════════════════════

def _build_supply_detail(item_codes):
    """
    For each BOM component item code, return the total open PO and MR quantities
    that have been raised but not yet received/fulfilled.

    This is DISPLAY-ONLY — it is overlaid on each shortage_item in simulate_kitting
    so the user can see what procurement is already in motion.

    Differs from _build_stock_pool:
        _build_stock_pool  — adds PO/MR qty to the AVAILABLE pool (Stock mode Y)
        _build_supply_detail — always returns the raw PO/MR figures (both modes)

    Returns:
        dict: {item_code: {"po_qty": float, "mr_qty": float}}
    """
    if not item_codes:
        return {}

    detail = {ic: {"po_qty": 0.0, "mr_qty": 0.0} for ic in item_codes}

    # Open PO remaining qty per item
    po_rows = frappe.db.sql("""
        SELECT poi.item_code,
               SUM(poi.qty - COALESCE(poi.received_qty, 0)) AS qty
        FROM   `tabPurchase Order Item` poi
        JOIN   `tabPurchase Order` po ON po.name = poi.parent
        WHERE  poi.item_code IN %(items)s
          AND  po.docstatus = 1
          AND  po.status NOT IN ('Closed', 'Cancelled')
          AND  (poi.qty - COALESCE(poi.received_qty, 0)) > 0
        GROUP BY poi.item_code
    """, {"items": item_codes}, as_dict=True)

    for r in po_rows:
        detail[r.item_code]["po_qty"] = flt(r.qty)

    # Open Purchase MR remaining qty (not yet converted to PO)
    mr_rows = frappe.db.sql("""
        SELECT mri.item_code,
               SUM(mri.qty - COALESCE(mri.ordered_qty, 0)) AS qty
        FROM   `tabMaterial Request Item` mri
        JOIN   `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE  mri.item_code IN %(items)s
          AND  mr.docstatus = 1
          AND  mr.material_request_type = 'Purchase'
          AND  mr.status NOT IN ('Cancelled', 'Stopped', 'Ordered')
          AND  (mri.qty - COALESCE(mri.ordered_qty, 0)) > 0
        GROUP BY mri.item_code
    """, {"items": item_codes}, as_dict=True)

    for r in mr_rows:
        detail[r.item_code]["mr_qty"] = flt(r.qty)

    return detail


# ═══════════════════════════════════════════════════════════════════════
#  CONSUMPTION DATA (Stock Entries per WO)
# ═══════════════════════════════════════════════════════════════════════

def _get_consumed_by_wo(wo_names):
    """
    Fetch actual material consumption from Stock Entries of type 'Manufacture'
    linked to each Work Order.

    Items with s_warehouse (source warehouse) in a Manufacture entry are
    raw materials being consumed in production.

    Returns:
        dict: {wo_name: {item_code: consumed_qty}}
    """
    if not wo_names:
        return {}

    rows = frappe.db.sql("""
        SELECT  se.work_order,
                sed.item_code,
                SUM(sed.qty) AS consumed_qty
        FROM    `tabStock Entry Detail` sed
        JOIN    `tabStock Entry` se ON se.name = sed.parent
        WHERE   se.work_order IN %(wos)s
          AND   se.docstatus   = 1
          AND   se.purpose     = 'Manufacture'
          AND   sed.s_warehouse IS NOT NULL
        GROUP BY se.work_order, sed.item_code
    """, {"wos": wo_names}, as_dict=True)

    result = {}
    for r in rows:
        wo = r.work_order
        if wo not in result:
            result[wo] = {}
        result[wo][r.item_code] = flt(r.consumed_qty)

    return result


# ═══════════════════════════════════════════════════════════════════════
#  DISPATCH INFO (Sales Orders)
# ═══════════════════════════════════════════════════════════════════════

def _get_dispatch_info(item_codes):
    """
    Fetch pending SO qty per item for previous and current calendar months.

    "Pending" = SO submitted, not closed/cancelled, delivery_date in period,
    and (qty - delivered_qty) > 0.

    Returns:
        dict: {item_code: {"prev_month": float, "curr_month": float}}
    """
    if not item_codes:
        return {}

    today_d    = date.today()
    curr_m     = today_d.month
    curr_y     = today_d.year
    prev_m     = 12 if curr_m == 1 else curr_m - 1
    prev_y     = curr_y - 1 if curr_m == 1 else curr_y

    def _period(m, y):
        last = calendar.monthrange(y, m)[1]
        return str(date(y, m, 1)), str(date(y, m, last))

    curr_from, curr_to = _period(curr_m, curr_y)
    prev_from, prev_to = _period(prev_m, prev_y)

    def _fetch(from_d, to_d):
        rows = frappe.db.sql("""
            SELECT soi.item_code,
                   SUM(soi.qty - COALESCE(soi.delivered_qty, 0)) AS pending
            FROM   `tabSales Order Item` soi
            JOIN   `tabSales Order` so ON so.name = soi.parent
            WHERE  soi.item_code IN %(items)s
              AND  so.docstatus  = 1
              AND  so.status NOT IN ('Closed', 'Cancelled')
              AND  (soi.qty - COALESCE(soi.delivered_qty, 0)) > 0
              AND  so.delivery_date BETWEEN %(f)s AND %(t)s
            GROUP BY soi.item_code
        """, {"items": item_codes, "f": from_d, "t": to_d}, as_dict=True)
        return {r.item_code: flt(r.pending) for r in rows}

    curr_map = _fetch(curr_from, curr_to)
    prev_map = _fetch(prev_from, prev_to)

    return {
        ic: {
            "prev_month": flt(prev_map.get(ic, 0)),
            "curr_month": flt(curr_map.get(ic, 0)),
        }
        for ic in item_codes
    }


# ═══════════════════════════════════════════════════════════════════════
#  DISPATCH BOTTLENECK ANALYSIS
#  Public endpoint + private helpers.
#  Called by wo_kitting_planner.js after simulate_kitting() completes.
#
#  Answers the executive question:
#    "For each finished good we are producing — do we have enough stock
#     AND production to fulfill all customer orders?"
#
#  ══════════════════════════════════════════════════════════════════════
#  🔒 RESTRICTED — do not change the return schema keys without
#     updating _renderDispatchBottleneck() in wo_kitting_planner.js
#  ══════════════════════════════════════════════════════════════════════
#
#  Return schema per item_code:
#    fg_stock        float  Physical FG stock (Bin.actual_qty, all warehouses)
#    total_pending   float  Sum of open SO qty not yet delivered
#    total_reserved  float  Sum of Stock Reservation qty for this item
#    has_pick_list   bool   Any SO for this item has a Pick List
#    so_list         list   [{so_name, customer, qty, delivered_qty,
#                             pending_qty, delivery_date, is_overdue,
#                             pick_list_count, reserved_qty, dn_qty}]
#
#  Performance: 5 batch SQL queries total (not N per item/SO).
# ═══════════════════════════════════════════════════════════════════════

@frappe.whitelist()
def get_dispatch_bottleneck(item_codes_json):
    """
    Dispatch bottleneck analysis for finished-good items.

    For each production item with open WOs, returns:
      - Physical FG stock in warehouse
      - All open Sales Orders with pending qty, delivery dates, urgency
      - Pick List status (has a pick list been created for each SO?)
      - Stock Reservation qty (how much is earmarked via reservation?)
      - Delivery Note qty (partial deliveries already made)

    Management use: Compare "Will Produce + In Stock" vs "Customer Orders"
    to identify items where production cannot cover demand even if all WOs complete.

    Args:
        item_codes_json (str): JSON list of production item codes

    Returns:
        dict: {item_code: {fg_stock, total_pending, total_reserved,
                           has_pick_list, so_list: [...]}}
    """
    item_codes = (
        frappe.parse_json(item_codes_json)
        if isinstance(item_codes_json, str)
        else item_codes_json
    ) or []

    if not item_codes:
        return {}

    # ── Step 1: FG physical stock ────────────────────────────────────
    fg_stock = _get_fg_stock(item_codes)

    # ── Step 2: Open Sales Orders (all open, not just 2-month window) ─
    so_rows = _get_open_so_detail(item_codes)

    if not so_rows:
        return {
            ic: {"fg_stock": flt(fg_stock.get(ic, 0)),
                 "total_pending": 0.0, "total_reserved": 0.0,
                 "has_pick_list": False, "so_list": []}
            for ic in item_codes
        }

    so_names = list({r["so_name"] for r in so_rows})

    # ── Step 3: Pick List status ────────────────────────────────────
    pick_map = _get_pick_list_status(so_names)

    # ── Step 4: Stock Reservation (ERPNext v15+ — fails gracefully) ──
    reserved_map = _get_reserved_stock(so_names)

    # ── Step 5: Delivery Note partial deliveries ────────────────────
    dn_map = _get_dn_detail(item_codes, so_names)

    # ── Assemble result ──────────────────────────────────────────────
    so_by_item = {}
    today_str  = str(date.today())

    for r in so_rows:
        ic = r["item_code"]
        so_by_item.setdefault(ic, []).append({
            "so_name"         : r["so_name"],
            "customer"        : r["customer"] or "",
            "qty"             : flt(r["qty"]),
            "delivered_qty"   : flt(r["delivered_qty"]),
            "pending_qty"     : flt(r["pending_qty"]),
            "delivery_date"   : str(r["delivery_date"] or ""),
            "is_overdue"      : str(r["delivery_date"] or "") < today_str
                                and flt(r["pending_qty"]) > 0,
            "pick_list_count" : int(pick_map.get(r["so_name"], 0)),
            "reserved_qty"    : flt(reserved_map.get(r["so_name"], 0)),
            "dn_qty"          : flt(dn_map.get((ic, r["so_name"]), 0)),
        })

    result = {}
    for ic in item_codes:
        so_list        = so_by_item.get(ic, [])
        total_pending  = sum(s["pending_qty"] for s in so_list)
        total_reserved = sum(s["reserved_qty"] for s in so_list)
        has_pick_list  = any(s["pick_list_count"] > 0 for s in so_list)

        result[ic] = {
            "fg_stock"      : flt(fg_stock.get(ic, 0)),
            "total_pending" : total_pending,
            "total_reserved": total_reserved,
            "has_pick_list" : has_pick_list,
            "so_list"       : so_list,
        }

    return result


def _get_fg_stock(item_codes):
    """
    Physical finished-good stock: sum of actual_qty across all warehouses.

    Returns:
        dict: {item_code: actual_qty}
    """
    if not item_codes:
        return {}
    rows = frappe.db.sql("""
        SELECT item_code, SUM(actual_qty) AS qty
        FROM   `tabBin`
        WHERE  item_code IN %(items)s
        GROUP BY item_code
    """, {"items": item_codes}, as_dict=True)
    return {r.item_code: flt(r.qty) for r in rows}


def _get_open_so_detail(item_codes):
    """
    Fetch all open (undelivered) Sales Order lines for these items.

    Returns ALL SOs regardless of delivery date — not restricted to
    the 2-month window used by _get_dispatch_info().
    Results are ordered by delivery_date ASC (soonest first).

    Returns:
        list of dicts: [{item_code, so_name, customer, qty,
                          delivered_qty, pending_qty, delivery_date}]
    """
    if not item_codes:
        return []
    rows = frappe.db.sql("""
        SELECT soi.item_code,
               so.name                                         AS so_name,
               so.customer,
               soi.qty,
               COALESCE(soi.delivered_qty, 0)                  AS delivered_qty,
               (soi.qty - COALESCE(soi.delivered_qty, 0))      AS pending_qty,
               so.delivery_date
        FROM   `tabSales Order Item` soi
        JOIN   `tabSales Order` so ON so.name = soi.parent
        WHERE  soi.item_code IN %(items)s
          AND  so.docstatus  = 1
          AND  so.status NOT IN ('Closed', 'Cancelled', 'Completed')
          AND  (soi.qty - COALESCE(soi.delivered_qty, 0)) > 0
        ORDER BY so.delivery_date ASC, so.creation ASC
    """, {"items": item_codes}, as_dict=True)
    return [dict(r) for r in rows]


def _get_pick_list_status(so_names):
    """
    Check if any Pick List exists for each Sales Order.

    Pick List Item has field `sales_order` linking back to the SO.
    A Pick List with docstatus < 2 (not cancelled) counts.

    Returns:
        dict: {so_name: pick_list_count}
    """
    if not so_names:
        return {}
    try:
        rows = frappe.db.sql("""
            SELECT pli.sales_order,
                   COUNT(DISTINCT pl.name) AS pick_count
            FROM   `tabPick List Item` pli
            JOIN   `tabPick List` pl ON pl.name = pli.parent
            WHERE  pli.sales_order IN %(sos)s
              AND  pl.docstatus < 2
              AND  pl.purpose = 'Delivery'
            GROUP BY pli.sales_order
        """, {"sos": so_names}, as_dict=True)
        return {r.sales_order: int(r.pick_count) for r in rows}
    except Exception:
        # Pick List module may not be enabled
        return {}


def _get_reserved_stock(so_names):
    """
    Fetch reserved stock qty per Sales Order from Stock Reservation entries.

    Stock Reservation (ERPNext v15+) allows reserving specific warehouse
    stock against a Sales Order before it is delivered.
    Falls back to empty dict if the doctype does not exist.

    Returns:
        dict: {so_name: reserved_qty}
    """
    if not so_names:
        return {}
    try:
        if not frappe.db.table_exists("Stock Reservation"):
            return {}
        rows = frappe.db.sql("""
            SELECT voucher_no,
                   SUM(reserved_qty) AS reserved_qty
            FROM   `tabStock Reservation`
            WHERE  voucher_no IN %(sos)s
              AND  docstatus = 1
              AND  status NOT IN ('Delivered', 'Cancelled')
            GROUP BY voucher_no
        """, {"sos": so_names}, as_dict=True)
        return {r.voucher_no: flt(r.reserved_qty) for r in rows}
    except Exception:
        return {}


def _get_dn_detail(item_codes, so_names):
    """
    Fetch partial Delivery Note quantities per (item_code, sales_order) pair.

    Helps show how much of each SO line has already been partially shipped.
    Uses `against_sales_order` field on Delivery Note Item.

    Returns:
        dict: {(item_code, so_name): delivered_qty}
    """
    if not item_codes or not so_names:
        return {}
    try:
        rows = frappe.db.sql("""
            SELECT dni.item_code,
                   dni.against_sales_order  AS so_name,
                   SUM(dni.qty)             AS dn_qty
            FROM   `tabDelivery Note Item` dni
            JOIN   `tabDelivery Note` dn ON dn.name = dni.parent
            WHERE  dni.item_code IN %(items)s
              AND  dni.against_sales_order IN %(sos)s
              AND  dn.docstatus = 1
              AND  dn.is_return = 0
            GROUP BY dni.item_code, dni.against_sales_order
        """, {"items": item_codes, "sos": so_names}, as_dict=True)
        return {(r.item_code, r.so_name): flt(r.dn_qty) for r in rows}
    except Exception:
        return {}


# ═══════════════════════════════════════════════════════════════════════
#  AI ADVISOR — DeepSeek Chat Integration
#  ══════════════════════════════════════════════════════════════════════
#
#  PURPOSE
#  ───────
#  Gives managers a plain-language AI advisor that understands the
#  current WO kitting simulation and dispatch bottleneck data.
#  Answers questions like:
#    "Which WOs should I release first?"
#    "What materials do I need to buy urgently?"
#    "Can we ship the Haldiram order on time?"
#
#  ARCHITECTURE
#  ─────────────
#  Session persistence: Redis cache (frappe.cache()) keyed per user+session_id.
#    - Only user+assistant messages are stored (system prompt regenerated each call).
#    - TTL: 2 hours. Older messages pruned to _AI_MAX_HISTORY to control cost.
#
#  Context compression: Full simulation data (~50+ rows) is compressed to a
#    ~400-token JSON summary before sending to the AI. This keeps cost minimal.
#
#  Function calling: DeepSeek is given 3 tools to fetch detail on demand:
#    - get_wo_shortage_detail(wo_name)   — BOM component breakdown for a WO
#    - get_dispatch_detail(item_code)    — SO list, pick list, reservation status
#    - get_top_shortage_items(rank_by)   — materials ranked by value/frequency
#
#  Token budget per call:
#    System prompt    ~180 tokens
#    Context          ~400 tokens
#    Chat history     ~300 tokens (14 messages max)
#    User message     ~50-100 tokens
#    Response         ~600 tokens max
#    Total            ~1500 tokens → < $0.001 per call (DeepSeek pricing)
#
#  ══════════════════════════════════════════════════════════════════════
#  🔒 RESTRICTED — do not change without updating wo_kitting_planner.js:
#    chat_with_planner()  return schema: {reply, session_id, is_html}
#    get_ai_auto_insight() return schema: {insight, is_html}
#  ══════════════════════════════════════════════════════════════════════

# ── System prompt (sent with EVERY call — keep short to minimise cost) ──
_AI_SYSTEM_PROMPT = (
    "You are a production planning advisor for a food/FMCG manufacturing factory using ERPNext.\n"
    "You analyse Work Order kitting and dispatch data to help production managers make fast decisions.\n\n"
    "AUDIENCE: Factory manager — knows the business but may not know ERP terminology.\n\n"
    "RESPONSE RULES:\n"
    "1. Be concise. Max 3 paragraphs unless a table is needed.\n"
    "2. Use HTML tables ONLY for comparisons (3+ rows of data). Format:\n"
    "   <table class=\"wkp-ai-table\"><thead><tr><th>Col</th></tr></thead>"
    "<tbody><tr><td>Val</td></tr></tbody></table>\n"
    "3. Use <strong>text</strong> for urgent items.\n"
    "4. Mark good things: <span class=\"wkp-ai-ok\">text</span>\n"
    "   Mark warnings:    <span class=\"wkp-ai-warn\">text</span>\n"
    "   Mark critical:    <span class=\"wkp-ai-err\">text</span>\n"
    "5. ALWAYS end with numbered action steps:\n"
    "   <ol class=\"wkp-ai-actions\"><li>Action 1</li><li>Action 2</li></ol>\n"
    "6. Call functions when the user asks about a SPECIFIC Work Order or item.\n"
    "7. ERPNext terms to know: WO=Work Order, BOM=Bill of Materials (recipe),\n"
    "   MR=Material Request (internal purchase order), PO=Purchase Order.\n"
    "   Kit status: ok=ready, partial=some missing, block=cannot start, kitted=done.\n"
)

# ── Tool definitions for DeepSeek function calling ──
_AI_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_wo_shortage_detail",
            "description": (
                "Get the full list of missing materials for a specific Work Order. "
                "Call this when the user asks about a specific WO name (e.g. WO-00123)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "wo_name": {
                        "type": "string",
                        "description": "The Work Order name, e.g. WO-00123 or MFG-WO-2026-00001",
                    }
                },
                "required": ["wo_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_dispatch_detail",
            "description": (
                "Get Sales Order dispatch detail for a specific finished-good item: "
                "FG stock, pending customer orders, pick list status, reservations. "
                "Call this when the user asks about dispatch, delivery or a specific product."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "item_code": {
                        "type": "string",
                        "description": "Item code of the finished good, e.g. MBLND-500G",
                    }
                },
                "required": ["item_code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_top_shortage_items",
            "description": (
                "Get the top shortage materials ranked by value or frequency across all WOs. "
                "Call this for procurement planning questions or 'what should I buy' questions."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "rank_by": {
                        "type": "string",
                        "enum": ["value", "frequency"],
                        "description": "rank_by='value': sort by INR shortage value. "
                                       "rank_by='frequency': sort by how many WOs need it.",
                    }
                },
                "required": ["rank_by"],
            },
        },
    },
]


# ─────────────────────────────────────────────────────────────────────
#  PUBLIC: Chat endpoint (session-persistent)
# ─────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def chat_with_planner(message, session_id, context_json):
    """
    AI chat endpoint with session memory and DeepSeek function calling.

    The client sends:
      message     str   User's plain-language question
      session_id  str   UUID generated by the browser (persisted in sessionStorage)
      context_json str  JSON with compressed simulation snapshot (from _compress_context)

    Session is stored in Redis cache keyed per user+session_id. Older messages
    are pruned to _AI_MAX_HISTORY to keep token counts bounded.

    Returns:
        dict: {
            reply:      str   AI response (may contain HTML)
            session_id: str   Echo back the session_id
            is_html:    bool  True if reply contains HTML tags
        }
    """
    api_key = _get_api_key()
    if not api_key or api_key.startswith("YOUR_"):
        return {
            "reply": (
                "<span class=\"wkp-ai-warn\">AI Advisor is not configured.</span> "
                "Set the DeepSeek API key in <code>wo_kitting_api.py</code> "
                "(DEEPSEEK_API_KEY constant) or in TOC Settings."
            ),
            "session_id": session_id,
            "is_html": True,
        }

    context = frappe.parse_json(context_json) if isinstance(context_json, str) else (context_json or {})

    # Load session history from Redis
    cache_key  = f"wkp:chat:{frappe.session.user}:{session_id}"
    history    = frappe.cache().get_value(cache_key) or []

    # Build full message list: system + history + new user message
    system_msg = {
        "role": "system",
        "content": _AI_SYSTEM_PROMPT + "\n\nCURRENT SIMULATION DATA:\n" + json.dumps(context, default=str),
    }
    messages = [system_msg] + history + [{"role": "user", "content": str(message)}]

    # Run with function-calling loop
    reply_text, updated_messages = _execute_chat_with_tools(messages, context, api_key)

    # Prune to last N messages (exclude system) and save back
    new_history = [m for m in updated_messages if m.get("role") != "system"]
    if len(new_history) > _AI_MAX_HISTORY:
        new_history = new_history[-_AI_MAX_HISTORY:]
    frappe.cache().set_value(cache_key, new_history, expires_in_sec=_AI_SESSION_TTL)

    return {
        "reply"     : reply_text,
        "session_id": session_id,
        "is_html"   : "<" in reply_text,  # True if reply contains HTML tags
    }


@frappe.whitelist()
def get_ai_auto_insight(context_json):
    """
    Stateless AI briefing called once after each simulation completes.

    No session — each call is independent. The AI analyses the compressed
    simulation snapshot and returns a structured briefing:
      - Overall situation (1-2 sentences)
      - Top 3 issues requiring immediate action
      - Recommended next steps

    Returns:
        dict: {insight: str (may contain HTML), is_html: bool}
    """
    api_key = _get_api_key()
    if not api_key or api_key.startswith("YOUR_"):
        return {
            "insight": (
                "<span class=\"wkp-ai-warn\">AI Advisor not configured.</span> "
                "Set DEEPSEEK_API_KEY in wo_kitting_api.py to enable AI insights."
            ),
            "is_html": True,
        }

    context = frappe.parse_json(context_json) if isinstance(context_json, str) else (context_json or {})

    prompt = (
        "Give me a production briefing based on this simulation data. "
        "Format: 1 sentence overall status, then a short HTML table of top 3-5 issues "
        "(columns: Issue | Impact | Action), then 3 numbered action steps. "
        "Be direct — no preamble."
    )

    messages = [
        {
            "role": "system",
            "content": _AI_SYSTEM_PROMPT + "\n\nCURRENT SIMULATION DATA:\n" + json.dumps(context, default=str),
        },
        {"role": "user", "content": prompt},
    ]

    # Auto-insight: no function calling (pure analysis, faster)
    try:
        result = _call_deepseek(messages, tools=None, api_key=api_key)
        reply  = result["choices"][0]["message"]["content"] or ""
    except Exception as exc:
        frappe.log_error(f"WKP AI auto-insight error: {exc}", "WKP AI")
        reply  = "<span class=\"wkp-ai-warn\">AI briefing unavailable. Check server logs.</span>"

    return {"insight": reply, "is_html": "<" in reply}


# ─────────────────────────────────────────────────────────────────────
#  PRIVATE: DeepSeek caller + function-call execution loop
# ─────────────────────────────────────────────────────────────────────

def _get_api_key():
    """
    Resolve DeepSeek API key via fallback hierarchy:
      1. DEEPSEEK_API_KEY constant (this file)
      2. frappe.conf.deepseek_api_key (site_config.json)
      3. TOC Settings custom_deepseek_api_key field (Password fieldtype — use get_decrypted_password)
    """
    if DEEPSEEK_API_KEY and not DEEPSEEK_API_KEY.startswith("YOUR_"):
        return DEEPSEEK_API_KEY
    key = getattr(frappe.conf, "deepseek_api_key", None)
    if key:
        return key
    try:
        from frappe.utils.password import get_decrypted_password
        key = get_decrypted_password(
            "TOC Settings", "TOC Settings", "custom_deepseek_api_key", raise_exception=False
        )
        if key:
            return key
    except Exception:
        pass
    return None


def _call_deepseek(messages, tools=None, api_key=None):
    """
    Low-level DeepSeek chat completion call via requests.

    Args:
        messages  list  Full message list (system + history + user)
        tools     list  Optional tool definitions for function calling
        api_key   str   DeepSeek API key

    Returns:
        dict: Raw DeepSeek API response JSON
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model"       : DEEPSEEK_MODEL,
        "messages"    : messages,
        "max_tokens"  : 700,
        "temperature" : 0.25,   # low temperature = focused, factual answers
        "stream"      : False,
    }
    if tools:
        payload["tools"]       = tools
        payload["tool_choice"] = "auto"

    resp = _requests.post(
        f"{DEEPSEEK_BASE_URL}/chat/completions",
        headers=headers,
        json=payload,
        timeout=40,
    )
    if not resp.ok:
        try:
            err_body = resp.json().get("error", {})
            err_msg = err_body.get("message", resp.text[:400])
        except Exception:
            err_msg = resp.text[:400]
        frappe.log_error(
            f"DeepSeek API {resp.status_code}: {err_msg}",
            "WKP AI DeepSeek Error",
        )
    resp.raise_for_status()
    return resp.json()


def _execute_chat_with_tools(messages, context, api_key):
    """
    Run the function-calling loop: send messages, execute any tool calls,
    and return the final text reply + updated message list.

    Args:
        messages list   Full message list to send
        context  dict   Compressed simulation context (for tool data lookup)
        api_key  str    DeepSeek API key

    Returns:
        tuple: (reply_text: str, updated_messages: list)
    """
    tool_calls_made = 0

    try:
        while tool_calls_made <= _AI_MAX_TOOL_CALLS:
            result   = _call_deepseek(messages, _AI_TOOLS, api_key)
            choice   = result["choices"][0]
            msg      = choice["message"]
            finish   = choice.get("finish_reason", "stop")

            messages.append(msg)

            if finish == "tool_calls" and msg.get("tool_calls"):
                tool_calls_made += 1
                for tc in msg["tool_calls"]:
                    fn_name = tc["function"]["name"]
                    fn_args = json.loads(tc["function"]["arguments"] or "{}")
                    fn_result = _execute_ai_tool(fn_name, fn_args, context)
                    messages.append({
                        "role"        : "tool",
                        "tool_call_id": tc["id"],
                        "content"     : json.dumps(fn_result, default=str),
                    })
            else:
                # Final response — return
                return msg.get("content") or "", messages

        return "Function call limit reached. Please rephrase your question.", messages

    except _requests.exceptions.Timeout:
        return "<span class=\"wkp-ai-warn\">AI response timed out. Please try again.</span>", messages
    except _requests.exceptions.HTTPError as exc:
        status = exc.response.status_code if exc.response is not None else "?"
        if status == 401:
            return (
                "<span class=\"wkp-ai-err\">Invalid DeepSeek API key. "
                "Update it in <b>TOC Settings → DeepSeek API Key</b>.</span>",
                messages,
            )
        if status == 402:
            return (
                "<span class=\"wkp-ai-err\">DeepSeek account has insufficient balance. "
                "Top up at platform.deepseek.com.</span>",
                messages,
            )
        frappe.log_error(f"WKP AI HTTP error {status}: {exc}", "WKP AI")
        return f"<span class=\"wkp-ai-warn\">AI service error (HTTP {status}). Try again later.</span>", messages
    except Exception as exc:
        frappe.log_error(f"WKP AI error: {exc}", "WKP AI")
        return "<span class=\"wkp-ai-warn\">AI error. Check server logs.</span>", messages


def _execute_ai_tool(fn_name, fn_args, context):
    """
    Execute a function-call tool and return structured data for the AI.

    Tools have access to:
      - context["rows"]       — full simulation rows (if present)
      - context["dispatch"]   — dispatch data per item
      - Live DB for shortage detail

    Returns:
        dict: Result data (serialised to JSON before sending to DeepSeek)
    """
    try:
        if fn_name == "get_wo_shortage_detail":
            wo_name = fn_args.get("wo_name", "")
            # Find in context rows first (no DB call needed)
            rows = context.get("rows") or []
            row  = next((r for r in rows if r.get("wo") == wo_name), None)
            if not row:
                return {"error": f"Work Order {wo_name!r} not found in current simulation."}
            return {
                "wo"           : row["wo"],
                "item_name"    : row.get("item_name", ""),
                "kit_status"   : row.get("kit_status", ""),
                "remaining_qty": row.get("remaining_qty", 0),
                "shortage_items": [
                    {
                        "material" : si.get("item_name", si.get("item_code", "")),
                        "needed"   : si.get("required", 0),
                        "in_stock" : si.get("available", 0),
                        "short"    : si.get("shortage", 0),
                        "stage"    : si.get("stage", ""),
                        "value_inr": si.get("shortage_value", 0),
                    }
                    for si in (row.get("shortage_items") or [])
                ],
                "customer_demand": row.get("total_pending_so", 0),
                "estimated_cost" : row.get("shortage_value", 0),
            }

        elif fn_name == "get_dispatch_detail":
            item_code = fn_args.get("item_code", "")
            dispatch  = context.get("dispatch") or {}
            d         = dispatch.get(item_code)
            if not d:
                return {"error": f"Item {item_code!r} not found in dispatch data. "
                                 "Make sure it appears in current simulation."}
            return {
                "item_code"    : item_code,
                "fg_stock"     : d.get("fg_stock", 0),
                "pending_orders": d.get("total_pending", 0),
                "reserved_qty" : d.get("total_reserved", 0),
                "has_pick_list": d.get("has_pick_list", False),
                "sales_orders" : [
                    {
                        "so"          : s.get("so_name", ""),
                        "customer"    : s.get("customer", ""),
                        "ordered_qty" : s.get("qty", 0),
                        "pending_qty" : s.get("pending_qty", 0),
                        "due_date"    : s.get("delivery_date", ""),
                        "overdue"     : s.get("is_overdue", False),
                        "pick_list"   : s.get("pick_list_count", 0) > 0,
                        "reserved"    : s.get("reserved_qty", 0),
                    }
                    for s in (d.get("so_list") or [])[:10]  # cap at 10 SOs
                ],
            }

        elif fn_name == "get_top_shortage_items":
            rank_by = fn_args.get("rank_by", "value")
            rows    = context.get("rows") or []
            # Aggregate shortages across all WOs
            agg = {}   # item_code -> {name, total_value, wo_count, total_qty}
            for row in rows:
                for si in (row.get("shortage_items") or []):
                    if flt(si.get("shortage", 0)) <= 0:
                        continue
                    ic = si.get("item_code", "")
                    if ic not in agg:
                        agg[ic] = {
                            "material": si.get("item_name", ic),
                            "uom"     : si.get("uom", ""),
                            "total_short_qty": 0.0,
                            "total_value_inr": 0.0,
                            "wo_count"       : 0,
                        }
                    agg[ic]["total_short_qty"] += flt(si.get("shortage", 0))
                    agg[ic]["total_value_inr"] += flt(si.get("shortage_value", 0))
                    agg[ic]["wo_count"]         += 1

            sort_key = "total_value_inr" if rank_by == "value" else "wo_count"
            ranked   = sorted(agg.values(), key=lambda x: x[sort_key], reverse=True)[:10]
            return {"ranked_by": rank_by, "top_materials": ranked}

        else:
            return {"error": f"Unknown function: {fn_name}"}

    except Exception as exc:
        return {"error": str(exc)}


# ─────────────────────────────────────────────────────────────────────
#  PUBLIC: Compress simulation data for AI context
#  Called from wo_kitting_planner.js before every AI call.
#  Returns a compact JSON that fits in ~400 tokens.
# ─────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def compress_context_for_ai(simulation_rows_json, dispatch_json, stock_mode, calc_mode):
    """
    Convert full simulation data into a compact AI context object.

    This is called client-side after simulation completes. The client sends
    the full rows + dispatch data; the server compresses it to a small summary
    that is cheap to send to the AI on every chat message.

    Returns:
        dict: Compact context (also includes 'rows' and 'dispatch' for tool use)
    """
    rows     = frappe.parse_json(simulation_rows_json) if isinstance(simulation_rows_json, str) else (simulation_rows_json or [])
    dispatch = frappe.parse_json(dispatch_json) if isinstance(dispatch_json, str) else (dispatch_json or {})

    total   = len(rows)
    ready   = sum(1 for r in rows if r.get("kit_status") == "ok")
    partial = sum(1 for r in rows if r.get("kit_status") == "partial")
    blocked = sum(1 for r in rows if r.get("kit_status") == "block")
    kitted  = sum(1 for r in rows if r.get("kit_status") == "kitted")

    total_shortage_val = sum(flt(r.get("shortage_value", 0)) for r in rows)
    total_pending_so   = sum(flt(r.get("total_pending_so", 0)) for r in rows)

    # Top 5 WOs by urgency (blocked/partial with customer pressure)
    urgent = sorted(
        [r for r in rows if r.get("kit_status") in ("block", "partial")],
        key=lambda x: (-(x.get("total_pending_so") or 0), -(x.get("shortage_value") or 0)),
    )[:5]
    critical_wos = [
        {
            "wo"            : r.get("wo", ""),
            "item"          : (r.get("item_name") or r.get("item_code", ""))[:35],
            "status"        : r.get("kit_status", ""),
            "remaining_qty" : round(flt(r.get("remaining_qty", 0)), 0),
            "shortage_val"  : round(flt(r.get("shortage_value", 0)), 0),
            "customer_demand": round(flt(r.get("total_pending_so", 0)), 0),
            "top_shortage"  : (
                r["shortage_items"][0]["item_name"][:25]
                if r.get("shortage_items") else None
            ),
        }
        for r in urgent
    ]

    # Dispatch alerts (items where gap > 0)
    dispatch_alerts = [
        {
            "item"      : k,
            "fg_stock"  : round(flt(v.get("fg_stock", 0)), 0),
            "orders"    : round(flt(v.get("total_pending", 0)), 0),
            "gap"       : round(flt(v.get("total_pending", 0)) - flt(v.get("fg_stock", 0)), 0),
        }
        for k, v in dispatch.items()
        if flt(v.get("total_pending", 0)) > flt(v.get("fg_stock", 0)) + 0.01
    ][:5]

    # Top shortage materials by value (for context)
    agg_shortages = {}
    for r in rows:
        for si in (r.get("shortage_items") or []):
            if flt(si.get("shortage", 0)) <= 0:
                continue
            ic = si.get("item_code", "")
            if ic not in agg_shortages:
                agg_shortages[ic] = {
                    "name" : si.get("item_name", ic)[:30],
                    "value": 0.0,
                    "wos"  : 0,
                }
            agg_shortages[ic]["value"] += flt(si.get("shortage_value", 0))
            agg_shortages[ic]["wos"]   += 1

    top_shortages = sorted(agg_shortages.values(), key=lambda x: -x["value"])[:5]
    top_shortages = [
        {"material": s["name"], "value_inr": round(s["value"], 0), "affecting_wos": s["wos"]}
        for s in top_shortages
    ]

    company = frappe.db.get_default("company") or ""

    # Compact summary (sent to AI in system prompt — ~400 tokens)
    summary = {
        "company"  : company,
        "date"     : str(frappe.utils.today()),
        "stock_mode": "Physical Only" if stock_mode == "current_only" else "Physical + Expected",
        "calc_mode" : "Independent Check" if calc_mode == "isolated" else "Sequential Priority",
        "summary"  : {
            "total_wos"    : total,
            "ready"        : ready,
            "partial"      : partial,
            "blocked"      : blocked,
            "kitted"       : kitted,
            "shortage_inr" : round(total_shortage_val, 0),
            "pending_so_qty": round(total_pending_so, 0),
        },
        "critical_wos"   : critical_wos,
        "dispatch_alerts": dispatch_alerts,
        "top_shortages"  : top_shortages,
    }

    # Include full rows + dispatch only for tool-call resolution (not sent to LLM directly)
    return {
        **summary,
        "rows"    : rows,      # used by _execute_ai_tool — not in the compressed summary
        "dispatch": dispatch,  # used by _execute_ai_tool — not in the compressed summary
    }
