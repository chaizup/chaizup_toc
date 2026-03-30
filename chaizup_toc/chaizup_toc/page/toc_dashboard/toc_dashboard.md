# `toc_dashboard/` — TOC Buffer Management Dashboard Page

## Role
Live, auto-refreshing single-page dashboard. The primary visual interface for daily operations. Accessible at `/app/toc-dashboard`.

## Page Metadata (`toc_dashboard.json`)
```json
{
    "name": "toc-dashboard",
    "title": "TOC Buffer Dashboard",
    "module": "Chaizup Toc",
    "standard": "Yes"
}
```

**Allowed roles**: System Manager, TOC Manager, TOC User, Stock Manager, Stock User, Purchase Manager, Manufacturing Manager.

## Page Components

### Header Bar (from `frappe.ui.make_app_page`)
- **Title**: "TOC Dashboard"
- **Primary button**: "Refresh Data" → `dash.load()`
- **Menu items**: TOC Settings | Production Priority Board | Procurement Action List | User Guide
- **Admin-only menu**: "Create Demo Data" | "Delete Demo Data"

### Filter Bar
| Filter | Type | Effect |
|--------|------|--------|
| Buffer Type | Select (All/FG/RM/PM/SFG) | Client-side filter on loaded data |
| Zone | Select (All/Red/Yellow/Green/Black) | Client-side filter on loaded data |
| Company | Link | Triggers `dash.load()` with company filter |

Changing Buffer Type or Zone filters applies client-side — no server call. Changing Company triggers a new API call.

### HTML Template (`toc_dashboard.html`)
Rendered via `frappe.render_template("toc_dashboard", {})`.

**Layout:**
```
┌─────────────────────────────────────────┐
│ [Red Card] [Yellow Card] [Green Card] [Avg BP Card] │
├──────────────────────────┬──────────────┤
│ Priority Table           │ Donut Chart  │
│ (sorted by BP% desc)     │ Zone Legend  │
│                          ├──────────────┤
│                          │ Quick Links  │
│                          ├──────────────┤
│                          │ Daily Rhythm │
└──────────────────────────┴──────────────┘
```

## `TOCDashboard` JS Class

### `constructor(page)`
Stores page reference, initializes `allData` and `filteredData` arrays.

### `load()`
Parallel API calls:
1. `get_buffer_summary()` → summary cards
2. `get_priority_board(buffer_type=null, company=...)` → all buffer data

On success: renders summary cards, applies filters, updates timestamp.
Auto-refreshes every 5 minutes (`setInterval`). Timer cleared on `page-hide`.

### `applyFilter()`
Client-side filtering of `allData` by buffer type and zone. Calls `_renderPriorityTable()` and `_renderZoneChart()`.

### `_renderSummaryCards(summary)`
Updates 4 metric cards: Red count, Yellow count, Green count, Avg BP%.

### `_renderPriorityTable(data)`
Renders the priority table `<tbody id="toc-tbody">`.

**Columns**: # | Item | Target | On-Hand | BP% | SR% | Zone | Buffer Health Bar | Deficit | Action

Each row has:
- Item link → `/app/item/{item_code}`
- Zone pill (color-coded CSS class)
- SR% progress bar (colored by zone)
- "Action Now" (Red/Black) or "Plan" (others) button — **only visible to System Manager / Stock Manager / TOC Manager**

### `_renderZoneChart(data)`
Pure SVG donut chart. No third-party charting library.
- 4 segments: Red, Yellow, Green, Black
- Animated transitions on `stroke-dasharray`/`stroke-dashoffset`
- Legend shows counts per zone

### `_openMR(itemCode, warehouse, bufferType, qty)`
Shows confirm dialog, then calls `trigger_manual_run(buffer_type, zone_filter)`.

Creates MRs for **all** Red/Yellow items of the given `bufferType` — not just the clicked item. The confirm dialog clearly communicates this to the user.

### Helper Methods
| Method | Description |
|--------|-------------|
| `_call(method, args)` | Promise wrapper around `frappe.call` |
| `_fmt(n)` | Indian locale number formatting (`en-IN`) |
| `_setLoading(on)` | Shows/hides spinner overlay |
| `_showError(err)` | Red alert toast |
| `_updateTimestamp()` | Updates "Last sync:" text |
| `_barHTML(srPct, zone)` | Returns SVG bar track HTML |
| `_zonePill(zone)` | Returns colored zone badge span |

## Bug History

### ~~BUG-1 (FIXED): Misleading `_openMR()` confirm dialog~~
Confirm text said "Create MR for [item]" but actually created MRs for all Red/Yellow items of that buffer type. **Fixed**: dialog now accurately says "generates MRs for **all** Red/Yellow [type] items — not just this one."

### ~~BUG-2 (FIXED): Permission mismatch on "Action Now" button~~
`trigger_manual_run` requires `Stock Manager`/`TOC Manager`/`System Manager`, but `Stock User`/`Purchase Manager` could see and click the button. **Fixed**: `frappe.user.has_role()` check added; users without permission see a plain text zone indicator instead of the action button.

### ~~BUG-3 (FIXED): "On Hand" column showed IP, not actual on-hand~~
Column header said "On Hand" but value was `inventory_position` (IP = OH + WIP − BO). **Fixed**: column now reads `r.on_hand` (actual physical stock), header updated to "On-Hand".
