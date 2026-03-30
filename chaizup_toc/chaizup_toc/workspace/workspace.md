# `workspace/` — Frappe Workspaces

## Workspaces in This App

| Workspace | File |
|-----------|------|
| `toc_buffer_management` | `toc_buffer_management/toc_buffer_management.json` |

## How Workspaces Work in Frappe

Workspaces are synced from JSON files during `bench migrate`. They appear in the Frappe sidebar as module navigation pages.

Key fields:
- `"public": 1` — visible to all users (role filtering done per-link)
- `"standard": "Yes"` — managed by the app, not user-customizable
- `"sequence_id"` — position in sidebar

## Workspace vs. Other Navigation

The TOC app registers its navigation in three places:
1. **`config/desktop.py`** — Legacy module tile (older Frappe UI)
2. **`hooks.py → add_to_apps_screen`** — Apps home grid tile (modern Frappe)
3. **`workspace/toc_buffer_management`** — Sidebar workspace (all Frappe versions)

All three point to the same routes/pages.
