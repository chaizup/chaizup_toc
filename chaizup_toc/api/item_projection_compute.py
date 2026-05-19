# =============================================================================
# CONTEXT: Item Projection View — data + math layer.
#   Powers /app/item-projection-view (Custom Page). Architecture mirrors
#   `item_shortage_compute.py` but with a procurement / planning slant
#   instead of TOC buffer health:
#
#     Stock (Higher UOM)
#       + Will-Receive (PO + WO Production)
#       − Will-Consume (WO Components + Pending SO Dispatch)
#       = Net Available
#
#     Shortage_Physical  = max(0, Demand − Stock)
#     Shortage_Projected = max(0, Demand − (Stock + WillReceive))
#       where Demand = WO_Consumption + SO_Dispatch
#
#   The page surfaces these in Higher UOM with a tooltip-on-every-number
#   contract that shows the back-end formula + voucher contributions.
#
# MEMORY:
#   - app_chaizup_toc.md § Item Projection View (added 2026-05-18)
#   - chaizup_item_shortage_dashboard.md (sibling page, same architecture)
#
# INSTRUCTIONS:
#   - `execute(filters)` is the single backend entry. Returns a flat dict the
#     page can pass straight to Tabulator.
#   - SQL helpers (Bin, WO, PO, SO) are IMPORTED from item_shortage_compute
#     — they're production-tested (ISD has been live since 2026-05-14). DO
#     NOT duplicate the SQL here; if a query needs to change, fix it in
#     item_shortage_compute and both pages benefit.
#   - Higher UOM picker = largest conversion_factor row in tabUOM Conversion
#     Detail for the item; falls back to stock_uom (CF=1) if none exists.
#     Computed ONCE per (item) in a single batch query then cached per call.
#   - Every numeric cell that lands on the page carries a parallel "tooltip"
#     payload — a list of short lines explaining HOW it was computed. The
#     page renders these via a Tabulator tooltipsHeader / cell-formatter
#     contract. The reason this is server-side and not just JS-derived: the
#     formula references TOC Settings (pending statuses) and the actual
#     contributing-voucher count, which the JS doesn't have.
#
# DANGER ZONE:
#   - Do NOT mutate the input `filters` dict — Frappe re-uses it across
#     subsequent endpoint calls on the same request and silent mutation
#     causes "ghost filters" between page actions.
#   - Higher UOM picker is per-ITEM not per-(item, warehouse) — same Yarn
#     item across two warehouses uses the same Carton CF; that's correct.
#   - Days of Cover uses Item.custom_toc_adu_value. If ADU is 0 or None,
#     return None (not 0!) so the page renders "—" instead of "0.0".
#
# RESTRICT:
#   - Do NOT add custom fields to Item or to any DocType from this module.
#     If we need new persisted state, it goes in a TOC Settings child table.
#   - Do NOT inline pending-status definitions. Always read via
#     `chaizup_toc.api.wo_kitting_api.get_toc_pending_filters` (TS-001
#     single-source-of-truth contract).
#   - Do NOT extend this file with cron jobs or write paths. The Page is
#     strictly read-on-demand.
# =============================================================================

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt


# ─────────────────────────────────────────────────────────────────────────────
# 1. SQL helpers — re-used from the Item Shortage Dashboard compute module.
# ─────────────────────────────────────────────────────────────────────────────
# We import the proven query helpers so this page never drifts from the
# canonical "what counts as pending" semantics. Any future change to the
# pending-status filter shape happens in ONE place.

from chaizup_toc.api.item_shortage_compute import (  # noqa: E402
    _build_status_clause,
    _get_stock_by_iw,
    _get_pending_wo_output_by_iw,
    _get_pending_po_incoming_by_iw,
    _get_open_wo_component_req_by_iw,
    _get_total_pending_so_by_iw,
)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Status loaders — single source of truth via TOC Settings.
# ─────────────────────────────────────────────────────────────────────────────
def _toc_pending_lists():
    """Return four lists from TOC Settings: (wo_plain, wo_wf, po_plain,
    po_wf, so_plain, so_wf). Empty string -> default list (per TS-001).

    The 'workflow' bucket carries the unprefixed workflow_state strings;
    `_build_status_clause` consults them only when the doctype has a
    workflow_state column.
    """
    try:
        from chaizup_toc.api.wo_kitting_api import get_toc_pending_filters
        p = get_toc_pending_filters() or {}
    except Exception:
        p = {}

    def _split(arr):
        plain, wf = [], []
        for s in (arr or []):
            if isinstance(s, str) and s.startswith("Workflow: "):
                wf.append(s[len("Workflow: "):])
            else:
                plain.append(s)
        return plain, wf

    wo_plain, wo_wf = _split(p.get("wo"))
    po_plain, po_wf = _split(p.get("po"))
    so_plain, so_wf = _split(p.get("so"))
    return wo_plain, wo_wf, po_plain, po_wf, so_plain, so_wf


# ─────────────────────────────────────────────────────────────────────────────
# 3. Higher UOM picker.
# ─────────────────────────────────────────────────────────────────────────────
def _pick_higher_uoms(item_codes: list[str]) -> dict[str, dict]:
    """
    For each item_code, return:
        {
          item_code: {
            "stock_uom":      "...",
            "higher_uom":     "...",            # may equal stock_uom if no ladder
            "conversion_factor": float,         # always >= 1
            "ladder": [{uom, factor}, ...],     # all alt UOMs sorted desc
          }, ...
        }

    Algorithm:
      1. Fetch Item.stock_uom for the input set.
      2. Fetch tabUOM Conversion Detail rows.
      3. For each item, find the row whose CF is the largest. That UOM is
         the "Higher UOM". If no rows exist (or only the stock UOM with
         CF=1), the higher UOM equals the stock UOM.

    INSTRUCTIONS:
      - Items can carry multiple alt UOMs (Gram / Kg / Carton). The "Higher
        UOM" is the COARSEST — biggest CF — so the reported number is the
        most-human-readable ("3 Cartons" reads better than "3000 Grams").
      - The full ladder is returned so the drill-down can show all options.
    """
    if not item_codes:
        return {}
    stock_rows = frappe.db.sql(
        """SELECT name AS item_code, stock_uom
           FROM `tabItem` WHERE name IN %(codes)s""",
        {"codes": tuple(item_codes)}, as_dict=True,
    )
    item_to_stock = {r.item_code: r.stock_uom for r in stock_rows}

    ladder_rows = frappe.db.sql(
        """SELECT parent AS item_code, uom, conversion_factor
           FROM `tabUOM Conversion Detail`
           WHERE parent IN %(codes)s
             AND parenttype = 'Item'
             AND IFNULL(conversion_factor, 0) > 0
           ORDER BY conversion_factor DESC""",
        {"codes": tuple(item_codes)}, as_dict=True,
    )
    by_item: dict[str, list] = {}
    for r in ladder_rows:
        by_item.setdefault(r.item_code, []).append({
            "uom":    r.uom,
            "factor": flt(r.conversion_factor),
        })

    out: dict[str, dict] = {}
    for ic in item_codes:
        s_uom = item_to_stock.get(ic) or ""
        ladder = by_item.get(ic) or []
        # Filter out the stock UOM (CF=1) entry to find a TRUE higher UOM.
        non_stock = [r for r in ladder if r["uom"] != s_uom and r["factor"] > 1.0]
        if non_stock:
            top = non_stock[0]    # sorted desc above
            out[ic] = {
                "stock_uom":         s_uom,
                "higher_uom":        top["uom"],
                "conversion_factor": top["factor"],
                "ladder":            ladder,
            }
        else:
            out[ic] = {
                "stock_uom":         s_uom,
                "higher_uom":        s_uom,
                "conversion_factor": 1.0,
                "ladder":            ladder,
            }
    return out


def _to_higher(qty_stock: float, cf: float) -> float:
    """Convert stock-UOM qty → higher-UOM qty. CF is always >= 1."""
    if not cf or cf <= 0:
        return flt(qty_stock)
    return flt(qty_stock) / flt(cf)


# ─────────────────────────────────────────────────────────────────────────────
# 4. ADU + name lookups.
# ─────────────────────────────────────────────────────────────────────────────
def _get_item_names(item_codes: list[str]) -> dict[str, dict]:
    if not item_codes:
        return {}
    rows = frappe.db.sql(
        """SELECT name AS item_code, item_name, item_group,
                  IFNULL(custom_toc_adu_value, 0) AS adu
           FROM `tabItem` WHERE name IN %(codes)s""",
        {"codes": tuple(item_codes)}, as_dict=True,
    )
    return {
        r.item_code: {
            "item_name":  r.item_name or r.item_code,
            "item_group": r.item_group or "",
            "adu":        flt(r.adu),
        }
        for r in rows
    }


# ─────────────────────────────────────────────────────────────────────────────
# 5. Candidate item resolution from filters.
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_candidate_items(filters: dict) -> tuple[list[str], list[str]]:
    """Return (item_codes, warehouses) honouring item / item_group / warehouse
    filters. If no explicit item filter, restrict to items that have AT LEAST
    one Bin row (active stock items only) so the result set stays bounded
    on multi-thousand-item sites.
    """
    f = filters or {}
    items   = f.get("item")        or []
    groups  = f.get("item_group")  or []
    whs     = f.get("warehouse")   or []
    company = f.get("company")     or None

    if isinstance(items, str):  items   = [items]
    if isinstance(groups, str): groups  = [groups]
    if isinstance(whs, str):    whs     = [whs]

    if items:
        return list(items), list(whs)

    where = ["1=1"]
    params: dict[str, Any] = {}
    if groups:
        where.append("i.item_group IN %(groups)s")
        params["groups"] = tuple(groups)
    if whs:
        where.append("b.warehouse IN %(whs)s")
        params["whs"] = tuple(whs)
    if company:
        # Bin doesn't carry company; restrict via Warehouse.company.
        where.append(
            "b.warehouse IN (SELECT name FROM `tabWarehouse` WHERE company = %(co)s)"
        )
        params["co"] = company

    rows = frappe.db.sql(
        f"""SELECT DISTINCT b.item_code
            FROM `tabBin` b
            JOIN `tabItem` i ON i.name = b.item_code
            WHERE {' AND '.join(where)}
              AND IFNULL(i.disabled, 0) = 0
            ORDER BY b.item_code""",
        params, as_dict=False,
    )
    return [r[0] for r in rows], list(whs)


# ─────────────────────────────────────────────────────────────────────────────
# 6. Column definitions — column metadata returned to the page.
# ─────────────────────────────────────────────────────────────────────────────
def _columns():
    """
    Column shape mirrors Frappe Script Report so the page can render
    labels/widths/types without re-defining them. Numeric columns have
    `numeric: True` and `higher_uom: True` markers the page uses to wire
    tooltips + click-to-drill.
    """
    return [
        # ── Identity ────────────────────────────────────────────────────
        {"fieldname": "item_code",  "label": _("Item Code"),
         "fieldtype": "Link", "options": "Item", "width": 180},
        {"fieldname": "item_name",  "label": _("Item Name"),
         "fieldtype": "Data", "width": 240},
        {"fieldname": "item_group", "label": _("Item Group"),
         "fieldtype": "Link", "options": "Item Group", "width": 160},
        {"fieldname": "warehouse",  "label": _("Warehouse"),
         "fieldtype": "Link", "options": "Warehouse", "width": 180},
        {"fieldname": "stock_uom",  "label": _("Stock UOM"),
         "fieldtype": "Data", "width": 90},
        # ── Current stock ───────────────────────────────────────────────
        {"fieldname": "current_stock_stock_uom",
         "label": _("Current Stock (Stock UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 150, "numeric": True},
        {"fieldname": "higher_uom", "label": _("Higher UOM"),
         "fieldtype": "Data", "width": 100},
        {"fieldname": "current_stock_higher_uom",
         "label": _("Current Stock (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 160,
         "numeric": True, "higher_uom": True},
        # ── Shortages ───────────────────────────────────────────────────
        {"fieldname": "shortage_physical",
         "label": _("Shortage — Physical (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 180,
         "numeric": True, "higher_uom": True,
         "drilldown": "shortage_physical"},
        {"fieldname": "shortage_projected",
         "label": _("Shortage — Projected (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 190,
         "numeric": True, "higher_uom": True,
         "drilldown": "shortage_projected"},
        # ── Will-Receive (inbound) ──────────────────────────────────────
        {"fieldname": "wo_remaining_production",
         "label": _("WO Remaining Production (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 200,
         "numeric": True, "higher_uom": True,
         "drilldown": "wo_remaining_production"},
        {"fieldname": "po_remaining",
         "label": _("PO Remaining (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 160,
         "numeric": True, "higher_uom": True,
         "drilldown": "po_remaining"},
        # ── Will-Consume / Dispatch (outbound) ──────────────────────────
        {"fieldname": "will_consume_open_wo",
         "label": _("Will Consume — Open WOs (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 210,
         "numeric": True, "higher_uom": True,
         "drilldown": "will_consume_open_wo"},
        {"fieldname": "will_dispatch_pending_so",
         "label": _("Will Dispatch — Pending SO (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 220,
         "numeric": True, "higher_uom": True,
         "drilldown": "will_dispatch_pending_so"},
        # ── Roll-ups ────────────────────────────────────────────────────
        {"fieldname": "net_available",
         "label": _("Net Available (Higher UOM)"),
         "fieldtype": "Float", "precision": 3, "width": 170,
         "numeric": True, "higher_uom": True,
         "drilldown": "net_available"},
        {"fieldname": "days_of_cover",
         "label": _("Days of Cover"),
         "fieldtype": "Float", "precision": 1, "width": 130,
         "numeric": True,
         "drilldown": "days_of_cover"},
        # ── Hidden helper fields (used by formatters) ───────────────────
        {"fieldname": "conversion_factor",
         "label": _("CF"), "fieldtype": "Float",
         "hidden": True, "precision": 6},
        {"fieldname": "_tooltips",
         "label": _("Tooltips"), "fieldtype": "Data", "hidden": True},
        {"fieldname": "_ladder",
         "label": _("UOM Ladder"), "fieldtype": "Data", "hidden": True},
        {"fieldname": "_flags",
         "label": _("Flags"), "fieldtype": "Data", "hidden": True},
    ]


# ─────────────────────────────────────────────────────────────────────────────
# 7. Per-row builder.
# ─────────────────────────────────────────────────────────────────────────────
def _build_row(
    ic: str, wh: str, info: dict, uom_meta: dict,
    stock_map, wo_prod_map, po_map, wo_cons_map, so_disp_map,
):
    """
    Single (item, warehouse) row. Each numeric output cell ships with a
    parallel tooltip line set so the JS can hover-render the formula and
    the contributing-voucher hint.
    """
    cf       = flt(uom_meta.get("conversion_factor") or 1.0)
    s_uom    = uom_meta.get("stock_uom") or info.get("stock_uom") or ""
    h_uom    = uom_meta.get("higher_uom") or s_uom
    ladder   = uom_meta.get("ladder") or []

    key = (ic, wh)
    stock_q   = flt(stock_map.get(key))
    wo_prod_q = flt(wo_prod_map.get(key))
    po_q      = flt(po_map.get(key))
    wo_cons_q = flt(wo_cons_map.get(key))
    so_disp_q = flt(so_disp_map.get(key))

    demand            = wo_cons_q + so_disp_q
    will_receive      = wo_prod_q + po_q
    short_physical_s  = max(0.0, demand - stock_q)
    short_proj_s      = max(0.0, demand - (stock_q + will_receive))
    net_available_s   = stock_q + will_receive - demand

    adu      = flt(info.get("adu"))
    doc_days = (stock_q / adu) if adu > 0 else None

    # Tooltips: keyed by fieldname → list of human lines (rendered with
    # <br> on the client). The first line is the formula. Subsequent lines
    # add component values.
    tooltips: dict[str, list[str]] = {
        "current_stock_stock_uom": [
            "Sum of Bin.actual_qty for this (item, warehouse).",
            f"= {stock_q:.3f} {s_uom}",
        ],
        "current_stock_higher_uom": [
            f"= Bin.actual_qty ÷ conversion_factor",
            f"= {stock_q:.3f} {s_uom} ÷ {cf:g}",
            f"= {_to_higher(stock_q, cf):.3f} {h_uom}",
        ],
        "shortage_physical": [
            "max(0, (WO consumption + SO dispatch) − current stock)",
            f"= max(0, ({wo_cons_q:.3f} + {so_disp_q:.3f}) − {stock_q:.3f})",
            f"= {short_physical_s:.3f} {s_uom}  →  "
            f"{_to_higher(short_physical_s, cf):.3f} {h_uom}",
        ],
        "shortage_projected": [
            "max(0, Demand − (Stock + PO + WO Production))",
            f"= max(0, {demand:.3f} − ({stock_q:.3f} + "
            f"{po_q:.3f} + {wo_prod_q:.3f}))",
            f"= {short_proj_s:.3f} {s_uom}  →  "
            f"{_to_higher(short_proj_s, cf):.3f} {h_uom}",
        ],
        "wo_remaining_production": [
            "Σ (Work Order.qty − produced_qty) where WO status is TOC-Pending and fg_warehouse matches.",
            f"= {wo_prod_q:.3f} {s_uom}  →  "
            f"{_to_higher(wo_prod_q, cf):.3f} {h_uom}",
            "Click for per-WO breakdown.",
        ],
        "po_remaining": [
            "Σ (Purchase Order Item.qty − received_qty) × conversion_factor where PO status is TOC-Pending.",
            f"= {po_q:.3f} {s_uom}  →  {_to_higher(po_q, cf):.3f} {h_uom}",
            "Click for per-PO breakdown.",
        ],
        "will_consume_open_wo": [
            "Σ (Work Order Item.required_qty − transferred_qty) where this item is a COMPONENT in a WO with TOC-Pending status.",
            f"= {wo_cons_q:.3f} {s_uom}  →  "
            f"{_to_higher(wo_cons_q, cf):.3f} {h_uom}",
            "Click for per-WO breakdown.",
        ],
        "will_dispatch_pending_so": [
            "Σ (Sales Order Item.stock_qty − delivered_qty × conversion_factor) where SO status is TOC-Pending.",
            f"= {so_disp_q:.3f} {s_uom}  →  "
            f"{_to_higher(so_disp_q, cf):.3f} {h_uom}",
            "Click for per-SO breakdown.",
        ],
        "net_available": [
            "Stock + Will-Receive (PO + WO Prod) − Demand (WO Cons + SO Dispatch).",
            f"= {stock_q:.3f} + ({po_q:.3f} + {wo_prod_q:.3f}) "
            f"− ({wo_cons_q:.3f} + {so_disp_q:.3f})",
            f"= {net_available_s:.3f} {s_uom}  →  "
            f"{_to_higher(net_available_s, cf):.3f} {h_uom}",
        ],
        "days_of_cover": (
            [
                f"= current_stock ÷ ADU",
                f"= {stock_q:.3f} ÷ {adu:.3f}",
                f"= {doc_days:.2f} days",
                "ADU = Item.custom_toc_adu_value (daily ADU cron, 06:30 AM).",
            ] if doc_days is not None else [
                "Days of Cover unavailable — Item.custom_toc_adu_value is 0 or null.",
                "Run TOC daily ADU update or set ADU manually on the Item.",
            ]
        ),
    }

    flags = {
        "negative_stock":       stock_q < 0,
        "shortage_physical":    short_physical_s > 0,
        "shortage_projected":   short_proj_s > 0,
        "doc_under_7":          (doc_days is not None and doc_days < 7),
        "net_below_zero":       net_available_s < 0,
    }

    return {
        "item_code":                  ic,
        "item_name":                  info.get("item_name") or ic,
        "item_group":                 info.get("item_group") or "",
        "warehouse":                  wh,
        "stock_uom":                  s_uom,
        "current_stock_stock_uom":    round(stock_q, 3),
        "higher_uom":                 h_uom,
        "current_stock_higher_uom":   round(_to_higher(stock_q, cf), 3),
        "shortage_physical":          round(_to_higher(short_physical_s, cf), 3),
        "shortage_projected":         round(_to_higher(short_proj_s, cf), 3),
        "wo_remaining_production":    round(_to_higher(wo_prod_q, cf), 3),
        "po_remaining":               round(_to_higher(po_q, cf), 3),
        "will_consume_open_wo":       round(_to_higher(wo_cons_q, cf), 3),
        "will_dispatch_pending_so":   round(_to_higher(so_disp_q, cf), 3),
        "net_available":              round(_to_higher(net_available_s, cf), 3),
        "days_of_cover":              round(doc_days, 1) if doc_days is not None else None,
        "conversion_factor":          cf,
        "_tooltips":                  json.dumps(tooltips),
        "_ladder":                    json.dumps(ladder),
        "_flags":                     json.dumps(flags),
    }


# ─────────────────────────────────────────────────────────────────────────────
# 8. Group-by aggregator (used for Tabulator dataTree mode).
# ─────────────────────────────────────────────────────────────────────────────
def _aggregate_group_rows(rows: list[dict]) -> list[dict]:
    """
    Return one synthetic "group header" row per Item Group with:
      - _group_header = True
      - item_group as the row label
      - summed numeric fields (stock, shortages, WO prod, PO, consume, dispatch,
        net_available) — note: these sums are in **Higher UOM** but each
        item's Higher UOM may differ, so the page renders the sum with a
        ⚠ tooltip explaining the caveat.
      - _children: list of leaf rows (Tabulator dataTree shape)

    INSTRUCTIONS:
      - The grouping is OPTIONAL — the page can render flat (no headers)
        by setting `group_by_item_group: false` in filters.
      - When grouped, leaf rows keep all their fields intact; the page
        toggles their display via Tabulator.
    """
    by_group: dict[str, list[dict]] = {}
    for r in rows:
        by_group.setdefault(r.get("item_group") or "(blank)", []).append(r)
    out: list[dict] = []
    for grp, leaves in sorted(by_group.items()):
        # Sum in higher UOM. The caveat: when leaves use different higher
        # UOMs (some "Carton" some "Kg"), the sum is meaningless. We tag it.
        higher_uoms_in_group = sorted({l.get("higher_uom") or "" for l in leaves})
        mixed = len(higher_uoms_in_group) > 1
        agg = {
            "_group_header":  True,
            "item_code":      "",
            "item_name":      f"▾ {grp}  ({len(leaves)} items)",
            "item_group":     grp,
            "warehouse":      "",
            "stock_uom":      "",
            "higher_uom":     "mixed" if mixed else (higher_uoms_in_group[0] or ""),
            "current_stock_higher_uom":  round(sum(flt(l.get("current_stock_higher_uom")) for l in leaves), 3),
            "shortage_physical":         round(sum(flt(l.get("shortage_physical")) for l in leaves), 3),
            "shortage_projected":        round(sum(flt(l.get("shortage_projected")) for l in leaves), 3),
            "wo_remaining_production":   round(sum(flt(l.get("wo_remaining_production")) for l in leaves), 3),
            "po_remaining":              round(sum(flt(l.get("po_remaining")) for l in leaves), 3),
            "will_consume_open_wo":      round(sum(flt(l.get("will_consume_open_wo")) for l in leaves), 3),
            "will_dispatch_pending_so":  round(sum(flt(l.get("will_dispatch_pending_so")) for l in leaves), 3),
            "net_available":             round(sum(flt(l.get("net_available")) for l in leaves), 3),
            "days_of_cover":             None,        # meaningless when aggregated
            "_tooltips":                 json.dumps({
                "_group": [
                    f"Sub-total of {len(leaves)} items in Item Group: {grp}.",
                    ("⚠ Mixed Higher UOMs in this group — sum is a coarse "
                     "signal only." if mixed else
                     f"All items in this group use Higher UOM = {higher_uoms_in_group[0]}."),
                ],
            }),
            "_flags":     json.dumps({"is_group": True, "mixed_uoms": mixed}),
            "_children":  leaves,
        }
        out.append(agg)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 9. Summary cards.
# ─────────────────────────────────────────────────────────────────────────────
def _summary(rows: list[dict]) -> list[dict]:
    n            = len(rows)
    short_phy    = sum(1 for r in rows if (r.get("shortage_physical") or 0) > 0)
    short_proj   = sum(1 for r in rows if (r.get("shortage_projected") or 0) > 0)
    neg_stock    = sum(1 for r in rows if (r.get("current_stock_stock_uom") or 0) < 0)
    doc_under_7  = sum(1 for r in rows
                       if r.get("days_of_cover") is not None
                       and r.get("days_of_cover") < 7)
    net_negative = sum(1 for r in rows if (r.get("net_available") or 0) < 0)
    return [
        {"value": n,            "label": _("Item × Warehouse Rows"),
         "datatype": "Int",     "indicator": "blue"},
        {"value": short_phy,    "label": _("Physical Shortage (>0)"),
         "datatype": "Int",     "indicator": "red"},
        {"value": short_proj,   "label": _("Projected Shortage (>0)"),
         "datatype": "Int",     "indicator": "orange"},
        {"value": neg_stock,    "label": _("Negative Stock Rows"),
         "datatype": "Int",     "indicator": "red"},
        {"value": doc_under_7,  "label": _("Days of Cover < 7"),
         "datatype": "Int",     "indicator": "red"},
        {"value": net_negative, "label": _("Net Available < 0"),
         "datatype": "Int",     "indicator": "red"},
    ]


# ─────────────────────────────────────────────────────────────────────────────
# 10. Entry — execute(filters).
# ─────────────────────────────────────────────────────────────────────────────
def execute(filters=None):
    """
    Return:
      columns: list of column dicts (Frappe-style + .numeric/.drilldown markers)
      rows:    list of row dicts (LEAF rows by default; group headers when
               `filters.group_by_item_group` is truthy)
      banner:  HTML pending-status banner (consumed by the page top strip)
      chart:   None for now (left null — projection is multi-dim)
      summary: 6 KPI cards
    """
    f = dict(filters or {})

    items, whs = _resolve_candidate_items(f)
    if not items:
        return _columns(), [], _empty_banner(), None, []

    info_map = _get_item_names(items)
    uom_map  = _pick_higher_uoms(items)

    wo_plain, wo_wf, po_plain, po_wf, so_plain, so_wf = _toc_pending_lists()

    stock_map   = _get_stock_by_iw(items, whs)
    wo_prod_map = _get_pending_wo_output_by_iw(items, whs, wo_plain, wo_wf)
    po_map      = _get_pending_po_incoming_by_iw(items, whs, po_plain, po_wf)
    wo_cons_map = _get_open_wo_component_req_by_iw(items, whs, wo_plain, wo_wf)
    so_disp_map = _get_total_pending_so_by_iw(items, whs, so_plain, so_wf)

    # Build the universe of (item, warehouse) pairs that appear in ANY map.
    pairs: set[tuple[str, str]] = set()
    for m in (stock_map, wo_prod_map, po_map, wo_cons_map, so_disp_map):
        for k in m:
            pairs.add(k)
    # Include items that have no Bin row but the user explicitly filtered.
    # (otherwise the row vanishes — confusing for the user).
    if f.get("item"):
        for ic in items:
            if not any(p for p in pairs if p[0] == ic):
                pairs.add((ic, ""))

    leaf_rows: list[dict] = []
    for ic, wh in sorted(pairs):
        info     = info_map.get(ic) or {"item_name": ic, "item_group": "", "adu": 0.0}
        uom_meta = uom_map.get(ic) or {}
        leaf_rows.append(_build_row(
            ic, wh, info, uom_meta,
            stock_map, wo_prod_map, po_map, wo_cons_map, so_disp_map,
        ))

    # Apply "only shortage" filter — done AFTER row build so the totals
    # stay informative when the user clears the filter.
    if f.get("only_shortage"):
        leaf_rows = [r for r in leaf_rows
                     if (r.get("shortage_physical") or 0) > 0
                     or (r.get("shortage_projected") or 0) > 0]

    # Sort: by projected shortage desc, then by net_available asc (most-needed first).
    leaf_rows.sort(key=lambda r: (
        -(r.get("shortage_projected") or 0),
        (r.get("net_available") or 0),
        r.get("item_code") or "",
    ))

    # 2026-05-18 — Always return FLAT leaf rows. Grouping now happens
    # client-side via Tabulator's native `groupBy: "item_group"` config.
    # The old `_aggregate_group_rows` path produced a `_children` shape that
    # required Tabulator dataTree mode, which was hiding rows under certain
    # config combinations. Tabulator's built-in groupBy is more robust and
    # produces collapsible visual headers with sub-totals via groupHeader
    # callback. The `group_by_item_group` filter is still echoed in
    # `filters_used` for the XLSX writer's "filters applied" sheet.
    return _columns(), leaf_rows, _banner(wo_plain, wo_wf, po_plain, po_wf, so_plain, so_wf), None, _summary(leaf_rows)


# ─────────────────────────────────────────────────────────────────────────────
# 11. Pending-status banner (rendered above the grid).
# ─────────────────────────────────────────────────────────────────────────────
def _banner(wo_plain, wo_wf, po_plain, po_wf, so_plain, so_wf) -> str:
    def chips(plain, wf, label, colour):
        items = list(plain) + [f"Workflow: {w}" for w in wf]
        if not items:
            items = ["(none)"]
        chip_html = "".join(
            f'<span class="ipv-chip ipv-chip--{colour}">'
            f'{frappe.utils.escape_html(s)}</span>' for s in items
        )
        return (
            f'<div class="ipv-banner-row">'
            f'<span class="ipv-banner-label">{label}</span>'
            f'<span class="ipv-banner-values">{chip_html}</span>'
            f'</div>'
        )
    return (
        '<div class="ipv-banner">'
        '<div class="ipv-banner-heading">'
        'Pending statuses (TOC Settings — single source of truth)'
        '<a class="ipv-banner-edit" href="/app/toc-settings">Edit</a>'
        '</div>'
        + chips(wo_plain, wo_wf, "Work Order",     "wo")
        + chips(so_plain, so_wf, "Sales Order",    "so")
        + chips(po_plain, po_wf, "Purchase Order", "po")
        + '</div>'
    )


def _empty_banner() -> str:
    return ('<div class="ipv-banner ipv-banner--empty">'
            'No items matched the current filters.</div>')
