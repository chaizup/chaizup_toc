# patches — Database Migration Patches

One-time data-fix scripts applied during `bench migrate`. Each patch runs exactly once (tracked in Frappe's `__PatchLog` table).

---

## patches.txt

```
chaizup_toc.patches.v1_0.fix_date_filters
chaizup_toc.patches.v1_0.fix_old_field_refs
chaizup_toc.patches.v1_0.fix_stale_workspace_filters
chaizup_toc.patches.v1_0.fix_workspace_icon
```

Patches run in this order during `bench migrate`. A failed patch halts migration.

---

## Frappe Patch Rules

- Each patch module must expose `def execute():` at module level
- Frappe checks `__PatchLog` table before running; skips already-run patches
- Patches should be **idempotent** — safe to run multiple times (use `frappe.db.exists()` checks)
- If a patch raises an exception, migration halts and shows the traceback
- To force re-run a patch: `bench --site your-site run-patch chaizup_toc.patches.v1_0.fix_date_filters`

---

## Subfolders

| Folder | Contents |
|--------|---------|
| `v1_0/` | All patches for v1.0.x — date filter fixes, field reference fixes, workspace icon fix |

---

## When to Add a New Patch

Add a patch whenever you need to:
1. Fix data created by a buggy earlier version (e.g., wrong field values in existing records)
2. Migrate data from old schema to new schema (e.g., rename a field, split a field)
3. Delete/recreate broken workspace/number-card configurations

Do NOT use patches for:
- Changes expressible in DocType JSON (Frappe handles these via `bench migrate` → schema sync)
- Installing new custom fields (use `setup/install.py` or fixtures)
- Creating reference data (use fixtures)

---

## Adding a New Patch

1. Create the file: `patches/v1_0/fix_my_issue.py`
2. Add the module path to `patches/patches.txt` (one line per patch)
3. Run `bench --site your-site migrate`

```python
# patches/v1_0/fix_my_issue.py
import frappe

def execute():
    # Idempotent — check before fixing
    broken_records = frappe.get_all("TOC Buffer Log",
        filters={"zone": None},
        fields=["name"])
    
    for rec in broken_records:
        frappe.db.set_value("TOC Buffer Log", rec.name, "zone", "Green")
    
    frappe.db.commit()
```
