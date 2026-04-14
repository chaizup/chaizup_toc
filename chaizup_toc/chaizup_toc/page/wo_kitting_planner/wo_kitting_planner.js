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

  item_name: {
    title: "Item Name &amp; Item Group",
    body:  "The ERPNext item name (product description) for what this Work Order will produce.\n\nBelow the item name, the Item Group is shown &mdash; this is the category the item belongs to in your Item master (e.g. Finished Goods, Raw Materials, Packaging).",
    example: "Item Name: Masala Blend 500g Pouch\nItem Group: Finished Goods\nItem Code: MBLND-500G",
    action: "Use the Item Group filter above the table to narrow the list to a specific product category.",
  },

  remaining_qty: {
    title: "Qty Still to Produce",
    body:  "How many units of this product still need to be manufactured to complete this Work Order.\n\nCalculated as: Planned Qty &minus; Already Produced Qty.\n\nData source: Work Order &rarr; Qty, Produced Qty fields.",
    example: "Work Order planned: 500 kg\nAlready produced: 120 kg\nStill to produce: 380 kg",
    action: "Focus on WOs with high remaining qty AND unshipped customer orders &mdash; those are your highest urgency.",
  },

  shortage: {
    title: "Material Status",
    body:  "Whether all the raw materials needed for this production run are available in the warehouse.\n\n\u2714 Ready to Produce &mdash; Everything is in stock. Can start now.\n\u26A0 N materials missing &mdash; Some items are short. Click to see which ones.\n\u26D4 Cannot Start &mdash; Critical materials are missing. Production is blocked.\n\nData source: BOM components vs Bin (warehouse stock).",
    example: "Masala Blend 500g BOM needs:\n  Chili Powder: need 80kg, have 120kg \u2714\n  Salt: need 50kg, have 20kg \u2716\n  Result: 1 material missing",
    action: "Click any chip to see the full material breakdown with PO/MR quantities and consumption data.",
  },

  est_cost: {
    title: "Estimated Production Cost",
    body:  "Approximate cost to produce the remaining quantity.\n\nCalculation: Valuation Rate (Item master) \u00D7 Remaining Qty\n\nThis is a rough estimate &mdash; actual costs may vary based on current material prices.",
    example: "Remaining: 380 kg\nValuation rate: \u20B9120 per kg\nEst. cost: \u20B945,600",
    action: "Use this to prioritize high-value WOs or identify where material shortages are most expensive.",
  },

  prev_so: {
    title: "Last Month Unshipped Orders",
    body:  "Qty of this product that was due for delivery in the PREVIOUS calendar month but has NOT yet been shipped to customers.\n\nThese orders are OVERDUE. Customers are already waiting.\n\nData source: Sales Order Items where delivery_date is in previous month and delivered_qty &lt; qty.",
    example: "Today is April 15. This column shows undelivered customer orders with delivery dates in March.",
    action: "Any value here means overdue deliveries. Prioritize these WOs immediately.",
  },

  curr_so: {
    title: "This Month Customer Orders",
    body:  "Qty of this product that customers have ordered with delivery due in the CURRENT calendar month, not yet shipped.\n\nThese are upcoming commitments that need to be met.\n\nData source: Sales Order Items where delivery_date is in current month.",
    example: "Today is April 15. This shows undelivered orders due by April 30.",
    action: "Compare against Qty to Produce to check if you can fulfil this month&apos;s commitments.",
  },

  total_so: {
    title: "Total Unshipped Customer Orders",
    body:  "Total pending customer order quantity across both last month (overdue) and this month (due soon).\n\nThis is the total demand pressure on this Work Order.\n\nCalculation: Last Month Unshipped + This Month Orders.",
    example: "Last month unshipped: 200 kg\nThis month orders: 300 kg\nTotal unshipped: 500 kg",
    action: "If Total Unshipped &gt; Qty to Produce, you may need to create additional Work Orders.",
  },

  dispatch_coverage: {
    title: "Total Coverage (FG Stock + Will Produce)",
    body:  "How much of this finished good will be available to dispatch when all open Work Orders complete.\n\nCalculation:\n  FG In Stock = physical qty in warehouse (Bin.actual_qty)\n  Will Produce = sum of remaining_qty across all open WOs for this item\n  Total Coverage = FG In Stock + Will Produce",
    example: "FG In Stock: 200 kg\nOpen WOs remaining: 600 kg\nTotal Coverage: 800 kg\nCustomer Orders: 750 kg\nGap: -50 kg (surplus = on track)",
    action: "If Coverage is less than Customer Orders, you need either more WOs or to expedite blocked WOs.",
  },

  dispatch_gap: {
    title: "Dispatch Gap (Coverage vs Customer Orders)",
    body:  "Gap = Customer Orders (Pending Dispatch) minus Total Coverage (FG In Stock + Will Produce).\n\nPositive gap = SHORTAGE: customer demand exceeds what you can produce and deliver.\nNegative gap = SURPLUS: you will have more than enough.\nZero = exactly enough.\n\nNote: This does not account for WOs that are blocked or partially blocked.",
    example: "Customer Orders: 1,000 kg\nTotal Coverage: 800 kg\nGap: +200 kg = 200 kg SHORT\nAction: Create additional Work Orders or find alternative stock.",
    action: "Focus first on Critical items (positive gap) then At Risk items (enough coverage but WOs are blocked).",
  },

  wo_status: {
    title: "ERP Production Stage (ERPNext Status)",
    body:  "The exact Work Order status as it appears in ERPNext Manufacturing:\n\nNot Started &mdash; Work Order created but production has not begun. Materials may not yet be issued.\n\nIn Process &mdash; Production is actively ongoing. Materials have been partially consumed.\n\nMaterial Transferred &mdash; All required materials have been issued (transferred) to the production floor via a Stock Entry. Production can now start.\n\nCompleted &mdash; Production is done. Finished goods received into warehouse.\n\nStopped &mdash; Work Order was manually stopped.",
    example: "A WO showing Material Transferred but kit_status=block means the kitting simulation is using fresh stock (the transferred materials may have already been issued).",
    action: "Use the Show WOs filter in the command bar to narrow by this status.",
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

    // Tab system
    this._activeTab = "wo-plan";  // "wo-plan" | "shortage-report" | "emergency" | "dispatch"

    // Dispatch bottleneck data (fetched from separate API call after load)
    this._dispatchData   = {};   // {item_code: {fg_stock, total_pending, so_list, ...}}
    this._dispatchLoaded = false; // true once API responded
    this._dispatchLoading = false; // true while API call in-flight

    // Client-side filter state (applied in _getFilteredRows)
    this._filterItemGroup = "";   // item_group value from filter bar
    this._filterKitStatus = "";   // kit_status value
    this._filterUrgency   = "";   // "overdue" | "due" | "none" | ""

    // Help system
    this._tipEl    = null;   // floating tooltip element
    this._popEl    = null;   // column help popover element
    this._tipTimer = null;

    // ── AI Advisor state ──────────────────────────────────────────────
    // Session ID: UUID persisted in sessionStorage so it survives tab
    // navigation within the same browser session but resets on full refresh.
    this._aiSessionId     = this._getOrCreateAISession();
    this._aiContext       = null;   // compressed context object (set after simulate)
    this._aiInsightLoaded = false;  // true once auto-insight has been fetched
    this._aiTyping        = false;  // true while waiting for AI response
    // ──────────────────────────────────────────────────────────────────
  }

  // ─────────────────────────────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────────────────────────────

  init() {
    this._bindControls();
    this._bindTabs();
    this._bindFilterBar();
    this._initHelpSystem();
    this._initAIPanel();
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
          this._showAllPanes(false);
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
      this._showAllPanes(false);
      const fbar = document.getElementById("wkp-filter-bar");
      if (fbar) fbar.style.display = "none";
      this._resetSummary();
      return;
    }
    const fbar = document.getElementById("wkp-filter-bar");
    if (fbar) fbar.style.display = this._activeTab === "wo-plan" ? "" : "none";
    this._showEmpty(false);
    this._updateSummary(this.rows);
    this._updateHintBar(this.rows);
    this._populateItemGroupFilter(this.rows);
    this._renderShortageReport(this.rows);
    this._renderEmergencyPanel(this.rows);
    // Prefetch dispatch data in background (independent of active tab)
    this._dispatchLoaded  = false;
    this._dispatchData    = {};
    this._fetchDispatchData();
    // Reset AI insight so it regenerates with fresh simulation data
    this._aiInsightLoaded = false;
    this._aiContext       = null;
    this._compressContextAndFetchInsight();
    this._switchTab(this._activeTab);  // show/render the active pane
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
    const filtered = this._getFilteredRows(rows);
    const tbody    = document.getElementById("wkp-tbody");
    tbody.innerHTML = filtered.map((row, idx) => this._buildRow(row, idx)).join("");
    this._updateFilterCount(filtered.length, rows.length);
    this._bindRowActions();
    this._bindSeqInput();
    if (this.calcMode === "sequential") this._bindDragDrop();
    this._setDragHandleState(this.calcMode === "sequential");
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CLIENT-SIDE FILTERING
  // ─────────────────────────────────────────────────────────────────────

  _getFilteredRows(rows) {
    return rows.filter(r => {
      if (this._filterItemGroup && r.item_group !== this._filterItemGroup) return false;
      if (this._filterKitStatus && r.kit_status !== this._filterKitStatus) return false;
      if (this._filterUrgency === "overdue" && !(r.prev_month_so > 0)) return false;
      if (this._filterUrgency === "due"     && !(r.curr_month_so > 0 || r.prev_month_so > 0)) return false;
      if (this._filterUrgency === "none"    && (r.total_pending_so > 0)) return false;
      return true;
    });
  }

  _updateFilterCount(shown, total) {
    const el = document.getElementById("wkp-fbar-count");
    if (!el) return;
    if (shown < total) {
      el.textContent = "Showing " + shown + " of " + total + " WOs";
      el.style.display = "";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
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

    // Use EXACT ERPNext status name — no translation, no alias.
    // Tooltip on the column header (? button) explains each status in plain language.
    const stageLbl = row.status || "\u2014";

    // Status tooltip — explains the ERPNext term in plain language
    const statusTip = {
      "Not Started"         : "Work Order created. Production has not started. Materials not yet issued.",
      "In Process"          : "Production is actively ongoing. Materials being consumed on the floor.",
      "Material Transferred": "All materials have been issued to the production floor via Stock Entry.",
      "Completed"           : "Production complete. Finished goods received into warehouse.",
      "Stopped"             : "Work Order manually stopped. No further production expected.",
    }[row.status] || row.status || "";

    // Sequence input (active in Mode B, read-only in Mode A)
    const seqInput = `<input class="wkp-seq-input" type="number" min="1"
      value="${idx + 1}" data-wo="${_esc(row.wo)}" data-idx="${idx}"
      title="Type a number to change priority order (applies only in Mode B &mdash; Priority Queue)"
      ${this.calcMode !== "sequential" ? "readonly" : ""}>`;

    return `
<tr class="wkp-tr ${statusClass}" data-wo="${_esc(row.wo)}" data-idx="${idx}">
  <td class="wkp-td-drag">
    <span class="wkp-drag-handle" title="Drag to change priority (Mode B only)">\u2630</span>
  </td>
  <td class="wkp-td-seq">${seqInput}</td>
  <td>
    <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-wo-link"
       title="Open this Work Order in ERPNext">${_esc(row.wo)}</a>
  </td>
  <td>
    <div class="wkp-item-name">${_esc(row.item_name || row.item_code)}</div>
    <div class="wkp-item-code">${_esc(row.item_code)}</div>
    ${row.item_group ? `<div class="wkp-item-group-tag">${_esc(row.item_group)}</div>` : ""}
  </td>
  <td class="ta-r">
    <strong>${_fmt_num(row.remaining_qty, 0)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(row.uom || "")}</div>
  </td>
  <td>
    <span class="wkp-short-chip ${chipClass}"
          data-wo="${_esc(row.wo)}"
          style="cursor:${isClickable ? "pointer" : "default"}"
          data-tip="${chipTip}">
      ${chipText}
    </span>
  </td>
  <td class="ta-r">${estCostTxt}</td>
  <td class="ta-r ${(row.prev_month_so || 0) > 0 ? "wkp-cell-red" : ""}">${prevSo}</td>
  <td class="ta-r">${currSo}</td>
  <td class="ta-r">${totalSoTxt}</td>
  <td>
    <span class="wkp-status-badge ${stageBadgeCls}"
          data-tip="${statusTip}"
          title="${_esc(row.status || "")}">
      ${_esc(stageLbl)}
    </span>
  </td>
  <td class="ta-r">
    <button class="wkp-btn wkp-btn-sm" data-action="wo-detail" data-wo="${_esc(row.wo)}"
            title="View full detail: quantities, customer orders, material breakdown">
      View
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
    // Sequence inputs: active only in Mode B
    document.querySelectorAll(".wkp-seq-input").forEach(inp => {
      inp.readOnly = !enabled;
      inp.title = enabled
        ? "Type a number to change priority order"
        : "Sequence input is active only in Mode B (Priority Queue)";
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SEQUENCE NUMBER INPUT (Priority Queue numeric edit)
  //  Allows typing a sequence number as an alternative to drag-drop.
  //  Only reorders in Mode B; in Mode A shows a message and resets.
  // ─────────────────────────────────────────────────────────────────────

  _bindSeqInput() {
    document.querySelectorAll(".wkp-seq-input").forEach(inp => {
      inp.addEventListener("change", () => {
        if (this.calcMode !== "sequential") {
          inp.value = parseInt(inp.dataset.idx || 0) + 1;
          frappe.show_alert({
            message: "Sequence editing applies only in Mode B (Priority Queue). Switch mode to reorder.",
            indicator: "orange",
          });
          return;
        }
        const wo     = inp.dataset.wo;
        const maxSeq = this.woOrder.length;
        let   newSeq = parseInt(inp.value) || 1;
        newSeq = Math.max(1, Math.min(newSeq, maxSeq));
        inp.value = newSeq;
        this._applySeqChange(wo, newSeq - 1);  // convert 1-based → 0-based
      });
      // Prevent drag accidentally triggering when clicking the input
      inp.addEventListener("mousedown", e => e.stopPropagation());
    });
  }

  _applySeqChange(wo, newIdx) {
    const oldIdx = this.woOrder.indexOf(wo);
    if (oldIdx === -1 || oldIdx === newIdx) return;
    this.woOrder.splice(oldIdx, 1);
    this.woOrder.splice(newIdx, 0, wo);
    this.simulate();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  TAB SYSTEM
  //  Three tabs: WO Kitting Plan | Material Shortage Report | Emergency Priorities
  //  Data is pre-rendered for all tabs in _render(); switching is instant.
  // ─────────────────────────────────────────────────────────────────────

  _bindTabs() {
    const bar = document.getElementById("wkp-tab-bar");
    if (!bar) return;
    bar.addEventListener("click", e => {
      const btn = e.target.closest(".wkp-tab-btn");
      if (!btn) return;
      this._switchTab(btn.dataset.tab);
    });
  }

  _switchTab(tabName) {
    this._activeTab = tabName || "wo-plan";

    // Update tab button active state
    document.querySelectorAll(".wkp-tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === this._activeTab);
    });

    // Show/hide filter bar (only relevant for WO plan tab)
    const filterBar = document.getElementById("wkp-filter-bar");
    if (filterBar) filterBar.style.display = this._activeTab === "wo-plan" ? "" : "none";

    // Show/hide panes
    const panes = {
      "wo-plan"        : "wkp-pane-wo-plan",
      "shortage-report": "wkp-pane-shortage",
      "emergency"      : "wkp-pane-emergency",
      "dispatch"       : "wkp-pane-dispatch",
      "ai-chat"        : "wkp-pane-ai-chat",
    };
    Object.entries(panes).forEach(([tab, paneId]) => {
      const pane = document.getElementById(paneId);
      if (pane) pane.style.display = tab === this._activeTab ? "" : "none";
    });

    // If switching to WO plan, render the table (respects current filters)
    if (this._activeTab === "wo-plan" && this.rows.length) {
      this._renderTable(this.rows);
    }

    // If switching to dispatch tab, render (or show loading if still fetching)
    if (this._activeTab === "dispatch") {
      if (this._dispatchLoaded) {
        this._renderDispatchBottleneck();
      } else if (!this._dispatchLoading) {
        this._fetchDispatchData();
      }
    }

    // If switching to AI tab, show insight if already loaded
    if (this._activeTab === "ai-chat" && this._aiInsightLoaded) {
      // Insight was pre-rendered; just ensure panel is visible
    }
  }

  _showAllPanes(show) {
    ["wkp-pane-wo-plan", "wkp-pane-shortage", "wkp-pane-emergency",
     "wkp-pane-dispatch", "wkp-pane-ai-chat"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? "" : "none";
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  FILTER BAR
  //  Client-side filters: item group, kit status, customer urgency.
  //  All filtering is done in _getFilteredRows() — no API call needed.
  // ─────────────────────────────────────────────────────────────────────

  _bindFilterBar() {
    const grpSel     = document.getElementById("wkp-fbar-group");
    const statusSel  = document.getElementById("wkp-fbar-status");
    const urgSel     = document.getElementById("wkp-fbar-urgency");
    const clearBtn   = document.getElementById("wkp-fbar-clear");

    if (grpSel) grpSel.addEventListener("change", e => {
      this._filterItemGroup = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (statusSel) statusSel.addEventListener("change", e => {
      this._filterKitStatus = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (urgSel) urgSel.addEventListener("change", e => {
      this._filterUrgency = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (clearBtn) clearBtn.addEventListener("click", () => {
      this._filterItemGroup = "";
      this._filterKitStatus = "";
      this._filterUrgency   = "";
      if (grpSel)    grpSel.value    = "";
      if (statusSel) statusSel.value = "";
      if (urgSel)    urgSel.value    = "";
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
  }

  _populateItemGroupFilter(rows) {
    const sel = document.getElementById("wkp-fbar-group");
    if (!sel) return;
    const groups = [...new Set(rows.map(r => r.item_group || "").filter(Boolean))].sort();
    // Preserve current selection
    const current = sel.value;
    // Remove old options (keep first "All Groups" option)
    while (sel.options.length > 1) sel.remove(1);
    groups.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    });
    if (groups.includes(current)) sel.value = current;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  MATERIAL SHORTAGE REPORT TAB
  //  Aggregates shortage_items across all WOs to show consolidated demand.
  //  Sorted by net_gap DESC (unmet shortages with no PO/MR action first).
  //  Computed entirely from this.rows — no extra API call.
  // ─────────────────────────────────────────────────────────────────────

  _renderShortageReport(rows) {
    const body    = document.getElementById("wkp-shortage-body");
    const mrBtn   = document.getElementById("wkp-shortage-mr-btn");
    const subEl   = document.getElementById("wkp-shortage-sub");
    if (!body) return;

    // Aggregate shortage items across all WOs
    const agg = {};  // item_code → aggregated data
    rows.forEach(row => {
      (row.shortage_items || []).forEach(comp => {
        if ((comp.shortage || 0) <= 0) return;  // Only show items with actual shortage
        const ic = comp.item_code;
        if (!agg[ic]) {
          agg[ic] = {
            item_code    : ic,
            item_name    : comp.item_name || ic,
            uom          : comp.uom || "",
            total_required  : 0,
            total_available : 0,
            total_shortage  : 0,
            total_value     : 0,
            po_qty          : 0,
            mr_qty          : 0,
            wo_list         : [],
          };
        }
        const a = agg[ic];
        a.total_required  += comp.required      || 0;
        a.total_available += comp.available     || 0;
        a.total_shortage  += comp.shortage      || 0;
        a.total_value     += comp.shortage_value || 0;
        a.po_qty           = Math.max(a.po_qty, comp.po_qty || 0);  // Take max (same item, same PO)
        a.mr_qty           = Math.max(a.mr_qty, comp.mr_qty || 0);
        if (!a.wo_list.includes(row.wo)) a.wo_list.push(row.wo);
      });
    });

    const aggList = Object.values(agg);
    // Sort: net_gap = shortage - po_qty - mr_qty; highest first (most unmet)
    aggList.sort((a, b) => {
      const gapA = a.total_shortage - a.po_qty - a.mr_qty;
      const gapB = b.total_shortage - b.po_qty - b.mr_qty;
      return gapB - gapA;
    });

    if (!aggList.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No material shortages found across any open Work Order.</div>
          <div class="wkp-reco-detail">All materials are available for all active Work Orders in this simulation.</div>
        </div>
      </div>`;
      if (mrBtn) mrBtn.style.display = "none";
      if (subEl) subEl.textContent = " \u2014 No shortages found";
      return;
    }

    const totalItems = aggList.length;
    const totalVal   = aggList.reduce((s, a) => s + a.total_value, 0);
    if (subEl) subEl.textContent =
      " \u2014 " + totalItems + " unique item" + (totalItems === 1 ? "" : "s") + " short"
      + " \u00B7 Total value: \u20B9" + _fmt_num(totalVal, 0);

    const rowsHtml = aggList.map(a => {
      const netGap  = Math.max(0, a.total_shortage - a.po_qty - a.mr_qty);
      const netCls  = netGap > 0 ? "wkp-cell-red" : "wkp-cell-green";
      const netTxt  = netGap > 0 ? _fmt_num(netGap, 2) : "\u2714 Covered";
      const poTxt   = a.po_qty  > 0 ? _fmt_num(a.po_qty,  2) : "\u2014";
      const mrTxt   = a.mr_qty  > 0 ? _fmt_num(a.mr_qty,  2) : "\u2014";
      const wos     = a.wo_list.slice(0, 3).join(", ") + (a.wo_list.length > 3 ? " +" + (a.wo_list.length - 3) + " more" : "");
      return `
<tr>
  <td>
    <div class="wkp-item-name">${_esc(a.item_name)}</div>
    <div class="wkp-item-code">${_esc(a.item_code)}</div>
  </td>
  <td class="ta-r" data-tip="Total qty of this material needed across all WOs in this simulation">${_fmt_num(a.total_required, 2)} <small>${_esc(a.uom)}</small></td>
  <td class="ta-r" data-tip="Qty available in warehouse (physical stock)">${_fmt_num(a.total_available, 2)}</td>
  <td class="ta-r wkp-cell-red" data-tip="Total shortage across all WOs">${_fmt_num(a.total_shortage, 2)}</td>
  <td class="ta-r" data-tip="Qty on open Purchase Orders (ordered from supplier, not yet received)">${poTxt}</td>
  <td class="ta-r" data-tip="Qty on open Material Requests (requested but not yet converted to PO)">${mrTxt}</td>
  <td class="ta-r ${netCls}" data-tip="Net Gap = Shortage &minus; PO Qty &minus; MR Qty. If positive, this material has NO procurement action and needs immediate attention.">${netTxt}</td>
  <td class="ta-r" data-tip="Estimated purchase cost of total shortage quantity">\u20B9${_fmt_num(a.total_value, 0)}</td>
  <td style="font-size:11px;color:var(--stone-400)" data-tip="Work Orders that need this material">${_esc(wos)}</td>
</tr>`;
    }).join("");

    body.innerHTML = `
<div class="wkp-shortage-hint" data-tip="Items with positive Net Gap have no purchase order or request raised yet. These are the most urgent.">
  Items sorted by Net Gap (unmet shortage) &mdash; highest first.
  <strong>Net Gap &gt; 0</strong> = no procurement action taken yet, needs immediate attention.
</div>
<table class="wkp-modal-table wkp-shortage-table">
  <thead>
    <tr>
      <th>Material</th>
      <th class="ta-r" data-tip="Total quantity needed across all open WOs">Total Required</th>
      <th class="ta-r" data-tip="Physical warehouse stock (Bin)">In Stock</th>
      <th class="ta-r" data-tip="Total shortage (Required &minus; In Stock)">Shortage</th>
      <th class="ta-r" data-tip="Open PO quantity (ordered from supplier, not yet received)">PO Raised</th>
      <th class="ta-r" data-tip="Open MR quantity (not yet converted to Purchase Order)">MR Raised</th>
      <th class="ta-r" data-tip="Net Gap = Shortage &minus; PO &minus; MR. Positive = needs action NOW.">Net Gap</th>
      <th class="ta-r">Est. Value (\u20B9)</th>
      <th data-tip="Work Orders affected by this shortage">Affects WOs</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>`;

    // Show "Create Consolidated MR" button for items with net gap > 0
    const hasNetGap = aggList.some(a => (a.total_shortage - a.po_qty - a.mr_qty) > 0);
    if (mrBtn) {
      mrBtn.style.display = hasNetGap ? "" : "none";
      if (hasNetGap) {
        mrBtn.onclick = () => this._createConsolidatedMR(
          aggList.filter(a => (a.total_shortage - a.po_qty - a.mr_qty) > 0)
        );
      }
    }
  }

  _createConsolidatedMR(items) {
    const payload = items.map(a => ({
      item_code   : a.item_code,
      shortage_qty: Math.max(0, a.total_shortage - a.po_qty - a.mr_qty),
      uom         : a.uom || "",
      warehouse   : "",
    }));
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages",
      args: { items_json: JSON.stringify(payload), company: this._company },
      freeze: true,
      freeze_message: "Creating Consolidated Material Request for " + items.length + " items\u2026",
      callback: r => {
        if (r.exc) return;
        const mr = r.message && r.message.mr;
        frappe.show_alert({
          message: "Consolidated Purchase MR <b><a href=\"/app/material-request/" + mr
                   + "\" target=\"_blank\">" + mr + "</a></b> created for "
                   + items.length + " items.",
          indicator: "green",
        }, 10);
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  EMERGENCY PRIORITIES TAB
  //  Shows WOs with unshipped customer orders, sorted by urgency.
  //  Overdue orders (prev_month_so > 0) appear first.
  //  Computed from this.rows — no extra API call.
  // ─────────────────────────────────────────────────────────────────────

  _renderEmergencyPanel(rows) {
    const body = document.getElementById("wkp-emerg-body");
    if (!body) return;

    // Only WOs with pending customer orders
    const urgent = rows
      .filter(r => (r.total_pending_so || 0) > 0)
      .sort((a, b) => {
        // Overdue first, then by total SO desc
        const aOver = (a.prev_month_so || 0) > 0 ? 1 : 0;
        const bOver = (b.prev_month_so || 0) > 0 ? 1 : 0;
        if (aOver !== bOver) return bOver - aOver;
        return (b.total_pending_so || 0) - (a.total_pending_so || 0);
      });

    if (!urgent.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No emergency priorities found.</div>
          <div class="wkp-reco-detail">None of the open Work Orders have unshipped customer orders in the last or current month.</div>
        </div>
      </div>`;
      return;
    }

    const cardsHtml = urgent.map((row, i) => {
      const isOverdue = (row.prev_month_so || 0) > 0;
      const badgeCls  = isOverdue ? "wkp-emerg-badge-red" : "wkp-emerg-badge-amber";
      const badgeTxt  = isOverdue ? "\u26A0 OVERDUE" : "Due This Month";
      const chipClass = {
        ok: "wkp-short-ok", partial: "wkp-short-warn",
        block: "wkp-short-block", kitted: "wkp-short-kitted",
      }[row.kit_status] || "wkp-short-ok";
      const chipText  = {
        ok      : "\u2714 Ready to Produce",
        partial : (row.shortage_count || 0) + " materials short",
        block   : "\u26D4 Blocked",
        kitted  : "\u2713 Kitted",
      }[row.kit_status] || row.kit_status;

      const overdueLine = (row.prev_month_so || 0) > 0
        ? `<div class="wkp-emerg-detail wkp-emerg-overdue">
             \u26A0 Overdue (last month): ${_fmt_num(row.prev_month_so, 0)} ${_esc(row.uom || "")}
           </div>` : "";
      const dueLine = (row.curr_month_so || 0) > 0
        ? `<div class="wkp-emerg-detail">
             Due this month: ${_fmt_num(row.curr_month_so, 0)} ${_esc(row.uom || "")}
           </div>` : "";
      const coverCheck = row.total_pending_so > row.remaining_qty
        ? `<div class="wkp-emerg-alert">
             Customer demand (${_fmt_num(row.total_pending_so, 0)}) exceeds remaining production
             (${_fmt_num(row.remaining_qty, 0)}). Consider creating an additional Work Order.
           </div>` : "";

      return `
<div class="wkp-emerg-card wkp-emerg-${isOverdue ? "high" : "med"}">
  <div class="wkp-emerg-left">
    <span class="wkp-emerg-rank">#${i + 1}</span>
    <span class="wkp-emerg-badge ${badgeCls}">${badgeTxt}</span>
  </div>
  <div class="wkp-emerg-main">
    <div class="wkp-emerg-wo">
      <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-wo-link">${_esc(row.wo)}</a>
    </div>
    <div class="wkp-item-name">${_esc(row.item_name || row.item_code)}</div>
    <div class="wkp-item-code">${_esc(row.item_code)}</div>
    ${row.item_group ? `<div class="wkp-item-group-tag">${_esc(row.item_group)}</div>` : ""}
    ${coverCheck}
  </div>
  <div class="wkp-emerg-orders">
    <div class="wkp-emerg-so-label">Customer Orders</div>
    ${overdueLine}
    ${dueLine}
    <div class="wkp-emerg-total">Total: ${_fmt_num(row.total_pending_so, 0)} ${_esc(row.uom || "")}</div>
  </div>
  <div class="wkp-emerg-prod">
    <div class="wkp-emerg-so-label">Production Status</div>
    <div style="margin-bottom:4px">
      <span class="wkp-status-badge ${_status_badge_class(row.status)}"
            title="${_esc(row.status || "")}">${_esc(row.status || "")}</span>
    </div>
    <div>Remaining: ${_fmt_num(row.remaining_qty, 0)} ${_esc(row.uom || "")}</div>
    <div style="margin-top:4px">
      <span class="wkp-short-chip ${chipClass}" style="font-size:11px">${chipText}</span>
    </div>
  </div>
  <div class="wkp-emerg-actions">
    <button class="wkp-btn wkp-btn-brand wkp-btn-sm" data-action="emerg-plan" data-wo="${_esc(row.wo)}"
            title="Switch to WO Plan tab and see this Work Order">
      View in Plan
    </button>
    ${(row.shortage_items || []).some(i => i.shortage > 0) ? `
    <button class="wkp-btn wkp-btn-sm" data-action="emerg-shortage" data-wo="${_esc(row.wo)}"
            title="See which materials are missing for this Work Order">
      See Shortages
    </button>` : ""}
  </div>
</div>`;
    }).join("");

    body.innerHTML = cardsHtml;

    // Bind action buttons in emergency panel
    body.querySelectorAll("[data-action='emerg-plan']").forEach(btn => {
      btn.addEventListener("click", () => {
        this._switchTab("wo-plan");
        // Scroll to the WO row after a short delay for render
        setTimeout(() => {
          const tr = document.querySelector(`tr[data-wo="${btn.dataset.wo}"]`);
          if (tr) tr.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      });
    });
    body.querySelectorAll("[data-action='emerg-shortage']").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === btn.dataset.wo);
        if (row) this._showShortageModal(row);
      });
    });
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
        const isShort      = (it.shortage || 0) > 0;
        const shortTxt     = isShort ? _fmt_num(it.shortage, 2) : "\u2014";
        const valTxt       = (it.shortage_value || 0) > 0
          ? "\u20B9" + _fmt_num(it.shortage_value, 0) : "\u2014";
        const stageCls     = "wkp-stage-" + (it.stage_color || "green");
        const stageDesc    = _stage_description(it.stage);
        const poTxt        = (it.po_qty  || 0) > 0 ? _fmt_num(it.po_qty,  2) : "\u2014";
        const mrTxt        = (it.mr_qty  || 0) > 0 ? _fmt_num(it.mr_qty,  2) : "\u2014";
        const consumedTxt  = (it.consumed_qty || 0) > 0 ? _fmt_num(it.consumed_qty, 2) : "\u2014";
        const netGap       = Math.max(0, (it.shortage || 0) - (it.po_qty || 0) - (it.mr_qty || 0));
        const netCls       = netGap > 0 ? "wkp-cell-red" : (isShort ? "wkp-cell-green" : "");
        const netTxt       = isShort
          ? (netGap > 0 ? _fmt_num(netGap, 2) : "\u2714 Covered")
          : "\u2014";

        return `
<tr class="${isShort ? "wkp-modal-row-short" : ""}">
  <td>
    <div class="wkp-item-name">${_esc(it.item_name || it.item_code)}</div>
    <div class="wkp-item-code">${_esc(it.item_code)}</div>
  </td>
  <td class="ta-r" data-tip="Total qty of this material needed for the remaining production quantity of this Work Order.&#10;Formula: BOM per_unit_qty &times; remaining_qty">
    <strong>${_fmt_num(it.required, 2)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(it.uom || "")}</div>
  </td>
  <td class="ta-r ${isShort ? "" : "wkp-cell-green"}"
      data-tip="Physical qty available in warehouse (Bin.actual_qty across all warehouses).${this.stockMode === "current_and_expected" ? " Mode Y also adds open PO/MR/WO expected qty to available qty." : ""}">
    ${_fmt_num(it.available, 2)}
  </td>
  <td class="ta-r ${isShort ? "wkp-cell-red" : "wkp-cell-green"}"
      data-tip="Shortage = Required &minus; Available. Zero or blank = enough in stock.">
    ${shortTxt}
  </td>
  <td class="ta-r"
      data-tip="Qty already consumed from warehouse for this Work Order (from submitted Manufacture Stock Entries).&#10;If this WO is In Process, some materials may already be partially consumed.">
    ${consumedTxt}
  </td>
  <td class="ta-r"
      data-tip="Qty on open Purchase Orders for this material.&#10;Source: Purchase Order Items where PO is submitted and not closed/cancelled.">
    ${poTxt}
  </td>
  <td class="ta-r"
      data-tip="Qty on open Material Requests (Purchase type, not yet converted to PO).&#10;Source: Material Request Items where status is not Ordered/Stopped.">
    ${mrTxt}
  </td>
  <td class="ta-r ${netCls}"
      data-tip="Net Gap = Shortage &minus; PO Qty &minus; MR Qty.&#10;If positive, this material has NO procurement action and needs immediate attention.&#10;If zero or negative, existing POs/MRs should cover the shortage.">
    ${netTxt}
  </td>
  <td>${valTxt}</td>
  <td>
    <span class="wkp-stage-badge ${stageCls}"
          data-tip="${stageDesc}"
          title="${stageDesc}">${_esc(it.stage || "In Stock")}</span>
  </td>
</tr>`;
      }).join("");

      bodyHtml = `
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
  Material-by-material breakdown &mdash; hover any cell for data source
</div>
<table class="wkp-modal-table wkp-modal-table-wide">
  <thead>
    <tr>
      <th>Material / Ingredient</th>
      <th class="ta-r" data-tip="Qty needed for the remaining production run">Need</th>
      <th class="ta-r" data-tip="Physical warehouse stock">In Stock</th>
      <th class="ta-r" data-tip="Qty still needed (Need &minus; In Stock)">Shortage</th>
      <th class="ta-r" data-tip="Already consumed via Stock Entry for this WO">Consumed</th>
      <th class="ta-r" data-tip="Open Purchase Order quantity (ordered, not received)">PO Raised</th>
      <th class="ta-r" data-tip="Open Material Request quantity (not yet ordered)">MR Raised</th>
      <th class="ta-r" data-tip="Net Gap = Shortage &minus; PO &minus; MR. Positive = needs urgent action.">Net Gap</th>
      <th class="ta-r">Value (\u20B9)</th>
      <th data-tip="Where this material is in the supply chain">Stage</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 0;line-height:1.5">
  <strong>Stage legend:</strong>
  In Stock = available now &nbsp;|&nbsp; In Production = sub-assembly WO open &nbsp;|&nbsp;
  PO Raised = ordered from supplier &nbsp;|&nbsp;
  MR Raised = requested, not yet ordered &nbsp;|&nbsp;
  Short = no action taken
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
  //  AI ADVISOR TAB (§9)
  //
  //  PURPOSE: Plain-language production decision support via DeepSeek AI.
  //    1. Auto-insight: generated after every simulation (stateless call)
  //    2. Chat: session-persistent Q&A about production/purchase/dispatch
  //
  //  ARCHITECTURE:
  //    Session ID stored in sessionStorage → survives tab navigation,
  //    resets on full page refresh (intentional — fresh simulation = fresh session).
  //
  //    Context: _compressContextAndFetchInsight() calls server-side
  //    compress_context_for_ai() which builds a ~400-token summary.
  //    This same context is sent with every chat message so the AI
  //    always has the current simulation snapshot.
  //
  //    Function calling: Server runs a tool-call loop — AI may call
  //    get_wo_shortage_detail, get_dispatch_detail, or get_top_shortage_items
  //    before responding. Client never calls these directly.
  //
  //    HTML output: AI may return HTML tables/spans. _renderAIContent()
  //    sanitises the HTML (removes script/on* attributes) before injecting
  //    into the DOM via innerHTML.
  //
  //  ══════════════════════════════════════════════════════════════════
  //  🔒 RESTRICTED — do not rename without updating HTML and CSS:
  //    this._aiSessionId       (UUID for Redis cache key on server)
  //    this._aiContext         (compressed simulation context object)
  //    this._aiInsightLoaded   (gate: prevents duplicate auto-insight calls)
  //    #wkp-ai-insight-body    (innerHTML target for auto-briefing)
  //    #wkp-ai-messages        (chat bubble container — appended by JS)
  //    #wkp-ai-input           (textarea for user message)
  //    #wkp-ai-send            (send button)
  //    #wkp-ai-status          (typing indicator row)
  //    .wkp-msg-user           (user bubble class — R: JS assigns)
  //    .wkp-msg-ai             (AI bubble class — R: JS assigns)
  //  ✅ SAFE to change: quick question text, guide card text, bubble styling,
  //    AI card subtitle, model badge label.
  //  ══════════════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────────────────

  _getOrCreateAISession() {
    const key = "wkp_ai_session";
    let id = sessionStorage.getItem(key);
    if (!id) {
      // Generate UUID-like session ID
      id = "wkp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  _initAIPanel() {
    // Populate quick-question chips
    const quickBtns = document.getElementById("wkp-ai-quick-btns");
    if (quickBtns) {
      const questions = [
        "Which Work Orders should I release today?",
        "What materials do I need to buy urgently?",
        "Can we fulfil all customer orders this month?",
        "Which items will miss dispatch deadlines?",
        "Summarise the top 3 production risks",
        "Which customers have overdue orders?",
      ];
      quickBtns.innerHTML = questions.map(q =>
        `<button class="wkp-ai-quick-btn" data-q="${_esc(q)}">${_esc(q)}</button>`
      ).join("");

      quickBtns.addEventListener("click", e => {
        const btn = e.target.closest(".wkp-ai-quick-btn");
        if (btn) this._sendAIMessage(btn.dataset.q);
      });
    }

    // Set textarea placeholder via JS (avoids single-quote risk in HTML)
    const inp = document.getElementById("wkp-ai-input");
    if (inp) {
      inp.placeholder = "Ask about your production plan... e.g. Which WOs can I start today?";
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          this._sendAIMessage(inp.value.trim());
        }
      });
    }

    const sendBtn = document.getElementById("wkp-ai-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        const inp2 = document.getElementById("wkp-ai-input");
        if (inp2) this._sendAIMessage(inp2.value.trim());
      });
    }

    const clearBtn = document.getElementById("wkp-ai-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const msgs = document.getElementById("wkp-ai-messages");
        if (msgs) msgs.innerHTML = "";
        // Generate a new session ID so server-side history is abandoned
        const newId = "wkp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem("wkp_ai_session", newId);
        this._aiSessionId = newId;
      });
    }
  }

  _compressContextAndFetchInsight() {
    // Called after every simulate() — sends full simulation data to server,
    // gets back compressed context for AI + auto-insight content.
    if (!this.rows.length) return;

    const insightBody = document.getElementById("wkp-ai-insight-body");
    if (insightBody) {
      insightBody.innerHTML =
        `<div class="wkp-ai-loading-row">
           <div class="wkp-ai-dots"></div>
           <span>Generating production briefing\u2026</span>
         </div>`;
    }

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.compress_context_for_ai",
      args: {
        simulation_rows_json: JSON.stringify(this.rows),
        dispatch_json        : JSON.stringify(this._dispatchData || {}),
        stock_mode           : this.stockMode,
        calc_mode            : this.calcMode,
      },
      callback: r => {
        if (r.exc || !r.message) {
          if (insightBody) insightBody.innerHTML =
            `<span class="wkp-ai-warn">Could not prepare AI context. Check server logs.</span>`;
          return;
        }
        this._aiContext = r.message;
        this._fetchAutoInsight();
      },
    });
  }

  _fetchAutoInsight() {
    if (this._aiInsightLoaded || !this._aiContext) return;

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_ai_auto_insight",
      args: { context_json: JSON.stringify(this._aiContext) },
      callback: r => {
        this._aiInsightLoaded = true;
        const insightBody = document.getElementById("wkp-ai-insight-body");
        if (!insightBody) return;
        const data = r.message || {};
        const text = data.insight || "<span class=\"wkp-ai-warn\">No insight returned.</span>";
        insightBody.innerHTML = data.is_html ? _sanitizeAIHtml(text) : _esc(text);
      },
      error: () => {
        this._aiInsightLoaded = true;
        const insightBody = document.getElementById("wkp-ai-insight-body");
        if (insightBody) insightBody.innerHTML =
          `<span class="wkp-ai-warn">AI briefing failed. Verify API key and connectivity.</span>`;
      },
    });
  }

  _sendAIMessage(text) {
    if (!text || this._aiTyping) return;

    // Clear input
    const inp = document.getElementById("wkp-ai-input");
    if (inp) inp.value = "";

    // Switch to AI tab if not already there
    if (this._activeTab !== "ai-chat") this._switchTab("ai-chat");

    // Append user bubble
    this._appendChatBubble("user", text, false);

    // Show typing indicator
    this._setAITyping(true);

    // Ensure context is ready; if not, send minimal placeholder
    const ctx = this._aiContext || {
      summary: { note: "Simulation data still loading. Please refresh and try again." },
    };

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.chat_with_planner",
      args: {
        message     : text,
        session_id  : this._aiSessionId,
        context_json: JSON.stringify(ctx),
      },
      callback: r => {
        this._setAITyping(false);
        const data = r.message || {};
        const reply = data.reply || "<span class=\"wkp-ai-warn\">No response from AI.</span>";
        this._appendChatBubble("ai", reply, !!(data.is_html));
      },
      error: () => {
        this._setAITyping(false);
        this._appendChatBubble("ai",
          "<span class=\"wkp-ai-err\">Request failed. Check server logs or API key.</span>",
          true
        );
      },
    });
  }

  _appendChatBubble(role, content, isHtml) {
    const msgs = document.getElementById("wkp-ai-messages");
    if (!msgs) return;

    const div = document.createElement("div");
    div.className = role === "user" ? "wkp-msg-user" : "wkp-msg-ai";

    if (role === "ai") {
      // AI avatar + bubble
      div.innerHTML = `
        <div class="wkp-msg-avatar">&#x1F916;</div>
        <div class="wkp-msg-bubble wkp-msg-bubble-ai">
          ${isHtml ? _sanitizeAIHtml(content) : _escHtml(content)}
        </div>`;
    } else {
      div.innerHTML = `
        <div class="wkp-msg-bubble wkp-msg-bubble-user">${_escHtml(content)}</div>`;
    }

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  _setAITyping(on) {
    this._aiTyping = on;
    const statusEl = document.getElementById("wkp-ai-status");
    if (statusEl) statusEl.style.display = on ? "flex" : "none";
    const sendBtn = document.getElementById("wkp-ai-send");
    if (sendBtn) {
      sendBtn.disabled   = on;
      sendBtn.textContent = on ? "Thinking\u2026" : "\u27A4 Send";
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DISPATCH BOTTLENECK TAB
  //
  //  PURPOSE: For each finished-good item being produced, compare:
  //    • Customer Orders (Pending Dispatch) — open SO qty not yet shipped
  //    • FG In Stock  — physical warehouse qty of the finished good
  //    • Will Produce — sum of remaining_qty across all open WOs
  //    • Total Coverage = FG In Stock + Will Produce
  //    • Gap = Customer Orders - Total Coverage
  //
  //  Also tracks per-SO:
  //    • Pick List created (materials picked for delivery)?
  //    • Stock Reserved (Stock Reservation entry exists)?
  //    • Partial Delivery Notes already shipped?
  //
  //  STATUS LOGIC (computed here in JS, not server):
  //    Critical  → Gap > 0  (demand exceeds total supply even with all WOs done)
  //    At Risk   → Gap ≤ 0 but some WOs for this item are blocked/partial
  //    On Track  → Gap ≤ 0 and all WOs ready
  //    Surplus   → No customer orders (or negative gap with no SO urgency)
  //    No Orders → Item has WOs but no pending customer orders
  //
  //  API: chaizup_toc.api.wo_kitting_api.get_dispatch_bottleneck
  //  Data merges with this.rows (WO simulation results from simulate_kitting)
  //
  //  ══════════════════════════════════════════════════════════════════
  //  🔒 RESTRICTED — do not rename:
  //    this._dispatchData   (keyed by item_code from API response)
  //    this._dispatchLoaded / this._dispatchLoading (state flags)
  //    _renderDispatchBottleneck() / _fetchDispatchData() (called by _switchTab)
  //    #wkp-dispatch-body (HTML target for innerHTML injection)
  //    #wkp-dispatch-loading (spinner shown while API is in-flight)
  //  ✅ SAFE to change: column labels, badge text, colours, sort order,
  //    SO detail row layout, number of SO detail columns shown.
  //  ══════════════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────────────────

  _fetchDispatchData() {
    // Collect unique production item codes from current simulation rows
    const itemCodes = [...new Set((this.rows || []).map(r => r.item_code))];
    if (!itemCodes.length) {
      this._dispatchLoaded  = true;
      this._dispatchLoading = false;
      return;
    }

    this._dispatchLoading = true;
    const loadingEl = document.getElementById("wkp-dispatch-loading");
    if (loadingEl) loadingEl.style.display = "flex";

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_dispatch_bottleneck",
      args: { item_codes_json: JSON.stringify(itemCodes) },
      callback: r => {
        this._dispatchLoading = false;
        this._dispatchLoaded  = true;
        this._dispatchData    = r.message || {};
        if (loadingEl) loadingEl.style.display = "none";
        // If user is already on the dispatch tab, render now
        if (this._activeTab === "dispatch") this._renderDispatchBottleneck();
      },
      error: () => {
        this._dispatchLoading = false;
        this._dispatchLoaded  = true;
        if (loadingEl) loadingEl.style.display = "none";
        const body = document.getElementById("wkp-dispatch-body");
        if (body) body.innerHTML =
          `<div class="wkp-reco wkp-reco-err" style="margin:16px">
             <div class="wkp-reco-icon">\u26A0\uFE0F</div>
             <div class="wkp-reco-body">
               <div class="wkp-reco-headline">Failed to load dispatch data.</div>
               <div class="wkp-reco-detail">Check the browser console and server logs. Try refreshing the page.</div>
             </div>
           </div>`;
      },
    });
  }

  _renderDispatchBottleneck() {
    const body = document.getElementById("wkp-dispatch-body");
    if (!body) return;

    // ── Build per-item summary by merging simulation rows + dispatch API data ──
    // this.rows: one row per WO (item_code, remaining_qty, kit_status, ...)
    // this._dispatchData: {item_code: {fg_stock, total_pending, so_list, ...}}

    // Step 1: aggregate WO remaining_qty per item_code
    const woByItem = {};   // {item_code: {will_produce, wos: [...], kit_statuses: Set}}
    (this.rows || []).forEach(row => {
      const ic = row.item_code;
      if (!woByItem[ic]) {
        woByItem[ic] = {
          item_code  : ic,
          item_name  : row.item_name || ic,
          item_group : row.item_group || "",
          will_produce: 0,
          wos        : [],
          kit_statuses: new Set(),
        };
      }
      woByItem[ic].will_produce   += (row.remaining_qty || 0);
      woByItem[ic].wos.push(row.wo);
      woByItem[ic].kit_statuses.add(row.kit_status);
    });

    // Step 2: merge dispatch API data
    const items = Object.values(woByItem).map(item => {
      const d            = this._dispatchData[item.item_code] || {};
      const fg_stock     = d.fg_stock      || 0;
      const total_pending= d.total_pending || 0;
      const total_coverage = fg_stock + item.will_produce;
      const gap          = total_pending - total_coverage;

      // Determine dispatch status
      let dspStatus;
      if (total_pending === 0) {
        dspStatus = "no-orders";
      } else if (gap > 0) {
        dspStatus = "critical";   // demand > supply even with all WOs done
      } else {
        // Coverage is enough, but are WOs actually ready?
        const ks = item.kit_statuses;
        const hasBlocked = ks.has("block") || ks.has("partial");
        dspStatus = hasBlocked ? "atrisk" : "ok";
      }

      // Surplus: supply greatly exceeds demand
      if (total_pending > 0 && gap < -(total_coverage * 0.25)) dspStatus = "surplus";

      return {
        ...item,
        fg_stock,
        total_pending,
        total_coverage,
        gap,
        dsp_status     : dspStatus,
        total_reserved : d.total_reserved || 0,
        has_pick_list  : d.has_pick_list  || false,
        so_list        : d.so_list        || [],
      };
    });

    // Step 3: sort — Critical first, then At Risk, then On Track / No Orders
    const sortOrder = { critical: 0, atrisk: 1, ok: 2, surplus: 3, "no-orders": 4 };
    items.sort((a, b) => {
      const sd = (sortOrder[a.dsp_status] || 0) - (sortOrder[b.dsp_status] || 0);
      return sd !== 0 ? sd : (b.total_pending - a.total_pending);
    });

    if (!items.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No open Work Orders to analyse.</div>
          <div class="wkp-reco-detail">Load Work Orders first using the Refresh button.</div>
        </div>
      </div>`;
      return;
    }

    // ── Step 4: Build table rows ───────────────────────────────────────────
    const rowsHtml = items.map(item => {
      const statusCfg = {
        critical  : { cls: "wkp-dsp-critical",  icon: "\uD83D\uDD34", label: "Critical",  tip: "Demand exceeds total supply even with all WOs complete. Create more Work Orders." },
        atrisk    : { cls: "wkp-dsp-atrisk",    icon: "\uD83D\uDFE1", label: "At Risk",   tip: "Coverage is enough IF all WOs complete. But some WOs are blocked or partially short." },
        ok        : { cls: "wkp-dsp-ok",        icon: "\uD83D\uDFE2", label: "On Track",  tip: "Sufficient production + stock to cover all customer orders." },
        surplus   : { cls: "wkp-dsp-surplus",   icon: "\uD83D\uDD35", label: "Surplus",   tip: "Production output exceeds current customer demand." },
        "no-orders": { cls: "wkp-dsp-noorders", icon: "\u2610",       label: "No Orders", tip: "No open customer orders for this item. WOs exist but no dispatch demand." },
      }[item.dsp_status] || { cls: "", icon: "?", label: item.dsp_status, tip: "" };

      const gapCls  = item.gap > 0 ? "wkp-cell-red" : (item.gap < 0 ? "wkp-cell-green" : "");
      const gapTxt  = item.gap > 0
        ? `+${_fmt_num(item.gap, 0)} SHORT`
        : (item.gap < 0 ? `\u2714 +${_fmt_num(-item.gap, 0)} surplus` : "\u2714 Exact");

      // Pick list badge
      const plBadge = item.has_pick_list
        ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok"
                 data-tip="At least one Pick List has been created for a Sales Order of this item.&#10;Materials are being (or have been) picked for delivery.">\u2714 Pick List</span>`
        : `<span class="wkp-dsp-pill wkp-dsp-pill-none"
                 data-tip="No Pick List has been created yet for any open Sales Order of this item.">\u2610 No Pick List</span>`;

      // Stock reservation badge
      const resBadge = item.total_reserved > 0
        ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok"
                 data-tip="Stock Reservation: ${_fmt_num(item.total_reserved, 2)} units are reserved against open Sales Orders.&#10;This stock is earmarked and cannot be used for other purposes.">\uD83D\uDD12 Reserved: ${_fmt_num(item.total_reserved, 0)}</span>`
        : `<span class="wkp-dsp-pill wkp-dsp-pill-none"
                 data-tip="No Stock Reservation entries exist for this item&apos;s open Sales Orders.">\u26AA No Reservation</span>`;

      // SO count
      const soCount = item.so_list.length;
      const overdueCount = item.so_list.filter(s => s.is_overdue).length;

      // Expandable SO detail table (hidden by default)
      const soRowsHtml = item.so_list.length ? item.so_list.map(so => {
        const isOverdue = so.is_overdue;
        const dueCls    = isOverdue ? "wkp-cell-red" : "";
        const dateStr   = so.delivery_date || "\u2014";
        const plPill    = so.pick_list_count > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Pick List created for this SO">\u2714 PL (${so.pick_list_count})</span>`
          : `<span class="wkp-dsp-pill wkp-dsp-pill-none" data-tip="No Pick List for this SO">\u2610</span>`;
        const resPill   = (so.reserved_qty || 0) > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Reserved qty: ${_fmt_num(so.reserved_qty, 2)}">\uD83D\uDD12 ${_fmt_num(so.reserved_qty, 0)}</span>`
          : `<span class="wkp-dsp-pill wkp-dsp-pill-none" data-tip="No stock reserved for this SO">&mdash;</span>`;
        const dnPill    = (so.dn_qty || 0) > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Partial Delivery Note shipped: ${_fmt_num(so.dn_qty, 2)}">\uD83D\uDE9A ${_fmt_num(so.dn_qty, 0)} shipped</span>`
          : "";
        const overdueLbl= isOverdue
          ? `<span class="wkp-dsp-overdue-badge" data-tip="Delivery date was ${_esc(dateStr)} &mdash; this order is overdue">\u26A0 OVERDUE</span>`
          : "";

        return `
<tr class="wkp-dsp-so-row ${isOverdue ? "wkp-dsp-so-overdue" : ""}">
  <td>
    <a href="/app/sales-order/${_esc(so.so_name)}" target="_blank" class="wkp-wo-link">${_esc(so.so_name)}</a>
    ${overdueLbl}
  </td>
  <td>${_esc(so.customer)}</td>
  <td class="ta-r">${_fmt_num(so.qty, 0)}</td>
  <td class="ta-r" style="color:var(--ok-text)">${_fmt_num(so.delivered_qty, 0)}</td>
  <td class="ta-r ${dueCls}" data-tip="Qty still to be shipped for this Sales Order">
    <strong>${_fmt_num(so.pending_qty, 0)}</strong>
  </td>
  <td class="${dueCls}" data-tip="Target delivery date from Sales Order">${_esc(dateStr)}</td>
  <td>${plPill}</td>
  <td>${resPill}</td>
  <td>${dnPill}</td>
</tr>`;
      }).join("") : `<tr><td colspan="9" style="color:var(--stone-400);font-style:italic;padding:12px">No open Sales Orders for this item.</td></tr>`;

      const soDetailId = "wkp-dsp-so-" + item.item_code.replace(/[^a-zA-Z0-9]/g, "_");

      return `
<tr class="wkp-dsp-row wkp-dsp-${item.dsp_status}" data-item="${_esc(item.item_code)}">
  <td>
    <span class="wkp-dsp-status-badge ${statusCfg.cls}" data-tip="${statusCfg.tip}">
      ${statusCfg.icon} ${statusCfg.label}
    </span>
  </td>
  <td>
    <div class="wkp-item-name">${_esc(item.item_name)}</div>
    <div class="wkp-item-code">${_esc(item.item_code)}</div>
    ${item.item_group ? `<div class="wkp-item-group-tag">${_esc(item.item_group)}</div>` : ""}
    <div class="wkp-dsp-wo-chips">
      ${item.wos.slice(0, 3).map(wo => `<span class="wkp-dsp-wo-chip">${_esc(wo)}</span>`).join("")}
      ${item.wos.length > 3 ? `<span class="wkp-dsp-wo-chip">+${item.wos.length - 3} more</span>` : ""}
    </div>
  </td>
  <td class="ta-r"
      data-tip="Customer Orders (Pending Dispatch)&#10;Total qty across all open Sales Orders not yet delivered.&#10;Source: Sales Order Items where (qty - delivered_qty) &gt; 0">
    <strong>${_fmt_num(item.total_pending, 0)}</strong>
    ${overdueCount > 0 ? `<div class="wkp-dsp-overdue-note" data-tip="${overdueCount} order(s) with overdue delivery dates">\u26A0 ${overdueCount} overdue</div>` : ""}
  </td>
  <td class="ta-r"
      data-tip="FG In Stock&#10;Physical finished-good stock in all warehouses right now.&#10;Source: Bin.actual_qty (tabBin) for this item code.">
    ${_fmt_num(item.fg_stock, 0)}
  </td>
  <td class="ta-r"
      data-tip="Will Be Produced&#10;Sum of remaining_qty (Planned - Produced) across all open Work Orders for this item.&#10;Only counts WOs that have NOT yet completed production.">
    ${_fmt_num(item.will_produce, 0)}
    <div style="font-size:10px;color:var(--stone-400)">${item.wos.length} WO${item.wos.length !== 1 ? "s" : ""}</div>
  </td>
  <td class="ta-r wkp-dsp-coverage"
      data-tip="Total Coverage = FG In Stock + Will Produce&#10;This is the maximum quantity available for dispatch once all open WOs complete.&#10;Does NOT account for WOs that are blocked or partially short.">
    <strong>${_fmt_num(item.total_coverage, 0)}</strong>
    <span class="wkp-th-help" data-popover="dispatch_coverage" title="How is this calculated?">?</span>
  </td>
  <td class="ta-r ${gapCls}"
      data-tip="Gap = Customer Orders &minus; Total Coverage&#10;Positive (red) = shortage even if all WOs complete. Action needed.&#10;Negative (green) = surplus.&#10;Zero = exactly meets demand.">
    <strong>${gapTxt}</strong>
    <span class="wkp-th-help" data-popover="dispatch_gap" title="What does Gap mean?">?</span>
  </td>
  <td>
    <div class="wkp-dsp-badges">${plBadge} ${resBadge}</div>
    ${item.so_list.length
      ? `<div>${soCount} SO${soCount !== 1 ? "s" : ""}${overdueCount > 0 ? ` (${overdueCount} overdue)` : ""}</div>` : ""}
  </td>
  <td class="ta-r">
    ${soCount > 0
      ? `<button class="wkp-btn wkp-btn-sm" onclick="document.getElementById('${soDetailId}').style.display =
           document.getElementById('${soDetailId}').style.display === 'none' ? '' : 'none'"
           title="Expand to see each Sales Order with delivery dates, pick list status, and reservations">
           Details
         </button>` : ""}
  </td>
</tr>
<tr class="wkp-dsp-detail-row" id="${soDetailId}" style="display:none">
  <td colspan="9" style="padding:0 0 0 40px">
    <table class="wkp-modal-table wkp-dsp-so-table">
      <thead>
        <tr>
          <th data-tip="Sales Order number (click to open in ERPNext)">Sales Order</th>
          <th>Customer</th>
          <th class="ta-r" data-tip="Total qty in the Sales Order">Ordered</th>
          <th class="ta-r" data-tip="Qty already delivered via Delivery Notes">Delivered</th>
          <th class="ta-r" data-tip="Qty still pending dispatch (Ordered &minus; Delivered)">Pending</th>
          <th data-tip="Delivery date committed to customer in the Sales Order">Due Date</th>
          <th data-tip="Has a Pick List been created? Pick Lists initiate warehouse picking before dispatch.">Pick List</th>
          <th data-tip="Is stock reserved via Stock Reservation entry?">Reserved</th>
          <th data-tip="Partial deliveries already shipped via Delivery Note">Shipped</th>
        </tr>
      </thead>
      <tbody>${soRowsHtml}</tbody>
    </table>
  </td>
</tr>`;
    }).join("");

    // ── Render summary banner ─────────────────────────────────────────────
    const critCount = items.filter(i => i.dsp_status === "critical").length;
    const riskCount = items.filter(i => i.dsp_status === "atrisk").length;
    const okCount   = items.filter(i => i.dsp_status === "ok").length;

    const bannerHtml = `
<div class="wkp-dispatch-summary">
  <div class="wkp-dispatch-sum-card wkp-dsp-critical" data-tip="Items where customer demand exceeds total supply. Immediate action required.">
    <div class="wkp-dispatch-sum-num">${critCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDD34 Critical</div>
  </div>
  <div class="wkp-dispatch-sum-card wkp-dsp-atrisk" data-tip="Items with enough coverage IF all WOs complete, but some WOs are blocked.">
    <div class="wkp-dispatch-sum-num">${riskCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDFE1 At Risk</div>
  </div>
  <div class="wkp-dispatch-sum-card wkp-dsp-ok" data-tip="Items fully covered with all WOs on track.">
    <div class="wkp-dispatch-sum-num">${okCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDFE2 On Track</div>
  </div>
  <div class="wkp-dispatch-sum-card" style="background:var(--stone-50);border-color:var(--stone-200)" data-tip="Unique finished-good items across all open Work Orders.">
    <div class="wkp-dispatch-sum-num">${items.length}</div>
    <div class="wkp-dispatch-sum-lbl">Total Items</div>
  </div>
</div>`;

    body.innerHTML = bannerHtml + `
<table class="wkp-table wkp-dsp-table">
  <thead>
    <tr>
      <th data-tip="Overall dispatch status for this item. Click Details to see individual Sales Orders.">Status</th>
      <th>
        Item
        <span class="wkp-th-help" data-popover="item_name" title="What is shown here?">?</span>
      </th>
      <th class="ta-r"
          data-tip="Total open customer order qty for this item (all open SOs, all dates).&#10;Source: Sales Order Items where status is not Closed/Cancelled.">
        Customer Orders
      </th>
      <th class="ta-r"
          data-tip="Physical finished-good stock in all warehouses.&#10;Source: SUM(Bin.actual_qty) for this item across all warehouses.">
        FG In Stock
      </th>
      <th class="ta-r"
          data-tip="Sum of remaining production qty across all open Work Orders for this item.&#10;Remaining = Planned Qty &minus; Already Produced Qty">
        Will Produce
      </th>
      <th class="ta-r"
          data-tip="Total Coverage = FG In Stock + Will Produce&#10;Maximum available supply once all open WOs complete.">
        Total Coverage
        <span class="wkp-th-help" data-popover="dispatch_coverage" title="How is Coverage calculated?">?</span>
      </th>
      <th class="ta-r"
          data-tip="Gap = Customer Orders &minus; Total Coverage&#10;Positive = short (cannot fulfill all orders). Negative = surplus.">
        Gap
        <span class="wkp-th-help" data-popover="dispatch_gap" title="What does Gap mean?">?</span>
      </th>
      <th data-tip="Pick List and Stock Reservation status. Click Details to see per-SO breakdown.">Fulfillment Tracking</th>
      <th></th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div class="wkp-dispatch-footer">
  <strong>How to read this table:</strong>
  Critical = demand cannot be met even if all WOs complete &mdash; need more WOs or stock transfer.
  At Risk = enough coverage on paper but blocked WOs must be unblocked first.
  Click &ldquo;Details&rdquo; on any row to see individual Sales Orders with pick list, reservation, and delivery status.
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  UI HELPERS
  // ─────────────────────────────────────────────────────────────────────

  _showLoader(show) {
    this._loading = show;
    const loader = document.getElementById("wkp-loader");
    if (loader) loader.style.display = show ? "flex" : "none";
    if (show) { this._showEmpty(false); this._showAllPanes(false); }
  }

  _showEmpty(show) {
    const el = document.getElementById("wkp-empty");
    if (el) el.style.display = show ? "flex" : "none";
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

/**
 * Escape plain text for innerHTML (used for user messages in AI chat).
 * Same as _esc but preserves newlines as <br>.
 */
function _escHtml(val) {
  if (val == null) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

/**
 * Sanitise AI-generated HTML before injecting into the DOM.
 * Allows safe formatting tags and our custom CSS classes.
 * Strips <script>, event handlers (on*=), javascript: hrefs, and iframes.
 *
 * This is a defence-in-depth measure — DeepSeek is trusted but we still
 * sanitise to prevent accidental XSS from unexpected model output.
 *
 * SAFE tags: table, thead, tbody, tr, th, td, ul, ol, li, p, br, strong,
 *   em, span, div, a, code, h3, h4
 * STRIPPED: script, iframe, object, embed, form, input, button
 * STRIPPED attributes: on*, javascript:, data: URIs
 */
function _sanitizeAIHtml(html) {
  if (!html) return "";

  // Remove script and dangerous tags entirely
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<input[^>]*>/gi, "")
    .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, "");

  // Strip event handler attributes (onclick, onload, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
  clean = clean.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, "");

  // Strip javascript: and data: URIs in href/src
  clean = clean.replace(/href\s*=\s*["']\s*javascript:[^"']*/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']\s*data:[^"']*/gi, 'src=""');

  return clean;
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
