# `chaizup_toc/` — App Module Folder

This folder is the Frappe **module** folder — same name as the app. It contains all DocTypes, Pages, Reports, and Workspaces that are tracked in Frappe's module registry.

## Module Name
`Chaizup Toc` (as used in `module` field of all DocType JSONs and fixtures)

## Subfolders

| Folder | Contents |
|--------|---------|
| `doctype/` | Custom DocTypes: TOC Buffer Log, TOC Item Buffer, TOC Settings |
| `page/` | Frappe Desk Pages: toc-dashboard |
| `report/` | Script Reports: Production Priority Board, Procurement Action List, Buffer Status Report, DBM Analysis |
| `workspace/` | Frappe Workspace: TOC Buffer Management |

## Module Registry
Registered in `modules.txt`:
```
Chaizup Toc
```

## How Frappe Uses This
- Frappe scans this folder for DocType JSONs during `bench migrate`.
- All DocTypes, Reports, Pages, and Workspaces inside this folder are auto-discovered.
- The `module` field in JSON files must match `"Chaizup Toc"` exactly.

## Important Note: Double-Nested Folder
The app has an identical-name nesting:
```
apps/chaizup_toc/          ← Git repo root
    chaizup_toc/           ← Python package
        chaizup_toc/       ← Module folder (THIS folder)
```
This is standard Frappe app structure. The outermost is the repo, the middle is the installed Python package, and this folder is the Frappe module.
