# =============================================================================
# CONTEXT
#   chaizup_toc / overrides / production_plan
#   ----------------------------------------
#   Subclass of ERPNext's ProductionPlan that closes a gap in the TOC UOM
#   bi-directional sync.
#
#   Before this override, the UOM custom-field trio on po_items and
#   sub_assembly_items (custom_uom, custom_uom_conversion_factor,
#   custom_*_in_uom) was populated by `_stamp_uom_fields_on_pp` only at
#   two points:
#       1. `Production Plan.validate`   — fires on Save (hooks.py:173)
#       2. The engine auto-PP path      — explicit call at Step 2.5
#                                         (production_plan_engine.py:697)
#
#   That meant when a user clicked the standard ERPNext button
#   "Get Sub Assembly Items" on a draft PP, the new sub-assembly rows
#   appeared in the grid with the STANDARD qty fields filled
#   (required_qty, projected_qty, qty) but the in-UOM display fields
#   stayed at 0 — the in-UOM columns only refreshed when the user hit
#   Save and the validate hook ran.
#
#   This override hooks into `ProductionPlan.get_sub_assembly_items` so
#   the same idempotent stamper runs as part of the server method itself.
#   The button's `frm.call` returns the modified doc, ERPNext's
#   `refresh_field("sub_assembly_items")` paints it, and the user sees
#   coherent in-UOM values immediately — no Save required.
#
# MEMORY
#   - [[app_chaizup_toc]] — Production Plan UOM stamping section
#   - hooks.py: `override_doctype_class["Production Plan"]` wires this in
#
# INSTRUCTIONS
#   - Keep the override SHALLOW. Call super() then run the stamper.
#     Don't replicate ERPNext logic here — if ERPNext changes its row
#     shape, super() picks it up for free.
#   - The stamper is idempotent. Don't worry about calling it twice
#     (validate will still fire on the subsequent Save).
#   - Keep the @frappe.whitelist() decorator. The base method is
#     whitelisted and the JS button (production_plan.js:415) calls it
#     via `frm.call` with `method: "get_sub_assembly_items"`; the
#     re-decoration is required so the subclass method stays whitelisted.
#
# DANGER ZONE
#   - DO NOT raise from the stamping step. If ladder lookups fail the
#     user still needs their sub-assembly rows. Log + continue.
#   - DO NOT change the method signature — ERPNext callers (combine_sub_items,
#     engine auto-PP at production_plan_engine.py:667) pass it positionally.
#
# RESTRICT
#   - Don't add business logic here. Anything beyond UOM stamping belongs
#     in `production_plan_engine.py` and a doc_event/validate hook.
#   - Don't override other ProductionPlan methods unless they have the
#     same "Save-bypassing UI button" problem. The validate hook covers
#     every save-driven path already.
# =============================================================================

import frappe

from erpnext.manufacturing.doctype.production_plan.production_plan import ProductionPlan

from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
    _stamp_uom_fields_on_pp,
    _stamp_toc_fields_on_work_orders,
)


class ChaizupProductionPlan(ProductionPlan):
    """Production Plan controller with TOC stamping wired into two
    button-driven server methods that ERPNext otherwise calls with
    `ignore_validate=True` (which bypasses our doc-event hooks):

        1. `get_sub_assembly_items` — populates the TOC UOM custom-field
           trio on po_items + sub_assembly_items rows the moment the
           "Get Sub Assembly Items" button is clicked, not only on Save.

        2. `make_work_order` — stamps the TOC UOM trio + MRP fields on
           every Work Order created by the "Create > Work Order" button,
           which ERPNext inserts via `wo.flags.ignore_validate = True`
           (production_plan.py:947) — that flag short-circuits Frappe's
           `_validate` (frappe/model/document.py:1331), so the existing
           `Work Order.validate → stamp_uom_fields_on_wo_validate` hook
           NEVER fires for those WOs. The override calls the engine
           stamper after super() to fill the gap.

    Forward sync (custom → standard) is handled by
    `public/js/production_plan_mrp_uom.js` and
    `public/js/work_order_mrp_uom.js`. Reverse sync (standard → custom)
    lives in `_stamp_uom_fields_on_pp` (PP rows) and
    `_stamp_toc_fields_on_work_orders` (WOs).
    """

    @frappe.whitelist()
    def get_sub_assembly_items(self, manufacturing_type=None):
        # 1. Let ERPNext do its work: traverse multi-level BOM, populate
        #    self.sub_assembly_items.
        super().get_sub_assembly_items(manufacturing_type=manufacturing_type)

        # 2. Stamp custom_uom / custom_uom_conversion_factor / all *_in_uom
        #    fields on every po_items + sub_assembly_items row, idempotent.
        #    Guarded: stamping must never block the button.
        try:
            _stamp_uom_fields_on_pp(self)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC UOM stamp after Get Sub Assembly Items failed for "
                f"Production Plan {self.name or '(new)'}",
            )

    @frappe.whitelist()
    def make_work_order(self):
        # 1. Let ERPNext create the FG + sub-assembly Work Orders. ERPNext
        #    uses ignore_validate=True (production_plan.py:947) which
        #    bypasses our Work Order validate doc-event hook — that's the
        #    gap this override closes.
        super().make_work_order()

        # 2. Stamp UOM trio + MRP fields on every WO produced by this PP.
        #    The stamper looks WOs up by `production_plan = self.name`, so
        #    it covers both finished-good WOs and sub-assembly WOs in one
        #    pass.
        #
        #    recorded_by=None — these WOs were created by a user button
        #    click, NOT by the TOC engine. The engine auto-PP path stamps
        #    "By System" itself; we must not impersonate that here, or
        #    downstream PO/MR overrides that gate on `custom_toc_recorded_by
        #    == "By System"` would treat user-driven WOs as TOC-generated.
        try:
            _stamp_toc_fields_on_work_orders(self.name, recorded_by=None)
        except Exception:
            frappe.log_error(
                frappe.get_traceback(),
                f"TOC WO stamp after Make Work Order failed for "
                f"Production Plan {self.name or '(new)'}",
            )
