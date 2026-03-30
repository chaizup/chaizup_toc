# `patches/` — Database Migration Patches

## Purpose
One-time patches applied during `bench migrate`. Each patch runs exactly once (tracked in `patches.txt`).

## `patches.txt`
Lists all patches in execution order:
```
chaizup_toc.patches.v1_0.fix_date_filters
chaizup_toc.patches.v1_0.fix_old_field_refs
chaizup_toc.patches.v1_0.fix_workspace_icon
```

## Subfolders
- `v1_0/` — All patches for v1.0.x

---

## Patch Application Rules (Frappe)
- Each patch module must have an `execute()` function.
- Frappe checks if the patch has already run in `__PatchLog` table.
- Patches are safe to re-run (idempotent by design).
- If a patch fails, migration halts and the error is shown.
