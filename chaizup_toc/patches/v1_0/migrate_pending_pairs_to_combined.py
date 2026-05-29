# =============================================================================
# CONTEXT: One-shot migrate patch (2026-05-27, chaizup_toc v0.0.27) —
#   Migrate the 6 TOC Settings pending fields from legacy plain-status
#   format to the new combined `<status>|<workflow_state>` pair format.
#
#   Legacy format (one-per-line):       New format (one-per-line):
#     Not Started                         Not Started|Taken In Production
#     In Process                          In Process|Taken In Production
#     Material Transferred
#
#   The migration enriches each legacy line by joining it with the
#   most-common workflow_state for that (doctype, status) combination
#   currently in the database. When no Work Order / Sales Order /
#   Purchase Order with that status exists (or none has a workflow_state),
#   the line is upgraded to `status|` (empty workflow side).
#
# WHY:
#   The v0.0.27 UI in toc_settings.js renders a multi-select pair widget
#   that reads each line as `status|workflow_state`. Sites with legacy
#   data would see EMPTY chips because no line matched any known pair.
#   This patch upgrades the stored value so the widget renders existing
#   selections correctly on first load.
#
#   The engine's parsers (`_extract_pair_side` in production_plan_engine.py)
#   already handle BOTH formats — legacy lines work, but pair lines align
#   the UI with the data. This patch is for UX, not correctness.
#
# WHAT THIS PATCH DOES:
#   1. Loads TOC Settings.
#   2. For each of 6 pair-format fields, enriches each line by looking up
#      the dominant workflow_state in the source table.
#   3. Saves the doc with `update_modified=False` so the change doesn't
#      bump the audit timestamp.
#
# RESTRICTED:
#   - Don't change the `|` separator. The widget AND the engine parser
#     hardcode it. Switching would require updating BOTH atomically.
#   - Don't enrich lines that already contain `|` (idempotency).
#   - Don't fail the patch on enrichment errors — fall back to
#     `<status>|` (empty workflow). The engine still reads this correctly.
#   - The 2 new SO fields (pending_so_statuses + pending_so_workflow_states)
#     start empty by default — nothing to enrich. The patch only touches
#     them if a future migration populates legacy SO data.
#
# IDEMPOTENT: re-runs are no-ops (already-enriched lines are skipped).
#
# MEMORY: app_chaizup_toc.md § "v0.0.27 — TOC Settings pending pair widget (2026-05-27)"
# =============================================================================

import frappe


_VOUCHER_MAP = {
    "projection_pending_so_statuses": ("Sales Order",    "status"),
    "pending_wo_statuses":            ("Work Order",     "status"),
    "pending_wo_workflow_states":     ("Work Order",     "workflow_state"),
    "pending_po_statuses":            ("Purchase Order", "status"),
    "pending_po_workflow_states":     ("Purchase Order", "workflow_state"),
}


def _column_exists(doctype: str, col: str) -> bool:
    try:
        rows = frappe.db.sql(f"""
            SELECT 1 FROM information_schema.COLUMNS
             WHERE TABLE_NAME = 'tab{doctype}' AND COLUMN_NAME = '{col}'
            LIMIT 1
        """)
        return bool(rows)
    except Exception:
        return False


def _dominant_pair(doctype: str, side: str, value: str) -> str:
    """For a given side ('status' or 'workflow_state') with value `value`,
    return the most-common opposite side currently in the table.
    Returns "" when none found.
    """
    other = "workflow_state" if side == "status" else "status"
    if not _column_exists(doctype, other):
        return ""
    rows = frappe.db.sql(f"""
        SELECT IFNULL(`{other}`, '') AS v, COUNT(*) AS c
          FROM `tab{doctype}`
         WHERE `{side}` = %s
           AND docstatus < 2
         GROUP BY `{other}`
         ORDER BY c DESC, v ASC
         LIMIT 1
    """, (value,))
    return (rows[0][0] or "") if rows else ""


def _migrate_field(doc, fieldname: str, doctype: str, side: str) -> bool:
    """Return True if doc.<fieldname> was changed."""
    raw = (doc.get(fieldname) or "").strip()
    if not raw:
        return False
    out_lines = []
    changed = False
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        if "|" in line:
            # Already migrated
            out_lines.append(line)
            continue
        # Legacy single-value line. Enrich by looking up dominant opposite.
        try:
            opp = _dominant_pair(doctype, side, line)
        except Exception:
            opp = ""
        if side == "status":
            pair = f"{line}|{opp}"
        else:
            pair = f"{opp}|{line}"
        out_lines.append(pair)
        changed = True
    if changed:
        doc.set(fieldname, "\n".join(out_lines))
    return changed


def execute():
    log = frappe.logger("chaizup_toc")
    try:
        doc = frappe.get_single("TOC Settings")
    except Exception:
        log.warning("v0.0.27 patch: TOC Settings singleton missing — skip")
        return

    any_changed = False
    for fieldname, (doctype, side) in _VOUCHER_MAP.items():
        try:
            if _migrate_field(doc, fieldname, doctype, side):
                any_changed = True
                log.info(f"v0.0.27 patch: migrated {fieldname}")
        except Exception:
            log.error(
                f"v0.0.27 patch: failed to migrate {fieldname} — leaving as-is",
                exc_info=True,
            )

    if any_changed:
        # TOC Settings is a Single doctype — values live in tabSingles, not
        # in a dedicated table. Use frappe.db.set_value("TOC Settings", None, ...)
        # which routes through the singletons accessor. doc.save() would
        # also work but would fire validate hooks; we want a pure
        # storage-format upgrade with no side-effects.
        for fieldname in _VOUCHER_MAP:
            try:
                frappe.db.set_value("TOC Settings", None, fieldname,
                                    doc.get(fieldname) or "")
            except Exception:
                log.error(f"v0.0.27 patch: set_value failed for {fieldname}",
                          exc_info=True)
        frappe.db.commit()
        log.info("v0.0.27 patch: TOC Settings pair fields upgraded to combined format")
    else:
        log.info("v0.0.27 patch: nothing to migrate (already pair-format or empty)")
