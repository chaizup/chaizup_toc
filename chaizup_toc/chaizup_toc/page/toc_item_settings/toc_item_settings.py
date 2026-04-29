# =============================================================================
# CONTEXT: TOC Item Settings Page — Backend API.
#   Supports the TOC Bulk Settings Dashboard:
#   a filterable item grid where managers can click any item and edit its
#   full TOC configuration (same fields as Item Master TOC tab) in a modal.
# MEMORY: app_chaizup_toc.md § TOC Item Settings Page
# INSTRUCTIONS:
#   - get_items_for_bulk_settings: paginated listing with toc/group/search
#     filters. Returns summary row per item (not full field set).
#   - get_item_toc_details: full TOC field set + buffer_rules child rows for
#     populating the modal. Called when modal opens. Also returns stock_uom
#     so the UI can display it next to all buffer quantity columns.
#   - save_item_toc_settings: receives JSON data from modal form, rebuilds
#     child table rows (clear-and-replace pattern), saves via doc API so that
#     on_item_validate fires (mutual-exclusion checks, T/CU recompute).
#     Uses flags.ignore_mandatory + flags.ignore_permissions.
#   - auto_detect_toc_settings: one-shot "smart" detection used by the
#     "Auto-Configure" button. Inspects BOM, is_purchase_item, is_manufacture_item,
#     and last SLE voucher_type to suggest mode. Fetches selling price from
#     the latest submitted Quotation → Sales Order (0% discount) → standard_rate.
#   - get_warehouses: returns all non-group, enabled warehouses for the
#     searchable datalist on the buffer rules warehouse input.
# DANGER ZONE:
#   - save uses clear-and-replace on custom_toc_buffer_rules. If JS sends an
#     incomplete rules list, existing rows are lost. The JS modal sends ALL
#     rows including existing ones.
#   - on_item_validate in overrides/item.py fires during save — it validates
#     auto_purchase/auto_manufacture mutual exclusion, BOM ownership, and
#     recomputes T/CU. Do NOT bypass save() with set_value.
#   - frappe.only_for() in save_item_toc_settings — only TOC Manager and
#     System Manager may write. TOC User gets read-only modal.
#   - auto_detect_toc_settings is READ-ONLY (no writes). It only suggests —
#     the user must review and click Save to persist any changes.
# RESTRICT:
#   - Do NOT skip on_item_validate.
#   - Do NOT use frappe.db.set_value for child table rows.
#   - Do NOT remove frappe.only_for() from save_item_toc_settings.
#   - auto_detect_toc_settings must NEVER write to the database.
#   - get_warehouses must NEVER return group warehouses (is_group=1).
# =============================================================================

import json

import frappe
from frappe.utils import flt, cint


@frappe.whitelist()
def get_items_for_bulk_settings(
    toc_filter="All",
    item_group=None,
    search=None,
    page_length=50,
    page_start=0,
):
    """
    Paginated item list for the bulk settings grid.
    toc_filter: "All" | "Active" | "Inactive"
    """
    conditions = ["i.disabled = 0"]
    params = {}

    if toc_filter == "Active":
        conditions.append("i.custom_toc_enabled = 1")
    elif toc_filter == "Inactive":
        conditions.append("(i.custom_toc_enabled = 0 OR i.custom_toc_enabled IS NULL)")

    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        params["item_group"] = item_group

    if search:
        conditions.append("(i.name LIKE %(search)s OR i.item_name LIKE %(search)s)")
        params["search"] = f"%{search}%"

    where = " AND ".join(conditions)

    params["limit"] = cint(page_length)
    params["offset"] = cint(page_start)

    items = frappe.db.sql(
        f"""
        SELECT
            i.name AS item_code,
            i.item_name,
            i.item_group,
            COALESCE(i.custom_toc_enabled, 0) AS toc_enabled,
            COALESCE(i.custom_toc_auto_purchase, 0) AS auto_purchase,
            COALESCE(i.custom_toc_auto_manufacture, 0) AS auto_manufacture,
            COALESCE(i.custom_toc_custom_adu, 0) AS custom_adu,
            COALESCE(i.custom_toc_adu_value, 0) AS adu_value,
            COALESCE(i.custom_toc_adu_period, '') AS adu_period,
            (
                SELECT COUNT(*)
                FROM `tabTOC Item Buffer` tib
                WHERE tib.parent = i.name AND tib.parentfield = 'custom_toc_buffer_rules'
            ) AS buffer_rules_count
        FROM `tabItem` i
        WHERE {where}
        ORDER BY i.custom_toc_enabled DESC, i.name ASC
        LIMIT %(limit)s OFFSET %(offset)s
        """,
        params,
        as_dict=True,
    )

    total = frappe.db.sql(
        f"SELECT COUNT(*) FROM `tabItem` i WHERE {where}",
        params,
    )[0][0]

    return {"items": items, "total": total}


@frappe.whitelist()
def get_item_toc_details(item_code):
    """Full TOC field set + buffer rules for modal population."""
    item = frappe.get_doc("Item", item_code)

    rules = []
    for r in item.get("custom_toc_buffer_rules") or []:
        rules.append({
            "name": r.name,
            "warehouse": r.warehouse,
            "adu": flt(r.adu),
            "rlt": flt(r.rlt),
            "variability_factor": flt(r.variability_factor),
            "target_buffer": flt(r.target_buffer),
            "daf": flt(r.daf) or 1.0,
            "adjusted_buffer": flt(r.adjusted_buffer),
            "red_zone_qty": flt(r.red_zone_qty),
            "yellow_zone_qty": flt(r.yellow_zone_qty),
            "enabled": cint(r.enabled),
        })

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "item_group": item.item_group,
        "stock_uom": item.stock_uom or "",
        "toc_enabled": cint(item.custom_toc_enabled),
        "auto_purchase": cint(item.custom_toc_auto_purchase),
        "auto_manufacture": cint(item.custom_toc_auto_manufacture),
        "custom_adu": cint(item.custom_toc_custom_adu),
        "adu_period": item.custom_toc_adu_period or "Last 90 Days",
        "adu_value": flt(item.custom_toc_adu_value),
        "adu_last_updated": str(item.custom_toc_adu_last_updated or ""),
        "selling_price": flt(item.custom_toc_selling_price),
        "tvc": flt(item.custom_toc_tvc),
        "constraint_speed": flt(item.custom_toc_constraint_speed),
        "tcu": flt(item.custom_toc_tcu),
        "default_bom": item.custom_toc_default_bom or "",
        "check_bom_availability": cint(item.custom_toc_check_bom_availability),
        "buffer_rules": rules,
    }


@frappe.whitelist()
def save_item_toc_settings(item_code, toc_data):
    """
    Save TOC settings for one item from the bulk modal.
    toc_data: JSON string with all TOC fields + buffer_rules list.
    Fires on_item_validate via doc.save() — validates mutual exclusion, recomputes T/CU.
    """
    frappe.only_for(["System Manager", "TOC Manager"])

    if isinstance(toc_data, str):
        toc_data = frappe.parse_json(toc_data)

    item = frappe.get_doc("Item", item_code)

    item.custom_toc_enabled = cint(toc_data.get("toc_enabled", 0))
    item.custom_toc_auto_purchase = cint(toc_data.get("auto_purchase", 0))
    item.custom_toc_auto_manufacture = cint(toc_data.get("auto_manufacture", 0))
    item.custom_toc_custom_adu = cint(toc_data.get("custom_adu", 0))
    item.custom_toc_adu_period = toc_data.get("adu_period") or "Last 90 Days"

    if cint(toc_data.get("custom_adu")):
        item.custom_toc_adu_value = flt(toc_data.get("adu_value", 0))

    item.custom_toc_selling_price = flt(toc_data.get("selling_price", 0))
    item.custom_toc_tvc = flt(toc_data.get("tvc", 0))
    item.custom_toc_constraint_speed = flt(toc_data.get("constraint_speed", 0))
    item.custom_toc_check_bom_availability = cint(toc_data.get("check_bom_availability", 1))

    # Rebuild buffer rules — clear-and-replace so deleted rows are removed
    item.set("custom_toc_buffer_rules", [])
    for rule in toc_data.get("buffer_rules") or []:
        if not rule.get("warehouse"):
            continue
        adu = flt(rule.get("adu", 0))
        rlt = flt(rule.get("rlt", 0))
        vf = flt(rule.get("variability_factor", 1.5))
        daf = flt(rule.get("daf", 1.0)) or 1.0
        target = round(adu * rlt * vf)
        adjusted = round(target * daf) if daf != 1.0 else 0
        item.append("custom_toc_buffer_rules", {
            "warehouse": rule["warehouse"],
            "adu": adu,
            "rlt": rlt,
            "variability_factor": vf,
            "target_buffer": target,
            "daf": daf,
            "adjusted_buffer": adjusted,
            "red_zone_qty": round(target * 0.33),
            "yellow_zone_qty": round(target * 0.66),
            "enabled": cint(rule.get("enabled", 1)),
        })

    item.flags.ignore_mandatory = True
    item.flags.ignore_permissions = True
    item.save()

    frappe.db.commit()
    return {"status": "ok", "item_code": item_code}


@frappe.whitelist()
def get_warehouses():
    """
    Returns all active, non-group warehouses for the searchable dropdown in the
    buffer rules table. Called once on page load, stored in tisApp.warehouses.
    """
    return frappe.db.sql(
        """
        SELECT name, warehouse_name, company
        FROM `tabWarehouse`
        WHERE disabled = 0 AND is_group = 0
        ORDER BY company, name ASC
        """,
        as_dict=True,
    )


# =============================================================================
# CONTEXT: Auto-detect replenishment mode and selling price for an item.
#   Called by the "⚡ Auto-Configure" button in the TOC Item Settings modal.
#   This is a READ-ONLY helper — it never writes to the database.
#
# Mode detection priority (first match wins):
#   1. Item has an active default BOM (docstatus=1, is_active=1, is_default=1)
#      → Manufacture
#   2. Item.is_purchase_item=1 and NOT is_manufacture_item=1
#      → Purchase
#   3. Latest Stock Ledger Entry (by posting_date DESC) — voucher_type:
#      "Purchase Receipt" | "Purchase Invoice" → Purchase
#      "Work Order" | "Manufacturing"           → Manufacture
#   4. Item.is_purchase_item=1 (final fallback)
#      → Purchase
#   If none match: mode = "Monitor"
#
# Selling price detection priority (for F5 T/CU):
#   1. Latest submitted Quotation item rate where rate > 0
#   2. Latest Sales Order item with discount_percentage = 0 and rate > 0
#   3. Item.standard_rate (if > 0)
#   Returns selling_price = 0 if nothing found.
#
# DANGER ZONE:
#   - Do NOT write to DB inside this function — read-only contract.
#   - BOM query uses is_active=1 + is_default=1 + docstatus=1 to avoid
#     draft or cancelled BOMs from triggering Manufacture mode incorrectly.
# RESTRICT:
#   - Do NOT add any frappe.db.set_value or doc.save() calls here.
# =============================================================================
@frappe.whitelist()
def auto_detect_toc_settings(item_code):
    """
    Detect replenishment mode and selling price from item data and transaction
    history. Returns suggestions only — does NOT save anything.
    """
    item = frappe.get_doc("Item", item_code)

    # ── Mode Detection ──────────────────────────────────────────────────────
    mode = "Monitor"
    mode_reason = "No active BOM, purchase/manufacture flags not set"

    has_bom = frappe.db.exists("BOM", {
        "item": item_code,
        "is_active": 1,
        "is_default": 1,
        "docstatus": 1,
    })

    if has_bom:
        mode = "Manufacture"
        mode_reason = "Active default BOM found"
    elif cint(item.is_purchase_item) and not cint(item.get("is_manufacture_item") or 0):
        mode = "Purchase"
        mode_reason = "Item flagged as purchase item (no manufacture flag)"
    else:
        latest_sle = frappe.db.sql(
            """
            SELECT voucher_type FROM `tabStock Ledger Entry`
            WHERE item_code = %s AND is_cancelled = 0
            ORDER BY posting_date DESC, posting_time DESC
            LIMIT 1
            """,
            item_code,
            as_dict=True,
        )
        if latest_sle:
            vtype = latest_sle[0].voucher_type
            if vtype in ("Purchase Receipt", "Purchase Invoice"):
                mode = "Purchase"
                mode_reason = f"Latest stock transaction: {vtype}"
            elif vtype in ("Work Order", "Manufacturing"):
                mode = "Manufacture"
                mode_reason = f"Latest stock transaction: {vtype}"
            elif cint(item.is_purchase_item):
                mode = "Purchase"
                mode_reason = "is_purchase_item=1"
            elif cint(item.get("is_manufacture_item") or 0):
                mode = "Manufacture"
                mode_reason = "is_manufacture_item=1"
        elif cint(item.is_purchase_item):
            mode = "Purchase"
            mode_reason = "is_purchase_item=1 (no stock history)"

    # ── Selling Price Detection ──────────────────────────────────────────────
    selling_price = 0.0
    price_source = ""

    # 1. Latest submitted Quotation item
    quot = frappe.db.sql(
        """
        SELECT qi.rate, q.name AS quotation_name, q.transaction_date
        FROM `tabQuotation Item` qi
        JOIN `tabQuotation` q ON q.name = qi.parent
        WHERE qi.item_code = %s AND q.docstatus = 1 AND qi.rate > 0
        ORDER BY q.transaction_date DESC, q.modified DESC
        LIMIT 1
        """,
        item_code,
        as_dict=True,
    )
    if quot and flt(quot[0].rate) > 0:
        selling_price = flt(quot[0].rate)
        price_source = f"Quotation {quot[0].quotation_name} ({quot[0].transaction_date})"
    else:
        # 2. Latest Sales Order item with 0% discount
        so = frappe.db.sql(
            """
            SELECT soi.rate, so.name AS so_name, so.transaction_date
            FROM `tabSales Order Item` soi
            JOIN `tabSales Order` so ON so.name = soi.parent
            WHERE soi.item_code = %s
              AND so.docstatus IN (0, 1)
              AND soi.rate > 0
              AND (soi.discount_percentage = 0 OR soi.discount_percentage IS NULL)
            ORDER BY so.transaction_date DESC, so.modified DESC
            LIMIT 1
            """,
            item_code,
            as_dict=True,
        )
        if so and flt(so[0].rate) > 0:
            selling_price = flt(so[0].rate)
            price_source = f"Sales Order {so[0].so_name} (0% discount, {so[0].transaction_date})"
        elif flt(item.standard_rate) > 0:
            selling_price = flt(item.standard_rate)
            price_source = "Item standard rate"

    return {
        "mode": mode,
        "mode_reason": mode_reason,
        "selling_price": selling_price,
        "price_source": price_source,
        "stock_uom": item.stock_uom or "",
        "item_name": item.item_name,
    }


@frappe.whitelist()
def get_item_groups():
    """Returns distinct item groups for the filter dropdown."""
    return frappe.db.sql(
        "SELECT DISTINCT item_group FROM `tabItem` WHERE disabled = 0 AND item_group IS NOT NULL ORDER BY item_group",
        as_list=True,
    )


# =============================================================================
# CONTEXT: Bulk save TOC settings across multiple items at once.
#   Called by the Bulk Configure modal — only saves the fields listed in
#   fields_to_apply; all other fields remain untouched for each item.
# MEMORY: app_chaizup_toc.md § TOC Item Settings Page | Multi-Select Bulk
# INSTRUCTIONS:
#   - fields_to_apply is the authoritative list of what to touch.
#   - replenishment_mode ("Purchase"/"Manufacture"/"Monitor") maps to the
#     auto_purchase / auto_manufacture pair.
#   - adu_period is a string ("Last 30 Days" etc), not an int.
#   - custom_adu: if None, clears the override flag and the value.
#   - Uses frappe.db.set_value for scalar fields (avoids child-table re-parse
#     and does not fire on_item_validate; intentional for bulk speed).
# DANGER ZONE:
#   - Does NOT rebuild buffer_rules child table — bulk only touches scalar fields.
#   - Does NOT fire on_item_validate — T/CU recompute does not run.
#     Acceptable because bulk configure only changes replenishment/ADU/BOM flags.
# RESTRICT:
#   - Do NOT add child-table edits here — use save_item_toc_settings for that.
#   - Do NOT remove frappe.only_for() guard.
# =============================================================================
# =============================================================================
# CONTEXT: Bulk auto-configure TOC for multiple items in one click.
#   Called by the "⚡ Auto-Enable TOC" button in the bulk action bar.
#   For each item: detects mode (same chain as auto_detect_toc_settings),
#   detects selling price, enables TOC, and auto-creates warehouse buffer
#   rules from Bin data if the item has no existing rules.
# INSTRUCTIONS:
#   - Mode detection order: active default BOM → is_purchase_item flag →
#     latest SLE voucher_type → flags fallback.
#   - Buffer rules created ONLY when item has zero existing rules — never
#     overwrites user-configured rules.
#   - Warehouses sourced from Bin (actual_qty > 0, top 5 by stock level).
#     Falls back to first enabled non-group warehouse if Bin is empty.
#   - Default RLT: 14 days for Purchase, 7 days for Manufacture.
#   - Default VF: 1.5 (moderate variability).
#   - Saves via doc.save() so on_item_validate fires (mutual-exclusion check,
#     T/CU recompute). Each item is saved independently; one failure does NOT
#     abort the rest.
# DANGER ZONE:
#   - Do NOT refactor to use frappe.db.set_value — on_item_validate MUST fire.
#   - Do NOT overwrite existing buffer rules — append only when rules list is empty.
#   - Per-item exceptions are caught, logged, and returned as status="error".
# RESTRICT:
#   - frappe.only_for() guard must NOT be removed.
#   - Do NOT add frappe.db.commit() inside the per-item loop — commit once at end.
# =============================================================================
@frappe.whitelist()
def bulk_auto_configure_toc(item_codes):
    """
    Auto-detect mode + enable TOC for each selected item.
    Returns {"success": True, "results": [...], "updated": N, "total": N}.
    """
    frappe.only_for(["System Manager", "TOC Manager"])

    if isinstance(item_codes, str):
        item_codes = frappe.parse_json(item_codes)

    if not item_codes:
        return {"success": False, "error": "No items provided"}

    results = []

    for item_code in item_codes:
        if not frappe.db.exists("Item", item_code):
            results.append({"item_code": item_code, "status": "skipped", "reason": "Item not found"})
            continue

        try:
            item = frappe.get_doc("Item", item_code)

            # ── Mode detection (mirrors auto_detect_toc_settings) ──
            mode = "Monitor"
            mode_reason = "No signals found — set Monitor"

            has_bom = frappe.db.exists("BOM", {
                "item": item_code, "is_active": 1, "is_default": 1, "docstatus": 1,
            })

            if has_bom:
                mode = "Manufacture"
                mode_reason = "Active default BOM found"
            elif cint(item.is_purchase_item) and not cint(item.get("is_manufacture_item") or 0):
                mode = "Purchase"
                mode_reason = "is_purchase_item=1"
            else:
                latest_sle = frappe.db.sql(
                    """SELECT voucher_type FROM `tabStock Ledger Entry`
                    WHERE item_code=%s AND is_cancelled=0
                    ORDER BY posting_date DESC, posting_time DESC LIMIT 1""",
                    item_code, as_dict=True,
                )
                if latest_sle:
                    vtype = latest_sle[0].voucher_type
                    if vtype in ("Purchase Receipt", "Purchase Invoice"):
                        mode, mode_reason = "Purchase", f"Last SLE: {vtype}"
                    elif vtype in ("Work Order", "Manufacturing"):
                        mode, mode_reason = "Manufacture", f"Last SLE: {vtype}"
                    elif cint(item.is_purchase_item):
                        mode, mode_reason = "Purchase", "is_purchase_item=1"
                    elif cint(item.get("is_manufacture_item") or 0):
                        mode, mode_reason = "Manufacture", "is_manufacture_item=1"
                elif cint(item.is_purchase_item):
                    mode, mode_reason = "Purchase", "is_purchase_item=1 (no stock history)"

            # ── Selling price detection ──
            selling_price = 0.0
            quot = frappe.db.sql(
                """SELECT qi.rate FROM `tabQuotation Item` qi
                JOIN `tabQuotation` q ON q.name=qi.parent
                WHERE qi.item_code=%s AND q.docstatus=1 AND qi.rate>0
                ORDER BY q.transaction_date DESC, q.modified DESC LIMIT 1""",
                item_code, as_dict=True,
            )
            if quot and flt(quot[0].rate) > 0:
                selling_price = flt(quot[0].rate)
            else:
                so_row = frappe.db.sql(
                    """SELECT soi.rate FROM `tabSales Order Item` soi
                    JOIN `tabSales Order` so ON so.name=soi.parent
                    WHERE soi.item_code=%s AND so.docstatus IN (0,1) AND soi.rate>0
                    AND (soi.discount_percentage=0 OR soi.discount_percentage IS NULL)
                    ORDER BY so.transaction_date DESC LIMIT 1""",
                    item_code, as_dict=True,
                )
                if so_row and flt(so_row[0].rate) > 0:
                    selling_price = flt(so_row[0].rate)
                elif flt(item.standard_rate) > 0:
                    selling_price = flt(item.standard_rate)

            # ── Apply core TOC flags ──
            item.custom_toc_enabled = 1
            item.custom_toc_auto_purchase = 1 if mode == "Purchase" else 0
            item.custom_toc_auto_manufacture = 1 if mode == "Manufacture" else 0
            if selling_price > 0:
                item.custom_toc_selling_price = selling_price

            # ── Auto-create buffer rules if none exist ──
            rules_added = 0
            if not (item.get("custom_toc_buffer_rules") or []):
                # Warehouses where item has actual stock (top 5 by qty)
                bin_rows = frappe.db.sql(
                    """SELECT warehouse FROM `tabBin`
                    WHERE item_code=%s AND actual_qty > 0
                    ORDER BY actual_qty DESC LIMIT 5""",
                    item_code, as_dict=True,
                )
                warehouses = [b.warehouse for b in bin_rows]

                # Fallback: first enabled non-group warehouse
                if not warehouses:
                    fallback = frappe.db.get_value(
                        "Warehouse", {"disabled": 0, "is_group": 0}, "name"
                    )
                    if fallback:
                        warehouses = [fallback]

                default_rlt = 14 if mode == "Purchase" else 7
                adu = flt(item.custom_toc_adu_value) or 0

                for wh in warehouses:
                    vf = 1.5
                    target = round(adu * default_rlt * vf)
                    item.append("custom_toc_buffer_rules", {
                        "warehouse": wh,
                        "adu": adu,
                        "rlt": default_rlt,
                        "variability_factor": vf,
                        "target_buffer": target,
                        "daf": 1.0,
                        "adjusted_buffer": 0,
                        "red_zone_qty": round(target * 0.33),
                        "yellow_zone_qty": round(target * 0.66),
                        "enabled": 1,
                    })
                    rules_added += 1

            # ── Save (fires on_item_validate: mutual-exclusion, T/CU recompute) ──
            item.flags.ignore_mandatory = True
            item.flags.ignore_permissions = True
            item.save()

            results.append({
                "item_code": item_code,
                "item_name": item.item_name,
                "status": "ok",
                "mode": mode,
                "mode_reason": mode_reason,
                "selling_price": selling_price,
                "rules_added": rules_added,
            })

        except Exception:
            frappe.log_error(frappe.get_traceback(), f"bulk_auto_configure_toc: {item_code}")
            results.append({
                "item_code": item_code,
                "status": "error",
                "reason": frappe.get_traceback().split("\n")[-2][:100],
            })

    frappe.db.commit()
    updated = sum(1 for r in results if r["status"] == "ok")
    return {"success": True, "results": results, "updated": updated, "total": len(results)}


@frappe.whitelist()
def bulk_save_toc_settings(item_codes, toc_data, fields_to_apply):
    """
    Apply a subset of TOC scalar fields to multiple items in one call.
    item_codes: JSON list of item_code strings.
    toc_data:   JSON dict of field values.
    fields_to_apply: JSON list of field keys to actually write.
    Returns {"success": True, "updated": N} on success.
    """
    frappe.only_for(["System Manager", "TOC Manager"])

    if isinstance(item_codes, str):
        item_codes = frappe.parse_json(item_codes)
    if isinstance(toc_data, str):
        toc_data = frappe.parse_json(toc_data)
    if isinstance(fields_to_apply, str):
        fields_to_apply = frappe.parse_json(fields_to_apply)

    if not item_codes:
        return {"success": False, "error": "No items provided"}
    if not fields_to_apply:
        return {"success": False, "error": "No fields selected to apply"}

    field_map = {
        "toc_enabled":           "custom_toc_enabled",
        "adu_period":            "custom_toc_adu_period",
        "check_bom_availability": "custom_toc_check_bom_availability",
    }

    updated = 0
    for item_code in item_codes:
        if not frappe.db.exists("Item", item_code):
            continue

        for field in fields_to_apply:
            if field == "toc_enabled":
                frappe.db.set_value("Item", item_code, "custom_toc_enabled",
                                    cint(toc_data.get("toc_enabled", 0)))

            elif field == "replenishment_mode":
                mode = toc_data.get("replenishment_mode", "Monitor")
                frappe.db.set_value("Item", item_code, "custom_toc_auto_purchase",
                                    1 if mode == "Purchase" else 0)
                frappe.db.set_value("Item", item_code, "custom_toc_auto_manufacture",
                                    1 if mode == "Manufacture" else 0)

            elif field == "adu_period":
                period = toc_data.get("adu_period") or "Last 90 Days"
                frappe.db.set_value("Item", item_code, "custom_toc_adu_period", period)

            elif field == "custom_adu":
                adu_val = toc_data.get("custom_adu")
                if adu_val is None:
                    frappe.db.set_value("Item", item_code, "custom_toc_custom_adu", 0)
                    frappe.db.set_value("Item", item_code, "custom_toc_adu_value", 0)
                else:
                    frappe.db.set_value("Item", item_code, "custom_toc_custom_adu", 1)
                    frappe.db.set_value("Item", item_code, "custom_toc_adu_value",
                                        flt(adu_val))

            elif field == "check_bom_availability":
                frappe.db.set_value("Item", item_code, "custom_toc_check_bom_availability",
                                    cint(toc_data.get("check_bom_availability", 1)))

        updated += 1

    frappe.db.commit()
    return {"success": True, "updated": updated}
