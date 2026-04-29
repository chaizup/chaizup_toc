# =============================================================================
# CONTEXT: Child table controller for TOC Projection Notification User.
#   Used by TOC Settings → Sales Projection Automation → Notification Users table.
#   Each row = one Frappe user who gets email alerts for Sales Projection events.
# MEMORY:  app_chaizup_toc.md § Sales Projection Automation
# INSTRUCTIONS:
#   - Controller body is intentionally empty — all logic is in projection_engine.py.
#   - Three flag fields control which events notify this user:
#     notify_on_edit, notify_on_submit, notify_on_wo_create.
# RESTRICT:
#   - Do not rename the flag fields — projection_engine._get_emails() references
#     them by name via getattr(row, flag_field, 0).
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TOCProjectionNotificationUser(Document):
    pass
