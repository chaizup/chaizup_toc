# toc_dashboard — TOC Buffer Management Dashboard Page

Live, auto-refreshing single-page dashboard for daily buffer operations. The primary visual interface. Route: `/app/toc-dashboard`.

```
toc_dashboard/
├── toc_dashboard.json   ← Page metadata (title, module, roles)
├── toc_dashboard.html   ← Jinja template (layout skeleton)
└── toc_dashboard.js     ← TOCDashboard class (all logic)
```

---

## Page Metadata

```json
{
    "name": "toc-dashboard",
    "title": "TOC Buffer Dashboard",
    "module": "Chaizup Toc",
    "standard": "Yes",
    "roles": [
        "System Manager", "TOC Manager", "TOC User",
        "Stock Manager", "Stock User",
        "Purchase Manager", "Manufacturing Manager"
    ]
}
```

---

## Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ [Header: "TOC Dashboard"] [Refresh] [Menu: Settings/Reports]     │
├──────────────────────────────────────────────────────────────────┤
│ [Filters: Buffer Type | Zone | Company]                          │
├────────────────────────────────────┬─────────────────────────────┤
│ Summary Cards:                     │ Donut Chart (SVG)            │
│ 🔴 Red: 3  🟡 Yellow: 5           │ [Red | Yellow | Green | Black]│
│ 🟢 Green: 12  📊 Avg BP%: 41.3%   │ Zone Legend w/ counts        │
├────────────────────────────────────┤─────────────────────────────┤
│ Priority Table (sorted by BP%)     │ Quick Links                  │
│ # | Item | Target | On-Hand |      │ [Production Priority Board]  │
│   | BP%  | Zone   | Buffer  |      │ [Procurement Action List]    │
│   | Deficit | Action            │ [Buffer Status Report]       │
│                                    ├─────────────────────────────┤
│                                    │ Daily Rhythm                 │
│                                    │ 06:30 ADU | 07:00 MRs...    │
└────────────────────────────────────┴─────────────────────────────┘
```

---

## TOCDashboard JS Class

### `constructor(page)`

```javascript
class TOCDashboard {
    constructor(page) {
        this.page = page;
        this.allData = [];       // full unfiltered buffer list
        this.filteredData = [];  // after client-side zone/type filter
        this.refreshTimer = null;
    }
}
```

### `load()`

Two parallel API calls:

```javascript
async load() {
    this._setLoading(true);
    const company = this.page.fields_dict.company.get_value();
    
    const [summary, buffers] = await Promise.all([
        this._call("chaizup_toc.api.toc_api.get_buffer_summary"),
        this._call("chaizup_toc.api.toc_api.get_priority_board", { company })
    ]);
    
    this.allData = buffers || [];
    this._renderSummaryCards(summary);
    this.applyFilter();            // applies type/zone filters, renders table
    this._updateTimestamp();
    this._setLoading(false);
}
```

Auto-refreshes every 5 minutes:
```javascript
this.refreshTimer = setInterval(() => this.load(), 5 * 60 * 1000);
// Cleared on page-hide to prevent orphaned timers
```

### `applyFilter()`

Client-side filtering — no server call on filter change:

```javascript
applyFilter() {
    const type = this.page.fields_dict.buffer_type.get_value();
    const zone = this.page.fields_dict.zone.get_value();
    
    this.filteredData = this.allData.filter(r =>
        (!type || r.buffer_type === type) &&
        (!zone || r.zone === zone)
    );
    
    this._renderPriorityTable(this.filteredData);
    this._renderZoneChart(this.filteredData);
}
```

Company filter triggers `this.load()` (new API call) while buffer_type/zone filter only calls `applyFilter()` (client-side).

### `_renderPriorityTable(data)`

Renders `<tbody id="toc-tbody">` rows. Key columns:

| Column | Source | Rendering |
|--------|--------|----------|
| `#` | `i+1` | Rank |
| Item | `item_code` → `/app/item/{item_code}` | Clickable link |
| Target | `target_buffer` | Formatted number |
| On-Hand | `on_hand` | Physical stock only (NOT inventory_position) |
| BP% | `bp_pct` | Red bold if ≥67%, orange bold if ≥33% |
| SR% | `sr_pct` | Progress bar colored by zone |
| Zone | `zone` | Colored pill (toc-zone-{zone} CSS class) |
| Buffer Health | SR% | SVG progress bar: green/yellow/red fill |
| Deficit | `order_qty` | Units to replenish |
| Action | — | "Action Now" button (restricted) or zone indicator |

### Action Button Permission Gate

```javascript
const canTrigger = frappe.user.has_role(["System Manager", "Stock Manager", "TOC Manager"]);

if (canTrigger && ["Red", "Black"].includes(r.zone)) {
    actionHtml = `<button onclick="dash._openMR('${r.item_code}', '${r.warehouse}', 
                   '${r.buffer_type}', ${r.order_qty})">Action Now</button>`;
} else {
    actionHtml = `<span class="toc-zone-${r.zone.toLowerCase()}">${r.zone_action}</span>`;
}
```

Users without `Stock Manager`/`TOC Manager`/`System Manager` see the action text — not the button.

### `_openMR(itemCode, warehouse, bufferType, qty)`

Creates Material Requests for **all** Red/Yellow items of the given buffer type — NOT just the clicked item.

```javascript
_openMR(itemCode, warehouse, bufferType, qty) {
    frappe.confirm(
        `This will generate MRs for <b>ALL</b> Red/Yellow <b>${bufferType}</b> items —
         not just ${itemCode}. The system generates one MR per item automatically.
         Continue?`,
        () => {
            frappe.call({
                method: "chaizup_toc.api.toc_api.trigger_manual_run",
                args: { buffer_type: bufferType, zone_filter: JSON.stringify(["Red", "Black", "Yellow"]) },
                callback(r) {
                    frappe.show_alert(`${r.message.created} Material Requests created`);
                }
            });
        }
    );
}
```

The confirm dialog explicitly states the scope — prevents user confusion about what gets created.

### `_renderZoneChart(data)`

Pure SVG donut chart — no third-party library dependency.

```javascript
_renderZoneChart(data) {
    const counts = { Red: 0, Yellow: 0, Green: 0, Black: 0 };
    data.forEach(r => counts[r.zone] = (counts[r.zone] || 0) + 1);
    const total = data.length || 1;
    
    const colors = { Red: "#E74C3C", Yellow: "#F39C12", Green: "#27AE60", Black: "#2C3E50" };
    const r = 60;  // SVG radius
    const cx = 80, cy = 80;
    
    let startAngle = -90;
    let svgPaths = "";
    
    for (const [zone, count] of Object.entries(counts)) {
        const angle = (count / total) * 360;
        const endAngle = startAngle + angle;
        // Calculate arc path for each zone segment
        // Animated via CSS transition on stroke-dasharray
        svgPaths += `<path d="${arcPath(cx, cy, r, startAngle, endAngle)}" fill="${colors[zone]}"/>`;
        startAngle = endAngle;
    }
    
    document.getElementById("toc-donut").innerHTML = svgPaths;
    // Update legend counts
}
```

Animated transitions on `stroke-dasharray` / `stroke-dashoffset` CSS properties when data refreshes.

### Helper Methods

| Method | Description |
|--------|-------------|
| `_call(method, args)` | Promise wrapper: `new Promise((resolve) => frappe.call({..., callback: r => resolve(r.message)}))` |
| `_fmt(n)` | Indian locale formatting: `new Intl.NumberFormat('en-IN').format(n)` |
| `_setLoading(on)` | Shows/hides spinner overlay on the table |
| `_showError(err)` | Red alert toast via `frappe.show_alert` |
| `_updateTimestamp()` | Updates "Last sync: HH:MM:SS" text |
| `_barHTML(srPct, zone)` | Returns `<div class="toc-bar-track"><div class="toc-bar-fill" style="width:{srPct}%"></div></div>` |
| `_zonePill(zone)` | Returns `<span class="toc-zone-pill zone-{zone}">{zone}</span>` |

---

## HTML Template (toc_dashboard.html)

Skeleton rendered via `frappe.render_template("toc_dashboard", {})`. Key IDs used by JS:

| ID | Purpose |
|----|---------|
| `#toc-summary-red` | Red zone count card |
| `#toc-summary-yellow` | Yellow zone count card |
| `#toc-summary-green` | Green zone count card |
| `#toc-summary-avg` | Avg BP% card |
| `#toc-tbody` | Priority table body |
| `#toc-donut` | SVG donut chart container |
| `#toc-legend` | Zone count legend |
| `#toc-last-sync` | Timestamp text |
| `#toc-spinner` | Loading overlay |

---

## Navigation to This Page

1. **Apps home screen** → Chaizup TOC tile → `/app/toc-dashboard`
2. **Workspace shortcut** → "TOC Live Dashboard"
3. **Keyboard shortcut** → `Ctrl+Shift+T` (from `desk_branding.js`)
4. **Production Priority Board menu** → "TOC Dashboard"
5. **Procurement Action List menu** → "TOC Dashboard"

---

## Fixed Bug History

### BUG-001: Misleading `_openMR()` Confirm Dialog
Dialog said "Create MR for [item]" but actually created MRs for ALL Red/Yellow items of that buffer type. **Fixed**: confirm text now explicitly says "ALL [type] items — not just this one."

### BUG-002: Permission Mismatch on "Action Now" Button
`trigger_manual_run` requires Stock Manager/TOC Manager/System Manager, but Stock User and Purchase Manager could see and click the button (getting a PermissionError). **Fixed**: `frappe.user.has_role()` gate added; unauthorized users see plain action text instead.

### BUG-003: "On Hand" Column Showed IP (Inventory Position)
Column header said "On-Hand" but value was `inventory_position` (the F2 result, which includes WIP and subtracts backorders). **Fixed**: column now reads `r.on_hand` (raw physical stock from Bin.actual_qty). Header updated to "On-Hand".
