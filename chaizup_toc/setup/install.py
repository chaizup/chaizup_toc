"""
Installation Hooks — Custom Fields on Item, Material Request, Work Order
=========================================================================
R1: "Custom ADU" checkbox — skips auto ADU calculation
R2: "TOC Setting" tab on Item — ALL TOC config in one place
R3: BOM-aware — reads ERPNext BOM for multi-level SFG detection
R4: ADU section with clear explanation of auto-calculation
"""

import frappe
from frappe import _

M = "Chaizup Toc"


def after_install():
    frappe.logger("chaizup_toc").info("=== Chaizup TOC: Post-Install Starting ===")
    _disable_default_auto_reorder()
    _install_custom_fields()
    _setup_roles()
    _create_number_cards()
    _create_dashboard_charts()
    frappe.db.commit()
    frappe.logger("chaizup_toc").info("=== Chaizup TOC: Post-Install Complete ===")


def before_uninstall():
    try:
        frappe.db.set_single_value("Stock Settings", "auto_indent", 1)
        frappe.db.commit()
    except Exception:
        pass


def _disable_default_auto_reorder():
    try:
        frappe.db.set_single_value("Stock Settings", "auto_indent", 0)
        frappe.logger("chaizup_toc").info("Disabled default auto Material Request")
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Install: auto_indent disable failed")


def _install_custom_fields():
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    custom_fields = {

        # ═══════════════════════════════════════
        # ITEM — "TOC Setting" Tab (R2)
        # ═══════════════════════════════════════
        "Item": [
            # ── R2: NEW TAB called "TOC Setting" ──
            dict(fieldname="custom_toc_tab", fieldtype="Tab Break",
                 label="TOC Setting", insert_after="reorder_levels", module=M),

            # ══ SECTION 1: Enable & Classification ══
            dict(fieldname="custom_toc_sec_enable", fieldtype="Section Break",
                 label="1. Enable TOC Buffer Management",
                 insert_after="custom_toc_tab",
                 description="Step 1: Enable TOC for this item. This REPLACES the default ERPNext reorder levels. The standard Auto Material Request scheduler is disabled when TOC App is installed.",
                 module=M),

            dict(fieldname="custom_toc_enabled", fieldtype="Check",
                 label="Enable TOC [TOC App]",
                 insert_after="custom_toc_sec_enable",
                 default="0", bold=1,
                 description="CHECK this to activate TOC for this item. When ON: item appears on Production Priority Board, MRs are auto-created at 7:00 AM based on Buffer Penetration %. The default ERPNext reorder level is IGNORED.",
                 module=M),

            dict(fieldname="custom_toc_buffer_type", fieldtype="Select",
                 label="Buffer Type [TOC App]",
                 options="\nFG\nSFG\nRM\nPM",
                 insert_after="custom_toc_enabled",
                 mandatory_depends_on="eval:doc.custom_toc_enabled",
                 depends_on="eval:doc.custom_toc_enabled",
                 description="FG = Finished Goods (you SELL these) | SFG = Semi-Finished Goods (intermediates like premix blend) | RM = Raw Materials (you BUY these) | PM = Packaging Materials (you BUY these). This determines the Inventory Position formula used.",
                 module=M),

            dict(fieldname="custom_toc_col_replenish", fieldtype="Column Break",
                 insert_after="custom_toc_buffer_type", module=M),

            # ── R6/R2: Auto Replenishment Mode ──
            dict(fieldname="custom_toc_auto_purchase", fieldtype="Check",
                 label="Auto Purchase TOC [TOC App]",
                 insert_after="custom_toc_col_replenish",
                 depends_on="eval:doc.custom_toc_enabled",
                 default="0",
                 description="CHECK if this item is PURCHASED from suppliers. System creates Purchase-type Material Request → becomes Purchase Order. Use for RM and PM items.",
                 module=M),

            dict(fieldname="custom_toc_auto_manufacture", fieldtype="Check",
                 label="Auto Manufacturing TOC [TOC App]",
                 insert_after="custom_toc_auto_purchase",
                 depends_on="eval:doc.custom_toc_enabled",
                 default="0",
                 description="CHECK if this item is MANUFACTURED in-house. System creates Manufacture-type Material Request → becomes Work Order. Use for FG and SFG items. You can only choose ONE: Purchase OR Manufacturing.",
                 module=M),

            # ══ SECTION 2: ADU — Average Daily Usage (R1, R4) ══
            dict(fieldname="custom_toc_sec_adu", fieldtype="Section Break",
                 label="2. Average Daily Usage (ADU) — Formula F1 Component",
                 insert_after="custom_toc_auto_manufacture",
                 depends_on="eval:doc.custom_toc_enabled",
                 description=(
                     "ADU = Average Daily Usage. It is the FIRST input to Formula F1: Target Buffer = ADU × RLT × VF.\n\n"
                     "HOW IT WORKS: Every day at 6:30 AM, the TOC scheduler automatically calculates ADU by:\n"
                     "• For FG items: counting total qty shipped in Delivery Notes over the selected period, then dividing by number of days.\n"
                     "• For RM/PM items: counting total qty consumed in Stock Entries (Material Issue / Manufacture) over the selected period.\n"
                     "• For SFG items: counting total qty consumed from Stock Entries where this SFG was used.\n\n"
                     "OR: Check 'Custom ADU' below to enter your own value manually — the scheduler will SKIP this item."
                 ),
                 module=M),

            # R1: Custom ADU checkbox
            dict(fieldname="custom_toc_custom_adu", fieldtype="Check",
                 label="Custom ADU (Manual Entry) [TOC App]",
                 insert_after="custom_toc_sec_adu",
                 depends_on="eval:doc.custom_toc_enabled",
                 default="0",
                 description="CHECK this if you want to enter ADU MANUALLY instead of using the auto-calculated value. When checked, the daily 6:30 AM scheduler will SKIP this item and will NOT overwrite your manual ADU value. Useful when you know the correct demand but there's no history in the system yet.",
                 module=M),

            dict(fieldname="custom_toc_adu_period", fieldtype="Select",
                 label="ADU Calculation Period [TOC App]",
                 options="\nLast 30 Days\nLast 90 Days\nLast 180 Days\nLast 365 Days",
                 insert_after="custom_toc_custom_adu",
                 default="Last 90 Days",
                 depends_on="eval:doc.custom_toc_enabled && !doc.custom_toc_custom_adu",
                 description="How far back should the scheduler look when auto-calculating ADU? Last 30 Days = responsive to recent trends. Last 90 Days = recommended default. Last 180/365 Days = for stable/seasonal items.",
                 module=M),

            dict(fieldname="custom_toc_col_adu", fieldtype="Column Break",
                 insert_after="custom_toc_adu_period", module=M),

            dict(fieldname="custom_toc_adu_value", fieldtype="Float",
                 label="ADU Value (units/day) [TOC App]",
                 insert_after="custom_toc_col_adu",
                 depends_on="eval:doc.custom_toc_enabled",
                 description="Average Daily Usage in units per day. If 'Custom ADU' is checked, enter your value here manually. Otherwise, this is auto-calculated daily at 6:30 AM from actual shipment/consumption data. This feeds into F1: Target = ADU × RLT × VF.",
                 module=M),

            dict(fieldname="custom_toc_adu_last_updated", fieldtype="Datetime",
                 label="ADU Last Calculated [TOC App]",
                 insert_after="custom_toc_adu_value",
                 read_only=1,
                 depends_on="eval:doc.custom_toc_enabled && !doc.custom_toc_custom_adu",
                 description="When was ADU last auto-calculated by the scheduler? If this timestamp is old, check Scheduled Job Log for errors. Shows 'Manual' if Custom ADU is checked.",
                 module=M),

            # ══ SECTION 3: T/CU — Tie-Breaker (FG only) ══
            dict(fieldname="custom_toc_sec_tcu", fieldtype="Section Break",
                 label="3. Throughput per Constraint Unit — T/CU (Formula F5, FG only)",
                 insert_after="custom_toc_adu_last_updated",
                 depends_on="eval:doc.custom_toc_buffer_type=='FG'",
                 collapsible=1,
                 description="F5 tie-breaker: When two FG items have EQUAL Buffer Penetration %, which should the VFFS run first? The one with higher T/CU (more ₹ earned per minute of bottleneck time). T = Price − (RM+PM cost). T/CU = T × Speed.",
                 module=M),

            dict(fieldname="custom_toc_selling_price", fieldtype="Currency",
                 label="Selling Price [TOC App]", insert_after="custom_toc_sec_tcu",
                 description="Selling price per unit. Used in F5: T = Price − TVC.", module=M),

            dict(fieldname="custom_toc_tvc", fieldtype="Currency",
                 label="Truly Variable Cost (RM+PM) [TOC App]", insert_after="custom_toc_selling_price",
                 description="ONLY raw material + packaging cost per unit. Do NOT include labour, electricity, rent — those are fixed costs that don't change per SKU.", module=M),

            dict(fieldname="custom_toc_col_tcu", fieldtype="Column Break",
                 insert_after="custom_toc_tvc", module=M),

            dict(fieldname="custom_toc_constraint_speed", fieldtype="Float",
                 label="Constraint Speed (units/min) [TOC App]", insert_after="custom_toc_col_tcu",
                 description="Bottleneck machine speed for this SKU (e.g. VFFS pouches/min).", module=M),

            dict(fieldname="custom_toc_tcu", fieldtype="Currency",
                 label="T/CU (₹/min) [TOC App]", insert_after="custom_toc_constraint_speed",
                 read_only=1,
                 description="Auto-calculated: F5 = (Price − TVC) × Speed. Higher = earns more per constraint minute.", module=M),

            # ══ SECTION 4: BOM / SFG Link (R3) ══
            dict(fieldname="custom_toc_sec_bom", fieldtype="Section Break",
                 label="4. BOM & SFG Dependency (R3)",
                 insert_after="custom_toc_tcu",
                 depends_on="eval:doc.custom_toc_enabled && (doc.custom_toc_buffer_type=='FG' || doc.custom_toc_buffer_type=='SFG')",
                 collapsible=1,
                 description=(
                     "For FG/SFG items: The system reads the ERPNext BOM (Bill of Materials) to check SFG and material availability BEFORE recommending production.\n\n"
                     "Multi-level: One FG BOM can have multiple SFGs + raw materials. One SFG BOM can also have sub-SFGs + materials. The system walks the full BOM tree.\n\n"
                     "If you link a BOM here, the Production Priority Board will show SFG availability status and flag shortfalls."
                 ),
                 module=M),

            dict(fieldname="custom_toc_default_bom", fieldtype="Link",
                 label="Default BOM for TOC [TOC App]",
                 options="BOM",
                 insert_after="custom_toc_sec_bom",
                 depends_on="eval:doc.custom_toc_buffer_type=='FG' || doc.custom_toc_buffer_type=='SFG'",
                 description="Link the active BOM for this item. TOC uses this to check if all SFGs and raw materials are available before scheduling production. Leave blank to skip BOM checking.",
                 module=M),

            dict(fieldname="custom_toc_check_bom_availability", fieldtype="Check",
                 label="Check BOM Availability [TOC App]",
                 insert_after="custom_toc_default_bom",
                 depends_on="eval:doc.custom_toc_default_bom",
                 default="1",
                 description="When checked, the system reads the BOM and checks each component's buffer status. If any SFG or RM component is in Red/Black zone, a warning appears on the Production Priority Board.",
                 module=M),

            # ══ SECTION 5: Buffer Rules per Warehouse ══
            dict(fieldname="custom_toc_sec_rules", fieldtype="Section Break",
                 label="5. Buffer Rules per Warehouse (Formula F1: Target = ADU × RLT × VF)",
                 insert_after="custom_toc_check_bom_availability",
                 depends_on="eval:doc.custom_toc_enabled",
                 description="Add one row per warehouse. Enter RLT (lead time days) and VF (variability factor). ADU comes from Section 2 above. The system auto-calculates Target Buffer = ADU × RLT × VF.",
                 module=M),

            dict(fieldname="custom_toc_buffer_rules", fieldtype="Table",
                 label="TOC Buffer Rules [TOC App]", options="TOC Item Buffer",
                 insert_after="custom_toc_sec_rules",
                 depends_on="eval:doc.custom_toc_enabled",
                 description="Each row = one warehouse buffer. The scheduler checks BP% daily at 7:00 AM and creates Material Requests for Yellow/Red zone items.",
                 module=M),
        ],

        # ═══════════════════════════════════════
        # MATERIAL REQUEST — TOC App tab
        # ═══════════════════════════════════════
        "Material Request": [
            dict(fieldname="custom_toc_tab", fieldtype="Tab Break",
                 label="TOC App", insert_after="terms", module=M),

            dict(fieldname="custom_toc_recorded_by", fieldtype="Select",
                 label="Recorded By [TOC App]",
                 options="\nBy User\nBy System",
                 insert_after="custom_toc_tab",
                 in_list_view=1, in_standard_filter=1, bold=1,
                 description="'By System' = auto-created by TOC at 7:00 AM. 'By User' = manually created. System MRs are sorted by BP% priority.",
                 module=M),

            dict(fieldname="custom_toc_zone", fieldtype="Select",
                 label="Buffer Zone [TOC App]",
                 options="\nGreen\nYellow\nRed\nBlack",
                 insert_after="custom_toc_recorded_by",
                 read_only=1, in_list_view=1, in_standard_filter=1, bold=1,
                 description="F3: Zone at MR creation. Green=safe | Yellow=plan | Red=URGENT | Black=STOCKOUT.",
                 module=M),

            dict(fieldname="custom_toc_bp_pct", fieldtype="Percent",
                 label="Buffer Penetration % [TOC App]",
                 insert_after="custom_toc_zone", read_only=1, bold=1,
                 description="F3: BP% = (Target − IP) ÷ Target × 100. Higher = more urgent.",
                 module=M),

            dict(fieldname="custom_toc_col", fieldtype="Column Break",
                 insert_after="custom_toc_bp_pct", module=M),

            dict(fieldname="custom_toc_target_buffer", fieldtype="Float",
                 label="Target Buffer [TOC App]",
                 insert_after="custom_toc_col", read_only=1,
                 description="F1: Target = ADU × RLT × VF at time of MR creation.",
                 module=M),

            dict(fieldname="custom_toc_inventory_position", fieldtype="Float",
                 label="Inventory Position [TOC App]",
                 insert_after="custom_toc_target_buffer", read_only=1,
                 description="F2: True available stock at time of MR creation.",
                 module=M),

            dict(fieldname="custom_toc_sr_pct", fieldtype="Percent",
                 label="Stock Remaining % [TOC App]",
                 insert_after="custom_toc_inventory_position", read_only=1,
                 description="F3 alt: SR% = IP ÷ Target × 100. SR% + BP% = 100%.",
                 module=M),
        ],

        # ═══════════════════════════════════════
        # WORK ORDER — TOC App tab
        # ═══════════════════════════════════════
        "Work Order": [
            dict(fieldname="custom_toc_tab", fieldtype="Tab Break",
                 label="TOC App", insert_after="description", module=M),

            dict(fieldname="custom_toc_recorded_by", fieldtype="Select",
                 label="Recorded By [TOC App]",
                 options="\nBy User\nBy System",
                 insert_after="custom_toc_tab",
                 in_list_view=1, in_standard_filter=1, bold=1,
                 description="'By System' = created from TOC Material Request. 'By User' = manually created.",
                 module=M),

            dict(fieldname="custom_toc_zone", fieldtype="Select",
                 label="Buffer Zone [TOC App]",
                 options="\nGreen\nYellow\nRed\nBlack",
                 insert_after="custom_toc_recorded_by",
                 read_only=1, in_standard_filter=1,
                 description="Buffer zone when WO was created. Red/Black WOs have ABSOLUTE priority on constraint machine.",
                 module=M),

            dict(fieldname="custom_toc_bp_pct", fieldtype="Percent",
                 label="Buffer Penetration % [TOC App]",
                 insert_after="custom_toc_zone", read_only=1,
                 description="F3: BP% at WO creation. Higher BP% = higher priority on VFFS.",
                 module=M),
        ],
    }

    create_custom_fields(custom_fields, update=True)
    frappe.logger("chaizup_toc").info("Custom fields installed on Item, Material Request, Work Order")


def _setup_roles():
    for role_name in ["TOC Manager", "TOC User"]:
        if not frappe.db.exists("Role", role_name):
            r = frappe.new_doc("Role")
            r.role_name = role_name
            r.desk_access = 1
            r.flags.ignore_permissions = True
            r.insert()


def _create_number_cards():
    """
    Create method-based Number Cards — avoids date filter parsing issues.
    type="Custom" + method= calls our Python API which handles date logic server-side.
    Force-recreates if broken cards exist from a previous install.
    """
    cards = [
        {"name": "TOC - Items in Red Zone", "label": "Red Zone Items",
         "type": "Custom", "method": "chaizup_toc.api.toc_api.nc_red_zone_count",
         "color": "#E74C3C", "show_percentage_stats": 0, "is_standard": 1, "module": M},
        {"name": "TOC - Items in Yellow Zone", "label": "Yellow Zone Items",
         "type": "Custom", "method": "chaizup_toc.api.toc_api.nc_yellow_zone_count",
         "color": "#F39C12", "show_percentage_stats": 0, "is_standard": 1, "module": M},
        {"name": "TOC - Items in Green Zone", "label": "Green Zone Items",
         "type": "Custom", "method": "chaizup_toc.api.toc_api.nc_green_zone_count",
         "color": "#27AE60", "show_percentage_stats": 0, "is_standard": 1, "module": M},
        {"name": "TOC - Open Material Requests", "label": "Open Material Requests",
         "type": "Custom", "method": "chaizup_toc.api.toc_api.nc_open_mr_count",
         "color": "#3498DB", "show_percentage_stats": 0, "is_standard": 1, "module": M},
    ]
    for cd in cards:
        # Force-delete existing broken card if present (fixes date filter error)
        if frappe.db.exists("Number Card", cd["name"]):
            try:
                frappe.delete_doc("Number Card", cd["name"], force=True, ignore_permissions=True)
            except Exception:
                pass
        try:
            nc = frappe.new_doc("Number Card")
            nc.update(cd)
            nc.flags.ignore_permissions = True
            nc.insert()
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"TOC NC: {cd['name']}")


def _create_dashboard_charts():
    """
    Create Dashboard Charts. Force-recreates if broken charts exist.
    Uses no date filter to avoid Timespan parsing issues.
    The chart shows zone distribution from the most recent buffer logs.
    """
    cn = "TOC - Zone Distribution"
    # Force-delete existing broken chart
    if frappe.db.exists("Dashboard Chart", cn):
        try:
            frappe.delete_doc("Dashboard Chart", cn, force=True, ignore_permissions=True)
        except Exception:
            pass
    try:
        c = frappe.new_doc("Dashboard Chart")
        c.name = cn
        c.chart_name = cn
        c.chart_type = "Group By"
        c.document_type = "TOC Buffer Log"
        c.group_by_type = "Count"
        c.group_by_based_on = "zone"
        c.type = "Donut"
        c.color = "#E67E22"
        c.filters_json = "[]"
        c.is_standard = 1
        c.module = M
        c.timeseries = 0
        c.is_public = 1
        c.flags.ignore_permissions = True
        c.insert()
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Chart")
