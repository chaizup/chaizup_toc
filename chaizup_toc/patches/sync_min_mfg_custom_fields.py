# =============================================================================
# CONTEXT: One-shot patch to sync the new Item.custom_minimum_manufacture
#   Custom Field rows from custom_field.json fixture. Frappe migrate doesn't
#   auto-import fixtures after the initial install-app, so this patch ensures
#   the field is created on existing sites.
# MEMORY: app_chaizup_toc.md § Sales Projection Automation · Min Mfg Floor
# RESTRICT:
#   - Do NOT widen this to "import all fixtures" — keep it scoped to the
#     two new field names. Other fixtures may be intentionally diverged on
#     existing sites; a global re-import would overwrite them.
# =============================================================================

import json

import frappe

FIXTURE_PATH = (
    "/workspace/development/frappe-bench/apps/chaizup_toc/chaizup_toc/"
    "chaizup_toc/fixtures/custom_field.json"
)
NEW_FIELD_NAMES = (
    "Item-custom_toc_sec_minmfg",
    "Item-custom_minimum_manufacture",
)


def execute():
    with open(FIXTURE_PATH) as fh:
        rows = json.load(fh)

    for row in rows:
        if row.get("doctype") != "Custom Field":
            continue
        if row.get("name") not in NEW_FIELD_NAMES:
            continue

        name = row["name"]
        if frappe.db.exists("Custom Field", name):
            # Already there — refresh editable attributes only.
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
