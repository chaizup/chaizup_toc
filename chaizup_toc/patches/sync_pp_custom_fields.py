# =============================================================================
# CONTEXT: One-shot patch — sync Production Plan custom fields used by the
#   PP automation engine (custom_created_by, custom_creation_reason,
#   custom_projection_reference). They were defined in custom_field.json but
#   never imported on existing sites. Without them, _pp_exists_for_item()
#   silently fails to dedup and every cron creates duplicate PPs.
# MEMORY: app_chaizup_toc.md § Sales Projection Automation · Dedup
# RESTRICT:
#   - Do NOT widen this to all custom fields. Each sync patch should be
#     scoped to the fields it explicitly enumerates.
# =============================================================================

import json
import os

import frappe

FIELD_NAMES = (
    "Production Plan-custom_created_by",
    "Production Plan-custom_creation_reason",
    "Production Plan-custom_projection_reference",
)


def execute():
    fixture_path = os.path.join(
        frappe.get_app_path("chaizup_toc"),
        "chaizup_toc", "fixtures", "custom_field.json",
    )
    if not os.path.exists(fixture_path):
        frappe.logger("chaizup_toc").warning(
            f"sync_pp_custom_fields: fixture missing at {fixture_path}; skipping"
        )
        return

    with open(fixture_path) as fh:
        rows = json.load(fh)

    for row in rows:
        if row.get("doctype") != "Custom Field":
            continue
        if row.get("name") not in FIELD_NAMES:
            continue

        name = row["name"]
        if frappe.db.exists("Custom Field", name):
            doc = frappe.get_doc("Custom Field", name)
            for key in (
                "label", "fieldtype", "options", "insert_after",
                "description", "module", "fieldname", "dt",
            ):
                if key in row and getattr(doc, key, None) != row[key]:
                    setattr(doc, key, row[key])
            doc.save(ignore_permissions=True)
            print(f"Updated {name}")
        else:
            doc = frappe.new_doc("Custom Field")
            doc.update(row)
            doc.insert(ignore_permissions=True)
            print(f"Created {name}")

    frappe.db.commit()
