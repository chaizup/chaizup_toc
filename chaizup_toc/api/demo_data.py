"""
TOC Demo Data Generator
========================
Creates test items, stock, BOMs, delivery notes to exercise every TOC trigger.
Admin only. Tracks every created doc for one-click cleanup.

Scenarios created:
  🔴 RED:    Manufacture item with very low stock (BP% ~80%)
  🟡 YELLOW: Manufacture item with medium stock (BP% ~50%)
  🟢 GREEN:  Manufacture item with healthy stock (BP% ~15%)
  🔴 RED:    Purchase item with low stock
  🟢 GREEN:  Purchase item with healthy stock
  🟡 YELLOW: Purchase item with medium stock
  🏭 SFG:   Sub-assembly (Manufacture) linked via BOM

All names prefixed with TOC-DEMO- for easy identification.
"""

import frappe
import json
from frappe.utils import today, add_days, nowdate, flt, now_datetime
from frappe import _

PREFIX = "TOC-DEMO-"


@frappe.whitelist()
def create_demo_data():
    """Create full test dataset. Admin only."""
    frappe.only_for("Administrator")

    # Don't create twice
    existing = _get_manifest()
    if existing:
        frappe.throw("Demo data already exists. Delete it first before creating new data.")

    manifest = {"items": [], "stock_entries": [], "boms": [], "delivery_notes": [],
                "warehouses": [], "item_groups": [], "customers": []}

    try:
        company = _get_company()
        warehouse = _get_or_create_warehouse(company, manifest)
        customer = _get_or_create_customer(company, manifest)

        # ── CREATE ITEMS ──
        items_config = [
            {"code": f"{PREFIX}FG-MASALA-1KG", "name": "Masala Tea 1kg [DEMO]",
             "group": "Products", "uom": "Nos",
             "adu": 200, "rlt": 3, "vf": 1.5, "price": 380, "tvc": 172, "speed": 30,
             "stock_qty": 200, "target": 900, "auto_mfg": 1},

            {"code": f"{PREFIX}FG-GINGER-500G", "name": "Ginger Tea 500g [DEMO]",
             "group": "Products", "uom": "Nos",
             "adu": 180, "rlt": 3, "vf": 1.5, "stock_qty": 450, "target": 810,
             "price": 195, "tvc": 81, "speed": 40, "auto_mfg": 1},

            {"code": f"{PREFIX}FG-CARDAMOM-200G", "name": "Cardamom Tea 200g [DEMO]",
             "group": "Products", "uom": "Nos",
             "adu": 280, "rlt": 3, "vf": 1.5, "stock_qty": 1100, "target": 1260,
             "price": 90, "tvc": 41, "speed": 45, "auto_mfg": 1},

            {"code": f"{PREFIX}SFG-MASALA-BLEND", "name": "Masala Premix Blend [DEMO]",
             "group": "Sub Assemblies", "uom": "Kg",
             "adu": 150, "rlt": 1.5, "vf": 1.3, "stock_qty": 200, "target": 293, "auto_mfg": 1},

            {"code": f"{PREFIX}RM-TEA-DUST", "name": "Tea Dust CTC [DEMO]",
             "group": "Raw Material", "uom": "Kg",
             "adu": 450, "rlt": 10, "vf": 1.6, "stock_qty": 1800, "target": 7200, "auto_pur": 1},

            {"code": f"{PREFIX}RM-SUGAR", "name": "Sugar [DEMO]",
             "group": "Raw Material", "uom": "Kg",
             "adu": 1500, "rlt": 5, "vf": 1.3, "stock_qty": 8000, "target": 9750, "auto_pur": 1},

            {"code": f"{PREFIX}PM-POUCH-1KG", "name": "1kg Printed Pouch [DEMO]",
             "group": "Consumable", "uom": "Nos",
             "adu": 200, "rlt": 18, "vf": 1.5, "stock_qty": 3000, "target": 5400, "auto_pur": 1},
        ]

        for ic in items_config:
            item = _create_item(ic, company, warehouse, manifest)

        # ── CREATE BOM: FG-MASALA → SFG-BLEND + RM-TEA + PM-POUCH ──
        bom = _create_bom(
            f"{PREFIX}FG-MASALA-1KG",
            [
                {
                    "item_code": f"{PREFIX}SFG-MASALA-BLEND",
                    "qty": 0.95,
                    "uom": "Kg",
                },
                {
                    "item_code": f"{PREFIX}RM-TEA-DUST",
                    "qty": 0.05,
                    "uom": "Kg",
                },
                {
                    "item_code": f"{PREFIX}PM-POUCH-1KG",
                    "qty": 1,
                    "uom": "Nos",
                },
            ],
            company, manifest
        )

        # Link BOM to item
        if bom:
            frappe.db.set_value("Item", f"{PREFIX}FG-MASALA-1KG",
                                "custom_toc_default_bom", bom)

        # ── CREATE DELIVERY NOTES (for ADU history) ──
        for days_ago in [5, 12, 20, 35, 50, 70]:
            _create_delivery_note(
                customer, company, warehouse,
                f"{PREFIX}FG-MASALA-1KG", 200,
                add_days(today(), -days_ago), manifest
            )

        for days_ago in [3, 15, 30, 45, 60]:
            _create_delivery_note(
                customer, company, warehouse,
                f"{PREFIX}FG-GINGER-500G", 180,
                add_days(today(), -days_ago), manifest
            )

        # ── SAVE MANIFEST ──
        _save_manifest(manifest)
        frappe.db.commit()

        # Count zones
        zones = {"red": 0, "yellow": 0, "green": 0}
        for ic in items_config:
            bp = max(0, (ic["target"] - ic["stock_qty"]) / ic["target"] * 100)
            if bp >= 67:
                zones["red"] += 1
            elif bp >= 33:
                zones["yellow"] += 1
            else:
                zones["green"] += 1

        total_docs = sum(len(v) for v in manifest.values())
        return {
            "status": "success",
            "message": f"Created {total_docs} documents: {len(manifest['items'])} items, "
                       f"{len(manifest['stock_entries'])} stock entries, "
                       f"{len(manifest['boms'])} BOMs, "
                       f"{len(manifest['delivery_notes'])} delivery notes. "
                       f"Zones: {zones['red']} Red, {zones['yellow']} Yellow, {zones['green']} Green.",
            "manifest": manifest,
        }

    except Exception:
        frappe.db.rollback()
        frappe.log_error(frappe.get_traceback(), "TOC Demo Data Creation Failed")
        frappe.throw("Demo data creation failed. Check Error Log for details.")


@frappe.whitelist()
def delete_demo_data():
    """Delete all demo data. Admin only. Uses manifest to track exact docs."""
    frappe.only_for("Administrator")

    manifest = _get_manifest()
    if not manifest:
        frappe.throw("No demo data found. Nothing to delete.")

    deleted = 0
    errors = []

    # Delete in reverse dependency order
    delete_order = ["delivery_notes", "boms", "stock_entries", "items",
                    "customers", "warehouses", "item_groups"]

    for doc_group in delete_order:
        docs = manifest.get(doc_group, [])
        for doc_info in reversed(docs):
            try:
                dt = doc_info["doctype"]
                dn = doc_info["name"]
                if frappe.db.exists(dt, dn):
                    doc = frappe.get_doc(dt, dn)
                    # Cancel if submitted
                    if hasattr(doc, "docstatus") and doc.docstatus == 1:
                        doc.flags.ignore_permissions = True
                        doc.cancel()
                    # Delete
                    frappe.delete_doc(dt, dn, force=True, ignore_permissions=True)
                    deleted += 1
            except Exception as e:
                errors.append(f"{doc_info.get('doctype')}/{doc_info.get('name')}: {str(e)[:80]}")

    # Clear manifest
    _save_manifest(None)
    frappe.db.commit()

    msg = f"Deleted {deleted} documents."
    if errors:
        msg += f" {len(errors)} errors (check Error Log)."
        frappe.log_error("\n".join(errors), "TOC Demo Data Deletion Errors")

    return {"status": "success", "message": msg, "deleted": deleted, "errors": len(errors)}


@frappe.whitelist()
def get_demo_status():
    """Check if demo data exists."""
    manifest = _get_manifest()
    if not manifest:
        return {"exists": False, "count": 0}
    total = sum(len(v) for v in manifest.values())
    return {"exists": True, "count": total, "manifest": manifest}


# ═══════════════════════════════════════════════════════
# INTERNAL HELPERS
# ═══════════════════════════════════════════════════════

def _get_manifest():
    try:
        raw = frappe.db.get_single_value("TOC Settings", "demo_data_manifest")
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _save_manifest(manifest):
    frappe.db.set_single_value("TOC Settings", "demo_data_manifest",
                                json.dumps(manifest) if manifest else "")


def _get_company():
    company = frappe.defaults.get_user_default("Company")
    if not company:
        company = frappe.db.get_value("Company", {}, "name")
    if not company:
        frappe.throw("No company found. Please create a Company first.")
    return company


def _get_or_create_warehouse(company, manifest):
    wh_name = f"TOC Demo Store - {frappe.db.get_value('Company', company, 'abbr')}"
    if frappe.db.exists("Warehouse", wh_name):
        return wh_name

    wh = frappe.get_doc({
        "doctype": "Warehouse",
        "warehouse_name": "TOC Demo Store",
        "company": company,
        "warehouse_type": "Stores",
    })
    wh.flags.ignore_permissions = True
    wh.insert()
    manifest["warehouses"].append({"doctype": "Warehouse", "name": wh.name})
    return wh.name


def _get_or_create_customer(company, manifest):
    cust_name = f"{PREFIX}Customer"
    if frappe.db.exists("Customer", cust_name):
        return cust_name

    cust = frappe.get_doc({
        "doctype": "Customer",
        "customer_name": "TOC Demo Customer",
        "customer_group": frappe.db.get_single_value("Selling Settings", "customer_group") or "All Customer Groups",
        "territory": frappe.db.get_single_value("Selling Settings", "territory") or "All Territories",
        "customer_type": "Company",
    })
    cust.flags.ignore_permissions = True
    cust.flags.ignore_mandatory = True
    cust.insert()
    manifest["customers"].append({"doctype": "Customer", "name": cust.name})
    return cust.name


def _create_item(config, company, warehouse, manifest):
    code = config["code"]
    if frappe.db.exists("Item", code):
        manifest["items"].append({"doctype": "Item", "name": code})
        return code

    # Ensure item group exists
    group = config.get("group", "Products")
    if not frappe.db.exists("Item Group", group):
        ig = frappe.get_doc({"doctype": "Item Group", "item_group_name": group,
                             "parent_item_group": "All Item Groups"})
        ig.flags.ignore_permissions = True
        ig.insert()
        manifest["item_groups"].append({"doctype": "Item Group", "name": ig.name})

    item = frappe.get_doc({
        "doctype": "Item",
        "item_code": code,
        "item_name": config["name"],
        "item_group": group,
        "stock_uom": config.get("uom", "Nos"),
        "is_stock_item": 1,
        # include_item_in_manufacturing: true for Manufacture-mode items (auto_mfg=1)
        "include_item_in_manufacturing": 1 if config.get("auto_mfg") else 0,
        # TOC fields — routing derived from auto_manufacture / auto_purchase flags
        "custom_toc_enabled": 1,
        "custom_toc_auto_purchase": config.get("auto_pur", 0),
        "custom_toc_auto_manufacture": config.get("auto_mfg", 0),
        "custom_toc_adu_value": config.get("adu", 0),
        "custom_toc_adu_period": "Last 90 Days",
        "custom_toc_custom_adu": 1,  # Manual ADU for demo
        "custom_toc_selling_price": config.get("price", 0),
        "custom_toc_tvc": config.get("tvc", 0),
        "custom_toc_constraint_speed": config.get("speed", 0),
        # Enable BOM availability check for all Manufacture-mode items
        "custom_toc_check_bom_availability": 1 if config.get("auto_mfg") else 0,
    })

    # Add buffer rule row
    item.append("custom_toc_buffer_rules", {
        "warehouse": warehouse,
        "adu": config.get("adu", 100),
        "rlt": config.get("rlt", 3),
        "variability_factor": config.get("vf", 1.5),
        "target_buffer": config.get("target", 0),
        "daf": 1.0,
        "enabled": 1,
    })

    item.flags.ignore_permissions = True
    item.flags.ignore_mandatory = True
    item.insert()
    manifest["items"].append({"doctype": "Item", "name": item.name})

    # Create stock entry to set initial stock
    if config.get("stock_qty", 0) > 0:
        se = frappe.get_doc({
            "doctype": "Stock Entry",
            "stock_entry_type": "Material Receipt",
            "company": company,
            "posting_date": today(),
            "items": [{
                "item_code": code,
                "qty": config["stock_qty"],
                "t_warehouse": warehouse,
                "basic_rate": config.get("tvc", 50) or 50,
            }],
        })
        se.flags.ignore_permissions = True
        se.flags.ignore_mandatory = True
        se.insert()
        se.submit()
        manifest["stock_entries"].append({"doctype": "Stock Entry", "name": se.name})

    return code


def _create_bom(fg_item, components, company, manifest):
    bom_exists = frappe.db.get_value("BOM", {"item": fg_item, "is_active": 1, "is_default": 1})
    if bom_exists:
        manifest["boms"].append({"doctype": "BOM", "name": bom_exists})
        return bom_exists

    try:
        bom = frappe.get_doc({
            "doctype": "BOM",
            "item": fg_item,
            "company": company,
            "is_active": 1,
            "is_default": 1,
            "with_operations": 0,
            "items": [
                {
                    "item_code": c["item_code"],
                    "qty": c["qty"],
                    "uom": c.get("uom", "Nos"),
                    "stock_uom": c.get("uom", "Nos"),
                    "rate": 50,
                }
                for c in components
            ],
        })
        bom.flags.ignore_permissions = True
        bom.flags.ignore_mandatory = True
        bom.insert()
        bom.submit()
        manifest["boms"].append({"doctype": "BOM", "name": bom.name})
        return bom.name
    except Exception:
        frappe.log_error(frappe.get_traceback(), f"TOC Demo BOM creation failed for {fg_item}")
        return None


def _create_delivery_note(customer, company, warehouse, item_code, qty, posting_date, manifest):
    try:
        dn = frappe.get_doc({
            "doctype": "Delivery Note",
            "customer": customer,
            "company": company,
            "posting_date": posting_date,
            "set_warehouse": warehouse,
            "items": [{
                "item_code": item_code,
                "qty": qty,
                "warehouse": warehouse,
                "rate": 100,
            }],
        })
        dn.flags.ignore_permissions = True
        dn.flags.ignore_mandatory = True
        dn.insert()
        dn.submit()
        manifest["delivery_notes"].append({"doctype": "Delivery Note", "name": dn.name})
    except Exception:
        # Stock might not be enough — skip silently
        pass
