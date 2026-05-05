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
        this._selPo     = [];     // PO Status filter
        this._planMode  = false;
        this._planSubmode = "independent";  // "independent" | "priority"
        // Sort + search
        this._sortKey   = "";       // header click sets this
        this._sortDir   = "asc";    // "asc" | "desc"
        this._searchTxt = "";       // universal search substring (lowercased)
        // Quick filter pill state (POR-008 + POR-011): all default OFF — additive (AND).
        // Open SO / No SO are mutually exclusive (handled in click handler).
        this._filterHasSO    = false;  // "Open SO"        pill
        this._filterNoSO     = false;  // "No SO"          pill (NEW POR-011)
        this._filterInProj   = false;  // "In Projection"  pill (NEW POR-011)
        this._filterHasWO    = false;  // "Open WO"        pill
        this._filterHasPP    = false;  // "In PP"          pill
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

    // Doctype hyperlink helper — used across the page so every doc id is a
    // hyperlink that opens /app/<route>/<name> in a new tab. The affordance is
    // the same everywhere so users learn it once.
    //
    // 4th arg `htmlLabel` (default false): if true, the caller is sending raw
    // HTML for the link content (e.g. an FA <i> icon). Without this opt-in we
    // _esc() the label and any HTML tags would render as literal text in the UI.
    // Bug POR-003 (2026-05-04): the FA icon next to PP names rendered as text.
    _dl(doctype, name, label, htmlLabel) {
        if (!name) return "";
        const route = String(doctype).toLowerCase().replace(/\s+/g, "-");
        const display = label != null ? label : name;
        const inner = htmlLabel ? display : this._esc(display);
        return `<a class="por-doclink" target="_blank" rel="noopener noreferrer"
                  href="/app/${route}/${encodeURIComponent(name)}"
                  title="Open ${this._esc(doctype)} ${this._esc(name)} in a new tab">${inner}</a>`;
    }

    // Render the `open_docs` column from `_get_open_docs_for_item` in the
    // shortage modal. Each entry is an object {type, name, qty, uom, received?}
    // — Bug POR-004 (2026-05-04): the JS was running String(d) which produced
    // "[object Object]". We render a typed pill with a clickable doctype link
    // and a compact qty/uom hint. Empty list shows an em-dash so the column
    // never collapses to nothing.
    _renderOpenDocs(docs) {
        if (!docs || !docs.length) {
            return `<span style="color:var(--por-sl-400);font-size:11px;">—</span>`;
        }
        return docs.slice(0, 3).map(d => {
            if (!d || typeof d !== "object") {
                return `<span class="por-open-doc">${this._esc(d)}</span>`;
            }
            const type  = d.type || "Doc";
            const name  = d.name || "";
            const tag   = type === "Purchase Order" ? "PO"
                        : type === "Material Request" ? "MR"
                        : type === "Work Order" ? "WO"
                        : this._esc(type);
            const qty   = d.qty != null ? this._formatNum(d.qty) : "";
            const uom   = d.uom ? this._esc(d.uom) : "";
            const qtyTxt = qty ? ` ${qty}${uom ? " " + uom : ""}` : "";
            const link  = name ? this._dl(type, name) : this._esc(name);
            return `<span class="por-open-doc" title="${this._esc(type)} ${this._esc(name)}${qtyTxt}">
                      <strong>${tag}</strong> ${link}${qtyTxt ? `<small style="color:var(--por-muted);"> ·${qtyTxt}</small>` : ""}
                    </span>`;
        }).join(" ");
    }

    // ── Init ─────────────────────────────────────────────────────────────
    async _init() {
        this._setupFullHeight();
        this._setupTooltips();   // custom hover-tip — must run before any HTML renders
        // POR-009: default Planning Mode = Independent. The CSS body class
        // `por-mode-independent` dims the drag handles + makes seq inputs
        // visually inert (pointer-events:none).
        document.body.classList.add("por-mode-independent");
        await this._loadDefaults();
        this._bindEvents();
        this._initAIPanel();
    }

    // ── Custom Tooltip System ─────────────────────────────────────────────
    // Why custom: native `title=` tooltips have a 700ms+ browser delay AND
    // are visually inconsistent across OS. The user reported "tooltips not
    // working". Reality is they DID fire — just very late. This replaces the
    // native tooltip with an instant, styled, multi-line popover.
    //
    // Mechanism:
    //   - Single global `#por-tooltip` div appended to <body>.
    //   - Delegated `mouseover` on `#por-root` reads `[title]` or `[data-tip]`
    //     of the hovered element, hides the native title (by moving it to
    //     `data-orig-title` so it can be restored), and shows the custom tip.
    //   - `mousemove` repositions, `mouseout` hides.
    //   - All existing `title="..."` attributes work without HTML edits.
    _setupTooltips() {
        const root = document.getElementById("por-root");
        if (!root) return;
        let tip = document.getElementById("por-tooltip");
        if (!tip) {
            tip = document.createElement("div");
            tip.id = "por-tooltip";
            tip.className = "por-tooltip";
            tip.style.display = "none";
            document.body.appendChild(tip);
        }

        const showTip = (target, x, y) => {
            // Suppress native browser tooltip by stashing the title.
            if (target.hasAttribute("title")) {
                const orig = target.getAttribute("title");
                if (orig) {
                    target.setAttribute("data-orig-title", orig);
                    target.removeAttribute("title");
                }
            }
            const text = target.dataset.origTitle || target.dataset.tip || "";
            if (!text) return;
            // innerText preserves \n line breaks; CSS uses white-space:pre-wrap
            tip.innerText = text;
            tip.style.display = "block";
            this._positionTip(tip, x, y);
        };

        const hideTip = (target) => {
            tip.style.display = "none";
            if (target && target.dataset && target.dataset.origTitle) {
                target.setAttribute("title", target.dataset.origTitle);
                delete target.dataset.origTitle;
            }
        };

        // mouseover bubbles, so a single delegated handler covers everything.
        root.addEventListener("mouseover", (e) => {
            const el = e.target.closest("[title], [data-tip]");
            if (!el || !root.contains(el)) return;
            showTip(el, e.clientX, e.clientY);
        });
        root.addEventListener("mousemove", (e) => {
            if (tip.style.display === "block") {
                this._positionTip(tip, e.clientX, e.clientY);
            }
        });
        root.addEventListener("mouseout", (e) => {
            const el = e.target.closest("[title], [data-orig-title], [data-tip]");
            if (!el) return;
            // If still inside the same element (moving over a child), keep open.
            if (e.relatedTarget && el.contains(e.relatedTarget)) return;
            hideTip(el);
        });
        // Also hide on scroll / blur so a stale tip never sticks
        window.addEventListener("scroll", () => { tip.style.display = "none"; }, true);
        window.addEventListener("blur",   () => { tip.style.display = "none"; });

        this._tipEl = tip;
    }

    // Visual cue when filters change so user knows to click Load.
    // Also marks chart/AI caches stale so the next view refetches.
    _markFiltersDirty() {
        this._chartsLoaded = false;
        this._aiInsightLoaded = false;
        const btn = document.getElementById("por-load-btn");
        if (btn) {
            btn.classList.add("por-load-pulse");
            // Auto-stop pulse after 6s in case the user gets distracted
            clearTimeout(this._pulseTo);
            this._pulseTo = setTimeout(() => btn.classList.remove("por-load-pulse"), 6000);
        }
    }

    _positionTip(tip, x, y) {
        // Place 12 px below+right of cursor, but flip if it would overflow.
        const margin = 8;
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        let left = x + 14;
        let top  = y + 14;
        if (left + w + margin > window.innerWidth)  left = window.innerWidth - w - margin;
        if (top  + h + margin > window.innerHeight) top  = y - h - 14;
        if (top < margin)  top = margin;
        if (left < margin) left = margin;
        tip.style.left = left + "px";
        tip.style.top  = top  + "px";
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

        // ── WO/SO/PO default statuses + warehouse list ──────────────────
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_default_statuses",
            callback: (r) => {
                if (!r.message) return;
                const d = r.message;
                this._selWo = [...(d.wo_statuses || [])];
                this._selSo = [...(d.so_statuses || [])];
                this._selPo = [...(d.po_statuses || [])];
                this._populateMsPanel("por-wo-status-list", "por-wo-panel", "por-wo-label",
                    d.all_wo_statuses || [], this._selWo);
                this._populateMsPanel("por-so-status-list", "por-so-panel", "por-so-label",
                    d.all_so_statuses || [], this._selSo);
                this._populateMsPanel("por-po-status-list", "por-po-panel", "por-po-label",
                    d.all_po_statuses || [], this._selPo);
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
    // EVERY DOM lookup here is null-guarded. Reason: if any one element is
    // missing in a stale cached template, an unguarded lookup throws and the
    // entire bootstrap aborts — page renders blank. Defensive null checks
    // make the page degrade gracefully (the missing feature simply doesn't
    // bind) instead of taking down everything.
    _bindEvents() {
        const $on = (id, ev, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(ev, fn);
        };
        // Load button
        $on("por-load-btn", "click", () => this._loadData());

        // Tab switching
        document.querySelectorAll(".por-tab-btn").forEach(btn => {
            btn.addEventListener("click", () => this._switchTab(btn.dataset.tab));
        });

        // Planning Mode segmented buttons (POR-009) — mirrors WKP Mode A / Mode B.
        // Mode A (Independent): row order does NOT affect Possible Qty.
        // Mode B (Priority Queue): items consume the pool in row order. The
        //   user reorders rows via the seq-input column or by drag-and-drop.
        // The OLD checkbox toggle + sub-mode dropdown are GONE — kept only as
        // safe-fallback null lookups so a stale cached template doesn't crash.
        document.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-plan-mode]");
            if (!btn) return;
            const mode = btn.dataset.planMode;            // "independent" | "priority"
            if (mode === "priority") {
                this._planMode    = true;
                this._planSubmode = "priority";
            } else {
                this._planMode    = false;
                this._planSubmode = "independent";
            }
            // Sync segment-button visual state
            document.querySelectorAll(".por-seg-btn[data-plan-mode]").forEach(b => {
                b.classList.toggle("active", b.dataset.planMode === mode);
            });
            // Add a body-level class so CSS can light up drag handles + seq inputs
            document.body.classList.toggle("por-mode-priority",    mode === "priority");
            document.body.classList.toggle("por-mode-independent", mode !== "priority");
            // Recompute and re-render
            if (this._data) {
                if (this._planSubmode === "priority") this._recalcPriorityPossibleQty();
                else this._restoreIndependentPossibleQty();
                this._renderTable(this._currentVisibleItems());
            }
        });

        // Select-all checkbox
        $on("por-select-all", "change", function () {
            document.querySelectorAll(".por-row-chk").forEach(c => c.checked = this.checked);
        });

        // Table delegation: item click, shortage view, cost, production plans
        const tbody = document.getElementById("por-tbody");
        if (tbody) {
            tbody.addEventListener("click", (e) => {
                const ic   = e.target.closest(".por-ic");
                const view = e.target.closest(".por-view-shortage");
                const cost = e.target.closest(".por-cost-btn");
                const pp   = e.target.closest(".por-pp-btn");
                const so   = e.target.closest(".por-so-btn");
                if (ic)   this._openItemModal(ic.dataset.code);
                if (view) this._openShortageModal(view.dataset.code);
                if (cost) this._openCostModal(cost.dataset.code);
                if (pp)   this._openPpModal(pp.dataset.code);
                if (so)   this._openSoModal(so.dataset.code);
            });
        }

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
                if (panelId === "por-po-panel")  this._updateMsLabel("por-po-panel", "por-po-label");
            }
        });

        // Header click — column sort
        const thead = document.querySelector("#por-table thead");
        if (thead) {
            thead.addEventListener("click", (e) => {
                const th = e.target.closest("th.por-th-sortable");
                if (!th) return;
                const key = th.dataset.sort;
                if (!key) return;
                if (this._sortKey === key) {
                    this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
                } else {
                    this._sortKey = key;
                    this._sortDir = "asc";
                }
                this._renderHeaderSortIndicators();
                if (this._data) this._renderTable(this._currentVisibleItems());
            });
        }

        // ── Filter change notifications ───────────────────────────────────
        // When ANY filter (warehouse, statuses, stock mode, period) changes,
        // we want two things:
        //   (1) A toast telling the user what changed and that they need to
        //       click Load to apply it across all tabs.
        //   (2) The Load button visually pulses so the user notices.
        //
        // We also invalidate cached data on chart/AI panes so the next click
        // refetches. The actual data fetch happens on Load click — auto
        // refetch on every keystroke would hammer the server (785 items).
        const _toastFilter = (label, value) => {
            this._markFiltersDirty();
            const v = String(value).slice(0, 60);
            frappe.show_alert({
                message: `<b>Filter changed:</b> ${this._esc(label)} → <code>${this._esc(v)}</code><br>
                          <small>Click <b>Load</b> to apply across Overview, AI Advisor &amp; Charts.</small>`,
                indicator: "blue",
            }, 5);
        };

        const fcompany = document.getElementById("por-company");
        if (fcompany) fcompany.addEventListener("change", () => _toastFilter("Company", fcompany.value));
        const fmonth   = document.getElementById("por-month");
        if (fmonth)   fmonth.addEventListener("change",   () => _toastFilter("Month", fmonth.options[fmonth.selectedIndex]?.text || fmonth.value));
        const fyear    = document.getElementById("por-year");
        if (fyear)    fyear.addEventListener("change",    () => _toastFilter("Year", fyear.value));
        const fstock   = document.getElementById("por-stock-mode");
        if (fstock)   fstock.addEventListener("change",   () => _toastFilter("Stock View", fstock.options[fstock.selectedIndex]?.text || fstock.value));

        // Multi-selects update via the .por-ms-chk change handler above; piggy-back here.
        document.addEventListener("change", (e) => {
            if (!e.target.classList || !e.target.classList.contains("por-ms-chk")) return;
            const panel = e.target.closest(".por-ms-panel");
            const map = {
                "por-wh-panel": "Warehouses",
                "por-wo-panel": "WO Status",
                "por-so-panel": "SO Status",
                "por-po-panel": "PO Status",
            };
            const lbl = panel ? map[panel.id] : null;
            if (lbl) _toastFilter(lbl, e.target.value + (e.target.checked ? " ✓" : " ✗"));
        });

        // Universal search
        const search = document.getElementById("por-search");
        if (search) {
            search.addEventListener("input", () => {
                this._searchTxt = (search.value || "").toLowerCase().trim();
                if (this._data) this._renderTable(this._currentVisibleItems());
            });
            search.addEventListener("keydown", (e) => {
                if (e.key === "Escape") { search.value = ""; this._searchTxt = ""; if (this._data) this._renderTable(this._currentVisibleItems()); }
            });
        }

        // Modal close via data-close-modal
        document.addEventListener("click", (e) => {
            const closeBtn = e.target.closest("[data-close-modal]");
            if (closeBtn) { this._closeModal(closeBtn.dataset.closeModal); return; }
            // Click outside modal content also closes
            const overlay = e.target.closest(".por-overlay");
            if (overlay && e.target === overlay) this._closeModal(overlay.id);
        });

        // PP modal — clicking the PP id opens the PP-Tree modal.
        // (Bound globally because the PP modal body is rendered dynamically.)
        document.addEventListener("click", (e) => {
            const treeBtn = e.target.closest(".por-pp-tree-btn");
            if (treeBtn) {
                e.preventDefault();
                this._openPpTreeModal(treeBtn.dataset.pp);
            }
        });

        // Item group filter
        $on("por-grp-filter", "change", (e) => this._applyGroupFilter(e.target.value));

        // Quick filter pills (POR-008 + POR-011) — toggle pill state and re-render.
        // Delegated so it works whether the pills exist at bind time or not.
        // Open SO and No SO are MUTUALLY EXCLUSIVE — selecting one auto-clears
        // the other. All other pills are additive (AND).
        document.addEventListener("click", (e) => {
            const pill = e.target.closest(".por-quick-pill");
            if (!pill) return;
            const flag = pill.dataset.quickFilter;
            if (flag === "has-so") {
                this._filterHasSO = !this._filterHasSO;
                if (this._filterHasSO) this._filterNoSO = false;
            } else if (flag === "no-so") {
                this._filterNoSO = !this._filterNoSO;
                if (this._filterNoSO) this._filterHasSO = false;
            } else if (flag === "in-proj") {
                this._filterInProj = !this._filterInProj;
            } else if (flag === "has-wo") {
                this._filterHasWO = !this._filterHasWO;
            } else if (flag === "has-pp") {
                this._filterHasPP = !this._filterHasPP;
            } else {
                return;
            }
            // Sync UI state on every relevant pill in the document
            const map = {
                "has-so":  this._filterHasSO,
                "no-so":   this._filterNoSO,
                "in-proj": this._filterInProj,
                "has-wo":  this._filterHasWO,
                "has-pp":  this._filterHasPP,
            };
            document.querySelectorAll(".por-quick-pill").forEach(p => {
                p.classList.toggle("active", !!map[p.dataset.quickFilter]);
            });
            if (this._data) this._renderTable(this._currentVisibleItems());
        });

        // Export buttons
        $on("por-export-csv",   "click", () => this._exportCSV());
        $on("por-export-excel", "click", () => this._exportExcel());
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

        // Stop the filter-changed pulse — user is acting on it now.
        const btn = document.getElementById("por-load-btn");
        if (btn) btn.classList.remove("por-load-pulse");
        clearTimeout(this._pulseTo);

        // Invalidate caches on EVERY tab so the next view is fresh.
        this._chartsLoaded     = false;
        this._aiInsightLoaded  = false;

        this._selWo = this._getSelectedMs("por-wo-status-list");
        this._selSo = this._getSelectedMs("por-so-status-list");
        this._selPo = this._getSelectedMs("por-po-status-list");
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
                po_statuses: JSON.stringify(this._selPo),
                stock_mode: document.getElementById("por-stock-mode").value,
                planning_mode: this._planMode ? 1 : 0,
            },
            callback: (r) => {
                if (!r.message) { this._showState("empty"); return; }
                this._data   = r.message;
                this._period = r.message.period;
                this._chartsLoaded    = false;
                this._aiInsightLoaded = false;
                this._render(r.message);
                // Confirmation toast — tells the user the filter applied across all tabs.
                const itemCount = (r.message.items || []).length;
                frappe.show_alert({
                    message: `Loaded <b>${itemCount}</b> items for <b>${this._esc(this._period?.month_name || "")} ${this._esc(this._period?.year || "")}</b>.<br>
                              <small>All tabs (Overview, AI Advisor, Charts) will use this dataset.</small>`,
                    indicator: "green",
                }, 5);
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

        // Universal search box becomes visible after first load
        const sw = document.getElementById("por-search-wrap");
        if (sw) sw.style.display = "block";

        // Export buttons
        document.getElementById("por-export-csv").style.display   = "inline-flex";
        document.getElementById("por-export-excel").style.display = "inline-flex";
    }

    // Returns items array filtered by current group + search, in current sort order.
    _currentVisibleItems() {
        if (!this._data || !this._data.items) return [];
        let items = this._data.items.slice();
        // Group filter (selected via #por-grp-filter)
        const grp = document.getElementById("por-grp-filter");
        const gv = grp ? grp.value : "";
        if (gv) items = items.filter(i => (i.item_group || "") === gv);
        // Quick filter pills (POR-008): "Has Open SO" / "Has Open WO".
        // Driven from JS state set by .por-quick-pill click handlers, so the
        // search and sort pipelines all stack consistently.
        if (this._filterHasSO) {
            items = items.filter(i =>
                i.has_open_so === true ||
                (i.curr_month_order || 0) > 0 ||
                (i.prev_month_order || 0) > 0 ||
                (i.total_pending_so || 0) > 0
            );
        }
        if (this._filterNoSO) {
            // POR-011: counterpoint to "Open SO" — items with NO active customer
            // demand. Often these are projection-driven / make-to-stock items.
            items = items.filter(i =>
                !i.has_open_so &&
                (i.total_pending_so || 0) === 0 &&
                (i.curr_month_order || 0) === 0 &&
                (i.prev_month_order || 0) === 0
            );
        }
        if (this._filterInProj) {
            // POR-011: items present in this month's submitted Sales Projection.
            items = items.filter(i => (i.curr_projection || 0) > 0);
        }
        if (this._filterHasWO) {
            items = items.filter(i => (i.open_wo_count || 0) > 0);
        }
        if (this._filterHasPP) {
            items = items.filter(i => (i.wo_pp_count || 0) > 0);
        }
        // Search
        if (this._searchTxt) {
            const q = this._searchTxt;
            items = items.filter(i => {
                const blob = [
                    i.item_code, i.item_name, i.item_group, i.active_bom,
                    (i.sub_assembly_wos || []).map(p => p.production_plan).join(" "),
                ].join(" ").toLowerCase();
                return blob.indexOf(q) !== -1;
            });
        }
        // Sort
        if (this._sortKey) {
            const k = this._sortKey;
            const dir = this._sortDir === "asc" ? 1 : -1;
            items.sort((a, b) => {
                const va = a[k]; const vb = b[k];
                // String sort vs number sort
                if (typeof va === "number" || typeof vb === "number") {
                    return ((va || 0) - (vb || 0)) * dir;
                }
                if (typeof va === "boolean") return ((va ? 1 : 0) - (vb ? 1 : 0)) * dir;
                return String(va || "").localeCompare(String(vb || "")) * dir;
            });
        }
        return items;
    }

    _renderHeaderSortIndicators() {
        document.querySelectorAll("#por-table thead th.por-th-sortable").forEach(th => {
            th.classList.remove("por-sort-asc", "por-sort-desc");
            if (th.dataset.sort === this._sortKey) {
                th.classList.add(this._sortDir === "asc" ? "por-sort-asc" : "por-sort-desc");
            }
        });
    }

    _renderSummary(s) {
        // EVERY number on these cards is an ITEM COUNT — never a qty.
        // Mixing UOMs across items would make sums meaningless.
        const set = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = (v == null ? "0" : v);
        };
        set("por-s-total",      s.total_items || 0);
        set("por-s-shortage",   s.items_with_shortage || 0);
        set("por-s-ok",         s.items_no_shortage || 0);
        set("por-s-planned",    s.items_with_open_wos || 0);
        set("por-s-orders",     s.items_with_curr_so || 0);
        set("por-s-dispatch",   s.items_dispatched || 0);
        set("por-s-blocked",    s.items_blocked || 0);
        set("por-s-target-hit", s.items_target_hit || 0);
        const strip = document.getElementById("por-summary-strip");
        if (strip) strip.style.display = "flex";
    }

    _renderTable(items) {
        const tbody = document.getElementById("por-tbody");
        // Priority Mode recompute is row-order-sensitive — apply BEFORE building
        // rows. After this call, item.possible_qty reflects priority simulation.
        if (this._planMode && this._planSubmode === "priority") {
            this._recalcPriorityPossibleQty(items);
        }
        // Persist the rendered order so seq-input + drag handlers know what
        // "row #N" maps to even after the user reorders.
        this._priorityOrder = items.map(i => i.item_code);
        tbody.innerHTML = items.map((item, idx) => this._buildRow(item, idx + 1)).join("");
        // Count badge
        document.getElementById("por-vis-count").textContent = items.length;
        document.getElementById("por-count-badge").style.display = "block";

        // Wire row-level interactions for Priority mode (POR-009).
        this._bindPriorityRowHandlers(tbody);
    }

    // === POR-009: Priority Queue (Mode B) row interactions ===
    // Two affordances: the seq-input (type a new number) and HTML5 drag-drop.
    // BOTH paths converge on _applyPriorityOrder(newCodeArray) which mutates
    // `_data.items` order in place, then calls `_renderTable` to re-simulate.
    _bindPriorityRowHandlers(tbody) {
        if (!tbody || !this._planMode) return;

        // -- Seq input: change/Enter triggers reorder --
        tbody.querySelectorAll(".por-seq-input").forEach(inp => {
            const commit = () => {
                if (!this._planMode) return;
                const code   = inp.dataset.code;
                const oldSeq = parseInt(inp.dataset.currentSeq, 10);
                const newSeq = Math.max(1, parseInt(inp.value, 10) || 1);
                if (newSeq === oldSeq) return;
                this._moveItemInOrder(code, newSeq - 1);
            };
            inp.addEventListener("change", commit);
            inp.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
            });
        });

        // -- Drag-and-drop on rows --
        tbody.querySelectorAll("tr").forEach(tr => {
            // Only drag when in Priority mode AND the user grabs the handle.
            const handle = tr.querySelector(".por-drag-handle");
            if (!handle) return;
            // We use HTML5 native DnD. Bind on the TR; gate by mousedown on
            // the handle to avoid hijacking checkbox/cell clicks.
            tr.draggable = false;
            handle.addEventListener("mousedown", () => {
                if (this._planMode) tr.draggable = true;
            });
            handle.addEventListener("mouseup",   () => { tr.draggable = false; });

            tr.addEventListener("dragstart", (e) => {
                if (!this._planMode) return;
                tr.classList.add("por-drag-active");
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tr.dataset.code);
            });
            tr.addEventListener("dragend", () => {
                tr.classList.remove("por-drag-active");
                tbody.querySelectorAll(".por-drag-over").forEach(t => t.classList.remove("por-drag-over"));
                tr.draggable = false;
            });
            tr.addEventListener("dragover", (e) => {
                if (!this._planMode) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                tr.classList.add("por-drag-over");
            });
            tr.addEventListener("dragleave", () => tr.classList.remove("por-drag-over"));
            tr.addEventListener("drop", (e) => {
                if (!this._planMode) return;
                e.preventDefault();
                tr.classList.remove("por-drag-over");
                const fromCode = e.dataTransfer.getData("text/plain");
                const toCode   = tr.dataset.code;
                if (!fromCode || !toCode || fromCode === toCode) return;
                const order   = (this._priorityOrder || []).slice();
                const fromIdx = order.indexOf(fromCode);
                const toIdx   = order.indexOf(toCode);
                if (fromIdx < 0 || toIdx < 0) return;
                order.splice(fromIdx, 1);
                order.splice(toIdx, 0, fromCode);
                this._applyPriorityOrder(order);
            });
        });
    }

    // Move an item to a specific 0-based index within the visible order, then
    // re-render. Bound to the seq-input change events.
    _moveItemInOrder(code, newIdx) {
        const order   = (this._priorityOrder || []).slice();
        const fromIdx = order.indexOf(code);
        if (fromIdx < 0) return;
        order.splice(fromIdx, 1);
        order.splice(Math.min(Math.max(newIdx, 0), order.length), 0, code);
        this._applyPriorityOrder(order);
    }

    // Apply a new order. Reorders `_data.items` so that subsequent renders
    // (with current sort cleared) reflect the user's priority. Note: any
    // active sort key is cleared because explicit priority overrides it.
    _applyPriorityOrder(orderCodes) {
        if (!this._data || !this._data.items) return;
        const byCode = new Map(this._data.items.map(i => [i.item_code, i]));
        const sorted = orderCodes.map(c => byCode.get(c)).filter(Boolean);
        // Append any items not in `orderCodes` (e.g. filtered out) so we
        // don't lose them on subsequent filter toggles.
        for (const it of this._data.items) {
            if (!orderCodes.includes(it.item_code)) sorted.push(it);
        }
        this._data.items = sorted;
        // Clear active column sort — explicit priority is now the order.
        this._sortKey = "";
        this._sortDir = "asc";
        this._renderHeaderSortIndicators();
        this._renderTable(this._currentVisibleItems());
    }

    _buildRow(item, seqNum) {
        const code   = this._esc(item.item_code);
        const name   = this._esc(item.item_name);
        const group  = this._esc(item.item_group || "");
        const uom    = item.stock_uom || "";
        const conv   = item.uom_conversions || [];
        const pm     = this._planMode;
        // POR-009: seq cell now has TWO affordances — drag handle + editable
        // input. Drag handle is dimmed in Mode A (CSS body class). The input
        // is ignored in Mode A by `pointer-events:none`.
        const seqHtml = `
            <span class="por-drag-handle" title="${pm ? "Drag this row to reorder priority (Mode B only)." : "Switch to Mode B — Priority Queue to drag rows."}">&#9776;</span>
            <input type="number" class="por-seq-input" min="1" value="${seqNum}"
                   data-code="${code}" data-current-seq="${seqNum}"
                   title="${pm ? "Type a new number and press Enter to move this row to that position." : "Read-only in Mode A. Switch to Mode B to edit priority."}"
                   ${pm ? "" : "readonly tabindex=\"-1\""}>`;

        // Sub-Asm chip with hover-list of parent WOs (with shortage qty)
        let subAsmHtml = `<span style="color:var(--por-sl-300);font-size:11px;">—</span>`;
        if (item.is_sub_assembly) {
            const parents = item.sub_assembly_wos || [];
            const rows = parents.length
                ? parents.slice(0, 8).map(p => `
                    <div class="por-subasm-row">
                      ${this._dl("Work Order", p.wo_name)}
                      <span style="color:var(--por-muted);"> &lt;- parent: ${this._esc(p.parent_item || "?")}</span>
                      <div style="font-size:10px;color:var(--por-sl-700);">
                        Need <strong>${this._formatNum(p.required_qty || 0)}</strong> ${this._esc(uom)}
                        for parent qty ${this._formatNum(p.parent_qty || 0)}
                        (PP: ${this._dl("Production Plan", p.production_plan || "")})
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
        // Smart PP indicator (POR-007): WOs grouped under Production Plans.
        // Hidden when no PPs touch this item — keeps the cell clean for the
        // 80% of items that aren't part of a multi-WO plan.
        const ppGroupChip = (item.wo_pp_count || 0) > 0
            ? `<span class="por-pp-chip" title="${this._esc(
                `${item.wo_pp_count} Production Plan${item.wo_pp_count > 1 ? "s" : ""}: ${(item.wo_pp_names || []).join(", ")}` +
                (item.wo_pp_siblings ? ` · co-planned with ${item.wo_pp_siblings} other item${item.wo_pp_siblings > 1 ? "s" : ""}` : "")
              )}">
                <i class="fa-solid fa-clipboard-list" style="font-size:9px;"></i>
                ${item.wo_pp_count}${item.wo_pp_siblings ? `<small style="opacity:.7;">+${item.wo_pp_siblings}</small>` : ""}
              </span>`
            : "";

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

        // Shortage cell — hover lists top short components with item code +
        // name + current stock (per 2026-05-01 spec). Click View for the
        // by-WO breakdown modal.
        let shortPreview = "Active BOM has component shortages. Click View for breakdown.";
        if (item.has_shortage && (item.shortage_components || []).length) {
            shortPreview = "Top short components (item code | name | required vs current stock):\n";
            for (const c of item.shortage_components) {
                const stk = c.in_stock != null ? c.in_stock : (c.stock || 0);
                shortPreview += `\n${c.item_code}  ${c.item_name || ""}  need ${this._formatNum(c.required)} ${c.uom || ""}  |  stock ${this._formatNum(stk)}  |  short ${this._formatNum(c.shortage)}`;
            }
            shortPreview += "\n\nClick View for the full by-Work-Order breakdown.";
        }
        const shortageHtml = item.has_shortage
            ? `<span class="por-short-warn" title="${this._esc(shortPreview)}"><i class="fa-solid fa-triangle-exclamation"></i> Short</span>
               <button class="por-btn por-btn-err por-btn-sm por-view-shortage" style="margin-left:4px;" data-code="${code}"
                       title="Open the full by-Work-Order shortage modal."><i class="fa-solid fa-eye"></i> View</button>`
            : `<span class="por-short-ok" title="All active-BOM components have sufficient stock for the current Possible Qty. Source: tabBOM Item required vs Bin.actual_qty."><i class="fa-solid fa-circle-check"></i> OK</span>`;

        // Active BOM as hyperlink (opens in new tab)
        const bomHtml = item.active_bom
            ? this._dl("BOM", item.active_bom,
                item.active_bom.length > 22 ? item.active_bom.slice(0, 20) + "..." : item.active_bom)
            : `<span class="por-no-bom" title="No active default BOM. Possible Qty and Shortage cannot be calculated.">No BOM</span>`;

        // Target Production cell — show driving source pill (Projection vs Order)
        const tgt = item.target_production || 0;
        const tgtPill = item.curr_projection >= item.total_curr_sales
            ? `<span class="por-target-pill por-target-proj" title="Projection drives the target this month.">Projection</span>`
            : `<span class="por-target-pill por-target-order" title="Orders drive the target this month.">Order</span>`;
        const tgtCalc = `Target = max(Projection ${this._formatNum(item.curr_projection)}, Total Sales ${this._formatNum(item.total_curr_sales)})`;
        const tgtHtml = tgt > 0
            ? `${this._fmtQ(tgt, conv, uom, tgtCalc)} <div style="margin-top:2px;">${tgtPill}</div>`
            : `<span class="por-q por-q-zero" title="No demand or projection — no target.">0</span> <span class="por-q-uom">${this._esc(uom)}</span>`;

        // % Target Achieved
        const ach = item.target_achieved_pct || 0;
        const achTip = `Gap = max(Curr SO ${this._formatNum(item.curr_month_order)} - (Pending WO ${this._formatNum(item.pending_wo_qty || 0)} + Stock ${this._formatNum(item.stock)}), 0)
Achieved = max(Target ${this._formatNum(tgt)} - Gap ${this._formatNum(item.target_gap || 0)}, 0)
Achieved % = Achieved / Target * 100 = ${ach}%
Warehouse-scoped to your filter.`;
        const achHtml = !tgt
            ? `<span class="por-cov-na" title="No target this month.">--</span>`
            : ach >= 90
                ? `<span class="por-ach-hi" title="${achTip}">${ach}%</span>`
                : ach >= 50
                    ? `<span class="por-ach-mid" title="${achTip}">${ach}%</span>`
                    : `<span class="por-ach-lo" title="${achTip}">${ach}%</span>`;

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

        // Item code is now a hyperlink to /app/item/<code> AND triggers the
        // detail modal on click of the chevron icon (data-code).
        const itemHeaderHtml = `
            <div style="display:flex;align-items:center;gap:6px;">
              ${this._dl("Item", item.item_code, item.item_code)}
              <button class="por-ic" data-code="${code}" title="Open the item-detail modal (open WOs, sub-asm chain, batch consumption)"
                      style="border:none;background:transparent;cursor:pointer;color:var(--por-brand);">
                <i class="fa-solid fa-circle-info" style="font-size:11px;"></i>
              </button>
            </div>
            <span class="por-in" title="${name}">${name}</span>`;

        return `<tr data-code="${code}" data-group="${group}" data-has-so="${item.has_open_so ? "1" : "0"}" class="${item.has_open_so ? "por-has-so" : ""}">
          <td class="por-col-s por-col-chk"><input type="checkbox" class="por-row-chk" data-code="${code}"></td>
          <td class="por-col-s por-col-item">${itemHeaderHtml}</td>
          <td style="text-align:center;">${seqHtml}</td>
          <td><span class="por-grp-cell" title="${group}">${group || "--"}</span></td>
          <td>${subAsmHtml}</td>
          <td style="text-align:center;white-space:nowrap;">${woChip}${ppGroupChip}</td>
          <td>${this._fmtQ(item.planned_qty, conv, uom, tipPlanned)}</td>
          <td>${this._fmtQ(item.actual_qty, conv, uom, tipProduced)}</td>
          <td>${this._fmtQ(item.prev_month_order, conv, uom, tipPrevSO)}</td>
          <td style="white-space:nowrap;">${this._fmtQ(item.curr_month_order, conv, uom, tipCurrSO)}
            <button class="por-btn por-btn-default por-btn-sm por-so-btn"
                    data-code="${code}"
                    title="View every Sales Order containing ${this._esc(item.item_code)} (status + customer + qty + UOM + delivery date), filtered by your selected SO statuses and warehouses.">
              <i class="fa-solid fa-cart-shopping"></i> SOs
            </button>
          </td>
          <td>${this._fmtQ(item.prev_dispatch || 0, conv, uom, tipPrevDisp)}</td>
          <td>${this._fmtQ(item.curr_dispatch, conv, uom, tipCurrDisp)}</td>
          <td>${this._fmtQ(item.curr_projection, conv, uom, tipProj)}</td>
          <td>${this._fmtQ(item.total_curr_sales, conv, uom, tipTotalSales)}</td>
          <td>${pvsHtml}</td>
          <td>${covHtml}</td>
          <td>${tgtHtml}</td>
          <td>${achHtml}</td>
          <td>${this._fmtQ(item.stock, conv, uom, tipStock)}</td>
          <td class="por-shortage-cell">${shortageHtml}</td>
          <td>${this._fmtQ(item.possible_qty, conv, uom, tipPossible)}${
              pm && item._planning_status
                ? `<span class="por-plan-status por-plan-status-${item._planning_status}" title="Priority simulation result for this row (Mode B). Full = nothing constrained. Partial = some components consumed by upstream rows. Blocked = pool exhausted before this row.">${item._planning_status}</span>`
                : ""
          }</td>
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

    // _planInput REMOVED in POR-009 — qty cells (Planned, Curr SO) are now
    // always read-only because they reflect ERPNext source data and must not
    // be edited from this page. The only user-editable affordance in
    // Planning Mode is now row priority (seq-input + drag-and-drop).

    // ── Group filter ──────────────────────────────────────────────────────
    _buildGroupFilter(items) {
        const groups = [...new Set(items.map(i => i.item_group).filter(Boolean))].sort();
        const sel = document.getElementById("por-grp-filter");
        sel.innerHTML = `<option value="">All Groups</option>` +
            groups.map(g => `<option value="${this._esc(g)}">${this._esc(g)}</option>`).join("");
        document.getElementById("por-grp-filter-wrap").style.display = "block";
        // Quick filter pills wrapper (POR-008) — shown alongside group filter
        const pills = document.getElementById("por-quick-pills-wrap");
        if (pills) pills.style.display = "flex";
    }

    _applyGroupFilter(_group) {
        // Now goes through the unified visible-items pipeline so sort + search
        // + group filter all stack consistently.
        if (this._data) this._renderTable(this._currentVisibleItems());
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

                // Component shortage summary — show item code, NAME, and CURRENT
                // STOCK so the user can act on the line without opening another
                // modal. Per 2026-05-01 spec.
                if (wo.components && wo.components.length > 0) {
                    const shortComps = wo.components.filter(c => c.shortage > 0);
                    if (shortComps.length > 0) {
                        html += `<tr><td colspan="7" style="padding:6px 9px;background:#fff8f8;">
                          <div style="font-size:11px;font-weight:600;color:var(--por-err-text);margin-bottom:4px;">
                            <i class="fa-solid fa-triangle-exclamation"></i> ${shortComps.length} component(s) short:
                          </div>
                          <table style="font-size:11px;border-collapse:collapse;width:100%;margin-top:2px;">
                            <thead><tr style="background:rgba(239,68,68,0.06);">
                              <th style="padding:3px 6px;text-align:left;border-bottom:1px solid #fecaca;">Code</th>
                              <th style="padding:3px 6px;text-align:left;border-bottom:1px solid #fecaca;">Item Name</th>
                              <th style="padding:3px 6px;text-align:right;border-bottom:1px solid #fecaca;">Need</th>
                              <th style="padding:3px 6px;text-align:right;border-bottom:1px solid #fecaca;">Current Stock</th>
                              <th style="padding:3px 6px;text-align:right;border-bottom:1px solid #fecaca;">Short</th>
                              <th style="padding:3px 6px;text-align:left;border-bottom:1px solid #fecaca;">UOM</th>
                            </tr></thead>
                            <tbody>
                            ${shortComps.slice(0,8).map(c => `
                              <tr>
                                <td style="padding:3px 6px;">${this._dl("Item", c.item_code)}</td>
                                <td style="padding:3px 6px;color:var(--por-sl-700);">${this._esc(c.item_name || "")}</td>
                                <td style="padding:3px 6px;text-align:right;font-family:monospace;">${this._formatNum(c.required)}</td>
                                <td style="padding:3px 6px;text-align:right;font-family:monospace;">${this._formatNum(c.in_stock)}</td>
                                <td style="padding:3px 6px;text-align:right;font-family:monospace;font-weight:700;color:var(--por-err-text);">${this._formatNum(c.shortage)}</td>
                                <td style="padding:3px 6px;color:var(--por-muted);">${this._esc(c.uom || "")}</td>
                              </tr>
                            `).join("")}
                            </tbody>
                          </table>
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
                  <td>${this._renderOpenDocs(a.open_docs)}</td>
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
                  WO: ${this._dl("Work Order", wo.wo_name)}
                  Qty: ${this._formatNum(wo.qty_to_manufacture)}
                  <span class="por-wo-st por-wo-st-ip" style="margin-left:6px;">${this._esc(wo.status)}</span>
                </div>`;
                if (wo.short_components && wo.short_components.length > 0) {
                    html += `<table class="por-dtable" style="margin-bottom:8px;">
                      <thead><tr>
                        <th>Code</th><th>Item Name</th><th>Required</th>
                        <th>Current Stock</th><th>Shortage</th><th>UOM</th>
                      </tr></thead>
                      <tbody>`;
                    for (const c of wo.short_components) {
                        html += `<tr>
                          <td>${this._dl("Item", c.item_code)}</td>
                          <td style="color:var(--por-sl-700);">${this._esc(c.item_name || "")}</td>
                          <td style="font-family:monospace;">${this._formatNum(c.required)}</td>
                          <td style="font-family:monospace;">${this._formatNum(c.in_stock)}</td>
                          <td style="font-family:monospace;color:var(--por-err-text);font-weight:700;">${this._formatNum(c.shortage)}</td>
                          <td style="font-size:10px;color:var(--por-muted);">${this._esc(c.uom || "")}</td>
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

    // ── Sales Orders for Item Modal (POR-012) ─────────────────────────────
    // Honours the SO Statuses + Warehouses + "Pending only" toggle. The
    // SO Status list passed to the API is read live from the page's MS
    // panel — so the modal stays in sync with what the user is filtering on.
    _openSoModal(itemCode) {
        const modal = document.getElementById("por-so-modal");
        const body  = document.getElementById("por-so-modal-body");
        const title = document.getElementById("por-so-modal-title");
        const toggle = document.getElementById("por-so-pending-only");
        if (!modal || !body || !title) return;
        title.textContent = `Sales Orders: ${itemCode}`;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading…</p></div>`;
        modal.classList.add("open");

        // Re-fetch on toggle change. Clean up the listener on close to avoid
        // stacking handlers across multiple openings of the modal.
        const fetchSos = (pendingOnly) => {
            frappe.call({
                method: "chaizup_toc.api.production_overview_api.get_so_detail_for_item",
                args: {
                    item_code:    itemCode,
                    so_statuses:  JSON.stringify(this._selSo || []),
                    warehouses:   JSON.stringify(this._selWh || []),
                    pending_only: pendingOnly ? 1 : 0,
                },
                callback: (r) => {
                    if (!r.message) {
                        body.innerHTML = `<div class="por-state-box"><i class="fa-solid fa-inbox"></i><p>No data returned.</p></div>`;
                        return;
                    }
                    body.innerHTML = this._buildSoHtml(r.message);
                },
                error: () => {
                    body.innerHTML = `<div class="por-state-box"><i class="fa-solid fa-triangle-exclamation"></i><p>Error loading Sales Orders. Check Error Log → POR.</p></div>`;
                },
            });
        };
        const onToggle = () => fetchSos(toggle.checked);
        if (toggle) {
            toggle.checked = true;
            // Replace any prior listener with a fresh one (clone trick).
            const fresh = toggle.cloneNode(true);
            toggle.parentNode.replaceChild(fresh, toggle);
            fresh.addEventListener("change", () => fetchSos(fresh.checked));
        }
        fetchSos(true);
    }

    _buildSoHtml(d) {
        const rows  = d.rows || [];
        const tot   = d.totals || {};
        const uom   = d.stock_uom || "";
        const conv  = d.uom_conversions || [];

        if (rows.length === 0) {
            const filter = d.filter_used || {};
            const stTxt = (filter.so_statuses || []).join(", ") || "(default)";
            return `<div class="por-state-box">
                <i class="fa-solid fa-inbox"></i>
                <p>No Sales Orders found for <code>${this._esc(d.item_code)}</code> matching your filter.</p>
                <p style="font-size:11px;color:var(--por-muted);">SO Status filter: <code>${this._esc(stTxt)}</code><br>
                Pending only: <code>${filter.pending_only ? "yes" : "no"}</code></p>
            </div>`;
        }

        // Summary strip — same UOM stack convention as the rest of the page.
        const stripHtml = `<div class="por-cost-strip">
            <div class="por-cost-card std">
              <div class="por-cost-num">${rows.length}</div>
              <div class="por-cost-lbl">SO Lines</div>
            </div>
            <div class="por-cost-card act">
              <div class="por-cost-num">${this._fmtQ(tot.ordered_qty_stock || 0, conv, uom)}</div>
              <div class="por-cost-lbl">Total Ordered (stock UOM)</div>
            </div>
            <div class="por-cost-card">
              <div class="por-cost-num">${this._fmtQ(tot.delivered_qty_stock || 0, conv, uom)}</div>
              <div class="por-cost-lbl">Total Delivered (stock UOM)</div>
            </div>
            <div class="por-cost-card ${tot.pending_qty_stock > 0 ? "over" : "under"}">
              <div class="por-cost-num">${this._fmtQ(tot.pending_qty_stock || 0, conv, uom)}</div>
              <div class="por-cost-lbl">Total Pending (stock UOM)</div>
            </div>
            <div class="por-cost-card">
              <div class="por-cost-num">${this._formatNum(tot.amount || 0)}</div>
              <div class="por-cost-lbl">Total Amount</div>
            </div>
          </div>`;

        const today = new Date().toISOString().slice(0, 10);

        // Status pill — submitted vs draft + workflow state when present.
        const statusPill = (r) => {
            const txt = r.so_docstatus === 0
                ? (r.workflow_state || "Draft")
                : (r.status || "Submitted");
            const cls = r.so_docstatus === 0
                ? "por-wo-st-ns"
                : (r.is_overdue ? "por-wo-st-mt" : "por-wo-st-ip");
            return `<span class="por-wo-st ${cls}" title="docstatus=${r.so_docstatus} | status=${this._esc(r.status || "")}${r.workflow_state ? " | workflow=" + this._esc(r.workflow_state) : ""}">${this._esc(txt)}</span>`;
        };

        const rowsHtml = rows.map(r => {
            const overdueBadge = r.is_overdue
                ? `<span class="por-pp-tag por-target-order" style="margin-left:4px;" title="Delivery date ${this._esc(r.delivery_date)} is in the past and qty is still pending.">Overdue</span>`
                : "";
            return `<tr>
                <td>${this._dl("Sales Order", r.so_name)} ${statusPill(r)}${overdueBadge}</td>
                <td><span style="font-weight:600;">${this._esc(r.customer_name || r.customer || "—")}</span>
                    ${r.customer_group ? `<span style="display:block;font-size:10px;color:var(--por-muted);">${this._esc(r.customer_group)}</span>` : ""}
                </td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;">${this._formatNum(r.qty)} ${this._esc(r.uom)}</td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;">${this._formatNum(r.delivered_qty)} ${this._esc(r.uom)}</td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;font-weight:700;color:${r.pending_qty > 0 ? "var(--por-err-text)" : "var(--por-ok-text)"};">${this._formatNum(r.pending_qty)} ${this._esc(r.uom)}</td>
                <td>${this._fmtQ(r.stock_pending_qty, conv, uom)}</td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;">×${this._formatNum(r.conversion_factor)}</td>
                <td style="font-size:11px;${r.is_overdue ? "color:var(--por-err-text);font-weight:700;" : ""}">${this._esc(r.delivery_date) || "—"}</td>
                <td style="font-size:11px;color:var(--por-muted);">${this._esc(r.warehouse) || "—"}</td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;text-align:right;">${this._formatNum(r.rate)}</td>
                <td style="font-family:'Geist Mono',monospace;font-size:11px;text-align:right;">${this._formatNum(r.amount)}</td>
            </tr>`;
        }).join("");

        return `${stripHtml}
            <div style="font-size:11px;color:var(--por-muted);margin:0 0 8px 4px;">
              <i class="fa-solid fa-circle-info"></i>
              Source: <code>tabSales Order Item</code> ⨯ <code>tabSales Order</code>.
              Status filter applied: <code>${this._esc((d.filter_used && d.filter_used.so_statuses) || [].join(", ")) || "(default)"}</code>.
              Pending qty = SO line qty − delivered qty (in line UOM); Pending (stock UOM) converts via the line's conversion factor.
            </div>
            <table class="por-dtable">
                <thead><tr>
                    <th>Sales Order</th>
                    <th>Customer</th>
                    <th title="Qty ordered in the SO line UOM (may differ from stock UOM)">Ordered Qty</th>
                    <th title="Qty already delivered in the SO line UOM">Delivered</th>
                    <th title="Pending qty in the SO line UOM (qty − delivered)">Pending (line UOM)</th>
                    <th title="Pending qty converted to the item's stock UOM, with secondary UOM stacked below">Pending (stock UOM)</th>
                    <th title="UOM Conversion Factor — how many stock-UOM units per 1 line-UOM unit">CF</th>
                    <th>Delivery Date</th>
                    <th>Warehouse</th>
                    <th title="Rate per SO-line UOM">Rate</th>
                    <th>Amount</th>
                </tr></thead>
                <tbody>${rowsHtml}</tbody>
            </table>`;
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
                  <button class="por-pp-tree-btn" data-pp="${this._esc(p.pp_name)}"
                          style="border:none;background:transparent;font-family:monospace;font-weight:700;color:var(--por-brand);cursor:pointer;padding:0;text-decoration:underline;"
                          title="Click to open the Production Plan tree (parent + sub-assemblies + components + supply + shortage)">
                    ${this._esc(p.pp_name)}
                  </button>
                  ${this._dl("Production Plan", p.pp_name, '<i class="fa-solid fa-arrow-up-right-from-square" style="font-size:10px;"></i>', true)}
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
                        <td>${this._dl("Work Order", w.wo_name)}</td>
                        <td>${this._dl("Item", w.production_item)}</td>
                        <td style="font-family:monospace;">${this._formatNum(w.planned_qty)}</td>
                        <td style="font-family:monospace;">${this._formatNum(w.produced_qty)}</td>
                        <td><span class="por-wo-st por-wo-st-ip">${this._esc(w.status)}</span></td>
                        <td style="font-size:11px;">${this._esc(w.planned_start_date || "")}</td>
                      </tr>`;
                }
                html += `</tbody></table>`;
            }
            html += `</div>`;
        }
        return html;
    }

    // ── Production Plan TREE Modal ────────────────────────────────────────
    _openPpTreeModal(ppName) {
        const modal = document.getElementById("por-pptree-modal");
        const body  = document.getElementById("por-pptree-modal-body");
        const title = document.getElementById("por-pptree-modal-title");
        title.textContent = `Production Plan Tree: ${ppName}`;
        body.innerHTML = `<div class="por-state-box"><div class="por-spinner"></div><p>Loading tree...</p></div>`;
        modal.classList.add("open");

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_pp_tree",
            args: { pp_name: ppName },
            callback: (r) => {
                if (!r.message) { body.innerHTML = "<p>No tree data.</p>"; return; }
                body.innerHTML = this._buildPpTreeHtml(r.message);
            },
            error: () => { body.innerHTML = "<p>Error loading tree.</p>"; },
        });
    }

    _buildPpTreeHtml(d) {
        if (!d.found) {
            return `<div class="por-state-box"><i class="fa-solid fa-inbox"></i>
                    <p>Production Plan ${this._esc(d.pp_name)} not found.</p></div>`;
        }
        const wos = d.work_orders || [];
        let html = `<div style="font-size:12px;color:var(--por-sl-700);margin-bottom:10px;">
            <strong>${this._dl("Production Plan", d.pp_name)}</strong>
            <span style="color:var(--por-muted);"> | ${this._esc(d.status || "")}</span>
            <span style="color:var(--por-muted);"> | ${this._esc(d.posting_date || "")}</span>
            ${d.for_warehouse ? `<span style="color:var(--por-muted);"> | warehouse: <strong>${this._esc(d.for_warehouse)}</strong></span>` : ""}
        </div>`;

        if (wos.length === 0) {
            html += `<div style="color:var(--por-muted);">No Work Orders attached to this plan.</div>`;
            return html;
        }

        html += `<div class="por-tree">`;
        for (const w of wos) {
            html += `<div class="por-tree-wo">
              <div class="por-tree-wo-hdr">
                <i class="fa-solid fa-hammer" style="color:var(--por-brand);"></i>
                ${this._dl("Work Order", w.wo_name)}
                <span class="por-pp-tag por-pp-other">${this._esc(w.production_item)}</span>
                <span class="por-wo-st por-wo-st-ip">${this._esc(w.status)}</span>
                <span style="color:var(--por-muted);font-size:11px;">
                  Plan ${this._formatNum(w.qty_to_manufacture)} | Produced ${this._formatNum(w.produced_qty)} | Remaining ${this._formatNum(w.remaining_qty)}
                </span>
                <span style="margin-left:auto;color:var(--por-muted);font-size:11px;">
                  ${w.fg_warehouse ? `to ${this._esc(w.fg_warehouse)}` : ""} | BOM: ${this._dl("BOM", w.bom_no)}
                </span>
              </div>`;

            const comps = w.components || [];
            if (comps.length === 0) {
                html += `<div style="color:var(--por-muted);font-size:11px;padding:4px;">No BOM components.</div>`;
            } else {
                html += `<table class="por-tree-comp-tbl">
                    <thead><tr>
                      <th>Component</th><th>UOM</th><th>Required</th><th>Consumed</th>
                      <th>Remaining</th><th>Stock</th>
                      <th>Will Be Received</th><th>Shortage</th>
                    </tr></thead><tbody>`;
                for (const c of comps) {
                    const isShort = c.shortage > 0;
                    const willReceive = (c.supply_from_po || 0) + (c.supply_from_wo || 0) + (c.supply_from_mr || 0);
                    const willTip = `PO: ${this._formatNum(c.supply_from_po)} | WO: ${this._formatNum(c.supply_from_wo)} | MR: ${this._formatNum(c.supply_from_mr)}`;
                    html += `<tr class="${isShort ? 'por-tree-row-short' : ''}">
                        <td>${this._dl("Item", c.item_code)}<div style="font-size:10px;color:var(--por-muted);">${this._esc(c.item_name || "")}</div></td>
                        <td>${this._esc(c.uom || "")}</td>
                        <td style="font-family:monospace;">${this._formatNum(c.required)}</td>
                        <td style="font-family:monospace;">${this._formatNum(c.consumed)}</td>
                        <td style="font-family:monospace;">${this._formatNum(c.remaining)}</td>
                        <td style="font-family:monospace;">${this._formatNum(c.stock)}</td>
                        <td style="font-family:monospace;" title="${willTip}">${this._formatNum(willReceive)}</td>
                        <td style="font-family:monospace;font-weight:700;color:${isShort ? 'var(--por-err-text)' : 'var(--por-ok-text)'};">${this._formatNum(c.shortage)}</td>
                      </tr>`;
                    // Detail row — show WOs / POs / MRs depending on supply mode
                    const supplyBits = [];
                    if (c.supply_wos && c.supply_wos.length) {
                        supplyBits.push(`<span class="por-tree-pill wo">Producing (open WOs):</span> `
                            + c.supply_wos.map(s => `${this._dl("Work Order", s.wo_name)} <small>(${this._formatNum(s.pending)} ${this._esc(c.uom)})</small>`).join(" | "));
                    }
                    if (c.supply_pos && c.supply_pos.length) {
                        supplyBits.push(`<span class="por-tree-pill po">Purchasing (open POs):</span> `
                            + c.supply_pos.map(s => `${this._dl("Purchase Order", s.po_name)} <small>${this._esc(s.supplier || "")} ${this._formatNum(s.pending_qty)} ${this._esc(s.uom)} ${s.schedule ? "due " + s.schedule : ""}</small>`).join(" | "));
                    }
                    if (c.supply_mrs && c.supply_mrs.length) {
                        supplyBits.push(`<span class="por-tree-pill mr">Material Requests:</span> `
                            + c.supply_mrs.map(s => `${this._dl("Material Request", s.mr_name)} <small>(${this._formatNum(s.pending_qty)} ${this._esc(s.uom)})</small>`).join(" | "));
                    }
                    if (supplyBits.length) {
                        html += `<tr class="por-tree-supply-row"><td colspan="8">${supplyBits.join("<br>")}</td></tr>`;
                    }
                }
                html += `</tbody></table>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
        return html;
    }

    // ── Planning Mode — Independent vs Priority ───────────────────────────
    // Inspired by WO Kitting Planner's Production Plan tab. Difference: that
    // page applies on Work Orders; here we apply on ITEMS (one row = one item).
    //
    // Independent (default): each item is checked against the FULL stock pool
    //                        independently — the canonical possible_qty from
    //                        the API.
    // Priority: items consume the pool in the visible row order. Earlier rows
    //           get first claim. Determines whether each item is FULLY
    //           producible, PARTIALLY producible, or NOT producible.
    //
    // We persist the original `possible_qty` once on each item as
    // `_origPossibleQty`, so flipping back to Independent restores it.
    _recalcPriorityPossibleQty(rowsToSimulate) {
        if (!this._data || !this._data.items) return;
        // Persist baseline + a per-component required-per-unit ratio derived
        // from API shortage_components.
        this._data.items.forEach(it => {
            if (it._origPossibleQty === undefined) it._origPossibleQty = it.possible_qty;
        });
        const pool = {};
        // If caller passes the visible (sorted/filtered) rows, simulate over
        // that order. Otherwise fall back to global item order.
        const rows = rowsToSimulate || this._data.items;
        for (const it of rows) {
            const comps = it.shortage_components || [];
            let limit = it._origPossibleQty || 0;
            // Calculate the binding component
            for (const c of comps) {
                const reqPerUnit = (it._origPossibleQty > 0 && c.required > 0)
                    ? c.required / it._origPossibleQty : 0;
                if (reqPerUnit > 0) {
                    const onHand = (pool[c.item_code] === undefined ? c.in_stock : pool[c.item_code]);
                    limit = Math.min(limit, onHand / reqPerUnit);
                }
            }
            limit = Math.max(0, Math.floor(limit));
            it.possible_qty = limit;
            it._planning_status = (
                limit >= (it._origPossibleQty || 0) && limit > 0 ? "full"
                : limit > 0 ? "partial"
                : "blocked"
            );
            // Deduct from pool
            for (const c of comps) {
                const reqPerUnit = (it._origPossibleQty > 0 && c.required > 0)
                    ? c.required / it._origPossibleQty : 0;
                if (reqPerUnit > 0) {
                    const onHand = (pool[c.item_code] === undefined ? c.in_stock : pool[c.item_code]);
                    pool[c.item_code] = onHand - reqPerUnit * limit;
                }
            }
        }
    }

    _restoreIndependentPossibleQty() {
        if (!this._data || !this._data.items) return;
        this._data.items.forEach(it => {
            if (it._origPossibleQty !== undefined) it.possible_qty = it._origPossibleQty;
            delete it._planning_status;
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
        if (body) {
            body.innerHTML = `<div class="por-ai-typing"><i class="fa-solid fa-circle-notch fa-spin"></i> Generating briefing…</div>`;
        }

        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_ai_overview_insight",
            args: { context_json: JSON.stringify(ctx), model: this._aiModel },
            callback: (r) => {
                if (!r.message) return;
                const { insight } = r.message;
                if (body) body.innerHTML = insight || `<span class="por-ai-warn">No insight returned.</span>`;
                const dp = document.getElementById("por-ai-data-pts");
                if (dp) dp.textContent =
                    `Data: ${ctx.summary?.total_items || 0} items, ${ctx.items?.length || 0} sent to AI`;
                this._aiInsightLoaded = true;
            },
            error: () => {
                if (body) body.innerHTML = `<span class="por-ai-warn">AI unavailable. Check Error Log → POR AI.</span>`;
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

        // Show user bubble.
        // POR-005 (2026-05-04): pass plain text, not _esc(text) — _appendBubble
        // renders user bubbles via .textContent so the browser handles escaping.
        // Pre-escaping caused double-escape (e.g. user typed "<3" → saw "&lt;3").
        this._appendBubble("user", text);
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
        // Pass ALL filter values — the chart pane must reflect what the user
        // selected. Same warehouse / status / stock-mode set as Overview tab.
        frappe.call({
            method: "chaizup_toc.api.production_overview_api.get_chart_data",
            args: {
                company,
                month:       document.getElementById("por-month").value,
                year:        document.getElementById("por-year").value,
                warehouses:  JSON.stringify(this._selWh),
                wo_statuses: JSON.stringify(this._selWo),
                so_statuses: JSON.stringify(this._selSo),
                pp_statuses: JSON.stringify(this._selPp || []),
                po_statuses: JSON.stringify(this._selPo || []),
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
        const CHART_DEFAULTS = {
            animation: { duration: 400 },
            plugins: { legend: { labels: { font: { size: 11 }, boxWidth: 12 } } },
        };

        // Helper — tooltip callback that prefixes item code with item_name
        // when both arrays are present. Lets bar chart hover read like
        // "CZPFG688 — PREMIUM DUST 50G ... Need 12,000".
        const namedTooltip = (labels, names, uoms) => ({
            callbacks: {
                title(ctx) {
                    const i = ctx[0].dataIndex;
                    const code = labels[i] || "";
                    const name = (names && names[i]) || "";
                    return name ? `${code} — ${name}` : code;
                },
                label(ctx) {
                    const u = (uoms && uoms[ctx.dataIndex]) ? " " + uoms[ctx.dataIndex] : "";
                    const v = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed.x;
                    return `${ctx.dataset.label}: ${Number(v).toLocaleString("en-IN")}${u}`;
                },
            }
        });

        // ── (1) Priority Action Board — top 10 by Target Gap, stacked ─────
        const pri = d.bar_priority_action || {};
        this._makeChart("por-chart-priority", "bar", {
            labels: pri.labels || [],
            datasets: [
                { label: "Stock",      data: pri.stock      || [], backgroundColor: "rgba(16,185,129,.85)", stack: "s" },
                { label: "Pending WO", data: pri.wo_pending || [], backgroundColor: "rgba(14,165,233,.85)", stack: "s" },
                { label: "Gap (action)", data: pri.gap      || [], backgroundColor: "rgba(239,68,68,.9)",   stack: "s" },
            ],
        }, {
            ...CHART_DEFAULTS,
            indexAxis: "y",
            scales: {
                x: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 } } },
                y: { stacked: true, ticks: { font: { size: 10 } } },
            },
            plugins: { ...CHART_DEFAULTS.plugins, tooltip: namedTooltip(pri.labels, pri.item_names, pri.stock_uoms) },
        });

        // ── (2) Daily Production Need ──────────────────────────────────────
        const dn = d.bar_daily_need || {};
        const wd = (dn.working_days_left != null) ? dn.working_days_left : (d.working_days_left || 1);
        this._makeChart("por-chart-daily-need", "bar", {
            labels: dn.labels || [],
            datasets: [
                { label: "Remaining (this month)", data: dn.remaining || [], backgroundColor: "rgba(79,70,229,.75)" },
                { label: `Daily Need (over ${wd} working days)`, data: dn.daily_need || [], backgroundColor: "rgba(245,158,11,.85)" },
            ],
        }, {
            ...CHART_DEFAULTS,
            indexAxis: "y",
            scales: {
                x: { beginAtZero: true, ticks: { font: { size: 10 } } },
                y: { ticks: { font: { size: 10 } } },
            },
            plugins: { ...CHART_DEFAULTS.plugins, tooltip: namedTooltip(dn.labels, dn.item_names, dn.stock_uoms) },
        });

        // ── (3) Production Readiness pie ──────────────────────────────────
        const rp = d.readiness_pie || {};
        this._makeChart("por-chart-readiness", "doughnut", {
            labels: ["Ready","Partial","Blocked","No Demand"],
            datasets: [{
                data: [rp["Ready"]||0, rp["Partial"]||0, rp["Blocked"]||0, rp["No Demand"]||0],
                backgroundColor: ["#10b981","#f59e0b","#ef4444","#94a3b8"],
                borderWidth: 2, borderColor: "#fff",
            }],
        }, { ...CHART_DEFAULTS });

        // ── (4) Shortage status (kept) ────────────────────────────────────
        const shortD = d.shortage_pie || {};
        this._makeChart("por-chart-shortage", "doughnut", {
            labels: ["With Shortage","No Shortage"],
            datasets: [{
                data: [shortD["Yes"]||0, shortD["No"]||0],
                backgroundColor: ["#ef4444","#10b981"],
                borderWidth: 2, borderColor: "#fff",
            }],
        }, { ...CHART_DEFAULTS });

        // ── (5) Coverage Health distribution ──────────────────────────────
        const cv = d.bar_coverage_health || {};
        this._makeChart("por-chart-coverage", "bar", {
            labels: cv.labels || [],
            datasets: [{
                label: "Items",
                data: cv.values || [],
                backgroundColor: ["#ef4444","#f59e0b","#10b981","#0ea5e9","#94a3b8"],
                borderRadius: 4,
            }],
        }, {
            ...CHART_DEFAULTS,
            scales: { y: { beginAtZero: true, precision: 0, ticks: { font: { size: 10 } } } },
            plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
        });

        // ── (6) Shortage Drivers — procurement priority ───────────────────
        const sd = d.bar_shortage_drivers || {};
        this._makeChart("por-chart-shortage-drivers", "bar", {
            labels: sd.labels || [],
            datasets: [
                { label: "Items Blocked",  data: sd.blocks || [],      backgroundColor: "rgba(239,68,68,.85)" },
                { label: "Total Shortage", data: sd.total_short || [], backgroundColor: "rgba(245,158,11,.65)" },
            ],
        }, {
            ...CHART_DEFAULTS,
            indexAxis: "y",
            scales: {
                x: { beginAtZero: true, ticks: { font: { size: 10 } } },
                y: { ticks: { font: { size: 10 } } },
            },
            plugins: { ...CHART_DEFAULTS.plugins, tooltip: namedTooltip(sd.labels, sd.item_names, sd.uoms) },
        });

        // ── (7) Top 10 by Curr Month SO (kept) ────────────────────────────
        const bo = d.bar_orders || {};
        this._makeChart("por-chart-orders", "bar", {
            labels: bo.labels || [],
            datasets: [
                { label: "Curr Month SO", data: bo.orders   || [], backgroundColor: "rgba(79,70,229,.75)",  borderRadius: 3 },
                { label: "Planned Qty",   data: bo.planned  || [], backgroundColor: "rgba(16,185,129,.65)", borderRadius: 3 },
                { label: "Dispatched",    data: bo.dispatch || [], backgroundColor: "rgba(245,158,11,.65)", borderRadius: 3 },
            ],
        }, {
            ...CHART_DEFAULTS,
            scales: { x: { ticks: { maxRotation: 45, font: { size: 10 } } } },
            plugins: { ...CHART_DEFAULTS.plugins, tooltip: namedTooltip(bo.labels, bo.item_names) },
        });

        // ── (8) Projection vs Sales (kept) ────────────────────────────────
        const bp = d.bar_projection || {};
        this._makeChart("por-chart-proj", "bar", {
            labels: bp.labels || [],
            datasets: [
                { label: "Projection",   data: bp.projection || [], backgroundColor: "rgba(14,165,233,.75)", borderRadius: 3 },
                { label: "Actual Sales", data: bp.sales      || [], backgroundColor: "rgba(16,185,129,.75)", borderRadius: 3 },
            ],
        }, {
            ...CHART_DEFAULTS,
            scales: { x: { ticks: { maxRotation: 45, font: { size: 10 } } } },
            plugins: { ...CHART_DEFAULTS.plugins, tooltip: namedTooltip(bp.labels, bp.item_names) },
        });

        // ── (9) WO count by group (kept) ──────────────────────────────────
        const bg = d.bar_wo_by_group || {};
        this._makeChart("por-chart-group", "bar", {
            labels: bg.labels || [],
            datasets: [{ label: "Open WO Count", data: bg.values || [],
                         backgroundColor: "rgba(245,158,11,.7)", borderRadius: 4 }],
        }, {
            ...CHART_DEFAULTS, indexAxis: "y",
            scales: {
                x: { beginAtZero: true, ticks: { font: { size: 11 } } },
                y: { ticks: { font: { size: 11 } } },
            },
        });
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
            po_statuses: JSON.stringify(this._selPo || []),
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
