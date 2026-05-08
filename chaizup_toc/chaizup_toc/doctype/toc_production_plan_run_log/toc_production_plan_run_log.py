# =============================================================================
# CONTEXT: TOC Production Plan Run Log — parent audit document. One per run
#   (manual button, manual API call, or 02:00 AM cron). Aggregates per-item
#   decisions in `items` child (TOC Production Plan Run Item).
# MEMORY: app_chaizup_toc.md § Sales Projection Automation · Run Log
# RESTRICT:
#   - Do NOT auto-delete old logs from this controller. Retention is
#     user-policy; if cleanup is needed add a separate scheduler task with
#     explicit configurable retention days (default: 365).
#   - Do NOT compute summary counts in validate(). The engine writes them
#     directly after each per-item commit so partial runs (worker timeout)
#     leave a partially-correct log instead of zeros.
#   - The `pending_so_statuses_used` and `default_so_warehouse_used` fields
#     are PINNED snapshots of TOC Settings at run time. Re-running with
#     different settings must NOT mutate prior log rows — that defeats the
#     audit purpose.
# =============================================================================

from frappe.model.document import Document


class TOCProductionPlanRunLog(Document):
    pass
