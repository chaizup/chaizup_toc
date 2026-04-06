# config/ — App Configuration

App-level configuration files for module registration and legacy desk navigation. Thin wrapper — the actual app behavior is wired in `hooks.py`.

```
config/
└── desktop.py   ← Legacy module tile for Frappe desk home (Module approach)
```

---

## desktop.py — Module Registration

Registers the "Chaizup Toc" module on the Frappe desk home screen using the legacy Module approach, which was the standard navigation mechanism in Frappe v13 and earlier.

```python
from frappe import _

def get_data():
    return [
        {
            "module_name": "Chaizup Toc",
            "color": "#E67E22",          # Orange — matches TOC urgency color theme
            "icon": "graph",             # Frappe icon name
            "type": "module",
            "label": _("TOC Buffer Management"),
        }
    ]
```

**Color choice (#E67E22 — Orange):** Reflects the TOC urgency theme. Yellow/Orange is the "plan ahead" zone color. The module tile itself is the entry point for planning, so orange is intentional.

---

## Three Navigation Registration Points — Why All Three

The TOC app registers navigation in three complementary ways to support all Frappe versions and UI contexts:

### 1. config/desktop.py (this file)
**Appears in**: `/app/modules` — the legacy module grid page (Frappe v13 style UI).

**Who uses it**: Sites running older Frappe themes or custom desks that still use the modules grid. Also used by some ERPNext dashboard widgets that list modules.

**When to update**: If the app's module name or color changes.

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

**Appears in**: `/app/home` — the modern Apps home screen grid (Frappe v14+). Shows app logo tiles.

**Permission gate**: `has_app_permission` checks if the user has at least one TOC role before showing the tile. Users without any TOC role won't see the tile.

### 3. workspace/toc_buffer_management/toc_buffer_management.json
```json
{"name": "TOC Buffer Management", "public": 1, "sequence_id": 25}
```

**Appears in**: Frappe sidebar — left navigation panel visible on every page.

**Who uses it**: All users with the workspace visible. The workspace itself is public, but individual shortcuts enforce their own role checks.

---

## Why Keep All Three

| Context | Registration Used |
|---------|------------------|
| Frappe v13 or older Frappe theme | desktop.py |
| Frappe v14+ modern UI, Apps screen | add_to_apps_screen |
| Frappe sidebar (all versions) | workspace JSON |
| ERPNext module listing widgets | desktop.py |
| `/app/home` tile with logo | add_to_apps_screen |

All three point to the same routes/pages. Removing one degrades the experience in some contexts but doesn't break the app.

---

## `__init__.py` Files

The `config/` folder contains an `__init__.py` (empty) to make it a Python package. `desktop.py` is imported by Frappe via:

```python
# Frappe internals — reads get_data() from each app's config/desktop.py
from chaizup_toc.config.desktop import get_data
```

No other files are needed in this folder unless adding custom report categories or module-level configuration for other Frappe features.
