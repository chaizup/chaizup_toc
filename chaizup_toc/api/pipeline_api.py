"""
pipeline_api.py — Supply Chain Tracker Data API

Fetches the complete open-action lifecycle for all TOC-managed items across both
the purchase chain (MR → RFQ → SQ → PO → PR → QI) and the production chain
(MR → Production Plan → Work Order → Job Card → Stock Entry → FG output).

Returns two representations of the same data:
  • nodes + edges  → for the Pipeline (column) view
  • tracks         → for the Tracker (item-centric) view

Each document node carries enriched metadata: days_open, is_overdue, next_action,
supplier, warehouse, and amounts — so the UI has everything it needs without
extra round trips.
"""

import frappe
from frappe.utils import today, add_days, date_diff, getdate


# ──────────────────────────────────────────────────────────────────────────────
#  Public API
# ──────────────────────────────────────────────────────────────────────────────

@frappe.whitelist()
def get_pipeline_data(
    item_code=None,
    buffer_type=None,
    zone=None,
    days_back=30,
    supplier=None,
    warehouse=None,
    show_overdue_only=0,
):
    """
    Full supply-chain graph for all TOC-managed items.

    Args:
        item_code         : Exact item code filter (optional)
        buffer_type       : "FG" | "SFG" | "RM" | "PM" | None
        zone              : "Red" | "Yellow" | "Green" | "Black" | None
        days_back         : Documents created in the last N days (default 30)
        supplier          : Filter documents by supplier name (partial match)
        warehouse         : Filter items by their buffer warehouse
        show_overdue_only : 1 = return only items with at least one overdue document

    Returns:
        {
          "nodes": [...],
          "edges": [...],
          "tracks": [...],
          "summary": {...},
          "stage_counts": {...},
          "meta": {...}
        }
    """
    days_back = int(days_back or 30)
    show_overdue_only = int(show_overdue_only or 0)
    from_date = add_days(today(), -days_back)

    # 1. Seed: TOC-managed items + non-TOC items with active transactions
    items = _fetch_items(item_code, buffer_type, warehouse, from_date)
    if not items:
        return _empty_response()

    item_codes = [i["item_code"] for i in items]

    # 2. TOC buffer overlay (once, shared by all callers)
    toc_map = _get_toc_map(item_codes)

    # 3a. Apply buffer_type filter using toc_map (buffer type is now resolved server-side)
    if buffer_type and buffer_type != "All":
        item_codes = [ic for ic in item_codes if toc_map.get(ic, {}).get("buffer_type") == buffer_type]
        items = [i for i in items if i["item_code"] in item_codes]
        if not items:
            return _empty_response()

    # 3b. Apply zone filter — narrow item_codes
    if zone and zone != "All":
        item_codes = [ic for ic in item_codes if toc_map.get(ic, {}).get("zone") == zone]
        items = [i for i in items if i["item_code"] in item_codes]
        if not items:
            return _empty_response()

    # 4. Fetch all pipeline documents (broad — status filter happens at item level below)
    mrs  = _fetch_material_requests(item_codes, from_date, supplier)
    rfqs = _fetch_rfqs(item_codes, from_date, supplier)
    pps  = _fetch_production_plans(item_codes, from_date)
    wos  = _fetch_work_orders(item_codes)
    rfq_names = list({r["name"] for r in rfqs})
    sqs  = _fetch_supplier_quotations(rfq_names, supplier)
    wo_names  = list({w["name"] for w in wos})
    pos  = _fetch_purchase_orders(item_codes, from_date, supplier)
    jcs  = _fetch_job_cards(wo_names)
    po_names  = list({p["name"] for p in pos})
    prs  = _fetch_purchase_receipts(po_names, supplier)
    pr_names  = list({p["name"] for p in prs})
    qis  = _fetch_quality_inspections(pr_names)
    ses  = _fetch_stock_entries(wo_names)

    # 5. Item-level active filter:
    #    Only show items that have at least one open/pending operation.
    #    For those items, show their FULL document chain (completed steps included).
    active_ics = _build_active_item_codes(mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses)
    items      = [i for i in items if i["item_code"] in active_ics]
    if not items:
        return _empty_response()

    # Narrow each document list to only those belonging to active items
    mrs  = [d for d in mrs  if d.get("item_code")      in active_ics]
    rfqs = [d for d in rfqs if d.get("item_code")      in active_ics]
    pps  = [d for d in pps  if d.get("item_code")      in active_ics]
    wos  = [d for d in wos  if d.get("production_item") in active_ics]
    pos  = [d for d in pos  if d.get("item_code")      in active_ics]

    # Child docs: filter by their (now-filtered) parent names
    active_rfq_names = {r["name"] for r in rfqs}
    active_wo_names  = {w["name"] for w in wos}
    active_po_names  = {p["name"] for p in pos}
    sqs = [d for d in sqs if d.get("request_for_quotation") in active_rfq_names]
    jcs = [d for d in jcs if d.get("work_order")            in active_wo_names]
    prs = [d for d in prs if d.get("purchase_order")        in active_po_names]

    active_pr_names = {p["name"] for p in prs}
    qis = [d for d in qis if d.get("reference_name") in active_pr_names]
    ses = [d for d in ses if d.get("work_order")      in active_wo_names]

    # 6. Build nodes (enrich each with days_open, is_overdue, next_action)
    output_ics = {
        i["item_code"]
        for i in items
        if toc_map.get(i["item_code"], {}).get("buffer_type") in ("FG", "SFG")
    }

    nodes, edges = _build_graph(
        items, toc_map, output_ics,
        mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses
    )

    # 7. Build item-centric tracks
    tracks = _build_tracks(
        items, toc_map,
        mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses, output_ics
    )

    # 8. Optional: keep only items with ≥1 overdue document
    if show_overdue_only:
        overdue_item_codes = {
            t["item_code"] for t in tracks if t.get("overdue_count", 0) > 0
        }
        tracks = [t for t in tracks if t["item_code"] in overdue_item_codes]

    # 9. Summary + stage bottleneck counts
    summary      = _build_summary(items, toc_map, mrs, wos, pos)
    stage_counts = _build_stage_counts(nodes)

    return {
        "nodes": nodes,
        "edges": edges,
        "tracks": tracks,
        "summary": summary,
        "stage_counts": stage_counts,
        "meta": {
            "from_date": str(from_date),
            "today": str(today()),
            "total_items": len(items),
            "days_back": days_back,
        },
    }


@frappe.whitelist()
def get_filter_options():
    """Return distinct values for filter dropdowns (suppliers, item_groups, warehouses)."""
    suppliers = frappe.db.sql("""
        SELECT DISTINCT supplier FROM `tabPurchase Order`
        WHERE docstatus < 2 AND supplier IS NOT NULL AND supplier != ''
        ORDER BY supplier LIMIT 200
    """, as_dict=False)

    item_groups = frappe.db.sql("""
        SELECT DISTINCT item_group FROM `tabItem`
        WHERE item_group IS NOT NULL AND item_group != '' AND disabled = 0
        ORDER BY item_group LIMIT 200
    """, as_dict=False)

    warehouses = frappe.db.sql("""
        SELECT DISTINCT name FROM `tabWarehouse`
        WHERE is_group = 0 AND disabled = 0
        ORDER BY name LIMIT 200
    """, as_dict=False)

    return {
        "suppliers":   [r[0] for r in suppliers],
        "item_groups": [r[0] for r in item_groups],
        "warehouses":  [r[0] for r in warehouses],
    }


# ──────────────────────────────────────────────────────────────────────────────
#  Fetch helpers
# ──────────────────────────────────────────────────────────────────────────────

def _fetch_items(item_code, buffer_type, warehouse, from_date):
    """
    Return items to track.

    • Always includes TOC-managed items (custom_toc_enabled = 1).
    • When buffer_type is "All" (no TOC-specific filter active), also pulls in
      every item that has open purchase or production activity in the window,
      giving a complete company-wide view even for items not yet under TOC.
    """
    _item_fields = ["name as item_code", "item_name", "custom_toc_default_bom", "item_group"]

    # ── 1. TOC-managed items ──────────────────────────────────────────────────
    # Note: buffer_type filter is applied AFTER toc_map is built (in get_pipeline_data step 3a)
    # because buffer type is now resolved from TOC Settings → Item Group Rules, not from Item field.
    toc_filters = {"custom_toc_enabled": 1}
    if item_code:
        toc_filters["name"] = item_code

    toc_items = frappe.get_all(
        "Item",
        filters=toc_filters,
        fields=_item_fields,
        ignore_permissions=True,
        limit=500,
    )
    toc_codes = {i["item_code"] for i in toc_items}

    # ── 2. Non-TOC items from active transactions ────────────────────────────
    # Only when no buffer_type / zone-specific filter is active (those are
    # TOC-specific and would produce meaningless results for non-TOC items).
    extra_items = []
    if not item_code and (not buffer_type or buffer_type == "All"):
        active_codes = _item_codes_from_transactions(from_date) - toc_codes
        if active_codes:
            extra_items = frappe.get_all(
                "Item",
                filters=[["name", "in", list(active_codes)]],
                fields=_item_fields,
                ignore_permissions=True,
                limit=2000,
            )
    elif item_code and item_code not in toc_codes:
        # Specific item lookup even if not TOC-enabled
        extra_items = frappe.get_all(
            "Item",
            filters={"name": item_code},
            fields=_item_fields,
            ignore_permissions=True,
            limit=1,
        )

    items = toc_items + extra_items

    # ── 3. Warehouse filter ──────────────────────────────────────────────────
    if warehouse and items:
        item_codes = [i["item_code"] for i in items]
        ph = _ph(item_codes)
        # TOC buffer rules
        toc_wh = {r[0] for r in frappe.db.sql(f"""
            SELECT DISTINCT item_code FROM `tabTOC Item Buffer`
            WHERE item_code IN ({ph}) AND warehouse = %s
        """, tuple(item_codes) + (warehouse,), as_dict=False)}
        # MR warehouse (covers non-TOC items)
        mr_wh = {r[0] for r in frappe.db.sql(f"""
            SELECT DISTINCT mri.item_code
            FROM `tabMaterial Request Item` mri
            WHERE mri.item_code IN ({ph}) AND mri.warehouse = %s
        """, tuple(item_codes) + (warehouse,), as_dict=False)}
        allowed = toc_wh | mr_wh
        items = [i for i in items if i["item_code"] in allowed]

    return items


def _item_codes_from_transactions(from_date):
    """
    Return the set of item codes that have open purchase/production activity
    in the given time window.  Used to seed the non-TOC item list.
    """
    codes = set()

    # Open Material Requests
    rows = frappe.db.sql("""
        SELECT DISTINCT mri.item_code
        FROM `tabMaterial Request` mr
        JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
        WHERE mr.docstatus < 2
          AND mr.status NOT IN ('Cancelled', 'Stopped')
          AND mr.transaction_date >= %s
    """, (from_date,), as_dict=False)
    codes.update(r[0] for r in rows if r[0])

    # Active Work Orders (no date filter — may have started before the window)
    rows = frappe.db.sql("""
        SELECT DISTINCT production_item
        FROM `tabWork Order`
        WHERE docstatus < 2
          AND status NOT IN ('Completed', 'Stopped', 'Cancelled')
    """, as_dict=False)
    codes.update(r[0] for r in rows if r[0])

    # Open Purchase Orders
    rows = frappe.db.sql("""
        SELECT DISTINCT poi.item_code
        FROM `tabPurchase Order` po
        JOIN `tabPurchase Order Item` poi ON poi.parent = po.name
        WHERE po.docstatus < 2
          AND po.status NOT IN ('Cancelled', 'Closed')
          AND po.transaction_date >= %s
    """, (from_date,), as_dict=False)
    codes.update(r[0] for r in rows if r[0])

    return codes


def _get_toc_map(item_codes):
    result = {}
    if not item_codes:
        return result
    try:
        from chaizup_toc.toc_engine.buffer_calculator import calculate_all_buffers
        all_buffers = calculate_all_buffers()
        for b in all_buffers:
            ic = b.get("item_code", "")
            if ic not in item_codes:
                continue
            if ic not in result or b.get("bp_pct", 0) > result[ic].get("bp_pct", 0):
                result[ic] = b
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC SCT: buffer calculation failed")
    return result


def _fetch_material_requests(item_codes, from_date, supplier=None):
    if not item_codes:
        return []
    ph = _ph(item_codes)
    return frappe.db.sql(f"""
        SELECT DISTINCT
            mr.name, mr.title, mr.material_request_type, mr.status, mr.docstatus,
            mr.schedule_date, mr.transaction_date, mr.creation,
            mr.custom_toc_zone, mr.custom_toc_bp_pct, mr.custom_toc_recorded_by,
            mr.custom_toc_target_buffer, mr.custom_toc_inventory_position,
            mri.item_code, mri.warehouse,
            mri.qty as required_qty
        FROM `tabMaterial Request` mr
        JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
        WHERE mri.item_code IN ({ph})
          AND mr.docstatus < 2
          AND mr.status NOT IN ('Cancelled', 'Stopped')
          AND mr.transaction_date >= %s
        ORDER BY mr.creation DESC
        LIMIT 400
    """, tuple(item_codes) + (from_date,), as_dict=True)


def _fetch_rfqs(item_codes, from_date, supplier=None):
    if not item_codes:
        return []
    ph = _ph(item_codes)
    supplier_clause = "AND rfqs.supplier LIKE %s" if supplier else ""
    args = tuple(item_codes) + (from_date,) + ((f"%{supplier}%",) if supplier else ())
    return frappe.db.sql(f"""
        SELECT
            rfq.name, rfq.status, rfq.transaction_date, rfq.creation,
            rfqi.item_code, rfqi.material_request, rfqi.qty,
            GROUP_CONCAT(DISTINCT rfqs.supplier ORDER BY rfqs.supplier SEPARATOR ', ') AS suppliers
        FROM `tabRequest for Quotation` rfq
        JOIN `tabRequest for Quotation Item` rfqi ON rfqi.parent = rfq.name
        LEFT JOIN `tabRequest for Quotation Supplier` rfqs ON rfqs.parent = rfq.name
        WHERE rfqi.item_code IN ({ph})
          AND rfq.docstatus < 2
          AND rfq.transaction_date >= %s
          {supplier_clause}
        GROUP BY rfq.name, rfqi.item_code, rfqi.material_request
        ORDER BY rfq.creation DESC
        LIMIT 300
    """, args, as_dict=True)


def _fetch_production_plans(item_codes, from_date):
    if not item_codes:
        return []
    ph = _ph(item_codes)
    return frappe.db.sql(f"""
        SELECT DISTINCT
            pp.name, pp.status, pp.posting_date, pp.creation,
            ppi.item_code, ppi.material_request,
            ppi.planned_qty
        FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent = pp.name
        WHERE ppi.item_code IN ({ph})
          AND pp.docstatus < 2
          AND pp.posting_date >= %s
        ORDER BY pp.creation DESC
        LIMIT 300
    """, tuple(item_codes) + (from_date,), as_dict=True)


def _fetch_supplier_quotations(rfq_names, supplier=None):
    if not rfq_names:
        return []
    ph = _ph(rfq_names)
    supplier_clause = "AND sq.supplier LIKE %s" if supplier else ""
    args = tuple(rfq_names) + ((f"%{supplier}%",) if supplier else ())
    return frappe.db.sql(f"""
        SELECT DISTINCT
            sq.name, sq.supplier, sq.status, sq.transaction_date, sq.creation,
            sq.grand_total,
            sqi.item_code, sqi.request_for_quotation, sqi.qty, sqi.rate
        FROM `tabSupplier Quotation` sq
        JOIN `tabSupplier Quotation Item` sqi ON sqi.parent = sq.name
        WHERE sqi.request_for_quotation IN ({ph})
          AND sq.docstatus < 2
          {supplier_clause}
        ORDER BY sq.creation DESC
        LIMIT 300
    """, args, as_dict=True)


def _fetch_work_orders(item_codes):
    if not item_codes:
        return []
    ph = _ph(item_codes)
    return frappe.db.sql(f"""
        SELECT name, production_item, status, qty, produced_qty,
               planned_start_date, planned_end_date, production_plan,
               actual_start_date, actual_end_date, creation,
               custom_toc_zone, custom_toc_bp_pct
        FROM `tabWork Order`
        WHERE production_item IN ({ph})
          AND docstatus < 2
          AND status NOT IN ('Completed', 'Stopped', 'Cancelled')
        ORDER BY creation DESC
        LIMIT 300
    """, tuple(item_codes), as_dict=True)


def _fetch_purchase_orders(item_codes, from_date, supplier=None):
    if not item_codes:
        return []
    ph = _ph(item_codes)
    supplier_clause = "AND po.supplier LIKE %s" if supplier else ""
    args = tuple(item_codes) + (from_date,) + ((f"%{supplier}%",) if supplier else ())
    return frappe.db.sql(f"""
        SELECT DISTINCT
            po.name, po.supplier, po.status, po.grand_total,
            po.transaction_date, po.creation,
            poi.item_code, poi.schedule_date, poi.qty, poi.received_qty,
            poi.supplier_quotation, poi.material_request,
            poi.rate, poi.amount
        FROM `tabPurchase Order` po
        JOIN `tabPurchase Order Item` poi ON poi.parent = po.name
        WHERE poi.item_code IN ({ph})
          AND po.docstatus < 2
          AND po.status NOT IN ('Cancelled', 'Closed')
          AND po.transaction_date >= %s
          {supplier_clause}
        ORDER BY po.creation DESC
        LIMIT 300
    """, args, as_dict=True)


def _fetch_job_cards(wo_names):
    if not wo_names:
        return []
    ph = _ph(wo_names)
    return frappe.db.sql(f"""
        SELECT name, work_order, production_item, operation,
               status, for_quantity, total_completed_qty, creation,
               expected_start_date, expected_end_date,
               actual_start_date, actual_end_date
        FROM `tabJob Card`
        WHERE work_order IN ({ph})
          AND docstatus < 2
        ORDER BY creation DESC
        LIMIT 400
    """, tuple(wo_names), as_dict=True)


def _fetch_purchase_receipts(po_names, supplier=None):
    if not po_names:
        return []
    ph = _ph(po_names)
    supplier_clause = "AND pr.supplier LIKE %s" if supplier else ""
    args = tuple(po_names) + ((f"%{supplier}%",) if supplier else ())
    return frappe.db.sql(f"""
        SELECT DISTINCT
            pr.name, pr.supplier, pr.status, pr.posting_date, pr.creation,
            pri.item_code, pri.purchase_order, pri.qty, pri.received_qty,
            pri.rejected_qty
        FROM `tabPurchase Receipt` pr
        JOIN `tabPurchase Receipt Item` pri ON pri.parent = pr.name
        WHERE pri.purchase_order IN ({ph})
          AND pr.docstatus < 2
          {supplier_clause}
        ORDER BY pr.creation DESC
        LIMIT 300
    """, args, as_dict=True)


def _fetch_quality_inspections(pr_names):
    if not pr_names:
        return []
    ph = _ph(pr_names)
    return frappe.db.sql(f"""
        SELECT name, reference_name, reference_type, item_code, status,
               inspection_type, creation
        FROM `tabQuality Inspection`
        WHERE reference_name IN ({ph})
          AND reference_type = 'Purchase Receipt'
          AND docstatus < 2
        ORDER BY creation DESC
        LIMIT 300
    """, tuple(pr_names), as_dict=True)


def _fetch_stock_entries(wo_names):
    if not wo_names:
        return []
    ph = _ph(wo_names)
    return frappe.db.sql(f"""
        SELECT DISTINCT
            se.name, se.work_order, se.stock_entry_type, se.docstatus,
            se.posting_date, se.creation,
            sed.item_code, sed.t_warehouse, sed.qty as produced_qty
        FROM `tabStock Entry` se
        JOIN `tabStock Entry Detail` sed ON sed.parent = se.name
        WHERE se.work_order IN ({ph})
          AND se.docstatus < 2
          AND se.stock_entry_type IN ('Manufacture', 'Material Transfer for Manufacture')
          AND sed.t_warehouse IS NOT NULL
        ORDER BY se.creation DESC
        LIMIT 400
    """, tuple(wo_names), as_dict=True)


# ──────────────────────────────────────────────────────────────────────────────
#  Graph builder (pipeline view)
# ──────────────────────────────────────────────────────────────────────────────

def _build_graph(items, toc_map, output_ics, mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses):
    nodes = []

    for item in items:
        ic  = item["item_code"]
        toc = toc_map.get(ic, {})
        nodes.append(_item_node(ic, item, toc))

    for mr  in mrs:  nodes.append(_mr_node(mr))
    for rfq in rfqs: nodes.append(_rfq_node(rfq))
    for pp  in pps:  nodes.append(_pp_node(pp))
    for sq  in sqs:  nodes.append(_sq_node(sq))
    for wo  in wos:  nodes.append(_wo_node(wo, toc_map.get(wo.get("production_item", ""), {})))
    for po  in pos:  nodes.append(_po_node(po))
    for jc  in jcs:  nodes.append(_jc_node(jc))
    for pr  in prs:  nodes.append(_pr_node(pr))
    for qi  in qis:  nodes.append(_qi_node(qi))
    for se  in ses:  nodes.append(_se_node(se))

    for ic in output_ics:
        toc = toc_map.get(ic, {})
        nodes.append(_output_node(ic, toc))

    # Deduplicate nodes by id — multi-item documents (e.g. a PO that covers two
    # active items) produce one SQL row per item_code, which creates duplicate
    # node ids.  Keep first occurrence (preserves the highest-priority item row).
    seen_ids = set()
    deduped = []
    for n in nodes:
        if n["id"] not in seen_ids:
            seen_ids.add(n["id"])
            deduped.append(n)
    nodes = deduped

    edges = _build_edges(items, mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses, output_ics)
    return nodes, edges


# ──────────────────────────────────────────────────────────────────────────────
#  Track builder (item-centric view)
# ──────────────────────────────────────────────────────────────────────────────

def _build_tracks(items, toc_map, mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses, output_ics):
    """Build one track per TOC item with all its open documents and metadata."""

    # Index each document type by item_code for fast lookup
    mrs_by_ic  = _idx_by(mrs,  "item_code")
    rfqs_by_ic = _idx_by(rfqs, "item_code")
    pps_by_ic  = _idx_by(pps,  "item_code")
    wos_by_ic  = _idx_by(wos,  "production_item")
    pos_by_ic  = _idx_by(pos,  "item_code")

    # Index child docs by parent ref
    sqs_by_rfq = _idx_by(sqs, "request_for_quotation")
    jcs_by_wo  = _idx_by(jcs, "work_order")
    prs_by_po  = _idx_by(prs, "purchase_order")
    qis_by_pr  = _idx_by(qis, "reference_name")
    ses_by_wo  = _idx_by(ses, "work_order")

    tracks = []
    for item in items:
        ic   = item["item_code"]
        toc  = toc_map.get(ic, {})
        bt   = toc.get("buffer_type", "")

        # Gather all documents for this item
        item_mrs  = mrs_by_ic.get(ic, [])
        item_rfqs = rfqs_by_ic.get(ic, [])
        item_pps  = pps_by_ic.get(ic, [])
        item_wos  = wos_by_ic.get(ic, [])
        item_pos  = pos_by_ic.get(ic, [])

        # Child docs
        item_sqs = []
        for rfq in item_rfqs:
            item_sqs += sqs_by_rfq.get(rfq["name"], [])

        item_jcs = []
        for wo in item_wos:
            item_jcs += jcs_by_wo.get(wo["name"], [])

        item_prs = []
        for po in item_pos:
            item_prs += prs_by_po.get(po["name"], [])

        item_qis = []
        for pr in item_prs:
            item_qis += qis_by_pr.get(pr["name"], [])

        item_ses = []
        for wo in item_wos:
            item_ses += ses_by_wo.get(wo["name"], [])

        # Build document timeline (all docs in stage order)
        docs = []
        for doc in item_mrs:  docs.append(_enrich_doc("Material Request",      doc, "material_request"))
        for doc in item_rfqs: docs.append(_enrich_doc("Request for Quotation",  doc, "rfq_pp"))
        for doc in item_pps:  docs.append(_enrich_doc("Production Plan",        doc, "rfq_pp"))
        for doc in item_sqs:  docs.append(_enrich_doc("Supplier Quotation",     doc, "sq_wo"))
        for doc in item_wos:  docs.append(_enrich_doc("Work Order",             doc, "sq_wo"))
        for doc in item_pos:  docs.append(_enrich_doc("Purchase Order",         doc, "po_jc"))
        for doc in item_jcs:  docs.append(_enrich_doc("Job Card",               doc, "po_jc"))
        for doc in item_prs:  docs.append(_enrich_doc("Purchase Receipt",       doc, "receipt_qc"))
        for doc in item_qis:  docs.append(_enrich_doc("Quality Inspection",     doc, "receipt_qc"))
        for doc in item_ses:  docs.append(_enrich_doc("Stock Entry",            doc, "receipt_qc"))

        overdue_count  = sum(1 for d in docs if d.get("is_overdue"))
        pending_count  = sum(1 for d in docs if not d.get("is_closed"))
        stuck_stage    = _detect_stuck_stage(docs)
        next_action    = _compute_next_action(bt, item_mrs, item_rfqs, item_pps, item_sqs,
                                               item_wos, item_pos, item_jcs, item_prs, item_ses)

        tracks.append({
            "item_code":    ic,
            "item_name":    item.get("item_name", ic),
            "item_group":   item.get("item_group", ""),
            "buffer_type":  bt,
            "toc_enabled":  bool(toc),  # False for items not under TOC management
            "zone":         toc.get("zone", ""),
            "bp_pct":       round(toc.get("bp_pct", 0) or 0, 1),
            "target_buffer":round(toc.get("target_buffer", 0) or 0, 2),
            "inventory_position": round(toc.get("inventory_position", 0) or 0, 2),
            "on_hand":      round(toc.get("on_hand", 0) or 0, 2),
            "order_qty":    round(toc.get("order_qty", 0) or 0, 2),
            "warehouse":    toc.get("warehouse", ""),
            "next_action":  next_action,
            "stuck_stage":  stuck_stage,
            "pending_count":pending_count,
            "overdue_count":overdue_count,
            "doc_count":    len(docs),
            "documents":    docs,
        })

    # Sort: Red+Black first, then Yellow, then Green; within zone by BP% descending
    zone_order = {"Black": 0, "Red": 1, "Yellow": 2, "Green": 3, "": 4}
    tracks.sort(key=lambda t: (zone_order.get(t["zone"], 4), -t["bp_pct"]))
    return tracks


def _enrich_doc(doctype, doc, stage):
    """Add days_open, is_overdue, is_closed, supplier, display_name to a raw SQL row."""
    creation = doc.get("creation")
    days_open = int(date_diff(today(), creation)) if creation else 0

    # Determine the due date based on doctype
    due = (doc.get("schedule_date") or doc.get("planned_end_date")
           or doc.get("expected_end_date") or doc.get("posting_date"))
    is_overdue = False
    days_overdue = 0
    if due:
        try:
            diff = date_diff(today(), due)
            if diff > 0:
                is_overdue = True
                days_overdue = int(diff)
        except Exception:
            pass

    status = doc.get("status", "")
    is_closed = status in ("Completed", "Closed", "Submitted", "To Bill", "Cancelled", "Stopped")

    supplier = doc.get("supplier") or doc.get("suppliers") or ""
    qty   = doc.get("qty") or doc.get("planned_qty") or doc.get("required_qty") or 0
    rate  = doc.get("rate") or 0
    amount = doc.get("amount") or doc.get("grand_total") or 0

    return {
        "doctype":      doctype,
        "stage":        stage,
        "doc_name":     doc.get("name", ""),
        "status":       status,
        "docstatus":    doc.get("docstatus", 0),
        "supplier":     supplier,
        "qty":          round(float(qty), 2),
        "rate":         round(float(rate), 2),
        "amount":       round(float(amount), 2),
        "days_open":    days_open,
        "is_overdue":   is_overdue,
        "days_overdue": days_overdue,
        "is_closed":    is_closed,
        "due_date":     _str(due),
        "creation_date":str(creation)[:10] if creation else "",
        "mr_type":      doc.get("material_request_type", ""),
        "zone":         doc.get("custom_toc_zone", ""),
        "bp_pct":       round(doc.get("custom_toc_bp_pct") or 0, 1),
        "recorded_by":  doc.get("custom_toc_recorded_by", ""),
        "mr_ref":       doc.get("material_request", ""),
        "rfq_ref":      doc.get("request_for_quotation", ""),
        "wo_ref":       doc.get("work_order", ""),
        "po_ref":       doc.get("purchase_order", ""),
        "item_code":    doc.get("item_code") or doc.get("production_item", ""),
        "operation":    doc.get("operation", ""),
        "progress_pct": _progress(doc),
    }


def _progress(doc):
    produced = doc.get("produced_qty") or doc.get("total_completed_qty") or doc.get("received_qty") or 0
    total    = doc.get("qty") or doc.get("for_quantity") or 0
    if total and produced is not None:
        return round(min(float(produced) / float(total) * 100, 100), 1)
    return 0


def _detect_stuck_stage(docs):
    """Return the stage name where the most documents are sitting without progress."""
    if not docs:
        return None
    open_docs = [d for d in docs if not d.get("is_closed")]
    if not open_docs:
        return None
    # Earliest open stage = stuck stage
    stage_order = ["material_request", "rfq_pp", "sq_wo", "po_jc", "receipt_qc", "output"]
    for stage in stage_order:
        if any(d["stage"] == stage for d in open_docs):
            return stage
    return open_docs[0]["stage"]


def _compute_next_action(bt, mrs, rfqs, pps, sqs, wos, pos, jcs, prs, ses):
    """
    Determine the single most important next action for this item.

    For non-TOC items (bt=""), the procurement path is inferred from the
    documents that already exist.
    """
    def has(docs, statuses):
        statuses = [s.lower() for s in statuses]
        return any(d.get("status", "").lower() in statuses for d in docs)

    # ── Infer path for non-TOC items ──────────────────────────────────────────
    if not bt:
        if wos or pps:
            bt = "FG"   # manufacture path
        elif rfqs or pos or (mrs and mrs[0].get("material_request_type") == "Purchase"):
            bt = "RM"   # purchase path
        elif mrs:
            bt = "FG"   # default to manufacture when only MR present
        else:
            return "No active documents"

    # ── No MR yet ─────────────────────────────────────────────────────────────
    if not mrs:
        if pos:
            # Direct PO without MR (common for non-TOC items)
            pending_pos = [p for p in pos if p.get("status") not in ("Closed", "Cancelled")]
            if not pending_pos:
                return "All Purchase Orders fulfilled"
            overdue_pos = [p for p in pending_pos if _is_overdue_doc(p, "schedule_date")]
            if overdue_pos:
                return f"⚠ {len(overdue_pos)} PO(s) overdue — follow up with supplier"
            return "Awaiting goods delivery"
        if wos:
            open_wos = [w for w in wos if w.get("status") not in ("Completed", "Stopped", "Cancelled")]
            if not open_wos:
                return "All Work Orders completed"
            if not jcs:
                return "Start Job Cards / Operations"
            open_jcs = [j for j in jcs if j.get("status") not in ("Completed",)]
            if open_jcs:
                overdue_jcs = [j for j in open_jcs if _is_overdue_doc(j, "expected_end_date")]
                if overdue_jcs:
                    return f"⚠ {len(overdue_jcs)} Job Card(s) overdue — expedite production"
                return "Production in progress — monitor Job Cards"
            if not ses:
                return "Post Manufacture Stock Entry"
            return "Production complete"
        return "No MR — raise a Material Request to trigger replenishment"

    pending_mrs = [m for m in mrs if m.get("status", "").lower() not in ("stopped", "cancelled")]

    if bt in ("RM", "PM"):
        # Purchase path
        if not rfqs:
            return "Create RFQ from open MRs"
        if not sqs:
            return "Awaiting Supplier Quotation"
        if not pos:
            if has(sqs, ["Submitted", "Ordered"]):
                return "Create Purchase Order from Quotation"
            return "Review and approve Supplier Quotation"
        pending_pos = [p for p in pos if p.get("status") not in ("Closed", "Cancelled")]
        if not prs:
            overdue_pos = [p for p in pending_pos if _is_overdue_doc(p, "schedule_date")]
            if overdue_pos:
                return f"⚠ {len(overdue_pos)} PO(s) overdue — follow up with supplier"
            return "Awaiting goods delivery"
        if not all(p.get("received_qty", 0) >= p.get("qty", 0) for p in prs):
            return "Goods partially received — pending balance"
        return "Fully received — buffer replenished"

    else:
        # Manufacture path (FG, SFG)
        if not pps and not wos:
            return "Create Production Plan from MR"
        if pps and not wos:
            return "Create Work Order from Production Plan"
        open_wos = [w for w in wos if w.get("status") not in ("Completed", "Stopped", "Cancelled")]
        if not open_wos:
            return "All Work Orders completed"
        if not jcs:
            return "Start Job Cards / Operations"
        open_jcs = [j for j in jcs if j.get("status") not in ("Completed",)]
        if open_jcs:
            overdue_jcs = [j for j in open_jcs if _is_overdue_doc(j, "expected_end_date")]
            if overdue_jcs:
                return f"⚠ {len(overdue_jcs)} Job Card(s) overdue — expedite production"
            return "Production in progress — monitor Job Cards"
        if not ses:
            return "Post Manufacture Stock Entry"
        return "Production complete — buffer updated"


def _is_overdue_doc(doc, date_field):
    due = doc.get(date_field)
    if not due:
        return False
    try:
        return date_diff(today(), due) > 0
    except Exception:
        return False


# ──────────────────────────────────────────────────────────────────────────────
#  Node builders (pipeline view)
# ──────────────────────────────────────────────────────────────────────────────

def _item_node(ic, item, toc):
    node = {
        "id": f"ITEM::{ic}", "stage": "items", "doctype": "Item",
        "doc_name": ic, "label": ic, "description": item.get("item_name", ""),
        "buffer_type": toc.get("buffer_type", ""),
        "item_group": item.get("item_group", ""),
        "toc_enabled": bool(toc),
        "zone": "", "bp_pct": 0,
        "target_buffer": None, "inventory_position": None,
        "on_hand": None, "order_qty": 0,
        "warehouse": "", "status": "active",
        "days_open": 0, "is_overdue": False,
    }
    if toc:
        node.update({
            "zone":               toc.get("zone", ""),
            "bp_pct":             _r(toc.get("bp_pct")),
            "target_buffer":      _r(toc.get("target_buffer")),
            "inventory_position": _r(toc.get("inventory_position")),
            "on_hand":            _r(toc.get("on_hand")),
            "order_qty":          _r(toc.get("order_qty")),
            "warehouse":          toc.get("warehouse", ""),
        })
    return node


def _mr_node(mr):
    return {
        "id": f"MR::{mr['name']}", "stage": "material_request", "doctype": "Material Request",
        "sub_type": "mr", "doc_name": mr["name"], "label": mr["name"],
        "description": mr.get("title") or mr.get("item_code", ""),
        "item_code": mr.get("item_code", ""), "warehouse": mr.get("warehouse", ""),
        "mr_type": mr.get("material_request_type", ""), "status": mr.get("status", ""),
        "docstatus": mr.get("docstatus", 0), "required_qty": _r(mr.get("required_qty")),
        "required_date": _str(mr.get("schedule_date")),
        "transaction_date": _str(mr.get("transaction_date")),
        "zone": mr.get("custom_toc_zone", ""), "bp_pct": _r(mr.get("custom_toc_bp_pct")),
        "target_buffer": _r(mr.get("custom_toc_target_buffer")), "ip": _r(mr.get("custom_toc_inventory_position")),
        "recorded_by": mr.get("custom_toc_recorded_by", ""),
        **_age(mr.get("creation"), mr.get("schedule_date")),
    }


def _rfq_node(rfq):
    return {
        "id": f"RFQ::{rfq['name']}", "stage": "rfq_pp", "doctype": "Request for Quotation",
        "sub_type": "rfq", "doc_name": rfq["name"], "label": rfq["name"],
        "description": rfq.get("suppliers") or "Pending suppliers",
        "item_code": rfq.get("item_code", ""), "qty": _r(rfq.get("qty")),
        "status": rfq.get("status", ""), "transaction_date": _str(rfq.get("transaction_date")),
        "mr_ref": rfq.get("material_request", ""),
        **_age(rfq.get("creation"), rfq.get("transaction_date")),
    }


def _pp_node(pp):
    return {
        "id": f"PP::{pp['name']}", "stage": "rfq_pp", "doctype": "Production Plan",
        "sub_type": "pp", "doc_name": pp["name"], "label": pp["name"],
        "description": f"Qty: {_r(pp.get('planned_qty'))} | {pp.get('status', '')}",
        "item_code": pp.get("item_code", ""), "planned_qty": _r(pp.get("planned_qty")),
        "status": pp.get("status", ""), "posting_date": _str(pp.get("posting_date")),
        "mr_ref": pp.get("material_request", ""),
        **_age(pp.get("creation"), None),
    }


def _sq_node(sq):
    return {
        "id": f"SQ::{sq['name']}", "stage": "sq_wo", "doctype": "Supplier Quotation",
        "sub_type": "sq", "doc_name": sq["name"], "label": sq["name"],
        "description": sq.get("supplier", ""), "supplier": sq.get("supplier", ""),
        "item_code": sq.get("item_code", ""), "qty": _r(sq.get("qty")),
        "rate": _r(sq.get("rate")), "grand_total": _r(sq.get("grand_total")),
        "status": sq.get("status", ""), "transaction_date": _str(sq.get("transaction_date")),
        "rfq_ref": sq.get("request_for_quotation", ""),
        **_age(sq.get("creation"), None),
    }


def _wo_node(wo, toc):
    produced = wo.get("produced_qty") or 0
    planned  = wo.get("qty") or 0
    pct      = round((produced / planned * 100) if planned else 0, 1)
    return {
        "id": f"WO::{wo['name']}", "stage": "sq_wo", "doctype": "Work Order",
        "sub_type": "wo", "doc_name": wo["name"], "label": wo["name"],
        "description": wo.get("production_item", ""), "item_code": wo.get("production_item", ""),
        "status": wo.get("status", ""), "qty": _r(planned), "produced_qty": _r(produced),
        "progress_pct": pct,
        "planned_start_date": _str(wo.get("planned_start_date")),
        "planned_end_date": _str(wo.get("planned_end_date")),
        "actual_start_date": _str(wo.get("actual_start_date")),
        "zone": wo.get("custom_toc_zone") or toc.get("zone", ""),
        "bp_pct": _r(wo.get("custom_toc_bp_pct") or toc.get("bp_pct")),
        "pp_ref": wo.get("production_plan", ""),
        **_age(wo.get("creation"), wo.get("planned_end_date")),
    }


def _po_node(po):
    return {
        "id": f"PO::{po['name']}", "stage": "po_jc", "doctype": "Purchase Order",
        "sub_type": "po", "doc_name": po["name"], "label": po["name"],
        "description": po.get("supplier", ""), "supplier": po.get("supplier", ""),
        "item_code": po.get("item_code", ""), "qty": _r(po.get("qty")),
        "received_qty": _r(po.get("received_qty")), "rate": _r(po.get("rate")),
        "amount": _r(po.get("amount")), "grand_total": _r(po.get("grand_total")),
        "status": po.get("status", ""), "expected_delivery": _str(po.get("schedule_date")),
        "transaction_date": _str(po.get("transaction_date")),
        "sq_ref": po.get("supplier_quotation", ""), "mr_ref": po.get("material_request", ""),
        **_age(po.get("creation"), po.get("schedule_date")),
    }


def _jc_node(jc):
    done  = jc.get("total_completed_qty") or 0
    total = jc.get("for_quantity") or 0
    pct   = round((done / total * 100) if total else 0, 1)
    return {
        "id": f"JC::{jc['name']}", "stage": "po_jc", "doctype": "Job Card",
        "sub_type": "jc", "doc_name": jc["name"], "label": jc["name"],
        "description": jc.get("operation", ""), "item_code": jc.get("production_item", ""),
        "status": jc.get("status", ""), "for_quantity": _r(total), "completed_qty": _r(done),
        "progress_pct": pct, "operation": jc.get("operation", ""),
        "expected_start_date": _str(jc.get("expected_start_date")),
        "expected_end_date": _str(jc.get("expected_end_date")),
        "actual_start_date": _str(jc.get("actual_start_date")),
        "wo_ref": jc.get("work_order", ""),
        **_age(jc.get("creation"), jc.get("expected_end_date")),
    }


def _pr_node(pr):
    return {
        "id": f"PR::{pr['name']}", "stage": "receipt_qc", "doctype": "Purchase Receipt",
        "sub_type": "pr", "doc_name": pr["name"], "label": pr["name"],
        "description": pr.get("supplier", ""), "supplier": pr.get("supplier", ""),
        "item_code": pr.get("item_code", ""), "qty": _r(pr.get("qty")),
        "received_qty": _r(pr.get("received_qty")), "rejected_qty": _r(pr.get("rejected_qty")),
        "status": pr.get("status", ""), "posting_date": _str(pr.get("posting_date")),
        "po_ref": pr.get("purchase_order", ""),
        **_age(pr.get("creation"), pr.get("posting_date")),
    }


def _qi_node(qi):
    return {
        "id": f"QI::{qi['name']}", "stage": "receipt_qc", "doctype": "Quality Inspection",
        "sub_type": "qi", "doc_name": qi["name"], "label": qi["name"],
        "description": qi.get("inspection_type", ""), "item_code": qi.get("item_code", ""),
        "status": qi.get("status", ""), "pr_ref": qi.get("reference_name", ""),
        **_age(qi.get("creation"), None),
    }


def _se_node(se):
    status_map = {0: "Draft", 1: "Submitted", 2: "Cancelled"}
    return {
        "id": f"SE::{se['name']}", "stage": "receipt_qc", "doctype": "Stock Entry",
        "sub_type": "se", "doc_name": se["name"], "label": se["name"],
        "description": se.get("stock_entry_type", ""), "item_code": se.get("item_code", ""),
        "produced_qty": _r(se.get("produced_qty")),
        "status": status_map.get(se.get("docstatus", 0), "Draft"),
        "posting_date": _str(se.get("posting_date")),
        "wo_ref": se.get("work_order", ""),
        **_age(se.get("creation"), None),
    }


def _output_node(ic, toc):
    return {
        "id": f"OUT::{ic}", "stage": "output", "doctype": "Item", "sub_type": "output",
        "doc_name": ic, "label": ic,
        "description": f"On-Hand: {_r(toc.get('on_hand'))} | Target: {_r(toc.get('target_buffer'))}",
        "buffer_type": toc.get("buffer_type", ""), "zone": toc.get("zone", ""),
        "bp_pct": _r(toc.get("bp_pct")), "on_hand": _r(toc.get("on_hand")),
        "target_buffer": _r(toc.get("target_buffer")),
        "inventory_position": _r(toc.get("inventory_position")),
        "order_qty": _r(toc.get("order_qty")), "warehouse": toc.get("warehouse", ""),
        "status": toc.get("zone", ""), "days_open": 0, "is_overdue": False,
    }


# ──────────────────────────────────────────────────────────────────────────────
#  Edge builder
# ──────────────────────────────────────────────────────────────────────────────

def _build_edges(items, mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses, output_ics):
    edges = []
    mr_by_item = {}
    for mr in mrs:
        mr_by_item.setdefault(mr.get("item_code", ""), set()).add(mr["name"])

    for item in items:
        ic = item["item_code"]
        for mr_name in mr_by_item.get(ic, []):
            edges.append({"source": f"ITEM::{ic}", "target": f"MR::{mr_name}"})

    for rfq in rfqs:
        if rfq.get("material_request"):
            edges.append({"source": f"MR::{rfq['material_request']}", "target": f"RFQ::{rfq['name']}"})
    for pp in pps:
        if pp.get("material_request"):
            edges.append({"source": f"MR::{pp['material_request']}", "target": f"PP::{pp['name']}"})
    for sq in sqs:
        if sq.get("request_for_quotation"):
            edges.append({"source": f"RFQ::{sq['request_for_quotation']}", "target": f"SQ::{sq['name']}"})
    for wo in wos:
        if wo.get("production_plan"):
            edges.append({"source": f"PP::{wo['production_plan']}", "target": f"WO::{wo['name']}"})

    mr_names_set = {mr["name"] for mr in mrs}
    for po in pos:
        if po.get("supplier_quotation"):
            edges.append({"source": f"SQ::{po['supplier_quotation']}", "target": f"PO::{po['name']}"})
        elif po.get("material_request") and po["material_request"] in mr_names_set:
            edges.append({"source": f"MR::{po['material_request']}", "target": f"PO::{po['name']}"})

    for jc in jcs:
        if jc.get("work_order"):
            edges.append({"source": f"WO::{jc['work_order']}", "target": f"JC::{jc['name']}"})
    for pr in prs:
        if pr.get("purchase_order"):
            edges.append({"source": f"PO::{pr['purchase_order']}", "target": f"PR::{pr['name']}"})
    for qi in qis:
        if qi.get("reference_name"):
            edges.append({"source": f"PR::{qi['reference_name']}", "target": f"QI::{qi['name']}"})
    for se in ses:
        if se.get("work_order"):
            edges.append({"source": f"WO::{se['work_order']}", "target": f"SE::{se['name']}"})

    # SE/JC → Output
    se_wo_set = {se.get("work_order", "") for se in ses}
    for se in ses:
        ic = se.get("item_code", "")
        if ic in output_ics:
            edges.append({"source": f"SE::{se['name']}", "target": f"OUT::{ic}"})
    for jc in jcs:
        if jc.get("status") == "Completed":
            wo_ref = jc.get("work_order", "")
            ic = jc.get("production_item") or jc.get("item_code", "")
            if ic in output_ics and wo_ref not in se_wo_set:
                edges.append({"source": f"JC::{jc['name']}", "target": f"OUT::{ic}"})

    seen = set()
    result = []
    for e in edges:
        k = (e["source"], e["target"])
        if k not in seen:
            seen.add(k)
            result.append(e)
    return result


# ──────────────────────────────────────────────────────────────────────────────
#  Summary / stage counts
# ──────────────────────────────────────────────────────────────────────────────

def _build_summary(items, toc_map, mrs, wos, pos):
    red = yellow = green = black = 0
    for item in items:
        z = toc_map.get(item["item_code"], {}).get("zone", "")
        if   z == "Red":    red    += 1
        elif z == "Black":  black  += 1
        elif z == "Yellow": yellow += 1
        elif z == "Green":  green  += 1
    return {
        "red": red + black, "yellow": yellow, "green": green,
        "mrs": len(mrs), "wos": len(wos), "pos": len(pos),
        "black": black,
    }


def _build_stage_counts(nodes):
    counts = {}
    for n in nodes:
        stage = n.get("stage", "")
        counts[stage] = counts.get(stage, 0) + 1
    return counts


def _build_active_item_codes(mrs, rfqs, pps, sqs, wos, pos, jcs, prs, qis, ses):
    """
    Return the set of item_codes that have at least one open/pending operation.

    Logic: an item is "active" if any of its supply chain documents still
    requires action — regardless of whether other documents in its chain are
    already completed. The caller then shows the FULL chain for active items.
    """
    active = set()

    # MR: pending procurement (not yet ordered)
    for d in mrs:
        if d.get("status") in ("Pending", "Partially Ordered") or d.get("docstatus", 0) == 0:
            active.add(d["item_code"])

    # WO: production not yet complete
    for d in wos:
        if d.get("status") not in ("Completed", "Stopped", "Cancelled"):
            active.add(d["production_item"])

    # PO: goods not yet received
    for d in pos:
        if d.get("status") not in ("Completed", "Closed", "Cancelled"):
            active.add(d["item_code"])

    # RFQ: open for quotation collection
    for d in rfqs:
        if d.get("docstatus", 0) < 2 and d.get("status") != "Cancelled":
            active.add(d["item_code"])

    # SQ: supplier quote received but no PO decision yet
    for d in sqs:
        if d.get("status") not in ("Ordered", "Cancelled") and d.get("docstatus", 0) < 2:
            active.add(d.get("item_code", ""))

    # Production Plan: not yet converted to WO
    for d in pps:
        if d.get("status") not in ("Completed", "Cancelled"):
            active.add(d["item_code"])

    # Job Card: operation not yet done
    for d in jcs:
        if d.get("status") not in ("Completed", "Cancelled"):
            active.add(d.get("production_item", ""))

    # PR: receipt pending billing
    for d in prs:
        if d.get("status") != "Completed" and d.get("docstatus", 0) < 2:
            active.add(d.get("item_code", ""))

    # QI: inspection pending
    for d in qis:
        if d.get("docstatus", 0) == 0:
            active.add(d.get("item_code", ""))

    # SE: manufacture entry not yet posted
    for d in ses:
        if d.get("docstatus", 0) == 0:
            active.add(d.get("item_code", ""))

    return active - {"", None}


def _empty_response():
    return {"nodes": [], "edges": [], "tracks": [], "summary": _empty_summary(),
            "stage_counts": {}, "meta": {}}


def _empty_summary():
    return {"red": 0, "yellow": 0, "green": 0, "mrs": 0, "wos": 0, "pos": 0, "black": 0}


# ──────────────────────────────────────────────────────────────────────────────
#  Utilities
# ──────────────────────────────────────────────────────────────────────────────

def _ph(lst):
    return ", ".join(["%s"] * len(lst))


def _str(val):
    if val is None:
        return ""
    return str(val)[:10] if val else ""  # trim to date only


def _r(val, dp=2):
    """Round to dp decimal places, defaulting None to 0."""
    try:
        return round(float(val or 0), dp)
    except (TypeError, ValueError):
        return 0


def _age(creation, due_date):
    days_open = int(date_diff(today(), creation)) if creation else 0
    is_overdue = False
    days_overdue = 0
    if due_date:
        try:
            diff = date_diff(today(), due_date)
            if diff > 0:
                is_overdue = True
                days_overdue = int(diff)
        except Exception:
            pass
    return {"days_open": days_open, "is_overdue": is_overdue, "days_overdue": days_overdue}


def _idx_by(lst, key):
    """Group a list of dicts by a key field."""
    result = {}
    for item in lst:
        k = item.get(key, "")
        if k:
            result.setdefault(k, []).append(item)
    return result
