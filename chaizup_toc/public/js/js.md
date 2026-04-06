# public/js/ — Client-Side JavaScript Files

Four JavaScript files that extend the Frappe desk UI with TOC-specific behavior. All files are served as static assets after `bench build`.

```
public/js/
├── desk_branding.js       ← Loaded globally on all desk pages
├── item_toc.js            ← Item form: TOC Settings tab behavior
├── material_request_toc.js ← MR form: TOC zone banner and button
└── stock_entry_toc.js     ← Stock Entry form: buffer impact check
```

Loading mechanism via `hooks.py`:

```python
# Loaded on EVERY desk page
app_include_js = ["/assets/chaizup_toc/js/desk_branding.js"]

# Loaded only when that specific DocType form is opened
doctype_js = {
    "Item": "public/js/item_toc.js",
    "Material Request": "public/js/material_request_toc.js",
    "Stock Entry": "public/js/stock_entry_toc.js",
}
```

---

## desk_branding.js — Global Desk Enhancements

Loaded on every Frappe desk page. Three independent features that enhance the global desk experience.

### Feature 1: Zone Color Pills in List Views

Targets any cell with `data-field="zone"` or `data-field="custom_toc_zone"` in Frappe List Views and form-embedded list views.

```javascript
function applyZoneColors() {
    const colorMap = {
        Red:    { bg: "#FADBD8", fg: "#E74C3C" },
        Yellow: { bg: "#FEF9E7", fg: "#F39C12" },
        Green:  { bg: "#D5F5E3", fg: "#27AE60" },
        Black:  { bg: "#D5D8DC", fg: "#2C3E50" },
    };
    
    document.querySelectorAll(
        '[data-field="zone"]:not(.toc-styled), [data-field="custom_toc_zone"]:not(.toc-styled)'
    ).forEach(cell => {
        const zone = cell.textContent.trim();
        const colors = colorMap[zone];
        if (colors) {
            cell.style.background = colors.bg;
            cell.style.color = colors.fg;
            cell.style.padding = "2px 8px";
            cell.style.borderRadius = "4px";
            cell.style.fontWeight = "bold";
            cell.classList.add("toc-styled");   // prevent re-processing
        }
    });
}

// Three trigger points for color application:
// 1. Initial load
applyZoneColors();

// 2. Page navigation (500ms delay for DOM to settle)
$(document).on("page-change", () => setTimeout(applyZoneColors, 500));

// 3. DOM mutations (Frappe renders list rows asynchronously)
const observer = new MutationObserver(applyZoneColors);
observer.observe(document.body, { childList: true, subtree: true });
```

**Why three trigger points?** Frappe renders list rows lazily — they may not exist in the DOM when `page-change` fires. The MutationObserver catches rows that are added after the initial render. The `.toc-styled` class prevents re-applying styles on already-colored cells.

**Zones styled**: All list views showing the `zone` field (TOC Buffer Log list), and `custom_toc_zone` field (Material Request list, Work Order list).

---

### Feature 2: Real-Time Buffer Alerts

Listens for `toc_buffer_alert` events published via Frappe's WebSocket real-time layer.

```javascript
frappe.realtime.on("toc_buffer_alert", function(data) {
    // data = { item_code, item_name, zone, bp_pct, warehouse }
    
    const zoneColors = {
        Red: "red",
        Black: "red",
        Yellow: "orange",
    };
    
    const indicator = zoneColors[data.zone] || "blue";
    const message = `${data.item_name} (${data.item_code}) entered ${data.zone} Zone — BP%: ${data.bp_pct}%`;
    
    frappe.show_alert({
        message: message,
        indicator: indicator,
    }, 10);   // 10-second toast
});
```

**Published by**: `buffer_calculator.check_realtime_alert()` which is called from `on_stock_movement()` (the `after_insert` hook on Stock Ledger Entry).

**Flow**:
```
Stock Entry submitted
  → Stock Ledger Entry created (one per item in the entry)
  → after_insert hook fires: on_stock_movement()
    → recalculates buffer for affected item
    → if new zone is Red/Black: frappe.publish_realtime("toc_buffer_alert", {...})
  → desk_branding.js listener fires: frappe.show_alert(...)
```

**User impact**: Any logged-in user with an active desk session sees the alert immediately when a stock movement causes an item to enter the Red or Black zone. No refresh required.

---

### Feature 3: Keyboard Shortcut — Ctrl+Shift+T

Opens the TOC Buffer Management workspace from anywhere in the desk:

```javascript
document.addEventListener("keydown", function(e) {
    if (e.ctrlKey && e.shiftKey && e.key === "T") {
        e.preventDefault();
        frappe.set_route("Workspaces", "TOC Buffer Management");
    }
});
```

Intended for production supervisors and operations managers who open the TOC dashboard multiple times a day.

---

## item_toc.js — Item Form TOC Tab

Loaded via `doctype_js["Item"]`. Adds behavior to the "TOC Settings" tab on the Item form.

### Form Events

```javascript
frappe.ui.form.on("Item", {
    refresh(frm) {
        _toggle_adu(frm);
        
        if (frm.doc.custom_toc_enabled) {
            // Add TOC button group
            frm.add_custom_button(__("Buffer Status"), () => _show_buffer_status(frm), __("TOC"));
            
            if (frm.doc.custom_toc_default_bom && frm.doc.custom_toc_check_bom_availability) {
                frm.add_custom_button(__("Check BOM"), () => _check_bom(frm), __("TOC"));
            }
            
            frm.add_custom_button(__("Priority Board"), () => {
                frappe.set_route("query-report", "Production Priority Board", {
                    item_code: frm.doc.name
                });
            }, __("TOC"));
        }
    },
    
    custom_toc_custom_adu(frm) {
        _toggle_adu(frm);
    },
    
    // Mutual exclusion: auto_purchase and auto_manufacture cannot both be checked
    custom_toc_auto_purchase(frm) {
        if (frm.doc.custom_toc_auto_purchase) {
            frm.set_value("custom_toc_auto_manufacture", 0);
        }
    },
    custom_toc_auto_manufacture(frm) {
        if (frm.doc.custom_toc_auto_manufacture) {
            frm.set_value("custom_toc_auto_purchase", 0);
        }
    },
    
    // T/CU live calculation: fires on any of the three inputs
    custom_toc_selling_price(frm) { _calc_tcu(frm); },
    custom_toc_tvc(frm)           { _calc_tcu(frm); },
    custom_toc_constraint_speed(frm) { _calc_tcu(frm); },
});
```

### Helper Functions

```javascript
function _toggle_adu(frm) {
    const is_custom = frm.doc.custom_toc_custom_adu;
    frm.set_df_property("custom_toc_adu_value", "read_only", !is_custom);
    frm.set_df_property("custom_toc_adu_period", "hidden", is_custom);
    frm.set_df_property("custom_toc_adu_last_updated", "hidden", is_custom);
}

function _calc_tcu(frm) {
    const price = flt(frm.doc.custom_toc_selling_price);
    const tvc   = flt(frm.doc.custom_toc_tvc);
    const speed = flt(frm.doc.custom_toc_constraint_speed);
    
    if (price > 0 && speed > 0) {
        // T/CU = (Price - TVC) × units per minute on constraint machine
        const tcu = (price - tvc) * speed;
        frm.set_value("custom_toc_tcu", tcu);
    }
}

function _show_buffer_status(frm) {
    frappe.call({
        method: "chaizup_toc.api.toc_api.get_priority_board",
        args: { item_code: frm.doc.name },
        callback(r) {
            if (!r.message || !r.message.length) {
                frappe.msgprint(__("No TOC buffer rules found for this item."));
                return;
            }
            
            const buffer = r.message[0];   // first (usually only) warehouse rule
            frappe.msgprint({
                title: `Buffer Status: ${frm.doc.item_name}`,
                message: `
                    <table class="table table-bordered">
                    <tr><td>Zone</td><td><b>${buffer.zone}</b></td></tr>
                    <tr><td>BP%</td><td>${buffer.bp_pct}%</td></tr>
                    <tr><td>IP</td><td>${buffer.inventory_position}</td></tr>
                    <tr><td>Target</td><td>${buffer.target_buffer}</td></tr>
                    <tr><td>Order Qty</td><td>${buffer.order_qty}</td></tr>
                    <tr><td>BOM Status</td><td>${buffer.sfg_status?.message || "N/A"}</td></tr>
                    </table>
                `
            });
        }
    });
}
```

---

## material_request_toc.js — MR Form

Loaded via `doctype_js["Material Request"]`. Two features: TOC zone banner and a priority board shortcut button.

### TOC Zone Banner

Shown when the MR was auto-generated by TOC (`custom_toc_recorded_by === "By System"`):

```javascript
frappe.ui.form.on("Material Request", {
    refresh(frm) {
        if (frm.doc.custom_toc_recorded_by === "By System") {
            const zone = frm.doc.custom_toc_zone || "Unknown";
            const bp = frm.doc.custom_toc_bp_pct || 0;
            const target = frm.doc.custom_toc_target_buffer || 0;
            const ip = frm.doc.custom_toc_ip || 0;
            
            const zoneColors = {
                Red: "#FADBD8", Yellow: "#FEF9E7",
                Green: "#D5F5E3", Black: "#D5D8DC"
            };
            
            frm.dashboard.add_comment(
                `<b>TOC Auto-Generated MR</b> — Zone: ${zone} | BP%: ${bp}% | 
                 Target: ${target} | IP: ${ip}<br>
                 Formula: BP% = (Target − IP) / Target × 100`,
                zoneColors[zone] || "#eee"
            );
        }
        
        // Always add Priority Board button
        frm.add_custom_button(__("TOC Priority Board"), () => {
            frappe.set_route("query-report", "Production Priority Board");
        }, __("View"));
    }
});
```

**Banner context**: When a procurement officer opens an auto-generated MR, the banner immediately shows why it was created — the zone and BP% at the time the MR was generated. This prevents "why was this MR created?" confusion.

---

## stock_entry_toc.js — Stock Entry Form

Loaded via `doctype_js["Stock Entry"]`. Adds a "Check Buffer Impact" button for draft Stock Entries.

```javascript
frappe.ui.form.on("Stock Entry", {
    refresh(frm) {
        if (frm.doc.docstatus !== 0) return;   // Only on draft entries
        
        frm.add_custom_button(__("Check Buffer Impact"), async () => {
            // Collect all unique item codes from this Stock Entry
            const item_codes = [...new Set(
                (frm.doc.items || []).map(r => r.item_code).filter(Boolean)
            )];
            
            if (!item_codes.length) {
                frappe.show_alert(__("No items in this Stock Entry."));
                return;
            }
            
            // Fetch ALL buffer data (no item filter — get full board)
            const r = await frappe.call({
                method: "chaizup_toc.api.toc_api.get_priority_board",
                args: {}
            });
            
            const all_buffers = r.message || [];
            
            // Filter to only items in this Stock Entry that are TOC-managed
            const relevant = all_buffers.filter(b => item_codes.includes(b.item_code));
            
            if (!relevant.length) {
                frappe.msgprint(__("None of the items in this Stock Entry are TOC-managed."));
                return;
            }
            
            // Build and show table
            const rows = relevant.map(b => `
                <tr>
                    <td>${b.item_code}</td>
                    <td>${b.item_name}</td>
                    <td>${b.zone}</td>
                    <td>${b.bp_pct}%</td>
                    <td>${b.inventory_position}</td>
                </tr>
            `).join("");
            
            frappe.msgprint({
                title: __("Buffer Impact of This Stock Entry"),
                message: `
                    <table class="table table-bordered table-sm">
                    <thead><tr>
                        <th>Item</th><th>Name</th><th>Zone</th><th>BP%</th><th>IP</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                    </table>
                    <small>IP values are current (before this entry is submitted)</small>
                `
            });
        }, __("TOC"));
    }
});
```

**Purpose**: Before submitting a large Stock Entry (e.g., inter-warehouse transfer or write-off), the warehouse manager can see which TOC-managed items will be affected and what their current buffer status is. This prevents accidental reduction of stock for items already in Red zone.

**Bug Fix History**: Originally only showed the first item's buffer. Now fetches all buffers and filters to all item codes in the entry.

---

## Bug History — All Resolved

| Bug | File | Description | Fix |
|-----|------|-------------|-----|
| BUG-003 | `toc_dashboard.js` | `_openMR()` confirm dialog said "[item]" but created MRs for ALL items of that type | Dialog text updated to explicitly state "ALL [type] items" |
| BUG-004 | `toc_dashboard.js` | "Action Now" button visible to Stock User/Purchase Manager without permission for `trigger_manual_run` | Added `frappe.user.has_role()` gate |
| BUG-005 | `toc_dashboard.js` + HTML | "On Hand" column showed `inventory_position` (F2 result) instead of physical `on_hand` | Column now reads `r.on_hand` |
| BUG-010 | `stock_entry_toc.js` | "Check Buffer Impact" only showed first item's buffer | Now fetches all buffers and filters by all item codes in the entry |
| BUG-012 | `toc_dashboard.js` | `_openMR` zone_filter excluded "Black" — stockout items never got MRs from dashboard | `["Red","Black","Yellow"]` in zone_filter; dialog text updated |
