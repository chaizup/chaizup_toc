# =============================================================================
# Phase 2.5 — Full scenario sweep on the dev replica.
# Runs after phase2_test_setup so MINMFG rows + TOC Settings are already in
# place. This script exercises the over-projection (Calc B) safety net by:
#   1. Cancelling the basic test projection
#   2. Creating a NEW projection that includes a sales-eligible item (CZPFG640)
#   3. Creating a SO whose qty exceeds the projection — Calc A skips, Calc B fires
#   4. Running the engine via run_projection_automation_for_all_warehouses
#   5. Asserting Run Log outcomes per scenario
#
# Scenarios covered:
#   S1  CZMAT/1593 — MINMFG floor              (oversupplied + min mfg floor)
#   S2  CZMAT/748  — Existing pending WO       (oversupplied via ITMWO)
#   S3  CZMAT/754  — Oversupplied via stock    (Calc A + B both skip)
#   S4  CZPFG640   — Over-projection           (Calc A skip, Calc B create)
# =============================================================================

import frappe
from frappe.utils import nowdate, add_days

WH      = "WAREHOUSE 1.9 (CZWH-5) - CCP"
COMPANY = "CHAIZUP CONSUMER PRODUCTS PRIVATE LIMITED"
ITEMS = [
    # (item_code, projection_qty_in_stock_uom, minmfg_qty)
    ("CZMAT/748",  5000,   0),     # Pre-existing pending WO of 364k → oversupplied (no MINMFG)
    ("CZMAT/754",  10000,  5000),  # Stock 245500 → oversupplied
    ("CZMAT/1593", 400000, 80000), # Stock 333500, projection 400000 → 66500 short, MINMFG floors to 80k
    ("CZPFG640",   50000,  10000), # Stock 94680, projection 50k. SO 200k overrides → Calc B fires
]
SO_OVERPROJECTION_ITEM = "CZPFG640"
SO_OVERPROJECTION_QTY  = 200000


def _cancel_test_pp_and_so():
    """Cancel previous test PPs / SOs / Projections so this run is deterministic."""
    # 1. Cancel test SOs
    test_sos = frappe.db.sql_list(
        "SELECT name FROM `tabSales Order` WHERE title=%s AND docstatus=1",
        ("TOC-TEST-OVERPROJECTION",),
    )
    for so_name in test_sos:
        try:
            frappe.get_doc("Sales Order", so_name).cancel()
            print(f"✓ Cancelled SO {so_name}")
        except Exception as exc:
            print(f"  ! SO cancel {so_name}: {exc}")

    # 2. Cancel test PPs (and their WOs)
    item_tuple = tuple(t[0] for t in ITEMS)
    test_pps = frappe.db.sql_list(
        """
        SELECT DISTINCT pp.name FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent=pp.name
        WHERE pp.docstatus=1
          AND pp.custom_created_by='System'
          AND ppi.item_code IN %s
        """,
        (item_tuple,),
    )
    for pp_name in test_pps:
        wos = frappe.db.sql_list(
            "SELECT name FROM `tabWork Order` WHERE production_plan=%s AND docstatus=1",
            (pp_name,),
        )
        for wo_name in wos:
            try:
                frappe.get_doc("Work Order", wo_name).cancel()
            except Exception as exc:
                print(f"  ! WO cancel {wo_name}: {exc}")
        try:
            frappe.get_doc("Production Plan", pp_name).cancel()
            print(f"✓ Cancelled PP {pp_name} (+ {len(wos)} WO)")
        except Exception as exc:
            print(f"  ! PP cancel {pp_name}: {exc}")

    # 3. Cancel test Sales Projections
    sps = frappe.db.sql_list(
        """
        SELECT name FROM `tabSales Projection`
        WHERE projection_month='May' AND projection_year=2026
          AND source_warehouse=%s AND docstatus=1
        """,
        (WH,),
    )
    for sp_name in sps:
        try:
            frappe.get_doc("Sales Projection", sp_name).cancel()
            print(f"✓ Cancelled SP {sp_name}")
        except Exception as exc:
            print(f"  ! SP cancel {sp_name}: {exc}")
    frappe.db.commit()


def _ensure_minmfg(item_code, qty):
    if qty <= 0:
        return
    frappe.db.sql(
        "DELETE FROM `tabItem Minimum Manufacture` WHERE parent=%s AND parentfield='custom_minimum_manufacture' AND warehouse=%s",
        (item_code, WH),
    )
    item = frappe.get_doc("Item", item_code)
    item.append("custom_minimum_manufacture", {
        "warehouse": WH,
        "min_manufacturing_qty": qty,
        "uom": item.stock_uom,
    })
    item.flags.ignore_validate = True
    item.flags.ignore_mandatory = True
    item.save(ignore_permissions=True)
    print(f"✓ MINMFG for {item_code}: {qty} {item.stock_uom}")
    frappe.db.commit()


def _create_projection():
    sp = frappe.new_doc("Sales Projection")
    sp.projection_month = "May"
    sp.projection_year  = 2026
    sp.source_warehouse = WH
    sp.company          = COMPANY
    for item_code, qty, _ in ITEMS:
        item = frappe.get_doc("Item", item_code)
        sp.append("table_mibv", {
            "item":      item_code,
            "item_name": item.item_name,
            "stock_uom": item.stock_uom,
            "uom_unit_of_measurement": item.stock_uom,
            "qty":       qty,
            "qty_in_stock_uom": qty,
            "conversion_factor": 1.0,
        })
    sp.flags.ignore_mandatory = True
    sp.insert(ignore_permissions=True)
    sp.submit()
    frappe.db.commit()
    print(f"✓ Sales Projection submitted: {sp.name}")
    return sp.name


def _create_overprojection_so():
    customer = frappe.db.get_value("Customer", filters={"disabled": 0}, fieldname="name")
    item = frappe.get_doc("Item", SO_OVERPROJECTION_ITEM)

    so = frappe.new_doc("Sales Order")
    so.title          = "TOC-TEST-OVERPROJECTION"
    so.customer       = customer
    so.transaction_date = nowdate()
    so.delivery_date    = add_days(nowdate(), 7)
    so.set_warehouse    = WH
    so.company          = COMPANY
    so.append("items", {
        "item_code":     SO_OVERPROJECTION_ITEM,
        "qty":           SO_OVERPROJECTION_QTY,
        "uom":           item.stock_uom,
        "stock_uom":     item.stock_uom,
        "conversion_factor": 1.0,
        "rate":          item.standard_rate or 1.0,
        "delivery_date": add_days(nowdate(), 7),
        "warehouse":     WH,
    })
    so.flags.ignore_mandatory = True
    so.insert(ignore_permissions=True)
    so.submit()
    frappe.db.commit()
    print(f"✓ SO submitted: {so.name} · {SO_OVERPROJECTION_QTY} of {SO_OVERPROJECTION_ITEM}")
    return so.name


def execute():
    print("\n=== STEP 1 — Cleanup prior test artefacts ===")
    _cancel_test_pp_and_so()

    print("\n=== STEP 2 — Configure MINMFG floors ===")
    for item_code, _, minmfg in ITEMS:
        _ensure_minmfg(item_code, minmfg)

    print("\n=== STEP 3 — Create over-projection SO ===")
    _create_overprojection_so()

    print("\n=== STEP 4 — Submit Sales Projection ===")
    sp_name = _create_projection()

    print("\n=== STEP 5 — Run automation engine ===")
    from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
        run_projection_automation_for_all_warehouses,
    )
    summary = run_projection_automation_for_all_warehouses(triggered_by="manual")
    print(f"Engine summary: {summary}")
    frappe.db.commit()

    print("\n=== STEP 6 — Inspect Run Log per item × calc ===")
    log_name = summary.get("run_logs", [None])[-1]
    if log_name:
        rows = frappe.db.sql("""
            SELECT item_code, calc_used, status,
                   ROUND(spow,1) AS spow,
                   ROUND(prvso,1) AS prvso,
                   ROUND(currso,1) AS currso,
                   ROUND(currALso,1) AS currALso,
                   ROUND(itmwo,1) AS itmwo,
                   ROUND(itmwstk,1) AS itmwstk,
                   ROUND(minmfg,1) AS minmfg,
                   ROUND(qty_of_shortage,1) AS qty_short,
                   ROUND(production_qty,1) AS prod_qty,
                   production_plan
            FROM `tabTOC Production Plan Run Item`
            WHERE parent=%s
            ORDER BY item_code, calc_used
        """, (log_name,), as_dict=True)
        print(f"\n  Log: {log_name} ({len(rows)} item-calc rows)\n")
        for r in rows:
            mark = "✓ CREATE" if r.status == "Created" else (
                "○ skip  " if r.status.startswith("Skipped") else "✗ ERROR "
            )
            print(
                f"  {mark} {r.item_code:14s} {r.calc_used:22s}  "
                f"SPOW={r.spow:>10}  PRVSO={r.prvso:>8}  CURRSO={r.currso:>8}  "
                f"CURRALSO={r.currALso:>8}  ITMWO={r.itmwo:>10}  "
                f"ITMWSTK={r.itmwstk:>10}  MINMFG={r.minmfg:>8}  "
                f"shortage={r.qty_short:>10}  prod={r.prod_qty:>10}  "
                f"PP={r.production_plan or '-'}"
            )

    return summary
