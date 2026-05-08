# =============================================================================
# Phase 2.4 — Configure live test data on the dev replica.
# =============================================================================

import frappe
from frappe.utils import nowdate

WH        = "WAREHOUSE 1.9 (CZWH-5) - CCP"
COMPANY   = "CHAIZUP CONSUMER PRODUCTS PRIVATE LIMITED"
TEST_ITEMS = [
    # (item_code, projection_qty, minmfg_qty)
    # Scenario 1: stock=0, projection=5000 → Calc A creates 5000 (no MINMFG)
    ("CZMAT/748",  5000, 0),
    # Scenario 2: stock=245500, projection=10000 → Calc A skip (oversupplied)
    ("CZMAT/754",  10000, 5000),
    # Scenario 3: stock=333500, projection=400000 → shortage 66500, but MINMFG=80000 → PP@80000
    ("CZMAT/1593", 400000, 80000),
]


def execute():
    # ── 1. TOC Settings — enable + default warehouse ─────────────────────────
    s = frappe.get_doc("TOC Settings")
    s.enable_projection_automation = 1
    s.default_so_warehouse = WH
    s.flags.ignore_validate = True
    s.save(ignore_permissions=True)
    frappe.db.commit()
    print(f"✓ TOC Settings: enable_projection_automation=1, default_so_warehouse={WH}")

    # ── 2. Item Minimum Manufacture rows ─────────────────────────────────────
    # Clean up any existing rows for these items so test is deterministic.
    for item_code, _, _ in TEST_ITEMS:
        frappe.db.sql(
            "DELETE FROM `tabItem Minimum Manufacture` WHERE parent=%s AND parentfield='custom_minimum_manufacture'",
            (item_code,),
        )
    frappe.db.commit()

    for item_code, _, minmfg_qty in TEST_ITEMS:
        if minmfg_qty <= 0:
            continue
        item = frappe.get_doc("Item", item_code)
        item.append("custom_minimum_manufacture", {
            "warehouse": WH,
            "min_manufacturing_qty": minmfg_qty,
            "uom": item.stock_uom,
        })
        item.flags.ignore_validate = True
        item.flags.ignore_mandatory = True
        item.save(ignore_permissions=True)
        print(f"✓ Item {item_code}: MINMFG row added — {minmfg_qty} {item.stock_uom}")
    frappe.db.commit()

    # ── 3. Cancel any existing test Sales Projection so re-runs are clean ────
    existing = frappe.get_all(
        "Sales Projection",
        filters={
            "projection_month": "May",
            "projection_year": 2026,
            "source_warehouse": WH,
            "docstatus": ("!=", 2),
        },
        pluck="name",
    )
    for sp_name in existing:
        sp = frappe.get_doc("Sales Projection", sp_name)
        if sp.docstatus == 1:
            sp.cancel()
        else:
            sp.delete(ignore_permissions=True)
        print(f"✓ Cleaned up existing projection: {sp_name}")
    frappe.db.commit()

    # ── 4. Cancel any prior PPs created by test runs (so dedup doesn't block) ─
    item_tuple = tuple(t[0] for t in TEST_ITEMS)
    test_pps = frappe.db.sql_list(
        """
        SELECT pp.name FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent=pp.name
        WHERE pp.docstatus=1
          AND pp.custom_creation_reason LIKE %s
          AND ppi.item_code IN %s
        """,
        ("%Calc A%", item_tuple),
    )
    test_pps += frappe.db.sql_list(
        """
        SELECT pp.name FROM `tabProduction Plan` pp
        JOIN `tabProduction Plan Item` ppi ON ppi.parent=pp.name
        WHERE pp.docstatus=1
          AND pp.custom_creation_reason LIKE %s
          AND ppi.item_code IN %s
        """,
        ("%Calc B%", item_tuple),
    )
    for pp_name in set(test_pps):
        try:
            for wo_name in frappe.db.sql_list(
                "SELECT name FROM `tabWork Order` WHERE production_plan=%s AND docstatus=1",
                pp_name,
            ):
                try:
                    wo = frappe.get_doc("Work Order", wo_name)
                    wo.cancel()
                except Exception as exc:
                    print(f"  ! Could not cancel WO {wo_name}: {exc}")
            pp = frappe.get_doc("Production Plan", pp_name)
            pp.cancel()
            print(f"✓ Cancelled prior test PP: {pp_name}")
        except Exception as exc:
            print(f"  ! Could not cancel PP {pp_name}: {exc}")
    frappe.db.commit()

    # ── 5. Create + submit a fresh Sales Projection ──────────────────────────
    sp = frappe.new_doc("Sales Projection")
    sp.projection_month   = "May"
    sp.projection_year    = 2026
    sp.source_warehouse   = WH
    sp.company            = COMPANY
    for item_code, qty, _ in TEST_ITEMS:
        item = frappe.get_doc("Item", item_code)
        sp.append("table_mibv", {
            "item": item_code,
            "item_name": item.item_name,
            "stock_uom": item.stock_uom,
            "uom_unit_of_measurement": item.stock_uom,
            "qty": qty,
            "qty_in_stock_uom": qty,
            "conversion_factor": 1.0,
        })
    sp.flags.ignore_mandatory = True
    sp.insert(ignore_permissions=True)
    sp.submit()
    frappe.db.commit()
    print(f"✓ Sales Projection submitted: {sp.name}")
    print(f"   Items: {[t[0] for t in TEST_ITEMS]}")

    return sp.name
