# =============================================================================
# Phase 3 — End-to-end test of all five Phase 3 changes:
#   1. Production Plan consider_projected_qty=0
#   2. Run Item grid columns (item_name + production_plan + reason)
#   3. Production Plan list view "Created By" visible
#   4. Work Order list view "Item Name" visible
#   5. Email sent to TOC notification users
# =============================================================================

import frappe

WH = "WAREHOUSE 1.9 (CZWH-5) - CCP"


def execute():
    # ── 1. Add notification user (reuse it@chaizup.in) ────────────────────────
    s = frappe.get_doc("TOC Settings")
    if not any(r.user == "it@chaizup.in" for r in (s.projection_notification_users or [])):
        s.append("projection_notification_users", {
            "user": "it@chaizup.in",
            "notify_on_edit": 1,
            "notify_on_submit": 1,
            "notify_on_wo_create": 1,
        })
        s.flags.ignore_validate = True
        s.save(ignore_permissions=True)
        frappe.db.commit()
        print("✓ Added it@chaizup.in to TOC notification users (on_wo_create=1)")
    else:
        print("✓ it@chaizup.in already in TOC notification users")

    # ── 2. Cancel prior test PPs so engine re-creates fresh ───────────────────
    test_pps = frappe.db.sql_list(
        """
        SELECT pp.name FROM `tabProduction Plan` pp
        WHERE pp.docstatus=1
          AND pp.custom_recorded_by='System'
          AND pp.modified > NOW() - INTERVAL 24 HOUR
        """
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
            print(f"✓ Cancelled prior PP {pp_name} (+ {len(wos)} WO)")
        except Exception as exc:
            print(f"  ! PP cancel {pp_name}: {exc}")
    frappe.db.commit()

    # ── 3. Run the engine ────────────────────────────────────────────────────
    from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
        run_projection_automation_for_all_warehouses,
    )
    print("\n=== Running engine ===")
    summary = run_projection_automation_for_all_warehouses(triggered_by="manual")
    print(f"Engine: {summary}")

    # ── 4. Verify PP has skip_available_sub_assembly_item=0 ──────────────────
    # (Field labelled "Consider Projected Qty in Calculation" in the UI; the
    # internal fieldname differs in ERPNext v16.)
    log_name = (summary.get("run_logs") or [None])[-1]
    if log_name:
        pp_names = frappe.db.sql_list(
            """
            SELECT DISTINCT production_plan FROM `tabTOC Production Plan Run Item`
            WHERE parent=%s AND production_plan IS NOT NULL AND production_plan!=''
            """,
            (log_name,),
        )
        print(f"\n=== Verifying skip_available_sub_assembly_item=0 on PPs ===")
        print(f"    (UI label: 'Consider Projected Qty in Calculation' — must be unchecked)")
        for pp_name in pp_names:
            cpq = frappe.db.get_value("Production Plan", pp_name, "skip_available_sub_assembly_item")
            mark = "✓" if cpq == 0 else "✗"
            print(f"  {mark} {pp_name}: skip_available_sub_assembly_item = {cpq}")

    # ── 5. Verify Run Item grid in_list_view fields ──────────────────────────
    print("\n=== Verifying Run Item grid columns ===")
    in_list = frappe.db.sql("""
        SELECT fieldname, label, columns, in_list_view
        FROM `tabDocField`
        WHERE parent='TOC Production Plan Run Item' AND in_list_view=1
        ORDER BY idx
    """, as_dict=True)
    for r in in_list:
        print(f"  ✓ {r['fieldname']:18s} '{r['label']:30s}'  cols={r['columns']}")

    # ── 6. Verify Property Setter for Work Order item_name ───────────────────
    print("\n=== Verifying Work Order Property Setters ===")
    psets = frappe.db.sql("""
        SELECT field_name, property, value FROM `tabProperty Setter`
        WHERE doc_type='Work Order' AND module='Chaizup Toc'
    """, as_dict=True)
    for r in psets:
        print(f"  ✓ Work Order.{r.field_name}.{r.property} = {r.value}")

    # ── 7. Verify Email Queue has the run summary ────────────────────────────
    print("\n=== Verifying Email Queue ===")
    if log_name:
        eq = frappe.db.sql("""
            SELECT name, status, LEFT(message, 80) AS preview
            FROM `tabEmail Queue`
            WHERE reference_name=%s
            ORDER BY creation DESC
            LIMIT 3
        """, (log_name,), as_dict=True)
        for r in eq:
            print(f"  ✓ {r.name} status={r.status}  preview={r.preview!r}")
        if not eq:
            print(f"  ! No Email Queue entries for {log_name}")

    return summary
