# =============================================================================
# CONTEXT: Shared helper for TOC automation dedup + remark generation.
#   - Defines the canonical TERMINAL status sets used by every auto-engine
#     (mr_generator, component_mr_generator, production_plan_engine) when
#     deciding whether an existing MR / PP / WO / PO blocks a new one.
#   - Centralises the "pending statuses considered" text block that auto-
#     created MR descriptions / PP reasons / WO descriptions must include.
#
# MEMORY: toc_engine.md (same folder) — read before editing.
#
# ─── BUSINESS RULE (2026-05-14 — user requirement) ────────────────────────────
#   For auto-MR + auto-WO / auto-PP creation, ALL existing documents must be
#   counted as "still pending" (and therefore block a new auto-created doc)
#   EXCEPT those in terminal states (Closed / Completed / Cancelled / Stopped /
#   Received). Otherwise the daily scheduler creates duplicates of yesterday's
#   doc — operators see two WOs / two MRs for the same item × warehouse.
#
#   This rule applies ONLY to AUTOMATION. Manual creation (form-driven, API,
#   etc.) is intentionally untouched — operators may decide to create a second
#   doc by hand for any reason.
#
# ─── WHY A CENTRAL FILE ───────────────────────────────────────────────────────
#   The same exclusion list and reason-text format is reused by three
#   generators. Keeping it in one place prevents the lists drifting apart and
#   makes future status additions (e.g. a new ERPNext PP status) a single edit.
#
# ─── DANGER ZONE ──────────────────────────────────────────────────────────────
#   - Renaming any constant breaks the three callers — search before renaming.
#   - The MR / PP / WO terminal lists are derived from ERPNext core status
#     values. If ERPNext renames a status (e.g. "Received" → "Fully Received")
#     the dedup query silently fails to match and dupes can re-appear.
#   - format_auto_creation_remark() loads TOC Settings on EVERY call. Callers
#     that loop over hundreds of items should accept this cost (one cached
#     read) — never re-query TOC Settings directly to bypass this function.
#
# ─── RESTRICT ─────────────────────────────────────────────────────────────────
#   - Do NOT add Draft (docstatus=0) to any terminal list — Drafts must always
#     count as pending. The terminal list is consulted only inside a
#     docstatus<2 query, so Draft+Submitted are already in scope.
#   - Do NOT call this from manual-creation paths (Item form save handler,
#     form-button create flows). The "pending check rule" remark only makes
#     sense on docs the scheduler / TOC engine created itself.
# =============================================================================

import frappe

# ─── Canonical terminal status sets ──────────────────────────────────────────
# Anything NOT in this list (and within docstatus<2) is "still pending" and
# blocks a new auto-created doc for the same item × warehouse.

MR_TERMINAL_STATUSES = [
    "Stopped",
    "Cancelled",
    "Received",        # Purchase MR fully received — cycle done
    "Issued",          # Material Issue mode — handed out
    "Transferred",     # Material Transfer mode — moved
    "Manufactured",    # Manufacture-mode MR — production booked
]

PP_TERMINAL_STATUSES = [
    "Completed",
    "Closed",
    "Cancelled",
]

WO_TERMINAL_STATUSES = [
    "Completed",
    "Closed",
    "Stopped",
    "Cancelled",
]

PO_TERMINAL_STATUSES = [
    "Completed",
    "Closed",
    "Cancelled",
]


# ─── Configured pending lists (read from TOC Settings) ───────────────────────
# These represent the POSITIVE list of statuses the engine treats as
# supply/demand contributors in the shortage formulas. Defaults match the
# legacy hardcoded clauses so blank-field sites see no behaviour change.

def _parse_lines(raw, fallback):
    if not raw:
        return list(fallback)
    return [x.strip() for x in str(raw).strip().split("\n") if x.strip()]


def get_pending_wo_statuses():
    s = frappe.get_cached_doc("TOC Settings")
    return _parse_lines(
        s.get("pending_wo_statuses"),
        ["Not Started", "In Process", "Material Transferred"],
    )


def get_pending_po_statuses():
    s = frappe.get_cached_doc("TOC Settings")
    return _parse_lines(
        s.get("pending_po_statuses"),
        ["To Receive", "To Receive and Bill"],
    )


def get_pending_so_statuses():
    s = frappe.get_cached_doc("TOC Settings")
    return _parse_lines(
        s.get("projection_pending_so_statuses"),
        ["To Deliver and Bill", "To Deliver", "On Hold"],
    )


# ─── Public formatter for auto-created docs ──────────────────────────────────
# Returned as plain text (newline-separated) so it embeds cleanly into both
# Material Request Item.description and Production Plan.custom_creation_reason
# (both are Long Text / Text Editor fields that render \n as line breaks).

def format_pending_check_block(scope="MR"):
    """Return a multi-line block listing which doc statuses the AUTOMATION
    dedup check considers "still pending" for the given scope.

    Args:
        scope: One of 'MR', 'PP', 'WO', 'PO' — used only in the heading.

    The block is identical regardless of scope (all four lists are useful
    context for the operator reading the remark) — the heading just clarifies
    WHICH new doc the remark is attached to.
    """
    try:
        wo = get_pending_wo_statuses()
        po = get_pending_po_statuses()
        so = get_pending_so_statuses()
    except Exception:
        # TOC Settings missing or fixtures not synced — fall back to defaults
        wo = ["Not Started", "In Process", "Material Transferred"]
        po = ["To Receive", "To Receive and Bill"]
        so = ["To Deliver and Bill", "To Deliver", "On Hold"]

    return "\n".join([
        f"── Auto-generation rule (scope: {scope}) ──",
        "Existing docs in these statuses BLOCK a new auto-created doc:",
        f"  • WO pending (counts as supply): {', '.join(wo) or '(none configured)'}",
        f"  • PO pending (counts as supply): {', '.join(po) or '(none configured)'}",
        f"  • SO pending (counts as demand): {', '.join(so) or '(none configured)'}",
        "Terminal statuses (DO NOT block — cycle complete):",
        f"  • MR terminal: {', '.join(MR_TERMINAL_STATUSES)}",
        f"  • PP terminal: {', '.join(PP_TERMINAL_STATUSES)}",
        f"  • WO terminal: {', '.join(WO_TERMINAL_STATUSES)}",
        f"  • PO terminal: {', '.join(PO_TERMINAL_STATUSES)}",
        "Source: TOC Settings → Pending Work Order & Purchase Order Statuses "
        "(applies to scheduler / TOC engine only — manual creation is unaffected).",
    ])


def format_auto_creation_remark(doc_type, item_code, warehouse, qty,
                                 reason_summary, source_engine):
    """Compose the full remark text written into auto-created MR / PP / WO.

    Args:
        doc_type: 'Material Request' | 'Production Plan' | 'Work Order'
        item_code: Item being replenished
        warehouse: Target warehouse
        qty: Quantity in stock UOM (numeric, will be formatted)
        reason_summary: One-line summary of WHY the doc was created
                        (e.g. "TOC Buffer Replenishment | Zone: Red | BP: 78%")
        source_engine: 'TOC Buffer' | 'PP Automation (Calc A)' | 'PP Automation
                        (Calc B)' | 'PP Automation (Calc SO)' | 'PP Automation
                        (Calc Action)' | 'Component Shortage'

    Returns a multi-line string suitable for any Long Text field.
    """
    scope_map = {
        "Material Request": "MR",
        "Production Plan":  "PP",
        "Work Order":       "WO",
    }
    scope = scope_map.get(doc_type, "MR")

    head = [
        f"[Auto-Generated by {source_engine}]",
        f"Document: {doc_type} | Item: {item_code} | Warehouse: {warehouse}",
        f"Planned Qty (stock UOM): {qty}",
        f"Trigger: {reason_summary}",
    ]
    return "\n".join(head + ["", format_pending_check_block(scope)])
