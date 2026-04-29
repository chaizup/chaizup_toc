# =============================================================================
# CONTEXT: Child table controller for TOC Engine Notification User.
#   Used by TOC Settings → TOC Engine Notifications → Notification Users table.
#   Each row = one Frappe user who gets email alerts for TOC Engine events:
#     notify_on_component_mrs      → email after component shortage MRs are created
#     notify_on_min_order_missing  → daily email listing items missing min order qty config
# MEMORY: app_chaizup_toc.md § TOC Engine Notifications
# RESTRICT:
#   - Do not rename flag fields — component_mr_generator and min_order_sync reference
#     them by name via getattr(row, flag_field, 0).
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TOCEngineNotificationUser(Document):
    pass
