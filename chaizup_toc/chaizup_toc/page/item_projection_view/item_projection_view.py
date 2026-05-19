# =============================================================================
# CONTEXT: Item Projection View Page — stub handler.
#   All data is served via frappe.call() from
#   `chaizup_toc.api.item_projection_api` (page-facing shim) which delegates
#   to `chaizup_toc.api.item_projection_compute` (data + math). This file only
#   exists because Frappe requires a .py alongside every Page.
#
# MEMORY: app_chaizup_toc.md § Item Projection View (added 2026-05-18)
#
# RESTRICT:
#   - Do NOT add server-side rendering here — keep logic in the API file.
#   - Do NOT add @frappe.whitelist endpoints in this file. Page consumers go
#     through `chaizup_toc.api.item_projection_api` for clean module
#     separation, matching the Item Shortage Dashboard pattern.
# =============================================================================
