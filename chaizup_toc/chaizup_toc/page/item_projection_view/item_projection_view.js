// =============================================================================
// CONTEXT: Item Projection View — JS controller.
//   Mounts the Tabulator grid + filter chips + drill-down + XLSX trigger.
//   Backend contract: chaizup_toc.api.item_projection_api.* (4 endpoints).
//
// MEMORY: app_chaizup_toc.md § Item Projection View
//
// INSTRUCTIONS:
//   - Re-init guard via wrapper._ipvInitialized prevents double-mount.
//   - frappe.call() for get_dashboard_data / get_breakdown / get_filter_options.
//   - export_xlsx is hit via direct URL navigation so the browser handles
//     the binary download (Frappe sets the response type to "binary").
//   - Every numeric cell carries a parallel `_tooltips` payload — keyed by
//     fieldname, an array of lines. We render it via a fixed-position
//     custom tooltip on hover (Tabulator's built-in title-attr is too
//     plain for multi-line back-end calculations).
//
// DANGER ZONE:
//   - Tabulator MUST be loaded before this controller runs. The HTML
//     template loads it from jsdelivr; we defer init until window.Tabulator
//     is defined.
//   - frappe.utils.escape_html(undefined) returns "undefined". Always guard.
//   - Filter chip dropdown uses createElement, not innerHTML, to keep
//     user-typed substrings out of the DOM as HTML.
//
// RESTRICT:
//   - Do NOT redefine column formulas in JS. Always use the `columns`
//     payload from the backend so updates to compute flow here.
//   - Do NOT remove the loading overlay element — it's part of the
//     UX contract for "I started a filter and the data is loading".
// =============================================================================

frappe.pages["item-projection-view"].on_page_load = function (wrapper) {
    if (wrapper._ipvInitialized) return;
    wrapper._ipvInitialized = true;

    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: "Item Projection View",
        single_column: true,
    });

    $(frappe.render_template("item_projection_view", {})).appendTo(page.body);

    window._ipvPage = new ItemProjectionView(wrapper, page);
    wrapper._ipvPage = window._ipvPage;
    frappe.breadcrumbs.add("Chaizup Toc");
};

frappe.pages["item-projection-view"].on_page_show = function (wrapper) {
    if (wrapper._ipvPage && wrapper._ipvPage._table) {
        // Re-paint custom row classes after navigation rebuild.
        wrapper._ipvPage._reapplyRowClasses();
    }
};


class ItemProjectionView {
    constructor(wrapper, page) {
        this.wrapper = wrapper;
        this.page    = page;

        // Filter state
        this._fCompany     = "";
        this._fItem        = new Set();
        this._fItemGroup   = new Set();
        this._fWarehouse   = new Set();
        this._fOnlyShort   = false;
        this._fGroupBy     = true;

        // Data state
        this._columns      = null;
        this._rows         = [];
        this._opts         = null;

        // DOM refs
        this._tooltipEl    = null;
        this._openDrop     = null;
        this._table        = null;

        // Wait for Tabulator script to load before any init.
        this._waitForTabulator(() => this._init());
    }

    _waitForTabulator(cb) {
        if (window.Tabulator) return cb();
        let tries = 0;
        const id = setInterval(() => {
            tries++;
            if (window.Tabulator) {
                clearInterval(id);
                cb();
            } else if (tries > 40) {       // ~4 s
                clearInterval(id);
                frappe.show_alert({
                    message: "Failed to load Tabulator from CDN. Check network.",
                    indicator: "red",
                });
            }
        }, 100);
    }

    _init() {
        this._buildTooltipEl();
        this._wireButtons();
        this._wireFilterInputs();
        this._wireDocClickClose();
        this._wireGridTooltipDelegation();
        this._loadFilterOptions().then(() => this._refresh());
    }

    // 2026-05-18 — tooltip event delegation.
    //   Tabulator v6 pools row DOM aggressively (rebuilds on sort, scroll,
    //   filter, dataTree expand). Listeners attached directly inside cell
    //   formatters get wiped, which is why the per-cell tooltip stopped
    //   firing. Solution: attach a SINGLE listener on the grid host and
    //   find the nearest [data-ipv-tt-key] ancestor on every mouse move.
    _wireGridTooltipDelegation() {
        const host = document.getElementById("ipv-grid");
        if (!host || host._ipvTtDelegated) return;
        host._ipvTtDelegated = true;
        host.addEventListener("mousemove", (e) => this._onGridHover(e));
        host.addEventListener("mouseleave", () => this._hideTooltip());
    }

    _onGridHover(e) {
        const t = e.target && e.target.closest
                  ? e.target.closest("[data-ipv-tt-key]")
                  : null;
        if (!t) {
            this._hideTooltip();
            return;
        }
        // Each tooltip-bearing span carries the JSON-encoded tooltip
        // payload + a key. The data is on the span so we don't need to
        // climb back to the Tabulator row data.
        const key = t.getAttribute("data-ipv-tt-key");
        let tips;
        try { tips = JSON.parse(t.getAttribute("data-ipv-tt-data") || "{}"); }
        catch (err) { tips = {}; }
        const lines = tips[key] || [];
        if (!lines.length) { this._hideTooltip(); return; }
        if (!this._tooltipEl) this._buildTooltipEl();
        // Only re-paint when the cell changes (avoid rebuilding on every px).
        if (this._tooltipEl._currentKey !== `${key}|${t._ipvUid || ""}`) {
            this._tooltipEl.innerHTML = "";
            lines.forEach((ln, i) => {
                const s = document.createElement("span");
                s.className = "ipv-tooltip-line" + (i === 0 ? " ipv-tooltip-formula" : "");
                s.textContent = ln;
                this._tooltipEl.appendChild(s);
            });
            this._tooltipEl._currentKey = `${key}|${t._ipvUid || ""}`;
        }
        this._tooltipEl.classList.add("is-visible");
        this._moveTooltip(e);
    }

    // ─────────────────────────────────────────────────────────────────────
    // FILTER OPTIONS
    // ─────────────────────────────────────────────────────────────────────
    _loadFilterOptions() {
        return frappe.call({
            method: "chaizup_toc.api.item_projection_api.get_filter_options",
        }).then(r => {
            this._opts = r.message || {};
            this._fCompany = this._opts.default_company || "";
            const sel = document.getElementById("ipv-filter-company");
            if (sel) {
                sel.innerHTML = "";
                (this._opts.companies || []).forEach(c => {
                    const opt = document.createElement("option");
                    opt.value = c;
                    opt.textContent = c;
                    opt.title = c;        // native hover tooltip
                    if (c === this._fCompany) opt.selected = true;
                    sel.appendChild(opt);
                });
                // Native <select> can't wrap; show the full text via the
                // element-level title attr so hovering the truncated value
                // still reveals the company name.
                sel.title = this._fCompany || "";
                sel.addEventListener("change", () => { sel.title = sel.value || ""; });
            }
        });
    }

    _wireButtons() {
        document.querySelector(".ipv-btn-refresh")?.addEventListener("click",
            () => this._refresh());
        document.querySelector(".ipv-btn-export")?.addEventListener("click",
            () => this._exportXlsx());
    }

    _wireFilterInputs() {
        document.getElementById("ipv-filter-company")
            ?.addEventListener("change", e => {
                this._fCompany = e.target.value;
                this._refresh();
            });
        document.getElementById("ipv-filter-only-shortage")
            ?.addEventListener("change", e => {
                this._fOnlyShort = e.target.checked;
                this._refresh();
            });
        document.getElementById("ipv-filter-group-by")
            ?.addEventListener("change", e => {
                this._fGroupBy = e.target.checked;
                this._refresh();
            });
        // Chip inputs
        ["item", "item-group", "warehouse"].forEach(k => {
            const inp = document.getElementById(`ipv-filter-${k}`);
            if (!inp) return;
            inp.addEventListener("focus",  e => this._openChipDropdown(e.target, k));
            inp.addEventListener("input",  e => this._openChipDropdown(e.target, k));
            inp.addEventListener("keydown", e => {
                if (e.key === "Escape") this._closeChipDropdown();
                if (e.key === "Enter" && inp.value.trim()) {
                    this._addChip(k, inp.value.trim());
                    inp.value = "";
                    this._closeChipDropdown();
                }
            });
        });
    }

    _wireDocClickClose() {
        document.addEventListener("click", e => {
            if (!this._openDrop) return;
            if (this._openDrop.contains(e.target)) return;
            if (e.target.matches("#ipv-filter-item, #ipv-filter-item-group, #ipv-filter-warehouse")) return;
            this._closeChipDropdown();
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // CHIP MULTI-SELECT
    // ─────────────────────────────────────────────────────────────────────
    _chipSetFor(kind) {
        return ({
            "item":         this._fItem,
            "item-group":   this._fItemGroup,
            "warehouse":    this._fWarehouse,
        })[kind];
    }

    _addChip(kind, value, label) {
        const set = this._chipSetFor(kind);
        if (!set || !value) return;
        set.add(value);
        // For Items: remember the human-readable label (Item Name) keyed by
        // item_code so the chip pill can render BOTH "code — name".
        if (kind === "item" && label) {
            this._itemLabels = this._itemLabels || {};
            this._itemLabels[value] = label;
        }
        this._renderChips(kind);
        this._refresh();
    }

    _renderChips(kind) {
        const host = document.getElementById(`ipv-filter-${kind}-chips`);
        if (!host) return;
        host.innerHTML = "";
        const set = this._chipSetFor(kind);
        Array.from(set).forEach(v => {
            const pill = document.createElement("span");
            pill.className = "ipv-pill";
            // Items show "ITEMCODE — Item Name" if we know the name;
            // groups / warehouses show their raw value.
            const niceName = (kind === "item"
                              && this._itemLabels
                              && this._itemLabels[v]);
            if (niceName) {
                // Code in bold + dimmed item name after an em-dash.
                const code = document.createElement("span");
                code.textContent = v;
                code.style.fontWeight = "600";
                const sep = document.createElement("span");
                sep.textContent = " — ";
                sep.style.opacity = "0.55";
                sep.style.margin = "0 2px";
                const name = document.createElement("span");
                name.textContent = niceName;
                name.style.opacity = "0.85";
                pill.appendChild(code);
                pill.appendChild(sep);
                pill.appendChild(name);
                pill.title = `${v} — ${niceName}`;
            } else {
                pill.textContent = v;
            }
            const x = document.createElement("button");
            x.type = "button";
            x.textContent = "×";
            x.addEventListener("click", () => {
                set.delete(v);
                if (kind === "item" && this._itemLabels) {
                    delete this._itemLabels[v];
                }
                this._renderChips(kind);
                this._refresh();
            });
            pill.appendChild(x);
            host.appendChild(pill);
        });
    }

    _openChipDropdown(input, kind) {
        this._closeChipDropdown();
        const drop = document.createElement("div");
        drop.className = "ipv-chip-drop";
        const rect = input.getBoundingClientRect();
        Object.assign(drop.style, {
            position: "fixed",
            left:  `${rect.left}px`,
            top:   `${rect.bottom + 4}px`,
            width: `${rect.width}px`,
            maxHeight: "260px",
            overflow: "auto",
            background: "var(--bg-color, #fff)",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 4px 18px rgba(15,23,42,0.12)",
            zIndex: 1080,
        });
        document.body.appendChild(drop);
        this._openDrop = drop;
        this._fillDropdown(drop, kind, (input.value || "").toLowerCase());
    }

    _closeChipDropdown() {
        if (this._openDrop && this._openDrop.parentNode) {
            this._openDrop.parentNode.removeChild(this._openDrop);
        }
        this._openDrop = null;
    }

    _fillDropdown(drop, kind, lower) {
        drop.innerHTML = "";
        if (kind === "item") {
            // Dynamic remote lookup — frappe.db.get_link_options returns
            //   [{value: ITEM_CODE, description: ITEM_NAME}, ...]
            // We render BOTH in the dropdown item so the user can pick by
            // either code or name. The selected chip also shows both.
            frappe.db.get_link_options("Item", lower, {disabled: 0}).then(arr => {
                if (this._openDrop !== drop) return;
                (arr || []).slice(0, 50).forEach(rec => {
                    const code = rec.value || "";
                    const name = rec.description || "";
                    const it = this._mkDropItem("");        // empty; we build inside
                    it.innerHTML = "";   // clear the textContent
                    const codeEl = document.createElement("span");
                    codeEl.textContent = code;
                    codeEl.style.fontWeight = "600";
                    codeEl.style.marginRight = "8px";
                    it.appendChild(codeEl);
                    if (name && name !== code) {
                        const nameEl = document.createElement("span");
                        nameEl.textContent = name;
                        nameEl.style.opacity = "0.7";
                        nameEl.style.fontSize = "0.78rem";
                        it.appendChild(nameEl);
                    }
                    it.title = name ? `${code} — ${name}` : code;
                    it.addEventListener("mousedown", e => {
                        e.preventDefault();
                        this._addChip("item", code, name);
                        document.getElementById("ipv-filter-item").value = "";
                        this._closeChipDropdown();
                    });
                    drop.appendChild(it);
                });
                if (!drop.children.length) {
                    drop.appendChild(this._mkDropEmpty("No items match"));
                }
            });
            return;
        }
        const pool = (kind === "item-group")
            ? (this._opts?.item_groups || [])
            : (this._opts?.warehouses || []);
        const filtered = pool.filter(v => !lower || v.toLowerCase().includes(lower)).slice(0, 80);
        if (!filtered.length) {
            drop.appendChild(this._mkDropEmpty("No matches"));
            return;
        }
        filtered.forEach(v => {
            const item = this._mkDropItem(v);
            item.addEventListener("mousedown", e => {
                e.preventDefault();
                this._addChip(kind, v);
                document.getElementById(`ipv-filter-${kind}`).value = "";
                this._closeChipDropdown();
            });
            drop.appendChild(item);
        });
    }

    _mkDropItem(label) {
        const it = document.createElement("div");
        it.className = "ipv-chip-drop-item";
        it.textContent = label;
        Object.assign(it.style, {
            padding: "8px 12px",
            cursor: "pointer",
            fontSize: "0.85rem",
            borderBottom: "1px solid #f1f5f9",
        });
        it.addEventListener("mouseover", () => it.style.background = "#eef2ff");
        it.addEventListener("mouseout",  () => it.style.background = "transparent");
        return it;
    }

    _mkDropEmpty(msg) {
        const it = document.createElement("div");
        it.textContent = msg;
        Object.assign(it.style, {
            padding: "10px",
            color: "#94a3b8",
            fontSize: "0.84rem",
            fontStyle: "italic",
            textAlign: "center",
        });
        return it;
    }

    // ─────────────────────────────────────────────────────────────────────
    // REFRESH
    // ─────────────────────────────────────────────────────────────────────
    _filtersPayload() {
        return {
            company:               this._fCompany || "",
            item:                  Array.from(this._fItem),
            item_group:            Array.from(this._fItemGroup),
            warehouse:             Array.from(this._fWarehouse),
            only_shortage:         this._fOnlyShort ? 1 : 0,
            group_by_item_group:   this._fGroupBy ? 1 : 0,
        };
    }

    _refresh() {
        this._setOverlay(true);
        // 2026-05-18 — previously chained `.finally(...)` on the jQuery
        // Deferred returned by frappe.call(). When render code inside the
        // .then() callback threw synchronously, the chain entered rejected
        // state without `.always` and the overlay never hid. Switching to
        // jQuery's `.always()` + an inner try/catch makes the overlay
        // hide unconditionally and surfaces render failures as toasts.
        const promise = frappe.call({
            method: "chaizup_toc.api.item_projection_api.get_dashboard_data",
            args:   {filters: this._filtersPayload()},
        });
        promise.then(r => {
            try {
                const d = r.message || {};
                this._columns = d.columns || [];
                this._rows    = d.rows || [];
                this._renderBanner(d.banner || "");
                this._renderSummary(d.summary || []);
                this._renderGrid();
                this._setRowCount(d.row_count || 0);
            } catch (e) {
                console.error("[IPV] render error", e);
                frappe.show_alert({
                    message: "Render error: " + (e && e.message ? e.message : e),
                    indicator: "red",
                }, 7);
            }
        });
        promise.fail(err => {
            console.error("[IPV] backend error", err);
            frappe.show_alert({
                message: "Failed to load Item Projection View — check the browser console.",
                indicator: "red",
            }, 7);
        });
        // Belt-and-braces: jQuery `.always()` is the canonical hook.
        // Some Frappe deferreds also expose a plain Promise via .promise()
        // but always() works on both. Wrap in a safety setTimeout in case
        // a callback hangs.
        const hide = () => this._setOverlay(false);
        if (typeof promise.always === "function") {
            promise.always(hide);
        } else if (promise && typeof promise.finally === "function") {
            promise.finally(hide);
        } else {
            // Worst case fallback — should never trigger.
            setTimeout(hide, 12000);
        }
        return promise;
    }

    _setOverlay(on) {
        const el = document.getElementById("ipv-grid-overlay");
        if (!el) return;
        el.classList.toggle("is-hidden", !on);
    }

    _setRowCount(n) {
        const el = document.getElementById("ipv-row-count");
        if (el) el.textContent = `${n} item × warehouse row${n === 1 ? "" : "s"}`;
    }

    _renderBanner(html) {
        const host = document.getElementById("ipv-banner-host");
        if (host) host.innerHTML = html || "";
    }

    _renderSummary(arr) {
        const host = document.getElementById("ipv-kpi-row");
        if (!host) return;
        host.innerHTML = "";
        (arr || []).forEach(s => {
            const card = document.createElement("div");
            card.className = `ipv-kpi ipv-kpi--${(s.indicator || "blue").toLowerCase()}`;
            const lbl = document.createElement("div");
            lbl.className = "ipv-kpi-label";
            lbl.textContent = s.label || "";
            const val = document.createElement("div");
            val.className = "ipv-kpi-value";
            val.textContent = (s.value === null || s.value === undefined)
                ? "—" : (typeof s.value === "number"
                            ? s.value.toLocaleString() : String(s.value));
            card.appendChild(lbl); card.appendChild(val);
            host.appendChild(card);
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // GRID
    // ─────────────────────────────────────────────────────────────────────
    _buildTabulatorColumns() {
        const visible = (this._columns || []).filter(c => !c.hidden);
        return visible.map(c => {
            const def = {
                title:      c.label,
                field:      c.fieldname,
                headerSort: true,
                resizable:  true,
                widthGrow:  1,
                minWidth:   c.width || 100,
            };
            if (c.numeric) {
                def.hozAlign = "right";
                def.formatter = (cell) => this._numericCellFormatter(cell, c);
            } else if (c.fieldname === "item_code") {
                def.formatter = (cell) => {
                    const v = cell.getValue();
                    if (!v) return "";
                    return `<a href="/app/item/${frappe.utils.escape_html(v)}" target="_blank">${frappe.utils.escape_html(v)}</a>`;
                };
            } else if (c.fieldname === "item_group") {
                def.formatter = (cell) => {
                    const v = cell.getValue();
                    if (!v) return "";
                    return `<a href="/app/item-group/${encodeURIComponent(v)}" target="_blank">${frappe.utils.escape_html(v)}</a>`;
                };
            } else if (c.fieldname === "warehouse") {
                def.formatter = (cell) => {
                    const v = cell.getValue();
                    if (!v) return "";
                    return `<a href="/app/warehouse/${encodeURIComponent(v)}" target="_blank">${frappe.utils.escape_html(v)}</a>`;
                };
            }
            if (c.drilldown) {
                def.cssClass = (def.cssClass || "") + " ipv-cell-clickable";
                def.cellClick = (e, cell) => this._openDrilldown(c.drilldown, cell);
            }
            return def;
        });
    }

    _numericCellFormatter(cell, colDef) {
        const v = cell.getValue();
        const row = cell.getRow().getData();

        let display;
        if (v === null || v === undefined) display = "—";
        else if (typeof v === "number") {
            display = Number(v).toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: colDef.precision || 3,
            });
        } else display = String(v);

        // Cell-level alert classes
        let cls = "ipv-cell-numeric";
        const fn = colDef.fieldname;
        if (fn === "days_of_cover" && v !== null && v !== undefined && v < 7) cls += " ipv-cell--alert";
        if (fn === "net_available" && v !== null && v !== undefined && v < 0)  cls += " ipv-cell--alert";
        if (fn === "shortage_physical"  && v > 0) cls += " ipv-cell--alert";
        if (fn === "shortage_projected" && v > 0) cls += " ipv-cell--warn";
        if (fn === "current_stock_stock_uom" && v < 0) cls += " ipv-cell--alert";

        const ttKey = fn;
        const el = document.createElement("span");
        el.className = cls;
        el.textContent = display;
        // The grid host has a delegated mousemove listener that reads
        // these two attributes. We avoid wiring per-cell listeners because
        // Tabulator row pooling wipes them on re-render.
        el.setAttribute("data-ipv-tt-key", ttKey);
        el.setAttribute("data-ipv-tt-data", row._tooltips || "{}");
        // Unique-ish marker so the delegation handler can detect cell
        // changes without re-rendering the tooltip on every pixel.
        el._ipvUid = `${row.item_code || ""}|${row.warehouse || ""}|${fn}`;
        return el;
    }

    _renderGrid() {
        const host = document.getElementById("ipv-grid");
        if (!host) return;
        const cols = this._buildTabulatorColumns();
        if (this._table) {
            try { this._table.destroy(); } catch (e) {}
        }
        // Re-wire delegation in case Tabulator replaced the host children.
        host._ipvTtDelegated = false;
        this._wireGridTooltipDelegation();
        // Diagnostic — surface a clear console line so future "table empty"
        // reports can be triaged from devtools immediately.
        console.info(
            `[IPV r3 2026-05-18] rendering grid — rows: ${(this._rows || []).length}, ` +
            `columns: ${cols.length}, groupBy: ${this._fGroupBy}, ` +
            `Tabulator: ${typeof window.Tabulator}`);

        // Defensive guard: if Tabulator never loaded (offline / CDN blocked)
        // show a clear in-host error instead of a silent empty box.
        if (typeof window.Tabulator !== "function") {
            host.innerHTML =
                `<div class="ipv-grid-error">
                    <div class="ipv-grid-error-title">Grid library failed to load</div>
                    <div class="ipv-grid-error-body">
                      Tabulator could not be reached at
                      <code>cdn.jsdelivr.net</code>. Check the network or
                      install an internal mirror. The data layer is fine —
                      <strong>${(this._rows || []).length}</strong> rows were
                      returned by the server.
                    </div>
                 </div>`;
            return;
        }

        // Defensive guard: if backend returned zero rows show a clear hint.
        // (Before this we rendered a Tabulator instance whose default
        // placeholder text could be visually mistaken for "grid broken".)
        if (!this._rows || this._rows.length === 0) {
            host.innerHTML =
                `<div class="ipv-grid-error">
                    <div class="ipv-grid-error-title">No items in the current scope</div>
                    <div class="ipv-grid-error-body">
                      The backend returned zero rows. Either no items exist
                      under the active filters, or your "Only shortage rows"
                      toggle is on with no shortages present. Clear filters
                      to see all items.
                    </div>
                 </div>`;
            return;
        }

        try {
            this._table = new Tabulator(host, {
                data:              this._rows,
                columns:           cols,
                // 2026-05-18 — switched from the custom _children dataTree
                // path to Tabulator's well-tested native `groupBy`. This
                // eliminates a class of "table looks empty" issues where
                // a single group-header summarised hidden leaf rows.
                groupBy:           this._fGroupBy ? "item_group" : false,
                groupStartOpen:    true,
                groupHeader:       (value, count, data, group) =>
                    this._renderGroupHeader(value, count, data, group),
                // fitDataFill: column widths set by content but grid never
                // exceeds the visible host. Horizontal scroll appears only
                // when the data legitimately exceeds the width.
                layout:            "fitDataFill",
                height:            "calc(100vh - 380px)",
                minHeight:         420,
                placeholder:       "No items match the current filters.",
                rowFormatter:      (row) => this._rowFormatter(row),
                initialSort:       [
                    {column: "shortage_projected", dir: "desc"},
                    {column: "net_available",      dir: "asc"},
                ],
            });
        } catch (err) {
            console.error("[IPV] Tabulator init crashed", err);
            host.innerHTML =
                `<div class="ipv-grid-error">
                    <div class="ipv-grid-error-title">Grid initialisation failed</div>
                    <div class="ipv-grid-error-body">
                      ${frappe.utils.escape_html(err && err.message ? err.message : String(err))}
                      <br/><small>See console for full stack.</small>
                    </div>
                 </div>`;
        }
    }

    // Tabulator native groupHeader formatter. Renders a clean summary line
    // with item count + summed shortages so the user gets a quick view of
    // group health without expanding.
    _renderGroupHeader(value, count, data) {
        const sum = (k) => (data || []).reduce(
            (acc, r) => acc + (r[k] || 0), 0);
        const shortPhy  = sum("shortage_physical");
        const shortProj = sum("shortage_projected");
        const netAvail  = sum("net_available");
        const fmt = (v) => v.toLocaleString(undefined, {maximumFractionDigits: 1});
        return `
          <span class="ipv-grp-label">${frappe.utils.escape_html(value || "—")}</span>
          <span class="ipv-grp-count">${count} item${count === 1 ? "" : "s"}</span>
          <span class="ipv-grp-sep"></span>
          <span class="ipv-grp-pair">
            Σ Shortage&nbsp;(Phys) <b class="${shortPhy > 0 ? "is-alert" : ""}">${fmt(shortPhy)}</b>
          </span>
          <span class="ipv-grp-pair">
            Σ Shortage&nbsp;(Proj) <b class="${shortProj > 0 ? "is-warn" : ""}">${fmt(shortProj)}</b>
          </span>
          <span class="ipv-grp-pair">
            Σ Net Available <b class="${netAvail < 0 ? "is-alert" : "is-ok"}">${fmt(netAvail)}</b>
          </span>
        `;
    }

    _rowFormatter(row) {
        const d = row.getData() || {};
        const el = row.getElement();
        if (!el) return;
        el.classList.remove(
            "ipv-row--shortage-physical", "ipv-row--shortage-projected",
            "ipv-row--negative-stock",
        );
        let flags = {};
        try { flags = JSON.parse(d._flags || "{}"); } catch (e) {}
        if (flags.negative_stock) el.classList.add("ipv-row--negative-stock");
        else if (flags.shortage_physical)  el.classList.add("ipv-row--shortage-physical");
        else if (flags.shortage_projected) el.classList.add("ipv-row--shortage-projected");
    }

    _reapplyRowClasses() {
        if (!this._table) return;
        this._table.getRows().forEach(r => this._rowFormatter(r));
    }

    // ─────────────────────────────────────────────────────────────────────
    // TOOLTIP — fixed div, populated from row._tooltips per fieldname.
    // ─────────────────────────────────────────────────────────────────────
    _buildTooltipEl() {
        if (this._tooltipEl) return;
        const el = document.createElement("div");
        el.className = "ipv-tooltip";
        document.body.appendChild(el);
        this._tooltipEl = el;
    }

    _moveTooltip(evt) {
        if (!this._tooltipEl) return;
        const pad = 12;
        let x = evt.clientX + pad;
        let y = evt.clientY + pad;
        const rect = this._tooltipEl.getBoundingClientRect();
        if (x + rect.width  > window.innerWidth  - 8) x = evt.clientX - rect.width  - pad;
        if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
        this._tooltipEl.style.left = `${x}px`;
        this._tooltipEl.style.top  = `${y}px`;
    }

    _hideTooltip() {
        if (!this._tooltipEl) return;
        this._tooltipEl.classList.remove("is-visible");
    }

    // ─────────────────────────────────────────────────────────────────────
    // DRILL-DOWN
    // ─────────────────────────────────────────────────────────────────────
    _openDrilldown(column, cell) {
        const row = cell.getRow().getData();
        if (row._group_header) return;
        const v = cell.getValue();
        if (v === null || v === undefined || v === 0) {
            frappe.show_alert({
                message: `No contributing vouchers for ${column}.`,
                indicator: "blue",
            });
            return;
        }
        frappe.call({
            method: "chaizup_toc.api.item_projection_api.get_breakdown",
            args: {
                column,
                item_code: row.item_code,
                warehouse: row.warehouse || null,
            },
        }).then(r => {
            const payload = r.message || {};
            const dlg = new frappe.ui.Dialog({
                title: payload.title || column,
                size: "extra-large",
            });
            $(dlg.body).empty().append(this._renderBreakdown(payload));
            dlg.show();
        });
    }

    _renderBreakdown(p) {
        const $w = $('<div class="ipv-bd"></div>');
        if (p.scalar) {
            const $box = $('<div class="ipv-bd-scalar"></div>');
            (p.lines || []).forEach(ln => $box.append($("<div></div>").text(ln)));
            return $w.append($box);
        }
        if (p.composite) {
            (p.sections || []).forEach(sec => {
                const $sec = $('<div class="ipv-bd-section"></div>');
                $sec.append($('<div class="ipv-bd-section-title"></div>').text(sec.title));
                $sec.append(this._renderBreakdownTable(sec.rows || [], sec.key, p.higher_uom));
                $w.append($sec);
            });
            return $w;
        }
        const $sec = $('<div class="ipv-bd-section"></div>');
        if (p.header_cols && p.header_cols.length) {
            const $tbl = $('<table class="ipv-bd-table"></table>');
            const $thead = $("<thead><tr></tr></thead>");
            p.header_cols.forEach(h => $thead.find("tr").append($("<th></th>").text(h)));
            $tbl.append($thead);
            const $tb = $("<tbody></tbody>");
            (p.rows || []).forEach(r => $tb.append(this._renderBreakdownRow(r, p.header_cols)));
            if (!p.rows || !p.rows.length) {
                $tb.append(`<tr><td colspan="${p.header_cols.length}" class="ipv-bd-empty">No vouchers contributing to this cell.</td></tr>`);
            }
            $tbl.append($tb);
            $sec.append($tbl);
        }
        return $w.append($sec);
    }

    _renderBreakdownTable(rows, key, higherUom) {
        const $tbl = $('<table class="ipv-bd-table"></table>');
        const header = this._sectionHeader(key, higherUom);
        const $thead = $("<thead><tr></tr></thead>");
        header.forEach(h => $thead.find("tr").append($("<th></th>").text(h)));
        $tbl.append($thead);
        const $tb = $("<tbody></tbody>");
        if (!rows.length) {
            $tb.append(`<tr><td colspan="${header.length}" class="ipv-bd-empty">No rows.</td></tr>`);
        } else {
            rows.forEach(r => $tb.append(this._renderSectionRow(key, r, higherUom)));
        }
        return $tbl.append($tb);
    }

    _sectionHeader(key, h) {
        const u = h || "Higher UOM";
        return ({
            stock:           ["Voucher", "Warehouse", "Actual Qty", "Stock UOM"],
            wo_production:   ["WO", "Status", "FG Warehouse", "Planned", "Produced",
                              "Remaining (Stock)", `Remaining (${u})`, "Planned Start"],
            po:              ["PO", "Status", "Supplier", "Warehouse",
                              "Ordered", "Received", "CF",
                              "Remaining (Stock)", `Remaining (${u})`, "Schedule"],
            wo_consumption:  ["WO", "Status", "Source WH", "Produces (FG)",
                              "Required", "Transferred", "Remaining (Stock)",
                              `Remaining (${u})`, "Planned Start"],
            so:              ["SO", "Status", "Customer", "Warehouse",
                              "Stock Qty", "Delivered", "CF",
                              "Remaining (Stock)", `Remaining (${u})`, "Delivery"],
        })[key] || ["Voucher Type", "Voucher", "Qty"];
    }

    _renderSectionRow(key, r, h) {
        const $tr = $("<tr></tr>");
        const a = (url, txt) => `<a href="${url}" target="_blank">${frappe.utils.escape_html(txt || "")}</a>`;
        const fmtNum = (v) => `<td class="numeric">${(v ?? 0).toLocaleString(undefined, {maximumFractionDigits: 3})}</td>`;
        const fmtText = (v) => `<td>${frappe.utils.escape_html(v === null || v === undefined ? "" : String(v))}</td>`;
        if (key === "stock") {
            $tr.append(`<td>${a("/app/bin/" + encodeURIComponent(r.voucher_name || ""), r.voucher_name || "Bin")}</td>`);
            $tr.append(fmtText(r.warehouse));
            $tr.append(fmtNum(r.actual_qty));
            $tr.append(fmtText(r.stock_uom));
        } else if (key === "wo_production") {
            $tr.append(`<td>${a(r.voucher_url, r.voucher_name)}</td>`);
            $tr.append(fmtText(r.status));
            $tr.append(fmtText(r.warehouse));
            $tr.append(fmtNum(r.planned_qty));
            $tr.append(fmtNum(r.produced_qty));
            $tr.append(fmtNum(r.remaining_qty));
            $tr.append(fmtNum(r.higher_uom_qty));
            $tr.append(fmtText(r.planned_start_date));
        } else if (key === "wo_consumption") {
            $tr.append(`<td>${a(r.voucher_url, r.voucher_name)}</td>`);
            $tr.append(fmtText(r.status));
            $tr.append(fmtText(r.warehouse));
            $tr.append(fmtText(r.produces_item));
            $tr.append(fmtNum(r.required_qty));
            $tr.append(fmtNum(r.transferred_qty));
            $tr.append(fmtNum(r.remaining_qty));
            $tr.append(fmtNum(r.higher_uom_qty));
            $tr.append(fmtText(r.planned_start_date));
        } else if (key === "po") {
            $tr.append(`<td>${a(r.voucher_url, r.voucher_name)}</td>`);
            $tr.append(fmtText(r.status));
            $tr.append(fmtText(r.supplier));
            $tr.append(fmtText(r.warehouse));
            $tr.append(fmtNum(r.qty));
            $tr.append(fmtNum(r.received_qty));
            $tr.append(fmtNum(r.cf));
            $tr.append(fmtNum(r.remaining_stock_qty));
            $tr.append(fmtNum(r.higher_uom_qty));
            $tr.append(fmtText(r.schedule_date));
        } else if (key === "so") {
            $tr.append(`<td>${a(r.voucher_url, r.voucher_name)}</td>`);
            $tr.append(fmtText(r.status));
            $tr.append(fmtText(r.customer));
            $tr.append(fmtText(r.warehouse));
            $tr.append(fmtNum(r.stock_qty));
            $tr.append(fmtNum(r.delivered_qty));
            $tr.append(fmtNum(r.cf));
            $tr.append(fmtNum(r.remaining_stock_qty));
            $tr.append(fmtNum(r.higher_uom_qty));
            $tr.append(fmtText(r.delivery_date));
        }
        return $tr;
    }

    _renderBreakdownRow(r, header) {
        // Non-composite path — for single-column drilldowns (wo_remaining_production
        // etc). We pick fields by position based on header_cols.
        const $tr = $("<tr></tr>");
        const a = (url, txt) => `<a href="${url}" target="_blank">${frappe.utils.escape_html(txt || "")}</a>`;
        const cells = [
            (r.voucher_url ? a(r.voucher_url, r.voucher_name) : frappe.utils.escape_html(r.voucher_name || "")),
            r.status, r.warehouse, r.planned_qty ?? r.qty ?? r.stock_qty ?? r.required_qty,
            r.produced_qty ?? r.received_qty ?? r.delivered_qty ?? r.transferred_qty,
            r.cf, r.remaining_qty ?? r.remaining_stock_qty, r.higher_uom_qty,
            r.planned_start_date ?? r.schedule_date ?? r.delivery_date,
        ];
        header.forEach((h, i) => {
            const v = cells[i];
            const isNum = (typeof v === "number");
            const td = $(`<td${isNum ? ' class="numeric"' : ''}></td>`);
            if (i === 0) td.html(cells[0]);    // voucher cell already HTML
            else if (isNum) td.text((v ?? 0).toLocaleString(undefined, {maximumFractionDigits: 3}));
            else td.text(v === null || v === undefined ? "" : String(v));
            $tr.append(td);
        });
        return $tr;
    }

    // ─────────────────────────────────────────────────────────────────────
    // EXPORT
    // ─────────────────────────────────────────────────────────────────────
    _exportXlsx() {
        const filters = encodeURIComponent(JSON.stringify(this._filtersPayload()));
        const url = `/api/method/chaizup_toc.api.item_projection_api.export_xlsx?filters=${filters}`;
        window.open(url, "_blank");
    }
}
