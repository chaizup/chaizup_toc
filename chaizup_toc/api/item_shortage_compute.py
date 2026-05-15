# =============================================================================
# CONTEXT: Item Shortage Dashboard — Compute Module
#   Single source of truth for column definitions, SQL helpers, and the
#   drill-down handler used by the Item Shortage Dashboard Page.
#   One row per (Item × Item Minimum Manufacture warehouse rule). Surfaces
#   the full supply / demand picture for items the TOC engine watches:
#   stock, max-level, shortage (with and without expected supply), pending
#   sales orders, dispatch, sales projection, ADU, lead time, safety
#   factor — plus drill-down hooks so the user can see WHICH documents
#   make up each number.
#
#   History: originally lived under
#   `chaizup_toc/chaizup_toc/report/item_shortage_dashboard/` as a Frappe
#   Script Report. The Script Report surface was removed 2026-05-14 per
#   user direction; the compute logic was relocated HERE so the Page can
#   keep working unchanged.
#
#   Audience: Stock Manager, Purchase Manager, Manufacturing Manager and
#   TOC Manager (planners). Sits alongside Production Priority Board /
#   Procurement Action List under the TOC Buffer Management workspace.
#
# MEMORY: chaizup_item_shortage_dashboard.md
#   - ISD-001: pending SO / WO / PO statuses MUST come from TOC Settings
#     (single source of truth, established by TS-001 / BTP-001). The
#     three column header tooltips and the page banner echo whatever
#     the user has configured globally.
#   - ISD-002: max_level, ADU, lead_time_days, safety_factor are read
#     from `tabItem Minimum Manufacture` rows (child of Item.
#     custom_minimum_manufacture). One page row per IMM row → if
#     the same item has rows for 3 warehouses, it appears 3 times.
#     Items without any IMM row still surface ONCE with the user-
#     selected warehouse (or warehouse="" aggregated) so the "shortage"
#     signal isn't lost just because someone hasn't yet populated the
#     IMM rule.
#   - ISD-003: every numeric column is clickable on the frontend →
#     the JS handler calls `get_cell_breakdown` (defined here) with
#     the column name + item_code + warehouse and renders the list of
#     contributing documents in a modal.
#   - ISD-008 (2026-05-14): Script Report deleted. Compute lives here.
#     `execute()` retained so existing callers (and saved Report Views
#     pre-deletion) get a graceful empty payload instead of an import
#     error; the Page entry point is `get_cell_breakdown` + the helpers
#     called from `chaizup_toc.api.item_shortage_api`.
#
# INSTRUCTIONS:
#   - All quantities returned in stock UOM. UOM conversions are returned
#     in a parallel `_uom_conversions` payload so the frontend can render
#     inline both-UOM cells AND tooltips on every numeric cell.
#   - Warehouse filter is multi-select — when set, scopes BIN / WO / PO /
#     SO / DN / IMM rows to that subset.
#   - Item Group filter is multi-select too.
#   - "Will consumed in" filter is a forward-looking month-year (default:
#     current month) — it selects which delivery_date month is treated as
#     "Current Month" demand vs prior carryover.
#   - Universal search is a free-text filter applied across
#     item_code / item_name / item_group at the SQL level.
#
# DANGER ZONE:
#   - Work Order column for "Qty To Manufacture" is `qty` (label only is
#     the long form). NEVER use `qty_to_manufacture` in `tabWork Order`
#     SQL → OperationalError 1054. Production Plan Item DOES have
#     `qty_to_manufacture`. Tests for this in production_overview_api.py.
#   - Sales Projected Items uses field `item` (Link→Item), NOT `item_code`.
#   - `projection_month` is a string ("May"), not an integer.
#   - tabBin warehouse can be NULL for items that never moved; we filter
#     with COALESCE in helpers so NULL warehouses don't crash compute.
#   - One row per IMM rule means an Item appears N times → frontend
#     formatters MUST key state by (item_code + warehouse), not item_code
#     alone, when showing drill-down modals.
#
# RESTRICT:
#   - Do NOT bypass the TOC Settings status lookups by inlining default
#     statuses here. If a future change adds a fourth status family
#     (e.g. Material Request), add it via TOC Settings + a helper in
#     wo_kitting_api, not hardcoded literals.
#   - Do NOT add per-row N+1 SQL — every helper here is bulk by design.
#     Adding a per-row query reintroduces the 30+ second load times the
#     production_overview_api refactor explicitly fixed.
#   - Do NOT rename fieldnames after the page ships; the page binds to
#     them directly via the columns payload.
#   - Do NOT move this module back under `report/` — the Script Report
#     surface is intentionally retired (2026-05-14). The Page is the only
#     supported surface from now on.
# =============================================================================

import frappe
from frappe import _
from frappe.utils import cint, flt, getdate, today


_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# =============================================================================
# CONTEXT: execute() — Frappe Script Report entry point.
#   Returns: (columns, data, message_or_None, chart_or_None, summary_or_None).
# INSTRUCTIONS:
#   - filters is a dict; tolerate missing keys.
#   - Honors saved Report Views (Frappe passes the saved filter set in).
# =============================================================================
def execute(filters=None):
    filters = filters or {}

    columns = _get_columns()
    data = _get_data(filters)
    chart = _get_chart(data)
    summary = _get_summary(data)

    message = _get_banner_message()

    return columns, data, message, chart, summary


# =============================================================================
# COLUMNS
# =============================================================================
def _get_columns():
    # Letter codes in the labels match the user spec for traceability:
    # a=item_code, b=item_name, c=item_group, i=current_stock, l=max_level,
    # m=max_level_pct, o=total_shortage_with_expected, q=shortage_stock_only,
    # p=need_max_level, decision=max(p,o), d=will_be_used_in_open_wos,
    # e=will_be_dispatch_pending_so, f=prev_month_pending_so,
    # g=curr_month_pending_so, h=curr_month_dispatch, j=will_recv_production,
    # k=will_recv_purchase, n=sales_projection, prod=actual_produced_qty.
    return [
        {"fieldname": "item_code", "label": _("Item Code (a)"),
         "fieldtype": "Link", "options": "Item", "width": 150},
        {"fieldname": "item_name", "label": _("Item Name (b)"),
         "fieldtype": "Data", "width": 200},
        {"fieldname": "item_group", "label": _("Item Group (c)"),
         "fieldtype": "Link", "options": "Item Group", "width": 130},
        {"fieldname": "warehouse", "label": _("Warehouse"),
         "fieldtype": "Link", "options": "Warehouse", "width": 140},
        {"fieldname": "stock_uom", "label": _("UOM"),
         "fieldtype": "Link", "options": "UOM", "width": 60},

        # ── Live stock & buffer cap ─────────────────────────────────────
        {"fieldname": "current_stock", "label": _("Current Stock (i)"),
         "fieldtype": "Float", "width": 110, "precision": "2"},
        {"fieldname": "max_level", "label": _("Max Level (l)"),
         "fieldtype": "Float", "width": 110, "precision": "2"},
        {"fieldname": "max_level_pct", "label": _("Max Level % (m)"),
         "fieldtype": "Percent", "width": 105, "precision": "1"},

        # ── Shortage maths ──────────────────────────────────────────────
        {"fieldname": "total_shortage_with_expected",
         "label": _("Total Shortage incl. Expected (o)"),
         "fieldtype": "Float", "width": 165, "precision": "2"},
        {"fieldname": "total_shortage_stock_only",
         "label": _("Total Shortage Stock Only (q)"),
         "fieldtype": "Float", "width": 165, "precision": "2"},
        {"fieldname": "need_as_per_max_level",
         "label": _("Need as per Max Level (p)"),
         "fieldtype": "Float", "width": 150, "precision": "2"},
        {"fieldname": "decision_qty",
         "label": _("Decision Qty max(p,o)"),
         "fieldtype": "Float", "width": 140, "precision": "2"},

        # ── Demand side ─────────────────────────────────────────────────
        {"fieldname": "will_be_used_in_open_wos",
         "label": _("Used in Open WOs (d)"),
         "fieldtype": "Float", "width": 130, "precision": "2"},
        {"fieldname": "will_dispatch_pending_so",
         "label": _("Dispatch vs Total Pending SO (e)"),
         "fieldtype": "Float", "width": 160, "precision": "2"},
        {"fieldname": "prev_month_pending_so",
         "label": _("Prev Month Pending SO (f)"),
         "fieldtype": "Float", "width": 140, "precision": "2"},
        {"fieldname": "curr_month_pending_so",
         "label": _("Curr Month Pending SO (g)"),
         "fieldtype": "Float", "width": 140, "precision": "2"},
        {"fieldname": "curr_month_dispatch",
         "label": _("Curr Month Dispatch (h)"),
         "fieldtype": "Float", "width": 140, "precision": "2"},

        # ── Supply side ─────────────────────────────────────────────────
        {"fieldname": "will_recv_production",
         "label": _("Will Receive from Production (j)"),
         "fieldtype": "Float", "width": 160, "precision": "2"},
        {"fieldname": "will_recv_purchase",
         "label": _("Will Receive from Purchase (k)"),
         "fieldtype": "Float", "width": 160, "precision": "2"},

        # ── Sales Projection + cover percentages ────────────────────────
        {"fieldname": "sales_projection",
         "label": _("Sales Projection (n)"),
         "fieldtype": "Float", "width": 130, "precision": "2"},
        {"fieldname": "sp_cover_pct_sales",
         "label": _("SP Cover % (SO+Disp)"),
         "fieldtype": "Percent", "width": 130, "precision": "1"},
        {"fieldname": "sp_cover_pct_production",
         "label": _("SP Cover % (Prod)"),
         "fieldtype": "Percent", "width": 130, "precision": "1"},

        # ── Production & dispatch totals ────────────────────────────────
        {"fieldname": "actual_produced_qty",
         "label": _("Actual Produced (prod)"),
         "fieldtype": "Float", "width": 130, "precision": "2"},
        {"fieldname": "total_dispatches",
         "label": _("Total Dispatches"),
         "fieldtype": "Float", "width": 130, "precision": "2"},

        # ── Buffer parameters from Item Minimum Manufacture ─────────────
        {"fieldname": "lead_time_days",
         "label": _("Lead Time (d)"),
         "fieldtype": "Int", "width": 100},
        {"fieldname": "safety_factor",
         "label": _("Safety Factor"),
         "fieldtype": "Float", "width": 110, "precision": "2"},
        {"fieldname": "adu",
         "label": _("ADU"),
         "fieldtype": "Float", "width": 100, "precision": "3"},

        # ── Hidden payload for frontend (UOM conversions, etc.) ────────
        {"fieldname": "_uom_conversions",
         "label": _("UOM Conversions"),
         "fieldtype": "Data", "width": 1, "hidden": 1},
        {"fieldname": "_has_pending_so",
         "label": _("Has Pending SO"),
         "fieldtype": "Check", "width": 1, "hidden": 1},
    ]


# =============================================================================
# CONTEXT: _get_data — Build one row per (item × warehouse-rule).
# INSTRUCTIONS:
#   - Source of qualifying items = ANY Item Minimum Manufacture row whose
#     parent Item is enabled AND matches the (optional) item group /
#     warehouse / item_name filters. Items with zero IMM rows still appear
#     once IF they have stock OR pending SO at any warehouse passed in.
#   - All numeric values in stock UOM. UOM conversion factors stored in
#     a parallel payload (`_uom_conversions`) — see column at the bottom.
# DANGER ZONE:
#   - The "Will consumed in" filter selects which month_year is treated
#     as "Current Month" demand. Default = today's month. Previous Month
#     = month - 1 (handles Jan→Dec rollover).
# =============================================================================
def _get_data(filters):
    company         = filters.get("company")
    item_groups     = _csv_to_list(filters.get("item_group"))
    item_names      = _csv_to_list(filters.get("item_name"))
    warehouses_in   = _csv_to_list(filters.get("warehouse"))
    universal       = (filters.get("universal_search") or "").strip()

    # Reference month / year drive "Curr / Prev" SO + dispatch buckets.
    today_d = getdate(today())
    ref_month = cint(filters.get("month")) or today_d.month
    ref_year  = cint(filters.get("year"))  or today_d.year
    if ref_month < 1 or ref_month > 12:
        ref_month = today_d.month
    prev_month = ref_month - 1 if ref_month > 1 else 12
    prev_year  = ref_year if ref_month > 1 else ref_year - 1
    ref_month_name = _MONTH_NAMES[ref_month - 1]

    # TOC Settings: pending status lists for SO / WO / PO. Single source.
    from chaizup_toc.api.wo_kitting_api import (
        _toc_settings_so_statuses,
        _toc_settings_wo_statuses,
        _toc_settings_po_statuses,
    )
    so_statuses_full = _toc_settings_so_statuses()
    wo_statuses_full = _toc_settings_wo_statuses()
    po_statuses_full = _toc_settings_po_statuses()
    so_plain, so_wf  = _split_status_and_workflow(so_statuses_full)
    wo_plain, wo_wf  = _split_status_and_workflow(wo_statuses_full)
    po_plain, po_wf  = _split_status_and_workflow(po_statuses_full)

    # Step 1: collect (item_code, warehouse, imm_row) tuples to display.
    rule_rows = _collect_rule_rows(
        company=company,
        item_groups=item_groups,
        item_names=item_names,
        warehouses=warehouses_in,
        universal=universal,
    )
    if not rule_rows:
        return []

    all_codes = sorted({r["item_code"] for r in rule_rows})
    all_whs   = sorted({r["warehouse"] for r in rule_rows if r.get("warehouse")})

    # Step 2: bulk-fetch metrics. Some are per (item, warehouse), some are
    # per item only — both shapes returned and assembled later per row.
    item_master_map = _get_item_master(all_codes)
    uom_map         = _get_uom_conversions(all_codes)

    stock_map           = _get_stock_by_iw(all_codes, all_whs)
    will_recv_prod_map  = _get_pending_wo_output_by_iw(
        all_codes, all_whs, wo_plain, wo_wf,
    )
    will_recv_buy_map   = _get_pending_po_incoming_by_iw(
        all_codes, all_whs, po_plain, po_wf,
    )
    open_wo_consume_map = _get_open_wo_component_req_by_iw(
        all_codes, all_whs, wo_plain, wo_wf,
    )
    actual_prod_map     = _get_actual_produced_by_iw(
        all_codes, all_whs, ref_month, ref_year,
    )
    curr_disp_map       = _get_dispatch_by_iw(
        all_codes, all_whs, ref_month, ref_year,
    )
    total_disp_map      = _get_total_dispatch_by_iw(all_codes, all_whs)
    curr_so_map         = _get_so_by_iw(
        all_codes, all_whs, so_plain, so_wf, ref_month, ref_year,
    )
    prev_so_map         = _get_so_by_iw(
        all_codes, all_whs, so_plain, so_wf, prev_month, prev_year,
    )
    total_pending_so_map = _get_total_pending_so_by_iw(
        all_codes, all_whs, so_plain, so_wf,
    )
    sales_proj_map      = _get_sales_projection_by_iw(
        all_codes, all_whs, ref_month_name, ref_year,
    )

    # Step 3: assemble rows.
    # ISD-006 (2026-05-14): synthetic rows (warehouse="") aggregate across
    # ALL warehouses for the item — caller passed no warehouse filter and
    # no IMM rule pins this item to a specific warehouse, so the natural
    # interpretation is "global". When the user passes a warehouse filter,
    # synthetic rows are emitted per filter-warehouse (see
    # _collect_rule_rows) and the keyed lookup matches normally.
    def _lookup(metric_map, item_code, wh):
        if wh:
            return flt(metric_map.get((item_code, wh), 0))
        # warehouse="" → sum across every key whose item_code matches.
        total = 0.0
        for (ic2, _wh), v in metric_map.items():
            if ic2 == item_code:
                total += flt(v)
        return total

    out = []
    for r in rule_rows:
        ic     = r["item_code"]
        wh     = r["warehouse"] or ""
        master = item_master_map.get(ic, {})

        i  = _lookup(stock_map, ic, wh)
        j  = _lookup(will_recv_prod_map, ic, wh)
        k  = _lookup(will_recv_buy_map, ic, wh)
        d  = _lookup(open_wo_consume_map, ic, wh)
        e  = _lookup(total_pending_so_map, ic, wh)
        f  = _lookup(prev_so_map, ic, wh)
        g  = _lookup(curr_so_map, ic, wh)
        h  = _lookup(curr_disp_map, ic, wh)
        n  = _lookup(sales_proj_map, ic, wh)
        prod = _lookup(actual_prod_map, ic, wh)
        tot_disp = _lookup(total_disp_map, ic, wh)

        l_max = flt(r.get("max_level", 0))
        # Max Level % — i / l × 100. Guarded against l = 0.
        m = round(i / l_max * 100, 1) if l_max > 0 else 0.0

        # o = (i + j + k) − (d + e), clamped ≥ 0 → "shortage incl expected".
        o = max(0.0, (i + j + k) - (d + e))
        # q = i − (d + e), clamped ≥ 0 → "shortage stock only".
        q = max(0.0, i - (d + e))

        # p = need to reach Max Level after netting demand vs supply.
        #   cover = (i + j + k) − (d + e)   (can be negative)
        #   p     = max(0, l − cover)
        # Same definition as the "Auto on Max Level" Shortage Action mode
        # in production_plan_engine.py (kept consistent on purpose).
        cover = (i + j + k) - (d + e)
        p = max(0.0, l_max - cover) if l_max > 0 else 0.0

        decision_qty = max(p, o)

        # Sales Projection coverage percentages.
        sp_cover_sales = round(n / (g + h) * 100, 1) if (g + h) > 0 else 0.0
        sp_cover_prod  = round(n / (j + prod) * 100, 1) if (j + prod) > 0 else 0.0

        out.append({
            "item_code":   ic,
            "item_name":   master.get("item_name") or "",
            "item_group":  master.get("item_group") or "",
            "warehouse":   wh,
            "stock_uom":   master.get("stock_uom") or "",
            "current_stock":                  round(i, 3),
            "max_level":                      round(l_max, 3),
            "max_level_pct":                  m,
            "total_shortage_with_expected":   round(o, 3),
            "total_shortage_stock_only":      round(q, 3),
            "need_as_per_max_level":          round(p, 3),
            "decision_qty":                   round(decision_qty, 3),
            "will_be_used_in_open_wos":       round(d, 3),
            "will_dispatch_pending_so":       round(e, 3),
            "prev_month_pending_so":          round(f, 3),
            "curr_month_pending_so":          round(g, 3),
            "curr_month_dispatch":            round(h, 3),
            "will_recv_production":           round(j, 3),
            "will_recv_purchase":             round(k, 3),
            "sales_projection":               round(n, 3),
            "sp_cover_pct_sales":             sp_cover_sales,
            "sp_cover_pct_production":        sp_cover_prod,
            "actual_produced_qty":            round(prod, 3),
            "total_dispatches":               round(tot_disp, 3),
            "lead_time_days":                 cint(r.get("lead_time_days") or 0),
            "safety_factor":                  flt(r.get("safety_factor") or 0),
            "adu":                            flt(r.get("adu") or 0),
            # Flag for the JS row formatter: any pending SO at all (used to
            # apply the light-red row background — ISD-004 / 2026-05-14).
            "_has_pending_so":                bool(e > 0),
            "_uom_conversions": frappe.as_json(uom_map.get(ic, [])),
        })

    return out


# =============================================================================
# RULE / ITEM SOURCING
# =============================================================================
def _collect_rule_rows(company, item_groups, item_names, warehouses, universal):
    """
    Return list of dicts: {item_code, warehouse, max_level, lead_time_days,
    safety_factor, adu}. One row per applicable Item Minimum Manufacture
    rule (= one row per item-warehouse pair the planner watches).

    Items WITHOUT any IMM row still surface — they get a synthetic row
    per filter-warehouse (or one row with blank warehouse if no warehouse
    filter is set). This keeps "shortage" visibility for items that
    haven't been onboarded into the IMM table yet.
    """
    # ── Step 1: IMM rows that match filters ────────────────────────────
    where = ["i.disabled = 0"]
    params = []
    if item_groups:
        where.append("i.item_group IN %(item_groups)s")
        params.append(("item_groups", tuple(item_groups)))
    if item_names:
        where.append("i.name IN %(item_names)s")
        params.append(("item_names", tuple(item_names)))
    if universal:
        where.append("(i.name LIKE %(univ)s OR i.item_name LIKE %(univ)s "
                     "OR i.item_group LIKE %(univ)s)")
        params.append(("univ", f"%{universal}%"))
    if warehouses:
        where.append("imm.warehouse IN %(warehouses)s")
        params.append(("warehouses", tuple(warehouses)))

    where_sql = " AND ".join(where)
    p = dict(params)

    rows = frappe.db.sql(
        f"""
        SELECT
            i.name                    AS item_code,
            imm.warehouse             AS warehouse,
            COALESCE(imm.max_level, 0)        AS max_level,
            COALESCE(imm.lead_time_days, 0)   AS lead_time_days,
            COALESCE(imm.safety_factor, 0)    AS safety_factor,
            COALESCE(imm.adu, 0)              AS adu
        FROM `tabItem` i
        JOIN `tabItem Minimum Manufacture` imm ON imm.parent = i.name
        WHERE {where_sql}
        ORDER BY i.item_name, imm.warehouse
        """,
        p,
        as_dict=True,
    )
    seen = {(r.item_code, r.warehouse) for r in rows}
    out = [dict(r) for r in rows]

    # ── Step 2: surface items with NO IMM row but matching filters that
    #            have stock or any pending SO. Synthetic row per warehouse
    #            (or a single blank-warehouse row when no warehouse filter).
    extra_where = ["i.disabled = 0"]
    extra_params = []
    if item_groups:
        extra_where.append("i.item_group IN %(item_groups)s")
        extra_params.append(("item_groups", tuple(item_groups)))
    if item_names:
        extra_where.append("i.name IN %(item_names)s")
        extra_params.append(("item_names", tuple(item_names)))
    if universal:
        extra_where.append("(i.name LIKE %(univ)s OR i.item_name LIKE %(univ)s "
                           "OR i.item_group LIKE %(univ)s)")
        extra_params.append(("univ", f"%{universal}%"))
    # Limit to items that already have an IMM row OR have stock OR have any
    # pending SO. The cleanest is to ask: "did we miss items the planner
    # filtered on?" — only meaningful when an item_group / item_name /
    # universal filter is set. Without those filters there's no signal
    # for which "unhandled" items to surface, so we stop here.
    if not (item_groups or item_names or universal):
        return out

    extra_where_sql = " AND ".join(extra_where)
    ep = dict(extra_params)
    extra_codes = frappe.db.sql_list(
        f"""
        SELECT i.name FROM `tabItem` i
        LEFT JOIN `tabItem Minimum Manufacture` imm ON imm.parent = i.name
        WHERE {extra_where_sql}
          AND imm.name IS NULL
        """,
        ep,
    )
    if not extra_codes:
        return out

    synth_whs = warehouses or [""]
    for code in extra_codes:
        for wh in synth_whs:
            key = (code, wh)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "item_code":      code,
                "warehouse":      wh,
                "max_level":      0,
                "lead_time_days": 0,
                "safety_factor":  0,
                "adu":            0,
            })
    return out


def _get_item_master(item_codes):
    if not item_codes:
        return {}
    rows = frappe.db.sql(
        """SELECT name, item_name, item_group, stock_uom
           FROM `tabItem` WHERE name IN %(codes)s""",
        {"codes": tuple(item_codes)}, as_dict=True,
    )
    return {r.name: dict(r) for r in rows}


def _get_uom_conversions(item_codes):
    if not item_codes:
        return {}
    rows = frappe.db.sql(
        """SELECT parent AS item_code, uom, conversion_factor
           FROM `tabUOM Conversion Detail`
           WHERE parent IN %(codes)s AND conversion_factor > 0
           ORDER BY conversion_factor ASC""",
        {"codes": tuple(item_codes)}, as_dict=True,
    )
    out = {}
    for r in rows:
        out.setdefault(r.item_code, []).append({
            "uom": r.uom, "factor": flt(r.conversion_factor),
        })
    return out


# =============================================================================
# CONTEXT: Per (item, warehouse) bulk metrics.
#   Each helper returns a dict keyed by `(item_code, warehouse)` tuple so
#   the assembler in _get_data can look up exactly what to render in the
#   matching report row. Warehouse may be "" — see _collect_rule_rows.
# INSTRUCTIONS:
#   - All sums clamped ≥ 0 with GREATEST(...,0) where reversal SLEs etc.
#     can produce momentary negatives.
#   - Helpers accept an explicit `warehouses` list to scope SQL — empty
#     list means "all warehouses" (rule rows with blank wh land here).
# DANGER ZONE:
#   - Workflow-state branch only activates when the doctype actually has
#     `workflow_state` (silently dropped otherwise). Mirrors the engine.
# =============================================================================
def _split_status_and_workflow(status_list):
    """Split `["A", "Workflow: B"]` → (["A"], ["B"])."""
    plain, wf = [], []
    for s in status_list or []:
        if isinstance(s, str) and s.startswith("Workflow: "):
            wf.append(s[len("Workflow: "):])
        elif isinstance(s, str) and s:
            plain.append(s)
    return plain, wf


def _csv_to_list(value):
    """Filter values arrive as list, JSON string, or comma string."""
    if value in (None, ""):
        return []
    if isinstance(value, list):
        return [str(v) for v in value if v]
    if isinstance(value, str):
        v = value.strip()
        if v.startswith("["):
            try:
                parsed = frappe.parse_json(v)
                if isinstance(parsed, list):
                    return [str(x) for x in parsed if x]
            except Exception:
                pass
        return [x.strip() for x in v.split(",") if x.strip()]
    return []


def _wh_clause(warehouses, column_expr):
    """SQL fragment: ' AND <expr> IN (...)' or '' when warehouses empty."""
    if not warehouses:
        return ""
    return f" AND {column_expr} IN %(warehouses)s"


def _get_stock_by_iw(item_codes, warehouses):
    """{(item, wh): actual_qty} from tabBin."""
    if not item_codes:
        return {}
    where = ["item_code IN %(codes)s"]
    p = {"codes": tuple(item_codes)}
    if warehouses:
        where.append("warehouse IN %(warehouses)s")
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""SELECT item_code, warehouse, SUM(actual_qty) AS qty
            FROM `tabBin` WHERE {" AND ".join(where)}
            GROUP BY item_code, warehouse""",
        p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _build_status_clause(plain, wf, doctype, table_alias, doc_alias):
    """Generic Submitted+status OR Draft+workflow_state filter."""
    parts, params = [], {}
    if plain:
        parts.append(f"({doc_alias}.docstatus = 1 AND {doc_alias}.status IN %(_st_plain)s)")
        params["_st_plain"] = tuple(plain)
    if wf and frappe.db.has_column(doctype, "workflow_state"):
        parts.append(
            f"({doc_alias}.docstatus = 0 AND {doc_alias}.workflow_state IN %(_st_wf)s)"
        )
        params["_st_wf"] = tuple(wf)
    if not parts:
        return "1=0", {}
    return "(" + " OR ".join(parts) + ")", params


def _get_pending_wo_output_by_iw(item_codes, warehouses, wo_plain, wo_wf):
    """Pending qty on open Work Orders producing each item, scoped by
    fg_warehouse. {(item, fg_warehouse): pending_qty}."""
    if not item_codes:
        return {}
    clause, sp = _build_status_clause(wo_plain, wo_wf, "Work Order", "tabWork Order", "wo")
    p = {"codes": tuple(item_codes), **sp}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND wo.fg_warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT wo.production_item AS item_code,
               wo.fg_warehouse    AS warehouse,
               SUM(GREATEST(wo.qty - IFNULL(wo.produced_qty,0), 0)) AS qty
        FROM `tabWork Order` wo
        WHERE wo.production_item IN %(codes)s
          AND {clause}
          {wh_sql}
        GROUP BY wo.production_item, wo.fg_warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_pending_po_incoming_by_iw(item_codes, warehouses, po_plain, po_wf):
    """Pending qty on open Purchase Orders for each item × target warehouse.
    Multiplies by conversion_factor → stock UOM."""
    if not item_codes:
        return {}
    clause, sp = _build_status_clause(po_plain, po_wf, "Purchase Order",
                                      "tabPurchase Order", "po")
    p = {"codes": tuple(item_codes), **sp}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND poi.warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT poi.item_code, poi.warehouse,
               SUM(GREATEST((poi.qty - IFNULL(poi.received_qty,0))
                             * IFNULL(poi.conversion_factor,1), 0)) AS qty
        FROM `tabPurchase Order Item` poi
        JOIN `tabPurchase Order` po ON po.name = poi.parent
        WHERE poi.item_code IN %(codes)s
          AND {clause}
          {wh_sql}
        GROUP BY poi.item_code, poi.warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_open_wo_component_req_by_iw(item_codes, warehouses, wo_plain, wo_wf):
    """For each item × source_warehouse, how much it'll be consumed by open WOs.
    Uses Work Order Item.required_qty − transferred_qty (in stock UOM)."""
    if not item_codes:
        return {}
    clause, sp = _build_status_clause(wo_plain, wo_wf, "Work Order",
                                      "tabWork Order", "wo")
    p = {"codes": tuple(item_codes), **sp}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND woi.source_warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT woi.item_code, woi.source_warehouse AS warehouse,
               SUM(GREATEST(woi.required_qty - IFNULL(woi.transferred_qty,0),0)) AS qty
        FROM `tabWork Order Item` woi
        JOIN `tabWork Order` wo ON wo.name = woi.parent
        WHERE woi.item_code IN %(codes)s
          AND {clause}
          {wh_sql}
        GROUP BY woi.item_code, woi.source_warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_actual_produced_by_iw(item_codes, warehouses, month, year):
    """Manufacture STE finished-item qty in given month (target warehouse)."""
    if not item_codes:
        return {}
    p = {"codes": tuple(item_codes), "m": cint(month), "y": cint(year)}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND sed.t_warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT sed.item_code, sed.t_warehouse AS warehouse,
               SUM(sed.transfer_qty) AS qty
        FROM `tabStock Entry Detail` sed
        JOIN `tabStock Entry` se ON se.name = sed.parent
        WHERE se.docstatus = 1
          AND se.stock_entry_type = 'Manufacture'
          AND sed.is_finished_item = 1
          AND MONTH(se.posting_date) = %(m)s
          AND YEAR(se.posting_date)  = %(y)s
          AND sed.item_code IN %(codes)s
          {wh_sql}
        GROUP BY sed.item_code, sed.t_warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_dispatch_by_iw(item_codes, warehouses, month, year):
    """Submitted Delivery Note qty in given month, scoped by line warehouse."""
    if not item_codes:
        return {}
    p = {"codes": tuple(item_codes), "m": cint(month), "y": cint(year)}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND dni.warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT dni.item_code, dni.warehouse, SUM(dni.stock_qty) AS qty
        FROM `tabDelivery Note Item` dni
        JOIN `tabDelivery Note` dn ON dn.name = dni.parent
        WHERE dn.docstatus = 1
          AND MONTH(dn.posting_date) = %(m)s
          AND YEAR(dn.posting_date)  = %(y)s
          AND dni.item_code IN %(codes)s
          {wh_sql}
        GROUP BY dni.item_code, dni.warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_total_dispatch_by_iw(item_codes, warehouses):
    """All-time submitted Delivery Note qty (warehouse-scoped)."""
    if not item_codes:
        return {}
    p = {"codes": tuple(item_codes)}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND dni.warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT dni.item_code, dni.warehouse, SUM(dni.stock_qty) AS qty
        FROM `tabDelivery Note Item` dni
        JOIN `tabDelivery Note` dn ON dn.name = dni.parent
        WHERE dn.docstatus = 1
          AND dni.item_code IN %(codes)s
          {wh_sql}
        GROUP BY dni.item_code, dni.warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_so_by_iw(item_codes, warehouses, so_plain, so_wf, month, year):
    """Pending SO qty (stock_qty − delivered) for given delivery month, scoped by
    SO Item warehouse (falls back to SO.set_warehouse). Stock UOM."""
    if not item_codes:
        return {}
    clause, sp = _build_status_clause(so_plain, so_wf, "Sales Order",
                                      "tabSales Order", "so")
    p = {"codes": tuple(item_codes), "m": cint(month), "y": cint(year), **sp}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT soi.item_code,
               COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) AS warehouse,
               SUM(GREATEST(soi.stock_qty - IFNULL(soi.delivered_qty,0)
                            * IFNULL(soi.conversion_factor,1), 0)) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code IN %(codes)s
          AND MONTH(soi.delivery_date) = %(m)s
          AND YEAR(soi.delivery_date)  = %(y)s
          AND {clause}
          {wh_sql}
        GROUP BY soi.item_code, warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_total_pending_so_by_iw(item_codes, warehouses, so_plain, so_wf):
    """All pending SO qty regardless of delivery month, warehouse-scoped."""
    if not item_codes:
        return {}
    clause, sp = _build_status_clause(so_plain, so_wf, "Sales Order",
                                      "tabSales Order", "so")
    p = {"codes": tuple(item_codes), **sp}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT soi.item_code,
               COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) AS warehouse,
               SUM(GREATEST(soi.stock_qty - IFNULL(soi.delivered_qty,0)
                            * IFNULL(soi.conversion_factor,1), 0)) AS qty
        FROM `tabSales Order Item` soi
        JOIN `tabSales Order` so ON so.name = soi.parent
        WHERE soi.item_code IN %(codes)s
          AND {clause}
          {wh_sql}
        GROUP BY soi.item_code, warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


def _get_sales_projection_by_iw(item_codes, warehouses, month_name, year):
    """Sales Projection qty per item × source_warehouse for given month/year."""
    if not item_codes:
        return {}
    p = {"codes": tuple(item_codes), "mn": month_name, "y": cint(year)}
    wh_sql = ""
    if warehouses:
        wh_sql = " AND sp.source_warehouse IN %(warehouses)s"
        p["warehouses"] = tuple(warehouses)
    rows = frappe.db.sql(
        f"""
        SELECT spi.item AS item_code, sp.source_warehouse AS warehouse,
               SUM(spi.qty_in_stock_uom) AS qty
        FROM `tabSales Projected Items` spi
        JOIN `tabSales Projection` sp ON sp.name = spi.parent
        WHERE sp.projection_month = %(mn)s
          AND sp.projection_year  = %(y)s
          AND sp.docstatus IN (0, 1)
          AND spi.item IN %(codes)s
          {wh_sql}
        GROUP BY spi.item, sp.source_warehouse
        """, p, as_dict=True,
    )
    return {(r.item_code, r.warehouse or ""): flt(r.qty) for r in rows}


# =============================================================================
# CHART / SUMMARY / BANNER
# =============================================================================
def _get_chart(data):
    if not data:
        return None
    buckets = {"Red (Shortage)": 0, "Amber (<50% Max)": 0, "OK": 0}
    for d in data:
        if d.get("total_shortage_with_expected", 0) > 0:
            buckets["Red (Shortage)"] += 1
        elif d.get("max_level_pct", 0) < 50 and d.get("max_level", 0) > 0:
            buckets["Amber (<50% Max)"] += 1
        else:
            buckets["OK"] += 1
    return {
        "data": {
            "labels": list(buckets.keys()),
            "datasets": [{"name": "Items", "values": list(buckets.values())}],
        },
        "type": "pie",
        "colors": ["#E74C3C", "#F39C12", "#27AE60"],
        "height": 260,
    }


def _get_summary(data):
    if not data:
        return []
    total = len(data)
    shortage = sum(1 for d in data if d.get("total_shortage_with_expected", 0) > 0)
    stock_shortage = sum(1 for d in data if d.get("total_shortage_stock_only", 0) > 0)
    below_50 = sum(1 for d in data
                   if d.get("max_level", 0) > 0 and d.get("max_level_pct", 0) < 50)
    return [
        {"value": total,          "label": _("Item × Warehouse Rows"),
         "datatype": "Int", "indicator": "blue"},
        {"value": shortage,       "label": _("Items in Shortage (o>0)"),
         "datatype": "Int", "indicator": "red"},
        {"value": stock_shortage, "label": _("Stock-Only Shortage (q>0)"),
         "datatype": "Int", "indicator": "orange"},
        {"value": below_50,       "label": _("Below 50% Max Level"),
         "datatype": "Int", "indicator": "yellow"},
    ]


def _get_banner_message():
    """Returns an HTML banner shown in the report header — surfaces the
    TOC Settings pending-status lists so the planner sees what counts
    as 'pending' for SO / WO / PO without leaving the report."""
    try:
        from chaizup_toc.api.wo_kitting_api import get_toc_pending_filters
        f = get_toc_pending_filters()
    except Exception:
        return ""
    wo = ", ".join(f.get("wo") or []) or "—"
    so = ", ".join(f.get("so") or []) or "—"
    po = ", ".join(f.get("po") or []) or "—"
    return (
        f"<div class='isd-banner' style='padding:8px 12px;background:#F8FAFC;"
        f"border:1px solid #E2E8F0;border-radius:6px;font-size:12px;line-height:1.6'>"
        f"<b>Pending Statuses (from <a href='/app/toc-settings'>TOC Settings</a>)</b><br>"
        f"<b>Sales Order:</b> {frappe.utils.escape_html(so)}<br>"
        f"<b>Work Order:</b> {frappe.utils.escape_html(wo)}<br>"
        f"<b>Purchase Order:</b> {frappe.utils.escape_html(po)}"
        f"</div>"
    )


# =============================================================================
# CONTEXT: get_cell_breakdown — drill-down API for clickable cells.
#   Called by the report JS when the user clicks any numeric cell. Returns
#   the list of contributing source documents (id, qty, status, etc.) so
#   the JS can render a modal explaining "where this number came from".
# INSTRUCTIONS:
#   - whitelisted; respects role-based access via Frappe permission system
#     (Item is the ref_doctype, all roles listed in the .json can read).
#   - `column` identifies which metric to break down; `item_code` and
#     `warehouse` scope the query identically to the main report.
#   - Returns: {"rows": [...], "total": float, "formula": "..."}.
# DANGER ZONE:
#   - Do NOT expose data outside the user's permitted item / warehouse
#     scope here — the parent report inherits Item permissions, so the
#     drill-down does too (caller already filtered to a row they can see).
# =============================================================================
@frappe.whitelist()
def get_cell_breakdown(column, item_code, warehouse=None, month=None, year=None):
    column = (column or "").strip()
    item_code = (item_code or "").strip()
    warehouse = (warehouse or "").strip() or None
    today_d = getdate(today())
    m = cint(month) or today_d.month
    y = cint(year) or today_d.year
    prev_m = m - 1 if m > 1 else 12
    prev_y = y if m > 1 else y - 1

    from chaizup_toc.api.wo_kitting_api import (
        _toc_settings_so_statuses,
        _toc_settings_wo_statuses,
        _toc_settings_po_statuses,
    )
    so_plain, so_wf = _split_status_and_workflow(_toc_settings_so_statuses())
    wo_plain, wo_wf = _split_status_and_workflow(_toc_settings_wo_statuses())
    po_plain, po_wf = _split_status_and_workflow(_toc_settings_po_statuses())

    handlers = {
        "current_stock":              lambda: _bd_stock(item_code, warehouse),
        "will_recv_production":       lambda: _bd_pending_wo(item_code, warehouse, wo_plain, wo_wf),
        "will_recv_purchase":         lambda: _bd_pending_po(item_code, warehouse, po_plain, po_wf),
        "will_be_used_in_open_wos":   lambda: _bd_wo_component(item_code, warehouse, wo_plain, wo_wf),
        "will_dispatch_pending_so":   lambda: _bd_so(item_code, warehouse, so_plain, so_wf, None, None),
        "curr_month_pending_so":      lambda: _bd_so(item_code, warehouse, so_plain, so_wf, m, y),
        "prev_month_pending_so":      lambda: _bd_so(item_code, warehouse, so_plain, so_wf, prev_m, prev_y),
        "curr_month_dispatch":        lambda: _bd_dn(item_code, warehouse, m, y),
        "total_dispatches":           lambda: _bd_dn(item_code, warehouse, None, None),
        "actual_produced_qty":        lambda: _bd_ste(item_code, warehouse, m, y),
        "sales_projection":           lambda: _bd_sp(item_code, warehouse, _MONTH_NAMES[m - 1], y),
    }
    handler = handlers.get(column)
    if not handler:
        return {"rows": [], "total": 0, "formula": f"No drill-down for column '{column}'."}
    rows, total, formula = handler()
    return {
        "rows": rows,
        "total": round(flt(total), 3),
        "formula": formula,
        "column": column,
        "item_code": item_code,
        "warehouse": warehouse,
    }


def _bd_stock(item_code, warehouse):
    where = "item_code = %(c)s"
    p = {"c": item_code}
    if warehouse:
        where += " AND warehouse = %(w)s"
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT warehouse, actual_qty, ordered_qty, planned_qty, projected_qty
            FROM `tabBin` WHERE {where} ORDER BY warehouse""",
        p, as_dict=True,
    )
    total = sum(flt(r.actual_qty) for r in rows)
    return (
        [{
            "doc": r.warehouse, "doc_type": "Bin",
            "qty": flt(r.actual_qty),
            "extra": (f"Ordered: {flt(r.ordered_qty):.2f} | "
                      f"Planned: {flt(r.planned_qty):.2f} | "
                      f"Projected: {flt(r.projected_qty):.2f}"),
        } for r in rows],
        total,
        "Current Stock = Σ Bin.actual_qty at the selected warehouse(s).",
    )


def _bd_pending_wo(item_code, warehouse, wo_plain, wo_wf):
    clause, sp = _build_status_clause(wo_plain, wo_wf, "Work Order", "tabWork Order", "wo")
    p = {"c": item_code, **sp}
    wh_sql = ""
    if warehouse:
        wh_sql = " AND wo.fg_warehouse = %(w)s"
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT wo.name AS doc, wo.qty AS planned_qty,
                   IFNULL(wo.produced_qty,0) AS produced_qty,
                   GREATEST(wo.qty - IFNULL(wo.produced_qty,0), 0) AS pending,
                   wo.status, wo.fg_warehouse
            FROM `tabWork Order` wo
            WHERE wo.production_item = %(c)s AND {clause} {wh_sql}
            ORDER BY wo.creation DESC""",
        p, as_dict=True,
    )
    total = sum(flt(r.pending) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Work Order",
            "qty": flt(r.pending),
            "extra": (f"Planned: {flt(r.planned_qty):.2f} | "
                      f"Produced: {flt(r.produced_qty):.2f} | "
                      f"FG WH: {r.fg_warehouse} | Status: {r.status}"),
        } for r in rows],
        total,
        "Σ (Work Order.qty − produced_qty) on open Work Orders (status from TOC Settings).",
    )


def _bd_pending_po(item_code, warehouse, po_plain, po_wf):
    clause, sp = _build_status_clause(po_plain, po_wf, "Purchase Order", "tabPurchase Order", "po")
    p = {"c": item_code, **sp}
    wh_sql = ""
    if warehouse:
        wh_sql = " AND poi.warehouse = %(w)s"
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT poi.parent AS doc, poi.qty, IFNULL(poi.received_qty,0) AS received_qty,
                   IFNULL(poi.conversion_factor,1) AS cf,
                   GREATEST((poi.qty - IFNULL(poi.received_qty,0))
                             * IFNULL(poi.conversion_factor,1), 0) AS pending_stock,
                   po.status, poi.warehouse, poi.uom
            FROM `tabPurchase Order Item` poi
            JOIN `tabPurchase Order` po ON po.name = poi.parent
            WHERE poi.item_code = %(c)s AND {clause} {wh_sql}
            ORDER BY po.creation DESC""",
        p, as_dict=True,
    )
    total = sum(flt(r.pending_stock) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Purchase Order",
            "qty": flt(r.pending_stock),
            "extra": (f"Ordered: {flt(r.qty):.2f} {r.uom} | "
                      f"Received: {flt(r.received_qty):.2f} {r.uom} | "
                      f"Factor: {flt(r.cf):.4f} | WH: {r.warehouse} | "
                      f"Status: {r.status}"),
        } for r in rows],
        total,
        "Σ (PO.qty − received_qty) × conversion_factor on open Purchase Orders.",
    )


def _bd_wo_component(item_code, warehouse, wo_plain, wo_wf):
    clause, sp = _build_status_clause(wo_plain, wo_wf, "Work Order", "tabWork Order", "wo")
    p = {"c": item_code, **sp}
    wh_sql = ""
    if warehouse:
        wh_sql = " AND woi.source_warehouse = %(w)s"
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT wo.name AS doc, wo.production_item, woi.required_qty,
                   IFNULL(woi.transferred_qty,0) AS transferred_qty,
                   GREATEST(woi.required_qty - IFNULL(woi.transferred_qty,0), 0) AS pending,
                   wo.status, woi.source_warehouse
            FROM `tabWork Order Item` woi
            JOIN `tabWork Order` wo ON wo.name = woi.parent
            WHERE woi.item_code = %(c)s AND {clause} {wh_sql}
            ORDER BY wo.creation DESC""",
        p, as_dict=True,
    )
    total = sum(flt(r.pending) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Work Order",
            "qty": flt(r.pending),
            "extra": (f"Producing: {r.production_item} | "
                      f"Required: {flt(r.required_qty):.2f} | "
                      f"Transferred: {flt(r.transferred_qty):.2f} | "
                      f"Src WH: {r.source_warehouse} | Status: {r.status}"),
        } for r in rows],
        total,
        "Σ (WO Item.required_qty − transferred_qty) where this item is a component.",
    )


def _bd_so(item_code, warehouse, so_plain, so_wf, month, year):
    clause, sp = _build_status_clause(so_plain, so_wf, "Sales Order", "tabSales Order", "so")
    p = {"c": item_code, **sp}
    extra_where = []
    if month and year:
        extra_where.append("MONTH(soi.delivery_date) = %(m)s")
        extra_where.append("YEAR(soi.delivery_date) = %(y)s")
        p["m"] = cint(month); p["y"] = cint(year)
    if warehouse:
        extra_where.append("COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) = %(w)s")
        p["w"] = warehouse
    extra_sql = (" AND " + " AND ".join(extra_where)) if extra_where else ""
    rows = frappe.db.sql(
        f"""SELECT so.name AS doc, soi.stock_qty,
                   IFNULL(soi.delivered_qty,0) AS delivered_qty,
                   IFNULL(soi.conversion_factor,1) AS cf,
                   GREATEST(soi.stock_qty - IFNULL(soi.delivered_qty,0)
                            * IFNULL(soi.conversion_factor,1), 0) AS pending_stock,
                   so.status, so.customer, soi.delivery_date,
                   COALESCE(NULLIF(soi.warehouse,''), so.set_warehouse) AS warehouse
            FROM `tabSales Order Item` soi
            JOIN `tabSales Order` so ON so.name = soi.parent
            WHERE soi.item_code = %(c)s AND {clause} {extra_sql}
            ORDER BY soi.delivery_date""",
        p, as_dict=True,
    )
    total = sum(flt(r.pending_stock) for r in rows)
    label = (
        f"Σ (SO Item.stock_qty − delivered) for delivery in "
        f"{_MONTH_NAMES[month-1]} {year}." if month and year
        else "Σ (SO Item.stock_qty − delivered) on all pending Sales Orders."
    )
    return (
        [{
            "doc": r.doc, "doc_type": "Sales Order",
            "qty": flt(r.pending_stock),
            "extra": (f"Customer: {r.customer} | "
                      f"Delivery: {r.delivery_date} | "
                      f"WH: {r.warehouse} | Status: {r.status}"),
        } for r in rows],
        total,
        label,
    )


def _bd_dn(item_code, warehouse, month, year):
    where = ["dn.docstatus = 1", "dni.item_code = %(c)s"]
    p = {"c": item_code}
    if month and year:
        where.append("MONTH(dn.posting_date) = %(m)s")
        where.append("YEAR(dn.posting_date) = %(y)s")
        p["m"] = cint(month); p["y"] = cint(year)
    if warehouse:
        where.append("dni.warehouse = %(w)s")
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT dn.name AS doc, dni.stock_qty, dn.posting_date,
                   dn.customer, dni.warehouse
            FROM `tabDelivery Note Item` dni
            JOIN `tabDelivery Note` dn ON dn.name = dni.parent
            WHERE {" AND ".join(where)}
            ORDER BY dn.posting_date DESC""",
        p, as_dict=True,
    )
    total = sum(flt(r.stock_qty) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Delivery Note",
            "qty": flt(r.stock_qty),
            "extra": (f"Customer: {r.customer} | "
                      f"Date: {r.posting_date} | WH: {r.warehouse}"),
        } for r in rows],
        total,
        "Σ Delivery Note Item.stock_qty (Submitted DNs).",
    )


def _bd_ste(item_code, warehouse, month, year):
    where = ["se.docstatus = 1", "se.stock_entry_type = 'Manufacture'",
             "sed.is_finished_item = 1", "sed.item_code = %(c)s",
             "MONTH(se.posting_date) = %(m)s", "YEAR(se.posting_date) = %(y)s"]
    p = {"c": item_code, "m": cint(month), "y": cint(year)}
    if warehouse:
        where.append("sed.t_warehouse = %(w)s")
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT se.name AS doc, sed.transfer_qty, se.posting_date,
                   sed.t_warehouse AS warehouse, se.work_order
            FROM `tabStock Entry Detail` sed
            JOIN `tabStock Entry` se ON se.name = sed.parent
            WHERE {" AND ".join(where)}
            ORDER BY se.posting_date DESC""",
        p, as_dict=True,
    )
    total = sum(flt(r.transfer_qty) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Stock Entry",
            "qty": flt(r.transfer_qty),
            "extra": (f"Date: {r.posting_date} | WH: {r.warehouse} | "
                      f"WO: {r.work_order or '—'}"),
        } for r in rows],
        total,
        "Σ Manufacture STE finished-item transfer_qty for the reference month.",
    )


def _bd_sp(item_code, warehouse, month_name, year):
    where = ["sp.docstatus IN (0,1)", "spi.item = %(c)s",
             "sp.projection_month = %(mn)s", "sp.projection_year = %(y)s"]
    p = {"c": item_code, "mn": month_name, "y": cint(year)}
    if warehouse:
        where.append("sp.source_warehouse = %(w)s")
        p["w"] = warehouse
    rows = frappe.db.sql(
        f"""SELECT sp.name AS doc, spi.qty_in_stock_uom AS qty,
                   sp.source_warehouse AS warehouse, sp.docstatus
            FROM `tabSales Projected Items` spi
            JOIN `tabSales Projection` sp ON sp.name = spi.parent
            WHERE {" AND ".join(where)}""",
        p, as_dict=True,
    )
    total = sum(flt(r.qty) for r in rows)
    return (
        [{
            "doc": r.doc, "doc_type": "Sales Projection",
            "qty": flt(r.qty),
            "extra": (f"WH: {r.warehouse} | "
                      f"Submitted: {'Yes' if r.docstatus == 1 else 'Draft'}"),
        } for r in rows],
        total,
        "Σ Sales Projected Items.qty_in_stock_uom for the reference month.",
    )
