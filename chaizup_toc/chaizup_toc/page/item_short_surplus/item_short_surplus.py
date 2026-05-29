# =============================================================================
# CONTEXT: Item Short / Surplus Page — stub handler.
#   All data is served via frappe.call() from
#   `chaizup_toc.api.item_short_surplus_api`. This file only exists because
#   Frappe requires a .py alongside every Page.
#
# MEMORY: app_chaizup_toc.md § v0.0.22 — Item Short / Surplus report
# DOC:    ./item_short_surplus.md (full architecture + restricted areas)
#
# RESTRICT:
#   - Do NOT add server-side rendering here — keep logic in the API file.
#   - Do NOT add @frappe.whitelist endpoints in this file. Page consumers go
#     through chaizup_toc.api.item_short_surplus_api for clean module
#     separation, matching the Item Projection View + Item Shortage Dashboard
#     pattern.
# =============================================================================
