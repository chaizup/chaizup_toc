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
from frappe.utils import add_days, cint, flt, today


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
