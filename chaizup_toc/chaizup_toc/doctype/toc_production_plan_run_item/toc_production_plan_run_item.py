# =============================================================================
# CONTEXT: TOC Production Plan Run Item — child table on TOC Production Plan
#   Run Log. One row per (item × warehouse × calc) decision the engine made.
# MEMORY: app_chaizup_toc.md § Sales Projection Automation · Run Log
# RESTRICT:
#   - Do NOT add validate logic that touches stock or creates documents.
#     This is a pure log row; mutating side-effects belong in the engine.
#   - Field naming `currALso` (mixed case) intentionally matches the spec
#     literal. Do NOT rename without updating the engine writer too.
# =============================================================================

from frappe.model.document import Document


class TOCProductionPlanRunItem(Document):
    pass
