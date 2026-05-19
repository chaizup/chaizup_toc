# =============================================================================
# CONTEXT: Production Indent Subs — Script Report
#   One row per (Work Order × Component) for every TOC-Pending Work Order.
#   "Indent Subs" = the SUB-components (raw materials / packing materials)
#   that need to be issued for each pending production.
#
#   Columns (per user spec, 2026-05-18):
#     Warehouse | WO (link) | Produced Item Code / Name / Group / MRP |
#     Higher UOM | Default UOM | Qty planned + actual produced (Higher UOM) |
#     Component (consumed) Item Code (link) / Name / Group |
#     Qty planned + actual consumed (Higher UOM + Stock UOM) |
#     PP (link)
#
# MEMORY: app_chaizup_toc.md § MRP & UOM custom fields (added 2026-05-18)
#
# INSTRUCTIONS:
#   - Pending-status semantics come from `wo_kitting_api.get_toc_pending_filters`
#     (TS-001 single source of truth). The filter applies BOTH to the WO and
#     to its visibility in this report.
#   - "Higher UOM" per FG = the FG's largest-CF row in tabUOM Conversion Detail.
#     Falls back to stock_uom. Same picker used by /app/item-projection-view.
#   - "Higher UOM" per Component = the COMPONENT'S largest-CF row (separate
#     ladder from the FG).
#   - "Default UOM" of the FG = its stock_uom.
#   - All quantities live in stock UOM in the source tables; converted to
#     higher UOM via division by the picked CF.
#
# DANGER ZONE:
#   - tabWork Order Item is the component child. Don't confuse with
#     tabWork Order (parent FG) or tabProduction Plan Item.
#   - Higher UOM picker per item must be computed in a SINGLE batch query
#     for ALL items in the result — N+1 queries kill report runtime when
#     hundreds of WOs are pending.
#
# RESTRICT:
#   - Do NOT change the column shape without updating chaizup_toc.md and the
#     toc_user_guide change log — the report is referenced by procurement
#     teams downstream.
#   - Pending-status definitions must always come from
#     `wo_kitting_api.get_toc_pending_filters` — never hard-code.
# =============================================================================

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt


# ----- Pending-status loader (single source of truth) -----
def _toc_wo_pending():
    """Return (plain_statuses, workflow_states) for TOC-Pending WOs."""
    try:
        from chaizup_toc.api.wo_kitting_api import get_toc_pending_filters
        wo = (get_toc_pending_filters() or {}).get("wo") or []
    except Exception:
        wo = ["Not Started", "In Process", "Material Transferred"]
    plain, wf = [], []
    for s in wo:
        if isinstance(s, str) and s.startswith("Workflow: "):
            wf.append(s[len("Workflow: "):])
        else:
            plain.append(s)
    return plain, wf


# ----- Higher-UOM picker (largest CF per item) -----
def _pick_higher_uoms(item_codes: list[str]) -> dict[str, dict]:
    if not item_codes:
        return {}
    items_to_stock = {
        r.name: r.stock_uom for r in frappe.db.sql("""
            SELECT name, stock_uom FROM `tabItem`
            WHERE name IN %(c)s""", {"c": tuple(item_codes)}, as_dict=True)
    }
    ladder = frappe.db.sql("""
        SELECT parent AS item_code, uom, conversion_factor
        FROM `tabUOM Conversion Detail`
        WHERE parent IN %(c)s AND parenttype = 'Item'
          AND IFNULL(conversion_factor, 0) > 0
        ORDER BY conversion_factor DESC
    """, {"c": tuple(item_codes)}, as_dict=True)
    by_item: dict[str, list] = {}
    for r in ladder:
        by_item.setdefault(r.item_code, []).append(
            {"uom": r.uom, "factor": flt(r.conversion_factor)})
    out: dict[str, dict] = {}
    for ic in item_codes:
        s_uom = items_to_stock.get(ic) or ""
        non_stock = [r for r in (by_item.get(ic) or [])
                     if r["uom"] != s_uom and r["factor"] > 1.0]
        if non_stock:
            top = non_stock[0]
            out[ic] = {"stock_uom": s_uom,
                       "higher_uom": top["uom"], "cf": top["factor"]}
        else:
            out[ic] = {"stock_uom": s_uom,
                       "higher_uom": s_uom, "cf": 1.0}
    return out


def _to_higher(qty_stock, cf):
    if not cf or cf <= 0:
        return flt(qty_stock)
    return flt(qty_stock) / flt(cf)


# ----- Status clause builder -----
def _wo_pending_clause(plain, wf):
    parts, params = [], {}
    if plain:
        parts.append("(wo.docstatus = 1 AND wo.status IN %(_p)s)")
        params["_p"] = tuple(plain)
    if wf and frappe.db.has_column("Work Order", "workflow_state"):
        parts.append("(wo.docstatus = 0 AND wo.workflow_state IN %(_w)s)")
        params["_w"] = tuple(wf)
    if not parts:
        return "1=0", {}
    return "(" + " OR ".join(parts) + ")", params


# ----- Columns -----
def _columns():
    return [
        {"fieldname": "warehouse",        "label": _("Warehouse"),
         "fieldtype": "Link", "options": "Warehouse",     "width": 160},
        {"fieldname": "work_order",       "label": _("Work Order"),
         "fieldtype": "Link", "options": "Work Order",    "width": 170},
        {"fieldname": "wo_status",        "label": _("WO Status"),
         "fieldtype": "Data",                              "width": 120},
        # FG identity
        {"fieldname": "produced_item",    "label": _("Produced Item"),
         "fieldtype": "Link", "options": "Item",           "width": 170},
        {"fieldname": "produced_item_name", "label": _("Produced Item Name"),
         "fieldtype": "Data",                              "width": 240},
        {"fieldname": "produced_item_group", "label": _("Produced Item Group"),
         "fieldtype": "Link", "options": "Item Group",     "width": 160},
        {"fieldname": "produced_mrp",     "label": _("Produced Item MRP"),
         "fieldtype": "Currency",                          "width": 120},
        {"fieldname": "produced_higher_uom", "label": _("Higher UOM (FG)"),
         "fieldtype": "Data",                              "width": 110},
        {"fieldname": "produced_default_uom", "label": _("Default UOM (FG)"),
         "fieldtype": "Data",                              "width": 110},
        # FG qty
        {"fieldname": "fg_qty_planned_higher",
         "label": _("FG Qty Planned (Higher UOM)"),
         "fieldtype": "Float", "precision": 3,             "width": 180},
        {"fieldname": "fg_qty_produced_higher",
         "label": _("FG Qty Produced (Higher UOM)"),
         "fieldtype": "Float", "precision": 3,             "width": 180},
        # Component identity
        {"fieldname": "component_item",   "label": _("Component (Consumed)"),
         "fieldtype": "Link", "options": "Item",           "width": 170},
        {"fieldname": "component_item_name", "label": _("Component Name"),
         "fieldtype": "Data",                              "width": 240},
        {"fieldname": "component_item_group", "label": _("Component Group"),
         "fieldtype": "Link", "options": "Item Group",     "width": 160},
        # Component qty
        {"fieldname": "comp_qty_planned_higher",
         "label": _("Comp Qty Planned (Higher UOM)"),
         "fieldtype": "Float", "precision": 3,             "width": 200},
        {"fieldname": "comp_qty_actual_higher",
         "label": _("Comp Qty Consumed (Higher UOM)"),
         "fieldtype": "Float", "precision": 3,             "width": 210},
        {"fieldname": "comp_qty_actual_default",
         "label": _("Comp Qty Consumed (Stock UOM)"),
         "fieldtype": "Float", "precision": 3,             "width": 210},
        {"fieldname": "component_higher_uom",
         "label": _("Higher UOM (Comp)"),
         "fieldtype": "Data",                              "width": 110},
        {"fieldname": "component_stock_uom",
         "label": _("Stock UOM (Comp)"),
         "fieldtype": "Data",                              "width": 110},
        # PP link
        {"fieldname": "production_plan",  "label": _("Production Plan"),
         "fieldtype": "Link", "options": "Production Plan", "width": 170},
    ]


# ----- Filter resolution -----
def _resolve_filters(filters):
    f = filters or {}
    item       = f.get("item")        or None
    item_group = f.get("item_group")  or None
    warehouse  = f.get("warehouse")   or None
    return item, item_group, warehouse


# ----- Main query -----
def _query_wo_components(filters):
    item, item_group, warehouse = _resolve_filters(filters)
    plain, wf = _toc_wo_pending()
    clause, params = _wo_pending_clause(plain, wf)

    where, p = [clause], dict(params)

    if item:
        where.append("(wo.production_item = %(_item)s OR woi.item_code = %(_item)s)")
        p["_item"] = item
    if item_group:
        where.append("""(
            fg.item_group = %(_grp)s
            OR ci.item_group = %(_grp)s
        )""")
        p["_grp"] = item_group
    if warehouse:
        where.append("""(
            wo.fg_warehouse = %(_wh)s
            OR woi.source_warehouse = %(_wh)s
        )""")
        p["_wh"] = warehouse

    rows = frappe.db.sql(f"""
        SELECT
            wo.name                              AS work_order,
            wo.status                            AS wo_status,
            wo.fg_warehouse                      AS warehouse,
            wo.production_item                   AS produced_item,
            fg.item_name                         AS produced_item_name,
            fg.item_group                        AS produced_item_group,
            IFNULL(wo.custom_mrp,
                   IFNULL(fg.custom_mrp, 0))     AS produced_mrp,
            fg.stock_uom                         AS produced_default_uom,
            wo.qty                               AS fg_qty_planned_stock,
            IFNULL(wo.produced_qty, 0)           AS fg_qty_produced_stock,
            wo.production_plan                   AS production_plan,
            woi.item_code                        AS component_item,
            ci.item_name                         AS component_item_name,
            ci.item_group                        AS component_item_group,
            ci.stock_uom                         AS component_stock_uom,
            woi.required_qty                     AS comp_qty_required_stock,
            IFNULL(woi.consumed_qty,
                   IFNULL(woi.transferred_qty, 0)) AS comp_qty_actual_stock
        FROM `tabWork Order` wo
        JOIN `tabWork Order Item` woi ON woi.parent = wo.name
        LEFT JOIN `tabItem` fg ON fg.name = wo.production_item
        LEFT JOIN `tabItem` ci ON ci.name = woi.item_code
        WHERE {" AND ".join(where)}
        ORDER BY wo.planned_start_date ASC, wo.name ASC, woi.idx ASC
    """, p, as_dict=True)
    return rows


# ----- Build display rows (apply UOM conversion) -----
def _build_data(filters):
    raw = _query_wo_components(filters)
    if not raw:
        return []
    # One UOM ladder lookup batch for FG items and component items.
    fg_items   = sorted({r.produced_item   for r in raw if r.produced_item})
    comp_items = sorted({r.component_item  for r in raw if r.component_item})
    all_items  = sorted(set(fg_items) | set(comp_items))
    uom_map    = _pick_higher_uoms(all_items)

    data = []
    for r in raw:
        fg_meta = uom_map.get(r.produced_item) or {
            "stock_uom": r.produced_default_uom or "", "higher_uom":
            r.produced_default_uom or "", "cf": 1.0}
        comp_meta = uom_map.get(r.component_item) or {
            "stock_uom": r.component_stock_uom or "", "higher_uom":
            r.component_stock_uom or "", "cf": 1.0}

        data.append({
            "warehouse":               r.warehouse or "",
            "work_order":              r.work_order,
            "wo_status":               r.wo_status,
            "produced_item":           r.produced_item,
            "produced_item_name":      r.produced_item_name or r.produced_item,
            "produced_item_group":     r.produced_item_group or "",
            "produced_mrp":            flt(r.produced_mrp),
            "produced_higher_uom":     fg_meta["higher_uom"],
            "produced_default_uom":    fg_meta["stock_uom"],
            "fg_qty_planned_higher":   round(_to_higher(r.fg_qty_planned_stock,  fg_meta["cf"]), 3),
            "fg_qty_produced_higher":  round(_to_higher(r.fg_qty_produced_stock, fg_meta["cf"]), 3),
            "component_item":          r.component_item,
            "component_item_name":     r.component_item_name or r.component_item,
            "component_item_group":    r.component_item_group or "",
            "comp_qty_planned_higher": round(_to_higher(r.comp_qty_required_stock, comp_meta["cf"]), 3),
            "comp_qty_actual_higher":  round(_to_higher(r.comp_qty_actual_stock,   comp_meta["cf"]), 3),
            "comp_qty_actual_default": round(flt(r.comp_qty_actual_stock), 3),
            "component_higher_uom":    comp_meta["higher_uom"],
            "component_stock_uom":     comp_meta["stock_uom"],
            "production_plan":         r.production_plan or "",
        })
    return data


def _chart(data):
    if not data:
        return None
    # Top 10 components by planned-consumption qty (higher UOM)
    from collections import defaultdict
    by_comp = defaultdict(float)
    for r in data:
        by_comp[r["component_item"]] += r["comp_qty_planned_higher"]
    top = sorted(by_comp.items(), key=lambda kv: -kv[1])[:10]
    if not top:
        return None
    return {
        "data": {
            "labels":   [c for c, _ in top],
            "datasets": [{"name": "Planned Consumption (Higher UOM)",
                          "values": [round(v, 3) for _, v in top]}],
        },
        "type": "bar", "height": 280,
        "colors": ["#3730A3"],
    }


def _summary(data):
    n_wo   = len({r["work_order"]      for r in data})
    n_pp   = len({r["production_plan"] for r in data if r["production_plan"]})
    n_comp = len({r["component_item"]  for r in data})
    return [
        {"value": len(data), "label": _("Component Rows"),
         "datatype": "Int", "indicator": "blue"},
        {"value": n_wo,      "label": _("Pending Work Orders"),
         "datatype": "Int", "indicator": "orange"},
        {"value": n_pp,      "label": _("Production Plans"),
         "datatype": "Int", "indicator": "blue"},
        {"value": n_comp,    "label": _("Distinct Components"),
         "datatype": "Int", "indicator": "green"},
    ]


def execute(filters=None):
    columns = _columns()
    data    = _build_data(filters or {})
    chart   = _chart(data)
    summary = _summary(data)
    return columns, data, None, chart, summary
