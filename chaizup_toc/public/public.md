# public — Static Frontend Assets

CSS, JavaScript, and image assets served to the browser. Loaded by Frappe on desk pages via `hooks.py → app_include_js/css` and `doctype_js`.

```
public/
├── js/
│   ├── desk_branding.js        ← Global desk: zone colors, realtime alerts, Ctrl+Shift+T
│   ├── item_toc.js             ← Item form TOC Setting tab behavior
│   ├── material_request_toc.js ← MR form: zone banner, Priority Board button
│   └── stock_entry_toc.js      ← Stock Entry: buffer impact check button
├── css/
│   └── toc.css                 ← Global TOC styling (zone pills, progress bars, etc.)
└── images/
    ├── chaizup_toc_icon.svg
    ├── chaizup_toc_logo.svg
    └── chaizup_toc_logo_white.svg
```

---

## Loading Mechanism

| Asset | Hook | Scope | When loaded |
|-------|------|-------|------------|
| `desk_branding.js` | `app_include_js` | Every Frappe desk page | Page load, always |
| `toc.css` | `app_include_css` | Every Frappe desk page | Page load, always |
| `item_toc.js` | `doctype_js["Item"]` | Item form only | When Item form opens |
| `material_request_toc.js` | `doctype_js["Material Request"]` | MR form only | When MR form opens |
| `stock_entry_toc.js` | `doctype_js["Stock Entry"]` | Stock Entry form only | When SE form opens |

---

## js/desk_branding.js — Global Desk Enhancements

Loaded on every desk page. Three features:

### 1. Zone Color Pills in List Views

Applies CSS classes to any list view cell with `data-field="zone"` or `data-field="custom_toc_zone"`.

```javascript
function applyZoneColors() {
    document.querySelectorAll('[data-field="zone"]:not(.toc-styled), [data-field="custom_toc_zone"]:not(.toc-styled)')
    .forEach(cell => {
        cell.classList.add("toc-styled");
        const zone = cell.innerText.trim();
        const colorMap = {
            Red:    { bg: "#FADBD8", text: "#E74C3C" },
            Yellow: { bg: "#FEF9E7", text: "#F39C12" },
            Green:  { bg: "#D5F5E3", text: "#27AE60" },
            Black:  { bg: "#D5D8DC", text: "#2C3E50" },
        };
        if (colorMap[zone]) {
            cell.style.backgroundColor = colorMap[zone].bg;
            cell.style.color = colorMap[zone].text;
            cell.style.fontWeight = "bold";
            cell.style.borderRadius = "4px";
            cell.style.padding = "2px 6px";
        }
    });
}
```

Triggered on:
- `frappe.after_ajax(() => applyZoneColors())` — after each AJAX list refresh
- `$(document).on("page-change", ...)` — when navigating between pages (500ms delay)
- `MutationObserver` on `document.body` — catches dynamically rendered cells

### 2. Real-Time Buffer Alerts

```javascript
frappe.realtime.on("toc_buffer_alert", function(data) {
    const zoneColor = { Red: "#E74C3C", Black: "#2C3E50" }[data.zone] || "#E74C3C";
    frappe.show_alert({
        message: `<b style="color:${zoneColor}">${data.zone}</b> — ${data.item_name}<br>
                  BP%: ${data.bp_pct}% | Order: ${data.order_qty}`,
        indicator: data.zone === "Black" ? "dark" : "red",
    }, 10);  // 10-second toast
});
```

Published by `buffer_calculator.check_realtime_alert()` via Frappe's WebSocket server. Fires when any stock movement, Sales Order, Work Order, or Purchase Order causes a buffer to enter Red/Black zone.

### 3. Keyboard Shortcut

```javascript
document.addEventListener("keydown", function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === "T") {
        frappe.set_route("Workspaces", "TOC Buffer Management");
    }
});
```

`Ctrl+Shift+T` → Navigate to TOC Buffer Management workspace from anywhere in Frappe.

---

## js/item_toc.js — Item Form TOC Tab

All logic lives inside `frappe.ui.form.on("Item", { ... })`.

### Form Events

#### `refresh`
- Calls `_toggle_adu(frm)` — sets ADU value field read-only state based on Custom ADU checkbox
- If `custom_toc_enabled=1`, adds three buttons under "TOC" group:
  1. **Buffer Status** — calls `get_priority_board(item_code)`, shows zone/BP%/IP/order qty modal
  2. **Check BOM** — calls `check_bom(item_code, qty=1)`, shows component availability table (only if `custom_toc_default_bom` + `custom_toc_check_bom_availability` both set)
  3. **Priority Board** — routes to Production Priority Board report

#### Buffer Status Modal Example
```
🔴 RED ZONE
BP%: 72.0% (F3: (Target−IP)÷Target×100)
Target: 168 (F1: ADU×RLT×VF)
IP: 47 (F2)
Order Qty: 121 (F4: Target−IP)
Action: PRODUCE NOW
BOM/SFG: 1 component(s) short
```

#### `custom_toc_custom_adu`
Calls `_toggle_adu(frm)` to update field editability:
```javascript
function _toggle_adu(frm) {
    let is_custom = frm.doc.custom_toc_custom_adu;
    frm.set_df_property("custom_toc_adu_value", "read_only", is_custom ? 0 : 1);
    frm.set_df_property("custom_toc_adu_period", "hidden", is_custom ? 1 : 0);
    frm.set_df_property("custom_toc_adu_last_updated", "hidden", is_custom ? 1 : 0);
}
```

#### `custom_toc_auto_purchase` / `custom_toc_auto_manufacture`
Client-side mutual exclusion enforcement:
```javascript
custom_toc_auto_purchase(frm) {
    if (frm.doc.custom_toc_auto_purchase && frm.doc.custom_toc_auto_manufacture) {
        frm.set_value("custom_toc_auto_manufacture", 0);
        frappe.show_alert("Unchecked Auto Manufacturing — choose only one.", "orange");
    }
}
```
The server (`overrides/item.py`) also enforces this — dual enforcement prevents race conditions.

#### F5 T/CU Live Calculation
```javascript
function _calc_tcu(frm) {
    let p = flt(frm.doc.custom_toc_selling_price);
    let tvc = flt(frm.doc.custom_toc_tvc);
    let speed = flt(frm.doc.custom_toc_constraint_speed);
    if (p && speed > 0) frm.set_value("custom_toc_tcu", (p - tvc) * speed);
}
// Triggers on: selling_price, tvc, constraint_speed field changes
```

---

## js/material_request_toc.js — MR Form

### `refresh`

If `custom_toc_recorded_by === "By System"`:
- Shows intro banner colored by zone:
  - Red/Black → red background
  - Yellow → orange background
  - Green → green background
- Banner content: zone pill, BP%, formula note, target buffer, IP, SR%

```javascript
if (frm.doc.custom_toc_recorded_by === "By System") {
    let color = { Red: "#E74C3C", Black: "#2C3E50", Yellow: "#F39C12", Green: "#27AE60" }
        [frm.doc.custom_toc_zone] || "#7F8C8D";
    frm.set_intro(
        `<b style="color:${color}">${frm.doc.custom_toc_zone} ZONE</b> — ` +
        `BP: ${frm.doc.custom_toc_bp_pct}% | Target: ${frm.doc.custom_toc_target_buffer} | ` +
        `IP: ${frm.doc.custom_toc_inventory_position} | SR%: ${frm.doc.custom_toc_sr_pct}%`,
        color
    );
}
```

Adds "TOC Priority Board" button under "View" group → routes to Production Priority Board report.

---

## js/stock_entry_toc.js — Stock Entry Form

### `refresh`

On Draft Stock Entries, adds "Check Buffer Impact" button under "TOC" group.

```javascript
function checkBufferImpact(frm) {
    // Collect all unique TOC-managed item codes from Stock Entry items table
    let item_codes = [...new Set(frm.doc.items.map(i => i.item_code))];
    
    frappe.call({
        method: "chaizup_toc.api.toc_api.get_priority_board",
        // No item_code filter — get all TOC items, filter client-side
        callback(r) {
            if (!r.message) return;
            // Filter to only items in this Stock Entry
            let relevant = r.message.filter(b => item_codes.includes(b.item_code));
            if (!relevant.length) {
                frappe.msgprint("None of the items in this entry are TOC-managed.");
                return;
            }
            // Show table: item, zone, BP%, IP, order_qty
            let html = buildBufferTable(relevant);
            frappe.msgprint({ title: "Buffer Impact", message: html, wide: true });
        }
    });
}
```

Shows which TOC-managed items in this Stock Entry are in Red/Yellow zone — helps operators understand the urgency before posting.

---

## css/toc.css — Global TOC Styling

Covers:
- Zone pill classes (`.toc-zone-red`, `.toc-zone-yellow`, `.toc-zone-green`, `.toc-zone-black`)
- SR% progress bar track and fill colors
- Dashboard-specific layout: summary cards grid, priority table header styling
- Mobile-responsive breakpoints for the TOC Dashboard page
- Print format zone color utilities

---

## images/

| File | Used In |
|------|---------|
| `chaizup_toc_logo.svg` | `hooks.py → app_logo_url`, apps home screen tile |
| `chaizup_toc_logo_white.svg` | Navbar (dark mode) |
| `chaizup_toc_icon.svg` | App tile icon (fallback) |
