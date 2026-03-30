# `page/` — Frappe Desk Pages

## Pages in This App

| Page Name | Route | Description |
|-----------|-------|-------------|
| `toc-dashboard` | `/app/toc-dashboard` | Live buffer priority dashboard |

## Frappe Page Structure
Each page folder contains:
- `<name>.json` — Page metadata (title, module, roles)
- `<name>.js` — JavaScript controller (loaded on page open)
- `<name>.html` — Jinja template (rendered client-side via `frappe.render_template`)

The `on_page_load` event in the JS file is the entry point.

## Navigation
The dashboard is accessible via:
- Apps home screen (Chaizup TOC tile) → `hooks.py → add_to_apps_screen → route: "/app/toc-dashboard"`
- Workspace shortcut "TOC Live Dashboard"
- Keyboard shortcut: `Ctrl+Shift+T` (set in `desk_branding.js`)
- Menu in Production Priority Board report
