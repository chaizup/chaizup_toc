# =============================================================================
# CONTEXT: Sales Projection — Doc Event notification handlers.
#   This file handles ONLY the email-notification side of the Sales Projection
#   lifecycle (on_update draft-save alert, on_submit alert).
#
#   The automation engine (Production Plan creation) lives in:
#     production_plan_engine.py
#
# MEMORY: projection_engine.md
#
# INSTRUCTIONS:
#   - on_sales_projection_update fires after every save (draft OR after-submit db_update).
#     The handler gates on docstatus == 0 so it only sends the "edited" email for
#     draft saves, not after on_submit (Frappe fires on_update again after submit).
#   - on_sales_projection_submit fires once when the user submits the document.
#   - Both are registered in hooks.py under doc_events["Sales Projection"].
#
# DANGER ZONE:
#   - on_update fires AGAIN after on_submit (Frappe always calls db_update on submit).
#     The docstatus == 0 guard is CRITICAL to prevent sending the "edited" alert
#     after a submit action.
#   - Do NOT merge these two handlers into one function — they use different
#     recipient flag fields (notify_on_edit vs notify_on_submit).
#
# RESTRICT:
#   - Do not remove the docstatus == 0 guard in on_sales_projection_update.
#   - Do not call frappe.sendmail inside a loop over items — send once per event.
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import frappe
from frappe.utils import flt  # noqa: F401 — kept for any future use


# =============================================================================
# DOC EVENT HANDLERS
# =============================================================================

def on_sales_projection_update(doc, method):
    """Notify users when a Sales Projection is saved in draft state."""
    if doc.docstatus != 0:
        return
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        if not settings.enable_projection_automation:
            return
        recipients = _get_emails(settings.projection_notification_users, "notify_on_edit")
        if not recipients:
            return
        _send_sp_edit_email(doc, recipients)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Projection: on_edit notify failed")


def on_sales_projection_submit(doc, method):
    """Notify users when a Sales Projection is submitted."""
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        if not settings.enable_projection_automation:
            return
        recipients = _get_emails(settings.projection_notification_users, "notify_on_submit")
        if not recipients:
            return
        _send_sp_submit_email(doc, recipients)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC Projection: on_submit notify failed")


# =============================================================================
# PRIVATE HELPERS
# =============================================================================

def _get_emails(users_list, flag_field):
    """Return email addresses from notification users where the given flag is checked."""
    emails = []
    for row in (users_list or []):
        if not getattr(row, flag_field, 0):
            continue
        email = frappe.db.get_value("User", row.user, "email")
        if email:
            emails.append(email)
    return emails


def _send_sp_edit_email(doc, recipients):
    """Email: Sales Projection was edited in draft state."""
    site_url = frappe.utils.get_url()
    link = f"{site_url}/app/sales-projection/{doc.name}"
    user_label = (
        frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
    )
    subject = f"Sales Projection Updated: {doc.projection_month} {doc.projection_year}"
    message = f"""
    <div style="font-family:DM Sans,Arial,sans-serif;max-width:600px">
      <div style="background:#e67e22;color:#fff;padding:12px 18px;border-radius:6px 6px 0 0">
        <b>Sales Projection — Edited</b>
      </div>
      <div style="background:#fff;padding:16px;border:1px solid #eee;border-radius:0 0 6px 6px">
        <p>Sales Projection <a href="{link}">{doc.name}</a> for
        <b>{doc.projection_month} {doc.projection_year}</b>
        was edited by <b>{user_label}</b>.</p>
        <p>Warehouse: {doc.source_warehouse or "—"} &nbsp;|&nbsp;
        Projected items: {len(doc.table_mibv or [])}</p>
        <p style="color:#888;font-size:12px">Manage notification preferences in
        TOC Settings → Sales Projection Automation → Notification Users.</p>
      </div>
    </div>"""
    frappe.sendmail(recipients=recipients, subject=subject, message=message, now=True)


def _send_sp_submit_email(doc, recipients):
    """Email: Sales Projection was submitted."""
    site_url = frappe.utils.get_url()
    link = f"{site_url}/app/sales-projection/{doc.name}"
    user_label = (
        frappe.db.get_value("User", frappe.session.user, "full_name") or frappe.session.user
    )
    subject = (
        f"Sales Projection Submitted: {doc.projection_month} {doc.projection_year} "
        f"/ {doc.source_warehouse} — PP Automation Will Run"
    )
    message = f"""
    <div style="font-family:DM Sans,Arial,sans-serif;max-width:600px">
      <div style="background:#27ae60;color:#fff;padding:12px 18px;border-radius:6px 6px 0 0">
        <b>Sales Projection — Submitted</b>
      </div>
      <div style="background:#fff;padding:16px;border:1px solid #eee;border-radius:0 0 6px 6px">
        <p>Sales Projection <a href="{link}">{doc.name}</a> for
        <b>{doc.projection_month} {doc.projection_year}</b>
        has been <b>submitted</b> by <b>{user_label}</b>.</p>
        <p>Warehouse: {doc.source_warehouse or "—"} &nbsp;|&nbsp;
        Projected items: {len(doc.table_mibv or [])}</p>
        <p>The Production Plan Automation engine will run <b>daily at 02:00 AM</b> to create
        Draft Production Plans for this projection. You can also trigger it immediately:
        open the Sales Projection → click <b>"Run Production Plan Automation"</b>.</p>
        <p style="color:#888;font-size:12px">Manage notification preferences in
        TOC Settings → Sales Projection Automation → Notification Users.</p>
      </div>
    </div>"""
    frappe.sendmail(recipients=recipients, subject=subject, message=message, now=True)
