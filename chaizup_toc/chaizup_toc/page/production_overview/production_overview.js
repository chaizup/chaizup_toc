// =============================================================================
// CONTEXT: Production Overview Page JS Controller
//   3-tab dashboard: Overview (18-col table) | AI Advisor | Charts.
//   All data fetched via frappe.call() from production_overview_api.py.
// MEMORY: app_chaizup_toc.md § Production Overview Page
// INSTRUCTIONS:
//   - Use data-* attrs for event delegation (no inline onclick in templates).
//   - Session stored in sessionStorage key "por_ai_session".
//   - Context for AI: _buildAIContext() sends summary + top-20 items only.
//   - Chart.js loaded via CDN in HTML; always check typeof Chart before render.
// DANGER:
//   - context_json sent to AI MUST NOT include full items array (HTTP 400).
//     _buildAIContext() intentionally excludes large item lists.
//   - _esc() uses INLINE entity replacement — do NOT replace with frappe.dom.escape.
// RESTRICT:
//   - Do NOT add server-side rendering; keep this file JS-only.
//   - Do NOT hardcode month names — use _MONTHS constant.
//   - WO/SO status defaults come from get_default_statuses() API.
// =============================================================================

frappe.pages["production-overview"].on_page_load = function (wrapper) {
    if (wrapper._por_initialized) return;
    wrapper._por_initialized = true;

    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "Production Overview",
        single_column: true,
    });

    $(frappe.render_template("production_overview", {})).appendTo(page.body);

    window._porPage = new ProductionOverview(wrapper, page);
    wrapper._porPage = window._porPage;
    frappe.breadcrumbs.add("Chaizup Toc");
};

frappe.pages["production-overview"].on_page_show = function (wrapper) {
    if (wrapper._porPage) {
        requestAnimationFrame(() => wrapper._porPage._applyHeight());
    }
};

class ProductionOverview {
    // ── Constants ────────────────────────────────────────────────────────
    static _MONTHS = [
        "January","February","March","April","May","June",
        "July","August","September","October","November","December"
    ];

    // ── Constructor ──────────────────────────────────────────────────────
    constructor(wrapper, page) {
        this.wrapper = wrapper;
        this.page    = page;
        // Data state
        this._data      = null;   // full get_production_overview response
        this._period    = null;
        // Filter state
        this._selWh     = [];     // [] = all warehouses
        this._selWo     = [];     // populated by get_default_statuses
        this._selSo     = [];
        this._planMode  = false;
        // AI state
        this._aiModel   = "deepseek-chat";
        this._aiContext = null;
        // Chart state
        this._charts    = {};
        this._chartsLoaded = false;
        // Expose globally for modal close buttons (data-close-modal approach)
        window._porPage = this;
        this._init();
    }

    // ── Init ─────────────────────────────────────────────────────────────
    async _init() {
        this._setupFullHeight();
        await this._loadDefaults();
        this._bindEvents();
        this._initAIPanel();
    }

    _setupFullHeight() {
        window.addEventListener("resize", () => this._applyHeight());
        this._applyHeight();
    }

    _applyHeight() {
        const root = document.getElementById("por-root");
        if (!root) return;
        const top = root.getBoundingClientRect().top;
        root.style.height = (window.innerHeight - top - 4) + "px";
    }

    async _loadDefaults() {
        // ── Company list ──────────────────────────────────────────────
        try {
            const companies = await frappe.db.get_list("Company", { fields: ["name"], limit: 50 });
            const sel = document.getElementById("por-company");
            sel.innerHTML = companies.map(c =>
                `<option value="${this._esc(c.name)}">${this._esc(c.name)}</option>`
            ).join("");
            // Set default company
            const def = frappe.defaults.get_user_default("company") ||
                frappe.defaults.get_global_default("company");
            if (def) sel.value = def;
        } catch (_) { /* non-critical */ }

        // ── Current month/year ────────────────────────────────────────
        const now = new Date();
        const monthSel = document.getElementById("por-month");
        const yearInp  = document.getElementById("por-year");
        monthSel.value = String(now.getMonth() + 1);
        yearInp.value  = String(now.getFullYear());

        // ── WO/SO default statuses + warehouse list ────────────────────
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_default_statuses",
            callback: (r) => {
                if (!r.message) return;
                const d = r.message;
                this._selWo = [...(d.wo_statuses || [])];
                this._selSo = [...(d.so_statuses || [])];
                this._populateMsPanel("por-wo-status-list", "por-wo-panel", "por-wo-label",
                    d.all_wo_statuses || [], this._selWo);
                this._populateMsPanel("por-so-status-list", "por-so-panel", "por-so-label",
                    d.all_so_statuses || [], this._selSo);
            }
        });

        // ── Warehouse list ─────────────────────────────────────────────
        frappe.db.get_list("Warehouse", {
            filters: { is_group: 0, disabled: 0 },
            fields: ["name"],
            limit: 200,
        }).then(rows => {
            const list = document.getElementById("por-wh-list");
            list.innerHTML = rows.map(w =>
                `<label class="por-ms-item">
                   <input type="checkbox" class="por-ms-chk" value="${this._esc(w.name)}">
                   ${this._esc(w.name)}
                 </label>`
            ).join("");
            this._updateMsLabel("por-wh-panel", "por-wh-label");
        });
    }

    // ── Event binding ─────────────────────────────────────────────────────
    _bindEvents() {
        // Load button
        document.getElementById("por-load-btn").addEventListener("click", () => this._loadData());

        // Tab switching
        document.querySelectorAll(".por-tab-btn").forEach(btn => {
            btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
        });

        // Planning mode toggle + sub-mode (Independent / Priority)
        const planToggle = document.getElementById("por-planning-toggle");
        const planSub    = document.getElementById("por-plan-submode");
        planToggle.addEventListener("change", () => {
            this._planMode = planToggle.checked;
            document.getElementById("por-planning-lbl").textContent = this._planMode ? "On" : "Off";
            // Show sub-mode selector only when Planning Mode is ON.
            planSub.style.display = this._planMode ? "" : "none";
            if (this._data) {
                if (this._planMode && planSub.value === "priority") {
                    this._recalcPriorityPossibleQty();
                }
                this._renderTable(this._data.items);
            }
        });
        planSub.addEventListener("change", () => {
            this._planSubmode = planSub.value;  // "independent" | "priority"
            if (this._data) {
                if (this._planSubmode === "priority") this._recalcPriorityPossibleQty();
                else this._restoreIndependentPossibleQty();
                this._renderTable(this._data.items);
            }
        });

        // Select-all checkbox
        document.getElementById("por-select-all").addEventListener("change", function () {
            document.querySelectorAll(".por-row-chk").forEach(c => c.checked = this.checked);
        });

        // Table delegation: item click, shortage view, cost, production plans
        const tbody = document.getElementById("por-tbody");
        tbody.addEventListener("click", (e) => {
            const ic   = e.target.closest(".por-ic");
            const view = e.target.closest(".por-view-shortage");
            const cost = e.target.closest(".por-cost-btn");
            const pp   = e.target.closest(".por-pp-btn");
            if (ic)   this._openItemModal(ic.dataset.code);
            if (view) this._openShortageModal(view.dataset.code);
            if (cost) this._openCostModal(cost.dataset.code);
            if (pp)   this._openPpModal(pp.dataset.code);
        });

        // Multi-select dropdown open/close
        document.addEventListener("click", (e) => {
            const btn = e.target.closest(".por-ms-btn");
            if (btn && btn.dataset.msPanel) {
                this._toggleDropdown(btn.dataset.msPanel, btn);
                return;
            }
            // All/None select actions
            const selAction = e.target.closest("[data-ms-select]");
            if (selAction) {
                const panelId = selAction.dataset.msSelect;
                const val     = selAction.dataset.val;
                this._selectAllMs(panelId, val === "all");
                return;
            }
            // Close dropdowns on outside click
            if (!e.target.closest(".por-ms-wrap")) {
                document.querySelectorAll(".por-ms-panel.open").forEach(p => p.classList.remove("open"));
                document.querySelectorAll(".por-ms-btn.active").forEach(b => b.classList.remove("active"));
            }
        });

        // Update label on checkbox change inside panels
        document.addEventListener("change", (e) => {
            if (e.target.classList.contains("por-ms-chk")) {
                const panel  = e.target.closest(".por-ms-panel");
                const panelId = panel ? panel.id : null;
                if (!panelId) return;
                if (panelId === "por-wh-panel")  this._updateMsLabel("por-wh-panel", "por-wh-label");
                if (panelId === "por-wo-panel")  this._updateMsLabel("por-wo-panel", "por-wo-label");
                if (panelId === "por-so-panel")  this._updateMsLabel("por-so-panel", "por-so-label");
            }
        });

        // Modal close via data-close-modal
        document.addEventListener("click", (e) => {
            const closeBtn = e.target.closest("[data-close-modal]");
            if (closeBtn) { this._closeModal(closeBtn.dataset.closeModal); return; }
            // Click outside modal content also closes
            const overlay = e.target.closest(".por-overlay");
            if (overlay && e.target === overlay) this._closeModal(overlay.id);
        });

        // Item group filter
        document.getElementById("por-grp-filter").addEventListener("change", (e) => {
            this._applyGroupFilter(e.target.value);
        });

        // Export buttons
        document.getElementById("por-export-csv").addEventListener("click", () => this._exportCSV());
        document.getElementById("por-export-excel").addEventListener("click", () => this._exportExcel());
    }

    // ── Tab switching ─────────────────────────────────────────────────────
    _switchTab(tab) {
        document.querySelectorAll(".por-tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
        const tabs = ["overview", "ai", "charts"];
        tabs.forEach(t => {
            const pane = document.getElementById(`por-pane-${t}`);
            pane.classList.toggle("por-pane-hidden", t !== tab);
        });
        if (tab === "charts" && !this._chartsLoaded && this._data) {
            this._loadCharts();
        }
    }

    // ── Load data ─────────────────────────────────────────────────────────
    _loadData() {
        const company = document.getElementById("por-company").value;
        if (!company) { frappe.msgprint("Please select a company."); return; }

        const month = document.getElementById("por-month").value;
        const year  = document.getElementById("por-year").value;

        this._selWo = this._getSelectedMs("por-wo-status-list");
        this._selSo = this._getSelectedMs("por-so-status-list");
        this._selWh = this._getSelectedMs("por-wh-list");

        this._showState("loading");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_production_overview",
            args: {
                company,
                month,
                year,
                warehouses: JSON.stringify(this._selWh),
                wo_statuses: JSON.stringify(this._selWo),
                so_statuses: JSON.stringify(this._selSo),
                stock_mode: document.getElementById("por-stock-mode").value,
                planning_mode: this._planMode ? 1 : 0,
            },
            callback: (r) => {
                if (!r.message) { this._showState("empty"); return; }
                this._data   = r.message;
                this._period = r.message.period;
                this._chartsLoaded = false;
                this._render(r.message);
                // Auto-fetch AI insight in background
                if (this._aiModel) this._fetchAutoInsight();
            },
            error: () => this._showState("empty"),
        });
    }

    // ── Render ────────────────────────────────────────────────────────────
    _render(data) {
        const { items, summary, period } = data;

        if (!items || items.length === 0) {
            this._showState("empty");
            return;
        }

        // Period badge
        const badge = document.getElementById("por-period-badge");
        badge.textContent = `${period.month_name} ${period.year}`;
        badge.style.display = "inline-block";

        // Summary cards
        this._renderSummary(summary);

        // Table
        this._renderTable(items);
        this._showState("table");

        // Item group filter
        this._buildGroupFilter(items);

        // Export buttons
        document.getElementById("por-export-csv").style.display   = "inline-flex";
        document.getElementById("por-export-excel").style.display = "inline-flex";
    }

    _renderSummary(s) {
        document.getElementById("por-s-total").textContent    = s.total_items;
        document.getElementById("por-s-shortage").textContent = s.items_with_shortage;
        document.getElementById("por-s-ok").textContent       = s.items_no_shortage;
        document.getElementById("por-s-planned").textContent  = this._formatNum(s.total_planned_qty);
        document.getElementById("por-s-orders").textContent   = this._formatNum(s.total_curr_orders);
        document.getElementById("por-s-dispatch").textContent = this._formatNum(s.total_dispatch);
        document.getElementById("por-summary-strip").style.display = "flex";
    }

    _renderTable(items) {
        const tbody = document.getElementById("por-tbody");
        tbody.innerHTML = items.map(item => this._buildRow(item)).join("");
        // Count badge
        document.getElementById("por-vis-count").textContent = items.length;
        document.getElementById("por-count-badge").style.display = "block";
    }

    _buildRow(item) {
        const code   = this._esc(item.item_code);
        const name   = this._esc(item.item_name);
        const group  = this._esc(item.item_group || "");
        const uom    = item.stock_uom || "";
        const conv   = item.uom_conversions || [];
        const pm     = this._planMode;

        const typeBadge = this._typeBadgeHtml(item.item_type);

        // Sub-Asm chip with hover-list of parent WOs (with shortage qty)
        let subAsmHtml = `<span style="color:var(--por-sl-300);font-size:11px;">—</span>`;
        if (item.is_sub_assembly) {
            const parents = item.sub_assembly_wos || [];
            const rows = parents.length
                ? parents.slice(0, 8).map(p => `
                    <div class="por-subasm-row">
                      <span style="font-family:monospace;color:var(--por-brand);">${this._esc(p.wo_name)}</span>
                      <span style="color:var(--por-muted);"> ← parent: ${this._esc(p.parent_item || "?")}</span>
                      <div style="font-size:10px;color:var(--por-sl-700);">
                        Need <strong>${this._formatNum(p.required_qty || 0)}</strong> ${this._esc(uom)}
                        for parent qty ${this._formatNum(p.parent_qty || 0)}
                        (PP: <span style="font-family:monospace;">${this._esc(p.production_plan || "")}</span>)
                      </div>
                    </div>`).join("")
                : `<div style="color:var(--por-muted);">No parent WO mapping found.</div>`;
            subAsmHtml = `<span class="por-subasm-wrap">
              <span class="por-subasm" title="Hover to see parent WO list and required qty">
                <i class="fa-solid fa-sitemap"></i> Sub-Asm (${parents.length})
              </span>
              <div class="por-subasm-list">
                <div style="font-weight:700;color:var(--por-sl-700);margin-bottom:4px;">Used in parent WOs:</div>
                ${rows}
              </div>
            </span>`;
        }

        const woChip = `<span class="por-wo-chip${item.open_wo_count ? "" : " zero"}"
            title="Open Work Orders for this item filtered by selected WO statuses. Click item code to see the list.">${item.open_wo_count}</span>`;

        const pvs = item.projection_vs_sales;
        const pvsHtml = !pvs
            ? `<span class="por-pvs-na" title="No Sales Projection set for this item this month.">—</span>`
            : pvs >= 1
                ? `<span class="por-pvs-hi" title="Total Sales ${this._formatNum(item.total_curr_sales)} ÷ Projection ${this._formatNum(item.curr_projection)} = ${(pvs * 100).toFixed(0)}% (≥100% = outperforming)">${(pvs * 100).toFixed(0)}%</span>`
                : `<span class="por-pvs-lo" title="Total Sales ${this._formatNum(item.total_curr_sales)} ÷ Projection ${this._formatNum(item.curr_projection)} = ${(pvs * 100).toFixed(0)}% (&lt;100% = below projection)">${(pvs * 100).toFixed(0)}%</span>`;

        // Coverage badge: (Projection + Prev SO) ÷ Total Curr Sales
        const cov = item.coverage_pct;
        const covTip = `(Projection ${this._formatNum(item.curr_projection)} + Prev Month SO ${this._formatNum(item.prev_month_order)}) ÷ Total Curr Sales ${this._formatNum(item.total_curr_sales)} × 100`;
        const covHtml = !item.total_curr_sales
            ? `<span class="por-cov-na" title="No current month sales — coverage undefined.">—</span>`
            : cov >= 100
                ? `<span class="por-cov-hi" title="${covTip} = ${cov}% — fully covered.">${cov}%</span>`
                : cov >= 60
                    ? `<span class="por-cov-mid" title="${covTip} = ${cov}% — partially covered.">${cov}%</span>`
                    : `<span class="por-cov-lo" title="${covTip} = ${cov}% — under-planned.">${cov}%</span>`;

        const shortageHtml = item.has_shortage
            ? `<span class="por-short-warn" title="Active BOM has component shortages. Click View for breakdown."><i class="fa-solid fa-triangle-exclamation"></i> Short</span>
               <button class="por-btn por-btn-err por-btn-sm por-view-shortage" style="margin-left:4px;" data-code="${code}"><i class="fa-solid fa-eye"></i> View</button>`
            : `<span class="por-short-ok" title="All active-BOM components have sufficient stock for the current possible qty."><i class="fa-solid fa-circle-check"></i> OK</span>`;

        const bomHtml = item.active_bom
            ? `<span class="por-bom-lnk" title="${this._esc(item.active_bom)}">${this._esc(item.active_bom.length > 20 ? item.active_bom.slice(0,18) + "…" : item.active_bom)}</span>`
            : `<span class="por-no-bom" title="No active default BOM. Possible Qty and Shortage cannot be calculated.">No BOM</span>`;

        // Production Plans cell — count chip + view button if any active PP
        const ppCount = item.pp_count || 0;
        const ppHtml = ppCount > 0
            ? `<span class="por-pp-chip" title="${ppCount} active Production Plan(s) contain this item">${ppCount}</span>
               <button class="por-btn por-btn-default por-btn-sm por-pp-btn" data-code="${code}" style="margin-left:4px;" title="View parent + child Work Orders for this item's Production Plans"><i class="fa-solid fa-eye"></i> Plan</button>`
            : `<span class="por-pp-chip zero" title="No active Production Plan contains this item">0</span>`;

        // Tooltip text per qty cell — explains the calculation
        const tipPlanned   = "Σ qty across open WOs (status filter applied)";
        const tipProduced  = "Σ Stock Entry Detail.transfer_qty for this month, is_finished_item=1, type=Manufacture";
        const tipPrevSO    = "Σ (stock_qty − delivered_qty × cf) on pending SOs with delivery_date in PREV month";
        const tipCurrSO    = "Σ (stock_qty − delivered_qty × cf) on pending SOs with delivery_date in CURR month";
        const tipPrevDisp  = "Σ Delivery Note Item.stock_qty in prev calendar month";
        const tipCurrDisp  = "Σ Delivery Note Item.stock_qty in curr calendar month";
        const tipProj      = "Sales Projected Items.qty_in_stock_uom for the curr-month Sales Projection";
        const tipTotalSales= "Σ Sales Order Item.stock_qty for curr month, submitted SOs only";
        const tipStock     = `Bin.${this._esc(document.getElementById("por-stock-mode").value === "expected" ? "actual_qty + ordered_qty + planned_qty" : "actual_qty")}`;
        const tipPossible  = "min(component_in_stock ÷ qty_per_unit) over all 1-level BOM components";

        return `<tr data-code="${code}" data-group="${group}" data-has-so="${item.has_open_so ? "1" : "0"}" class="${item.has_open_so ? "por-has-so" : ""}">
          <td class="por-col-s por-col-chk"><input type="checkbox" class="por-row-chk" data-code="${code}"></td>
          <td class="por-col-s por-col-item">
            <span class="por-ic" data-code="${code}" title="Click for full item detail (open WOs, sub-asm chain, batch consumption)">${code}</span>
            <span class="por-in" title="${name}">${name}</span>
          </td>
          <td>${typeBadge}</td>
          <td><span class="por-grp-cell" title="${group}">${group || "—"}</span></td>
          <td>${subAsmHtml}</td>
          <td style="text-align:center;">${woChip}</td>
          <td>${pm ? this._planInput(item.item_code, "planned_qty", item.planned_qty) : this._fmtQ(item.planned_qty, conv, uom, tipPlanned)}</td>
          <td>${this._fmtQ(item.actual_qty, conv, uom, tipProduced)}</td>
          <td>${this._fmtQ(item.prev_month_order, conv, uom, tipPrevSO)}</td>
          <td>${pm ? this._planInput(item.item_code, "curr_month_order", item.curr_month_order) : this._fmtQ(item.curr_month_order, conv, uom, tipCurrSO)}</td>
          <td>${this._fmtQ(item.prev_dispatch || 0, conv, uom, tipPrevDisp)}</td>
          <td>${this._fmtQ(item.curr_dispatch, conv, uom, tipCurrDisp)}</td>
          <td>${this._fmtQ(item.curr_projection, conv, uom, tipProj)}</td>
          <td>${this._fmtQ(item.total_curr_sales, conv, uom, tipTotalSales)}</td>
          <td>${pvsHtml}</td>
          <td>${covHtml}</td>
          <td>${this._fmtQ(item.stock, conv, uom, tipStock)}</td>
          <td class="por-shortage-cell">${shortageHtml}</td>
          <td>${this._fmtQ(item.possible_qty, conv, uom, tipPossible)}</td>
          <td>${bomHtml}</td>
          <td>${ppHtml}</td>
          <td>
            <button class="por-btn por-btn-cost por-btn-sm por-cost-btn" data-code="${code}" title="3-way cost (BOM std vs Actual STE vs 6-month avg) PLUS per-UOM cost breakdown">
              <i class="fa-solid fa-indian-rupee-sign"></i> Cost
            </button>
          </td>
        </tr>`;
    }

    _typeBadgeHtml(type) {
        const map = {
            "FG":    "por-tbadge-fg",
            "SFG":   "por-tbadge-sfg",
            "RM":    "por-tbadge-rm",
            "PM":    "por-tbadge-pm",
            "Other": "por-tbadge-other",
        };
        const cls = map[type] || "por-tbadge-other";
        return `<span class="por-tbadge ${cls}">${this._esc(type || "—")}</span>`;
    }

    // Stacked UOM quantity display.
    // - Always shows stock UOM as primary line.
    // - Shows top 2 UOM conversions inline; the FULL list (every UOM) is in
    //   the cell's `title=` so the user can hover to see all conversions and
    //   the calculation that produced the qty.
    _fmtQ(qty, uomConversions, stockUom, calcText) {
        const n = parseFloat(qty) || 0;
        const uomLabel = this._esc(stockUom || "");
        const allUoms = (uomConversions || []).filter(c => parseFloat(c.factor) > 0);
        // Build full-conversion tooltip text — every UOM, not just two.
        const tipLines = [`${this._formatNum(n)} ${stockUom || ""}  (stock UOM)`];
        for (const c of allUoms) {
            const f = parseFloat(c.factor);
            tipLines.push(`${this._formatNum(n / f)} ${c.uom}  (factor ${f})`);
        }
        if (calcText) tipLines.push("", `Calc: ${calcText}`);
        const tooltip = this._esc(tipLines.join("\n"));

        if (n === 0) {
            return `<span class="por-q por-q-zero" title="${tooltip}">0</span> <span class="por-q-uom">${uomLabel}</span>`;
        }
        let html = `<span class="por-q" title="${tooltip}">${this._formatNum(n)}</span> <span class="por-q-uom">${uomLabel}</span>`;
        // Inline render the FIRST 2 conversions (cell space limit) — full list
        // lives in the tooltip above.
        for (const c of allUoms.slice(0, 2)) {
            const f = parseFloat(c.factor);
            html += `<span class="por-q-sub" title="${tooltip}">${this._formatNum(n / f)} ${this._esc(c.uom)}</span>`;
        }
        return html;
    }

    _planInput(code, field, val) {
        const safeCode  = this._esc(code);
        const safeField = this._esc(field);
        const safeVal   = parseFloat(val) || 0;
        return `<input class="por-plan-inp" type="number" min="0"
                  data-code="${safeCode}" data-field="${safeField}" value="${safeVal}">`;
    }

    // ── Group filter ──────────────────────────────────────────────────────
    _buildGroupFilter(items) {
        const groups = [...new Set(items.map(i => i.item_group).filter(Boolean))].sort();
        const sel = document.getElementById("por-grp-filter");
        sel.innerHTML = `<option value="">All Groups</option>` +
            groups.map(g => `<option value="${this._esc(g)}">${this._esc(g)}</option>`).join("");
        document.getElementById("por-grp-filter-wrap").style.display = "block";
    }

    _applyGroupFilter(group) {
        let visible = 0;
        document.querySelectorAll("#por-tbody tr").forEach(tr => {
            const show = !group || tr.dataset.group === group;
            tr.style.display = show ? "" : "none";
            if (show) visible++;
        });
        document.getElementById("por-vis-count").textContent = visible;
    }

    // ── Show/hide state panels ─────────────────────────────────────────────
    _showState(state) {
        const states = { loading: "por-loading", empty: "por-empty", init: "por-init-msg", table: "por-table-wrap" };
        Object.values(states).forEach(id => document.getElementById(id).classList.add("por-pane-hidden"));
        if (states[state]) document.getElementById(states[state]).classList.remove("por-pane-hidden");
    }

    // ── Item Detail Modal ─────────────────────────────────────────────────
    _openItemModal(itemCode) {
        const modal = document.getElementById("por-item-modal");
        const body  = document.getElementById("por-item-modal-body");
        const title = document.getElementById("por-item-modal-title");
        title.textContent = itemCode;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading…</p></div>`;
        modal.classList.add("open");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_item_detail",
            args: {
                item_code: itemCode,
                company: document.getElementById("por-company").value,
                month:   document.getElementById("por-month").value,
                year:    document.getElementById("por-year").value,
                warehouses:  JSON.stringify(this._selWh),
                stock_mode:  document.getElementById("por-stock-mode").value,
                wo_statuses: JSON.stringify(this._selWo),
            },
            callback: (r) => {
                if (!r.message) { body.innerHTML = "<p>No detail available.</p>"; return; }
                const d = r.message;
                title.textContent = `${d.item_code} — ${d.item_name}`;
                body.innerHTML = this._buildItemDetailHtml(d);
            },
            error: () => { body.innerHTML = "<p>Error loading detail.</p>"; },
        });
    }

    _buildItemDetailHtml(d) {
        const uom  = d.stock_uom || "";
        const conv = d.uom_conversions || [];

        let html = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
          <div class="por-sum-card info" style="min-width:140px;">
            <div class="por-sum-num">${this._fmtQ(d.current_stock, conv, uom)}</div>
            <div class="por-sum-lbl">Current Stock</div>
          </div>
          <div class="por-sum-card brand" style="min-width:140px;">
            <div class="por-sum-num">${d.work_orders ? d.work_orders.length : 0}</div>
            <div class="por-sum-lbl">Open Work Orders</div>
          </div>
        </div>`;

        if (d.work_orders && d.work_orders.length > 0) {
            html += `<div class="por-sec-hdr"><i class="fa-solid fa-hammer"></i> Work Orders</div>
            <table class="por-dtable">
              <thead><tr>
                <th>WO</th><th>Status</th><th>Planned Qty</th><th>Produced</th><th>BOM</th><th>Start</th><th>End</th>
              </tr></thead><tbody>`;

            for (const wo of d.work_orders) {
                const stCls = { "Not Started":"por-wo-st-ns","In Process":"por-wo-st-ip",
                    "Material Transferred":"por-wo-st-mt","Completed":"por-wo-st-done" }[wo.status] || "por-wo-st-ns";
                html += `<tr>
                  <td><span class="por-bom-lnk">${this._esc(wo.wo_name)}</span></td>
                  <td><span class="por-wo-st ${stCls}">${this._esc(wo.status)}</span></td>
                  <td>${this._fmtQ(wo.qty_to_manufacture, conv, uom)}</td>
                  <td>${this._fmtQ(wo.produced_qty, conv, uom)}</td>
                  <td style="font-size:10px;color:var(--por-brand);">${this._esc(wo.bom_no || "—")}</td>
                  <td style="font-size:11px;">${wo.planned_start || "—"}</td>
                  <td style="font-size:11px;">${wo.planned_end || "—"}</td>
                </tr>`;

                // Sub-assembly WOs
                if (wo.sub_assembly_wos && wo.sub_assembly_wos.length > 0) {
                    html += `<tr><td colspan="7" style="padding:4px 9px;background:var(--por-sl-50);">
                      <span style="font-size:11px;font-weight:600;color:var(--por-sl-700);">
                        <i class="fa-solid fa-sitemap" style="color:var(--por-warn);"></i> Sub-Assembly WOs:
                      </span>
                      <div class="por-sub-chips">${wo.sub_assembly_wos.map(w =>
                          `<span class="por-sub-chip">${this._esc(w)}</span>`).join("")}
                      </div>
                    </td></tr>`;
                }

                // Component shortage summary
                if (wo.components && wo.components.length > 0) {
                    const shortComps = wo.components.filter(c => c.shortage > 0);
                    if (shortComps.length > 0) {
                        html += `<tr><td colspan="7" style="padding:4px 9px;background:#fff8f8;">
                          <span style="font-size:11px;font-weight:600;color:var(--por-err-text);">
                            <i class="fa-solid fa-triangle-exclamation"></i> ${shortComps.length} component(s) short:
                          </span>
                          ${shortComps.slice(0,5).map(c =>
                              `<span style="font-size:11px;margin:0 4px;color:var(--por-err-text);">
                                ${this._esc(c.item_code)}: need ${this._formatNum(c.required)}, have ${this._formatNum(c.in_stock)}
                               </span>`).join(" | ")}
                        </td></tr>`;
                    }
                }

                // Batch consumption
                if (wo.batch_consumption && wo.batch_consumption.length > 0) {
                    html += `<tr><td colspan="7" style="padding:4px 9px;background:var(--por-sl-50);">
                      <span style="font-size:11px;font-weight:600;color:var(--por-sl-700);">
                        <i class="fa-solid fa-boxes-stacked"></i> Batch Consumption:
                      </span>
                      <table style="font-size:11px;border-collapse:collapse;margin-top:4px;">
                        <tr style="background:var(--por-sl-100);">
                          <th style="padding:3px 7px;border:1px solid var(--por-sl-200);">Material</th>
                          <th style="padding:3px 7px;border:1px solid var(--por-sl-200);">Batch</th>
                          <th style="padding:3px 7px;border:1px solid var(--por-sl-200);">Qty Consumed</th>
                          <th style="padding:3px 7px;border:1px solid var(--por-sl-200);">Date</th>
                        </tr>
                        ${wo.batch_consumption.slice(0,10).map(b =>
                            `<tr>
                              <td style="padding:3px 7px;border:1px solid var(--por-sl-200);">${this._esc(b.item_code || "")}</td>
                              <td style="padding:3px 7px;border:1px solid var(--por-sl-200);font-family:monospace;">${this._esc(b.batch_no || "—")}</td>
                              <td style="padding:3px 7px;border:1px solid var(--por-sl-200);font-family:monospace;">${this._formatNum(b.qty)}</td>
                              <td style="padding:3px 7px;border:1px solid var(--por-sl-200);font-size:10px;">${this._esc(b.posting_date || "")}</td>
                            </tr>`).join("")}
                      </table>
                    </td></tr>`;
                }
            }
            html += `</tbody></table>`;
        } else {
            html += `<div style="color:var(--por-muted);font-size:13px;padding:12px 0;">No open Work Orders found for this item.</div>`;
        }

        return html;
    }

    // ── Shortage Modal ────────────────────────────────────────────────────
    _openShortageModal(itemCode) {
        const modal = document.getElementById("por-shortage-modal");
        const body  = document.getElementById("por-shortage-modal-body");
        const title = document.getElementById("por-shortage-modal-title");
        title.textContent = `Shortage: ${itemCode}`;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading…</p></div>`;
        modal.classList.add("open");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_shortage_detail",
            args: {
                item_code:   itemCode,
                warehouses:  JSON.stringify(this._selWh),
                stock_mode:  document.getElementById("por-stock-mode").value,
                wo_statuses: JSON.stringify(this._selWo),
            },
            callback: (r) => {
                if (!r.message) { body.innerHTML = "<p>No shortage data.</p>"; return; }
                body.innerHTML = this._buildShortageHtml(r.message, itemCode);
            },
            error: () => { body.innerHTML = "<p>Error loading shortage detail.</p>"; },
        });
    }

    _buildShortageHtml(data, itemCode) {
        const { by_wo, aggregated } = data;

        let html = `<div class="por-sec-hdr"><i class="fa-solid fa-layer-group"></i> Aggregated Shortage (sorted by value)</div>`;
        if (aggregated && aggregated.length > 0) {
            html += `<table class="por-dtable">
              <thead><tr>
                <th>Component</th><th>Required</th><th>In Stock</th><th>Shortage</th><th>WO Count</th><th>Open Docs</th>
              </tr></thead><tbody>`;
            for (const a of aggregated) {
                const uomC = a.uom_conversions || [];
                html += `<tr class="por-short-row-bad">
                  <td><span style="font-family:monospace;font-size:11px;color:var(--por-brand);">${this._esc(a.item_code)}</span>
                    <span style="display:block;font-size:10px;color:var(--por-muted);">${this._esc(a.item_name || "")}</span>
                  </td>
                  <td>${this._fmtQ(a.total_required, uomC, a.stock_uom)}</td>
                  <td>${this._fmtQ(a.in_stock, uomC, a.stock_uom)}</td>
                  <td style="font-weight:700;color:var(--por-err-text);">${this._fmtQ(a.shortage, uomC, a.stock_uom)}</td>
                  <td style="text-align:center;">${a.wo_count}</td>
                  <td>${(a.open_docs || []).slice(0,3).map(d => `<span class="por-open-doc">${this._esc(d)}</span>`).join(" ")}</td>
                </tr>`;
            }
            html += `</tbody></table>`;
        } else {
            html += `<div style="color:var(--por-ok-text);font-size:13px;padding:10px 0;">
              <i class="fa-solid fa-circle-check"></i> No component shortages found for ${this._esc(itemCode)}.
            </div>`;
        }

        if (by_wo && by_wo.length > 0) {
            html += `<div class="por-sec-hdr" style="margin-top:14px;"><i class="fa-solid fa-hammer"></i> Breakdown by Work Order</div>`;
            for (const wo of by_wo) {
                html += `<div style="font-size:11px;font-weight:600;color:var(--por-sl-700);margin:8px 0 4px;">
                  WO: <span style="font-family:monospace;color:var(--por-brand);">${this._esc(wo.wo_name)}</span>
                  — Qty: ${this._formatNum(wo.qty_to_manufacture)}
                  <span class="por-wo-st por-wo-st-ip" style="margin-left:6px;">${this._esc(wo.status)}</span>
                </div>`;
                if (wo.short_components && wo.short_components.length > 0) {
                    html += `<table class="por-dtable" style="margin-bottom:8px;">
                      <thead><tr><th>Component</th><th>Required</th><th>In Stock</th><th>Shortage</th></tr></thead>
                      <tbody>`;
                    for (const c of wo.short_components) {
                        html += `<tr>
                          <td style="font-family:monospace;font-size:11px;">${this._esc(c.item_code)}</td>
                          <td>${this._formatNum(c.required)} <span style="font-size:10px;color:var(--por-muted);">${this._esc(c.uom || "")}</span></td>
                          <td>${this._formatNum(c.in_stock)}</td>
                          <td style="color:var(--por-err-text);font-weight:700;">${this._formatNum(c.shortage)}</td>
                        </tr>`;
                    }
                    html += `</tbody></table>`;
                } else {
                    html += `<div style="font-size:11px;color:var(--por-ok-text);padding:4px 0;"><i class="fa-solid fa-circle-check"></i> No shortages for this WO.</div>`;
                }
            }
        }

        return html;
    }

    // ── Cost Modal ────────────────────────────────────────────────────────
    _openCostModal(itemCode) {
        const modal = document.getElementById("por-cost-modal");
        const body  = document.getElementById("por-cost-modal-body");
        const title = document.getElementById("por-cost-modal-title");
        title.textContent = `Cost Breakup: ${itemCode}`;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading…</p></div>`;
        modal.classList.add("open");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_cost_breakup",
            args: {
                item_code: itemCode,
                company:   document.getElementById("por-company").value,
                month:     document.getElementById("por-month").value,
                year:      document.getElementById("por-year").value,
            },
            callback: (r) => {
                if (!r.message) { body.innerHTML = "<p>No cost data.</p>"; return; }
                body.innerHTML = this._buildCostHtml(r.message);
            },
            error: () => { body.innerHTML = "<p>Error loading cost data.</p>"; },
        });
    }

    _buildCostHtml(d) {
        const bom  = d.bom_standard || {};
        const act  = d.actual_consumed || {};
        const hist = d.historical_avg || {};
        const varPct = d.variance_pct || 0;
        const varCls = varPct > 10 ? "over" : varPct < -10 ? "under" : "";
        const varColor = varPct > 10 ? "por-var-over" : varPct < -10 ? "por-var-under" : "";

        let html = `<div class="por-cost-strip">
          <div class="por-cost-card std">
            <div class="por-cost-num">₹${this._formatNum(bom.total || 0)}</div>
            <div class="por-cost-lbl">BOM Standard (per batch)</div>
          </div>
          <div class="por-cost-card act">
            <div class="por-cost-num">₹${this._formatNum(act.total || 0)}</div>
            <div class="por-cost-lbl">Actual Consumed (curr month STE)</div>
          </div>
          <div class="por-cost-card ${varCls || "std"}">
            <div class="por-cost-num">
              <span class="${varColor}">${varPct > 0 ? "+" : ""}${varPct}%</span>
            </div>
            <div class="por-cost-lbl">Variance (Actual vs BOM Std)</div>
          </div>
          <div class="por-cost-card">
            <div class="por-cost-num">₹${this._formatNum(hist.avg_per_run || 0)}</div>
            <div class="por-cost-lbl">Hist. Avg (${hist.months_data || 0} months)</div>
          </div>
        </div>`;

        // Per-UOM cost — shows ₹/Stock-UOM AND ₹/each-conversion-UOM side by side.
        // Source: API now returns cost_per_uom for the active BOM × actual STE consumed.
        const cpu = d.cost_per_uom || [];
        if (cpu.length > 0) {
            html += `<div class="por-sec-hdr"><i class="fa-solid fa-ruler-combined"></i> Cost per UOM (default + all conversions)</div>
            <div style="font-size:11px;color:var(--por-muted);margin-bottom:6px;">
              For every UOM the item supports (UOM Conversion Detail), shows BOM standard ₹/unit and Actual STE ₹/unit.
              Useful when selling in Pcs but costing in Kg.
            </div>
            <table class="por-dtable">
              <thead><tr><th>UOM</th><th>Factor</th><th>BOM Std (₹/unit)</th><th>Actual (₹/unit)</th><th>Variance %</th></tr></thead>
              <tbody>`;
            for (const u of cpu) {
                const v = parseFloat(u.variance_pct) || 0;
                const vClr = v > 10 ? "var(--por-err-text)" : v < -10 ? "var(--por-ok-text)" : "var(--por-muted)";
                html += `<tr>
                    <td><strong>${this._esc(u.uom || "")}</strong>${u.factor === 1 ? ` <span style="font-size:10px;color:var(--por-muted);">(stock UOM)</span>` : ""}</td>
                    <td style="font-family:monospace;">${this._formatNum(u.factor)}</td>
                    <td style="font-family:monospace;">₹${this._formatNum(u.bom_std)}</td>
                    <td style="font-family:monospace;">₹${this._formatNum(u.actual)}</td>
                    <td style="font-family:monospace;font-weight:700;color:${vClr};">${v > 0 ? "+" : ""}${v}%</td>
                  </tr>`;
            }
            html += `</tbody></table>`;
        }

        // BOM standard breakdown
        if (bom.components && bom.components.length > 0) {
            html += `<div class="por-sec-hdr"><i class="fa-solid fa-file-invoice"></i> BOM Standard Cost</div>
            <div style="font-size:11px;color:var(--por-muted);margin-bottom:6px;">Source: <code>tabBOM Item</code> × <code>tabItem.valuation_rate</code></div>
            <table class="por-dtable">
              <thead><tr><th>Component</th><th>Qty/Unit</th><th>UOM</th><th>Rate (₹)</th><th>Amount (₹)</th></tr></thead>
              <tbody>`;
            for (const c of bom.components) {
                html += `<tr>
                  <td style="font-family:monospace;font-size:11px;">${this._esc(c.item_code)}<span style="display:block;font-size:10px;color:var(--por-muted);">${this._esc(c.item_name || "")}</span></td>
                  <td style="font-family:monospace;">${this._formatNum(c.qty)}</td>
                  <td>${this._esc(c.uom || "")}</td>
                  <td style="font-family:monospace;">₹${this._formatNum(c.rate)}</td>
                  <td style="font-family:monospace;font-weight:600;">₹${this._formatNum(c.amount)}</td>
                </tr>`;
            }
            html += `</tbody><tfoot>
              <tr style="font-weight:700;background:var(--por-sl-100);">
                <td colspan="4">Total BOM Standard Cost</td>
                <td style="font-family:monospace;">₹${this._formatNum(bom.total)}</td>
              </tr>
            </tfoot></table>`;
        }

        // Actual consumed
        if (act.components && act.components.length > 0) {
            html += `<div class="por-sec-hdr"><i class="fa-solid fa-scale-balanced"></i> Actual Consumed (Current Month)</div>
            <div style="font-size:11px;color:var(--por-muted);margin-bottom:6px;">
              Source: <code>tabStock Entry Detail</code> — Manufacture STEs this month.
              Produced qty: <strong>${this._formatNum(act.qty_produced || 0)}</strong>
            </div>
            <table class="por-dtable">
              <thead><tr><th>Material</th><th>Consumed</th><th>UOM</th><th>Avg Rate (₹)</th><th>Total (₹)</th></tr></thead>
              <tbody>`;
            for (const c of act.components) {
                html += `<tr>
                  <td style="font-family:monospace;font-size:11px;">${this._esc(c.item_code)}<span style="display:block;font-size:10px;color:var(--por-muted);">${this._esc(c.item_name || "")}</span></td>
                  <td style="font-family:monospace;">${this._formatNum(c.qty)}</td>
                  <td>${this._esc(c.uom || "")}</td>
                  <td style="font-family:monospace;">₹${this._formatNum(c.rate)}</td>
                  <td style="font-family:monospace;font-weight:600;">₹${this._formatNum(c.amount)}</td>
                </tr>`;
            }
            html += `</tbody><tfoot>
              <tr style="font-weight:700;background:var(--por-sl-100);">
                <td colspan="4">Total Actual Consumed</td>
                <td style="font-family:monospace;">₹${this._formatNum(act.total)}</td>
              </tr>
            </tfoot></table>`;
        } else {
            html += `<div class="por-sec-hdr"><i class="fa-solid fa-scale-balanced"></i> Actual Consumed</div>
            <div style="color:var(--por-muted);font-size:12px;padding:8px 0;">No Stock Entry (Manufacture) found for this item in the current month — WO may not have started yet.</div>`;
        }

        return html;
    }

    // ── Production Plans Modal ────────────────────────────────────────────
    _openPpModal(itemCode) {
        const modal = document.getElementById("por-pp-modal");
        const body  = document.getElementById("por-pp-modal-body");
        const title = document.getElementById("por-pp-modal-title");
        title.textContent = `Production Plans: ${itemCode}`;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading…</p></div>`;
        modal.classList.add("open");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_active_production_plans",
            args: { item_code: itemCode },
            callback: (r) => {
                if (!r.message) { body.innerHTML = "<p>No active Production Plans.</p>"; return; }
                body.innerHTML = this._buildPpHtml(r.message);
            },
            error: () => { body.innerHTML = "<p>Error loading Production Plans.</p>"; },
        });
    }

    _buildPpHtml(d) {
        const plans = d.plans || [];
        if (plans.length === 0) {
            return `<div class="por-state-box"><i class="fa-solid fa-inbox"></i>
                    <p>No active Production Plans contain item <code>${this._esc(d.item_code)}</code>.</p></div>`;
        }
        let html = `<div style="font-size:11px;color:var(--por-muted);margin-bottom:10px;">
            <i class="fa-solid fa-circle-info"></i>
            Plans below are taken directly from ERPNext (<code>tabProduction Plan Item</code>).
            Each card shows the parent + child Work Orders that the plan generated.
        </div>`;
        for (const p of plans) {
            html += `<div class="por-pp-card">
                <div class="por-pp-card-hdr">
                  <i class="fa-solid fa-clipboard-list" style="color:var(--por-brand);"></i>
                  <span style="font-family:monospace;">${this._esc(p.pp_name)}</span>
                  <span class="por-wo-st por-wo-st-ip" title="Production Plan status">${this._esc(p.status)}</span>
                  <span style="color:var(--por-muted);font-weight:400;font-size:11px;">${this._esc(p.posting_date)}</span>
                  <span class="por-pp-tag por-pp-other" style="margin-left:auto;">Created by: ${this._esc(p.created_by)}</span>
                </div>`;
            if (p.creation_reason) {
                html += `<div style="font-size:11px;color:var(--por-sl-700);margin-bottom:6px;background:var(--por-surface);padding:5px 8px;border-radius:4px;border:1px solid var(--por-sl-200);">${this._esc(p.creation_reason)}</div>`;
            }
            const wos = p.work_orders || [];
            if (wos.length === 0) {
                html += `<div style="font-size:11px;color:var(--por-muted);">No Work Orders generated yet.</div>`;
            } else {
                html += `<table class="por-dtable" style="margin-bottom:0;">
                    <thead><tr>
                      <th>Role</th><th>Work Order</th><th>Production Item</th>
                      <th>Planned</th><th>Produced</th><th>Status</th><th>Start</th>
                    </tr></thead><tbody>`;
                for (const w of wos) {
                    const role = w.is_target_item
                        ? `<span class="por-pp-tag por-pp-target">Target</span>`
                        : `<span class="por-pp-tag por-pp-other">Other</span>`;
                    html += `<tr>
                        <td>${role}</td>
                        <td><span style="font-family:monospace;color:var(--por-brand);">${this._esc(w.wo_name)}</span></td>
                        <td>${this._esc(w.production_item)}</td>
                        <td style="font-family:monospace;">${this._formatNum(w.planned_qty)}</td>
                        <td style="font-family:monospace;">${this._formatNum(w.produced_qty)}</td>
                        <td><span class="por-wo-st por-wo-st-ip">${this._esc(w.status)}</span></td>
                        <td style="font-size:11px;">${this._esc(w.planned_start_date || "—")}</td>
                      </tr>`;
                }
                html += `</tbody></table>`;
            }
            html += `</div>`;
        }
        return html;
    }

    // ── Planning Mode (Independent / Priority) ────────────────────────────
    // Independent: each item checked against the FULL stock pool (the default
    //              `possible_qty` from the API).
    // Priority: items consume stock in row order; an item earlier in the list
    //           takes precedence over later items competing for the same RM.
    //           Pure client-side sim — server data unchanged.
    _recalcPriorityPossibleQty() {
        if (!this._data || !this._data.items) return;
        // Persist the original possible_qty once so we can restore it.
        this._data.items.forEach(it => {
            if (it._origPossibleQty === undefined) {
                it._origPossibleQty = it.possible_qty;
            }
        });
        // Build a virtual stock pool from each item's shortage_components
        // (already returned by the API). For each item in row order, deduct
        // its consumed components and recompute the producible qty.
        const pool = {};
        const rows = this._data.items;
        for (const it of rows) {
            const comps = it.shortage_components || [];
            // possibleQty bound = current pool ÷ qty_per_unit; we approximate
            // qty_per_unit from required ÷ original possible_qty (if non-zero).
            let limit = it._origPossibleQty || 0;
            for (const c of comps) {
                const have = pool[c.item_code];
                const onHand = (have === undefined ? c.in_stock : have);
                const reqPerUnit = (it._origPossibleQty > 0 && c.required > 0)
                    ? c.required / it._origPossibleQty : 0;
                if (reqPerUnit > 0) {
                    limit = Math.min(limit, onHand / reqPerUnit);
                }
            }
            limit = Math.max(0, Math.floor(limit));
            it.possible_qty = limit;
            // Deduct from pool
            for (const c of comps) {
                const reqPerUnit = (it._origPossibleQty > 0 && c.required > 0)
                    ? c.required / it._origPossibleQty : 0;
                if (reqPerUnit > 0) {
                    const have = pool[c.item_code];
                    pool[c.item_code] = (have === undefined ? c.in_stock : have) - reqPerUnit * limit;
                }
            }
        }
    }

    _restoreIndependentPossibleQty() {
        if (!this._data || !this._data.items) return;
        this._data.items.forEach(it => {
            if (it._origPossibleQty !== undefined) it.possible_qty = it._origPossibleQty;
        });
    }

    // ── Modal helpers ─────────────────────────────────────────────────────
    _closeModal(modalId) {
        const el = document.getElementById(modalId);
        if (el) el.classList.remove("open");
    }

    // ── Multi-select helpers ──────────────────────────────────────────────
    _populateMsPanel(listId, panelId, labelId, allOptions, defaults) {
        const container = document.getElementById(listId);
        if (!container) return;
        container.innerHTML = allOptions.map(opt =>
            `<label class="por-ms-item">
               <input type="checkbox" class="por-ms-chk" value="${this._esc(opt)}"${defaults.includes(opt) ? " checked" : ""}>
               ${this._esc(opt)}
             </label>`
        ).join("");
        this._updateMsLabel(panelId, labelId);
    }

    _toggleDropdown(panelId, triggerBtn) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        // Close other panels
        document.querySelectorAll(".por-ms-panel.open").forEach(p => {
            if (p.id !== panelId) {
                p.classList.remove("open");
                const btn = document.querySelector(`[data-ms-panel="${p.id}"]`);
                if (btn) btn.classList.remove("active");
            }
        });
        panel.classList.toggle("open");
        if (triggerBtn) triggerBtn.classList.toggle("active", panel.classList.contains("open"));
    }

    _selectAllMs(panelId, checked) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        panel.querySelectorAll(".por-ms-chk").forEach(c => c.checked = checked);
        // Determine label ID from panel ID
        const labelMap = { "por-wh-panel":"por-wh-label", "por-wo-panel":"por-wo-label", "por-so-panel":"por-so-label" };
        this._updateMsLabel(panelId, labelMap[panelId]);
    }

    _updateMsLabel(panelId, labelId) {
        const panel = document.getElementById(panelId);
        const label = document.getElementById(labelId);
        if (!panel || !label) return;
        const all     = panel.querySelectorAll(".por-ms-chk");
        const checked = panel.querySelectorAll(".por-ms-chk:checked");
        if (checked.length === 0 || checked.length === all.length) {
            label.textContent = labelId === "por-wh-label" ? "All" : "Default";
            const btn = document.querySelector(`[data-ms-panel="${panelId}"]`);
            if (btn) btn.classList.remove("active");
        } else {
            label.textContent = `${checked.length} selected`;
            const btn = document.querySelector(`[data-ms-panel="${panelId}"]`);
            if (btn) btn.classList.add("active");
        }
    }

    _getSelectedMs(listId) {
        const list = document.getElementById(listId);
        if (!list) return [];
        const all     = list.querySelectorAll(".por-ms-chk");
        const checked = list.querySelectorAll(".por-ms-chk:checked");
        // If all checked or none checked → treat as "all" → return []
        if (checked.length === 0 || checked.length === all.length) return [];
        return Array.from(checked).map(c => c.value);
    }

    // ── AI Panel ──────────────────────────────────────────────────────────
    _initAIPanel() {
        // Session ID
        let sessionId = sessionStorage.getItem("por_ai_session");
        if (!sessionId) {
            sessionId = "por_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2);
            sessionStorage.setItem("por_ai_session", sessionId);
        }
        document.getElementById("por-ai-session").value = sessionId;

        // Load model list
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_deepseek_models_por",
            callback: (r) => {
                if (!r.message) return;
                const models = r.message;
                const sel = document.getElementById("por-ai-model");
                sel.innerHTML = "";
                for (const [id, cfg] of Object.entries(models)) {
                    const opt = document.createElement("option");
                    opt.value = id;
                    opt.textContent = cfg.name || id;
                    sel.appendChild(opt);
                }
                this._aiModel = sel.value;
                this._updateCostHint();
                sel.addEventListener("change", () => {
                    this._aiModel = sel.value;
                    this._updateCostHint();
                });
            },
        });

        // Refresh insight button
        document.getElementById("por-ai-refresh").addEventListener("click", () => {
            if (this._data) this._fetchAutoInsight();
            else frappe.show_alert({ message: "Load production data first.", indicator: "orange" });
        });

        // Test connection
        document.getElementById("por-ai-test").addEventListener("click", () => this._testAI());

        // Chat send
        document.getElementById("por-ai-send").addEventListener("click", () => this._sendAIFromInput());
        document.getElementById("por-ai-input").addEventListener("keydown", (e) => {
            if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); this._sendAIFromInput(); }
        });

        // FAQ chips
        document.querySelectorAll(".por-faq-chip").forEach(chip => {
            chip.addEventListener("click", () => this._sendAIMessage(chip.textContent.trim()));
        });
    }

    _updateCostHint() {
        // Model cost hint (populated from model data if available)
        const hint = document.getElementById("por-ai-cost-hint");
        if (hint) hint.textContent = "";
    }

    _buildAIContext() {
        if (!this._data) return {};
        const { summary, period } = this._data;
        // Top 20 items sorted by shortage-first then by curr_month_order
        const topItems = [...this._data.items]
            .sort((a, b) => {
                if (a.has_shortage && !b.has_shortage) return -1;
                if (!a.has_shortage && b.has_shortage) return 1;
                return (b.curr_month_order || 0) - (a.curr_month_order || 0);
            })
            .slice(0, 20)
            .map(i => ({
                item_code:         i.item_code,
                item_name:         i.item_name,
                item_type:         i.item_type,
                stock_uom:         i.stock_uom,
                open_wo_count:     i.open_wo_count,
                planned_qty:       i.planned_qty,
                actual_qty:        i.actual_qty,
                curr_month_order:  i.curr_month_order,
                curr_projection:   i.curr_projection,
                stock:             i.stock,
                has_shortage:      i.has_shortage,
                possible_qty:      i.possible_qty,
                projection_vs_sales: i.projection_vs_sales,
            }));

        return {
            summary,
            period,
            items: topItems,
            company:    document.getElementById("por-company").value,
            stock_mode: document.getElementById("por-stock-mode").value,
        };
    }

    _fetchAutoInsight() {
        const ctx  = this._buildAIContext();
        this._aiContext = ctx;
        const body = document.getElementById("por-ai-insight-body");
        body.innerHTML = `<div class="por-ai-typing"><i class="fa-solid fa-circle-notch fa-spin"></i> Generating briefing…</div>`;

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_ai_overview_insight",
            args: { context_json: JSON.stringify(ctx), model: this._aiModel },
            callback: (r) => {
                if (!r.message) return;
                const { insight } = r.message;
                body.innerHTML = insight || `<span class="por-ai-warn">No insight returned.</span>`;
                document.getElementById("por-ai-data-pts").textContent =
                    `Data: ${ctx.summary?.total_items || 0} items, ${ctx.items?.length || 0} sent to AI`;
            },
            error: () => {
                body.innerHTML = `<span class="por-ai-warn">AI unavailable. Check Error Log → POR AI.</span>`;
            },
        });
    }

    _sendAIFromInput() {
        const input = document.getElementById("por-ai-input");
        const msg   = (input.value || "").trim();
        if (!msg) return;
        input.value = "";
        this._sendAIMessage(msg);
    }

    _sendAIMessage(text) {
        if (!text) return;
        if (!this._aiContext && this._data) this._aiContext = this._buildAIContext();

        // Show user bubble
        this._appendBubble("user", this._esc(text));
        this._setTyping(true);

        const sessionId = document.getElementById("por-ai-session").value;

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.chat_with_overview_advisor",
            args: {
                message:      text,
                session_id:   sessionId,
                context_json: JSON.stringify(this._aiContext || {}),
                model:        this._aiModel,
            },
            callback: (r) => {
                this._setTyping(false);
                if (!r.message) return;
                this._appendBubble("asst", r.message.reply || "…", true);
            },
            error: () => {
                this._setTyping(false);
                this._appendBubble("asst", `<span class="por-ai-warn">Error communicating with AI.</span>`, true);
            },
        });
    }

    _appendBubble(role, content, isHtml) {
        const msgs = document.getElementById("por-ai-msgs");
        const div  = document.createElement("div");
        div.className = `por-ai-bubble ${role}`;
        if (isHtml) div.innerHTML = content;
        else        div.textContent = content;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
    }

    _setTyping(on) {
        const existing = document.getElementById("por-ai-typing-indicator");
        if (on && !existing) {
            const div = document.createElement("div");
            div.id = "por-ai-typing-indicator";
            div.className = "por-ai-typing";
            div.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> AI is thinking…`;
            document.getElementById("por-ai-msgs").appendChild(div);
        } else if (!on && existing) {
            existing.remove();
        }
    }

    _testAI() {
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.test_ai_connection_por",
            callback: (r) => {
                const d = r.message || {};
                frappe.show_alert({
                    message: d.ok ? `AI connected: ${d.message}` : `AI error: ${d.message}`,
                    indicator: d.ok ? "green" : "red",
                });
            },
        });
    }

    // ── Charts ────────────────────────────────────────────────────────────
    _loadCharts() {
        if (typeof Chart === "undefined") {
            console.warn("POR: Chart.js not loaded (CDN timeout?). Charts unavailable.");
            return;
        }
        const company = document.getElementById("por-company").value;
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_chart_data",
            args: {
                company,
                month:       document.getElementById("por-month").value,
                year:        document.getElementById("por-year").value,
                warehouses:  JSON.stringify(this._selWh),
                wo_statuses: JSON.stringify(this._selWo),
                so_statuses: JSON.stringify(this._selSo),
                stock_mode:  document.getElementById("por-stock-mode").value,
            },
            callback: (r) => {
                if (!r.message) return;
                document.getElementById("por-charts-empty").style.display = "none";
                document.getElementById("por-charts-content").style.display = "grid";
                this._renderCharts(r.message);
                this._chartsLoaded = true;
            },
        });
    }

    _renderCharts(d) {
        const PIE_COLORS  = ["#4f46e5","#10b981","#f59e0b","#ef4444","#0ea5e9","#8b5cf6","#ec4899","#14b8a6"];
        const CHART_DEFAULTS = { animation: { duration: 400 }, plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } } };

        // ── Pie 1: Item type distribution
        const typeD = d.type_pie || {};
        this._makeChart("por-chart-type", "doughnut", {
            labels: Object.keys(typeD),
            datasets: [{ data: Object.values(typeD), backgroundColor: PIE_COLORS, borderWidth: 2, borderColor: "#fff" }]
        }, { ...CHART_DEFAULTS });

        // ── Pie 2: Shortage
        const shortD = d.shortage_pie || {};
        this._makeChart("por-chart-shortage", "doughnut", {
            labels: ["With Shortage","No Shortage"],
            datasets: [{ data: [shortD["Yes"] || 0, shortD["No"] || 0],
                backgroundColor: ["#ef4444","#10b981"], borderWidth: 2, borderColor: "#fff" }]
        }, { ...CHART_DEFAULTS });

        // ── Bar 1: Top orders
        const bo = d.bar_orders || {};
        this._makeChart("por-chart-orders", "bar", {
            labels: bo.labels || [],
            datasets: [
                { label: "Curr Month SO", data: bo.orders || [], backgroundColor: "rgba(79,70,229,.7)", borderRadius: 3 },
                { label: "Planned Qty",   data: bo.planned || [], backgroundColor: "rgba(16,185,129,.6)", borderRadius: 3 },
                { label: "Dispatched",    data: bo.dispatch || [], backgroundColor: "rgba(245,158,11,.6)", borderRadius: 3 },
            ]
        }, { ...CHART_DEFAULTS, scales: { x: { ticks: { maxRotation: 45, font: { size: 10 } } } } });

        // ── Bar 2: Projection vs sales
        const bp = d.bar_projection || {};
        this._makeChart("por-chart-proj", "bar", {
            labels: bp.labels || [],
            datasets: [
                { label: "Projection", data: bp.projection || [], backgroundColor: "rgba(14,165,233,.7)", borderRadius: 3 },
                { label: "Actual Sales", data: bp.sales || [], backgroundColor: "rgba(16,185,129,.7)", borderRadius: 3 },
            ]
        }, { ...CHART_DEFAULTS, scales: { x: { ticks: { maxRotation: 45, font: { size: 10 } } } } });

        // ── Bar 3: WO count by group
        const bg = d.bar_wo_by_group || {};
        this._makeChart("por-chart-group", "bar", {
            labels: bg.labels || [],
            datasets: [{ label: "Open WO Count", data: bg.values || [],
                backgroundColor: "rgba(245,158,11,.7)", borderRadius: 4 }]
        }, { ...CHART_DEFAULTS, indexAxis: "y",
            scales: { x: { beginAtZero: true, ticks: { font: { size: 11 } } },
                      y: { ticks: { font: { size: 11 } } } } });
    }

    _makeChart(canvasId, type, chartData, options) {
        if (this._charts[canvasId]) { this._charts[canvasId].destroy(); }
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        this._charts[canvasId] = new Chart(canvas.getContext("2d"), {
            type, data: chartData, options: { responsive: true, ...options }
        });
    }

    // ── Export ────────────────────────────────────────────────────────────
    _buildCSVContent() {
        if (!this._data || !this._data.items) return "";
        const cols = [
            "Item Code","Item Name","Item Group","Type","Sub-Assembly",
            "Open WOs","Planned Qty","Produced","Prev Month SO","Curr Month SO",
            "Dispatched","Sales Projection","Total Sales","Proj vs Sales %",
            "Stock on Hand","Has Shortage","Possible Qty","Active BOM",
        ];
        const rows = this._data.items.map(i => [
            i.item_code, i.item_name, i.item_group, i.item_type,
            i.is_sub_assembly ? "Yes" : "No",
            i.open_wo_count, i.planned_qty, i.actual_qty,
            i.prev_month_order, i.curr_month_order, i.curr_dispatch,
            i.curr_projection, i.total_curr_sales,
            i.projection_vs_sales ? (i.projection_vs_sales * 100).toFixed(1) + "%" : "",
            i.stock, i.has_shortage ? "Yes" : "No",
            i.possible_qty, i.active_bom || "",
        ]);

        const escape = v => {
            const s = String(v ?? "");
            return s.includes(",") || s.includes('"') || s.includes("\n")
                ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [cols, ...rows].map(r => r.map(escape).join(",")).join("\r\n");
    }

    _exportCSV() {
        const csv  = this._buildCSVContent();
        const period = this._period;
        const fname = `production_overview_${period?.month_name || ""}_${period?.year || ""}.csv`;
        const blob  = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
        this._downloadBlob(blob, fname);
    }

    _exportExcel() {
        // True Excel via server-side openpyxl - 3 sheets (Overview /
        // UOM Comparison / Summary), colour coding, frozen header.
        // Frappe streams the file via frappe.response.filecontent, so a
        // GET redirect is the standard way to download it.
        const company = document.getElementById("por-company").value;
        if (!company) { frappe.msgprint("Please select a company."); return; }
        const params = new URLSearchParams({
            company,
            month:       document.getElementById("por-month").value,
            year:        document.getElementById("por-year").value,
            warehouses:  JSON.stringify(this._selWh),
            wo_statuses: JSON.stringify(this._selWo),
            so_statuses: JSON.stringify(this._selSo),
            stock_mode:  document.getElementById("por-stock-mode").value,
        });
        window.location.href =
            `/api/method/chaizup_toc.api.production_overview_api.export_excel?${params.toString()}`;
    }

    _downloadBlob(blob, filename) {
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ── Utility helpers ───────────────────────────────────────────────────
    _esc(str) {
        return String(str == null ? "" : str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    _formatNum(n) {
        const f = parseFloat(n) || 0;
        return f.toLocaleString("en-IN", { maximumFractionDigits: 2 });
    }
}
