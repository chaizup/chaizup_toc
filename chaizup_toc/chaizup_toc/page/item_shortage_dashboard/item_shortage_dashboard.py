# =============================================================================
# CONTEXT: Item Shortage Dashboard Page — stub handler.
#   All data is served via frappe.call() from
#   `chaizup_toc.chaizup_toc.report.item_shortage_dashboard.item_shortage_dashboard.execute`
#   (reused from the Script Report) plus the page-specific shim defined in
#   `chaizup_toc.api.item_shortage_api`. This file only exists because Frappe
#   requires a .py alongside every page.
# MEMORY: chaizup_item_shortage_dashboard.md § Page (added 2026-05-14)
# RESTRICT:
#   - Do NOT add server-side rendering here — keep logic in the API file.
#   - Do NOT add @frappe.whitelist endpoints in this file. Page consumers go
#     through `chaizup_toc.api.item_shortage_api` for clean module separation.
# =============================================================================
