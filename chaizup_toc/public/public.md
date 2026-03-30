# `public/` — Static Frontend Assets

## Purpose
CSS, JavaScript, and image assets served to the browser. Loaded by Frappe on every desk page (via `hooks.py → app_include_js/css`).

## Structure

```
public/
├── js/
│   ├── desk_branding.js      ← Global desk enhancements (auto-loaded)
│   ├── item_toc.js           ← Item form TOC tab (via doctype_js hook)
│   ├── material_request_toc.js ← MR form zone badge
│   └── stock_entry_toc.js    ← Stock Entry buffer impact check
├── css/
│   └── toc.css               ← Global TOC styling
└── images/
    ├── chaizup_toc_icon.svg
    ├── chaizup_toc_logo.svg
    └── chaizup_toc_logo_white.svg
```

## Loading Mechanism

| Asset | Hook | Scope |
|-------|------|-------|
| `desk_branding.js` | `app_include_js` | Every Frappe desk page |
| `toc.css` | `app_include_css` | Every Frappe desk page |
| `item_toc.js` | `doctype_js["Item"]` | Item form only |
| `material_request_toc.js` | `doctype_js["Material Request"]` | MR form only |
| `stock_entry_toc.js` | `doctype_js["Stock Entry"]` | Stock Entry form only |
