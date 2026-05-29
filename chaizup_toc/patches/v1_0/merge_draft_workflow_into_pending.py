# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.29) —
#   Drop the now-removed "Draft Workflow States" fields for WO + PO + SO
#   and migrate any leftover values into their parent pair fields.
#
#   v0.0.28 dropped `projection_confirmed_so_workflow_states` (merged into
#   `projection_pending_so_statuses`). v0.0.29 does the same for the WO
#   and PO equivalents:
#
#     - `pending_wo_workflow_states` → merged into `pending_wo_statuses`
#     - `pending_po_workflow_states` → merged into `pending_po_statuses`
#
#   Each legacy workflow line becomes a workflow-only pair line `|<wf>`
#   in the target field. The engine's `_extract_pair_side(_, "workflow")`
#   parser reads them correctly.
#
# WHY:
#   User spec (2026-05-27): "remove the fields: Draft WO Workflow States
#   (one per line), Draft PO Workflow States (one per line). this filed
#   not required right now". The combined pair widget on the single
#   `pending_<wo|po>_statuses` field is sufficient.
#
# RESTRICTED:
#   - Don't drop the OLD Singles row until AFTER appending its values to
#     the new field. If the migrate fails mid-way, the legacy data must
#     remain readable.
#   - Idempotent re-runs are safe: legacy field already gone → no-op.
# =============================================================================

import frappe


_MIGRATIONS = [
    # (legacy_field, target_field)
    ("pending_wo_workflow_states", "pending_wo_statuses"),
    ("pending_po_workflow_states", "pending_po_statuses"),
]


def execute():
    log = frappe.logger("chaizup_toc")

    for legacy_field, target_field in _MIGRATIONS:
        rows = frappe.db.sql("""
            SELECT value FROM `tabSingles`
             WHERE doctype = 'TOC Settings' AND field = %s
        """, (legacy_field,))
        legacy_value = (rows[0][0] if rows else "") or ""
        legacy_value = legacy_value.strip()

        if not legacy_value:
            log.info(f"v0.0.29 patch: no legacy {legacy_field} value to merge")
            # Still cleanup the orphan row
            frappe.db.sql("""
                DELETE FROM `tabSingles`
                 WHERE doctype = 'TOC Settings' AND field = %s
            """, (legacy_field,))
            continue

        target_rows = frappe.db.sql("""
            SELECT value FROM `tabSingles`
             WHERE doctype = 'TOC Settings' AND field = %s
        """, (target_field,))
        current_target = (target_rows[0][0] if target_rows else "") or ""
        existing_set = set(current_target.split("\n")) if current_target else set()

        new_lines = []
        for line in legacy_value.split("\n"):
            line = line.strip()
            if not line:
                continue
            if "|" in line:
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
            frappe.db.set_value("TOC Settings", None, target_field, merged)
            log.info(f"v0.0.29 patch: merged {len(new_lines)} workflow line(s) "
                     f"from {legacy_field} → {target_field}")

        # Drop the legacy Singles row
        frappe.db.sql("""
            DELETE FROM `tabSingles`
             WHERE doctype = 'TOC Settings' AND field = %s
        """, (legacy_field,))
        log.info(f"v0.0.29 patch: removed legacy {legacy_field} Singles row")

    frappe.db.commit()
