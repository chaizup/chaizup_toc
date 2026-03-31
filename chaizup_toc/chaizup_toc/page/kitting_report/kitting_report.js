/**
 * kitting_report.js — Full Kitting Report Controller
 * Frappe Page · Enterprise Grade
 */

frappe.pages["kitting-report"].on_page_load = function (wrapper) {
  if (wrapper.kit_initialized) return;
  wrapper.kit_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "Full Kitting Report",
    single_column: true,
  });

  // ── Filters ──
  const today = frappe.datetime.nowdate();
  const currMonth = parseInt(today.split("-")[1]);
  const currYear  = parseInt(today.split("-")[0]);

  page.add_field({
    label: __("Company"), fieldname: "company", fieldtype: "Link",
    options: "Company",
    default: frappe.defaults.get_user_default("Company"),
    change() { window.kitReport.load(); },
  });
  page.add_field({
    label: __("Month"), fieldname: "month", fieldtype: "Select",
    options: ["1","2","3","4","5","6","7","8","9","10","11","12"]
      .map((m,i) => `${m}|${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][i]}`)
      .join("\n"),
    default: String(currMonth),
    change() { window.kitReport.load(); },
  });
  page.add_field({
    label: __("Year"), fieldname: "year", fieldtype: "Select",
    options: [currYear-1, currYear, currYear+1].join("\n"),
    default: String(currYear),
    change() { window.kitReport.load(); },
  });
  page.add_field({
    label: __("Type"), fieldname: "buffer_type", fieldtype: "Select",
    options: ["All", "FG", "SFG"].join("\n"), default: "All",
    change() { window.kitReport.load(); },
  });

  // ── Toolbar buttons ──
  page.add_inner_button(__("Refresh"), () => window.kitReport.load())
    .addClass("btn-primary-dark");
  page.add_menu_item(__("TOC Dashboard"), () =>
    frappe.set_route("toc-dashboard"));
  page.add_menu_item(__("TOC Settings"), () =>
    frappe.set_route("Form", "TOC Settings", "TOC Settings"));

  // ── Mount HTML ──
  $(frappe.render_template("kitting_report", {})).appendTo(page.body);

  // ── Start controller ──
  window.kitReport = new KittingReport(page);
  kitReport.load();
};

frappe.pages["kitting-report"].on_page_hide = function () {
  if (window.kitReport && window.kitReport._timer) {
    clearInterval(window.kitReport._timer);
  }
};

/* ══════════════════════════════════════════════════
   CONTROLLER
══════════════════════════════════════════════════ */
class KittingReport {
  constructor(page) {
    this.page = page;
    this.data = [];
    this.activeRow = null;    // currently selected item_code
    this.drillData = null;    // loaded drill-down data
    this._bindBulkActions();
  }

  /* ── Load main table ── */
  load() {
    this._setTableLoading(true);
    this.activeRow = null;
    document.getElementById("kit-drill-panel").style.display = "none";

    const f = this.page.fields_dict;
    const monthVal = (f.month.get_value() || "").split("|")[0];

    frappe.call({
      method: "chaizup_toc.api.kitting_api.get_kitting_summary",
      args: {
        company    : f.company.get_value() || null,
        month      : monthVal || null,
        year       : f.year.get_value() || null,
        buffer_type: f.buffer_type.get_value() === "All" ? null : f.buffer_type.get_value(),
      },
      callback: (r) => {
        this.data = r.message || [];
        this._renderCards();
        this._renderTable();
        this._updateMeta();
        this._setTableLoading(false);
      },
      error: (err) => {
        this._setTableLoading(false);
        frappe.show_alert({ message: "Kitting load error: " + (err.message||""), indicator: "red" });
      },
    });
  }

  /* ── Summary Cards ── */
  _renderCards() {
    const counts = { none: 0, partial: 0, full: 0, no_demand: 0 };
    this.data.forEach(r => { counts[r.kit_status] = (counts[r.kit_status] || 0) + 1; });
    _el("kc-none").textContent    = counts.none;
    _el("kc-partial").textContent = counts.partial;
    _el("kc-full").textContent    = counts.full + counts.no_demand;
    _el("kc-total").textContent   = this.data.length;

    const bulkBar = _el("kit-bulk-bar");
    if (this.data.length > 0) {
      bulkBar.style.display = "flex";
      _el("kit-bulk-info").textContent =
        `${counts.none + counts.partial} item(s) need action`;
    } else {
      bulkBar.style.display = "none";
    }
  }

  /* ── Main Table ── */
  _renderTable() {
    const tbody = _el("kit-tbody");
    if (!this.data.length) {
      tbody.innerHTML = `<tr><td colspan="14" class="kit-placeholder">
        No TOC-enabled FG/SFG items found. Enable TOC on items to begin.</td></tr>`;
      return;
    }

    const canAct = frappe.user.has_role(
      ["System Manager", "Stock Manager", "TOC Manager",
       "Manufacturing Manager", "Purchase Manager"]);

    tbody.innerHTML = this.data.map((r, i) => {
      const kitCls  = `kit-status-${r.kit_status}`;
      const kitIcon = { full:"✅", partial:"🟡", none:"🔴", no_demand:"⚪" }[r.kit_status] || "";
      const kitLbl  = { full:"Full Kit", partial:"Partial", none:"Cannot Kit", no_demand:"No Demand" }[r.kit_status] || "";
      const kitPct  = r.kit_pct != null ? `${r.kit_pct}%` : "";
      const barW    = Math.min(100, r.kit_pct || 0);
      const barCol  = { full:"#10b981", partial:"#f59e0b", none:"#ef4444", no_demand:"#94a3b8" }[r.kit_status];

      const sp = r.should_produce;
      const spCls = sp > 0 ? "style='color:#dc2626;font-weight:700'" : "";

      const actionBtns = canAct && sp > 0 ? `
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${r.buffer_type === "FG" || r.buffer_type === "SFG"
            ? `<button class="kit-btn kit-btn-mfg" style="padding:4px 8px;font-size:11px"
                onclick="event.stopPropagation();kitReport._quickWO('${r.item_code}','${r.bom}',${sp})">
                ⚙️ WO</button>` : ""}
          <button class="kit-btn kit-btn-teal" style="padding:4px 8px;font-size:11px"
            onclick="event.stopPropagation();kitReport._drillAndCreateMR('${r.item_code}',${sp})">
            🛒 MR</button>
        </div>` : "";

      return `<tr data-code="${r.item_code}" data-qty="${sp}" class="${this.activeRow === r.item_code ? "kit-row-active" : ""}"
               onclick="kitReport._onRowClick('${r.item_code}',${sp},this)">
        <td><span style="color:#9ca3af;font-size:11.5px;font-weight:600">${i+1}</span></td>
        <td><span class="kit-type kit-type-${r.buffer_type}">${r.buffer_type}</span></td>
        <td>
          <a href="/app/item/${encodeURIComponent(r.item_code)}"
             onclick="event.stopPropagation()"
             style="font-weight:600;color:inherit;text-decoration:none">${r.item_name}</a>
          <div style="font-size:11px;color:#9ca3af">${r.item_code}</div>
        </td>
        <td class="kit-num" style="font-weight:600">${_n(r.total_so_pending)}</td>
        <td class="kit-num" style="color:#6b7280">${_n(r.prev_month_pending_so)}</td>
        <td class="kit-num">${_n(r.curr_month_pending_so)}</td>
        <td class="kit-num" style="color:#059669">${_n(r.curr_month_dispatched)}</td>
        <td class="kit-num" style="color:#6b7280">${_n(r.prev_month_dispatched)}</td>
        <td class="kit-num" style="font-weight:600">${_n(r.stock)}</td>
        <td class="kit-num">${_n(r.curr_month_prod_req)}</td>
        <td class="kit-num" style="color:#059669">${_n(r.curr_month_actual_prod)}</td>
        <td class="kit-num" ${spCls}>${_n(sp)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="kit-status-pill ${kitCls}">${kitIcon} ${kitLbl}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
            <div class="kit-mini-bar">
              <div class="kit-mini-fill" style="width:${barW}%;background:${barCol}"></div>
            </div>
            <span style="font-size:10.5px;color:#6b7280">${kitPct}</span>
          </div>
        </td>
        <td>${actionBtns}</td>
      </tr>`;
    }).join("");
  }

  /* ── Row click → drill-down ── */
  _onRowClick(itemCode, shouldProduce, rowEl) {
    // Toggle off if same row clicked again
    if (this.activeRow === itemCode) {
      this.activeRow = null;
      rowEl.classList.remove("kit-row-active");
      _el("kit-drill-panel").style.display = "none";
      return;
    }

    // Mark row active
    document.querySelectorAll(".kit-row-active").forEach(r => r.classList.remove("kit-row-active"));
    rowEl.classList.add("kit-row-active");
    this.activeRow = itemCode;

    // Show panel with spinner
    const panel = _el("kit-drill-panel");
    panel.style.display = "block";
    _el("kit-drill-header").innerHTML = `<div style="color:#6b7280;font-size:13px">
      <span class="kit-spinner"></span> Loading full BOM chain for <b>${itemCode}</b>…</div>`;
    _el("kit-drill-actions").innerHTML = "";
    _el("kit-tree-body").innerHTML = "";
    _el("kit-fg-docs").innerHTML = "";
    panel.scrollIntoView({ behavior: "smooth", block: "start" });

    // Load detail
    frappe.call({
      method: "chaizup_toc.api.kitting_api.get_item_kitting_detail",
      args: { item_code: itemCode, required_qty: shouldProduce || 1 },
      callback: (r) => {
        this.drillData = r.message;
        this._renderDrillPanel(r.message);
      },
      error: (err) => {
        _el("kit-drill-header").innerHTML =
          `<div style="color:#dc2626">Error loading detail: ${err.message||""}</div>`;
      },
    });
  }

  /* ── Drill-down panel rendering ── */
  _renderDrillPanel(d) {
    const company = this.page.fields_dict.company.get_value();
    const canAct  = frappe.user.has_role(
      ["System Manager", "Stock Manager", "TOC Manager",
       "Manufacturing Manager", "Purchase Manager"]);

    // Header
    const kitPct  = d.required_qty > 0
      ? Math.min(100, Math.round(d.kit_qty / d.required_qty * 100)) : 100;
    const kitColor = kitPct >= 100 ? "#059669" : (kitPct > 0 ? "#d97706" : "#dc2626");

    _el("kit-drill-header").innerHTML = `
      <div>
        <div class="kit-drill-title">📋 ${d.item_name}
          <span style="font-size:12px;font-weight:400;color:#6b7280;margin-left:8px">${d.item_code}</span>
        </div>
        <div class="kit-drill-sub">Full BOM chain · Click a component to see linked documents</div>
      </div>
      <div class="kit-drill-stats">
        <div class="kit-stat">
          <div class="kit-stat-val">${_n(d.required_qty)}</div>
          <div class="kit-stat-lbl">Should Produce</div>
        </div>
        <div class="kit-stat">
          <div class="kit-stat-val" style="color:${kitColor}">${_n(d.kit_qty)}</div>
          <div class="kit-stat-lbl">Can Kit Now</div>
        </div>
        <div class="kit-stat">
          <div class="kit-stat-val" style="color:#dc2626">${_n(d.shortage)}</div>
          <div class="kit-stat-lbl">Shortage</div>
        </div>
        <div class="kit-stat">
          <div class="kit-stat-val" style="color:#6366f1">${kitPct}%</div>
          <div class="kit-stat-lbl">Kit Ready</div>
        </div>
      </div>`;

    // Actions
    const purchaseItems = [];
    this._collectPurchaseShortages(d.components, purchaseItems);
    const hasShortages = purchaseItems.length > 0;
    const hasWOShortage = d.shortage > 0;

    if (canAct) {
      _el("kit-drill-actions").innerHTML = `
        ${hasWOShortage ? `
          <button class="kit-btn kit-btn-mfg"
            onclick="kitReport._createWO('${d.item_code}',${d.shortage},'${d.bom}')">
            ⚙️ Create Work Order (${_n(d.shortage)} units)
          </button>` : ""}
        ${hasShortages ? `
          <button class="kit-btn kit-btn-teal"
            onclick="kitReport._createPurchaseMR()">
            🛒 Create Purchase MR (${purchaseItems.length} items)
          </button>` : ""}
        ${!hasWOShortage && !hasShortages ? `
          <span style="font-size:12px;color:#059669;font-weight:500">
            ✅ All materials available — ready to produce</span>` : ""}
        <a href="/app/item/${encodeURIComponent(d.item_code)}" target="_blank"
           class="kit-btn" style="margin-left:auto">
          📦 Open Item
        </a>
        ${d.bom ? `<a href="/app/bom/${encodeURIComponent(d.bom)}" target="_blank"
           class="kit-btn">📐 Open BOM</a>` : ""}`;
    }

    // BOM Tree
    const treeEl = _el("kit-tree-body");
    if (!d.components || !d.components.length) {
      treeEl.innerHTML = `<div style="color:#9ca3af;font-size:13px;padding:20px 0">
        No BOM components found for this item. Create a BOM to enable kitting analysis.</div>`;
    } else {
      treeEl.innerHTML = "";
      d.components.forEach(c => this._renderComponent(c, treeEl));
    }

    // FG own WOs and MRs
    const docsEl = _el("kit-fg-docs");
    const ownDocs = [...(d.work_orders||[]), ...(d.material_requests||[])];
    if (ownDocs.length) {
      docsEl.innerHTML = `
        <div style="font-size:12px;font-weight:600;color:#6b7280;
             text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
          Open Documents for ${d.item_code}
        </div>
        ${d.work_orders.map(w => this._woDocHtml(w)).join("")}
        ${d.material_requests.map(m => this._mrDocHtml(m)).join("")}`;
    }
  }

  /* ── Render one BOM component row (recursive for SFG) ── */
  _renderComponent(comp, parentEl, depth = 0) {
    const indent = depth * 24;
    const hasSubs = comp.sub_components && comp.sub_components.length > 0;
    const hasDoc  = comp.work_orders.length || comp.purchase_orders.length
                 || comp.material_requests.length;
    const uid = `comp-${comp.item_code.replace(/[^a-zA-Z0-9]/g, "_")}_${Math.random().toString(36).slice(2,7)}`;

    const stageCls = {
      "In Stock": "kit-stage-green",
      "In Production": "kit-stage-blue",
      "Purchase Ordered": "kit-stage-teal",
      "MR Raised": "kit-stage-orange",
      "Short — No Action": "kit-stage-red",
    }[comp.stage] || "kit-stage-red";

    const shortCls = comp.shortage > 0 ? "shortage-val" : "ok-val";
    const rowClass = comp.shortage > 0 ? "kit-comp-shortage"
                   : (comp.type === "SFG" ? "kit-comp-sfg" : "");

    const wrapper = document.createElement("div");

    const rowHtml = `
      <div class="kit-comp-row ${rowClass}" style="margin-left:${indent}px" id="row-${uid}">
        <div class="kit-comp-indent">
          ${depth > 0 ? '<div class="kit-comp-indent-line"></div>' : ""}
        </div>
        <div class="kit-comp-item">
          <div style="display:flex;align-items:center;gap:6px">
            <span class="kit-type kit-type-${comp.type}">${comp.type}</span>
            <span class="kit-comp-name">${comp.item_name}</span>
            ${hasSubs ? `<button class="kit-sfg-toggle" onclick="kitReport._toggleSFG('${uid}')">
              ▼ chain</button>` : ""}
          </div>
          <div class="kit-comp-code">${comp.item_code} · ${comp.uom}</div>
        </div>
        <div class="kit-comp-num" title="Required quantity">${_n(comp.required_qty)}</div>
        <div class="kit-comp-num ${comp.in_stock > 0 ? "ok-val" : ""}" title="In stock">${_n(comp.in_stock)}</div>
        <div class="kit-comp-num ${shortCls}" title="Shortage">${comp.shortage > 0 ? _n(comp.shortage) : "—"}</div>
        <div>
          <span class="kit-stage ${stageCls}">${comp.stage}</span>
        </div>
        <div>
          ${hasDoc ? `<button class="kit-docs-toggle" onclick="kitReport._toggleDocs('${uid}')">
            📄 ${comp.work_orders.length + comp.purchase_orders.length + comp.material_requests.length} doc(s)
          </button>` : ""}
        </div>
      </div>
      <div class="kit-doc-list" id="docs-${uid}">
        ${comp.work_orders.map(w => this._woDocHtml(w)).join("")}
        ${comp.purchase_orders.map(p => this._poDocHtml(p)).join("")}
        ${comp.material_requests.map(m => this._mrDocHtml(m)).join("")}
      </div>
      ${hasSubs ? `<div class="kit-sfg-children" id="sfg-${uid}"></div>` : ""}`;

    wrapper.innerHTML = rowHtml;
    parentEl.appendChild(wrapper);

    // Render sub-components into the sfg children container
    if (hasSubs) {
      const subEl = wrapper.querySelector(`#sfg-${uid}`);
      comp.sub_components.forEach(sub => this._renderComponent(sub, subEl, depth + 1));
    }
  }

  /* ── Document HTML helpers ── */
  _woDocHtml(w) {
    const pct = w.qty > 0 ? Math.round(w.produced_qty / w.qty * 100) : 0;
    return `<div class="kit-doc-item">
      <a href="/app/work-order/${encodeURIComponent(w.name)}" target="_blank"
         class="kit-doc-link" onclick="event.stopPropagation()">⚙️ ${w.name}</a>
      <span class="kit-doc-meta">Status: <b>${w.status}</b></span>
      <span class="kit-doc-meta">Qty: ${_n(w.qty)} · Produced: ${_n(w.produced_qty)} (${pct}%)</span>
      ${w.planned_start_date ? `<span class="kit-doc-meta">Start: ${w.planned_start_date}</span>` : ""}
      <span class="kit-doc-meta">By: ${w.owner}</span>
      <span class="kit-doc-meta" style="color:#9ca3af">${w.raised_on||""}</span>
    </div>`;
  }

  _poDocHtml(p) {
    const rcvPct = p.qty > 0 ? Math.round((p.received_qty||0) / p.qty * 100) : 0;
    return `<div class="kit-doc-item">
      <a href="/app/purchase-order/${encodeURIComponent(p.name)}" target="_blank"
         class="kit-doc-link" onclick="event.stopPropagation()">🛒 ${p.name}</a>
      <span class="kit-doc-meta">Supplier: <b>${p.supplier||"—"}</b></span>
      <span class="kit-doc-meta">Status: <b>${p.status}</b></span>
      <span class="kit-doc-meta">Qty: ${_n(p.qty)} · Received: ${_n(p.received_qty||0)} (${rcvPct}%)</span>
      <span class="kit-doc-meta">By: ${p.owner}</span>
      <span class="kit-doc-meta" style="color:#9ca3af">${p.raised_on||""}</span>
    </div>`;
  }

  _mrDocHtml(m) {
    const ordPct = m.qty > 0 ? Math.round((m.ordered_qty||0) / m.qty * 100) : 0;
    return `<div class="kit-doc-item">
      <a href="/app/material-request/${encodeURIComponent(m.name)}" target="_blank"
         class="kit-doc-link" onclick="event.stopPropagation()">📋 ${m.name}</a>
      <span class="kit-doc-meta">Type: <b>${m.material_request_type||""}</b></span>
      <span class="kit-doc-meta">Status: <b>${m.status}</b></span>
      <span class="kit-doc-meta">Qty: ${_n(m.qty)} · Ordered: ${_n(m.ordered_qty||0)} (${ordPct}%)</span>
      <span class="kit-doc-meta">By: ${m.owner}</span>
      <span class="kit-doc-meta" style="color:#9ca3af">${m.raised_on||""}</span>
    </div>`;
  }

  /* ── Toggle helpers ── */
  _toggleDocs(uid) {
    const el = document.getElementById(`docs-${uid}`);
    if (el) el.classList.toggle("open");
  }

  _toggleSFG(uid) {
    const el = document.getElementById(`sfg-${uid}`);
    if (!el) return;
    const btn = document.querySelector(`#row-${uid} .kit-sfg-toggle`);
    if (el.style.display === "none") {
      el.style.display = "";
      if (btn) btn.textContent = "▼ chain";
    } else {
      el.style.display = "none";
      if (btn) btn.textContent = "▶ chain";
    }
  }

  /* ── Action: Create Work Order from drill-down ── */
  _createWO(itemCode, qty, bom) {
    const company = this.page.fields_dict.company.get_value();
    if (!company) { frappe.msgprint("Select a Company first."); return; }

    frappe.confirm(
      `Create a <b>Work Order</b> for <b>${itemCode}</b>?<br>
       Qty: <b>${_n(qty)}</b> units · BOM: <b>${bom || "auto-detect"}</b>`,
      () => {
        frappe.call({
          method: "chaizup_toc.api.kitting_api.create_work_order_from_kitting",
          args: { item_code: itemCode, qty, company, bom },
          freeze: true, freeze_message: "Creating Work Order...",
          callback: (r) => {
            if (r.message && r.message.status === "success") {
              frappe.show_alert({
                message: `Work Order <b>${r.message.work_order}</b> created`,
                indicator: "green",
              });
              kitReport.load();
            }
          },
        });
      }
    );
  }

  /* ── Action: Quick WO from main table row button ── */
  _quickWO(itemCode, bom, qty) {
    this._createWO(itemCode, qty, bom);
  }

  /* ── Action: Create Purchase MR (from drill-down) ── */
  _createPurchaseMR() {
    if (!this.drillData) { frappe.msgprint("Open a drill-down first."); return; }
    const company = this.page.fields_dict.company.get_value();
    if (!company) { frappe.msgprint("Select a Company first."); return; }

    const shortages = [];
    this._collectPurchaseShortages(this.drillData.components, shortages);
    if (!shortages.length) {
      frappe.show_alert({ message: "No RM/PM shortages to purchase.", indicator: "orange" });
      return;
    }

    const listHtml = shortages.map(s =>
      `<tr><td>${s.item_code}</td><td style="text-align:right">${_n(s.shortage_qty)}</td><td>${s.uom}</td></tr>`
    ).join("");

    frappe.confirm(
      `Create <b>Purchase Material Request</b> for the following shortages?<br><br>
       <table style="width:100%;font-size:12px;border-collapse:collapse">
         <thead><tr style="color:#6b7280;border-bottom:1px solid #e5e7eb">
           <th style="text-align:left;padding:4px 8px">Item</th>
           <th style="text-align:right;padding:4px 8px">Qty</th>
           <th style="padding:4px 8px">UOM</th>
         </tr></thead>
         <tbody>${listHtml}</tbody>
       </table>`,
      () => {
        frappe.call({
          method: "chaizup_toc.api.kitting_api.create_purchase_requests",
          args: { items_json: JSON.stringify(shortages), company },
          freeze: true, freeze_message: "Creating Material Request...",
          callback: (r) => {
            if (r.message && r.message.status === "success") {
              frappe.show_alert({
                message: `MR <b>${r.message.mr}</b> created · ${r.message.items_count} items`,
                indicator: "green",
              });
              kitReport.load();
            }
          },
        });
      }
    );
  }

  /* ── Drill + Create MR (from row button without opening panel) ── */
  _drillAndCreateMR(itemCode, shouldProduce) {
    const company = this.page.fields_dict.company.get_value();
    if (!company) { frappe.msgprint("Select a Company first."); return; }

    frappe.call({
      method: "chaizup_toc.api.kitting_api.get_item_kitting_detail",
      args: { item_code: itemCode, required_qty: shouldProduce || 1 },
      freeze: true, freeze_message: "Checking component shortages...",
      callback: (r) => {
        this.drillData = r.message;
        this._createPurchaseMR();
      },
    });
  }

  /* ── Bulk actions ── */
  _bindBulkActions() {
    const self = this;
    document.addEventListener("click", (e) => {
      if (e.target.id === "btn-bulk-purchase") self._bulkPurchaseMR();
      if (e.target.id === "btn-bulk-wo")       self._bulkWorkOrders();
    });
  }

  _bulkPurchaseMR() {
    frappe.msgprint({
      title: "Bulk Purchase MR",
      message: "Select an item row first, then use <b>🛒 MR</b> button to create a Purchase MR for that item's shortages.",
      indicator: "blue",
    });
  }

  _bulkWorkOrders() {
    const company = this.page.fields_dict.company.get_value();
    if (!company) { frappe.msgprint("Select a Company first."); return; }

    const actionItems = this.data.filter(r =>
      r.should_produce > 0 && r.bom &&
      (r.kit_status === "none" || r.kit_status === "partial" || r.kit_status === "full")
    );
    if (!actionItems.length) {
      frappe.show_alert({ message: "No items need Work Orders.", indicator: "orange" });
      return;
    }

    const listHtml = actionItems.map(r =>
      `<tr><td>${r.item_code}</td><td>${r.item_name}</td>
       <td style="text-align:right">${_n(r.should_produce)}</td></tr>`
    ).join("");

    frappe.confirm(
      `Create <b>${actionItems.length} Work Order(s)</b>?<br><br>
       <table style="width:100%;font-size:12px">
         <thead><tr style="color:#6b7280"><th>Code</th><th>Item</th><th>Qty</th></tr></thead>
         <tbody>${listHtml}</tbody>
       </table>`,
      () => {
        let created = 0, errors = 0;
        const chain = actionItems.reduce((p, item) =>
          p.then(() => frappe.call({
            method: "chaizup_toc.api.kitting_api.create_work_order_from_kitting",
            args: { item_code: item.item_code, qty: item.should_produce,
                    company, bom: item.bom },
          }).then(r => { if (r.message?.status === "success") created++; else errors++; })
           .catch(() => errors++)
        , Promise.resolve());

        frappe.freeze("Creating Work Orders...");
        chain.then(() => {
          frappe.unfreeze();
          frappe.show_alert({
            message: `${created} Work Order(s) created${errors ? ` · ${errors} failed` : ""}`,
            indicator: errors ? "orange" : "green",
          });
          kitReport.load();
        });
      }
    );
  }

  /* ── Helpers ── */
  _collectPurchaseShortages(components, result) {
    (components || []).forEach(c => {
      if (c.shortage > 0 && (c.type === "RM" || c.type === "PM")) {
        result.push({
          item_code   : c.item_code,
          shortage_qty: c.shortage,
          uom         : c.uom,
        });
      }
      if (c.sub_components && c.sub_components.length) {
        this._collectPurchaseShortages(c.sub_components, result);
      }
    });
  }

  _setTableLoading(on) {
    const tbody = _el("kit-tbody");
    if (on) {
      tbody.innerHTML = `<tr><td colspan="14" class="kit-placeholder">
        <span class="kit-spinner"></span> Calculating kitting status...</td></tr>`;
    }
  }

  _updateMeta() {
    const f = this.page.fields_dict;
    const monthVal = (f.month.get_value() || "").split("|")[0];
    const months = ["","Jan","Feb","Mar","Apr","May","Jun",
                    "Jul","Aug","Sep","Oct","Nov","Dec"];
    const mLabel = months[parseInt(monthVal)] || monthVal;
    _el("kit-period-label").textContent =
      `Period: ${mLabel} ${f.year.get_value() || ""}`;
    _el("kit-last-updated").textContent =
      "Last refreshed: " + frappe.datetime.now_time();
  }
}

/* ── Module-level helpers ── */
function _el(id) { return document.getElementById(id); }

function _n(v) {
  if (v == null || v === "" || isNaN(v)) return "—";
  const n = Number(v);
  if (n === 0) return "0";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
