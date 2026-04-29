# page/ — Frappe Desk Pages

Six custom Frappe Desk Pages providing interactive operational interfaces beyond what Script Reports offer.

```
page/
├── toc_dashboard/        ← Live buffer priority dashboard (auto-refreshing)
├── toc_item_settings/    ← Bulk TOC configuration per item (added 2026-04-26)
├── toc_user_guide/       ← Self-contained tutorial — all formulas, logic, triggers (added 2026-04-26)
├── kitting_report/       ← Full kitting readiness board (demand + supply + BOM)
├── supply_chain_tracker/ ← 7-stage supply chain Kanban pipeline
└── wo_kitting_planner/   ← Work Order kitting planner (7 tabs, WKP-001..033)
```

## Critical HTML Template Rule (affects ALL pages)

Frappe caches HTML templates inside a single-quoted JS string:
```javascript
frappe.templates["page_name"] = '...your HTML...'
```
**Any raw single quote `'` inside an onclick/oninput attribute value WILL BREAK THE PAGE**
with `SyntaxError: Unexpected identifier`. Always use `&quot;` for string arguments in event handlers:
- ✅ `onclick="fn(&quot;value&quot;)"`
- ❌ `onclick="fn('value')"` — breaks Frappe template caching

This caused the 2026-04-26 `toc-item-settings` outage. After any `.html` change:
```
redis-cli -h redis-cache -p 6379 FLUSHALL
```

---

## Pages vs. Script Reports — When to Use Each

| Aspect | Script Report | Desk Page |
|--------|--------------|-----------|
| Data display | Grid table (Frappe DataTable) | Custom HTML — any layout |
| Interactivity | Cell formatter, toolbar buttons | Full JS classes, event handlers, modals |
| Refresh pattern | Manual (user clicks Refresh) | Can auto-refresh (setInterval) |
| Drill-down panels | Not supported natively | Fully supported (show/hide panels) |
| Action buttons | Toolbar only | Inline per-row, toolbar, modal |
| Charts | Frappe Charts (simple) | Custom SVG, any chart library |
| Filter mechanism | Frappe Query Report filter bar | Custom filter fields on the page |
| URL shareable | Yes (filters in URL) | Yes (route: /app/page-name) |
| Export to Excel | Built-in button | Must implement manually |

**Use Script Report when**: The output is fundamentally a table with fixed columns and simple toolbar actions.

**Use Desk Page when**: The UI needs drill-down panels, rich inline actions, auto-refresh, custom charts, or multi-panel layouts.

---

## Pages in This App

### toc_dashboard — TOC Buffer Dashboard

Route: `/app/toc-dashboard`

**Purpose**: Live, auto-refreshing overview of all buffer zones. The morning "at-a-glance" view before opening Production Priority Board.

**Auto-refresh**: Every 5 minutes via `setInterval`.

**Key difference from Production Priority Board**: Dashboard shows a simplified table optimized for quick zone scanning. The Production Priority Board is the full decision-support report with all formula columns.

**Data source**: `toc_api.get_priority_board()` + `toc_api.get_buffer_summary()` (two parallel API calls on load).

**Who uses it**: Anyone who needs a live status view — production floor screen, management dashboard, operations meeting.

Full documentation: `toc_dashboard/toc_dashboard.md`

---

### toc_item_settings — Bulk TOC Configuration

Route: `/app/toc-item-settings` · Added: 2026-04-26

**Purpose**: Bulk item configuration dashboard. Filter items by TOC status, buffer type, and item group. Click any row → modal with all TOC fields (5 tabs: Enable/Mode, ADU, T/CU, BOM, Buffer Rules) + rich help panel with formula explanations and importance levels. Replaces editing each item individually in Item Master.

**Key UX**: Modal is scoped to one item at a time. Save fires `on_item_validate` via `item.save()` — auto-resolves buffer_type, validates mutual exclusion.

Full documentation: `toc_item_settings/toc_item_settings.md`

---

### toc_user_guide — User Guide

Route: `/app/toc-user-guide` · Added: 2026-04-26

**Purpose**: Self-contained HTML+CSS+JS tutorial covering all 13 topics: Overview, Quick Start, Formulas F1–F8 (with live calculators), Buffer Types, Zone System, Daily Schedule, Sales Projection Automation, DBM, Real-Time Alerts, TOC Settings Reference, Item Fields Reference, Trigger Map, Troubleshooting.

**Design**: Static page — zero API calls. All content inline. Navigation sidebar with scroll-spy. Sticky layout with search filter. Intended as always-open reference during configuration.

Full documentation: `toc_user_guide/toc_user_guide.md`

---

### kitting_report — Kitting Report

Route: `/app/kitting-report`

**Purpose**: Full production readiness check. Shows which FG/SFG items have pending demand, whether components are available, and what the procurement status of each shortage is.

**No auto-refresh**: BOM walking is expensive. Manual refresh only.

**Key difference from Production Priority Board**: Kitting Report is demand-driven (SOs → demand → BOM check). Priority Board is buffer-driven (TOC buffer rules → replenishment signal).

**Data source**: `kitting_api.get_kitting_summary()` (main table) + `kitting_api.get_item_kitting_detail()` (drill-down per row click).

**Who uses it**: Production Planner, Operations Manager, anyone scheduling production runs.

Full documentation: `kitting_report/kitting_report.md`

---

## Frappe Page Structure

### Page Metadata (page_name.json)

```json
{
    "name": "toc-dashboard",
    "title": "TOC Buffer Dashboard",
    "module": "Chaizup Toc",
    "standard": "Yes",
    "roles": [
        {"role": "System Manager"},
        {"role": "TOC Manager"},
        {"role": "TOC User"},
        {"role": "Stock Manager"},
        {"role": "Stock User"},
        {"role": "Purchase Manager"},
        {"role": "Manufacturing Manager"}
    ]
}
```

`"standard": "Yes"` — managed by the app, not user-customizable from the UI.

### JavaScript Entry Point

```javascript
// page_name.js — auto-loaded when user navigates to /app/page-name
frappe.pages["page-name"].on_page_load = function(wrapper) {
    frappe.ui.make_app_page({
        parent: wrapper,
        title: "Page Title",
        single_column: true,
    });
    
    const page = wrapper.page;
    // Add filters
    // Initialize page class
    const dashboard = new MyPageClass(page);
    dashboard.load();
};
```

### HTML Template (page_name.html)

Rendered via `frappe.render_template("page_name", {})`. Provides the skeleton DOM structure that the JS class then populates:

```html
<!-- Jinja template — executed once on page load -->
<div id="my-container">
    <div id="my-summary"></div>
    <div id="my-table-wrapper">
        <div id="my-spinner" style="display:none">Loading...</div>
        <table><tbody id="my-tbody"></tbody></table>
    </div>
</div>
```

The JS class then manipulates these IDs directly (`document.getElementById("my-tbody").innerHTML = ...`).

---

## Navigation to These Pages

### From Workspace
The TOC Buffer Management workspace has direct shortcuts to both pages.

### From Reports
Production Priority Board toolbar → "TOC Dashboard" menu item → `/app/toc-dashboard`.

### From Keyboard
`Ctrl+Shift+T` → TOC Buffer Management workspace (configured in `desk_branding.js`).

### From hooks.py (Apps Screen)
```python
add_to_apps_screen = [
    {
        "name": "Chaizup TOC",
        "logo": "/assets/chaizup_toc/images/toc_logo.png",
        "title": "TOC Buffer Management",
        "route": "/app/toc-dashboard",
        "has_permission": "chaizup_toc.api.permissions.has_app_permission",
    }
]
```

---

## Common JS Patterns (Both Pages)

### API Call Wrapper

```javascript
_call(method, args = {}) {
    return new Promise((resolve, reject) => {
        frappe.call({
            method: method,
            args: args,
            callback(r) {
                if (r.exc) {
                    frappe.show_alert({ message: r.exc, indicator: "red" });
                    reject(r.exc);
                } else {
                    resolve(r.message);
                }
            }
        });
    });
}
```

### Loading Spinner

```javascript
_setLoading(on) {
    document.getElementById("toc-spinner").style.display = on ? "flex" : "none";
    document.getElementById("toc-tbody").style.opacity = on ? "0.3" : "1";
}
```

### Permission Gate

```javascript
// Only show action buttons to authorized roles
const canAct = frappe.user.has_role(["System Manager", "Stock Manager", "TOC Manager"]);
if (canAct) {
    // show action button
} else {
    // show plain text or nothing
}
```
