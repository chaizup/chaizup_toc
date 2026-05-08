# =============================================================================
# Phase 2.5 — Scenario: actual SOs > projection (Calc B safety net).
# Creates a Sales Order against CZMAT/754 with delivery_date in May 2026 that
# exceeds the projection (10000) so Calc A skips and Calc B catches it.
#
# After running, you can call run_projection_automation_for_all_warehouses
# again. The first run already created Calc A's PP for items where shortage > 0;
# this test creates a SO so the second run (after this patch) sees CURRSO and
# CURRALSO populated.
# =============================================================================

import frappe
from frappe.utils import nowdate, add_days

WH      = "WAREHOUSE 1.9 (CZWH-5) - CCP"
COMPANY = "CHAIZUP CONSUMER PRODUCTS PRIVATE LIMITED"


def execute():
    # Pick or create a Customer to attach the SO to
    customer = frappe.db.get_value("Customer", filters={"disabled": 0}, fieldname="name")
    if not customer:
        c = frappe.new_doc("Customer")
        c.customer_name = "TOC Test Customer"
        c.customer_group = frappe.db.get_value("Customer Group", filters={"is_group": 0}, fieldname="name")
        c.territory = frappe.db.get_value("Territory", filters={"is_group": 0}, fieldname="name")
        c.insert(ignore_permissions=True)
        customer = c.name
        print(f"✓ Created Customer {customer}")

    item = frappe.get_doc("Item", "CZMAT/754")

    # Cancel any prior test SOs (so re-runs are clean)
    prior = frappe.db.sql_list(
        """
        SELECT so.name FROM `tabSales Order` so
        JOIN `tabSales Order Item` soi ON soi.parent=so.name
        WHERE so.docstatus=1
          AND soi.item_code=%s
          AND so.title LIKE %s
        """,
        ("CZMAT/754", "%TOC-TEST-OVERPROJECTION%"),
    )
    for so_name in prior:
        try:
            so = frappe.get_doc("Sales Order", so_name)
            so.cancel()
            print(f"✓ Cancelled prior test SO {so_name}")
        except Exception as exc:
            print(f"  ! Could not cancel SO {so_name}: {exc}")
    frappe.db.commit()

    # Create a SO that's bigger than the 10,000 projection.
    # Stock at WH = 245,500. SPOW = 10,000.
    #   Calc A: (10000 + 0) - (300000 + 0 + 245500) = -535,500 → still skip
    #   Hmm — that's because CURRALSO is so large it dwarfs SPOW.
    # To force Calc B to fire while Calc A is still useful, set SO qty modest
    # but EMPTY the stock (impractical to alter Bin) OR test a different setup.
    #
    # SIMPLER: Calc B fires when (PRVSO + CURRSO) > (ITMWSTK + ITMWO).
    # Stock=245500. Need pending SO total > 245500. Use 300_000.
    so_qty = 300000

    so = frappe.new_doc("Sales Order")
    so.title          = "TOC-TEST-OVERPROJECTION"
    so.customer       = customer
    so.transaction_date = nowdate()
    so.delivery_date    = add_days(nowdate(), 7)   # mid-May 2026 → CURRSO bucket
    so.set_warehouse    = WH
    so.company          = COMPANY
    so.append("items", {
        "item_code":     "CZMAT/754",
        "qty":           so_qty,
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
    print(f"✓ SO submitted: {so.name} · {so_qty} {item.stock_uom} of CZMAT/754 due in 7 days")

    return so.name
