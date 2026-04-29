// =============================================================================
// CONTEXT: TOC Item Settings — Bulk Configuration Dashboard JS Controller.
//   Renders a filterable item grid; click any row to open a modal with the
//   full TOC settings (same fields as Item Master TOC tab) plus rich help.
// MEMORY: app_chaizup_toc.md § TOC Item Settings Page
// INSTRUCTIONS:
//   - All server calls: chaizup_toc.chaizup_toc.page.toc_item_settings.*
//   - _esc(): inline HTML escape — do NOT use frappe.dom.escape (unreliable).
//   - Grid rows: 8 columns matching 8 <th> in HTML (no index col in header).
//   - autoDetectSettings(): single-item read-only detection, sets DOM only.
//   - bulkAutoEnable(): calls bulk_auto_configure_toc — WRITES to DB for all
//     selected items. Shows result table in frappe.msgprint dialog.
//   - Warehouses loaded on page load via get_warehouses() into this.warehouses[].
//     _buildRuleRow() renders a native <select> from that array.
//   - saveModal sends toc_data as plain JS object — Python frappe.parse_json
//     handles both string and dict forms.
// DANGER ZONE:
//   - Never put raw single quotes in onclick/oninput inside .html template.
//     In JS-generated innerHTML it is fine (not Frappe-template-cached).
//   - canWrite gate is JS-side UX only — real security is frappe.only_for()
//     in save_item_toc_settings and bulk_auto_configure_toc (Python).
//   - bulkAutoEnable calls doc.save() on the server per item — slow on large
//     selections. Warn user if > 50 items selected.
// RESTRICT:
//   - Do NOT skip on_item_validate (Python). It fires via doc.save().
//   - Do NOT remove frappe.only_for() guard from Python bulk methods.
//   - Do NOT merge tabs into single scroll — tab structure is intentional.
//   - bulkAutoEnable must NEVER overwrite existing buffer rules (Python
//     guard: only appends rules when custom_toc_buffer_rules is empty).
// =============================================================================

const HELP_CONTENT = {
  toc_enabled: {
    title: "Enable TOC Buffer Management",
    formula: "Master Switch",
    body: "Activates Theory of Constraints (TOC) buffer management for this item. Once enabled, the system monitors stock levels against target buffers and triggers replenishment when stock falls into the Red Zone (&lt;33% of target).",
    example: "Buffer target = 100 units. Stock drops to 25 units (25%) → Red Zone → system creates a Purchase or Work Order automatically.",
    importance: "critical",
    importance_text: "Must be ON for the item to appear on TOC dashboards and be included in auto-replenishment runs."
  },
  auto_purchase: {
    title: "Auto Purchase Mode",
    formula: "Replenishment Mode → Purchase Order",
    body: "Sets this item to be replenished by purchasing from an external supplier. When buffer enters the Red Zone, a Purchase Material Request is automatically raised.",
    example: "Use for: Raw Materials (RM), Packaging Materials (PM), spare parts, or any item you buy rather than make.",
    importance: "high",
    importance_text: "Cannot be ON at the same time as Auto Manufacture. Select only one replenishment mode."
  },
  auto_manufacture: {
    title: "Auto Manufacture Mode",
    formula: "Replenishment Mode → Production Plan + Work Order",
    body: "Sets this item to be replenished by in-house manufacturing. When the buffer enters the Red Zone, a Production Plan and Work Order are automatically created.",
    example: "Use for: Finished Goods (FG), Semi-Finished Goods (SFG), or any item you produce in your factory.",
    importance: "high",
    importance_text: "Cannot be ON at the same time as Auto Purchase. Select only one replenishment mode."
  },
  custom_adu: {
    title: "Set ADU Manually",
    formula: "Locks ADU — disables overnight auto-calculation",
    body: "Normally the system calculates Average Daily Usage (ADU) automatically from sales and consumption history each night. Check this to lock in your own value and prevent it from being overwritten.",
    example: "Use for: new items with no sales history, seasonal products, or when you have a known future demand forecast.",
    importance: "medium",
    importance_text: "When unchecked, the scheduler updates ADU every night from real consumption data. Leave unchecked for most items."
  },
  adu_period: {
    title: "ADU Lookback Period",
    formula: "Rolling window for auto-calculation",
    body: "How far back in time the system looks when calculating your Average Daily Usage. A longer period smooths out demand spikes; a shorter period responds faster to recent trends.",
    example: "Last 90 Days is recommended for most items. Use Last 30 Days for fast-moving items with rapidly changing demand.",
    importance: "medium",
    importance_text: "Only relevant when Manual ADU Override is OFF. Has no effect if you locked ADU manually."
  },
  adu_value: {
    title: "ADU — Average Daily Usage",
    formula: "F1: Target Buffer = ADU × RLT × VF",
    body: "The average number of units consumed or sold each day. This is the single most important input — every buffer size is calculated from this number. A higher ADU creates a larger buffer.",
    example: "You sell 10 units/day. RLT = 14 days, VF = 1.5 → Target = 10 × 14 × 1.5 = 210 units in the warehouse.",
    importance: "critical",
    importance_text: "Keep this accurate. All buffer targets are multiplied from this value — wrong ADU = wrong buffers."
  },
  selling_price: {
    title: "Selling Price",
    formula: "F5: T/CU = (Selling Price − TVC) × Speed",
    body: "The price at which this item is sold to customers. Used to calculate T/CU (Throughput per Constraint Unit) — your production priority score. Higher selling price → higher priority.",
    example: "Price = ₹500, TVC = ₹200, Speed = 2 units/min → T/CU = (500 − 200) × 2 = 600. This item will be produced before items with lower T/CU.",
    importance: "medium",
    importance_text: "Used only for production prioritization. Does not affect buffer sizing."
  },
  tvc: {
    title: "TVC — Truly Variable Cost",
    formula: "F5: T/CU = (Price − TVC) × Speed",
    body: "The direct material cost per unit. Include raw materials and packaging ONLY. Do NOT include labor, machine depreciation, electricity, or factory overhead — those are fixed costs.",
    example: "Product uses ₹150 of raw materials + ₹50 packaging = TVC of ₹200. Salary of the operator making it is NOT included.",
    importance: "medium",
    importance_text: "Including fixed costs as TVC will understate T/CU and incorrectly lower this item's priority."
  },
  constraint_speed: {
    title: "Constraint Speed",
    formula: "F5: T/CU = (Price − TVC) × Speed (units/min)",
    body: "How many units of this item your bottleneck machine or resource can produce per minute. Items that run faster on the constraint generate more throughput per minute of constrained time.",
    example: "Your bottleneck packing line handles 3 units/min for this item → Speed = 3. An item at 1 unit/min on the same machine gets lower priority even if its margin is similar.",
    importance: "medium",
    importance_text: "Items running faster on the constraint get scheduled first to maximize total factory output."
  },
  check_bom_availability: {
    title: "Check Component Availability",
    formula: "Pre-production material check before Work Order creation",
    body: "When enabled, TOC verifies that all sub-components listed in the Bill of Materials (BOM) have sufficient stock before creating a Work Order. If any component is short, the planner is alerted instead of creating a Work Order that cannot be completed.",
    example: "BOM needs 10 kg of Material A. Only 3 kg in stock → Work Order blocked, planner gets an alert to arrange material first.",
    importance: "low",
    importance_text: "Recommended for complex BOMs or high-value assemblies. Leave OFF for simple items to avoid unnecessary blocks."
  },
  rlt: {
    title: "RLT — Replenishment Lead Time",
    formula: "F1: Target Buffer = ADU × RLT × VF",
    body: "The total number of days from when a replenishment order is placed until the stock is available and ready to use in this warehouse. Includes: supplier lead time + transit + receiving + inspection.",
    example: "Supplier ships in 7 days + 2 days transit + 1 day receiving = RLT of 10 days. With ADU=10, VF=1.5 → Target = 10 × 10 × 1.5 = 150 units.",
    importance: "critical",
    importance_text: "Always use realistic (worst-case) lead times, not best-case. Longer RLT = larger buffer needed."
  },
  vf: {
    title: "VF — Variability Factor",
    formula: "F1: Target Buffer = ADU × RLT × VF (multiplier)",
    body: "A multiplier added on top of the base buffer to absorb unexpected demand spikes or supply delays. VF = 1.0 means no extra buffer; VF = 2.0 doubles the buffer to handle high uncertainty.",
    example: "Stable item with reliable supplier: VF = 1.2. Seasonal product with unpredictable demand: VF = 2.0. Standard starting point for most items: VF = 1.5.",
    importance: "high",
    importance_text: "Start at 1.5 for most items. Increase if the item frequently runs out; decrease if the warehouse is always overstocked."
  },
  daf: {
    title: "DAF — Demand Adjustment Factor",
    formula: "Adjusted Buffer = Target Buffer × DAF",
    body: "A temporary multiplier to adjust the buffer for known upcoming demand changes — promotions, festivals, planned shutdowns, or slow seasons. Multiply by more than 1 to increase buffer; less than 1 to reduce it.",
    example: "Diwali season coming → DAF = 1.4 (40% more stock). Lean quarter → DAF = 0.7 (30% less). Normal operations → DAF = 1.0 (no change).",
    importance: "low",
    importance_text: "Leave at 1.0 for normal operations. Use temporarily when you know demand is about to shift significantly."
  }
};

const tisPage = {
  current: 0,
  pageLength: 50,
  total: 0,
  next() { if ((this.current + 1) * this.pageLength < this.total) { this.current++; tisApp.load(); } },
  prev() { if (this.current > 0) { this.current--; tisApp.load(); } },
  reset() { this.current = 0; }
};

frappe.pages["toc-item-settings"].on_page_load = function (wrapper) {
  if (wrapper.tis_initialized) return;
  wrapper.tis_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "TOC Item Settings",
    single_column: true,
  });

  page.add_field({
    fieldname: "toc_filter",
    label: __("TOC Status"),
    fieldtype: "Select",
    options: ["All", "Active", "Inactive"].join("\n"),
    default: "All",
    change() { tisPage.reset(); if (window.tisApp) tisApp.clearSelection(); tisApp.load(); },
  });
  page.add_field({
    fieldname: "item_group",
    label: __("Item Group"),
    fieldtype: "Link",
    options: "Item Group",
    change() { tisPage.reset(); if (window.tisApp) tisApp.clearSelection(); tisApp.load(); },
  });
  page.add_field({
    fieldname: "search",
    label: __("Search"),
    fieldtype: "Data",
    change() { tisPage.reset(); if (window.tisApp) tisApp.clearSelection(); tisApp.load(); },
  });

  page.add_menu_item(__("TOC Dashboard"), () => frappe.set_route("toc-dashboard"));
  page.add_menu_item(__("TOC Settings"), () => frappe.set_route("Form", "TOC Settings", "TOC Settings"));

  $(frappe.render_template("toc_item_settings", {})).appendTo(page.body);

  window.tisApp = new TOCItemSettings(page);
  tisApp.load();
};

class TOCItemSettings {
  constructor(page) {
    this.page = page;
    this.currentItem = null;
    this.currentData = null;
    this.canWrite = frappe.user.has_role(["System Manager", "TOC Manager"]);
    this.selectedItems = new Set();
    this.warehouses = [];
    this._loadWarehouses();
  }

  _loadWarehouses() {
    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.get_warehouses",
      callback: (r) => { if (r.message) this.warehouses = r.message; }
    });
  }

  load() {
    const f = this.page.fields_dict;
    const tbody = document.getElementById("tis-tbody");
    tbody.innerHTML = `<tr class="tis-spinner-row"><td colspan="8" style="text-align:center; padding: 40px"><div class="tis-spinner"></div> Loading...</td></tr>`;

    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.get_items_for_bulk_settings",
      args: {
        toc_filter: f.toc_filter.get_value() || "All",
        item_group: f.item_group.get_value() || null,
        search: f.search.get_value() || null,
        page_length: tisPage.pageLength,
        page_start: tisPage.current * tisPage.pageLength,
      },
      callback: (r) => {
        if (r.message) {
          tisPage.total = r.message.total || 0;
          this._renderGrid(r.message.items || []);
          this._updateStats();
        }
      }
    });
  }

  _renderGrid(items) {
    const tbody = document.getElementById("tis-tbody");
    const countEl = document.getElementById("tis-count-label");

    if (!items.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:50px 20px;color:var(--tis-muted)">
        <div style="font-size:28px;margin-bottom:8px">📦</div>
        <div style="font-weight:600">No items found</div>
        <div style="font-size:12px;margin-top:4px">Adjust the filters above</div>
      </td></tr>`;
      if (countEl) countEl.textContent = "0 items";
      this._updatePagination();
      return;
    }

    const startIdx = tisPage.current * tisPage.pageLength;
    tbody.innerHTML = items.map((item, i) => {
      const isChecked = this.selectedItems.has(item.item_code);
      // Use data-code attr for row identification; escape for onclick with &quot;
      const codeAttr = this._esc(item.item_code);
      return `<tr class="${isChecked ? "tis-selected" : ""}" data-code="${codeAttr}"
                  onclick="tisApp.openModal(&quot;${codeAttr}&quot;)">
        <td onclick="event.stopPropagation()" style="text-align:center">
          <input type="checkbox" class="tis-row-check"
            ${isChecked ? "checked" : ""}
            onclick="event.stopPropagation()"
            onchange="tisApp.selectRow(&quot;${codeAttr}&quot;, this.checked)">
        </td>
        <td>
          <div style="font-weight:600;font-size:13px">${this._esc(item.item_code)}</div>
          <div style="font-size:11px;color:var(--tis-muted)">${this._esc(item.item_name || "")}</div>
        </td>
        <td style="font-size:12px;color:var(--tis-muted)">${this._esc(item.item_group || "")}</td>
        <td><span class="tis-badge ${item.toc_enabled ? "tis-badge-active" : "tis-badge-inactive"}">${item.toc_enabled ? "&#10003; Active" : "&#8212; Inactive"}</span></td>
        <td>${this._modeBadge(item)}</td>
        <td style="font-size:12px">${parseFloat(item.adu_value || 0).toFixed(2)}</td>
        <td style="font-size:12px">${item.buffer_rules_count > 0
          ? `<span style="color:#2563eb;font-weight:600">${item.buffer_rules_count} wh</span>`
          : `<span style="color:#fca5a5;font-size:11px">None</span>`}</td>
        <td style="text-align:right">
          <button class="btn btn-xs btn-default" onclick="event.stopPropagation(); tisApp.openModal(&quot;${codeAttr}&quot;)">
            Edit ✎
          </button>
        </td>
      </tr>`;
    }).join("");

    if (countEl) countEl.textContent = `${tisPage.total.toLocaleString()} items`;
    this._updatePagination();
  }

  _modeBadge(item) {
    if (item.auto_purchase) return `<span class="tis-badge tis-badge-purchase">Purchase</span>`;
    if (item.auto_manufacture) return `<span class="tis-badge tis-badge-manufacture">Manufacture</span>`;
    return `<span class="tis-badge" style="background:var(--tis-bg); color:var(--tis-muted)">Monitor</span>`;
  }

  _updatePagination() {
    const info = document.getElementById("tis-page-info");
    if (info) info.textContent = `${tisPage.current * tisPage.pageLength + 1} - ${Math.min((tisPage.current + 1) * tisPage.pageLength, tisPage.total)} of ${tisPage.total}`;
    
    const prev = document.getElementById("tis-btn-prev");
    const next = document.getElementById("tis-btn-next");
    if (prev) prev.disabled = (tisPage.current === 0);
    if (next) next.disabled = ((tisPage.current + 1) * tisPage.pageLength >= tisPage.total);
  }

  _updateStats() {
    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.get_items_for_bulk_settings",
      args: { page_length: 9999, page_start: 0 },
      callback: (r) => {
        if (r.message) {
          const items = r.message.items || [];
          document.getElementById("tis-stat-total").textContent = items.length;
          document.getElementById("tis-stat-active").textContent = items.filter(i => i.toc_enabled).length;
          document.getElementById("tis-stat-inactive").textContent = items.filter(i => !i.toc_enabled).length;
          document.getElementById("tis-stat-manufacture").textContent = items.filter(i => i.auto_manufacture).length;
          document.getElementById("tis-stat-purchase").textContent = items.filter(i => i.auto_purchase).length;
        }
      }
    });
  }

  openModal(itemCode) {
    // itemCode arrives HTML-decoded (browser resolves &quot; → ") — use as-is
    this.currentItem = itemCode;
    this._showModal();
    document.getElementById("tis-modal-item-name").textContent = "Loading...";
    document.getElementById("tis-modal-item-meta").textContent = "";
    document.getElementById("tis-save-status").textContent = "";

    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.get_item_toc_details",
      args: { item_code: itemCode },
      callback: (r) => { if (r.message) this._populateModal(r.message); }
    });
  }

  _populateModal(data) {
    this.currentData = data;
    document.getElementById("tis-modal-item-name").textContent = data.item_name || data.item_code;
    document.getElementById("tis-modal-item-meta").textContent = `${data.item_code} | ${data.item_group} | ${data.stock_uom}`;
    this._renderTabs(data);
    this.switchTab("enable", document.querySelector('[data-tab="enable"]'));
  }

  _renderTabs(data) {
    document.getElementById("tis-tab-enable").innerHTML = this._buildEnableTab(data);
    document.getElementById("tis-tab-adu").innerHTML = this._buildAduTab(data);
    document.getElementById("tis-tab-tcu").innerHTML = this._buildTcuTab(data);
    document.getElementById("tis-tab-bom").innerHTML = this._buildBomTab(data);
    document.getElementById("tis-tab-rules").innerHTML = this._buildRulesTab(data);
  }

  _buildEnableTab(d) {
    return `
      <div style="border-bottom:1px solid var(--tis-border); padding-bottom:16px; margin-bottom:24px; display:flex; justify-content:space-between; align-items:center">
        <div>
          <h6 style="margin:0">Setup — TOC Enable &amp; Replenishment Mode</h6>
          <p class="text-muted" style="font-size:12px; margin:4px 0 0">Turn on TOC and choose how this item is replenished</p>
        </div>
        <button class="btn btn-xs btn-primary" id="tis-auto-detect-btn" onclick="tisApp.autoDetectSettings()" title="Automatically detect the replenishment mode and selling price from this item's history">
          &#9889; Auto-Detect Settings
        </button>
      </div>
      <div id="tis-auto-detect-result" style="display:none; margin-bottom:20px"></div>
      <div class="tis-field-row">
        <div class="tis-field tis-full">
          <div class="tis-check-row">
            <input type="checkbox" id="f-toc-enabled" class="tis-check" ${d.toc_enabled ? "checked" : ""}>
            <label for="f-toc-enabled" style="font-weight:600; margin:0; cursor:pointer; font-size:14px">Enable TOC Buffer Management for this Item</label>
            <button class="btn btn-link btn-xs" onclick="tisApp.showHelp('toc_enabled')">ⓘ</button>
          </div>
          <p class="text-muted" style="font-size:11px; margin: 4px 0 0 28px">Must be ON for this item to appear on TOC dashboards and be included in auto-replenishment.</p>
        </div>
      </div>
      <div style="background:var(--control-bg,#f8fafc); border:1px solid var(--tis-border); border-radius:8px; padding:14px 16px; margin:16px 0; font-size:12px; color:var(--tis-muted)">
        <strong style="color:var(--tis-text)">Replenishment Mode</strong> — Choose how this item is restocked when the buffer runs low. Select exactly one:
      </div>
      <div class="tis-field-row">
        <div class="tis-field">
          <div style="border:1px solid var(--tis-border); border-radius:8px; padding:14px; cursor:pointer;" onclick="document.getElementById('f-auto-purchase').click()">
            <div class="tis-check-row" style="margin-bottom:6px">
              <input type="checkbox" id="f-auto-purchase" class="tis-check" ${d.auto_purchase ? "checked" : ""} onchange="tisApp.onPurchaseChange(this.checked)">
              <label for="f-auto-purchase" style="margin:0; cursor:pointer; font-weight:600; font-size:13px">Auto Purchase</label>
              <button class="btn btn-link btn-xs" onclick="event.stopPropagation(); tisApp.showHelp('auto_purchase')">ⓘ</button>
            </div>
            <p class="text-muted" style="font-size:11px; margin: 0 0 0 26px; line-height:1.5">Item is sourced externally. Low buffer → Purchase Order raised automatically.<br><em>Use for: Raw Materials, Packaging, Traded goods</em></p>
          </div>
        </div>
        <div class="tis-field">
          <div style="border:1px solid var(--tis-border); border-radius:8px; padding:14px; cursor:pointer;" onclick="document.getElementById('f-auto-manufacture').click()">
            <div class="tis-check-row" style="margin-bottom:6px">
              <input type="checkbox" id="f-auto-manufacture" class="tis-check" ${d.auto_manufacture ? "checked" : ""} onchange="tisApp.onManufactureChange(this.checked)">
              <label for="f-auto-manufacture" style="margin:0; cursor:pointer; font-weight:600; font-size:13px">Auto Manufacture</label>
              <button class="btn btn-link btn-xs" onclick="event.stopPropagation(); tisApp.showHelp('auto_manufacture')">ⓘ</button>
            </div>
            <p class="text-muted" style="font-size:11px; margin: 0 0 0 26px; line-height:1.5">Item is produced in-house. Low buffer → Production Plan + Work Order created automatically.<br><em>Use for: Finished Goods, Semi-Finished Goods</em></p>
          </div>
        </div>
      </div>`;
  }

  _buildAduTab(d) {
    const uom = this._esc(d.stock_uom || "units");
    return `
      <div style="border-bottom:1px solid var(--tis-border); padding-bottom:16px; margin-bottom:24px">
        <h6 style="margin:0">ADU — Average Daily Usage</h6>
        <p class="text-muted" style="font-size:12px; margin:4px 0 0">How much of this item is consumed or sold per day · Formula F1: <strong>Target Buffer = ADU × RLT × VF</strong></p>
      </div>
      <div class="tis-field-row">
        <div class="tis-field tis-full">
          <div class="tis-check-row">
            <input type="checkbox" id="f-custom-adu" class="tis-check" ${d.custom_adu ? "checked" : ""} onchange="tisApp.onCustomAduChange(this.checked)">
            <label for="f-custom-adu" style="cursor:pointer; font-weight:500">Set ADU Manually (override auto-calculation)</label>
            <button class="btn btn-link btn-xs" onclick="tisApp.showHelp('custom_adu')">ⓘ</button>
          </div>
          <p class="text-muted" style="font-size:11px; margin: 4px 0 0 28px">Uncheck to let the system calculate ADU automatically each night from historical consumption data.</p>
        </div>
        <div class="tis-field">
          <label class="tis-field-label">
            Lookback Period for Auto-Calculation
            <button class="btn btn-link btn-xs" style="padding:0; margin-left:2px" onclick="tisApp.showHelp('adu_period')">ⓘ</button>
          </label>
          <select id="f-adu-period" class="tis-select" ${d.custom_adu ? "disabled" : ""} title="How far back to look when calculating average daily usage automatically">
            ${["Last 30 Days", "Last 90 Days", "Last 180 Days", "Last 365 Days"].map(v => `<option ${d.adu_period === v ? "selected" : ""}>${v}</option>`).join("")}
          </select>
          <p class="text-muted" style="font-size:11px; margin-top:4px">Only active when manual override is OFF</p>
        </div>
        <div class="tis-field">
          <label class="tis-field-label">
            ADU — Average Daily Usage (${uom}/day)
            <button class="btn btn-link btn-xs" style="padding:0; margin-left:2px" onclick="tisApp.showHelp('adu_value')">ⓘ</button>
          </label>
          <input id="f-adu-value" type="number" class="tis-input" value="${d.adu_value || 0}" ${!d.custom_adu ? "readonly" : ""} oninput="tisApp.recalcAllRules()" title="Average units consumed per day — foundation for all buffer calculations">
          <p class="text-muted" style="font-size:11px; margin-top:4px">Units used/sold per day — basis for buffer sizing</p>
        </div>
      </div>`;
  }

  _buildTcuTab(d) {
    const tcu = d.tcu || 0;
    return `
      <div style="border-bottom:1px solid var(--tis-border); padding-bottom:16px; margin-bottom:24px">
        <h6 style="margin:0">T/CU — Throughput per Constraint Unit</h6>
        <p class="text-muted" style="font-size:12px; margin:4px 0 0">Production priority score · Formula F5: <strong>T/CU = (Selling Price − TVC) × Constraint Speed</strong></p>
      </div>
      <div class="tis-field-row">
        <div class="tis-field">
          <label class="tis-field-label">
            Selling Price (₹)
            <button class="btn btn-link btn-xs" style="padding:0; margin-left:2px" onclick="tisApp.showHelp('selling_price')">ⓘ</button>
          </label>
          <input id="f-selling-price" type="number" class="tis-input" value="${d.selling_price || 0}" oninput="tisApp.recalcTcu()" title="Price at which this item is sold to customers">
          <p class="text-muted" style="font-size:11px; margin-top:4px">Customer selling price per unit</p>
        </div>
        <div class="tis-field">
          <label class="tis-field-label">
            TVC — Truly Variable Cost (₹)
            <button class="btn btn-link btn-xs" style="padding:0; margin-left:2px" onclick="tisApp.showHelp('tvc')">ⓘ</button>
          </label>
          <input id="f-tvc" type="number" class="tis-input" value="${d.tvc || 0}" oninput="tisApp.recalcTcu()" title="Direct material cost per unit — raw materials + packaging only, no labor or overhead">
          <p class="text-muted" style="font-size:11px; margin-top:4px">Material cost per unit (raw materials + packaging)</p>
        </div>
        <div class="tis-field">
          <label class="tis-field-label">
            Constraint Speed (units/min)
            <button class="btn btn-link btn-xs" style="padding:0; margin-left:2px" onclick="tisApp.showHelp('constraint_speed')">ⓘ</button>
          </label>
          <input id="f-constraint-speed" type="number" class="tis-input" value="${d.constraint_speed || 0}" oninput="tisApp.recalcTcu()" title="Units produced per minute on the bottleneck machine or resource">
          <p class="text-muted" style="font-size:11px; margin-top:4px">Units/minute on the bottleneck machine</p>
        </div>
        <div class="tis-field">
          <label class="tis-field-label">T/CU — Priority Score</label>
          <div style="font-size:22px; font-weight:700; color:var(--tis-green); padding:6px 0" id="f-tcu-display">&#8377;${tcu.toLocaleString()}</div>
          <p class="text-muted" style="font-size:11px; margin-top:4px">Higher score = higher production priority</p>
        </div>
      </div>
      <div style="background:var(--control-bg,#f8fafc); border:1px solid var(--tis-border); border-radius:8px; padding:14px 16px; font-size:12px; color:var(--tis-muted)">
        <strong style="color:var(--tis-text)">How it works:</strong> T/CU = (Selling Price − TVC) × Constraint Speed<br>
        Items with a higher T/CU score are scheduled on the production line first, maximizing the total revenue generated per minute of constrained machine time.
      </div>`;
  }

  _buildBomTab(d) {
    return `
      <div style="border-bottom:1px solid var(--tis-border); padding-bottom:16px; margin-bottom:24px">
        <h6 style="margin:0">BOM — Bill of Materials</h6>
        <p class="text-muted" style="font-size:12px; margin:4px 0 0">Component availability check for manufactured items</p>
      </div>
      <div style="background:var(--control-bg,#eff6ff); border:1px solid #bfdbfe; border-radius:8px; padding:14px 16px; margin-bottom:24px; font-size:13px; display:flex; gap:12px; align-items:flex-start;">
        <span style="font-size:18px; line-height:1.2; flex-shrink:0">ℹ</span>
        <div>
          <strong>BOM is detected automatically by the TOC engine.</strong><br>
          <span class="text-muted" style="font-size:12px">When TOC triggers a Production Plan, it automatically fetches the <em>active default BOM</em> for this item from the BOM database. You do not need to select it manually here.</span>
        </div>
      </div>
      <div class="tis-field-row">
        <div class="tis-field tis-full">
          <div class="tis-check-row">
            <input type="checkbox" id="f-check-bom" class="tis-check" ${d.check_bom_availability ? "checked" : ""}>
            <label for="f-check-bom" style="cursor:pointer; font-weight:500">Check Component Availability Before Creating Work Order</label>
            <button class="btn btn-link btn-xs" onclick="tisApp.showHelp('check_bom_availability')">ⓘ</button>
          </div>
          <p class="text-muted" style="font-size:11px; margin: 6px 0 0 28px">When checked, TOC verifies that all sub-components listed in the BOM have sufficient stock before creating a Work Order. If any component is short, the planner is alerted.</p>
        </div>
      </div>`;
  }

  _buildRulesTab(d) {
    return `
      <div style="border-bottom:1px solid var(--tis-border); padding-bottom:16px; margin-bottom:20px">
        <h6 style="margin:0">Warehouse Buffer Rules</h6>
        <p class="text-muted" style="font-size:12px; margin:4px 0 0">Set the replenishment parameters for each warehouse where this item is stocked · Formula: <strong>Target = ADU × RLT × VF</strong></p>
      </div>
      <div class="tis-rules-wrap">
        <table class="table table-bordered table-condensed" style="font-size:12px">
          <thead>
            <tr>
              <th style="min-width:160px">Warehouse</th>
              <th style="min-width:90px">
                RLT (days)
                <button class="btn btn-link btn-xs" style="padding:0; font-size:10px; vertical-align:middle" onclick="tisApp.showHelp('rlt')">ⓘ</button>
                <div style="font-weight:400; font-size:10px; color:var(--tis-muted)">Lead Time</div>
              </th>
              <th style="min-width:70px">
                VF
                <button class="btn btn-link btn-xs" style="padding:0; font-size:10px; vertical-align:middle" onclick="tisApp.showHelp('vf')">ⓘ</button>
                <div style="font-weight:400; font-size:10px; color:var(--tis-muted)">Variability</div>
              </th>
              <th style="min-width:80px">
                Target
                <div style="font-weight:400; font-size:10px; color:var(--tis-muted)">ADU×RLT×VF</div>
              </th>
              <th style="min-width:70px">
                DAF
                <button class="btn btn-link btn-xs" style="padding:0; font-size:10px; vertical-align:middle" onclick="tisApp.showHelp('daf')">ⓘ</button>
                <div style="font-weight:400; font-size:10px; color:var(--tis-muted)">Demand Adj.</div>
              </th>
              <th style="min-width:60px">Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="tis-rules-body">
            ${(d.buffer_rules || []).map((r, i) => this._buildRuleRow(r, i)).join("")}
          </tbody>
        </table>
        <button class="btn btn-xs btn-default" style="margin-top:10px" onclick="tisApp.addRuleRow()">+ Add Warehouse Rule</button>
      </div>`;
  }

  _buildRuleRow(r, i) {
    const adu_el = document.getElementById("f-adu-value");
    const adu = adu_el ? (parseFloat(adu_el.value) || 0) : (this.currentData ? this.currentData.adu_value : 0);
    const target = Math.round(adu * (r.rlt || 7) * (r.variability_factor || 1.5));
    const currentWh = r.warehouse || "";
    const whInList = (this.warehouses || []).some(w => w.name === currentWh);
    // Preserve saved warehouse even if not in current list (e.g. disabled warehouse)
    let whOptions = '<option value="">— Select Warehouse —</option>';
    if (currentWh && !whInList) {
      whOptions += `<option value="${this._esc(currentWh)}" selected>${this._esc(currentWh)}</option>`;
    }
    whOptions += (this.warehouses || []).map(w =>
      `<option value="${this._esc(w.name)}" ${w.name === currentWh ? "selected" : ""}>${this._esc(w.name)}</option>`
    ).join("");
    return `<tr data-idx="${i}">
      <td><select class="tis-rule-input" name="wh" title="Storage location for this buffer rule">${whOptions}</select></td>
      <td><input class="tis-rule-input" type="number" name="rlt" value="${r.rlt || 7}" title="Days to replenish: order placed → stock available" oninput="tisApp.recalcRuleRow(this)"></td>
      <td><input class="tis-rule-input" type="number" name="vf" value="${r.variability_factor || 1.5}" title="Variability multiplier: 1.0 = no extra buffer, 1.5 = standard, 2.0 = high variability" oninput="tisApp.recalcRuleRow(this)"></td>
      <td><input class="tis-rule-input" readonly name="target" style="background:var(--tis-bg); font-weight:600; color:var(--tis-primary)" value="${target}" title="Target Buffer = ADU × RLT × VF (auto-calculated)"></td>
      <td><input class="tis-rule-input" type="number" name="daf" value="${r.daf || 1.0}" title="Demand Adjustment Factor: 1.0 = normal, >1.0 = increase buffer, <1.0 = reduce buffer"></td>
      <td style="text-align:center"><input type="checkbox" name="enabled" ${(r.enabled !== undefined ? r.enabled : true) ? "checked" : ""} title="Enable or disable this warehouse buffer rule"></td>
      <td><button class="btn btn-xs btn-link text-danger" onclick="this.closest('tr').remove()" title="Remove this warehouse rule">&times;</button></td>
    </tr>`;
  }

  addRuleRow() {
    const tbody = document.getElementById("tis-rules-body");
    const row = document.createElement("tr");
    row.innerHTML = this._buildRuleRow({}, tbody.children.length);
    tbody.appendChild(row);
  }

  recalcRuleRow(el) {
    const tr = el.closest("tr");
    const adu_el = document.getElementById("f-adu-value");
    const adu = adu_el ? (parseFloat(adu_el.value) || 0) : (this.currentData ? this.currentData.adu_value : 0);
    const rlt = parseFloat(tr.querySelector('[name="rlt"]').value) || 0;
    const vf = parseFloat(tr.querySelector('[name="vf"]').value) || 0;
    tr.querySelector('[name="target"]').value = Math.round(adu * rlt * vf);
  }

  recalcAllRules() {
    document.querySelectorAll("#tis-rules-body tr").forEach(tr => this.recalcRuleRow(tr.querySelector('[name="rlt"]')));
  }

  recalcTcu() {
    const price = parseFloat(document.getElementById("f-selling-price")?.value) || 0;
    const tvc = parseFloat(document.getElementById("f-tvc")?.value) || 0;
    const speed = parseFloat(document.getElementById("f-constraint-speed")?.value) || 0;
    const tcu = speed > 0 ? Math.round((price - tvc) * speed * 100) / 100 : 0;
    const el = document.getElementById("f-tcu-display");
    if (el) el.textContent = "₹" + tcu.toLocaleString();
  }

  autoDetectSettings() {
    const btn = document.getElementById("tis-auto-detect-btn");
    btn.disabled = true;
    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.auto_detect_toc_settings",
      args: { item_code: this.currentItem },
      callback: (r) => {
        btn.disabled = false;
        if (r.message) {
          const m = r.message;
          const res = document.getElementById("tis-auto-detect-result");
          res.style.display = "block";
          res.innerHTML = `<div style="background:var(--control-bg, #f0fdf4); border:1px solid var(--tis-green); border-radius:8px; padding:12px; font-size:12px;">
            <strong>Suggested:</strong> ${m.mode} mode (${m.mode_reason})<br>
            <strong>Suggested Price:</strong> ₹${m.selling_price.toLocaleString()} (${m.price_source})
          </div>`;
          if (m.mode === "Purchase") this.onPurchaseChange(true);
          else if (m.mode === "Manufacture") this.onManufactureChange(true);
          document.getElementById("f-selling-price").value = m.selling_price;
          this.recalcTcu();
        }
      }
    });
  }

  switchTab(tabId, btn) {
    document.querySelectorAll(".tis-tab-pane").forEach(p => p.classList.remove("tis-active"));
    document.querySelectorAll(".tis-modal-tab").forEach(b => b.classList.remove("tis-tab-active"));
    const pane = document.getElementById(`tis-tab-${tabId}`);
    if (pane) pane.classList.add("tis-active");
    if (btn) btn.classList.add("tis-tab-active");
    // Reset help
    document.getElementById("tis-help-default").style.display = "block";
    document.getElementById("tis-help-content").innerHTML = "";
  }

  showHelp(key) {
    const c = HELP_CONTENT[key];
    if (!c) return;
    document.getElementById("tis-help-default").style.display = "none";
    const exampleHtml = c.example
      ? `<div style="background:var(--control-bg,#f0fdf4); border-left:3px solid var(--tis-green); padding:10px 12px; font-size:11px; margin-top:12px; line-height:1.5"><strong>Example:</strong> ${c.example}</div>`
      : "";
    document.getElementById("tis-help-content").innerHTML = `
      <h6 style="color:var(--tis-primary); margin-bottom:8px; font-size:13px">${c.title}</h6>
      <span class="label label-blue" style="font-size:10px">${c.formula}</span>
      <p style="margin-top:12px; line-height:1.6; font-size:12px">${c.body}</p>
      ${exampleHtml}
      <div style="background:var(--tis-bg); border-left:3px solid var(--tis-primary); padding:10px 12px; font-size:11px; margin-top:12px; line-height:1.5">${c.importance_text}</div>`;
  }

  onPurchaseChange(val) { 
    document.getElementById("f-auto-purchase").checked = val;
    if (val) document.getElementById("f-auto-manufacture").checked = false; 
  }
  onManufactureChange(val) { 
    document.getElementById("f-auto-manufacture").checked = val;
    if (val) document.getElementById("f-auto-purchase").checked = false; 
  }
  onCustomAduChange(val) { document.getElementById("f-adu-period").disabled = val; document.getElementById("f-adu-value").readOnly = !val; }

  saveModal() {
    if (!this.canWrite) { frappe.msgprint("You do not have permission to save settings."); return; }
    const btn = document.getElementById("tis-save-btn");
    btn.disabled = true;
    const adu_val = parseFloat(document.getElementById("f-adu-value").value) || 0;
    const data = {
      toc_enabled: document.getElementById("f-toc-enabled").checked ? 1 : 0,
      auto_purchase: document.getElementById("f-auto-purchase").checked ? 1 : 0,
      auto_manufacture: document.getElementById("f-auto-manufacture").checked ? 1 : 0,
      custom_adu: document.getElementById("f-custom-adu").checked ? 1 : 0,
      adu_period: document.getElementById("f-adu-period").value,
      adu_value: adu_val,
      selling_price: parseFloat(document.getElementById("f-selling-price").value) || 0,
      tvc: parseFloat(document.getElementById("f-tvc").value) || 0,
      constraint_speed: parseFloat(document.getElementById("f-constraint-speed").value) || 0,
      check_bom_availability: document.getElementById("f-check-bom").checked ? 1 : 0,
      buffer_rules: Array.from(document.querySelectorAll("#tis-rules-body tr")).map(row => ({
        warehouse: row.querySelector("[name=wh]").value,
        rlt: parseFloat(row.querySelector("[name=rlt]").value),
        variability_factor: parseFloat(row.querySelector("[name=vf]").value),
        daf: parseFloat(row.querySelector("[name=daf]").value),
        enabled: row.querySelector("[name=enabled]").checked ? 1 : 0,
        adu: adu_val
      })).filter(r => r.warehouse)
    };
    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.save_item_toc_settings",
      args: { item_code: this.currentItem, toc_data: data },
      callback: (r) => {
        btn.disabled = false;
        if (r.message && r.message.status === "ok") { 
          frappe.show_alert({message: __("Settings saved"), indicator: 'green'});
          this.closeModal(); 
          this.load(); 
        } 
      }
    });
  }

  _showModal() { document.getElementById("tis-modal-backdrop").classList.add("tis-open"); }
  closeModal() { document.getElementById("tis-modal-backdrop").classList.remove("tis-open"); }
  handleBackdropClick(e) { if (e.target.id === "tis-modal-backdrop") this.closeModal(); }

  selectRow(code, checked) {
    // code arrives as the HTML-decoded string (browser unescapes &quot; → ")
    if (checked) this.selectedItems.add(code); else this.selectedItems.delete(code);
    this._updateBulkBar();
    const tr = document.querySelector(`#tis-tbody tr[data-code="${this._esc(code)}"]`);
    if (tr) tr.classList.toggle("tis-selected", checked);
  }
  selectAll(checked) { 
    document.querySelectorAll("#tis-tbody input[type=checkbox]").forEach(cb => {
      cb.checked = checked;
      const tr = cb.closest("tr");
      if (!tr) return;
      const code = tr.dataset.code;
      if (checked) this.selectedItems.add(code); else this.selectedItems.delete(code);
      tr.classList.toggle("tis-selected", checked);
    });
    this._updateBulkBar();
  }
  clearSelection() { 
    this.selectedItems.clear(); 
    const chkAll = document.getElementById("tis-check-all");
    if (chkAll) chkAll.checked = false;
    document.querySelectorAll("#tis-tbody tr").forEach(tr => {
      tr.classList.remove("tis-selected");
      const cb = tr.querySelector("input[type=checkbox]");
      if (cb) cb.checked = false;
    });
    this._updateBulkBar(); 
  }
  _updateBulkBar() {
    const bar = document.getElementById("tis-bulk-bar");
    const count = document.getElementById("tis-bulk-count");
    bar.classList.toggle("tis-bulk-visible", this.selectedItems.size > 0);
    count.textContent = `${this.selectedItems.size} items selected`;
  }

  openBulkModal() {
    document.getElementById("tis-bulk-subtitle").textContent = `${this.selectedItems.size} items selected`;
    document.getElementById("tis-bulk-backdrop").classList.add("tis-open");
  }
  closeBulkModal() { document.getElementById("tis-bulk-backdrop").classList.remove("tis-open"); }
  handleBulkBackdropClick(e) { if (e.target.id === "tis-bulk-backdrop") this.closeBulkModal(); }
  toggleBulkRow(field, checked) { document.getElementById(`tis-bfr-${field}`).classList.toggle("tis-bulk-apply-on", checked); }

  saveBulk() {
    if (!this.canWrite) { frappe.msgprint("You do not have permission to update settings."); return; }
    const fields = [];
    const data = {};
    if (document.querySelector("#tis-bfr-enable .tis-bulk-apply-chk").checked) {
      fields.push("toc_enabled");
      const rad = document.querySelector("input[name=bulk-enable]:checked");
      data.toc_enabled = rad ? parseInt(rad.value) : 0;
    }
    if (document.querySelector("#tis-bfr-mode .tis-bulk-apply-chk").checked) {
      fields.push("replenishment_mode");
      const rad = document.querySelector("input[name=bulk-mode]:checked");
      data.replenishment_mode = rad ? rad.value : "Monitor";
    }
    if (document.querySelector("#tis-bfr-adu-period .tis-bulk-apply-chk").checked) {
      fields.push("adu_period");
      data.adu_period = document.getElementById("tis-bulk-adu-period").value;
    }
    if (document.querySelector("#tis-bfr-custom-adu .tis-bulk-apply-chk").checked) {
      fields.push("custom_adu");
      const val = document.getElementById("tis-bulk-custom-adu").value;
      data.custom_adu = (val === "" || val === null) ? null : parseFloat(val);
    }
    if (document.querySelector("#tis-bfr-bom-check .tis-bulk-apply-chk").checked) {
      fields.push("check_bom_availability");
      const rad = document.querySelector("input[name=bulk-bom-check]:checked");
      data.check_bom_availability = rad ? parseInt(rad.value) : 1;
    }

    if (!fields.length) { frappe.msgprint("Please select at least one field to apply"); return; }

    const btn = document.getElementById("tis-bulk-save-btn");
    btn.disabled = true;
    frappe.call({
      method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.bulk_save_toc_settings",
      args: { item_codes: Array.from(this.selectedItems), toc_data: data, fields_to_apply: fields },
      callback: (r) => { 
        btn.disabled = false;
        if (r.message && r.message.success) { 
          frappe.show_alert({message: __("Bulk settings applied"), indicator: 'green'});
          this.closeBulkModal(); 
          this.clearSelection(); 
          this.load();
        } 
      }
    });
  }

  openInItemMaster() { if (this.currentItem) frappe.set_route("Form", "Item", this.currentItem); }

  // Safe inline HTML escape — do NOT replace with frappe.dom.escape (not always available).
  _esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // =============================================================================
  // CONTEXT: Bulk Auto-Enable TOC — detect mode + enable + create buffer rules
  //   for all selected items in one server call. Shows per-item result table.
  // INSTRUCTIONS:
  //   - Calls bulk_auto_configure_toc(item_codes) — Python handles detection,
  //     mode assignment, selling price, and buffer rule creation from Bin.
  //   - Warns before proceeding if > 50 items (doc.save() per item is slow).
  //   - Shows spinner dialog while waiting; replaces with result table on done.
  //   - On success: clears selection, refreshes grid.
  // DANGER ZONE:
  //   - This WRITES to the database. canWrite guard must remain.
  //   - Do NOT call from a read-only context (read-only users see disabled btn).
  // RESTRICT:
  //   - Do NOT add any direct frappe.db calls here — all logic is in Python.
  // =============================================================================
  bulkAutoEnable() {
    if (!this.canWrite) {
      frappe.show_alert({ message: __("TOC Manager role required"), indicator: "orange" });
      return;
    }
    const items = Array.from(this.selectedItems);
    if (!items.length) return;

    const proceed = () => {
      const btn = document.getElementById("tis-btn-auto-enable");
      if (btn) { btn.disabled = true; btn.textContent = "Processing..."; }

      frappe.call({
        method: "chaizup_toc.chaizup_toc.page.toc_item_settings.toc_item_settings.bulk_auto_configure_toc",
        args: { item_codes: items },
        callback: (r) => {
          if (btn) { btn.disabled = false; btn.innerHTML = "&#9889; Auto-Enable TOC"; }
          if (!r.message) return;
          this._showAutoEnableResults(r.message);
          if (r.message.updated > 0) {
            this.clearSelection();
            this.load();
          }
        },
        error: () => {
          if (btn) { btn.disabled = false; btn.innerHTML = "&#9889; Auto-Enable TOC"; }
          frappe.show_alert({ message: __("Auto-configure failed — check Error Log"), indicator: "red" });
        },
      });
    };

    if (items.length > 50) {
      frappe.confirm(
        `You are about to auto-configure <strong>${items.length}</strong> items. This may take 1–2 minutes. Proceed?`,
        proceed
      );
    } else {
      proceed();
    }
  }

  _showAutoEnableResults(res) {
    const modeClass = { Purchase: "tis-ae-mode-purchase", Manufacture: "tis-ae-mode-manufacture", Monitor: "tis-ae-mode-monitor" };
    const rows = (res.results || []).map(r => {
      if (r.status === "ok") {
        const modeTag = `<span class="${modeClass[r.mode] || "tis-ae-mode-monitor"}">${this._esc(r.mode)}</span>`;
        const price = r.selling_price > 0 ? "&#8377;" + parseFloat(r.selling_price).toLocaleString("en-IN") : "<span style='color:#94a3b8'>—</span>";
        const rules = r.rules_added > 0
          ? `<span style='color:#059669'>+${r.rules_added} wh</span>`
          : `<span style='color:#94a3b8'>kept</span>`;
        return `<tr>
          <td><strong>${this._esc(r.item_code)}</strong><br><small style='color:#64748b'>${this._esc(r.item_name || "")}</small></td>
          <td>${modeTag}</td>
          <td style='font-size:11px;color:#64748b'>${this._esc(r.mode_reason)}</td>
          <td>${price}</td>
          <td>${rules}</td>
        </tr>`;
      }
      const statusLabel = r.status === "skipped" ? "Skipped" : "Error";
      return `<tr>
        <td><strong>${this._esc(r.item_code)}</strong></td>
        <td colspan="4"><span class="tis-ae-err">${statusLabel}:</span> ${this._esc(r.reason || "unknown")}</td>
      </tr>`;
    }).join("");

    const summaryColor = res.updated === res.total ? "green" : (res.updated > 0 ? "orange" : "red");

    frappe.msgprint({
      title: __(`Auto-Enable TOC — ${res.updated} / ${res.total} items updated`),
      indicator: summaryColor,
      message: `
        <div style="overflow-x:auto; max-height:400px">
          <table class="tis-ae-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Mode</th>
                <th>Detection Reason</th>
                <th>Price</th>
                <th>Buffer Rules</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p style="font-size:11px;color:#64748b;margin-top:8px">
          Buffer rules created from stock locations (Bin). Existing rules are never overwritten.
          Review and adjust RLT / VF per item via the Settings modal.
        </p>`,
    });
  }
}
