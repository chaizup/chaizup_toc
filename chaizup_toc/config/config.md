# `config/` — App Configuration

## `desktop.py`

Registers the "Chaizup Toc" module on the Frappe desk home screen (legacy Module approach for older Frappe UI compatibility).

```python
{
    "module_name": "Chaizup Toc",
    "color": "#E67E22",
    "icon": "graph",
    "type": "module",
    "label": "TOC Buffer Management",
}
```

This is a companion to `hooks.py → add_to_apps_screen` (modern apps grid) and `workspace/toc_buffer_management.json` (workspace sidebar). The three together ensure the module appears in all navigation contexts across Frappe v14/v15/v16.
