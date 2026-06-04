# Copyright (c) 2026, Chaizup and Contributors
# See license.txt

from frappe.model.document import Document


class TOCTriggerConfiguration(Document):
    """Child row on TOC Settings: one automation engine's schedule + pending
    status overrides. Behaviour lives in trigger_scheduler / pending_status;
    this controller is intentionally empty (child rows validate via parent)."""
    pass
