# =============================================================================
# CONTEXT: One-shot patch that backfills the "Sales Projection Admin" role on
#   existing installs. Required because:
#     1. Frappe `bench migrate` does NOT auto-create Role rows referenced in
#        a DocType JSON's `permissions` list — the role row must exist BEFORE
#        the sync_doctype step or the perm rule is silently dropped.
#     2. The after_install hook only fires on a brand-new install, so existing
#        sites would never get the new role created automatically.
#   The patch also calls reload_doc on Sales Projection so the new perm row
#   from sales_projection.json is imported into `tabDocPerm` immediately.
# MEMORY: app_chaizup_toc.md § Sales Projection Permissions
# INSTRUCTIONS:
#   - Registered in patches.txt (chaizup_toc.patches.v1_0.add_sales_projection_admin_role).
#   - Idempotent: re-running is a no-op once the role + perm row exist.
# DANGER ZONE:
#   - Do NOT widen the role to other DocTypes here. Permission grants belong
#     in each DocType's own JSON `permissions` list, not in a runtime patch.
#   - reload_doc is path-based — ("chaizup_toc", "doctype", "sales_projection")
#     must match the actual folder structure or the reload silently no-ops.
# RESTRICT:
#   - Do not flip desk_access off. Without desk access the role holder can
#     authenticate but cannot navigate to /app/sales-projection.
# =============================================================================

import frappe


ROLE_NAME = "Sales Projection Admin"


def execute():
    _ensure_role()
    _reload_sales_projection_doctype()
    frappe.db.commit()


def _ensure_role():
    if frappe.db.exists("Role", ROLE_NAME):
        print(f"add_sales_projection_admin_role: role '{ROLE_NAME}' already exists; skipping create")
        return

    role = frappe.new_doc("Role")
    role.role_name = ROLE_NAME
    role.desk_access = 1
    role.flags.ignore_permissions = True
    role.insert()
    print(f"add_sales_projection_admin_role: created role '{ROLE_NAME}'")


def _reload_sales_projection_doctype():
    # Pulls the latest permissions list from sales_projection.json into tabDocPerm.
    # Without this, the new "Sales Projection Admin" row would only sync on the
    # next `bench migrate` — which is fine, but this patch is supposed to make
    # the role usable in the same migrate run that installs it.
    try:
        frappe.reload_doc("chaizup_toc", "doctype", "sales_projection", force=True)
        print("add_sales_projection_admin_role: reloaded Sales Projection DocType")
    except Exception:
        frappe.log_error(
            frappe.get_traceback(),
            "add_sales_projection_admin_role: reload_doc failed (non-fatal)",
        )
