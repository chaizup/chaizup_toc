# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.28) —
#   Merge the legacy `projection_confirmed_so_workflow_states` field
#   into `projection_pending_so_statuses` and drop the old field.
#
#   Background: v0.0.27 introduced the combined pair widget. v0.0.28
#   consolidates by removing the standalone "Confirmed Draft SO Workflow
#   States" field — its values are now stored as workflow-side-only pair
#   lines (`|<workflow>`) in `projection_pending_so_statuses`.
#
# WHAT THIS PATCH DOES:
#   1. Read the legacy `projection_confirmed_so_workflow_states` value
#      from tabSingles (TOC Settings is a Single doctype).
#   2. For each legacy workflow line, append a `|<workflow>` line to
#      `projection_pending_so_statuses` (workflow-only pair).
#   3. Delete the old Singles row so the field is fully gone from data.
#
# WHY:
#   The user requested in v0.0.28 spec: "Confirmed Draft SO Workflow
#   States (one per line) ← this not needed we will merge all status
#   and workflow states togather". The single pair field is the only
#   place SO pending config lives now.
#
# RESTRICTED:
#   - Don't drop the OLD field's Singles row until AFTER appending its
#     values to the new field. If the migrate fails mid-way, the legacy
#     data must remain readable.
#   - The legacy field's DocField is removed from toc_settings.json so
#     Frappe's schema sync handles the metadata removal. This patch only
#     moves the DATA.
#   - Re-runs are safe: legacy field already gone → no-op.
#
# IDEMPOTENT: re-run reads the legacy field; if absent or empty, no-op.
# =============================================================================

import frappe

_LEGACY_FIELD = "projection_confirmed_so_workflow_states"
_TARGET_FIELD = "projection_pending_so_statuses"


def execute():
    log = frappe.logger("chaizup_toc")

    # Read legacy value directly from tabSingles (the DocField may already
    # be removed from meta by the time this patch runs).
    rows = frappe.db.sql("""
        SELECT value FROM `tabSingles`
         WHERE doctype = 'TOC Settings' AND field = %s
    """, (_LEGACY_FIELD,))
    legacy_value = (rows[0][0] if rows else "") or ""
    legacy_value = legacy_value.strip()

    if not legacy_value:
        log.info("v0.0.28 patch: no legacy projection_confirmed_so_workflow_states "
                 "value — nothing to merge")
        # Still try to clean up the row if it exists
        frappe.db.sql("""
            DELETE FROM `tabSingles`
             WHERE doctype = 'TOC Settings' AND field = %s
        """, (_LEGACY_FIELD,))
        frappe.db.commit()
        return

    # Read current target value
    target_rows = frappe.db.sql("""
        SELECT value FROM `tabSingles`
         WHERE doctype = 'TOC Settings' AND field = %s
    """, (_TARGET_FIELD,))
    current_target = (target_rows[0][0] if target_rows else "") or ""

    # Build appended workflow-only lines from legacy value
    new_lines = []
    existing_set = set(current_target.split("\n")) if current_target else set()
    for line in legacy_value.split("\n"):
        line = line.strip()
        if not line:
            continue
        # Legacy format = bare workflow state name. Convert to "|<wf>"
        # pair so the pair parsers pick it up as workflow-only.
        if "|" in line:
            # Already pair format somehow — just take the right side
            _, _, wf_part = line.partition("|")
            wf = wf_part.strip()
        else:
            wf = line
        if not wf:
            continue
        pair_line = f"|{wf}"
        if pair_line not in existing_set:
            new_lines.append(pair_line)
            existing_set.add(pair_line)

    if new_lines:
        merged = (current_target + "\n" + "\n".join(new_lines)).strip() \
                 if current_target else "\n".join(new_lines)
        frappe.db.set_value("TOC Settings", None, _TARGET_FIELD, merged)
        log.info(f"v0.0.28 patch: merged {len(new_lines)} workflow line(s) "
                 f"from {_LEGACY_FIELD} into {_TARGET_FIELD}")
    else:
        log.info(f"v0.0.28 patch: all legacy {_LEGACY_FIELD} lines already "
                 "present in target — no merge needed")

    # Drop legacy Singles row regardless of merge outcome
    frappe.db.sql("""
        DELETE FROM `tabSingles`
         WHERE doctype = 'TOC Settings' AND field = %s
    """, (_LEGACY_FIELD,))
    frappe.db.commit()
    log.info(f"v0.0.28 patch: removed legacy {_LEGACY_FIELD} Singles row")
