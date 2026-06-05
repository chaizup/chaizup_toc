"""Drop the stale `custom_deepseek_api_key` value on TOC Settings after the
DeepSeek -> OpenAI migration (2026-06-05).

# =============================================================================
# CONTEXT: The AI Advisor (WO Kitting Planner + Production Overview) moved from
#   DeepSeek to the OpenAI SDK. The TOC Settings field was renamed
#   `custom_deepseek_api_key` -> `custom_openai_api_key` (Password). TOC Settings
#   is a Single doctype, so its field values live in `tabSingles`. A DeepSeek key
#   cannot authenticate against OpenAI, so we DELETE the orphaned key rather than
#   migrate it — the operator enters a fresh OpenAI key in the renamed field.
# RESTRICT: idempotent; safe to re-run. Do NOT copy the old value into the new
#   field (it would just produce auth failures against OpenAI).
# =============================================================================
"""

import frappe


def execute():
    # tabSingles columns are (doctype, field, value) — NOT parent.
    frappe.db.sql(
        "DELETE FROM `tabSingles` WHERE doctype = %s AND field = %s",
        ("TOC Settings", "custom_deepseek_api_key"),
    )
    frappe.clear_cache()
