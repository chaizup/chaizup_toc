# =============================================================================
# CONTEXT: One-shot patch to sync property_setter.json fixtures into the DB.
#   Frappe's `bench migrate` does NOT auto-import fixture files after the
#   initial install-app, so existing sites need this patch to flip Work Order
#   `item_name` to in_list_view=1.
# MEMORY: app_chaizup_toc.md § Sales Projection Automation v2 · UX
# RESTRICT:
#   - Do NOT widen this to Property Setters from other modules. The chaizup_toc
#     module owns only its own list-view tweaks.
#   - Property Setter `name` must match exactly so re-runs are idempotent.
# =============================================================================

import json

import frappe

FIXTURE_PATH = (
    "/workspace/development/frappe-bench/apps/chaizup_toc/chaizup_toc/"
    "chaizup_toc/fixtures/property_setter.json"
)


def execute():
    with open(FIXTURE_PATH) as fh:
        rows = json.load(fh)

    for row in rows:
        if row.get("doctype") != "Property Setter":
            continue
        name = row["name"]

        if frappe.db.exists("Property Setter", name):
            doc = frappe.get_doc("Property Setter", name)
            for key in (
                "doctype_or_field", "doc_type", "field_name",
                "property", "property_type", "value", "module",
            ):
                if key in row and getattr(doc, key, None) != row[key]:
                    setattr(doc, key, row[key])
            doc.save(ignore_permissions=True)
            print(f"Updated {name}")
        else:
            doc = frappe.new_doc("Property Setter")
            doc.update(row)
            doc.insert(ignore_permissions=True)
            print(f"Created {name}")

    frappe.db.commit()
    frappe.clear_cache(doctype="Work Order")
