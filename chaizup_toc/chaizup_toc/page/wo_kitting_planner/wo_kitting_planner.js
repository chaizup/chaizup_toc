/**
 * wo_kitting_planner.js -- WO Kitting Planner Controller
 * ========================================================
 * Frappe Custom Page (page_name: wo-kitting-planner)
 *
 * PURPOSE
 * -------
 * Dynamic simulation of Work Order kitting feasibility.
 * Covers ALL open Work Orders — not restricted to TOC-enabled items.
 *
 * EXECUTIVE UX DESIGN
 * --------------------
 * Built for manufacturing executives who need to answer three questions fast:
 *   1. "Which orders can I produce TODAY?" → Green rows / Ready count
 *   2. "Which orders are blocked and why?" → Shortage chip → modal with recommendation
 *   3. "What do I need to order to unblock everything?" → One-click MR creation
 *
 * HELP SYSTEM
 * -----------
 * Three layers of contextual help for non-technical users:
 *   a) Floating tooltip (data-tip): hover any control for a plain-language description
 *   b) Column popover (? button): click ? to see a full column explanation with examples
 *   c) Modal recommendation card: every shortage modal starts with "what should I do"
 *
 * FEATURES
 * --------
 * - Stock Perspective X: physical Bin stock only
 * - Stock Perspective Y: Bin + open POs + open Purchase MRs + open WO expected output
 * - Scenario A (Independent Check): each WO evaluated against FULL pool; order irrelevant
 * - Scenario B (Priority Queue): stock consumed in row order; drag rows to change priority
 * - Multi-level BOM toggle (Deep BOM Check — OFF by default for speed)
 * - Summary strip: Ready / Partial / Blocked / Total / Shortage Value
 * - Shortage modal with business-language recommendation card + per-component table
 * - WO detail modal with decision guidance based on customer order pressure
 * - One-click Purchase MR creation for all shortage components
 *
 * UI FLOW
 * -------
 *   on_page_load → init() → _bindControls() + _initHelpSystem() + _setupFullHeight() + load()
 *   load()      → API get_open_work_orders → this.woOrder → simulate()
 *   simulate()  → API simulate_kitting → this.rows → _render()
 *   _render()   → _updateSummary() + _renderTable() + _updateHintBar()
 *   Shortage chip → _showShortageModal(row) [with reco card + component table]
 *   Detail btn  → _showWOModal(row) [with decision card + all metadata]
 *   Drag-drop   → reorder this.woOrder → simulate() [Scenario B only]
 *
 * API CALLS
 * ---------
 *   chaizup_toc.api.wo_kitting_api.get_open_work_orders
 *   chaizup_toc.api.wo_kitting_api.simulate_kitting
 *   chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages
 *
 * KNOWN BUGS / GOTCHAS
 * --------------------
 * WKP-001: No single quotes in .html file (Frappe wraps HTML in JS single-quoted string)
 * WKP-002: After any file change: redis-cli -h redis-cache -p 6379 FLUSHALL
 * WKP-003: _applyHeight() uses getBoundingClientRect().top — run after DOM paint
 * WKP-004: simulate() must use this.woOrder to preserve Scenario B drag order
 * WKP-005: Tooltip div #wkp-tooltip is inside wkp-root, positioned via fixed CSS
 */

"use strict";


// ═══════════════════════════════════════════════════════════════════════
//  COLUMN HELP POPOVER CONTENT
//  Shown when the user clicks a ? button on a column header.
//  Write in plain business language — assume the reader is an executive,
//  not an ERP administrator.
// ═══════════════════════════════════════════════════════════════════════

const WKP_POPOVERS = {

  remaining_qty: {
    title: "Qty Still to Produce",
    body:  "How many units of this product still need to be manufactured to complete this Work Order. Already-produced units are subtracted.",
    example: "Work Order: 500 kg Masala Blend\nAlready produced: 120 kg\nStill to produce: 380 kg",
    action: "Focus on WOs with high remaining qty AND unshipped customer orders — those are your highest urgency.",
  },

  shortage: {
    title: "Material Status",
    body:  "Whether all the raw materials and ingredients needed for this production run are available in the warehouse.\n\n\u2714 Ready to Produce \u2014 Everything is in stock. Can start now.\n\u26A0 N materials missing \u2014 Some items are short. Click to see which ones.\n\u26D4 Cannot Start \u2014 Critical materials are missing. Production is blocked.",
    example: "A 500 kg Masala Blend needs:\n  Chili Powder: need 80kg, have 120kg \u2714\n  Salt: need 50kg, have 20kg \u2716\n  \u2192 Status: 1 material missing",
    action: "Click any chip to see the full material breakdown and order missing items.",
  },

  est_cost: {
    title: "Estimated Production Cost",
    body:  "Approximate cost to produce the remaining quantity. Calculated as:\n  Valuation Rate (from BOM) \u00D7 Remaining Qty\n\nThis is a rough estimate — actual costs may vary based on current material prices.",
    example: "Remaining: 380 kg\nValuation rate: \u20B9120 per kg\nEst. cost: \u20B945,600",
    action: "Use this to prioritize high-value WOs or identify where material shortages are most expensive.",
  },

  prev_so: {
    title: "Last Month Unshipped Orders",
    body:  "Quantity of this product that was due for delivery in the PREVIOUS calendar month but has NOT yet been shipped to customers.\n\nThese orders are OVERDUE. Customers are already waiting.",
    example: "If today is April 15th, this shows undelivered customer orders with delivery dates in March.",
    action: "Any value here means you have overdue deliveries. Prioritize these WOs to avoid customer escalations.",
  },

  curr_so: {
    title: "This Month Customer Orders",
    body:  "Quantity of this product that customers have ordered with delivery due in the CURRENT calendar month, not yet shipped.\n\nThese are upcoming commitments that need to be met.",
    example: "If today is April 15th, this shows undelivered orders due by April 30th.",
    action: "Compare against \u2018Qty Still to Produce\u2019 to check if you can fulfil this month's commitments.",
  },

  total_so: {
    title: "Total Unshipped Customer Orders",
    body:  "Total pending customer order quantity across both last month (overdue) and this month (due soon).\n\nThis is the total demand pressure on this Work Order.",
    example: "Last month unshipped: 200 kg\nThis month orders: 300 kg\nTotal unshipped: 500 kg",
    action: "If Total Unshipped is higher than Qty Still to Produce, you may need to create additional Work Orders.",
  },
};


// ═══════════════════════════════════════════════════════════════════════
//  PAGE ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

frappe.pages["wo-kitting-planner"].on_page_load = function (wrapper) {
  if (wrapper._wkp_initialized) return;
  wrapper._wkp_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "WO Kitting Planner",
    single_column: true,
  });

  $(frappe.render_template("wo_kitting_planner", {})).appendTo(page.body);

  const planner = new WOKittingPlanner(wrapper, page);
  wrapper._wkp_planner = planner;
  planner.init();
};

frappe.pages["wo-kitting-planner"].on_page_show = function (wrapper) {
  if (wrapper._wkp_planner) {
    requestAnimationFrame(() => wrapper._wkp_planner._applyHeight());
  }
};


// ═══════════════════════════════════════════════════════════════════════
//  MAIN CONTROLLER CLASS
// ═══════════════════════════════════════════════════════════════════════

class WOKittingPlanner {
  constructor(wrapper, page) {
    this.wrapper = wrapper;
    this.page    = page;

    this.stockMode    = "current_only";
    this.calcMode     = "isolated";
    this.multiLevel   = false;
    this.statusFilter = "";
    this._company     = frappe.defaults.get_default("company") || "";

    this.woOrder  = [];
    this.rows     = [];
    this._loading = false;
    this._dragSrc = null;

    // Help system
    this._tipEl    = null;   // floating tooltip element
    this._popEl    = null;   // column help popover element
    this._tipTimer = null;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────────────────────────────

  init() {
    this._bindControls();
    this._initHelpSystem();
    this._setupFullHeight();
    this._updateHintBar();
    this.load();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HELP SYSTEM
  //  Two layers:
  //    1. Floating tooltip: shows on hover for [data-tip] elements
  //    2. Column popover: shows on click of .wkp-th-help ? buttons
  // ─────────────────────────────────────────────────────────────────────

  _initHelpSystem() {
    // ── Tooltip setup ──
    this._tipEl = document.getElementById("wkp-tooltip");
    this._popEl = document.getElementById("wkp-popover");

    // Delegate tooltip for any [data-tip] element inside wkp-root
    const root = document.getElementById("wkp-root");
    if (!root || !this._tipEl) return;

    root.addEventListener("mouseover", e => {
      const target = e.target.closest("[data-tip]");
      if (!target) return;
      clearTimeout(this._tipTimer);
      this._tipTimer = setTimeout(() => {
        this._tipEl.textContent = target.dataset.tip || "";
        this._tipEl.classList.add("wkp-tip-visible");
        this._tipEl.style.display = "block";
        this._positionTip(e);
      }, 300);
    });

    root.addEventListener("mousemove", e => {
      if (this._tipEl && this._tipEl.classList.contains("wkp-tip-visible")) {
        this._positionTip(e);
      }
    });

    root.addEventListener("mouseout", e => {
      if (!e.target.closest("[data-tip]")) return;
      clearTimeout(this._tipTimer);
      this._tipEl.classList.remove("wkp-tip-visible");
      this._tipEl.style.display = "none";
    });

    // ── Column popover setup ──
    // Delegated — works even after table re-renders
    root.addEventListener("click", e => {
      const btn = e.target.closest(".wkp-th-help");
      if (btn) {
        e.stopPropagation();
        this._showPopover(btn, btn.dataset.popover);
        return;
      }
      // Click anywhere else → close popover
      if (!e.target.closest("#wkp-popover")) {
        this._hidePopover();
      }
    });

    const closeBtn = document.getElementById("wkp-pop-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this._hidePopover());

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        this._hidePopover();
        this._closeModal("wkp-modal");
        this._closeModal("wkp-wo-modal");
      }
    });
  }

  _positionTip(mouseEvent) {
    if (!this._tipEl) return;
    const x = mouseEvent.clientX;
    const y = mouseEvent.clientY;
    const tw = this._tipEl.offsetWidth  || 240;
    const th = this._tipEl.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + 14;
    let top  = y - th - 10;

    if (left + tw > vw - 10) left = x - tw - 10;
    if (top < 6)             top  = y + 16;
    if (top + th > vh - 6)  top  = vh - th - 6;

    this._tipEl.style.left = left + "px";
    this._tipEl.style.top  = top  + "px";
  }

  _showPopover(anchor, key) {
    const content = WKP_POPOVERS[key];
    if (!content || !this._popEl) return;

    document.getElementById("wkp-pop-title").textContent = content.title || "";
    document.getElementById("wkp-pop-body").textContent  = content.body  || "";

    const exEl  = document.getElementById("wkp-pop-example");
    const exTxt = document.getElementById("wkp-pop-ex-text");
    if (content.example) {
      exTxt.textContent     = content.example;
      exEl.style.display    = "";
    } else {
      exEl.style.display    = "none";
    }

    const actEl = document.getElementById("wkp-pop-action");
    if (content.action) {
      actEl.textContent  = "\uD83D\uDCA1 " + content.action;
      actEl.style.display = "";
    } else {
      actEl.style.display = "none";
    }

    // Position below anchor
    this._popEl.style.display = "block";
    const rect   = anchor.getBoundingClientRect();
    const popW   = 300;
    const popH   = this._popEl.offsetHeight || 180;
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;

    let left = rect.left + rect.width / 2 - popW / 2;
    let top  = rect.bottom + 8;

    if (left + popW > vw - 10) left = vw - popW - 10;
    if (left < 6)              left = 6;
    if (top + popH > vh - 10)  top  = rect.top - popH - 8;

    this._popEl.style.left = left + "px";
    this._popEl.style.top  = top  + "px";
  }

  _hidePopover() {
    if (this._popEl) this._popEl.style.display = "none";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  FULL-HEIGHT SETUP
  // ─────────────────────────────────────────────────────────────────────

  _setupFullHeight() {
    window.addEventListener("resize", () => this._applyHeight());
    this._applyHeight();
  }

  _applyHeight() {
    const root = document.getElementById("wkp-root");
    if (!root) return;
    const top = Math.round(root.getBoundingClientRect().top);
    root.style.height = Math.max(300, window.innerHeight - top - 4) + "px";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CONTROL BINDING
  // ─────────────────────────────────────────────────────────────────────

  _bindControls() {
    // Stock X / Y toggle
    document.querySelectorAll("#wkp-seg-stock .wkp-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (this.stockMode === btn.dataset.val) return;
        document.querySelectorAll("#wkp-seg-stock .wkp-seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.stockMode = btn.dataset.val;
        this.simulate();
      });
    });

    // Scenario A / B toggle
    document.querySelectorAll("#wkp-seg-calc .wkp-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (this.calcMode === btn.dataset.val) return;
        document.querySelectorAll("#wkp-seg-calc .wkp-seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.calcMode = btn.dataset.val;
        this._updateHintBar();
        this.simulate();
      });
    });

    // Deep BOM Check toggle
    const mlBtn        = document.getElementById("wkp-multilevel-btn");
    const mlDot        = document.getElementById("wkp-ml-dot");
    const mlSubLabel   = mlBtn && mlBtn.closest(".wkp-pill-group")
                          ? mlBtn.closest(".wkp-pill-group").querySelector(".wkp-pill-sublabel")
                          : null;

    if (mlBtn) {
      mlBtn.addEventListener("click", () => {
        this.multiLevel = !this.multiLevel;
        mlBtn.classList.toggle("active", this.multiLevel);
        mlDot.classList.toggle("active", this.multiLevel);
        if (mlSubLabel) {
          mlSubLabel.textContent = this.multiLevel
            ? "Sub-assemblies: ON"
            : "Sub-assemblies: OFF";
          mlSubLabel.style.color = this.multiLevel
            ? "var(--brand-600)"
            : "";
        }
        this.simulate();
      });
    }

    // Status filter
    document.getElementById("wkp-status-filter").addEventListener("change", e => {
      this.statusFilter = e.target.value;
      this.load();
    });

    // Refresh
    document.getElementById("wkp-refresh").addEventListener("click", () => this.load());

    // Modal close buttons + backdrop click
    ["wkp-modal-close", "wkp-wo-close"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => {
        this._closeModal("wkp-modal");
        this._closeModal("wkp-wo-modal");
      });
    });

    document.getElementById("wkp-modal").addEventListener("click", e => {
      if (e.target.id === "wkp-modal") this._closeModal("wkp-modal");
    });
    document.getElementById("wkp-wo-modal").addEventListener("click", e => {
      if (e.target.id === "wkp-wo-modal") this._closeModal("wkp-wo-modal");
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DATA LOADING
  // ─────────────────────────────────────────────────────────────────────

  load() {
    this._showLoader(true);
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_open_work_orders",
      args: { status_filter: this.statusFilter },
      callback: r => {
        if (r.exc) {
          this._showLoader(false);
          frappe.show_alert({ message: "Failed to load Work Orders.", indicator: "red" });
          return;
        }
        const wos = r.message || [];
        if (!wos.length) {
          this._showLoader(false);
          this._showEmpty(true);
          this._showTable(false);
          this._resetSummary();
          this._setHintText("No open Work Orders found. Create Work Orders in the Manufacturing module.");
          return;
        }
        this.woOrder = wos.map(w => w.name);
        this.simulate();
      },
    });
  }

  simulate() {
    if (!this.woOrder.length) return;
    this._showLoader(true);
    this._hidePopover();
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.simulate_kitting",
      args: {
        work_orders_json : JSON.stringify(this.woOrder),
        stock_mode       : this.stockMode,
        calc_mode        : this.calcMode,
        multi_level      : this.multiLevel ? 1 : 0,
      },
      callback: r => {
        this._showLoader(false);
        if (r.exc) {
          frappe.show_alert({ message: "Simulation failed. Check console.", indicator: "red" });
          return;
        }
        this.rows = r.message || [];
        this._render();
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────

  _render() {
    if (!this.rows.length) {
      this._showEmpty(true);
      this._showTable(false);
      this._resetSummary();
      return;
    }
    this._showEmpty(false);
    this._showTable(true);
    this._updateSummary(this.rows);
    this._renderTable(this.rows);
    this._updateHintBar(this.rows);
  }

  _updateSummary(rows) {
    let ready = 0, partial = 0, blocked = 0;
    let shortageVal = 0;
    for (const r of rows) {
      const s = r.kit_status;
      if (s === "ok" || s === "kitted") ready++;
      else if (s === "partial")         partial++;
      else if (s === "block")           blocked++;
      shortageVal += r.shortage_value || 0;
    }
    document.getElementById("wsum-ready").textContent   = ready;
    document.getElementById("wsum-partial").textContent = partial;
    document.getElementById("wsum-blocked").textContent = blocked;
    document.getElementById("wsum-total").textContent   = rows.length;
    document.getElementById("wsum-shortage-val").textContent =
      "\u20B9" + _fmt_num(shortageVal, 0);
  }

  _resetSummary() {
    ["wsum-ready", "wsum-partial", "wsum-blocked", "wsum-total", "wsum-shortage-val"]
      .forEach(id => { document.getElementById(id).textContent = "--"; });
  }

  _renderTable(rows) {
    const tbody = document.getElementById("wkp-tbody");
    tbody.innerHTML = rows.map((row, idx) => this._buildRow(row, idx)).join("");
    this._bindRowActions();
    if (this.calcMode === "sequential") this._bindDragDrop();
    this._setDragHandleState(this.calcMode === "sequential");
  }

  _buildRow(row, idx) {
    const statusClass = {
      ok: "wkp-row-ok", partial: "wkp-row-warn",
      block: "wkp-row-block", kitted: "wkp-row-kitted",
    }[row.kit_status] || "";

    const chipClass = {
      ok: "wkp-short-ok", partial: "wkp-short-warn",
      block: "wkp-short-block", kitted: "wkp-short-kitted",
    }[row.kit_status] || "wkp-short-ok";

    // Business-language chip text
    const sc = row.shortage_count || 0;
    const chipText = {
      ok      : "\u2714 Ready to Produce",
      partial : sc + " material" + (sc === 1 ? "" : "s") + " missing \u2014 click to see",
      block   : "\u26D4 Cannot Start \u2014 click to see",
      kitted  : "\u2713 Already Kitted",
    }[row.kit_status] || "\u2014";

    // Customer urgency badge
    const totalSO = row.total_pending_so || 0;
    let urgencyBadge = "";
    if (totalSO > 0) {
      const isOverdue = (row.prev_month_so || 0) > 0;
      const cls = isOverdue ? "wkp-pressure-high" : "wkp-pressure-med";
      const lbl = isOverdue ? "\u26A0 Overdue orders!" : "Orders due";
      urgencyBadge = `<span class="wkp-pressure ${cls}">${lbl}: ${_fmt_num(totalSO, 0)}</span>`;
    }

    const estCostTxt = row.est_cost
      ? "\u20B9" + _fmt_num(row.est_cost, 0) : "\u2014";
    const prevSo  = (row.prev_month_so   || 0) > 0 ? _fmt_num(row.prev_month_so,   0) : "\u2014";
    const currSo  = (row.curr_month_so   || 0) > 0 ? _fmt_num(row.curr_month_so,   0) : "\u2014";
    const totalSoTxt = totalSO > 0
      ? `<span style="font-weight:700">${_fmt_num(totalSO, 0)}</span>${urgencyBadge}`
      : "\u2014";

    const isClickable = row.kit_status !== "kitted" && (row.shortage_items || []).length > 0;
    const chipTip  = isClickable
      ? "Click to see which materials are missing and what action to take"
      : (row.kit_status === "ok" ? "All materials available in warehouse" : "");
    const stageBadgeCls = _status_badge_class(row.status);

    // Stage label (business-friendly)
    const stageLbl = {
      "Not Started"          : "Not Started",
      "Material Transferred" : "Kitted \u2714",
      "In Process"           : "On Floor",
      "Completed"            : "Done",
      "Stopped"              : "Stopped",
    }[row.status] || (row.status || "");

    return `
<tr class="wkp-tr ${statusClass}" data-wo="${_esc(row.wo)}" data-idx="${idx}">
  <td class="wkp-td-drag">
    <span class="wkp-drag-handle" title="Drag to change priority (Mode B only)">\u2630</span>
  </td>
  <td class="wkp-td-seq">${idx + 1}</td>
  <td>
    <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-wo-link"
       title="Open this Work Order in ERPNext">${_esc(row.wo)}</a>
  </td>
  <td>
    <div class="wkp-item-name">${_esc(row.item_name || row.item_code)}</div>
    <div class="wkp-item-code">${_esc(row.item_code)}</div>
  </td>
  <td class="ta-r">
    <strong>${_fmt_num(row.remaining_qty, 0)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(row.uom || "")}</div>
  </td>
  <td>
    <span class="wkp-short-chip ${chipClass}"
          data-wo="${_esc(row.wo)}"
          style="cursor:${isClickable ? "pointer" : "default"}"
          title="${chipTip}">
      ${chipText}
    </span>
  </td>
  <td class="ta-r">${estCostTxt}</td>
  <td class="ta-r ${(row.prev_month_so || 0) > 0 ? "wkp-cell-red" : ""}">${prevSo}</td>
  <td class="ta-r">${currSo}</td>
  <td class="ta-r">${totalSoTxt}</td>
  <td><span class="wkp-status-badge ${stageBadgeCls}" title="${_esc(row.status || "")}">${_esc(stageLbl)}</span></td>
  <td class="ta-r">
    <button class="wkp-btn wkp-btn-sm" data-action="wo-detail" data-wo="${_esc(row.wo)}"
            title="View full detail: quantities, customer orders, production cost">
      View Detail
    </button>
  </td>
</tr>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  ROW ACTION BINDING
  // ─────────────────────────────────────────────────────────────────────

  _bindRowActions() {
    document.querySelectorAll(".wkp-short-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === chip.dataset.wo);
        if (row && (row.shortage_items || []).length > 0) this._showShortageModal(row);
      });
    });

    document.querySelectorAll("[data-action='wo-detail']").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === btn.dataset.wo);
        if (row) this._showWOModal(row);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DRAG AND DROP (Scenario B / Priority Queue)
  // ─────────────────────────────────────────────────────────────────────

  _bindDragDrop() {
    const tbody = document.getElementById("wkp-tbody");
    if (!tbody) return;
    tbody.querySelectorAll("tr.wkp-tr").forEach(tr => {
      tr.setAttribute("draggable", "true");
      tr.addEventListener("dragstart", e => this._onDragStart(e, tr));
      tr.addEventListener("dragover",  e => this._onDragOver(e, tr));
      tr.addEventListener("dragleave", ()  => tr.classList.remove("wkp-drag-over"));
      tr.addEventListener("drop",      e => this._onDrop(e, tr));
      tr.addEventListener("dragend",   ()  => {
        document.querySelectorAll(".wkp-dragging, .wkp-drag-over")
          .forEach(el => el.classList.remove("wkp-dragging", "wkp-drag-over"));
        this._dragSrc = null;
      });
    });
  }

  _onDragStart(e, tr) {
    this._dragSrc = tr;
    tr.classList.add("wkp-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tr.dataset.wo);
  }

  _onDragOver(e, tr) {
    e.preventDefault();
    if (!this._dragSrc || this._dragSrc === tr) return;
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".wkp-drag-over").forEach(el => el.classList.remove("wkp-drag-over"));
    tr.classList.add("wkp-drag-over");
  }

  _onDrop(e, tr) {
    e.preventDefault();
    if (!this._dragSrc || this._dragSrc === tr) return;
    tr.classList.remove("wkp-drag-over");
    this._dragSrc.classList.remove("wkp-dragging");

    const tbody   = document.getElementById("wkp-tbody");
    const allRows = [...tbody.querySelectorAll("tr.wkp-tr")];
    const srcIdx  = allRows.indexOf(this._dragSrc);
    const tgtIdx  = allRows.indexOf(tr);

    if (srcIdx < tgtIdx) tr.parentNode.insertBefore(this._dragSrc, tr.nextSibling);
    else                  tr.parentNode.insertBefore(this._dragSrc, tr);

    this.woOrder = [...tbody.querySelectorAll("tr.wkp-tr")].map(r => r.dataset.wo);
    tbody.querySelectorAll("tr.wkp-tr").forEach((row, i) => {
      const s = row.querySelector(".wkp-td-seq");
      if (s) s.textContent = i + 1;
    });
    this.simulate();
  }

  _setDragHandleState(enabled) {
    document.querySelectorAll(".wkp-drag-handle").forEach(h => {
      h.style.opacity = enabled ? "1" : "0.2";
      h.style.cursor  = enabled ? "grab" : "default";
    });
    document.querySelectorAll("tr.wkp-tr").forEach(tr => {
      tr.setAttribute("draggable", enabled ? "true" : "false");
    });
    const thDrag = document.querySelector(".wkp-th-drag");
    if (thDrag) thDrag.style.opacity = enabled ? "1" : "0.3";
    const dragHint = document.getElementById("wkp-drag-hint");
    if (dragHint) dragHint.style.display = enabled ? "" : "none";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SHORTAGE DETAIL MODAL
  //  Opens when a shortage chip is clicked.
  //  Shows:
  //    1. Recommendation card (plain-language: what does this mean + what to do)
  //    2. Per-component breakdown table (what is needed vs available)
  //    3. "Order Missing Materials" button (creates Purchase MR)
  // ─────────────────────────────────────────────────────────────────────

  _showShortageModal(row) {
    document.getElementById("wkp-modal-title").textContent =
      "Material Shortage Detail";
    document.getElementById("wkp-modal-sub").textContent =
      row.wo + " \u2014 " + (row.item_name || row.item_code) +
      " (" + _fmt_num(row.remaining_qty, 0) + " " + (row.uom || "") + " remaining)";

    // ── Recommendation card ─────────────────────────────────────────
    document.getElementById("wkp-modal-reco").innerHTML = this._buildRecoCard(row);

    // ── Component breakdown table ───────────────────────────────────
    const items = row.shortage_items || [];
    let bodyHtml = "";

    if (!items.length) {
      bodyHtml = `<p class="wkp-modal-empty">
        No BOM components found. Please ensure an active BOM exists for this item.
      </p>`;
    } else {
      const rowsHtml = items.map(it => {
        const isShort   = (it.shortage || 0) > 0;
        const shortTxt  = isShort ? _fmt_num(it.shortage, 2) + " " + _esc(it.uom || "") : "\u2014";
        const valTxt    = (it.shortage_value || 0) > 0
          ? "\u20B9" + _fmt_num(it.shortage_value, 0) : "\u2014";
        const stageCls  = "wkp-stage-" + (it.stage_color || "green");
        const stageDesc = _stage_description(it.stage);
        return `
<tr class="${isShort ? "wkp-modal-row-short" : ""}">
  <td>
    <div class="wkp-item-name">${_esc(it.item_name || it.item_code)}</div>
    <div class="wkp-item-code">${_esc(it.item_code)}</div>
  </td>
  <td class="ta-r">
    <strong>${_fmt_num(it.required, 2)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(it.uom || "")}</div>
  </td>
  <td class="ta-r ${isShort ? "" : "wkp-cell-green"}">
    ${_fmt_num(it.available, 2)}
  </td>
  <td class="ta-r ${isShort ? "wkp-cell-red" : "wkp-cell-green"}">
    ${shortTxt}
  </td>
  <td class="ta-r">${valTxt}</td>
  <td>
    <span class="wkp-stage-badge ${stageCls}" title="${stageDesc}">${_esc(it.stage || "In Stock")}</span>
  </td>
</tr>`;
      }).join("");

      bodyHtml = `
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
  Material-by-material breakdown
</div>
<table class="wkp-modal-table">
  <thead>
    <tr>
      <th>Material / Ingredient</th>
      <th class="ta-r">Need</th>
      <th class="ta-r">In Stock</th>
      <th class="ta-r">Shortage</th>
      <th class="ta-r">Value (\u20B9)</th>
      <th>Procurement Stage</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 0;line-height:1.5">
  <strong>Procurement Stage legend:</strong>
  In Stock = available &nbsp;|&nbsp; In Production = being made &nbsp;|&nbsp;
  PO Raised = ordered from supplier &nbsp;|&nbsp;
  MR Raised = requested, not yet ordered &nbsp;|&nbsp;
  Short = no action taken yet
</div>`;
    }

    document.getElementById("wkp-modal-body").innerHTML = bodyHtml;

    // ── Create MR button ────────────────────────────────────────────
    const hasShortage = items.some(i => (i.shortage || 0) > 0);
    const mrBtn = document.getElementById("wkp-create-mr-btn");
    const canCreate = hasShortage && frappe.user.has_role([
      "System Manager", "TOC Manager", "Stock Manager",
      "Purchase Manager", "Manufacturing Manager",
    ]);
    mrBtn.style.display = canCreate ? "" : "none";
    if (canCreate) mrBtn.onclick = () => this._createMR(row);

    document.getElementById("wkp-modal").style.display = "flex";
  }

  /**
   * Build a plain-language recommendation card for the shortage modal.
   * This is the first thing an executive sees — "what does this mean and what should I do?"
   */
  _buildRecoCard(row) {
    const sc = row.shortage_count || 0;
    const sv = row.shortage_value || 0;

    const configs = {
      ok: {
        bg    : "wkp-reco-ok",
        icon  : "\u2705",
        head  : "This Work Order can start production immediately.",
        detail: "All required materials are available in the warehouse right now. No action needed on procurement.",
        action: null,
      },
      partial: {
        bg    : "wkp-reco-warn",
        icon  : "\u26A0\uFE0F",
        head  : sc + " material" + (sc === 1 ? "" : "s") + " need to be ordered"
                + (sv > 0 ? " (\u20B9" + _fmt_num(sv, 0) + " worth)" : "") + ".",
        detail: "Some ingredients are short. You can either partially produce what is possible now, or wait until all materials arrive and produce in full. Review the table below to decide which materials to expedite.",
        action: "Click \u201cOrder Missing Materials\u201d below to create a Purchase MR and send it to your procurement team.",
      },
      block: {
        bg    : "wkp-reco-err",
        icon  : "\uD83D\uDD34",
        head  : "Production is blocked \u2014 " + sc + " critical material" + (sc === 1 ? "" : "s") + " must be ordered first.",
        detail: "None of the required materials are available. This Work Order CANNOT start until procurement delivers the missing items."
                + (sv > 0 ? " Estimated purchase cost: \u20B9" + _fmt_num(sv, 0) + "." : ""),
        action: "Click \u201cOrder Missing Materials\u201d below to immediately create a Purchase MR. Mark it URGENT in your procurement workflow.",
      },
      kitted: {
        bg    : "wkp-reco-buy",
        icon  : "\u2705",
        head  : "Materials have already been transferred to the production floor.",
        detail: "This Work Order has been kitted. Check with the shop floor supervisor or production manager for current status.",
        action: null,
      },
    };

    const c = configs[row.kit_status] || configs.ok;
    return `
<div class="wkp-reco ${c.bg}">
  <div class="wkp-reco-icon">${c.icon}</div>
  <div class="wkp-reco-body">
    <div class="wkp-reco-headline">${c.head}</div>
    <div class="wkp-reco-detail">${c.detail}</div>
    ${c.action ? `<span class="wkp-reco-action">\uD83D\uDCA1 ${c.action}</span>` : ""}
  </div>
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  WO DETAIL MODAL
  //  Full picture of one Work Order: quantities, cost, customer orders, kitting status.
  //  Includes a "Decision Card" at the top with actionable business guidance.
  // ─────────────────────────────────────────────────────────────────────

  _showWOModal(row) {
    document.getElementById("wkp-wo-title").textContent = row.wo;
    document.getElementById("wkp-wo-sub").textContent   =
      (row.item_name || row.item_code) + " \u2014 " + (row.status || "");

    const totalSO     = (row.total_pending_so || 0);
    const isOverdue   = (row.prev_month_so || 0) > 0;
    const estCost     = row.est_cost ? "\u20B9" + _fmt_num(row.est_cost, 0) : "\u2014";

    // ── Decision card (top of modal) ────────────────────────────────
    const decisionHtml = this._buildDecisionCard(row);

    // ── WO info grid ────────────────────────────────────────────────
    const pressureHtml = totalSO > 0
      ? `<span class="wkp-pressure ${isOverdue ? "wkp-pressure-high" : "wkp-pressure-med"}">
           ${isOverdue ? "\u26A0 Overdue: " : "Due: "}${_fmt_num(totalSO, 0)} ${_esc(row.uom || "")}
         </span>`
      : `<span class="wkp-pressure wkp-pressure-none">No pending orders</span>`;

    const html = `
${decisionHtml}

<div class="wkp-wo-grid">

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Work Order Info</div>
    <div class="wkp-wo-info-row">
      <span>Order No.</span>
      <span><a href="/app/work-order/${_esc(row.wo)}" target="_blank">${_esc(row.wo)}</a></span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Product</span>
      <span>${_esc(row.item_name || row.item_code)}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Bill of Materials</span>
      <span class="mono">${_esc(row.bom_no || "\u2014")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Stage</span>
      <span>${_esc(row.status || "\u2014")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Planned Start</span>
      <span>${_esc(row.planned_start_date || "\u2014")}</span>
    </div>
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Production Quantities</div>
    <div class="wkp-wo-info-row">
      <span>Planned</span>
      <span>${_fmt_num(row.planned_qty, 0)} ${_esc(row.uom || "")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Already Produced</span>
      <span>${_fmt_num(row.produced_qty || 0, 0)}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span><strong>Still to Produce</strong></span>
      <span><strong>${_fmt_num(row.remaining_qty, 0)} ${_esc(row.uom || "")}</strong></span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Est. Production Cost</span>
      <span>${estCost}</span>
    </div>
    ${row.shortage_value > 0 ? `
    <div class="wkp-wo-info-row">
      <span>Missing Materials Cost</span>
      <span style="color:var(--err-text);font-weight:700">\u20B9${_fmt_num(row.shortage_value, 0)}</span>
    </div>` : ""}
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Customer Order Pressure</div>
    <div style="margin-bottom:10px">${pressureHtml}</div>
    <div class="wkp-wo-info-row">
      <span>Last Month (Overdue)</span>
      <span ${(row.prev_month_so || 0) > 0 ? 'style="color:var(--err-text);font-weight:700"' : ""}>
        ${(row.prev_month_so || 0) > 0 ? _fmt_num(row.prev_month_so, 0) + " " + _esc(row.uom || "") : "\u2014 No overdue orders"}
      </span>
    </div>
    <div class="wkp-wo-info-row">
      <span>This Month</span>
      <span>${(row.curr_month_so || 0) > 0 ? _fmt_num(row.curr_month_so, 0) + " " + _esc(row.uom || "") : "\u2014"}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span><strong>Total Unshipped</strong></span>
      <span><strong>${totalSO > 0 ? _fmt_num(totalSO, 0) + " " + _esc(row.uom || "") : "\u2014"}</strong></span>
    </div>
    ${totalSO > row.remaining_qty ? `
    <div style="margin-top:8px;font-size:11px;color:var(--err-text);font-weight:600">
      \u26A0 Customer demand (${_fmt_num(totalSO, 0)}) exceeds remaining production (${_fmt_num(row.remaining_qty, 0)}). Additional Work Orders may be needed.
    </div>` : ""}
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Kitting / Material Status</div>
    <div class="wkp-wo-kit-status ${_kit_status_class(row.kit_status)}">
      ${_kit_status_label(row.kit_status)}
    </div>
    ${row.shortage_count > 0 ? `
    <div class="wkp-wo-info-row" style="margin-top:10px">
      <span>Materials missing</span>
      <span style="color:var(--err-text);font-weight:700">${row.shortage_count}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Materials to buy</span>
      <span style="color:var(--err-text);font-weight:700">\u20B9${_fmt_num(row.shortage_value || 0, 0)}</span>
    </div>
    <div style="margin-top:8px">
      <button class="wkp-btn wkp-btn-sm" onclick="document.getElementById('wkp-wo-modal').style.display='none';
        document.querySelector('[data-action=wo-detail][data-wo=&quot;${_esc(row.wo)}&quot;]') && document.querySelector('.wkp-short-chip[data-wo=&quot;${_esc(row.wo)}&quot;]').click()">
        See Material Breakdown
      </button>
    </div>` : ""}
  </div>

</div>

<div class="wkp-wo-footer">
  <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-btn wkp-btn-brand">
    Open in ERPNext \u2192
  </a>
</div>`;

    document.getElementById("wkp-wo-body").innerHTML = html;
    document.getElementById("wkp-wo-modal").style.display = "flex";
  }

  /**
   * Builds the top decision card in the WO detail modal.
   * Tells the executive exactly what to do based on the situation.
   */
  _buildDecisionCard(row) {
    const totalSO = row.total_pending_so || 0;
    const pressure = totalSO > 0 ? (row.prev_month_so > 0 ? "high" : "medium") : "none";

    const pressureLine = {
      high  : `\u26A0 <strong>URGENT</strong> \u2014 There are overdue customer orders (${_fmt_num(row.prev_month_so || 0, 0)} ${_esc(row.uom || "")} past due). Expedite this production.`,
      medium: `Customer orders of ${_fmt_num(totalSO, 0)} ${_esc(row.uom || "")} are due this month.`,
      none  : "No pending customer orders for this product this month.",
    }[pressure];

    const statusCfg = {
      ok: {
        cls : "wkp-decision-ok",
        text: "\u2705 This Work Order can start immediately \u2014 all materials are in stock.",
        sub : "Release this to the production floor today.",
      },
      partial: {
        cls : "wkp-decision-warn",
        text: "\u26A0 Partially blocked \u2014 " + (row.shortage_count || 0) + " materials need to be ordered.",
        sub : "Create a Purchase MR for missing materials. You may be able to start partial production meanwhile.",
      },
      block: {
        cls : "wkp-decision-err",
        text: "\uD83D\uDD34 Fully blocked \u2014 production cannot start without procurement.",
        sub : "Immediately create a Purchase MR for all " + (row.shortage_count || 0) + " missing materials.",
      },
      kitted: {
        cls : "wkp-decision-buy",
        text: "\u2705 Materials already kitted and on the production floor.",
        sub : "Follow up with the shop floor supervisor for production progress.",
      },
    };

    const s = statusCfg[row.kit_status] || statusCfg.ok;

    return `
<div class="wkp-decision ${s.cls}" style="margin-bottom:0">
  <div class="wkp-decision-label">What to do</div>
  <div class="wkp-decision-text">${s.text}</div>
  <div class="wkp-decision-sub">${s.sub}</div>
  <div class="wkp-decision-sub" style="margin-top:6px;border-top:1px solid rgba(0,0,0,.06);padding-top:6px">
    ${pressureLine}
  </div>
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CREATE PURCHASE MR
  // ─────────────────────────────────────────────────────────────────────

  _createMR(row) {
    const items = (row.shortage_items || []).filter(i => (i.shortage || 0) > 0);
    if (!items.length) {
      frappe.show_alert({ message: "No shortage items to create MR for.", indicator: "orange" });
      return;
    }

    const payload = items.map(i => ({
      item_code   : i.item_code,
      shortage_qty: i.shortage,
      uom         : i.uom || "",
      warehouse   : i.warehouse || "",
    }));

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages",
      args: { items_json: JSON.stringify(payload), company: this._company },
      freeze: true,
      freeze_message: "Creating Material Request for " + items.length + " items\u2026",
      callback: r => {
        if (r.exc) return;
        const mr = r.message && r.message.mr;
        this._closeModal("wkp-modal");
        frappe.show_alert({
          message: "Purchase MR <b><a href=\"/app/material-request/" + mr
                   + "\" target=\"_blank\">" + mr + "</a></b> created for "
                   + items.length + " items. Send to procurement for action.",
          indicator: "green",
        }, 10);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CONTEXT BAR (formerly hint bar)
  //  Shows mode + live simulation results in plain language after each run.
  // ─────────────────────────────────────────────────────────────────────

  _updateHintBar(rows) {
    const modeEl   = document.getElementById("wkp-hint-mode");
    const textEl   = document.getElementById("wkp-hint-text");
    const iconEl   = document.getElementById("wkp-hint-icon");
    if (!modeEl || !textEl) return;

    // ── Mode label ──────────────────────────────────────────────────
    const stockLabel = this.stockMode === "current_only"
      ? "Physical stock only"
      : "Physical + Expected stock";

    const modeLabel = this.calcMode === "isolated"
      ? "Mode A \u2014 Independent Check \u00B7 " + stockLabel
      : "Mode B \u2014 Priority Queue \u00B7 " + stockLabel;

    modeEl.textContent = modeLabel;

    // ── Results summary ─────────────────────────────────────────────
    if (!rows || !rows.length) {
      this._setHintText("Checking which Work Orders can start production today\u2026");
      if (iconEl) iconEl.textContent = "\uD83D\uDCCA";
      return;
    }

    let ready = 0, partial = 0, blocked = 0;
    for (const r of rows) {
      if (r.kit_status === "ok" || r.kit_status === "kitted") ready++;
      else if (r.kit_status === "partial")                     partial++;
      else if (r.kit_status === "block")                       blocked++;
    }

    const parts = [];
    if (ready)   parts.push(ready   + " ready to start");
    if (partial) parts.push(partial + " partially blocked");
    if (blocked) parts.push(blocked + " fully blocked");

    const summary = rows.length + " Work Orders \u2014 " + parts.join(" \u00B7 ");
    this._setHintText(summary);

    if (iconEl) {
      iconEl.textContent = blocked > 0 ? "\u26A0\uFE0F" : (partial > 0 ? "\uD83D\uDFE1" : "\u2705");
    }
  }

  _setHintText(text) {
    const el = document.getElementById("wkp-hint-text");
    if (el) el.textContent = text;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  UI HELPERS
  // ─────────────────────────────────────────────────────────────────────

  _showLoader(show) {
    this._loading = show;
    const loader = document.getElementById("wkp-loader");
    if (loader) loader.style.display = show ? "flex" : "none";
    if (show) { this._showEmpty(false); this._showTable(false); }
  }

  _showEmpty(show) {
    const el = document.getElementById("wkp-empty");
    if (el) el.style.display = show ? "flex" : "none";
  }

  _showTable(show) {
    const el = document.getElementById("wkp-table-wrap");
    if (el) el.style.display = show ? "block" : "none";
  }

  _closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
}


// ═══════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function _fmt_num(val, decimals) {
  const n = parseFloat(val) || 0;
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function _esc(val) {
  if (val == null) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _status_badge_class(status) {
  return {
    "Not Started"          : "wkp-badge-gray",
    "Material Transferred" : "wkp-badge-blue",
    "In Process"           : "wkp-badge-amber",
    "Completed"            : "wkp-badge-green",
    "Stopped"              : "wkp-badge-red",
  }[status] || "wkp-badge-gray";
}

function _kit_status_class(status) {
  return {
    ok: "wkp-status-ok", partial: "wkp-status-warn",
    block: "wkp-status-block", kitted: "wkp-status-kitted",
  }[status] || "wkp-status-ok";
}

function _kit_status_label(status) {
  return {
    ok      : "\u2705 Ready to Produce \u2014 All materials available",
    partial : "\u26A0 Partially Blocked \u2014 Some materials missing",
    block   : "\uD83D\uDD34 Fully Blocked \u2014 Cannot start production",
    kitted  : "\u2713 Kitted \u2014 Materials on production floor",
  }[status] || "\u2014";
}

/**
 * Plain-English tooltip for the supply stage badge shown in shortage table.
 * Helps executives understand what each stage means without ERP knowledge.
 */
function _stage_description(stage) {
  return {
    "In Stock"     : "Available in warehouse right now",
    "In Production": "Being manufactured in another Work Order (sub-assembly)",
    "PO Raised"    : "Purchase Order sent to supplier — awaiting delivery",
    "MR Raised"    : "Material Request created — needs to be converted to PO",
    "Short"        : "Not available, not ordered — action needed immediately",
  }[stage] || stage || "";
}
