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
import os

import frappe

NEW_FIELD_NAMES = (
    "Item-custom_toc_sec_minmfg",
    "Item-custom_minimum_manufacture",
)


def execute():
    # Resolve the fixture path relative to the app — portable across dev
    # benches and Frappe Cloud (which has /home/frappe/frappe-bench/...).
    fixture_path = os.path.join(
        frappe.get_app_path("chaizup_toc"),
        "chaizup_toc", "fixtures", "custom_field.json",
    )
    if not os.path.exists(fixture_path):
        # Belt-and-braces — never hard-fail a migration on a missing fixture.
        # Log and move on; the fields can be created later via fixture re-export.
        frappe.logger("chaizup_toc").warning(
            f"sync_min_mfg_custom_fields: fixture missing at {fixture_path}; skipping"
        )
        return

    with open(fixture_path) as fh:
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
