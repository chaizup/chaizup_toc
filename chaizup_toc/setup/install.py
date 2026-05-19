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
    # 2026-05-19 — Back-fill TOC UOM custom fields on every existing
    # Work Order + Production Plan + BOM. SKIPS MRP (Item.custom_mrp
    # remains user-managed per requirement). Idempotent — rows that
    # already have custom_uom set are left untouched. Wrapped so
    # back-fill failures never block install.
    try:
        backfill_toc_uom_on_existing_records()
    except Exception:
        frappe.log_error(frappe.get_traceback(),
                         "TOC back-fill on after_install failed")
    frappe.db.commit()
    frappe.logger("chaizup_toc").info("=== Chaizup TOC: Post-Install Complete ===")


def after_migrate():
    """Run on every `bench migrate`. The custom-fields portion is handled
    by fixtures, but the UOM back-fill needs to run when the new fields
    first appear on an existing site. Idempotent — re-runs skip already-
    populated rows.

    2026-05-19 — wired in hooks.py:after_migrate so legacy chaizup_toc
    sites get back-filled the first time they run `bench migrate` after
    pulling these changes.
    """
    try:
        backfill_toc_uom_on_existing_records()
        frappe.db.commit()
    except Exception:
        frappe.log_error(frappe.get_traceback(),
                         "TOC back-fill on after_migrate failed")


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

            dict(fieldname="custom_toc_col_replenish", fieldtype="Column Break",
                 insert_after="custom_toc_enabled", module=M),

            # ── R6/R2: Auto Replenishment Mode ──
            dict(fieldname="custom_toc_auto_purchase", fieldtype="Check",
                 label="Auto Purchase TOC [TOC App]",
                 insert_after="custom_toc_col_replenish",
                 depends_on="eval:doc.custom_toc_enabled",
                 default="0",
                 description="CHECK if this item is PURCHASED from suppliers. System creates a Purchase-type Material Request when buffer falls below threshold. Mutually exclusive with Auto Manufacturing.",
                 module=M),

            dict(fieldname="custom_toc_auto_manufacture", fieldtype="Check",
                 label="Auto Manufacturing TOC [TOC App]",
                 insert_after="custom_toc_auto_purchase",
                 depends_on="eval:doc.custom_toc_enabled",
                 default="0",
                 description="CHECK if this item is MANUFACTURED in-house. System creates a Production Plan → Work Order when buffer falls below threshold. Mutually exclusive with Auto Purchase.",
                 module=M),

            # ══ SECTION 2: ADU — Average Daily Usage (R1, R4) ══
            dict(fieldname="custom_toc_sec_adu", fieldtype="Section Break",
                 label="2. Average Daily Usage (ADU) — Formula F1 Component",
                 insert_after="custom_toc_auto_manufacture",
                 depends_on="eval:doc.custom_toc_enabled",
                 description=(
                     "ADU = Average Daily Usage. It is the FIRST input to Formula F1: Target Buffer = ADU × RLT × VF.\n\n"
                     "HOW IT WORKS: Every day at 6:30 AM, the TOC scheduler automatically calculates ADU by reading ALL stock "
                     "outflows from the Stock Ledger for this item (actual_qty < 0) over the selected period, then dividing by "
                     "the number of days. This captures sales, production consumption, transfers — every way the item leaves stock.\n\n"
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

            # ══ SECTION 3: T/CU — Tie-Breaker (manufactured items) ══
            dict(fieldname="custom_toc_sec_tcu", fieldtype="Section Break",
                 label="3. Throughput per Constraint Unit — T/CU (Formula F5)",
                 insert_after="custom_toc_adu_last_updated",
                 depends_on="eval:doc.custom_toc_enabled && doc.custom_toc_auto_manufacture",
                 collapsible=1,
                 description="F5 tie-breaker: When two manufactured items have EQUAL Buffer Penetration %, which should the bottleneck run first? The one with higher T/CU earns more per constraint minute. T = Price − TVC. T/CU = T × Speed.",
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

            # ══ SECTION 4: BOM Link (R3) ══
            dict(fieldname="custom_toc_sec_bom", fieldtype="Section Break",
                 label="4. BOM & Component Dependency (R3)",
                 insert_after="custom_toc_tcu",
                 depends_on="eval:doc.custom_toc_enabled",
                 collapsible=1,
                 description=(
                     "Optional: Link an ERPNext BOM to enable component availability checking.\n\n"
                     "If linked, the system walks the full BOM tree (up to 5 levels) and checks "
                     "whether all components have sufficient stock before recommending production.\n\n"
                     "Works for any item regardless of category — not restricted to FG or SFG."
                 ),
                 module=M),

            dict(fieldname="custom_toc_default_bom", fieldtype="Link",
                 label="Default BOM for TOC [TOC App]",
                 options="BOM",
                 insert_after="custom_toc_sec_bom",
                 depends_on="eval:doc.custom_toc_enabled",
                 description="Link the active BOM for this item. TOC uses this to check if all components are available before scheduling production. Leave blank to skip BOM checking.",
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

            # ── Projection Automation fields (added 2026-04-18) ──
            # custom_projection_parent_wo: Link to the FG parent WO when this WO
            # was auto-created as a sub-assembly by projection_engine.py.
            # Appears in Frappe Connections tab of the parent WO automatically
            # (any Link field pointing to a DocType shows in that DocType's Connections).
            dict(fieldname="custom_projection_parent_wo", fieldtype="Link",
                 label="Parent Work Order [Projection]",
                 options="Work Order",
                 insert_after="custom_toc_bp_pct",
                 read_only=1,
                 in_list_view=0, in_standard_filter=1,
                 description="Set automatically when this Work Order was created as a sub-assembly by the Sales Projection Automation engine. Links to the parent FG Work Order. Open the parent WO and check its Connections tab to see all child Work Orders created for this BOM tree.",
                 module=M),

            # custom_toc_creation_reason: Explains WHY the system created this WO.
            # Written by projection_engine._create_work_order() with full formula breakdown.
            dict(fieldname="custom_toc_creation_reason", fieldtype="Long Text",
                 label="WO Creation Reason [TOC]",
                 insert_after="custom_projection_parent_wo",
                 read_only=1,
                 description="Auto-filled by the TOC system when a Work Order is created automatically (by Sales Projection Automation or TOC buffer logic). Explains the calculation behind the WO quantity so any user can understand why this WO was created.",
                 module=M),
        ],
    }

    create_custom_fields(custom_fields, update=True)
    frappe.logger("chaizup_toc").info("Custom fields installed on Item, Material Request, Work Order")


# =============================================================================
# CONTEXT: Ensures all TOC roles exist on a fresh install.
#   Frappe DOES NOT auto-create roles referenced in DocType JSON `permissions`;
#   the role row must exist in `tabRole` first or the perm rule is silently
#   dropped at sync_doctype time. Each role here pairs with a permission entry
#   in one or more DocType JSONs:
#     - TOC Manager / TOC User: legacy roles, used across TOC Buffer, Settings,
#       etc. (kept as-is for back-compat).
#     - Sales Projection Admin: added 2026-05-12. Holds elevated permissions on
#       Sales Projection (write/submit/cancel/amend/delete). Authorised power
#       users can cancel a Sales Projection, amend it, and resubmit without
#       needing the full System Manager role.
# DANGER ZONE:
#   - desk_access MUST stay 1 — without it, holders of the role cannot reach the
#     /app desk where Sales Projection lives.
#   - The role NAME ("Sales Projection Admin") is referenced verbatim in
#     sales_projection.json `permissions` list. Renaming requires updating both
#     places + a data-migration patch.
# RESTRICT:
#   - Do not add a `customize: 1` flag to this role — it would let holders
#     change the Sales Projection schema. Keep them scoped to document data only.
# =============================================================================
def _setup_roles():
    for role_name in ["TOC Manager", "TOC User", "Sales Projection Admin"]:
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


# =============================================================================
# CONTEXT: TOC UOM back-fill on existing records.
#
# When a user installs chaizup_toc on a site that already has Work Orders,
# Production Plans, and BOMs, the new TOC custom fields (custom_uom,
# custom_uom_conversion_factor, custom_qty_in_uom, etc.) get added by
# fixtures with NULL/0 default values. The user-facing form would then
# show empty UOM/CF columns until each record is re-saved one-by-one.
#
# This function back-fills the UOM trio on every existing record using:
#   - custom_uom = item's largest-CF non-stock UOM (auto-pick)
#   - custom_uom_conversion_factor = the CF for that UOM
#   - custom_qty_in_uom = standard_qty / CF
#   - + the produced_qty / creation / owner mirrors on Work Order
#   - + the per-row in-UOM fields on Production Plan child tables
#
# What it DOES NOT touch:
#   - Item.custom_mrp / Work Order.custom_mrp / Production Plan Item.custom_mrp
#     MRP is a per-item commercial decision; user populates Item.custom_mrp
#     manually after install. The auto-fetch chain (Item → WO/PP via the
#     custom_mrp_source = "Auto from Item" handler) takes over from there.
#
# INSTRUCTIONS:
#   - Idempotent. Only stamps rows where custom_uom IS NULL/empty. Re-runs
#     are safe; running it 10x has the same effect as running it once.
#   - Single batched UOM-ladder query per pass (no N+1).
#   - Direct SQL UPDATEs via frappe.db.sql for speed (no validate/save
#     overhead per row). Skip update_modified.
#   - Wrapped per-pass in try/except so a single bad row never aborts the
#     whole back-fill.
#
# DANGER ZONE:
#   - Do NOT remove the `IS NULL OR = ''` guard on custom_uom. Without it
#     this overwrites user choices on every re-run.
#   - Do NOT include `custom_mrp` in the UPDATE list. MRP back-fill would
#     unintentionally populate from Item.custom_mrp on items the user
#     hasn't yet priced.
#   - Direct SQL is intentional. doc.save() would trigger validate +
#     buffer_calculator hooks on every WO and PP — too slow on large
#     sites and could create spurious MRs.
#
# RESTRICT:
#   - This function MUST stay idempotent. It's wired into both
#     after_install and after_migrate; a non-idempotent version would
#     corrupt data on every bench migrate.
#   - Don't change the field names — they're referenced by the validate
#     hooks (stamp_uom_fields_on_*_validate) and the JS controllers.
# =============================================================================
def backfill_toc_uom_on_existing_records():
    """Populate TOC UOM fields on every existing WO + PP + BOM. Skips MRP."""
    frappe.logger("chaizup_toc").info("=== TOC UOM Back-fill: starting ===")

    # ── 1. Build a single UOM ladder map for ALL items referenced ──────────
    #    (Faster than per-row lookups across thousands of rows.)
    item_codes = set()
    for r in frappe.db.sql(
            """SELECT DISTINCT production_item FROM `tabWork Order`
               WHERE production_item IS NOT NULL""", as_dict=True):
        item_codes.add(r.production_item)
    for r in frappe.db.sql(
            """SELECT DISTINCT item_code FROM `tabProduction Plan Item`
               WHERE item_code IS NOT NULL""", as_dict=True):
        item_codes.add(r.item_code)
    for r in frappe.db.sql(
            """SELECT DISTINCT production_item FROM `tabProduction Plan Sub Assembly Item`
               WHERE production_item IS NOT NULL""", as_dict=True):
        item_codes.add(r.production_item)
    for r in frappe.db.sql(
            """SELECT DISTINCT item FROM `tabBOM`
               WHERE item IS NOT NULL""", as_dict=True):
        item_codes.add(r.item)
    if not item_codes:
        frappe.logger("chaizup_toc").info("No existing WO/PP/BOM rows; back-fill skipped")
        return

    ladders = frappe.db.sql(
        """
        SELECT parent AS item_code, uom, conversion_factor
        FROM `tabUOM Conversion Detail`
        WHERE parent IN %(c)s AND parenttype = 'Item'
          AND IFNULL(conversion_factor, 0) > 0
        ORDER BY conversion_factor DESC
        """, {"c": tuple(item_codes)}, as_dict=True)
    stock_uoms = {
        r.name: r.stock_uom for r in frappe.db.sql(
            """SELECT name, stock_uom FROM `tabItem` WHERE name IN %(c)s""",
            {"c": tuple(item_codes)}, as_dict=True)
    }
    by_item = {}
    for r in ladders:
        by_item.setdefault(r.item_code, []).append(
            (r.uom, float(r.conversion_factor or 0)))

    def pick(item_code):
        """Return (uom, cf) — largest non-stock UOM, else stock UOM at CF=1."""
        rows = by_item.get(item_code) or []
        s_uom = stock_uoms.get(item_code) or ""
        for uom, cf in rows:
            if uom != s_uom and cf > 1.0:
                return uom, cf
        return s_uom, 1.0

    # ── 2. Work Order back-fill ────────────────────────────────────────────
    wo_rows = frappe.db.sql(
        """SELECT name, production_item, qty, produced_qty,
                  creation, owner
           FROM `tabWork Order`
           WHERE (custom_uom IS NULL OR custom_uom = '')
             AND production_item IS NOT NULL""",
        as_dict=True)
    wo_done = 0
    for r in wo_rows:
        try:
            uom, cf = pick(r.production_item)
            qty       = float(r.qty or 0)
            prod      = float(r.produced_qty or 0)
            frappe.db.sql(
                """UPDATE `tabWork Order` SET
                       custom_uom = %(uom)s,
                       custom_uom_conversion_factor = %(cf)s,
                       custom_qty_in_uom = %(qiu)s,
                       custom_produced_qty_in_uom = %(piu)s,
                       custom_created_time = IFNULL(custom_created_time, %(creation)s),
                       custom_created_by   = IFNULL(NULLIF(custom_created_by, ''), %(owner)s)
                   WHERE name = %(name)s""",
                {"uom": uom, "cf": cf,
                 "qiu": (qty / cf) if cf else 0,
                 "piu": (prod / cf) if cf else 0,
                 "creation": r.creation, "owner": r.owner,
                 "name": r.name})
            wo_done += 1
        except Exception:
            frappe.log_error(frappe.get_traceback(),
                             f"TOC back-fill failed for WO {r.name}")
    frappe.logger("chaizup_toc").info(f"WO back-fill: {wo_done}/{len(wo_rows)} rows stamped")

    # ── 3. Production Plan Item (po_items) back-fill ───────────────────────
    ppi_rows = frappe.db.sql(
        """SELECT name, item_code, planned_qty, produced_qty
           FROM `tabProduction Plan Item`
           WHERE (custom_uom IS NULL OR custom_uom = '')
             AND item_code IS NOT NULL""",
        as_dict=True)
    ppi_done = 0
    for r in ppi_rows:
        try:
            uom, cf = pick(r.item_code)
            planned = float(r.planned_qty or 0)
            prod    = float(r.produced_qty or 0)
            frappe.db.sql(
                """UPDATE `tabProduction Plan Item` SET
                       custom_uom = %(uom)s,
                       custom_uom_conversion_factor = %(cf)s,
                       custom_qty_in_uom = %(qiu)s,
                       custom_produced_qty_in_uom = %(piu)s
                   WHERE name = %(name)s""",
                {"uom": uom, "cf": cf,
                 "qiu": (planned / cf) if cf else 0,
                 "piu": (prod / cf) if cf else 0,
                 "name": r.name})
            ppi_done += 1
        except Exception:
            frappe.log_error(frappe.get_traceback(),
                             f"TOC back-fill failed for PPI {r.name}")
    frappe.logger("chaizup_toc").info(f"PP Item back-fill: {ppi_done}/{len(ppi_rows)} rows stamped")

    # ── 4. Production Plan Sub Assembly Item back-fill ─────────────────────
    sub_rows = frappe.db.sql(
        """SELECT name, production_item, required_qty, projected_qty, qty
           FROM `tabProduction Plan Sub Assembly Item`
           WHERE (custom_uom IS NULL OR custom_uom = '')
             AND production_item IS NOT NULL""",
        as_dict=True)
    sub_done = 0
    for r in sub_rows:
        try:
            uom, cf = pick(r.production_item)
            req = float(r.required_qty or 0)
            prj = float(r.projected_qty or 0)
            qty = float(r.qty or 0)
            frappe.db.sql(
                """UPDATE `tabProduction Plan Sub Assembly Item` SET
                       custom_uom = %(uom)s,
                       custom_uom_conversion_factor = %(cf)s,
                       custom_required_qty_in_uom  = %(riu)s,
                       custom_projected_qty_in_uom = %(piu)s,
                       custom_qty_to_order_in_uom  = %(oiu)s
                   WHERE name = %(name)s""",
                {"uom": uom, "cf": cf,
                 "riu": (req / cf) if cf else 0,
                 "piu": (prj / cf) if cf else 0,
                 "oiu": (qty / cf) if cf else 0,
                 "name": r.name})
            sub_done += 1
        except Exception:
            frappe.log_error(frappe.get_traceback(),
                             f"TOC back-fill failed for Sub Assembly {r.name}")
    frappe.logger("chaizup_toc").info(
        f"Sub Assembly back-fill: {sub_done}/{len(sub_rows)} rows stamped")

    # ── 5. BOM back-fill ───────────────────────────────────────────────────
    # 2026-05-19 — Also back-fills custom_created_time + custom_created_by
    # so the BOM list view's Created On / Created By columns work on
    # legacy records without waiting for next save.
    bom_rows = frappe.db.sql(
        """SELECT name, item, quantity, creation, owner
           FROM `tabBOM`
           WHERE (custom_uom IS NULL OR custom_uom = ''
                  OR custom_created_time IS NULL
                  OR custom_created_by IS NULL
                  OR custom_created_by = '')
             AND item IS NOT NULL""",
        as_dict=True)
    bom_done = 0
    for r in bom_rows:
        try:
            uom, cf = pick(r.item)
            q = float(r.quantity or 0)
            frappe.db.sql(
                """UPDATE `tabBOM` SET
                       custom_uom = IFNULL(NULLIF(custom_uom, ''), %(uom)s),
                       custom_uom_conversion_factor = COALESCE(NULLIF(custom_uom_conversion_factor, 0), %(cf)s),
                       custom_qty_in_uom = COALESCE(NULLIF(custom_qty_in_uom, 0), %(qiu)s),
                       custom_created_time = IFNULL(custom_created_time, %(creation)s),
                       custom_created_by   = IFNULL(NULLIF(custom_created_by, ''), %(owner)s)
                   WHERE name = %(name)s""",
                {"uom": uom, "cf": cf,
                 "qiu": (q / cf) if cf else 0,
                 "creation": r.creation, "owner": r.owner,
                 "name": r.name})
            bom_done += 1
        except Exception:
            frappe.log_error(frappe.get_traceback(),
                             f"TOC back-fill failed for BOM {r.name}")
    frappe.logger("chaizup_toc").info(f"BOM back-fill: {bom_done}/{len(bom_rows)} rows stamped")

    frappe.db.commit()
    frappe.logger("chaizup_toc").info("=== TOC UOM Back-fill: complete ===")
    return {"wo": wo_done, "ppi": ppi_done, "sub": sub_done, "bom": bom_done}


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
