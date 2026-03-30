"""
TOC Buffer Calculator — Core Engine
=====================================
Reads from built-in ERPNext Bin + Work Order + Item DocTypes.
Custom Fields on Item hold buffer config.
Child table 'TOC Item Buffer' holds per-warehouse rules.

ERPNext Data Sources:
  ┌──────────────────┬─────────────┬───────────────┐
  │ TOC Concept      │ DocType     │ Field         │
  ├──────────────────┼─────────────┼───────────────┤
  │ On-Hand          │ Bin         │ actual_qty    │
  │ WIP (FG)         │ Work Order  │ qty-produced  │
  │ Backorders (FG)  │ Bin         │ reserved_qty  │
  │ On-Order (RM)    │ Bin         │ ordered_qty   │
  │ Committed (RM)   │ Bin         │ reserved_qty  │
  │ ADU, RLT, VF     │ Item child  │ TOC Item Buf  │
  │ Buffer Type      │ Item        │ custom field  │
  └──────────────────┴─────────────┴───────────────┘
"""

import frappe
from frappe.utils import flt, today, cint
from frappe import _


# ═══════════════════════════════════════════════════════
# ZONE LOGIC
# ═══════════════════════════════════════════════════════

def get_zone(bp_pct, settings=None):
    """
    F3: Determine buffer zone from penetration percentage.

    Zone thresholds are configurable in TOC Settings.
    Default: Green < 33% | Yellow 33-67% | Red 67-100% | Black > 100%
    """
    if not settings:
        settings = _get_settings()
    bp = flt(bp_pct)
    if bp >= 100:
        return "Black"
    if bp >= flt(settings.red_zone_threshold):
        return "Red"
    if bp >= flt(settings.yellow_zone_threshold):
        return "Yellow"
    return "Green"


def get_zone_color(zone):
    """Jinja helper for print formats and reports."""
    return {"Green": "#27AE60", "Yellow": "#F39C12", "Red": "#E74C3C", "Black": "#2C3E50"}.get(zone, "#7F8C8D")


def get_zone_label(zone):
    """Jinja helper — emoji + zone name."""
    return {"Green": "🟢 GREEN", "Yellow": "🟡 YELLOW", "Red": "🔴 RED", "Black": "⚫ BLACK"}.get(zone, zone)


def get_zone_action(zone, buffer_type="FG"):
    """Return action text for each zone."""
    actions = {
        "FG": {"Green": "No action", "Yellow": "Plan production", "Red": "PRODUCE NOW", "Black": "EMERGENCY"},
        "RM": {"Green": "No action", "Yellow": "Standard PO", "Red": "ORDER NOW + Express", "Black": "EMERGENCY — Alt supplier"},
        "PM": {"Green": "No action", "Yellow": "Standard PO", "Red": "ORDER NOW + Express", "Black": "EMERGENCY — Alt supplier"},
        "SFG": {"Green": "No action", "Yellow": "Plan blending", "Red": "BLEND NOW", "Black": "EMERGENCY"},
    }
    return actions.get(buffer_type, actions["FG"]).get(zone, "Unknown")


# ═══════════════════════════════════════════════════════
# INVENTORY POSITION CALCULATORS
# ═══════════════════════════════════════════════════════

def get_fg_position(item_code, warehouse, settings=None):
    """
    F2a: FG Inventory Position = On-Hand + WIP − Backorders

    When TOC Settings has Warehouse Classification rules:
      - On-Hand: SUM of Bin.actual_qty across all Inventory-classified warehouses
      - WIP:     Work Orders targeting Inventory/WIP warehouses
                 + Bin.actual_qty in WIP-classified warehouses
      - Backorders: SUM of Bin.reserved_qty across Inventory warehouses
    Fallback (no warehouse rules): single warehouse lookup (original behavior).
    """
    if settings is None:
        settings = _get_settings()

    wh = _get_warehouse_lists(settings)

    if wh["inventory"]:
        on_hand = _sum_bin_field(item_code, wh["inventory"], "actual_qty")
        backorders = _sum_bin_field(item_code, wh["inventory"], "reserved_qty")

        # Work Orders destined for Inventory or WIP warehouses
        wo_target_whs = wh["inventory"] + wh["wip"]
        placeholders = ", ".join(["%s"] * len(wo_target_whs))
        wip_from_wo = flt(frappe.db.sql(
            f"""SELECT COALESCE(SUM(qty - produced_qty), 0)
                FROM `tabWork Order`
                WHERE production_item = %s AND docstatus = 1
                AND status NOT IN ('Completed', 'Stopped', 'Cancelled')
                AND fg_warehouse IN ({placeholders})""",
            [item_code] + wo_target_whs
        )[0][0])

        # Dedicated WIP warehouse bins (for companies without Work Orders)
        wip_from_bins = _sum_bin_field(item_code, wh["wip"], "actual_qty") if wh["wip"] else 0.0
        wip = wip_from_wo + wip_from_bins
    else:
        # Fallback: single warehouse (original behavior — backward-compatible)
        bin_data = frappe.db.get_value("Bin",
            {"item_code": item_code, "warehouse": warehouse},
            ["actual_qty", "reserved_qty"], as_dict=True
        ) or {"actual_qty": 0, "reserved_qty": 0}
        on_hand = flt(bin_data.get("actual_qty"))
        backorders = flt(bin_data.get("reserved_qty"))
        wip = flt(frappe.db.sql("""
            SELECT COALESCE(SUM(qty - produced_qty), 0)
            FROM `tabWork Order`
            WHERE production_item = %s AND docstatus = 1
            AND status NOT IN ('Completed', 'Stopped', 'Cancelled')
        """, item_code)[0][0])

    return {"on_hand": on_hand, "wip": wip, "backorders": backorders,
            "ip": on_hand + wip - backorders}


def get_sfg_position(item_code, warehouse, settings=None):
    """
    F2 (SFG): Same as FG — blending Work Orders behave identically to production WOs.
    """
    return get_fg_position(item_code, warehouse, settings)


def get_rm_position(item_code, warehouse, settings=None):
    """
    F2b: RM/PM Inventory Position = On-Hand + On-Order − Committed

    When TOC Settings has Warehouse Classification rules:
      - On-Hand:  SUM Bin.actual_qty across Inventory warehouses
      - On-Order: SUM Bin.ordered_qty across Inventory + WIP warehouses
      - Committed: SUM Bin.reserved_qty across Inventory warehouses
    Fallback (no warehouse rules): single warehouse lookup (original behavior).
    """
    if settings is None:
        settings = _get_settings()

    wh = _get_warehouse_lists(settings)

    if wh["inventory"]:
        on_hand = _sum_bin_field(item_code, wh["inventory"], "actual_qty")
        on_order = _sum_bin_field(item_code, wh["inventory"] + wh["wip"], "ordered_qty")
        committed = _sum_bin_field(item_code, wh["inventory"], "reserved_qty")
    else:
        bin_data = frappe.db.get_value("Bin",
            {"item_code": item_code, "warehouse": warehouse},
            ["actual_qty", "ordered_qty", "reserved_qty"], as_dict=True
        ) or {"actual_qty": 0, "ordered_qty": 0, "reserved_qty": 0}
        on_hand = flt(bin_data.get("actual_qty"))
        on_order = flt(bin_data.get("ordered_qty"))
        committed = flt(bin_data.get("reserved_qty"))

    return {"on_hand": on_hand, "on_order": on_order, "committed": committed,
            "ip": on_hand + on_order - committed}


# ═══════════════════════════════════════════════════════
# MAIN CALCULATION ENGINE
# ═══════════════════════════════════════════════════════

def calculate_all_buffers(buffer_type=None, company=None, warehouse=None, item_code=None):
    """
    Calculate IP, BP%, Zone, Order Qty for all enabled buffer configs.
    Reads from Item.custom_toc_buffer_rules (child table).

    Returns list sorted by BP% desc (most urgent first), T/CU as tie-breaker.
    """
    settings = _get_settings()

    # Build filters for Items with TOC enabled.
    # NOTE: buffer_type is NOT added to the SQL filter here because items may have
    # no custom_toc_buffer_type set and rely on item_group_rules for resolution.
    # Python-level filtering is applied after type resolution below.
    item_filters = {"custom_toc_enabled": 1, "disabled": 0}
    if item_code:
        item_filters["name"] = item_code

    items = frappe.get_all("Item", filters=item_filters,
        fields=["name", "item_name", "item_group", "stock_uom", "custom_toc_buffer_type",
                "custom_toc_auto_purchase", "custom_toc_auto_manufacture", "custom_toc_selling_price", "custom_toc_tvc",
                "custom_toc_constraint_speed", "custom_toc_tcu", "custom_toc_default_bom"])

    results = []
    for item in items:
        # Resolve buffer_type: item-level setting wins; fall back to item group rules
        btype = item.custom_toc_buffer_type
        if not btype:
            btype = _resolve_buffer_type(item.name, item.item_group, settings)
            if not btype:
                frappe.log_error(
                    f"Item {item.name} has TOC enabled but no buffer_type set and no matching "
                    f"Item Group rule in TOC Settings. Item skipped.",
                    "TOC Buffer Type Unresolved"
                )
                continue
            # Attach resolved type so _calculate_single can use it
            item.custom_toc_buffer_type = btype

        # Apply buffer_type filter after resolution
        if buffer_type and btype != buffer_type:
            continue

        # Get all buffer rules (child table rows) for this item
        rules = frappe.get_all("TOC Item Buffer",
            filters={"parent": item.name, "parentfield": "custom_toc_buffer_rules", "enabled": 1},
            fields=["*"])

        if warehouse:
            rules = [r for r in rules if r.warehouse == warehouse]

        for rule in rules:
            try:
                result = _calculate_single(item, rule, settings)
                if result:
                    results.append(result)
            except Exception:
                frappe.log_error(frappe.get_traceback(),
                    f"TOC Calc Error: {item.name} / {rule.warehouse}")

    # F3+F5: Primary sort by BP% desc, secondary by T/CU desc
    results.sort(key=lambda x: (-x["bp_pct"], -x["tcu"]))
    return results


def _calculate_single(item, rule, settings):
    """Calculate buffer status for one item-warehouse pair."""
    # Effective buffer = adjusted (DAF) or base target
    target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
    if target <= 0:
        return None

    btype = item.custom_toc_buffer_type
    # F2: Get inventory position (settings passed for warehouse classification)
    if btype == "FG":
        pos = get_fg_position(item.name, rule.warehouse, settings)
    elif btype == "SFG":
        pos = get_sfg_position(item.name, rule.warehouse, settings)
    else:
        pos = get_rm_position(item.name, rule.warehouse, settings)

    ip = flt(pos["ip"])

    # F3: Buffer Penetration % and Stock Remaining %
    bp_pct = max(0, (target - ip) / target * 100)
    sr_pct = min(100, max(0, ip / target * 100))
    zone = get_zone(bp_pct, settings)

    # F4: Order Qty
    order_qty = max(0, target - ip)

    # Check BOM component availability if this FG/SFG has a BOM linked
    sfg_status = None
    if btype == "FG" and item.custom_toc_default_bom:
        try:
            sfg_status = check_bom_availability(item.name, order_qty, rule.warehouse)
        except Exception:
            sfg_status = {"available": True, "message": "BOM check skipped (error)"}

    company = frappe.db.get_value("Warehouse", rule.warehouse, "company")

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "stock_uom": item.stock_uom,
        "warehouse": rule.warehouse,
        "company": company,
        "buffer_type": btype,
        "mr_type": "Manufacture" if item.custom_toc_auto_manufacture else "Purchase",
        # Position
        "on_hand": pos.get("on_hand", 0),
        "wip_or_on_order": pos.get("wip", pos.get("on_order", 0)),
        "backorders_or_committed": pos.get("backorders", pos.get("committed", 0)),
        "inventory_position": round(ip, 2),
        # Buffer status
        "target_buffer": target,
        "bp_pct": round(bp_pct, 1),
        "sr_pct": round(sr_pct, 1),
        "zone": zone,
        "zone_color": get_zone_color(zone),
        "zone_action": get_zone_action(zone, btype),
        "order_qty": round(order_qty, 2),
        # T/CU
        "tcu": flt(item.custom_toc_tcu),
        # Rule metadata
        "adu": flt(rule.adu),
        "rlt": flt(rule.rlt),
        "vf": flt(rule.variability_factor),
        "daf": flt(rule.daf) or 1.0,
        "rule_name": rule.name,
        # SFG check
        "sfg_item": item.custom_toc_default_bom or "",
        "sfg_status": sfg_status,
    }



# ═══════════════════════════════════════════════════════
# DOC EVENT HANDLERS (called by hooks.py)
# ═══════════════════════════════════════════════════════

def on_stock_movement(doc, method):
    """Triggered on every Stock Ledger Entry — async buffer check."""
    if not _is_toc_item(doc.item_code):
        return
    frappe.enqueue(
        "chaizup_toc.toc_engine.buffer_calculator.check_realtime_alert",
        item_code=doc.item_code, warehouse=doc.warehouse,
        queue="short", enqueue_after_commit=True)


def on_demand_change(doc, method):
    """Sales Order submit/cancel → reserved_qty changes → check FG buffers."""
    for item in doc.items:
        if _is_toc_item(item.item_code, "FG"):
            frappe.enqueue(
                "chaizup_toc.toc_engine.buffer_calculator.check_realtime_alert",
                item_code=item.item_code, warehouse=item.warehouse,
                queue="short", enqueue_after_commit=True)


def on_supply_change(doc, method):
    """Work Order / PO changes → WIP/on_order changes → check buffers."""
    item_code = getattr(doc, "production_item", None) or getattr(doc, "item_code", None)
    if not item_code:
        # Purchase Order has items child table
        for item in getattr(doc, "items", []):
            if _is_toc_item(item.item_code):
                frappe.enqueue(
                    "chaizup_toc.toc_engine.buffer_calculator.check_realtime_alert",
                    item_code=item.item_code, warehouse=item.warehouse,
                    queue="short", enqueue_after_commit=True)
        return

    if _is_toc_item(item_code):
        frappe.enqueue(
            "chaizup_toc.toc_engine.buffer_calculator.check_realtime_alert",
            item_code=item_code, warehouse=None,
            queue="short", enqueue_after_commit=True)


def check_realtime_alert(item_code, warehouse=None):
    """Check a single item's buffer and send browser alert if Red/Black."""
    results = calculate_all_buffers(item_code=item_code, warehouse=warehouse)
    for r in results:
        if r["zone"] in ("Red", "Black"):
            frappe.publish_realtime("toc_buffer_alert", {
                "item_code": r["item_code"],
                "item_name": r["item_name"],
                "zone": r["zone"],
                "bp_pct": r["bp_pct"],
                "order_qty": r["order_qty"],
                "warehouse": r["warehouse"],
            }, after_commit=True)


# ═══════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════

def _is_toc_item(item_code, buffer_type=None):
    """Check if an item has TOC buffer management enabled."""
    filters = {"name": item_code, "custom_toc_enabled": 1}
    if buffer_type:
        filters["custom_toc_buffer_type"] = buffer_type
    return frappe.db.exists("Item", filters)


def _get_settings():
    """Get cached TOC Settings singleton."""
    try:
        return frappe.get_cached_doc("TOC Settings")
    except Exception:
        # Return defaults if settings don't exist yet
        return frappe._dict({
            "red_zone_threshold": 67,
            "yellow_zone_threshold": 33,
            "tmr_red_pct_of_rlt": 20,
            "tmg_cycles_required": 3,
            "dbm_adjustment_pct": 33,
            "max_tmr_consecutive": 3,
            "min_buffer_floor": 50,
            "warehouse_rules": [],
            "item_group_rules": [],
        })


def _get_warehouse_lists(settings):
    """
    Parse TOC Settings warehouse_rules into categorised lists.

    Returns:
        dict with keys:
          "inventory"  — warehouses whose Bin.actual_qty counts as on-hand
          "wip"        — warehouses counted as WIP (also filters Work Order fg_warehouse)
          "excluded"   — never counted (Scrap, Expiry, Wastage, QC Hold)

    If warehouse_rules is empty the caller falls back to single-warehouse mode
    (backward-compatible with existing per-rule warehouse setup).
    """
    wh = {"inventory": [], "wip": [], "excluded": []}
    for r in (getattr(settings, "warehouse_rules", None) or []):
        purpose = (r.warehouse_purpose or "").strip()
        if purpose == "Inventory":
            wh["inventory"].append(r.warehouse)
        elif purpose == "WIP":
            wh["wip"].append(r.warehouse)
        elif purpose == "Excluded":
            wh["excluded"].append(r.warehouse)
    return wh


def _sum_bin_field(item_code, warehouses, field):
    """
    Sum a single Bin field across a list of warehouses for one item.
    Returns 0.0 if the warehouse list is empty.
    """
    if not warehouses:
        return 0.0
    placeholders = ", ".join(["%s"] * len(warehouses))
    result = frappe.db.sql(
        f"SELECT COALESCE(SUM(`{field}`), 0) FROM `tabBin` "
        f"WHERE item_code = %s AND warehouse IN ({placeholders})",
        [item_code] + warehouses
    )
    return flt(result[0][0]) if result else 0.0


def _resolve_buffer_type(item_code, item_group, settings):
    """
    Resolve buffer type for an item using TOC Settings item_group_rules.

    Resolution order:
      1. Exact item_group match (lowest priority number wins on tie)
      2. Parent group match if include_sub_groups = 1 (walks hierarchy upward)
      3. Returns None — item will be skipped, Error Log entry written

    Item-level custom_toc_buffer_type always takes precedence over this function;
    callers should check it BEFORE calling here.
    """
    rules = getattr(settings, "item_group_rules", None) or []
    if not rules:
        return None

    # Sort ascending by priority so lower numbers are checked first
    sorted_rules = sorted(rules, key=lambda r: (r.priority if r.priority is not None else 10))

    # Build lookup maps
    exact_map = {}
    sub_group_map = {}
    for r in sorted_rules:
        if r.item_group not in exact_map:
            exact_map[r.item_group] = r.buffer_type
        if r.include_sub_groups and r.item_group not in sub_group_map:
            sub_group_map[r.item_group] = r.buffer_type

    # 1. Exact match
    if item_group in exact_map:
        return exact_map[item_group]

    # 2. Walk item group hierarchy
    visited = set()
    parent = frappe.db.get_value("Item Group", item_group, "parent_item_group")
    while parent and parent not in visited and parent != "All Item Groups":
        visited.add(parent)
        if parent in sub_group_map:
            return sub_group_map[parent]
        parent = frappe.db.get_value("Item Group", parent, "parent_item_group")

    return None


# ═══════════════════════════════════════════════════════
# R3: MULTI-LEVEL BOM AVAILABILITY CHECK
# ═══════════════════════════════════════════════════════

def check_bom_availability(item_code, required_qty, warehouse=None):
    """
    R3: Walk the BOM tree for an FG/SFG item and check component availability.

    One FG BOM can have multiple SFGs + materials.
    One SFG BOM can have multiple sub-SFGs + materials.
    This function recursively checks each level.

    Returns:
        dict with component-level availability status
    """
    bom_name = frappe.db.get_value("Item", item_code, "custom_toc_default_bom")
    check_enabled = frappe.db.get_value("Item", item_code, "custom_toc_check_bom_availability")

    if not bom_name or not check_enabled:
        return {"available": True, "components": [], "message": "No BOM check configured"}

    components = []
    _walk_bom(bom_name, required_qty, 1.0, warehouse, components, depth=0, max_depth=5)

    shortfalls = [c for c in components if not c["available"]]

    return {
        "available": len(shortfalls) == 0,
        "total_components": len(components),
        "shortfalls": len(shortfalls),
        "components": components,
        "message": f"{len(shortfalls)} component(s) short" if shortfalls else "All components available",
    }


def _walk_bom(bom_name, parent_qty, multiplier, warehouse, results, depth, max_depth):
    """Recursively walk BOM tree. Handles multi-level SFG→SFG→RM structures."""
    if depth > max_depth:
        return  # Safety: prevent infinite recursion

    bom_items = frappe.get_all("BOM Item",
        filters={"parent": bom_name, "parenttype": "BOM"},
        fields=["item_code", "item_name", "qty", "stock_qty", "uom", "stock_uom"])

    for bi in bom_items:
        required = flt(bi.stock_qty or bi.qty) * multiplier * parent_qty
        item_type = frappe.db.get_value("Item", bi.item_code, "custom_toc_buffer_type") or ""
        is_toc = frappe.db.get_value("Item", bi.item_code, "custom_toc_enabled")

        # Get current stock
        actual_qty = 0
        if warehouse:
            actual_qty = flt(frappe.db.get_value("Bin",
                {"item_code": bi.item_code, "warehouse": warehouse}, "actual_qty"))
        else:
            # Sum across all warehouses
            actual_qty = flt(frappe.db.sql(
                "SELECT COALESCE(SUM(actual_qty),0) FROM `tabBin` WHERE item_code=%s",
                bi.item_code)[0][0])

        available = actual_qty >= required

        results.append({
            "item_code": bi.item_code,
            "item_name": bi.item_name,
            "item_type": item_type,
            "is_toc_managed": bool(is_toc),
            "required_qty": round(required, 2),
            "available_qty": round(actual_qty, 2),
            "shortfall": round(max(0, required - actual_qty), 2),
            "available": available,
            "depth": depth,
        })

        # If this component is itself an SFG with a BOM, recurse
        if item_type == "SFG":
            sub_bom = frappe.db.get_value("Item", bi.item_code, "custom_toc_default_bom")
            if sub_bom:
                _walk_bom(sub_bom, required, 1.0, warehouse, results, depth + 1, max_depth)
