# =============================================================================
# CONTEXT: Daily 12 AM Min Order Qty Sync & Missing Config Notifier.
#   Runs every night to keep Item Min Order Qty (purchase) and
#   Item Minimum Manufacture (manufacture) child tables accurate.
#
# ─── TWO SYNC PASSES ──────────────────────────────────────────────────────────
#   1. Purchase items  → read Item.minimum_order_qty (ERPNext built-in field)
#      For each auto_purchase item with minimum_order_qty > 0:
#        - Find warehouses from TOC Item Buffer rules (custom_toc_buffer_rules)
#        - Create missing rows in Item Min Order Qty child table
#        - Update existing rows if ERPNext value changed
#
#   2. Manufacture items → read Work Order history (last 90 days)
#      For each auto_manufacture item with NO Item Minimum Manufacture rows:
#        - Compute average planned_qty from completed WOs (same item + warehouse)
#        - Round to a practical batch size
#        - Create the row if avg > 0
#
# ─── NOTIFICATION ─────────────────────────────────────────────────────────────
#   After both syncs, query remaining gaps:
#     - auto_purchase items with still-missing Item Min Order Qty rows
#     - auto_manufacture items with still-missing Item Minimum Manufacture rows
#   Send HTML email to toc_engine_notification_users with notify_on_min_order_missing = 1.
#
# MEMORY: app_chaizup_toc.md § Min Order Qty Sync
#
# DANGER ZONE:
#   - ItemMinOrderQty.validate() is called explicitly after setting fields so that
#     stock_uom_qty is re-computed. If you skip this, the pre-computed column may be stale.
#   - _sync_manufacture_items only creates rows for items with NO existing rows —
#     it never overwrites manually set minimum batch sizes.
#   - frappe.db.commit() is called once per sync pass after all writes — do NOT
#     commit per-row (performance) and do NOT omit (rows would not persist).
#
# RESTRICT:
#   - Do NOT override manually set Item Minimum Manufacture rows — only create
#     new rows from history when NONE exist for item+warehouse.
#   - Do NOT alter purchase rows when they were manually set to a value different
#     from Item.minimum_order_qty — update only when the ERPNext field changed.
#   - Do NOT send the missing-config email when no recipients are configured —
#     skip gracefully without error.
# =============================================================================

import frappe
from frappe.utils import flt, today, add_days, cint


def daily_min_order_sync():
    """12 AM daily entry point. Syncs min order quantities and notifies on gaps."""
    try:
        frappe.logger("chaizup_toc").info(f"=== Min Order Qty Sync: {today()} ===")
        _sync_purchase_items_from_erpnext()
        _sync_manufacture_items_from_history()
        _notify_missing_min_order_qty()
        frappe.logger("chaizup_toc").info("Min Order Qty Sync: done")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Min Order Sync FAILED")


# =============================================================================
# SYNC PASS 1 — Purchase items from Item.minimum_order_qty
# =============================================================================

def _sync_purchase_items_from_erpnext():
    """
    For each auto_purchase item with Item.minimum_order_qty > 0:
    - Find warehouses from custom_toc_buffer_rules child table
    - Create a row in Item Min Order Qty if none exists for item+warehouse
    - Update the row if the ERPNext minimum_order_qty field changed
    Uses purchase_uom if available, otherwise stock_uom.
    """
    items = frappe.db.sql("""
        SELECT name, minimum_order_qty, purchase_uom, stock_uom
        FROM `tabItem`
        WHERE custom_toc_auto_purchase = 1
          AND disabled = 0
          AND minimum_order_qty > 0
    """, as_dict=True)

    created = 0
    updated = 0

    for item in items:
        warehouses = frappe.db.sql_list("""
            SELECT DISTINCT warehouse FROM `tabTOC Item Buffer`
            WHERE parent = %s
              AND parentfield = 'custom_toc_buffer_rules'
              AND warehouse IS NOT NULL
              AND warehouse != ''
        """, item.name)

        if not warehouses:
            continue

        use_uom = item.purchase_uom or item.stock_uom

        for warehouse in warehouses:
            existing = frappe.db.get_value(
                "Item Min Order Qty",
                {
                    "parent": item.name,
                    "parentfield": "custom_min_order_qty",
                    "warehouse": warehouse,
                },
                ["name", "min_order_qty"],
                as_dict=True,
            )

            if not existing:
                try:
                    row_doc = frappe.get_doc({
                        "doctype": "Item Min Order Qty",
                        "parent": item.name,
                        "parenttype": "Item",
                        "parentfield": "custom_min_order_qty",
                        "warehouse": warehouse,
                        "uom": use_uom,
                        "min_order_qty": flt(item.minimum_order_qty),
                    })
                    row_doc.insert(ignore_permissions=True)
                    created += 1
                    frappe.logger("chaizup_toc").info(
                        f"Min order sync: CREATED — {item.name}/{warehouse}: "
                        f"{item.minimum_order_qty} {use_uom}"
                    )
                except Exception:
                    frappe.log_error(
                        frappe.get_traceback(),
                        f"Min order sync: insert failed — {item.name}/{warehouse}",
                    )
            else:
                if abs(flt(existing.min_order_qty) - flt(item.minimum_order_qty)) > 0.001:
                    try:
                        row_doc = frappe.get_doc("Item Min Order Qty", existing.name)
                        old_qty = row_doc.min_order_qty
                        row_doc.min_order_qty = flt(item.minimum_order_qty)
                        row_doc.uom = use_uom
                        row_doc.validate()   # re-computes stock_uom_qty
                        row_doc.db_update()
                        updated += 1
                        frappe.logger("chaizup_toc").info(
                            f"Min order sync: UPDATED — {item.name}/{warehouse}: "
                            f"{old_qty} → {item.minimum_order_qty}"
                        )
                    except Exception:
                        frappe.log_error(
                            frappe.get_traceback(),
                            f"Min order sync: update failed — {item.name}/{warehouse}",
                        )

    frappe.db.commit()
    frappe.logger("chaizup_toc").info(
        f"Min order sync (Purchase): {created} created, {updated} updated"
    )


# =============================================================================
# SYNC PASS 2 — Manufacture items from Work Order history
# =============================================================================

def _sync_manufacture_items_from_history():
    """
    For auto_manufacture items with NO Item Minimum Manufacture rows:
    - Query last-90-day completed Work Orders for item+warehouse
    - Use the average planned_qty (rounded to a practical batch size) as minimum
    - Create one row per item+warehouse where history exists
    Never overwrites existing manually-set rows.
    """
    from_date = add_days(today(), -90)

    items = frappe.get_all(
        "Item",
        filters={"custom_toc_auto_manufacture": 1, "disabled": 0},
        fields=["name", "stock_uom"],
    )

    created = 0

    for item in items:
        warehouses = frappe.db.sql_list("""
            SELECT DISTINCT warehouse FROM `tabTOC Item Buffer`
            WHERE parent = %s
              AND parentfield = 'custom_toc_buffer_rules'
              AND warehouse IS NOT NULL
              AND warehouse != ''
        """, item.name)

        for warehouse in warehouses:
            # Skip if row already exists — never overwrite manual config
            if frappe.db.exists("Item Minimum Manufacture", {
                "parent": item.name,
                "parentfield": "custom_minimum_manufacture",
                "warehouse": warehouse,
            }):
                continue

            # Compute average from completed WO history
            result = frappe.db.sql("""
                SELECT AVG(qty) AS avg_qty, COUNT(*) AS wo_count
                FROM `tabWork Order`
                WHERE production_item = %s
                  AND wip_warehouse = %s
                  AND status IN ('Completed', 'Closed')
                  AND docstatus = 1
                  AND creation >= %s
            """, (item.name, warehouse, from_date), as_dict=True)

            if not result or not result[0].wo_count:
                continue

            avg_qty = flt(result[0].avg_qty)
            if avg_qty <= 0:
                continue

            suggested = _round_to_nice(avg_qty)

            try:
                row_doc = frappe.get_doc({
                    "doctype": "Item Minimum Manufacture",
                    "parent": item.name,
                    "parenttype": "Item",
                    "parentfield": "custom_minimum_manufacture",
                    "warehouse": warehouse,
                    "min_manufacturing_qty": suggested,
                    "uom": item.stock_uom,
                })
                row_doc.insert(ignore_permissions=True)
                created += 1
                frappe.logger("chaizup_toc").info(
                    f"Min manufacture sync: CREATED — {item.name}/{warehouse}: "
                    f"{suggested} {item.stock_uom} (avg of {result[0].wo_count} WOs)"
                )
            except Exception:
                frappe.log_error(
                    frappe.get_traceback(),
                    f"Min manufacture sync: insert failed — {item.name}/{warehouse}",
                )

    if created:
        frappe.db.commit()
    frappe.logger("chaizup_toc").info(
        f"Min manufacture sync (Manufacture): {created} rows created from WO history"
    )


def _round_to_nice(qty):
    """Round qty to the nearest practical production batch size."""
    if qty <= 10:
        return round(qty)
    elif qty <= 100:
        return round(qty / 5) * 5
    elif qty <= 1000:
        return round(qty / 50) * 50
    else:
        return round(qty / 500) * 500


# =============================================================================
# NOTIFICATION — items still missing after sync
# =============================================================================

def _notify_missing_min_order_qty():
    """
    After both sync passes, find items that still have no min order qty configured.
    Send HTML email to users with notify_on_min_order_missing = 1.
    """
    from chaizup_toc.toc_engine.component_mr_generator import _get_engine_notification_emails

    recipients = _get_engine_notification_emails("notify_on_min_order_missing")
    if not recipients:
        return

    missing_purchase = frappe.db.sql("""
        SELECT i.name AS item_code, i.item_name, i.item_group
        FROM `tabItem` i
        WHERE i.custom_toc_auto_purchase = 1
          AND i.disabled = 0
          AND NOT EXISTS (
            SELECT 1 FROM `tabItem Min Order Qty` m
            WHERE m.parent = i.name
              AND m.parentfield = 'custom_min_order_qty'
          )
        ORDER BY i.name
    """, as_dict=True)

    missing_manufacture = frappe.db.sql("""
        SELECT i.name AS item_code, i.item_name, i.item_group
        FROM `tabItem` i
        WHERE i.custom_toc_auto_manufacture = 1
          AND i.disabled = 0
          AND NOT EXISTS (
            SELECT 1 FROM `tabItem Minimum Manufacture` m
            WHERE m.parent = i.name
              AND m.parentfield = 'custom_minimum_manufacture'
          )
        ORDER BY i.name
    """, as_dict=True)

    if not missing_purchase and not missing_manufacture:
        frappe.logger("chaizup_toc").info("Min order qty: all items configured. No alert needed.")
        return

    html = _build_missing_alert_email(missing_purchase, missing_manufacture)
    total = len(missing_purchase) + len(missing_manufacture)

    frappe.sendmail(
        recipients=recipients,
        subject=f"TOC Engine: Min Order Qty Missing — {total} item(s) | {today()}",
        message=html,
        header=["Min Order Qty Alert", "orange"],
    )
    frappe.logger("chaizup_toc").info(
        f"Min order qty alert sent: {len(missing_purchase)} purchase, "
        f"{len(missing_manufacture)} manufacture items | to: {recipients}"
    )


def _build_missing_alert_email(missing_purchase, missing_manufacture):
    total = len(missing_purchase) + len(missing_manufacture)
    html = f"""
<div style="font-family:sans-serif;max-width:860px;margin:0 auto">
  <div style="background:#b45309;color:white;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:18px">TOC Engine — Min Order Qty Configuration Missing</h2>
    <p style="margin:4px 0 0;opacity:0.85;font-size:13px">
      {total} item(s) need configuration | {today()}
    </p>
  </div>
  <div style="background:#fffbeb;padding:20px;border:1px solid #fde68a;border-top:none">
    <p style="color:#78350f;margin-top:0;font-size:13px">
      The items below do not have minimum order / production qty configured in Item Master.
      Without this, the TOC Engine creates MRs and Production Plans at raw shortage qty with no
      minimum floor. Please configure in:
      <b>Item Master &rarr; Min Order Qty Rules [TOC App]</b> (purchase) or
      <b>Item Master &rarr; Minimum Manufacture Batch [TOC App]</b> (manufacture).
    </p>
"""

    if missing_purchase:
        html += f"""
    <h3 style="color:#1d4ed8;border-bottom:1px solid #bfdbfe;padding-bottom:4px">
      Purchase Items — Missing Min Order Qty ({len(missing_purchase)})
    </h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <thead>
        <tr style="background:#dbeafe">
          <th style="padding:7px 10px;text-align:left;border:1px solid #93c5fd">Item Code</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #93c5fd">Item Name</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #93c5fd">Item Group</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #93c5fd">Action</th>
        </tr>
      </thead>
      <tbody>
"""
        for i, item in enumerate(missing_purchase):
            bg = "#f0f9ff" if i % 2 == 0 else "#ffffff"
            html += (
                f'<tr style="background:{bg}">'
                f'<td style="padding:7px 10px;border:1px solid #bfdbfe"><b>{item.item_code}</b></td>'
                f'<td style="padding:7px 10px;border:1px solid #bfdbfe">{item.item_name}</td>'
                f'<td style="padding:7px 10px;border:1px solid #bfdbfe">{item.item_group or ""}</td>'
                f'<td style="padding:7px 10px;border:1px solid #bfdbfe;color:#dc2626">'
                f'Add row: Warehouse + UOM + Min Order Qty</td>'
                f'</tr>\n'
            )
        html += "      </tbody>\n    </table>"

    if missing_manufacture:
        html += f"""
    <h3 style="color:#166534;border-bottom:1px solid #bbf7d0;padding-bottom:4px">
      Manufacture Items — Missing Min Manufacturing Qty ({len(missing_manufacture)})
    </h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px">
      <thead>
        <tr style="background:#dcfce7">
          <th style="padding:7px 10px;text-align:left;border:1px solid #86efac">Item Code</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #86efac">Item Name</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #86efac">Item Group</th>
          <th style="padding:7px 10px;text-align:left;border:1px solid #86efac">Action</th>
        </tr>
      </thead>
      <tbody>
"""
        for i, item in enumerate(missing_manufacture):
            bg = "#f0fdf4" if i % 2 == 0 else "#ffffff"
            html += (
                f'<tr style="background:{bg}">'
                f'<td style="padding:7px 10px;border:1px solid #bbf7d0"><b>{item.item_code}</b></td>'
                f'<td style="padding:7px 10px;border:1px solid #bbf7d0">{item.item_name}</td>'
                f'<td style="padding:7px 10px;border:1px solid #bbf7d0">{item.item_group or ""}</td>'
                f'<td style="padding:7px 10px;border:1px solid #bbf7d0;color:#dc2626">'
                f'Add row: Warehouse + UOM + Min Manufacturing Qty</td>'
                f'</tr>\n'
            )
        html += "      </tbody>\n    </table>"

    html += "  </div>\n</div>"
    return html
