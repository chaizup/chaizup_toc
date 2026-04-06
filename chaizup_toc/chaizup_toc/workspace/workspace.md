# workspace/ — Frappe Workspaces

The workspace/ folder contains Frappe Workspace definitions — the module homepage that appears when users click a module in the Frappe sidebar.

```
workspace/
└── toc_buffer_management/
    └── toc_buffer_management.json   ← Complete workspace definition
```

---

## Workspaces in This App

| Workspace Name | File | Route |
|----------------|------|-------|
| TOC Buffer Management | `toc_buffer_management/toc_buffer_management.json` | Frappe sidebar → "TOC Buffer Management" |

---

## How Frappe Workspaces Work

### Sync Mechanism

Workspace JSON files are synced from disk to the `Workspace` DocType during `bench migrate`. Frappe reads every `workspace/*.json` file in registered app modules and creates/updates the corresponding Workspace record.

```
bench migrate
  → Frappe scans: apps/chaizup_toc/chaizup_toc/chaizup_toc/workspace/*/
  → Finds: toc_buffer_management.json
  → Creates/updates: Workspace DocType record "TOC Buffer Management"
```

**Important**: Once a user modifies a workspace in the UI (adds/removes shortcuts), Frappe marks it as "customized" and may not overwrite it during future migrates. Use the force-delete patch pattern to reset.

### JSON Structure

A workspace JSON contains:

```json
{
    "name": "TOC Buffer Management",
    "title": "TOC Buffer Management",
    "module": "Chaizup Toc",
    "icon": "graph",
    "public": 1,
    "standard": "Yes",
    "sequence_id": 25,
    "content": "[...]",      ← JSON string of sections/cards layout
    "shortcuts": [...],      ← List of shortcut items
    "charts": [...],         ← Dashboard charts to embed
    "number_cards": [...]    ← Number cards to embed
}
```

The `content` field is a JSON-serialized array of layout sections. Each section has a `type` ("header", "card", "quick_list", "spacer") and its configuration.

### Accessing in Code

Workspaces are not commonly accessed programmatically. They are declarative UI configuration. Exception: during patching.

```python
# Read workspace
ws = frappe.get_doc("Workspace", "TOC Buffer Management")

# Force-delete for recreation
frappe.delete_doc("Workspace", "TOC Buffer Management", force=True)
frappe.db.commit()
# Next migrate recreates from JSON
```

---

## Three Navigation Registration Points

The TOC app registers navigation in three complementary places. All three should be kept in sync:

### 1. Workspace JSON (this folder)
```json
{
    "name": "TOC Buffer Management",
    "icon": "graph"
}
```
Appears in: **Frappe sidebar** (left navigation panel). All Frappe versions.

### 2. hooks.py → add_to_apps_screen

```python
add_to_apps_screen = [{
    "name": "Chaizup TOC",
    "logo": "/assets/chaizup_toc/images/toc_logo.png",
    "title": "TOC Buffer Management",
    "route": "/app/toc-dashboard",
    "has_permission": "chaizup_toc.api.permissions.has_app_permission",
}]
```

Appears in: **Apps home screen** (grid of installed apps, `/app/home`). Frappe v14+.

### 3. config/desktop.py

```python
{
    "module_name": "Chaizup Toc",
    "color": "#E67E22",
    "icon": "graph",
    "type": "module",
    "label": "TOC Buffer Management",
}
```

Appears in: **Legacy module home** (older Frappe UI, `/app/modules`). Kept for backward compatibility with Frappe v13 and older themes.

---

## Workspace vs. Report/Page Roles

Workspace access is controlled by the `"public"` flag and linked shortcut permissions:

- `"public": 1` — the workspace itself is visible to all logged-in users
- Individual shortcuts (reports, pages) enforce their own role checks
- A user who can see the workspace but lacks TOC User role will see shortcuts but get permission errors when clicking them

This means role management is done on the Reports/Pages/DocTypes, not on the workspace itself.

---

## Adding More Workspaces

If the app grows to serve different audiences (e.g., a separate "Procurement Dashboard" for the purchase team), add a new workspace:

1. Create folder: `workspace/procurement_dashboard/`
2. Create `procurement_dashboard.json` with appropriate sections
3. Register module: ensure `module = "Chaizup Toc"` in the JSON
4. Run `bench migrate` to sync

Each workspace appears as a separate sidebar entry. Use `sequence_id` to control ordering relative to other modules.
