# =============================================================================
# CONTEXT: Kitting Report API — answers "Can we produce this item today?"
#   Shows Manufacture-mode TOC items (auto_manufacture=1) with multi-level BOM
#   walk, per-component shortage analysis, and one-click WO/MR creation.
# MEMORY: app_chaizup_toc.md § Key Module Structure (kitting_api.py)
# INSTRUCTIONS:
#   - get_kitting_summary: filters items by custom_toc_auto_manufacture=1.
#     The old buffer_type FG/SFG filter is removed — all Manufacture-mode items shown.
#   - _walk_bom: assigns type="Manufacture" to components that have a BOM (recurse),
#     or type="Purchase" to leaf components (no BOM).
#   - _infer_type: for non-TOC components, checks auto_manufacture flag and BOM
#     existence. Returns "Manufacture" | "Purchase". No more FG/SFG/RM/PM strings.
#   - _component_stage: routes Work Order check to type=="Manufacture";
#     Purchase Order check to type=="Purchase".
#   - UOM RULE: ALL quantity comparisons must use stock_uom.
#     _so_pending: uses soi.stock_qty (not soi.qty) and pending = stock_qty - delivered_qty*cf
#     _dispatched:  uses dni.stock_qty (always in stock_uom)
#     _produced:    uses sed.transfer_qty (stock_uom) not sed.qty
#     _stock_map:   uses Bin.actual_qty (always stock_uom) — already correct
#     create_purchase_requests: uses purchase_uom + conversion_factor (same pattern as mr_generator._create_mr)
# DANGER ZONE:
#   - _resolve_buffer_type was removed from buffer_calculator.py. DO NOT import it.
#     Filtering is now done via frappe.get_all filters on custom_toc_auto_manufacture.
#   - Component "type" field in BOM tree rows is now "Manufacture" or "Purchase" —
#     not "FG"/"SFG"/"RM"/"PM". kitting_report.js checks r.mr_type, not r.buffer_type.
#   - UOM DANGER: BOM Item.stock_qty is in stock_uom (ERPNext auto-converts on BOM save).
#     Always use stock_qty not qty for BOM-based calculations.
#   - SO pending vs stock comparison MUST both be in stock_uom — mixing UOMs gives wrong
#     should_produce values, leading to incorrect WO creation qty.
# RESTRICT:
#   - Do NOT re-add _resolve_buffer_type import — it no longer exists.
#   - Do NOT add FG/SFG/RM/PM strings back — they break the filter in kitting_report.js.
#   - frappe.only_for() in create_purchase_requests / create_work_order_from_kitting —
#     do not remove (security gates).
#   - Do NOT use soi.qty or dni.qty for demand/dispatch — use stock_qty (stock_uom).
#   - Do NOT use sed.qty for produced qty — use transfer_qty (stock_uom).
# =============================================================================

"""
Kitting Report API — Full Supply Chain Visibility
==================================================
Answers: "Can we produce this Manufacture-mode item today? If not, why?"

Features:
- Filters to custom_toc_auto_manufacture=1 items (Manufacture-mode)
- Multi-level BOM walking (top-level → sub-assembly → leaf components)
- Per-component stage tracking (In Stock / In Production / Purchase Ordered / MR Raised / Short)
- One-click Purchase MR creation for all Purchase-mode shortages
- One-click Work Order creation for Manufacture-mode items/sub-assemblies
- Monthly demand vs dispatch vs production analysis

Called by: chaizup_toc/page/kitting_report/kitting_report.js
"""

import calendar
from datetime import date

import frappe
from frappe.utils import cint, flt, today


# ═══════════════════════════════════════════════════════
#  PUBLIC API
# ═══════════════════════════════════════════════════════

@frappe.whitelist()
def get_kitting_summary(company=None, month=None, year=None, buffer_type=None):
    """
    Main table data — one row per Manufacture-mode item.

    Args:
        buffer_type: kept for backward compat — silently ignored.
                     All custom_toc_auto_manufacture=1 items are shown.

    Returns:
        List of dicts with SO demand, dispatch, stock, production
        figures and a quick kit-status per item.
    """
    today_d = date.today()
    curr_month = cint(month) or today_d.month
    curr_year  = cint(year)  or today_d.year
    prev_month, prev_year = _prev_month(curr_month, curr_year)

    curr_from, curr_to = _period_dates(curr_month, curr_year)
    prev_from, prev_to = _period_dates(prev_month, prev_year)

    # Show all Manufacture-mode TOC items (auto_manufacture=1)
    items = frappe.get_all("Item",
        filters={"custom_toc_enabled": 1, "disabled": 0, "custom_toc_auto_manufacture": 1},
        fields=["name", "item_name", "item_group", "stock_uom", "custom_toc_default_bom"])

    if not items:
        return []

    item_codes = [i.name for i in items]

    # Batch-fetch all demand/supply data in parallel SQL calls
    curr_pending = _so_pending(item_codes, curr_from, curr_to, company)
    prev_pending = _so_pending(item_codes, prev_from, prev_to, company)
    curr_disp    = _dispatched(item_codes, curr_from, curr_to, company)
    prev_disp    = _dispatched(item_codes, prev_from, prev_to, company)
    curr_prod    = _produced(item_codes, curr_from, curr_to, company)
    stock        = _stock_map(item_codes, company)

    rows = []
    for item in items:
        ic = item.name
        curr_p = flt(curr_pending.get(ic, 0))
        prev_p = flt(prev_pending.get(ic, 0))
        total_p = curr_p + prev_p

        in_stock       = flt(stock.get(ic, 0))
        actual_prod    = flt(curr_prod.get(ic, 0))
        prod_req       = max(0.0, total_p - in_stock)
        should_produce = max(0.0, prod_req - actual_prod)

        kit = _quick_kit_check(ic, should_produce, item.custom_toc_default_bom)

        rows.append({
            "item_code"               : ic,
            "item_name"               : item.item_name,
            "item_group"              : item.item_group,
            "stock_uom"               : item.stock_uom,
            "mr_type"                 : "Manufacture",
            "bom"                     : item.custom_toc_default_bom or "",
            # Demand
            "total_so_pending"        : round(total_p, 2),
            "prev_month_pending_so"   : round(prev_p, 2),
            "curr_month_pending_so"   : round(curr_p, 2),
            "curr_month_dispatched"   : round(flt(curr_disp.get(ic, 0)), 2),
            "prev_month_dispatched"   : round(flt(prev_disp.get(ic, 0)), 2),
            # Supply
            "stock"                   : round(in_stock, 2),
            "curr_month_prod_req"     : round(prod_req, 2),
            "curr_month_actual_prod"  : round(actual_prod, 2),
            "should_produce"          : round(should_produce, 2),
            # Kit
            "kit_qty"                 : kit["kit_qty"],
            "kit_pct"                 : kit["kit_pct"],
            "kit_status"              : kit["status"],
        })

    # Sort: cannot-kit first (most urgent), then partial, full, no-demand
    _order = {"none": 0, "partial": 1, "full": 2, "no_demand": 3}
    rows.sort(key=lambda r: (_order.get(r["kit_status"], 9), -r["should_produce"]))
    return rows


@frappe.whitelist()
def get_item_kitting_detail(item_code, required_qty):
    """
    Full drill-down for one Manufacture-mode item.

    Returns:
        BOM component tree with per-component stock, shortage,
        stage, and all linked open documents (WO / PO / MR).
        Each component has type="Manufacture" (has BOM) or "Purchase" (leaf/purchased).
    """
    required_qty = flt(required_qty) or 1.0

    bom_name = (
        frappe.db.get_value("Item", item_code, "custom_toc_default_bom")
        or frappe.db.get_value("BOM",
            {"item": item_code, "is_active": 1, "docstatus": 1}, "name")
    )

    components = []
    if bom_name:
        _walk_bom(bom_name, required_qty, components, depth=0, max_depth=6)

    kit_qty = _calc_kit_qty_from_components(required_qty, components)

    return {
        "item_code"        : item_code,
        "item_name"        : frappe.db.get_value("Item", item_code, "item_name"),
        "required_qty"     : required_qty,
        "kit_qty"          : round(kit_qty, 2),
        "shortage"         : round(max(0.0, required_qty - kit_qty), 2),
        "bom"              : bom_name or "",
        "components"       : components,
        "work_orders"      : _open_work_orders(item_code),
        "material_requests": _open_mrs_for_item(item_code),
    }


@frappe.whitelist()
def create_purchase_requests(items_json, company):
    """
    One-click: Create a single Purchase Material Request
    covering all Purchase-mode component shortages passed in.

    Args:
        items_json: JSON list of {item_code, shortage_qty, uom, warehouse}
        company: Company name

    Returns:
        {status, mr, items_count}
    """
    frappe.only_for(["System Manager", "Stock Manager", "TOC Manager",
                     "Purchase Manager", "Manufacturing Manager"])

    items = frappe.parse_json(items_json) if isinstance(items_json, str) else items_json
    items = [i for i in (items or []) if flt(i.get("shortage_qty", 0)) > 0]
    if not items:
        frappe.throw("No shortage items to create a Material Request for.")

    from frappe.utils import add_days
    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    mr.company = company
    mr.transaction_date = today()
    mr.schedule_date = add_days(today(), 7)

    default_wh = _default_warehouse(company)
    for it in items:
        stock_uom = frappe.db.get_value("Item", it["item_code"], "stock_uom") or "Nos"
        # Resolve purchase_uom + conversion_factor (same pattern as mr_generator._create_mr)
        purchase_uom = frappe.db.get_value("Item", it["item_code"], "purchase_uom") or stock_uom
        conversion_factor = 1.0
        if purchase_uom and purchase_uom != stock_uom:
            cf = frappe.db.get_value(
                "UOM Conversion Detail",
                {"parent": it["item_code"], "uom": purchase_uom},
                "conversion_factor",
            )
            conversion_factor = flt(cf) if cf else 1.0
        # shortage_qty is in stock_uom; convert to purchase_uom for the MR line
        shortage_in_stock_uom = flt(it["shortage_qty"])
        if conversion_factor > 0 and conversion_factor != 1.0:
            mr_qty = shortage_in_stock_uom / conversion_factor
        else:
            mr_qty = shortage_in_stock_uom
            purchase_uom = stock_uom
        mr.append("items", {
            "item_code"        : it["item_code"],
            "qty"              : mr_qty,
            "uom"              : purchase_uom,
            "stock_uom"        : stock_uom,
            "conversion_factor": conversion_factor,
            "warehouse"        : it.get("warehouse") or default_wh,
            "schedule_date"    : add_days(today(), 7),
        })

    mr.flags.ignore_permissions = True
    mr.insert()
    frappe.db.commit()
    return {"status": "success", "mr": mr.name, "items_count": len(items)}


@frappe.whitelist()
def create_work_order_from_kitting(item_code, qty, company, bom=None):
    """
    One-click: Create a Work Order for a Manufacture-mode item shortage.

    Returns:
        {status, work_order, item_code, qty}
    """
    frappe.only_for(["System Manager", "Stock Manager", "TOC Manager",
                     "Manufacturing Manager"])

    qty = flt(qty)
    if qty <= 0:
        frappe.throw("Quantity must be greater than 0.")

    bom_name = (
        bom
        or frappe.db.get_value("Item", item_code, "custom_toc_default_bom")
        or frappe.db.get_value("BOM",
            {"item": item_code, "is_active": 1, "docstatus": 1}, "name")
    )
    if not bom_name:
        frappe.throw(
            f"No active BOM found for <b>{item_code}</b>. "
            "Please create and activate a BOM first."
        )

    wo = frappe.new_doc("Work Order")
    wo.production_item = item_code
    wo.bom_no = bom_name
    wo.qty = qty
    wo.company = company
    wo.planned_start_date = today()
    wo.flags.ignore_permissions = True
    wo.insert()
    frappe.db.commit()

    return {"status": "success", "work_order": wo.name,
            "item_code": item_code, "qty": qty}


# ═══════════════════════════════════════════════════════
#  DEMAND / SUPPLY QUERIES  (batch — one SQL per metric)
# ═══════════════════════════════════════════════════════

def _so_pending(item_codes, from_date, to_date, company=None):
    """
    Pending SO qty per item in STOCK UOM — delivery_date in period, not fully dispatched.

    Uses soi.stock_qty (stock_uom) for total ordered qty and
    soi.delivered_qty * soi.conversion_factor to get delivered qty in stock_uom.
    This ensures the result is comparable with Bin.actual_qty (also stock_uom).
    """
    if not item_codes:
        return {}
    co = "AND so.company = %(company)s" if company else ""
    rows = frappe.db.sql(f"""
        SELECT soi.item_code,
               SUM(
                   soi.stock_qty
                   - IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
               ) AS pending
        FROM   `tabSales Order Item` soi
        JOIN   `tabSales Order` so ON so.name = soi.parent
        WHERE  soi.item_code IN %(items)s
          AND  so.docstatus = 1
          AND  so.status NOT IN ('Closed','Cancelled')
          AND  soi.stock_qty > IFNULL(soi.delivered_qty, 0) * IFNULL(soi.conversion_factor, 1)
          AND  so.delivery_date BETWEEN %(f)s AND %(t)s
          {co}
        GROUP BY soi.item_code
    """, {"items": item_codes, "f": from_date, "t": to_date, "company": company},
    as_dict=True)
    return {r.item_code: flt(r.pending) for r in rows}


def _dispatched(item_codes, from_date, to_date, company=None):
    """
    Delivered qty per item in STOCK UOM from Delivery Notes in the period.
    Uses dni.stock_qty (automatically in stock_uom by ERPNext DN posting).
    """
    if not item_codes:
        return {}
    co = "AND dn.company = %(company)s" if company else ""
    rows = frappe.db.sql(f"""
        SELECT dni.item_code, SUM(dni.stock_qty) AS dispatched
        FROM   `tabDelivery Note Item` dni
        JOIN   `tabDelivery Note` dn ON dn.name = dni.parent
        WHERE  dni.item_code IN %(items)s
          AND  dn.docstatus = 1
          AND  dn.posting_date BETWEEN %(f)s AND %(t)s
          {co}
        GROUP BY dni.item_code
    """, {"items": item_codes, "f": from_date, "t": to_date, "company": company},
    as_dict=True)
    return {r.item_code: flt(r.dispatched) for r in rows}


def _produced(item_codes, from_date, to_date, company=None):
    """
    Qty manufactured in STOCK UOM (Stock Entries, type=Manufacture) per item in period.
    Uses sed.transfer_qty which is in stock_uom (= sed.qty × sed.conversion_factor).
    """
    if not item_codes:
        return {}
    co = "AND se.company = %(company)s" if company else ""
    rows = frappe.db.sql(f"""
        SELECT sed.item_code, SUM(sed.transfer_qty) AS produced
        FROM   `tabStock Entry Detail` sed
        JOIN   `tabStock Entry` se ON se.name = sed.parent
        WHERE  sed.item_code IN %(items)s
          AND  se.docstatus = 1
          AND  se.stock_entry_type = 'Manufacture'
          AND  sed.is_finished_item = 1
          AND  se.posting_date BETWEEN %(f)s AND %(t)s
          {co}
        GROUP BY sed.item_code
    """, {"items": item_codes, "f": from_date, "t": to_date, "company": company},
    as_dict=True)
    return {r.item_code: flt(r.produced) for r in rows}


def _stock_map(item_codes, company=None):
    """Current on-hand (Bin.actual_qty) per item, optionally filtered by company."""
    if not item_codes:
        return {}
    if company:
        rows = frappe.db.sql("""
            SELECT b.item_code, SUM(b.actual_qty) AS qty
            FROM   `tabBin` b
            JOIN   `tabWarehouse` w ON w.name = b.warehouse
            WHERE  b.item_code IN %(items)s AND w.company = %(company)s
            GROUP BY b.item_code
        """, {"items": item_codes, "company": company}, as_dict=True)
    else:
        rows = frappe.db.sql("""
            SELECT item_code, SUM(actual_qty) AS qty
            FROM   `tabBin`
            WHERE  item_code IN %(items)s
            GROUP BY item_code
        """, {"items": item_codes}, as_dict=True)
    return {r.item_code: flt(r.qty) for r in rows}


# ═══════════════════════════════════════════════════════
#  BOM WALKING
# ═══════════════════════════════════════════════════════

def _walk_bom(bom_name, parent_qty, results, depth, max_depth):
    """
    Recursive multi-level BOM walker.

    For each component:
      - Gets stock, shortage
      - Determines stage (In Stock / In Production / Purchase Ordered / MR Raised / Short)
      - Attaches all linked open documents with owner + creation info
      - Recurses into SFG sub-BOMs
    """
    if depth >= max_depth:
        return

    bom_items = frappe.get_all("BOM Item",
        filters={"parent": bom_name, "parenttype": "BOM"},
        fields=["item_code", "item_name", "stock_qty", "qty", "uom", "stock_uom"],
        order_by="idx asc")

    for bi in bom_items:
        required = flt(bi.stock_qty or bi.qty) * parent_qty

        item_meta = frappe.db.get_value(
            "Item", bi.item_code,
            ["item_name", "item_group",
             "custom_toc_default_bom", "custom_toc_enabled"],
            as_dict=True) or {}

        itype = _infer_type(bi.item_code)

        in_stock = flt(frappe.db.sql(
            "SELECT COALESCE(SUM(actual_qty),0) FROM `tabBin` WHERE item_code=%s",
            bi.item_code)[0][0])
        shortage = round(max(0.0, required - in_stock), 3)

        stage_info = _component_stage(bi.item_code, shortage, itype)

        component = {
            "item_code"        : bi.item_code,
            "item_name"        : bi.item_name or item_meta.get("item_name", bi.item_code),
            "type"             : itype,
            "uom"              : bi.stock_uom or bi.uom,
            "required_qty"     : round(required, 3),
            "in_stock"         : round(in_stock, 3),
            "shortage"         : shortage,
            "stage"            : stage_info["stage"],
            "stage_color"      : stage_info["color"],
            "work_orders"      : stage_info["work_orders"],
            "purchase_orders"  : stage_info["purchase_orders"],
            "material_requests": stage_info["material_requests"],
            "depth"            : depth,
            "sub_components"   : [],
        }

        # Recurse for Manufacture-mode sub-assemblies — walk their BOM to expose full chain
        if itype == "Manufacture":
            sub_bom = (
                item_meta.get("custom_toc_default_bom")
                or frappe.db.get_value("BOM",
                    {"item": bi.item_code, "is_active": 1, "docstatus": 1}, "name")
            )
            if sub_bom:
                _walk_bom(sub_bom, required, component["sub_components"],
                          depth + 1, max_depth)

        results.append(component)


# ═══════════════════════════════════════════════════════
#  KIT QTY CALCULATION
# ═══════════════════════════════════════════════════════

def _quick_kit_check(item_code, should_produce, bom_name):
    """Fast kit check for main table — no deep document fetching."""
    if should_produce <= 0:
        return {"kit_qty": 0.0, "kit_pct": 100.0, "status": "no_demand"}

    if not bom_name:
        bom_name = frappe.db.get_value(
            "BOM", {"item": item_code, "is_active": 1, "docstatus": 1}, "name")
    if not bom_name:
        return {"kit_qty": 0.0, "kit_pct": 0.0, "status": "none"}

    components = []
    _walk_bom(bom_name, should_produce, components, depth=0, max_depth=5)

    kit_qty = _calc_kit_qty_from_components(should_produce, components)
    kit_pct = round(min(100.0, kit_qty / should_produce * 100), 1)
    status  = "full" if kit_pct >= 100 else ("partial" if kit_pct > 0 else "none")
    return {"kit_qty": round(kit_qty, 2), "kit_pct": kit_pct, "status": status}


def _calc_kit_qty_from_components(required_qty, components):
    """
    How many FG units can be produced given the BOM component stock?
    Uses the bottleneck (most constrained component) approach.
    """
    if not components or not required_qty:
        return 0.0

    min_units = float("inf")

    def _check(comps, req):
        nonlocal min_units
        for c in comps:
            per_unit = flt(c["required_qty"]) / flt(req) if req else 0
            if per_unit <= 0:
                continue
            # Leaf components (Purchase-mode, or sub-assemblies with no sub-components)
            if c["type"] == "Purchase" or not c.get("sub_components"):
                producible = flt(c["in_stock"]) / per_unit
                min_units = min(min_units, producible)
            elif c.get("sub_components"):
                _check(c["sub_components"], c["required_qty"])

    _check(components, required_qty)
    return max(0.0, min_units) if min_units != float("inf") else 0.0


# ═══════════════════════════════════════════════════════
#  STAGE & DOCUMENT HELPERS
# ═══════════════════════════════════════════════════════

def _component_stage(item_code, shortage, item_type):
    """
    Determine supply stage for a component.

    Priority: In Stock > In Production (WO) > Purchase Ordered > MR Raised > Short—No Action

    Returns work_orders, purchase_orders, material_requests lists with
    enough detail for the UI to render: name, status, qty, owner, creation.
    """
    empty = {"stage": "In Stock", "color": "green",
             "work_orders": [], "purchase_orders": [], "material_requests": []}

    if shortage <= 0:
        return empty

    work_orders = []
    if item_type == "Manufacture":
        work_orders = frappe.db.sql("""
            SELECT wo.name, wo.status, wo.qty, wo.produced_qty,
                   wo.planned_start_date,
                   wo.owner, DATE_FORMAT(wo.creation,'%%d %%b %%Y') AS raised_on
            FROM   `tabWork Order` wo
            WHERE  wo.production_item = %s
              AND  wo.docstatus = 1
              AND  wo.status NOT IN ('Completed','Stopped','Cancelled')
            ORDER BY wo.creation DESC LIMIT 5
        """, item_code, as_dict=True)

    purchase_orders = []
    if item_type == "Purchase":
        purchase_orders = frappe.db.sql("""
            SELECT poi.parent AS name, po.status,
                   poi.qty, poi.received_qty,
                   po.supplier,
                   po.owner, DATE_FORMAT(po.creation,'%%d %%b %%Y') AS raised_on
            FROM   `tabPurchase Order Item` poi
            JOIN   `tabPurchase Order` po ON po.name = poi.parent
            WHERE  poi.item_code = %s
              AND  po.docstatus = 1
              AND  po.status NOT IN ('Closed','Cancelled')
            ORDER BY po.creation DESC LIMIT 5
        """, item_code, as_dict=True)

    material_requests = frappe.db.sql("""
        SELECT mri.parent AS name, mr.status,
               mri.qty, mri.ordered_qty,
               mr.material_request_type,
               mr.owner, DATE_FORMAT(mr.creation,'%%d %%b %%Y') AS raised_on
        FROM   `tabMaterial Request Item` mri
        JOIN   `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE  mri.item_code = %s
          AND  mr.docstatus < 2
          AND  mr.status NOT IN ('Cancelled','Stopped')
        ORDER BY mr.creation DESC LIMIT 5
    """, item_code, as_dict=True)

    if work_orders:
        stage, color = "In Production", "blue"
    elif purchase_orders:
        stage, color = "Purchase Ordered", "teal"
    elif material_requests:
        stage, color = "MR Raised", "orange"
    else:
        stage, color = "Short — No Action", "red"

    return {
        "stage"           : stage,
        "color"           : color,
        "work_orders"     : [dict(r) for r in work_orders],
        "purchase_orders" : [dict(r) for r in purchase_orders],
        "material_requests": [dict(r) for r in material_requests],
    }


def _open_work_orders(item_code):
    return frappe.db.sql("""
        SELECT name, status, qty, produced_qty, planned_start_date,
               owner, DATE_FORMAT(creation,'%%d %%b %%Y') AS raised_on
        FROM   `tabWork Order`
        WHERE  production_item = %s AND docstatus = 1
          AND  status NOT IN ('Completed','Stopped','Cancelled')
        ORDER BY creation DESC LIMIT 10
    """, item_code, as_dict=True)


def _open_mrs_for_item(item_code):
    return frappe.db.sql("""
        SELECT mri.parent AS name, mr.status,
               mri.qty, mri.ordered_qty,
               mr.material_request_type,
               mr.owner, DATE_FORMAT(mr.creation,'%%d %%b %%Y') AS raised_on
        FROM   `tabMaterial Request Item` mri
        JOIN   `tabMaterial Request` mr ON mr.name = mri.parent
        WHERE  mri.item_code = %s AND mr.docstatus < 2
          AND  mr.status NOT IN ('Cancelled','Stopped')
        ORDER BY mr.creation DESC LIMIT 10
    """, item_code, as_dict=True)


# ═══════════════════════════════════════════════════════
#  UTILITIES
# ═══════════════════════════════════════════════════════

def _period_dates(month, year):
    last = calendar.monthrange(year, month)[1]
    return str(date(year, month, 1)), str(date(year, month, last))


def _prev_month(month, year):
    return (12, year - 1) if month == 1 else (month - 1, year)


def _infer_type(item_code):
    """
    Determine replenishment mode for a BOM component.
    Priority: TOC flags → BOM existence → fallback to Purchase.
    Returns "Manufacture" | "Purchase" — never FG/SFG/RM/PM.
    """
    flags = frappe.db.get_value(
        "Item", item_code,
        ["custom_toc_auto_manufacture", "custom_toc_auto_purchase"],
        as_dict=True,
    ) or {}
    if flags.get("custom_toc_auto_manufacture"):
        return "Manufacture"
    if flags.get("custom_toc_auto_purchase"):
        return "Purchase"
    # Non-TOC item: check if an active BOM exists — if so, treat as manufactured sub-assembly
    has_bom = frappe.db.get_value(
        "BOM", {"item": item_code, "is_active": 1, "docstatus": 1}, "name"
    )
    return "Manufacture" if has_bom else "Purchase"


def _default_warehouse(company):
    return frappe.db.get_value(
        "Warehouse",
        {"company": company, "is_group": 0, "disabled": 0},
        "name"
    ) or ""
