# Copyright (c) 2026, chaizup_toc and contributors
# For license information, please see license.txt
"""
============================================================================
 Batch-wise Stock Balance  —  Script Report  (module: Chaizup Toc)
============================================================================
CONTEXT:
    An ERPNext-v16 "Stock Balance"-style report, but resolved PER BATCH and
    shown in BOTH UOMs. For each batch it reports the on-hand quantity (in the
    item stock UOM and the next-higher UOM) as on `to_date`, plus the voucher
    that originally created the batch (Work Order / Purchase Receipt / Stock
    Entry, hyperlinked).

MEMORY / ERPNEXT v16 QUIRK (the crux of this report):
    On this site batches are tracked 100% through the **Serial and Batch
    Bundle** — `Stock Ledger Entry.batch_no` is ALWAYS NULL (0 rows). The
    per-batch movement lives in `Serial and Batch Entry` (child of the bundle):
        sbe.qty           — signed qty (+in / -out), SUMs to SLE.actual_qty
        sbe.parent        — = SLE.serial_and_batch_bundle
        sbe.batch_no      — the batch
    So batch balances MUST be derived from the bundle entries, never from
    SLE.batch_no. A legacy UNION branch (direct SLE.batch_no) is kept for
    robustness on rows that pre-date the bundle model.

DANGER:
    - Only `is_cancelled = 0` SLEs count. Cancelled ledger rows must never be
      summed or balances double-count / go negative.
    - `qty in stock uom` = SUM of signed batch qty for posting_date <= to_date
      (true closing balance as on to_date). Do NOT bound the lower side by
      from_date for the qty — opening stock received before from_date is real
      on-hand stock and must be included.
    - `qty in higher uom` = stock_qty / conversion_factor, where the higher UOM
      is the SMALLEST `UOM Conversion Detail.conversion_factor > 1` (closest
      higher unit). NEVER multiply; items without a CF>1 show only the stock UOM.

RESTRICT:
    - Filters: from_date, to_date, company (single), warehouse (multi),
      item_code (multi), item_group (multi), batch_no (multi), show_zero_balance.
    - `from_date` pairs with `show_zero_balance`: by default only batches with a
      non-zero on-hand balance are shown; tick "Show Zero Balance" to also reveal
      batches that had movement within [from_date, to_date] but netted to zero.
    - All user values are passed as bound parameters (never string-formatted into
      SQL). Only fixed column-name fragments are concatenated.

DB OBJECTS READ (never written): `tabStock Ledger Entry`,
    `tabSerial and Batch Entry`, `tabItem`, `tabBatch`, `tabUOM Conversion Detail`.
============================================================================
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate, nowdate

# Quantities below this absolute value are treated as zero (float dust guard).
_QTY_TOL = 0.0001


def execute(filters=None):
    filters = frappe._dict(filters or {})
    _apply_defaults(filters)
    columns = get_columns()
    data = get_data(filters)
    return columns, data


# ---------------------------------------------------------------------------
# CONTEXT: sensible server-side fallbacks so the report never crashes when run
#          via API / scheduler without the JS defaults having populated dates.
# ---------------------------------------------------------------------------
def _apply_defaults(filters):
    if not filters.get("to_date"):
        filters.to_date = nowdate()
    if not filters.get("from_date"):
        # Wide default — a year back — so on-hand stock is never hidden.
        filters.from_date = frappe.utils.add_to_date(getdate(filters.to_date), years=-1)


def get_columns():
    # NOTE: `origin_doctype` is a hidden helper column that the visible
    #       `origin_voucher` Dynamic Link reads to know which doctype to open.
    return [
        {"label": _("Item Code"), "fieldname": "item_code", "fieldtype": "Link",
         "options": "Item", "width": 130},
        {"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data",
         "width": 220},
        {"label": _("Item Group"), "fieldname": "item_group", "fieldtype": "Link",
         "options": "Item Group", "width": 140},
        {"label": _("Batch"), "fieldname": "batch_no", "fieldtype": "Link",
         "options": "Batch", "width": 150},
        {"label": _("Qty (Stock UOM)"), "fieldname": "qty", "fieldtype": "Float",
         "width": 130, "precision": 3},
        {"label": _("Stock UOM"), "fieldname": "stock_uom", "fieldtype": "Link",
         "options": "UOM", "width": 100},
        {"label": _("Qty (Higher UOM)"), "fieldname": "qty_higher", "fieldtype": "Float",
         "width": 130, "precision": 3},
        {"label": _("Higher UOM"), "fieldname": "higher_uom", "fieldtype": "Data",
         "width": 100},
        {"label": _("Origin Voucher"), "fieldname": "origin_voucher",
         "fieldtype": "Dynamic Link", "options": "origin_doctype", "width": 180},
        {"label": _("Origin Voucher Type"), "fieldname": "origin_doctype",
         "fieldtype": "Data", "width": 150},
    ]


def get_data(filters):
    sle_cond, params = _build_conditions(filters)
    params["from_date"] = getdate(filters.from_date)
    params["to_date"] = getdate(filters.to_date)
    params["show_zero"] = 1 if filters.get("show_zero_balance") else 0

    # --- Batch-level movement unit -----------------------------------------
    # Branch A (v16): explode each SLE's Serial and Batch Bundle into its
    #   Serial and Batch Entry rows -> (batch_no, signed qty).
    # Branch B (legacy): SLEs that carry batch_no directly (no bundle).
    # Both bounded to posting_date <= to_date so SUM(qty) = closing balance.
    movement = f"""
        SELECT sle.item_code, sle.warehouse, sle.company,
               sbe.batch_no AS batch_no, sle.posting_date AS posting_date,
               sbe.qty AS qty
        FROM `tabStock Ledger Entry` sle
        INNER JOIN `tabSerial and Batch Entry` sbe
                ON sbe.parent = sle.serial_and_batch_bundle
        WHERE sle.is_cancelled = 0
          AND IFNULL(sle.serial_and_batch_bundle, '') <> ''
          AND IFNULL(sbe.batch_no, '') <> ''
          AND sle.posting_date <= %(to_date)s
          {sle_cond}
          {_batch_clause('sbe', filters)}

        UNION ALL

        SELECT sle.item_code, sle.warehouse, sle.company,
               sle.batch_no AS batch_no, sle.posting_date AS posting_date,
               sle.actual_qty AS qty
        FROM `tabStock Ledger Entry` sle
        WHERE sle.is_cancelled = 0
          AND IFNULL(sle.serial_and_batch_bundle, '') = ''
          AND IFNULL(sle.batch_no, '') <> ''
          AND sle.posting_date <= %(to_date)s
          {sle_cond}
          {_batch_clause('sle', filters)}
    """

    item_group_cond = ""
    if _as_list(filters.get("item_group")):
        item_group_cond = "AND i.item_group IN %(item_group)s"

    query = f"""
        SELECT
            m.item_code                              AS item_code,
            i.item_name                              AS item_name,
            i.item_group                             AS item_group,
            i.stock_uom                              AS stock_uom,
            m.batch_no                               AS batch_no,
            bt.reference_doctype                     AS origin_doctype,
            bt.reference_name                        AS origin_voucher,
            ROUND(SUM(m.qty), 6)                     AS qty,
            ROUND(SUM(CASE WHEN m.posting_date BETWEEN %(from_date)s AND %(to_date)s
                           THEN ABS(m.qty) ELSE 0 END), 6) AS period_activity
        FROM ( {movement} ) m
        LEFT JOIN `tabItem`  i  ON i.name  = m.item_code
        LEFT JOIN `tabBatch` bt ON bt.name = m.batch_no
        WHERE 1 = 1 {item_group_cond}
        GROUP BY m.item_code, m.batch_no
        HAVING ABS(qty) > {_QTY_TOL}
            OR (%(show_zero)s = 1 AND period_activity > {_QTY_TOL})
        ORDER BY i.item_group, m.item_code, m.batch_no
    """

    rows = frappe.db.sql(query, params, as_dict=True)

    # Enrich with the higher UOM (one batched lookup) + qty in higher UOM.
    higher = _higher_uom_map({r.item_code for r in rows if r.item_code})
    for r in rows:
        h = higher.get(r.item_code)
        if h and flt(h["factor"]) > 1:
            r.higher_uom = h["uom"]
            r.qty_higher = round(flt(r.qty) / flt(h["factor"]), 3)
        else:
            r.higher_uom = ""
            r.qty_higher = None
        r.qty = round(flt(r.qty), 3)
        r.pop("period_activity", None)
    return rows


# ---------------------------------------------------------------------------
# Filter -> SQL helpers. Every user value is a BOUND PARAM; only fixed column
# names are concatenated into the fragment strings.
# ---------------------------------------------------------------------------
def _build_conditions(filters):
    """Conditions that live on the Stock Ledger Entry (`sle`) alias, shared by
    both UNION branches. Returns (sql_fragment, params)."""
    cond = []
    params = {}
    if filters.get("company"):
        cond.append("AND sle.company = %(company)s")
        params["company"] = filters.company
    wh = _as_list(filters.get("warehouse"))
    if wh:
        cond.append("AND sle.warehouse IN %(warehouse)s")
        params["warehouse"] = tuple(wh)
    items = _as_list(filters.get("item_code"))
    if items:
        cond.append("AND sle.item_code IN %(item_code)s")
        params["item_code"] = tuple(items)
    # batch param is shared by both branches (sbe.batch_no / sle.batch_no)
    batches = _as_list(filters.get("batch_no"))
    if batches:
        params["batch_no"] = tuple(batches)
    if _as_list(filters.get("item_group")):
        params["item_group"] = tuple(_as_list(filters.get("item_group")))
    return "\n          ".join(cond), params


def _batch_clause(alias, filters):
    """Branch-specific batch filter (sbe.batch_no for the bundle branch,
    sle.batch_no for the legacy branch). Uses the shared %(batch_no)s param."""
    if _as_list(filters.get("batch_no")):
        return f"AND {alias}.batch_no IN %(batch_no)s"
    return ""


def _higher_uom_map(item_codes):
    """{item_code: {"uom", "factor"}} — closest higher UOM (smallest CF>1).
    Items without an alternate UOM are simply absent (caller shows stock UOM)."""
    if not item_codes:
        return {}
    rows = frappe.db.sql(
        """
        SELECT parent AS item_code, uom, conversion_factor
        FROM   `tabUOM Conversion Detail`
        WHERE  parent IN %(items)s AND conversion_factor > 1
        ORDER BY parent, conversion_factor ASC
        """,
        {"items": list(item_codes)},
        as_dict=True,
    )
    out = {}
    for r in rows:
        if r.item_code not in out:  # first = smallest factor = closest higher unit
            out[r.item_code] = {"uom": r.uom, "factor": flt(r.conversion_factor)}
    return out


def _as_list(value):
    """Normalise a MultiSelectList filter value (list | csv-string | None) to a
    clean list of non-empty strings."""
    if not value:
        return []
    if isinstance(value, str):
        value = [v.strip() for v in value.split(",")]
    return [str(v).strip() for v in value if str(v).strip()]
