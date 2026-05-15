// =============================================================================
// CONTEXT: Item Shortage Dashboard Page — JS Controller.
//   Builds a Tabulator-backed data grid with:
//     - 27 columns mirroring the Script Report (single compute source)
//     - Native column sort + multi-sort (shift-click)
//     - Frozen header, zebra rows, light-red pending-SO row
//     - Per-cell drill-down modal (click any numeric cell)
//     - Per-cell UOM tooltip (stock UOM + every conversion factor)
//     - Per-column header tooltip (formula caption)
//     - CSV / XLSX export (Tabulator built-in)
//     - Email composer (frappe.ui.Dialog → backend send)
//     - Multi-select filters (Item Group / Item / Warehouse) with chip UI
//
// MEMORY: chaizup_item_shortage_dashboard.md § Page (added 2026-05-14)
//
// INSTRUCTIONS:
//   - Use frappe.call() to chaizup_toc.api.item_shortage_api.*.
//   - Cell click → backend get_breakdown → render in #isd-modal-bg.
//   - Tabulator placeholder element MUST be a DOM node, not raw HTML — Frappe
//     wraps the entire HTML template in a single-quoted JS string.
//   - Filter chip dropdown is fully built in JS DOM (createElement) to keep
//     raw apostrophes out of inline HTML.
//
// DANGER ZONE:
//   - frappe.utils.escape_html(undefined) → "undefined" literal. Always guard.
//   - Tabulator v6 export("csv") and export("xlsx") are different methods —
//     downloadData("csv", …) for CSV, download("xlsx", …) for XLSX. Mixed
//     signatures in older docs; use download("type", filename) for both here.
//   - The page wrapper persists across navigations — re-init guard via
//     wrapper._isdInitialized prevents double-mount and event leaks.
//
// RESTRICT:
//   - Do NOT redefine column formulas here. Always import them via the
//     `columns` payload from the backend so a fix in the report file flows
//     to the page automatically.
//   - Do NOT remove the floating tooltip element (#isd-tip) — its CSS is
//     load-bearing for the per-cell UOM hover hint on touch devices.
//   - Do NOT swap Tabulator for a different lib without porting every
//     feature in this comment block.
// =============================================================================

frappe.pages["item-shortage-dashboard"].on_page_load = function (wrapper) {
    if (wrapper._isdInitialized) return;
    wrapper._isdInitialized = true;

    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "Item Shortage Dashboard",
        single_column: true,
    });

    $(frappe.render_template("item_shortage_dashboard", {})).appendTo(page.body);

    window._isdPage = new ItemShortageDashboard(wrapper, page);
    wrapper._isdPage = window._isdPage;
    frappe.breadcrumbs.add("Chaizup Toc");
};

frappe.pages["item-shortage-dashboard"].on_page_show = function (wrapper) {
    if (wrapper._isdPage && wrapper._isdPage._table) {
        // Re-tag pending-SO rows after navigation in case Tabulator rebuilt.
        wrapper._isdPage._tagPendingSoRows();
    }
};

class ItemShortageDashboard {
    static _MONTHS = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ];

    constructor(wrapper, page) {
        this.wrapper = wrapper;
        this.page    = page;

        // Data state
        this._columns      = null;
        this._rows         = [];
        this._summary      = [];
        this._banner       = "";
        this._chart        = null;

        // Filter state
        this._fCompany     = "";
        this._fItemGroup   = new Set();
        this._fItemName    = new Set();
        this._fWarehouse   = new Set();
        this._fMonth       = "";
        this._fYear        = "";
        this._fSearch      = "";
        // ISD-014: client-side quick-filter chips (AND together).
        // Keys mirror the data attributes in the HTML chip strip.
        this._qf = {
            shortage:  false,
            open_so:   false,
            open_po:   false,
            open_wo:   false,
            below_max: false,
        };

        // Lookup payloads (loaded once)
        this._opts = {
            companies: [], warehouses: [], item_groups: [], pending: {},
        };

        // Tabulator instance
        this._table = null;
        // Track open chip dropdown so we can close it on outside click
        this._openDrop = null;

        this._init();
    }

    // ─────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────
    _init() {
        const today = new Date();
        const monthSel = document.getElementById("isd-f-month");
        const yearInp  = document.getElementById("isd-f-year");
        if (monthSel) monthSel.value = ItemShortageDashboard._MONTHS[today.getMonth()];
        if (yearInp)  yearInp.value  = today.getFullYear();
        this._fMonth = monthSel ? monthSel.value : "";
        this._fYear  = yearInp  ? yearInp.value  : "";

        this._wireButtons();
        this._wireFilterInputs();
        this._wireDocClickClose();
        this._loadFilterOptions().then(() => this._refresh());
    }

    // ─────────────────────────────────────────────────────────────────────
    // FILTER WIRING
    // ─────────────────────────────────────────────────────────────────────
    _wireButtons() {
        document.getElementById("isd-btn-refresh")?.addEventListener("click",
            () => this._refresh());
        document.getElementById("isd-btn-clear")?.addEventListener("click",
            () => this._clearFilters());
        document.getElementById("isd-btn-csv")?.addEventListener("click",
            () => this._exportCsv());
        document.getElementById("isd-btn-xlsx")?.addEventListener("click",
            () => this._exportXlsx());
        document.getElementById("isd-btn-email")?.addEventListener("click",
            () => this._showEmailDialog());
        document.getElementById("isd-btn-settings")?.addEventListener("click",
            () => frappe.set_route("Form", "TOC Settings"));
        document.getElementById("isd-btn-guide")?.addEventListener("click",
            () => window.open("/toc-guide", "_blank"));
        // ISD-014: quick-filter chips
        document.querySelectorAll("[data-isd-qf]").forEach(chip => {
            chip.addEventListener("click", () => {
                const key = chip.getAttribute("data-isd-qf");
                if (!(key in this._qf)) return;
                this._qf[key] = !this._qf[key];
                chip.classList.toggle("isd-qf-chip-active", this._qf[key]);
                this._applyQuickFilters();
            });
        });
    }

    _wireFilterInputs() {
        document.getElementById("isd-f-company")?.addEventListener("change",
            e => { this._fCompany = e.target.value; this._refresh(); });
        document.getElementById("isd-f-month")?.addEventListener("change",
            e => { this._fMonth = e.target.value; this._refresh(); });
        document.getElementById("isd-f-year")?.addEventListener("change",
            e => { this._fYear = e.target.value; this._refresh(); });

        // Universal search → debounced refresh
        const search = document.getElementById("isd-f-search");
        if (search) {
            let t = null;
            search.addEventListener("input", e => {
                clearTimeout(t);
                this._fSearch = e.target.value;
                t = setTimeout(() => this._refresh(), 320);
            });
        }

        // Chip-multi-select inputs
        document.querySelectorAll("[data-isd-chip-input]").forEach(inp => {
            inp.addEventListener("focus", e => this._openChipDropdown(e.target));
            inp.addEventListener("input", e => this._openChipDropdown(e.target));
            inp.addEventListener("keydown", e => {
                if (e.key === "Escape") this._closeChipDropdown();
            });
        });
    }

    _wireDocClickClose() {
        document.addEventListener("click", e => {
            if (!this._openDrop) return;
            if (this._openDrop.contains(e.target)) return;
            if (e.target.matches("[data-isd-chip-input]")) return;
            this._closeChipDropdown();
        });
    }

    _clearFilters() {
        this._fCompany   = "";
        this._fItemGroup = new Set();
        this._fItemName  = new Set();
        this._fWarehouse = new Set();
        this._fSearch    = "";
        Object.keys(this._qf).forEach(k => (this._qf[k] = false));
        document.querySelectorAll("[data-isd-qf]").forEach(c =>
            c.classList.remove("isd-qf-chip-active"));
        document.getElementById("isd-f-company").value = "";
        document.getElementById("isd-f-search").value = "";
        this._renderChips("item_group");
        this._renderChips("item_name");
        this._renderChips("warehouse");
        this._refresh();
    }

    // ─────────────────────────────────────────────────────────────────────
    // CHIP MULTI-SELECT (Item Group / Item Name / Warehouse)
    // ─────────────────────────────────────────────────────────────────────
    _chipSetFor(kind) {
        return ({
            item_group: this._fItemGroup,
            item_name:  this._fItemName,
            warehouse:  this._fWarehouse,
        })[kind];
    }

    _chipOptionsFor(kind, filter) {
        const lower = (filter || "").toLowerCase();
        let pool = [];
        if (kind === "item_group") pool = this._opts.item_groups || [];
        else if (kind === "warehouse") pool = this._opts.warehouses || [];
        else if (kind === "item_name") {
            // For items, use frappe.db.get_link to remote-search live.
            return null;   // signal: dynamic
        }
        return pool.filter(o => !lower || o.toLowerCase().includes(lower)).slice(0, 100);
    }

    _renderChips(kind) {
        const container = document.querySelector(`[data-isd-multi=\"${kind}\"]`);
        if (!container) return;
        const set = this._chipSetFor(kind);
        // Wipe + rebuild chip elements (preserve the <input> at the end).
        const input = container.querySelector(".isd-chip-input");
        container.querySelectorAll(".isd-chip").forEach(c => c.remove());
        Array.from(set).forEach(v => {
            const chip = document.createElement("span");
            chip.className = "isd-chip";
            chip.textContent = v;
            const x = document.createElement("span");
            x.className = "isd-chip-x";
            x.textContent = "×";
            x.addEventListener("click", () => {
                set.delete(v);
                this._renderChips(kind);
                this._refresh();
            });
            chip.appendChild(x);
            container.insertBefore(chip, input);
        });
    }

    _openChipDropdown(input) {
        this._closeChipDropdown();
        const kind = input.getAttribute("data-isd-chip-input");
        const drop = document.createElement("div");
        drop.className = "isd-chip-drop";
        const rect = input.getBoundingClientRect();
        drop.style.top  = `${rect.bottom + 4}px`;
        drop.style.left = `${rect.left}px`;
        drop.style.width = `${Math.max(rect.width, 240)}px`;
        document.body.appendChild(drop);
        this._openDrop = drop;

        const renderOpts = (opts) => {
            drop.innerHTML = "";
            const set = this._chipSetFor(kind);
            if (!opts || !opts.length) {
                const empty = document.createElement("div");
                empty.className = "isd-chip-opt";
                empty.style.color = "var(--isd-sl-500)";
                empty.textContent = "No matches";
                drop.appendChild(empty);
                return;
            }
            opts.forEach(o => {
                const optEl = document.createElement("div");
                optEl.className = "isd-chip-opt"
                    + (set.has(o) ? " isd-chip-opt-sel" : "");
                optEl.textContent = o;
                optEl.addEventListener("click", () => {
                    if (set.has(o)) set.delete(o);
                    else set.add(o);
                    input.value = "";
                    this._renderChips(kind);
                    this._closeChipDropdown();
                    this._refresh();
                });
                drop.appendChild(optEl);
            });
        };

        const filter = input.value;
        const direct = this._chipOptionsFor(kind, filter);
        if (direct !== null) {
            renderOpts(direct);
        } else {
            // Items: live frappe.db.get_link_options for substring search.
            frappe.call({
                method: "frappe.client.get_list",
                args: {
                    doctype: "Item",
                    fields:  ["name"],
                    filters: filter ? [["name", "like", `%${filter}%`]] : [],
                    limit_page_length: 50,
                    or_filters: filter
                        ? [["item_name", "like", `%${filter}%`]] : null,
                },
                callback(r) {
                    renderOpts((r.message || []).map(x => x.name));
                },
            });
        }
    }

    _closeChipDropdown() {
        if (this._openDrop) {
            this._openDrop.remove();
            this._openDrop = null;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // BACKEND
    // ─────────────────────────────────────────────────────────────────────
    async _loadFilterOptions() {
        const r = await frappe.call({
            method: "chaizup_toc.api.item_shortage_api.get_filter_options",
        });
        const m = r.message || {};
        this._opts.companies   = m.companies   || [];
        this._opts.warehouses  = m.warehouses  || [];
        this._opts.item_groups = m.item_groups || [];
        this._opts.pending     = m.pending     || {};
        // Hydrate company dropdown.
        const sel = document.getElementById("isd-f-company");
        if (sel) {
            sel.innerHTML = `<option value=\"\">All Companies</option>`
                + this._opts.companies.map(c =>
                    `<option value=\"${frappe.utils.escape_html(c)}\">`
                    + `${frappe.utils.escape_html(c)}</option>`).join("");
            if (m.default_company) {
                sel.value = m.default_company;
                this._fCompany = m.default_company;
            }
        }
        // Render the pending-status banner.
        const banner = document.getElementById("isd-banner");
        if (banner) {
            const p = this._opts.pending;
            banner.innerHTML = (
                `<b>Pending Statuses (from <a href=\"/app/toc-settings\">TOC Settings</a>)</b><br>`
                + `<b>SO:</b> ${frappe.utils.escape_html((p.so || []).join(", ") || "—")}<br>`
                + `<b>WO:</b> ${frappe.utils.escape_html((p.wo || []).join(", ") || "—")}<br>`
                + `<b>PO:</b> ${frappe.utils.escape_html((p.po || []).join(", ") || "—")}`
            );
        }
    }

    _currentFilters() {
        return {
            company:          this._fCompany || null,
            item_group:       Array.from(this._fItemGroup),
            item_name:        Array.from(this._fItemName),
            warehouse:        Array.from(this._fWarehouse),
            month:            this._fMonth,
            year:             this._fYear,
            universal_search: this._fSearch,
        };
    }

    async _refresh() {
        this._showLoader(true);
        try {
            const r = await frappe.call({
                method: "chaizup_toc.api.item_shortage_api.get_dashboard_data",
                args:   { filters: this._currentFilters() },
            });
            const m = r.message || {};
            this._columns = m.columns || [];
            this._rows    = m.rows    || [];
            this._summary = m.summary || [];
            this._chart   = m.chart;
            this._renderSummary();
            this._renderGrid();
            this._refreshQfCounts();
            this._applyQuickFilters();
        } catch (e) {
            console.error("Item Shortage Dashboard refresh failed", e);
            frappe.show_alert(
                { message: __("Failed to load dashboard"), indicator: "red" });
        } finally {
            this._showLoader(false);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // RENDER
    // ─────────────────────────────────────────────────────────────────────
    // ISD-013: Loading overlay sits OUTSIDE the Tabulator host, toggled
    // via the .isd-loading-on class. Tabulator never wipes it because
    // it lives at a sibling DOM level. _showLoader(true) shows, false hides.
    _showLoader(show) {
        const overlay = document.getElementById("isd-loading");
        if (!overlay) return;
        overlay.classList.toggle("isd-loading-on", !!show);
    }

    _renderSummary() {
        const bar = document.getElementById("isd-summary");
        if (!bar) return;
        bar.innerHTML = "";
        (this._summary || []).forEach(s => {
            const span = document.createElement("span");
            const cls = ({
                red:    "isd-stat-err",
                orange: "isd-stat-warn",
                yellow: "isd-stat-warn",
                green:  "isd-stat-ok",
                blue:   "isd-stat-info",
            })[(s.indicator || "").toLowerCase()] || "";
            span.className = `isd-stat ${cls}`;
            span.innerHTML = (
                `<span class=\"isd-stat-val\">${frappe.utils.escape_html(String(s.value))}</span>`
                + ` <span>${frappe.utils.escape_html(s.label || "")}</span>`
            );
            bar.appendChild(span);
        });
    }

    _renderGrid() {
        const host = document.getElementById("isd-grid");
        if (!host) return;
        // Clear old grid only — the loader is now an overlay sibling, not
        // a child of `host`, so we don't need to wipe innerHTML.
        if (this._table) {
            this._table.destroy();
            this._table = null;
        }

        // Tabulator column definitions derived from backend columns payload.
        const tabCols = this._buildTabulatorColumns();

        // Cap option: small datasets render in DOM; larger use virtualized rows.
        const isLarge = (this._rows || []).length > 250;

        this._table = new Tabulator(host, {
            data:               this._rows,
            columns:            tabCols,
            layout:             "fitDataStretch",
            height:             "100%",
            placeholder:        "No items match the current filters",
            rowFormatter:       row => this._rowFormatter(row),
            tooltipsHeader:     true,
            // Multi-sort via shift-click is enabled by default in Tabulator v6;
            // we also seed a sensible initial sort (worst shortage first).
            initialSort:        [
                { column: "total_shortage_with_expected", dir: "desc" },
            ],
            // Virtualized for large datasets — much smoother scroll.
            virtualDom:         isLarge,
            virtualDomBuffer:   600,
            movableColumns:     true,
            persistence:        false,   // do not stash to localStorage
        });

        this._table.on("rowFormatted", row => {
            const data = row.getData();
            if (data && data._has_pending_so) {
                row.getElement().classList.add("isd-row-pending-so");
            }
        });
    }

    _tagPendingSoRows() {
        if (!this._table) return;
        this._table.getRows().forEach(row => {
            const data = row.getData();
            if (data && data._has_pending_so) {
                row.getElement().classList.add("isd-row-pending-so");
            }
        });
    }

    _rowFormatter(row) {
        const data = row.getData();
        if (data && data._has_pending_so) {
            row.getElement().classList.add("isd-row-pending-so");
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // ISD-014: Client-side quick-filter chips.
    //   - Predicates run against the in-memory row data (no extra round-trip).
    //   - Chips AND together — a row must pass every active chip to display.
    //   - Counts shown in each chip = count of rows matching JUST THAT
    //     predicate against the loaded data (not the AND combination), so
    //     the user can see "Open SO: 14" even when Shortage is also active.
    // DANGER: Tabulator setFilter() replaces the existing filter set; we
    //   pass a SINGLE function that combines the active predicates.
    // ─────────────────────────────────────────────────────────────────────
    _qfPredicates() {
        return {
            shortage:  r => Number(r.total_shortage_with_expected) > 0,
            open_so:   r => !!r._has_pending_so
                            || Number(r.will_dispatch_pending_so) > 0
                            || Number(r.curr_month_pending_so)    > 0
                            || Number(r.prev_month_pending_so)    > 0,
            open_po:   r => Number(r.will_recv_purchase) > 0,
            open_wo:   r => Number(r.will_recv_production) > 0
                            || Number(r.will_be_used_in_open_wos) > 0,
            below_max: r => Number(r.max_level) > 0
                            && Number(r.max_level_pct) < 50,
        };
    }

    _applyQuickFilters() {
        if (!this._table) return;
        const preds = this._qfPredicates();
        const active = Object.entries(this._qf)
            .filter(([_, on]) => on)
            .map(([k]) => preds[k])
            .filter(Boolean);
        if (!active.length) {
            this._table.clearFilter(true);
            return;
        }
        this._table.setFilter(row => active.every(p => p(row)));
    }

    _refreshQfCounts() {
        const preds = this._qfPredicates();
        Object.entries(preds).forEach(([key, fn]) => {
            const count = (this._rows || []).filter(fn).length;
            const el = document.getElementById(`isd-qf-count-${key}`);
            if (el) el.textContent = String(count);
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // TABULATOR COLUMNS — built from backend `columns` payload but with
    // formatters / tooltips / click handlers added on the client.
    // ─────────────────────────────────────────────────────────────────────
    _buildTabulatorColumns() {
        const numericClickable = new Set([
            "current_stock",
            "max_level",
            "total_shortage_with_expected",
            "total_shortage_stock_only",
            "need_as_per_max_level",
            "decision_qty",
            "will_be_used_in_open_wos",
            "will_dispatch_pending_so",
            "prev_month_pending_so",
            "curr_month_pending_so",
            "curr_month_dispatch",
            "will_recv_production",
            "will_recv_purchase",
            "sales_projection",
            "actual_produced_qty",
            "total_dispatches",
        ]);
        const tooltipMap = this._columnTooltipMap();

        // ISD-009 + ISD-010: numeric columns now render two-line cells
        // (primary stock UOM + alt UOM lines) and headers wrap. Bump the
        // computed width so neither dimension clips. Float / Percent /
        // Currency get +35 px; the rest keep backend-supplied widths.
        const expandTypes = new Set(["Float", "Percent", "Currency"]);
        return (this._columns || [])
            .filter(c => !c.hidden)
            .map(c => {
                const baseWidth = c.width || 120;
                const wantWide = expandTypes.has(c.fieldtype);
                const tabCol = {
                    title:    this._stripHtml(c.label || c.fieldname),
                    field:    c.fieldname,
                    width:    wantWide ? Math.max(baseWidth, 145) : baseWidth,
                    minWidth: 90,
                    headerTooltip: tooltipMap[c.fieldname] || c.label || "",
                    headerSort:    true,
                    headerHozAlign: "left",
                    headerWordWrap: true,
                    resizable: true,
                };
                // Numeric vs text alignment + cell formatter.
                const isNum = ["Float", "Int", "Percent", "Currency"]
                    .includes(c.fieldtype);
                if (isNum) {
                    tabCol.hozAlign = "right";
                    tabCol.sorter   = "number";
                    tabCol.cssClass = "isd-num";
                }
                // Frozen first column (item code) for horizontal scroll.
                if (c.fieldname === "item_code") tabCol.frozen = true;
                // Type-specific cell formatter.
                tabCol.formatter = (cell) => this._cellFormatter(cell, c, numericClickable);
                // Per-cell tooltip — shows the UOM conversion ladder.
                tabCol.tooltip = (e, cell) => this._cellTooltip(cell, c);
                // Click handler for drill-down on numeric clickable columns.
                if (numericClickable.has(c.fieldname)) {
                    tabCol.cellClick = (e, cell) => {
                        this._showBreakdown(c.fieldname, cell.getData());
                    };
                }
                // Link-style for item_code / warehouse columns.
                if (c.fieldtype === "Link") {
                    tabCol.formatter = (cell) => this._linkFormatter(cell, c);
                }
                return tabCol;
            });
    }

    _columnTooltipMap() {
        // Header tooltips: explain the formula behind every column.
        // Plain text — Tabulator escapes header tooltips automatically.
        return {
            item_code: "Item master ID (a).",
            item_name: "Item master name (b).",
            item_group: "Item Group classification from Item master (c).",
            warehouse: "Item Minimum Manufacture warehouse rule. Empty = synthetic row aggregating across all warehouses.",
            stock_uom: "Stock UOM of the item (used for all numeric columns).",
            current_stock: "i = Σ Bin.actual_qty at the selected warehouse(s).",
            max_level: "l = Item Minimum Manufacture.max_level (auto = ADU × Lead × Safety).",
            max_level_pct: "m = (i ÷ l) × 100.",
            total_shortage_with_expected: "o = max(0, (i + j + k) − (d + e)).",
            total_shortage_stock_only: "q = max(0, i − (d + e)).",
            need_as_per_max_level: "p = max(0, l − ((i + j + k) − (d + e))).",
            decision_qty: "Decision = max(p, o).",
            will_be_used_in_open_wos: "d = Σ (WO Item.required_qty − transferred_qty).",
            will_dispatch_pending_so: "e = Σ pending SO qty (any delivery month).",
            prev_month_pending_so: "f = Σ pending SO with delivery_date in previous month.",
            curr_month_pending_so: "g = Σ pending SO with delivery_date in selected month.",
            curr_month_dispatch: "h = Σ Delivery Note Item.stock_qty in selected month.",
            will_recv_production: "j = Σ (WO.qty − produced) on open Work Orders.",
            will_recv_purchase: "k = Σ (PO.qty − received) × conv_factor on open POs.",
            sales_projection: "n = Σ Sales Projected Items.qty_in_stock_uom in selected month.",
            sp_cover_pct_sales: "Sales Projection ÷ (g + h) × 100.",
            sp_cover_pct_production: "Sales Projection ÷ (j + Actual Produced) × 100.",
            actual_produced_qty: "prod = Σ Manufacture STE finished-item qty in selected month.",
            total_dispatches: "Σ Delivery Note Item.stock_qty (all time).",
            lead_time_days: "Item Minimum Manufacture.lead_time_days.",
            safety_factor: "Item Minimum Manufacture.safety_factor (buffer multiplier).",
            adu: "Item Minimum Manufacture.adu (Average Daily Usage).",
        };
    }

    _stripHtml(s) {
        return String(s || "").replace(/<[^>]+>/g, "");
    }

    _linkFormatter(cell, col) {
        const v = cell.getValue();
        if (!v) return "";
        const route = (col.options || "").toLowerCase().replace(/\s+/g, "-");
        const url = `/app/${route}/${encodeURIComponent(v)}`;
        return `<a href=\"${url}\" target=\"_blank\" rel=\"noopener\">${frappe.utils.escape_html(String(v))}</a>`;
    }

    _cellFormatter(cell, col, clickable) {
        const v = cell.getValue();
        if (col.fieldname === "item_code" || col.fieldname === "warehouse"
            || col.fieldname === "item_group" || col.fieldname === "stock_uom") {
            return this._linkFormatter(cell, col);
        }
        const data = cell.getData();

        // ─── Build the cell body ────────────────────────────────────────
        // ISD-009 (2026-05-14): Numeric quantity columns now render in
        // TWO LINES — primary stock-UOM line + secondary conversion line
        // ("1000 g" / "1 kg"). Non-numeric and percentage columns keep
        // a single line.
        let body;
        if (v == null || v === "") {
            body = `<span class=\"isd-num-empty\">—</span>`;
        } else if (typeof v === "number") {
            body = this._renderNumericCell(v, col, data, clickable);
        } else {
            body = `<span class=\"isd-num-mono\">${frappe.utils.escape_html(String(v))}</span>`;
        }

        // ─── Conditional styling classes ────────────────────────────────
        let cls = clickable.has(col.fieldname) ? "isd-cell-click" : "";
        if (col.fieldname === "total_shortage_with_expected"
            && Number(data.total_shortage_with_expected) > 0) {
            cls += " isd-shortage-red";
        }
        if (col.fieldname === "total_shortage_stock_only"
            && Number(data.total_shortage_stock_only) > 0) {
            cls += " isd-shortage-orange";
        }
        if (col.fieldname === "max_level_pct") {
            const pct = Number(data.max_level_pct);
            if (pct < 33) cls += " isd-pct-red";
            else if (pct < 67) cls += " isd-pct-orange";
            else cls += " isd-pct-green";
        }
        if (col.fieldname === "decision_qty" && Number(data.decision_qty) > 0) {
            return `<span class=\"isd-decision-pill ${cls}\">${body}</span>`;
        }
        return `<span class=\"${cls}\">${body}</span>`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // CONTEXT: _renderNumericCell — two-line cell renderer.
    //   Primary line  = value in the row's stock UOM.
    //   Secondary line = the value rendered in every conversion UOM
    //                    available for that item (1000 g → 1 kg, etc.).
    //
    //   ISD-009 (2026-05-14): user requested both-UOM inline rather than
    //   tooltip-only. The conversion factors come from `_uom_conversions`
    //   which the backend attaches to each row. Percentage / Int columns
    //   stay single-line — only Float quantity columns get the dual view.
    //
    // DANGER ZONE:
    //   - `c.factor` from the UOM Conversion Detail row is the "1 alt = factor × stock"
    //     ratio per ERPNext convention. So qty_in_alt = stock_qty / factor.
    //     If the factor is 0 the line is skipped (defensive).
    //   - Empty / zero values still render — they show "0 Pcs · 0 CFC".
    // ─────────────────────────────────────────────────────────────────────
    _renderNumericCell(v, col, data, clickable) {
        // Single-line for percentage + int columns.
        if (col.fieldtype === "Percent" || col.fieldtype === "Int") {
            return `<span class=\"isd-num-mono\">${this._fmtNum(v, col)}</span>`;
        }
        // Quantity column → two-line rendering with conversions.
        const stockUom = data.stock_uom || "";
        const primary = `${this._fmtNumPretty(v, col.precision || 2)} `
            + `<span class=\"isd-uom\">${frappe.utils.escape_html(stockUom)}</span>`;
        let secondary = "";
        try {
            const conv = data._uom_conversions
                ? JSON.parse(data._uom_conversions) : [];
            const lines = [];
            conv.forEach(c => {
                if (!c || !c.factor || Number(c.factor) === 0) return;
                if (c.uom === stockUom) return;
                const inAlt = Number(v) / Number(c.factor);
                // Skip noisy near-zero conversions (e.g. 0.001 pcs when stock_qty=0)
                if (Math.abs(inAlt) < 1e-6 && Number(v) === 0) {
                    lines.push(
                        `0 <span class=\"isd-uom\">${frappe.utils.escape_html(c.uom)}</span>`,
                    );
                } else {
                    lines.push(
                        `${this._fmtNumPretty(inAlt, 3)} `
                        + `<span class=\"isd-uom\">${frappe.utils.escape_html(c.uom)}</span>`,
                    );
                }
            });
            if (lines.length) {
                secondary = `<div class=\"isd-num-alt\">${lines.join("<br>")}</div>`;
            }
        } catch (e) { /* secondary line is best-effort */ }
        return (
            `<div class=\"isd-num-primary\">${primary}</div>${secondary}`
        );
    }

    _fmtNum(v, col) {
        if (col.fieldtype === "Int") return Number(v).toLocaleString();
        if (col.fieldtype === "Percent")
            return `${Number(v).toFixed(col.precision || 1)}%`;
        const p = col.precision || 2;
        return Number(v).toLocaleString(undefined, {
            minimumFractionDigits: p, maximumFractionDigits: p,
        });
    }

    // Numeric formatter that strips redundant trailing zeros so values
    // like "1000.00 g" render as "1,000 g" and "0.500 kg" stays "0.500 kg".
    // The `maxDp` cap prevents floating-point noise from polluting the UI.
    _fmtNumPretty(v, maxDp) {
        const n = Number(v);
        if (!isFinite(n)) return "0";
        const dp = Math.min(Math.max(maxDp || 2, 0), 6);
        const fixed = n.toFixed(dp);
        // Strip trailing zeros (keep at least an integer view).
        const stripped = fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
        const parts = stripped.split(".");
        parts[0] = Number(parts[0]).toLocaleString();
        return parts.join(".");
    }

    _cellTooltip(cell, col) {
        const data = cell.getData();
        if (!data) return "";
        const v = cell.getValue();
        if (v == null || v === "" || typeof v !== "number") return "";
        try {
            const conv = data._uom_conversions
                ? JSON.parse(data._uom_conversions) : [];
            if (!conv.length) return "";
            const parts = [`${Number(v).toFixed(2)} ${data.stock_uom}`];
            conv.forEach(c => {
                if (!c || !c.factor || c.uom === data.stock_uom) return;
                const inU = Number(v) / Number(c.factor);
                parts.push(`${inU.toFixed(3)} ${c.uom}`);
            });
            return parts.join("  |  ");
        } catch (e) {
            return "";
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // DRILL-DOWN MODAL
    // ─────────────────────────────────────────────────────────────────────
    _showBreakdown(column, rowData) {
        const itemCode = rowData.item_code;
        const wh = rowData.warehouse || null;
        const title = `${this._stripHtml(this._columnLabel(column))} — ${itemCode}`
            + (wh ? ` @ ${wh}` : "");

        this._openModal(title, this._loaderHtml());

        frappe.call({
            method: "chaizup_toc.api.item_shortage_api.get_breakdown",
            args: {
                column:    column,
                item_code: itemCode,
                warehouse: wh,
                month:     this._fMonth,
                year:      this._fYear,
            },
            callback: (r) => {
                const out = r.message || {};
                this._renderBreakdown(out);
            },
            error: () => {
                document.getElementById("isd-modal-body").innerHTML
                    = `<div class="isd-empty">Failed to load breakdown.</div>`;
            },
        });
    }

    _columnLabel(field) {
        const col = (this._columns || []).find(c => c.fieldname === field);
        return col ? col.label : field;
    }

    _loaderHtml() {
        return `<div class=\"isd-loader\"><div class=\"isd-spinner\"></div>`
            + `Loading breakdown&hellip;</div>`;
    }

    _renderBreakdown(out) {
        const rows = out.rows || [];
        const total = out.total || 0;
        const formula = out.formula || "";
        const body = document.getElementById("isd-modal-body");
        if (!body) return;

        let html = `<div class=\"isd-formula\">${frappe.utils.escape_html(formula)}</div>`;
        if (!rows.length) {
            html += `<div class=\"isd-empty\">No contributing documents found.</div>`;
        } else {
            html += `<table class=\"isd-dtable\">`
                + `<thead><tr><th>Type</th><th>Document</th><th class=\"isd-num\">Qty</th><th>Detail</th></tr></thead><tbody>`;
            rows.forEach(r => {
                const route = String(r.doc_type || "").toLowerCase().replace(/\s+/g, "-");
                const link = (route && r.doc)
                    ? `<a href=\"/app/${route}/${encodeURIComponent(r.doc)}\" target=\"_blank\" rel=\"noopener\">${frappe.utils.escape_html(r.doc)}</a>`
                    : frappe.utils.escape_html(r.doc || "");
                html += (
                    `<tr><td>${frappe.utils.escape_html(r.doc_type || "")}</td>`
                    + `<td>${link}</td>`
                    + `<td class=\"isd-num\">${Number(r.qty || 0).toFixed(3)}</td>`
                    + `<td style=\"color:var(--isd-sl-500);font-size:11px\">${frappe.utils.escape_html(r.extra || "")}</td></tr>`
                );
            });
            html += `</tbody><tfoot><tr><td colspan=\"2\">Total</td><td class=\"isd-num\">${Number(total).toFixed(3)}</td><td></td></tr></tfoot></table>`;
        }
        body.innerHTML = html;
    }

    _openModal(title, bodyHtml) {
        this._closeModal();
        const bg = document.createElement("div");
        bg.id = "isd-modal-bg";
        bg.className = "isd-modal-bg";
        bg.innerHTML = (
            `<div class=\"isd-modal\" role=\"dialog\" aria-label=\"${frappe.utils.escape_html(title)}\">`
            + `  <div class=\"isd-modal-hdr\">`
            + `    <div class=\"isd-modal-title\">${frappe.utils.escape_html(title)}</div>`
            + `    <button class=\"isd-modal-close\" id=\"isd-modal-close\" aria-label=\"Close\">&times;</button>`
            + `  </div>`
            + `  <div class=\"isd-modal-body\" id=\"isd-modal-body\">${bodyHtml || ""}</div>`
            + `</div>`
        );
        document.body.appendChild(bg);
        bg.addEventListener("click", e => {
            if (e.target === bg) this._closeModal();
        });
        document.getElementById("isd-modal-close")
            ?.addEventListener("click", () => this._closeModal());
    }

    _closeModal() {
        const bg = document.getElementById("isd-modal-bg");
        if (bg) bg.remove();
    }

    // ─────────────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────────────
    _exportCsv() {
        if (!this._table) return;
        this._table.download("csv", `item-shortage-${frappe.datetime.now_date()}.csv`);
    }

    // ISD-015 (2026-05-14): XLSX export is now SERVER-SIDE — branded
    // multi-sheet workbook produced by openpyxl. Triggers via a form POST
    // so the browser saves the file directly. The Tabulator-side xlsx
    // fallback was removed because the cover sheet / shortage-drivers /
    // pending-SO subsheets aren't expressible client-side without a much
    // heavier xlsx pipeline.
    _exportXlsx() {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/api/method/chaizup_toc.api.item_shortage_api.export_xlsx";
        form.target = "_self";
        const csrf = document.createElement("input");
        csrf.type = "hidden";
        csrf.name = "csrf_token";
        csrf.value = frappe.csrf_token || "";
        form.appendChild(csrf);
        const filters = document.createElement("input");
        filters.type = "hidden";
        filters.name = "filters";
        filters.value = JSON.stringify(this._currentFilters());
        form.appendChild(filters);
        document.body.appendChild(form);
        form.submit();
        // Cleanup after the navigation triggers download.
        setTimeout(() => form.remove(), 800);
    }

    // ─────────────────────────────────────────────────────────────────────
    // EMAIL DIALOG
    // ─────────────────────────────────────────────────────────────────────
    _showEmailDialog() {
        const d = new frappe.ui.Dialog({
            title: __("Email Item Shortage Dashboard"),
            fields: [
                { fieldname: "recipients", label: "To", fieldtype: "Data", reqd: 1,
                  description: "Comma-separated email addresses" },
                { fieldname: "cc", label: "CC", fieldtype: "Data" },
                { fieldname: "subject", label: "Subject", fieldtype: "Data",
                  reqd: 1,
                  default: `Item Shortage Dashboard — ${frappe.datetime.now_date()}` },
                { fieldname: "message", label: "Message", fieldtype: "Text Editor",
                  default: ("Please find the latest Item Shortage Dashboard "
                           + "snapshot attached below.<br><br>"
                           + "Generated from ERPNext / TOC Buffer Management.") },
            ],
            primary_action_label: __("Send"),
            primary_action: (values) => {
                frappe.call({
                    method: "chaizup_toc.api.item_shortage_api.send_email_snapshot",
                    args: {
                        recipients: values.recipients,
                        cc: values.cc || "",
                        subject: values.subject,
                        message: values.message,
                        filters: this._currentFilters(),
                    },
                    freeze: true,
                    freeze_message: __("Sending email…"),
                    callback: (r) => {
                        if (r.message && r.message.queued) {
                            frappe.show_alert({
                                message: __("Email queued"),
                                indicator: "green",
                            });
                            d.hide();
                        }
                    },
                });
            },
        });
        d.show();
    }
}
