# =============================================================================
# CONTEXT: Post-WO Component Shortage MR Generator (v2 — warehouse-grouped).
#   Called as Step 7 in _submit_pp_and_create_work_orders() after Work Orders
#   are created from a Production Plan. Aggregates all Work Order Item rows
#   across the full PP → multi-level BOM tree, checks Bin.actual_qty and
#   Bin.ordered_qty per component + warehouse, and creates ONE Purchase
#   Material Request PER WAREHOUSE containing all shortage items for that warehouse.
#
# MEMORY: toc_engine.md (same folder)
#
# ─── FLOW ─────────────────────────────────────────────────────────────────────
#   1. Fetch all submitted WOs linked to pp_name.
#   2. Aggregate WO Item net_required = SUM(required_qty − transferred_qty) per
#      item_code + source_warehouse across the entire multi-level BOM tree.
#   3. Classify items:
#      a. custom_toc_auto_purchase = 1          → "purchase" (always included)
#      b. no active BOM AND not auto_manufacture → "leaf"    (raw leaf node; included)
#      c. custom_toc_auto_manufacture = 1        → "skip"   (WO already created)
#      d. has active BOM but no auto flags       → "skip"   (manual handling)
#   4. Build Min Order Qty map (stock_uom floor) from Item Min Order Qty child table.
#   5. For each included component:
#      shortage = max(0, net_required − actual_qty − ordered_qty)
#        actual_qty : Bin.actual_qty  (on-hand stock)
#        ordered_qty: Bin.ordered_qty (already on open POs — avoids over-ordering)
#      order_qty = max(shortage, min_order_qty_in_stock_uom)
#      Dedup: skip if any open Purchase MR already exists for item + warehouse.
#   6. Group all non-skipped items by warehouse.
#   7. Create ONE Purchase MR per warehouse group (all shortage items as line items).
#   8. Send email summary to TOC Engine notification users.
#
# ─── UOM STANDARD ─────────────────────────────────────────────────────────────
#   WO Item required_qty / transferred_qty  : stock_uom (ERPNext stores in stock_uom)
#   Bin.actual_qty / Bin.ordered_qty        : stock_uom
#   Item Min Order Qty.stock_uom_qty        : stock_uom (pre-computed by controller)
#   Purchase MR qty                         : purchase_uom (divide by conversion_factor)
#   ERPNext MR validation recomputes stock_qty = mr_qty × cf automatically.
#
# ─── MULTI-LEVEL BOM COVERAGE ─────────────────────────────────────────────────
#   pp_doc.make_work_order() creates separate WOs for every BOM level:
#     FG WO  → WO Items are direct sub-assemblies (SFG) + raw materials (RM/PM)
#     SFG WOs → WO Items are their direct raw materials
#   Querying ALL tabWork Order Item WHERE parent IN (all PP's WOs) flattens the
#   full tree automatically — no additional BOM recursion needed here.
#
# ─── DEDUP STRATEGY ───────────────────────────────────────────────────────────
#   _has_open_component_mr() is checked per-item before adding to a warehouse
#   batch. If an open MR already exists for item+warehouse, that item is excluded
#   from the batch. Other items in the same warehouse still proceed.
#
# ─── DANGER ZONE ──────────────────────────────────────────────────────────────
#   - WO Items with NULL or empty source_warehouse are silently skipped —
#     cannot create an MR without a destination warehouse.
#   - Items with custom_toc_auto_manufacture = 1 are excluded — their WOs are
#     already created by the PP flow.
#   - Leaf nodes (items with no active BOM and not auto_manufacture) ARE included
#     even without auto_purchase flag — they need to be purchased to fill the BOM.
#   - The entire create_component_shortage_mrs() function is called inside
#     a try/except in production_plan_engine.py — failures NEVER abort PP/WO.
#   - Do NOT call frappe.db.commit() here — caller commits after this step.
#   - build_min_order_map() is a PUBLIC function (no underscore) — imported by
#     mr_generator.py to apply the same floor to buffer-triggered purchase MRs.
#
# ─── RESTRICT ─────────────────────────────────────────────────────────────────
#   - Do NOT create MRs for items with custom_toc_auto_manufacture = 1.
#   - Do NOT add frappe.db.commit() — caller owns the transaction.
#   - Do NOT apply min_order_qty floor to manufacture items.
#   - Each MR groups ALL shortage items for ONE warehouse into one document.
#     Purchasing workflow: one MR per warehouse → one PO per supplier region.
# =============================================================================

import frappe
from frappe.utils import flt, today, add_days, cint, now_datetime


def create_component_shortage_mrs(pp_name, company):
    """
    Main entry point. Returns list of created MR names.

    Walks all WO Items across the full multi-level BOM of pp_name,
    identifies component shortages (subtracting already-ordered qty from Bin),
    and creates one Purchase MR per warehouse containing all shortage items.
    Includes auto_purchase items AND leaf-node items (no active BOM, not auto_manufacture).
    """
    # ── Step 1: All submitted WOs for this PP ────────────────────────────────
    wo_names = frappe.get_all(
        "Work Order",
        filters={"production_plan": pp_name, "docstatus": 1},
        pluck="name",
    )
    if not wo_names:
        return []

    # ── Step 2: Aggregate net component requirements across all BOM levels ───
    wo_ph = ", ".join(["%s"] * len(wo_names))
    rows = frappe.db.sql(
        f"""
        SELECT
            woi.item_code,
            woi.item_name,
            woi.stock_uom,
            woi.source_warehouse          AS warehouse,
            SUM(GREATEST(
                woi.required_qty - IFNULL(woi.transferred_qty, 0),
                0
            ))                            AS net_required
        FROM `tabWork Order Item` woi
        WHERE woi.parent IN ({wo_ph})
          AND woi.source_warehouse IS NOT NULL
          AND woi.source_warehouse != ''
        GROUP BY woi.item_code, woi.source_warehouse
        HAVING net_required > 0
        """,
        wo_names,
        as_dict=True,
    )
    if not rows:
        return []

    # ── Step 3: Classify items ───────────────────────────────────────────────
    item_codes = list({r.item_code for r in rows})
    item_classification = _classify_items(item_codes)
    purchasable_codes = [c for c, cls in item_classification.items() if cls in ("purchase", "leaf")]
    if not purchasable_codes:
        return []

    # ── Step 4: Build min order qty map (stock_uom floor) ───────────────────
    min_order_map = build_min_order_map(purchasable_codes)

    # ── Step 5: Process each row, compute shortage, group by warehouse ───────
    warehouse_batches = {}  # {warehouse: [item_info, ...]}
    skipped_items = []
    no_min_qty_items = []

    for row in rows:
        if item_classification.get(row.item_code, "skip") == "skip":
            continue

        actual_qty, ordered_qty = _get_bin_qtys(row.item_code, row.warehouse)
        # Subtract both on-hand and already-on-order quantities to avoid over-purchasing
        shortage = max(0.0, flt(row.net_required) - actual_qty - ordered_qty)
        if shortage <= 0:
            continue

        min_qty_stock = min_order_map.get((row.item_code, row.warehouse), 0.0)
        order_qty = max(shortage, min_qty_stock)

        # Track items with no min order qty for email notification
        if min_qty_stock <= 0:
            no_min_qty_items.append({
                "item_code": row.item_code,
                "item_name": row.item_name,
                "warehouse": row.warehouse,
                "shortage": shortage,
            })

        # Dedup: skip if open Purchase MR already exists for this item+warehouse
        if _has_open_component_mr(row.item_code, row.warehouse):
            skipped_items.append({"item_code": row.item_code, "warehouse": row.warehouse})
            frappe.logger("chaizup_toc").info(
                f"Component MR skipped (open MR exists): {row.item_code} / {row.warehouse}"
            )
            continue

        # Add to warehouse batch
        warehouse_batches.setdefault(row.warehouse, []).append({
            "item_code": row.item_code,
            "item_name": row.item_name,
            "order_qty_stock": order_qty,
            "stock_uom": row.stock_uom or "",
            "shortage": shortage,
            "min_qty_stock": min_qty_stock,
        })

    if not warehouse_batches:
        _send_component_mr_summary(pp_name, [], skipped_items, no_min_qty_items)
        return []

    # ── Step 6: Create ONE MR per warehouse group ─────────────────────────────
    created = []
    for warehouse, batch_items in warehouse_batches.items():
        try:
            mr_name = _create_warehouse_batch_mr(batch_items, warehouse, company, pp_name)
            if mr_name:
                created.append(mr_name)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"Component MR batch failed: PP={pp_name} / WH={warehouse}",
            )

    # ── Step 7: Send email summary ─────────────────────────────────────────────
    try:
        _send_component_mr_summary(pp_name, created, skipped_items, no_min_qty_items)
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"Component MR summary email failed: PP={pp_name}")

    if created:
        frappe.logger("chaizup_toc").info(
            f"PP {pp_name}: {len(created)} warehouse MRs created "
            f"({sum(len(v) for v in warehouse_batches.values())} total line items)"
        )
    return created


# =============================================================================
# PUBLIC HELPER — also imported by mr_generator.py for buffer-triggered MR floor
# CONTEXT: Reads Item Min Order Qty child table and returns a lookup dict.
#   stock_uom_qty column is pre-computed by ItemMinOrderQty.validate() on save.
#   Fallback: recompute from min_order_qty × conversion_factor when stock_uom_qty
#   is 0 (row saved before the controller was deployed, or row entered via bench).
#
# DANGER ZONE:
#   - Parentfield must be 'custom_min_order_qty' — matches the Custom Field
#     created on Item. If that field is renamed, update this filter.
#   - Returns empty dict (no floor) for items with no matching rows.
#     Callers must handle 0.0 return as "no floor configured".
# =============================================================================
def build_min_order_map(item_codes):
    """
    Build {(item_code, warehouse): min_qty_in_stock_uom} from Item Min Order Qty child table.
    Returns an empty dict for item codes with no rows in the table.
    Used by both component_mr_generator and mr_generator for the min-order floor.
    """
    result = {}
    if not item_codes:
        return result

    for item_code in item_codes:
        try:
            rows = frappe.db.get_all(
                "Item Min Order Qty",
                filters={"parent": item_code, "parentfield": "custom_min_order_qty"},
                fields=["warehouse", "min_order_qty", "conversion_factor", "stock_uom_qty"],
            )
            for row in rows:
                if not row.warehouse or not flt(row.min_order_qty):
                    continue
                # Prefer pre-computed stock_uom_qty; fallback to manual calculation
                stock_qty = flt(row.stock_uom_qty)
                if stock_qty <= 0:
                    cf = flt(row.conversion_factor) if flt(row.conversion_factor) > 0 else 1.0
                    stock_qty = flt(row.min_order_qty) * cf
                if stock_qty > 0:
                    result[(item_code, row.warehouse)] = stock_qty
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"build_min_order_map error for item {item_code}",
            )

    return result


# =============================================================================
# INTERNAL HELPERS
# =============================================================================

def _classify_items(item_codes):
    """
    Returns {item_code: "purchase" | "leaf" | "skip"}.
      purchase : custom_toc_auto_purchase = 1 (explicitly configured for auto MR)
      leaf     : no active default BOM AND not auto_manufacture (raw leaf node)
      skip     : custom_toc_auto_manufacture = 1 (WO already created) OR
                 has an active BOM but no auto flags (manual handling required)
    """
    if not item_codes:
        return {}

    item_meta = {
        r.name: r
        for r in frappe.get_all(
            "Item",
            filters={"name": ["in", item_codes]},
            fields=["name", "custom_toc_auto_purchase", "custom_toc_auto_manufacture"],
        )
    }

    # Items that have at least one active, default BOM
    ph = ", ".join(["%s"] * len(item_codes))
    items_with_bom = set(
        frappe.db.sql_list(
            f"SELECT DISTINCT item FROM `tabBOM`"
            f" WHERE item IN ({ph}) AND is_active = 1 AND is_default = 1",
            item_codes,
        )
    )

    result = {}
    for code in item_codes:
        meta = item_meta.get(code)
        if not meta:
            result[code] = "skip"
        elif cint(meta.custom_toc_auto_manufacture):
            # Already being manufactured — WO exists, no purchase MR needed
            result[code] = "skip"
        elif cint(meta.custom_toc_auto_purchase):
            result[code] = "purchase"
        elif code not in items_with_bom:
            # No active BOM → raw leaf node → must be purchased
            result[code] = "leaf"
        else:
            # Has a BOM but no auto flags — leave for manual handling
            result[code] = "skip"

    return result


def _get_bin_qtys(item_code, warehouse):
    """Return (actual_qty, ordered_qty) from Bin in stock_uom. Returns (0, 0) if no Bin row."""
    row = frappe.db.get_value(
        "Bin",
        {"item_code": item_code, "warehouse": warehouse},
        ["actual_qty", "ordered_qty"],
        as_dict=True,
    )
    if row:
        return flt(row.actual_qty), flt(row.ordered_qty)
    return 0.0, 0.0


def _has_open_component_mr(item_code, warehouse):
    """
    Return True if an open (non-cancelled, non-stopped) Purchase MR already
    exists for this item + warehouse. Prevents double-ordering when buffer
    engine and component engine both try to create MRs for the same item.
    """
    return bool(
        frappe.db.sql(
            """
            SELECT mr.name
            FROM `tabMaterial Request` mr
            JOIN `tabMaterial Request Item` mri ON mri.parent = mr.name
            WHERE mr.docstatus < 2
              AND mr.material_request_type = 'Purchase'
              AND mr.status NOT IN ('Stopped', 'Cancelled')
              AND mri.item_code = %s
              AND mri.warehouse = %s
            LIMIT 1
            """,
            (item_code, warehouse),
        )
    )


def _resolve_purchase_uom(item_code, stock_uom):
    """
    Return (purchase_uom, conversion_factor) for an item.
    Falls back to (stock_uom, 1.0) if no purchase_uom or no conversion factor found.
    """
    purchase_uom = frappe.db.get_value("Item", item_code, "purchase_uom") or stock_uom
    conversion_factor = 1.0
    if purchase_uom and purchase_uom != stock_uom:
        cf = frappe.db.get_value(
            "UOM Conversion Detail",
            {"parent": item_code, "uom": purchase_uom},
            "conversion_factor",
        )
        conversion_factor = flt(cf) if flt(cf) > 0 else 1.0
    if conversion_factor == 1.0:
        purchase_uom = stock_uom
    return purchase_uom, conversion_factor


def _create_warehouse_batch_mr(batch_items, warehouse, company, pp_name):
    """
    Create one Purchase MR with multiple line items, all destined for the same warehouse.

    batch_items: list of dicts:
        item_code, item_name, order_qty_stock, stock_uom, shortage, min_qty_stock
    Returns MR name.
    """
    mr = frappe.new_doc("Material Request")
    mr.material_request_type = "Purchase"
    mr.transaction_date = today()
    mr.company = company
    mr.schedule_date = add_days(today(), 3)
    mr.custom_toc_recorded_by = "By System"

    for item in batch_items:
        purchase_uom, conversion_factor = _resolve_purchase_uom(
            item["item_code"], item["stock_uom"]
        )

        mr_qty = (
            item["order_qty_stock"] / conversion_factor
            if conversion_factor != 1.0
            else item["order_qty_stock"]
        )

        floor_note = ""
        if item["min_qty_stock"] > 0 and item["order_qty_stock"] > item["shortage"]:
            floor_note = (
                f" (raised from {item['shortage']:.2f} to {item['order_qty_stock']:.2f}"
                f" {item['stock_uom']} — min order floor)"
            )

        mr.append("items", {
            "item_code": item["item_code"],
            "item_name": item["item_name"],
            "qty": mr_qty,
            "uom": purchase_uom,
            "stock_uom": item["stock_uom"],
            "conversion_factor": conversion_factor,
            "warehouse": warehouse,
            "schedule_date": mr.schedule_date,
            "description": (
                f"TOC Component Shortage | PP: {pp_name} | "
                f"Required: {item['order_qty_stock']:.2f} {item['stock_uom']}{floor_note}"
            ),
        })

    mr.flags.ignore_permissions = True
    mr.insert()

    summary = ", ".join(i["item_code"] for i in batch_items[:3])
    if len(batch_items) > 3:
        summary += f" +{len(batch_items) - 3} more"
    frappe.logger("chaizup_toc").info(
        f"Component MR {mr.name}: {len(batch_items)} items | {warehouse} | PP:{pp_name} | {summary}"
    )
    return mr.name


def _send_component_mr_summary(pp_name, created_mrs, skipped_items, no_min_qty_items):
    """Send HTML email summary to notification users with notify_on_component_mrs = 1."""
    recipients = _get_engine_notification_emails("notify_on_component_mrs")
    if not recipients:
        return

    now_str = now_datetime().strftime("%Y-%m-%d %H:%M")
    html = f"""
<div style="font-family:sans-serif;max-width:860px;margin:0 auto">
  <div style="background:#1e40af;color:white;padding:16px 20px;border-radius:8px 8px 0 0">
    <h2 style="margin:0;font-size:18px">TOC Engine — Component Shortage MRs</h2>
    <p style="margin:4px 0 0;opacity:0.85;font-size:13px">Production Plan: <b>{pp_name}</b> | Generated: {now_str}</p>
  </div>
  <div style="background:#f8fafc;padding:20px;border:1px solid #e2e8f0;border-top:none">
"""

    # Created MRs
    html += f'<h3 style="color:#166534;margin-top:0">&#x2705; MRs Created ({len(created_mrs)} warehouses)</h3>'
    if created_mrs:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">'
        html += '<thead><tr style="background:#dcfce7"><th style="padding:6px 10px;text-align:left;border:1px solid #a7f3d0">Material Request</th></tr></thead><tbody>'
        for mr_name in created_mrs:
            html += f'<tr><td style="padding:6px 10px;border:1px solid #d1fae5"><b>{mr_name}</b></td></tr>'
        html += '</tbody></table>'
    else:
        html += '<p style="color:#6b7280;font-size:13px">No MRs created (all items already have open MRs or no shortages).</p>'

    # Skipped items
    html += f'<h3 style="color:#92400e">&#x23ed;&#xfe0f; Items Skipped — Open MR Exists ({len(skipped_items)})</h3>'
    if skipped_items:
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">'
        html += '<thead><tr style="background:#fef3c7"><th style="padding:6px 10px;text-align:left;border:1px solid #fcd34d">Item Code</th><th style="padding:6px 10px;text-align:left;border:1px solid #fcd34d">Warehouse</th></tr></thead><tbody>'
        for i, s in enumerate(skipped_items):
            bg = "#fffbeb" if i % 2 == 0 else "#ffffff"
            html += f'<tr style="background:{bg}"><td style="padding:6px 10px;border:1px solid #fde68a">{s["item_code"]}</td><td style="padding:6px 10px;border:1px solid #fde68a">{s["warehouse"]}</td></tr>'
        html += '</tbody></table>'
    else:
        html += '<p style="color:#6b7280;font-size:13px">None skipped.</p>'

    # Missing min order qty
    html += f'<h3 style="color:#dc2626">&#x26a0;&#xfe0f; Items Without Min Order Qty Floor ({len(no_min_qty_items)})</h3>'
    if no_min_qty_items:
        html += '<p style="color:#6b7280;font-size:12px;margin-top:-8px">MRs created at raw shortage qty without minimum floor. Configure Min Order Qty in Item Master for better accuracy.</p>'
        html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px">'
        html += '<thead><tr style="background:#fee2e2"><th style="padding:6px 10px;text-align:left;border:1px solid #fca5a5">Item</th><th style="padding:6px 10px;text-align:left;border:1px solid #fca5a5">Warehouse</th><th style="padding:6px 10px;text-align:right;border:1px solid #fca5a5">Shortage (Stock UOM)</th></tr></thead><tbody>'
        for i, n in enumerate(no_min_qty_items):
            bg = "#fef2f2" if i % 2 == 0 else "#ffffff"
            html += (
                f'<tr style="background:{bg}">'
                f'<td style="padding:6px 10px;border:1px solid #fecaca"><b>{n["item_code"]}</b> — {n["item_name"]}</td>'
                f'<td style="padding:6px 10px;border:1px solid #fecaca">{n["warehouse"]}</td>'
                f'<td style="padding:6px 10px;text-align:right;border:1px solid #fecaca">{n["shortage"]:.2f}</td>'
                f'</tr>'
            )
        html += '</tbody></table>'
    else:
        html += '<p style="color:#166534;font-size:13px">&#x2714; All processed items have Min Order Qty configured.</p>'

    html += "  </div>\n</div>"

    frappe.sendmail(
        recipients=recipients,
        subject=f"TOC Component MRs — PP {pp_name} | {today()}",
        message=html,
        header=["TOC Component MRs", "blue"],
    )


def _get_engine_notification_emails(flag_field):
    """
    Return email addresses from TOC Settings → toc_engine_notification_users
    where the given flag_field is checked (= 1).
    """
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        users_table = getattr(settings, "toc_engine_notification_users", None) or []
        emails = []
        for row in users_table:
            if cint(getattr(row, flag_field, 0)) and row.user:
                email = frappe.db.get_value("User", row.user, "email")
                if email:
                    emails.append(email)
        return emails
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC: _get_engine_notification_emails failed")
        return []
