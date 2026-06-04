// =============================================================================
// CONTEXT: Item Short / Surplus — JS controller (v0.0.23 rewrite, 2026-05-27).
//   The v0.0.22 first attempt failed silently in the browser — only the first
//   3 filter chips rendered and the table never mounted. Root causes:
//
//     1. Used `_.debounce` (lodash) which isn't reliably available on every
//        Frappe Desk page version. Threw a ReferenceError that nuked the
//        controller mid-construct.
//
//     2. The multi-select chip widget's async fetch (Link autocomplete)
//        captured `selSet` at fetch time rather than reading from state
//        on each option click — selections silently drifted.
//
//     3. Filter bar layout was column-grid not row-flow → didn't match the
//        Item Shortage Dashboard chrome the user wanted as the reference.
//
//   v0.0.23 rewrite — strategy:
//     - Mirror the Item Shortage Dashboard JS structure: jQuery DOM building
//       + every dynamic value escaped via frappe.utils.escape_html, Tabulator
//       init once + destroy/recreate on refresh, single source of truth =
//       this.state.
//     - Filter bar: Pending Statuses banner + Row 1 (item / item group /
//       warehouse / company) + Row 2 (SO/WO/PO status & workflow multi
//       chips) + Row 3 (quick filter pills) + Row 4 (Refresh / Reset /
//       Export action buttons). Matches the Item Shortage Dashboard chrome.
//     - Dual-UOM cells render as a STACKED two-line cell (1,000 Gram / 1 Kg).
//       XLSX export keeps them split — backend ships both fields, dashboard
//       merges visually, Excel renders both columns.
//     - All chip option clicks read `this.state[key]` at click time (not
//       captured at render time). Selection drift from captured Sets was
//       the v0.0.22 bug.
//
// MEMORY: app_chaizup_toc.md § v0.0.22 / v0.0.23 — Item Short / Surplus
// DOC:    ./item_short_surplus.md
//
// DANGER ZONE:
//   - Tabulator MUST be loaded before init. Polling guard handles slow CDN.
//   - frappe.utils.escape_html(undefined) returns "undefined" — always guard
//     with `|| ""`.
//   - The "click cell → drilldown" uses cell.cellClick, NOT the row-level
//     rowClick. Otherwise clicking the item-name cell (which opens the
//     Item doc in a new tab) would also trigger a useless drilldown.
//   - All .html() / .append() of dynamic values pass through
//     frappe.utils.escape_html() FIRST. Static template strings are safe.
//
// RESTRICT:
//   - DO NOT call lodash (_.foo). Frappe ships `frappe.utils.debounce`
//     (a hand-rolled debouncer) — use that or a native setTimeout closure.
//   - DO NOT redefine column formulas in JS — the backend ships them
//     in the get_report payload's `columns` field.
//   - DO NOT remove the "merge two UOMs in one cell" rendering. User
//     explicitly asked for it in the spec follow-up; XLSX still uses
//     separate columns per the spec.
//   - DO NOT add cell-row hover effects that swallow the cell-click
//     event. Drill-down on number is the primary "tell me why" affordance.
//   - When wiring chip option clicks, ALWAYS read state at click time
//     (not at render time). Selection drift from captured Sets was
//     the v0.0.22 bug.
// =============================================================================

frappe.pages["item-short-surplus"].on_page_load = function (wrapper) {
    if (wrapper._issInitialized) return;
    wrapper._issInitialized = true;

    const page = frappe.ui.make_app_page({
        parent: wrapper,
        title: __("Item Short / Surplus"),
        single_column: true,
    });

    $(frappe.render_template("item_short_surplus", {})).appendTo(page.body);

    window._issPage = new ItemShortSurplusPage(wrapper, page);
    wrapper._issPage = window._issPage;
    frappe.breadcrumbs.add("Chaizup Toc");
};

frappe.pages["item-short-surplus"].on_page_show = function (wrapper) {
    if (wrapper._issPage && wrapper._issPage.table) {
        try { wrapper._issPage.table.redraw(true); } catch (e) {}
    }
};

/* v0.0.25 — clean up any orphaned dropdowns when navigating away.
   Dropdowns are appended to <body> to escape Frappe's transformed
   ancestors; without this cleanup, leaving the page leaves them
   orphaned in the DOM. */
frappe.pages["item-short-surplus"].on_page_hide = function () {
    document.querySelectorAll(".iss-multiselect-dropdown")
        .forEach(d => d.classList.remove("open"));
};

const _esc = (v) => frappe.utils.escape_html(String(v == null ? "" : v));

// v0.0.37 — Friendly local timestamp format used by every report
// surface (footer "generated" stamp, drilldown dates, etc.).
// Output: "dd-MMM-yyyy hh:mm am/pm"  →  e.g. "28-May-2026 02:31 AM"
// Falls back to the raw value if moment can't parse it (so we never
// silently drop a non-standard string the backend might send).
const _fmtTs = (v) => {
    if (v == null || v === "") return "";
    try {
        // moment ships with Frappe; format() returns a string.
        const m = moment(v);
        if (!m.isValid()) return String(v);
        return m.format("DD-MMM-YYYY hh:mm A");
    } catch (e) {
        return String(v);
    }
};
// Date-only variant — same format minus the time. Used where the
// backend hands us a posting_date (no time component).
const _fmtDate = (v) => {
    if (v == null || v === "") return "";
    try {
        const m = moment(v);
        if (!m.isValid()) return String(v);
        return m.format("DD-MMM-YYYY");
    } catch (e) {
        return String(v);
    }
};

/* v0.0.25 — position a fixed-position dropdown panel relative to its trigger.
   Required because Frappe's Desk layout uses transformed ancestors that
   break position:absolute on the dropdown (the v0.0.24 bug — dropdowns
   rendered at the bottom of the viewport instead of below the chip).

   The panel is rendered with `position: fixed`, so its top/left are
   viewport coordinates. We anchor under the trigger, flip up if there's
   not enough room below, and clamp to viewport edges. Width matches the
   trigger but with a minimum.

   RESTRICT: do NOT use position:absolute on the dropdown. Frappe's
   Desk wraps the page in a transform-positioned container that
   creates a new containing block for absolutes — breaks the layout. */
function positionDropdownToTrigger(triggerEl, dropdownEl) {
    if (!triggerEl || !dropdownEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const vpH = window.innerHeight;
    const vpW = window.innerWidth;
    const dropH = Math.min(420, dropdownEl.scrollHeight || 420);
    const minW  = Math.max(280, rect.width);

    // Default: below the trigger
    let top  = rect.bottom + 4;
    let left = rect.left;

    // Flip up if not enough room below AND there IS room above
    if (top + dropH > vpH - 8 && rect.top > dropH + 8) {
        top = rect.top - dropH - 4;
    }
    // Clamp horizontally to viewport
    if (left + minW > vpW - 8) left = Math.max(8, vpW - minW - 8);
    if (left < 8) left = 8;

    dropdownEl.style.top   = `${top}px`;
    dropdownEl.style.left  = `${left}px`;
    dropdownEl.style.width = `${minW}px`;
}


class ItemShortSurplusPage {
    constructor(wrapper, page) {
        this.wrapper = wrapper;
        this.page = page;
        this.$root         = $(wrapper).find(".iss-root");
        this.$filterToggle = this.$root.find(".iss-filter-toggle");
        this.$fontSize     = this.$root.find(".iss-fontsize");
        this.$filterBar    = this.$root.find(".iss-filter-bar");
        this.$searchBar    = this.$root.find(".iss-searchbar");
        this.$searchIn     = this.$searchBar.find(".iss-searchbar-input");
        this.$searchClr    = this.$searchBar.find(".iss-searchbar-clear");
        this.$searchCnt    = this.$searchBar.find(".iss-searchbar-count");
        // v0.0.37 — sort picker (replaces header-click sorting)
        this.$sortBar      = this.$root.find(".iss-sortbar");
        this.$sortPicker   = this.$sortBar.find(".iss-sortpicker");
        this.$sortDrop     = this.$sortBar.find(".iss-sortpicker-dropdown");
        this.$sortSearch   = this.$sortBar.find(".iss-sortpicker-search");
        this.$sortOpts     = this.$sortBar.find(".iss-sortpicker-opts");
        this.$sortValue    = this.$sortBar.find(".iss-sortpicker-value");
        this.$sortDir      = this.$sortBar.find(".iss-sortdir");
        this.$sortDirLabel = this.$sortBar.find(".iss-sortdir-label");
        this.$sortDirIcon  = this.$sortBar.find(".iss-sortdir-icon");
        this.$sortClear    = this.$sortBar.find(".iss-sortclear");
        this._sortField    = null;     // currently sorted column field
        this._sortDir      = "desc";   // "asc" | "desc"
        this._sortTitleMap = {};       // field -> title
        this.$gridHost     = this.$root.find(".iss-grid-host");
        this.$footer       = this.$root.find(".iss-footer");
        // v0.0.35 — universal search state (client-side, persists for session)
        this._searchTerm = "";
        this._searchDebounce = null;

        // v0.0.26 — Status + Workflow State merged into a single
        // combined pair filter per voucher type. State keys: so_pairs,
        // wo_pairs, po_pairs (each = array of "status|workflow_state"
        // keys; backend splits on `|`). Legacy split keys removed.
        this.state = {
            item: [],
            item_group: [],
            warehouses: [],
            company: "",
            so_pairs: [],
            wo_pairs: [],
            po_pairs: [],
            active_so: 0, active_wo: 0, active_po: 0, active_wo_consume: 0,
            no_so: 0,     no_wo: 0,     no_po: 0,     no_wo_consume: 0,
            so_no_wo: 0,  wo_with_shortage: 0, so_with_shortage: 0,
            // Status-only views — by mode
            shortage_only: 0,    surplus_only: 0,    // projected
            shortage_only_cs: 0, surplus_only_cs: 0, // current stock
            // Composite views — key off the Current-Stock status
            po_with_shortage_cs: 0,
            so_with_shortage_cs: 0,
        };
        this.options = null;
        this.table = null;
        this.lastRows = [];
        this.lastColumns = [];

        this._waitForTabulator().then(() => this._boot());
    }

    _waitForTabulator() {
        return new Promise((resolve) => {
            if (window.Tabulator) return resolve();
            const t0 = Date.now();
            const tick = () => {
                if (window.Tabulator) return resolve();
                if (Date.now() - t0 > 8000) {
                    frappe.show_alert({
                        message: __("Tabulator failed to load from CDN — table cannot render."),
                        indicator: "red",
                    });
                    return resolve();
                }
                setTimeout(tick, 80);
            };
            tick();
        });
    }

    async _boot() {
        try {
            const r = await frappe.call({
                method: "chaizup_toc.api.item_short_surplus_api.get_filter_options",
            });
            this.options = r.message || { options: {}, defaults: {}, always_excluded: {} };
            // v0.0.30 — Three-tier state seeding precedence:
            //   1. localStorage (user's previous session picks) — wins if present
            //   2. server defaults from TOC Settings — first-visit fallback
            //   3. empty arrays — only when both above are absent
            //
            // The TOC Settings defaults flow from this.options.defaults.{so,wo,po}_pairs
            // (server already filtered to keys that match current valid_options).
            // Operator can ALWAYS override per session via the chip widgets —
            // any change writes to localStorage so the override persists across
            // page loads on the same browser.
            this._seedFromServerDefaults();
            this._loadStateFromLocalStorage();
            this._renderFilterBar();
            this._bindSearchBar();
            this._bindSortPicker();
            this._bindFilterToggle();
            this._bindFontSize();
            this._refresh();
        } catch (err) {
            console.error("ISS boot failed:", err);
            this.$filterBar.text(__("Failed to load filter options. Check console."));
        }
    }

    /* v0.0.30 — Seed pair fields from TOC Settings on first visit.
       Only fills KEYS that are currently empty in state — never overrides
       localStorage. Called BEFORE _loadStateFromLocalStorage so any saved
       picks win the merge. */
    _seedFromServerDefaults() {
        const d = (this.options && this.options.defaults) || {};
        // Array-valued defaults — seed only when current state is empty
        // so localStorage / explicit user clears continue to win.
        ["so_pairs", "wo_pairs", "po_pairs", "warehouses"].forEach(k => {
            const seed = Array.isArray(d[k]) ? d[k] : [];
            if (seed.length && (!this.state[k] || !this.state[k].length)) {
                this.state[k] = seed.slice();
            }
        });
        // Scalar default — only seed when state is currently empty/blank.
        if (d.company && !this.state.company) {
            this.state.company = d.company;
        }
    }

    /* v0.0.24 — per-user filter persistence in localStorage. Key namespaced
       by user so multiple users sharing a browser don't see each other's
       picks. Doesn't sync across browsers (intentional — different
       devices, different operator contexts).

       v0.0.30 — Stores a "seeded" flag so we can distinguish "user has
       explicitly cleared all picks" (don't re-seed) from "first visit"
       (do seed). Without this flag, _seedFromServerDefaults would keep
       repopulating empty arrays after the user deliberately clears them. */
    _lsKey() {
        return `chaizup_toc.iss.filters.${frappe.session.user || "guest"}`;
    }
    _loadStateFromLocalStorage() {
        try {
            const raw = localStorage.getItem(this._lsKey());
            if (!raw) return;
            const saved = JSON.parse(raw);
            if (saved && typeof saved === "object") {
                // localStorage WINS over server defaults — user's
                // explicit picks beat any TOC Settings seed.
                Object.assign(this.state, saved);
            }
        } catch (e) { /* corrupted localStorage — ignore */ }
    }
    _saveStateToLocalStorage() {
        try {
            localStorage.setItem(this._lsKey(), JSON.stringify(this.state));
        } catch (e) { /* quota exceeded / private mode — ignore */ }
    }

    // ── FILTER BAR ──────────────────────────────────────────────────────────
    _renderFilterBar() {
        this.$filterBar.empty();

        // Row 1 — Item / Item Group / Warehouse / Company
        const $r1 = $(`<div class="iss-filter-row"></div>`);
        // v0.0.30 — Item picker renders options as `<code> : <name>` for
        // operator-friendly identification. Chip + filter VALUE stays the
        // item code (so the SQL filter is unchanged); only the display
        // label is enriched.
        // v0.0.36 — Item + Company widened (operators frequently pick long
        // codes / multi-word company names; the default 200-320 px wrapped
        // the names mid-string and made chips overflow.)
        $r1.append(this._mkLinkMulti("item",       __("Item"),       "Item", { title_field: "item_name", size: "xwide" }));
        $r1.append(this._mkLinkMulti("item_group", __("Item Group"), "Item Group"));
        $r1.append(this._mkLinkMulti("warehouses", __("Warehouses"), "Warehouse"));
        $r1.append(this._mkSingleLink("company",   __("Company"),    "Company", { size: "wide" }));
        this.$filterBar.append($r1);

        // Row 2 — v0.0.26 — SINGLE combined "Status : Workflow" chip per
        // voucher type. Replaces v0.0.25's 6-chip Status + Workflow split.
        // Each option label is "<status> : <workflow_state>" so operators
        // pick the exact real pair (e.g. "Draft : WO Approved") in one
        // shot instead of manually cross-producting two arrays.
        const $r2 = $(`<div class="iss-filter-row"></div>`);
        $r2.append(this._mkPairMulti("so_pairs", __("SO Pending (Status : Workflow)"), this.options.options.so_pairs || []));
        $r2.append(this._mkPairMulti("wo_pairs", __("WO Pending (Status : Workflow)"), this.options.options.wo_pairs || []));
        $r2.append(this._mkPairMulti("po_pairs", __("PO Pending (Status : Workflow)"), this.options.options.po_pairs || []));
        this.$filterBar.append($r2);

        // Row 3 — Quick filter pills (boolean toggles)
        const _quickFiltersTip = __("One-click toggles that further narrow the items shown. Hover any chip for its exact rule. Active / No pairs are mutually exclusive within their SO / WO / PO group.");
        const $r3 = $(`<div class="iss-quickfilter-row">
            <span class="iss-quickfilter-label" title="${_esc(_quickFiltersTip)}">${__("Quick Filters:")}
                <i class="fa fa-info-circle iss-info-icon" aria-hidden="true"></i>
            </span>
        </div>`);
        const quickFilters = [
            // v0.0.35 — every chip carries a `tip` rendered as a tooltip.
            //   Layman ERPNext language so a planner/sales user instantly
            //   understands which rows the chip keeps.
            { key: "active_so",         label: __("Active SO"),         color: "indigo",
              tip: __("Keep ONLY items that still have qty pending on an open Sales Order (Sales Order Item: qty − delivered_qty > 0).") },
            { key: "active_wo",         label: __("Active WO"),         color: "cyan",
              tip: __("Keep ONLY items that still have qty pending on an open Work Order (Work Order: qty − produced_qty > 0).") },
            { key: "active_po",         label: __("Active PO"),         color: "emerald",
              tip: __("Keep ONLY items that still have qty pending on an open Purchase Order (Purchase Order Item: qty − received_qty > 0).") },
            { key: "active_wo_consume", label: __("Active WO Consume"), color: "amber",
              tip: __("Keep ONLY items that are required as a component by an open Work Order (Work Order Item: required_qty − transferred_qty > 0).") },
            { key: "no_so",             label: __("No SO"),             color: "gray",
              tip: __("Keep ONLY items with NO open Sales Order pending qty.") },
            { key: "no_wo",             label: __("No WO"),             color: "gray",
              tip: __("Keep ONLY items with NO open Work Order pending qty.") },
            { key: "no_po",             label: __("No PO"),             color: "gray",
              tip: __("Keep ONLY items with NO open Purchase Order pending qty.") },
            { key: "no_wo_consume",     label: __("No WO Consume"),     color: "gray",
              tip: __("Keep ONLY items NOT required as a component by any open Work Order.") },
            // Composite "view" chips
            { key: "so_no_wo",          label: __("Open SO but No WO"),        color: "rose",
              tip: __("Sales demand exists (pending SO > 0) but NO production planned (pending WO = 0). Useful to spot items where sales have committed orders but the factory isn't building them yet.") },
            { key: "wo_with_shortage",  label: __("Open WO + Shortage (Projected)"), color: "orange",
              tip: __("Production is already underway (pending WO > 0) but the PROJECTED view still shows a Shortage — supply (Stock + Pending WO + Pending PO) is below Demand. Treat as a planning gap.") },
            { key: "so_with_shortage",  label: __("Open SO + Shortage (Projected)"), color: "orange",
              tip: __("Sales demand is committed (pending SO > 0) AND the PROJECTED view still shows a Shortage — even after all pending WO production and PO receipts, supply will fall short. Highest risk to sales fulfilment.") },
            { key: "shortage_only",     label: __("Shortage as per Projection"),    color: "red",
              tip: __("Keep ONLY items whose PROJECTED status is Shortage. Projected supply = Current Stock + Pending WO + Pending PO. Shortage when projected supply < Total Demand.") },
            { key: "surplus_only",      label: __("Surplus as per Projection"),     color: "green",
              tip: __("Keep ONLY items whose PROJECTED status is Surplus. Projected supply = Current Stock + Pending WO + Pending PO. Surplus when projected supply ≥ Total Demand.") },
            { key: "shortage_only_cs",  label: __("Shortage as per Current Stock"), color: "red",
              tip: __("Keep ONLY items short RIGHT NOW based on physical stock alone (pending WO / PO ignored). Shortage when Current Stock < Total Demand.") },
            { key: "surplus_only_cs",   label: __("Surplus as per Current Stock"),  color: "green",
              tip: __("Keep ONLY items with on-hand surplus RIGHT NOW based on physical stock alone (pending WO / PO ignored). Surplus when Current Stock ≥ Total Demand.") },
            // Composite chips that key off the Current-Stock status
            { key: "po_with_shortage_cs", label: __("Open PO + Shortage as per Current Stock"), color: "orange",
              tip: __("Purchase Orders are already placed (pending PO > 0) but RIGHT NOW physical stock is short of Demand. Useful to confirm whether incoming PO will land in time.") },
            { key: "so_with_shortage_cs", label: __("Open SO + Shortage as per Current Stock"), color: "rose",
              tip: __("Sales Order is open (pending SO > 0) AND right now physical stock can't fulfil Demand. Highest-urgency rows for warehouse/planning intervention.") },
        ];
        // v0.0.36 PERF — chip click no longer rebuilds the entire filter
        // bar. It just toggles the active class on this chip + the
        // mutually-exclusive opposite (if any), then triggers _refresh.
        // Rebuilding the bar discards focus, re-renders 4 multi-selects
        // and 3 pair widgets — wasteful on every click.
        quickFilters.forEach(qf => {
            const active = this.state[qf.key] ? " iss-qfchip--active" : "";
            const tipAttr = qf.tip ? ` title="${_esc(qf.tip)}" aria-label="${_esc(qf.tip)}"` : "";
            const $chip = $(`<button class="iss-qfchip iss-qfchip--${qf.color}${active}" data-qf="${_esc(qf.key)}"${tipAttr}>${_esc(qf.label)}</button>`);
            $chip.on("click", () => {
                this.state[qf.key] = this.state[qf.key] ? 0 : 1;
                $chip.toggleClass("iss-qfchip--active", !!this.state[qf.key]);
                // Auto-clear the mutually-exclusive opposite (active_X vs no_X).
                if (this.state[qf.key] && (qf.key.startsWith("active_") || qf.key.startsWith("no_"))) {
                    const opp = qf.key.startsWith("active_") ? qf.key.replace("active_", "no_")
                                                              : qf.key.replace("no_", "active_");
                    if (opp in this.state && this.state[opp]) {
                        this.state[opp] = 0;
                        $r3.find(`.iss-qfchip[data-qf="${opp}"]`).removeClass("iss-qfchip--active");
                    }
                }
                this._refresh();
            });
            $r3.append($chip);
        });
        this.$filterBar.append($r3);

        // Row 4 — Action buttons
        const $r4 = $(`<div class="iss-action-row">
            <button class="btn btn-default btn-sm iss-btn-refresh">
                <i class="fa fa-refresh"></i> ${__("Refresh")}
            </button>
            <button class="btn btn-default btn-sm iss-btn-reset">
                <i class="fa fa-undo"></i> ${__("Reset Filters")}
            </button>
            <button class="btn btn-primary btn-sm iss-btn-export">
                <i class="fa fa-file-excel-o"></i> ${__("Export XLSX")}
            </button>
        </div>`);
        $r4.find(".iss-btn-refresh").on("click", () => this._refresh());
        $r4.find(".iss-btn-reset").on("click",   () => this._reset());
        $r4.find(".iss-btn-export").on("click",  () => this._export());
        this.$filterBar.append($r4);
    }

    /* v0.0.24 — Professional multi-select widget.
       Features:
         - Sticky search input at top of dropdown
         - "Select all (filtered)" + "Clear" actions
         - "X of Y selected" live counter footer
         - Keyboard nav: Esc closes, Enter on input selects first match
         - Chips collapse to "N selected" when > 3 are picked (avoids
           overflow chaos)
         - Always-excluded options shown as disabled with explanation
         - Selection clicks ALWAYS read this.state[key] fresh — no captured
           Sets (the v0.0.22 selection-drift bug)
    */
    _mkMulti(key, label, options, opts = {}) {
        const $g    = $(`<div class="iss-filter-group"></div>`);
        const $lab  = $(`<label class="iss-filter-label">${_esc(label)}</label>`);
        const $ms   = $(`<div class="iss-multiselect" tabindex="0"></div>`);
        const $drop = $(`<div class="iss-multiselect-dropdown"></div>`);
        const $head = $(`
            <div class="iss-multiselect-head">
                <div class="iss-multiselect-search-wrap">
                    <i class="fa fa-search iss-multiselect-search-icon"></i>
                    <input type="search" class="iss-multiselect-search"
                           placeholder="${_esc(__("Search options…"))}">
                </div>
                <div class="iss-multiselect-actions">
                    <button class="iss-msa iss-msa-all">${__("Select all")}</button>
                    <button class="iss-msa iss-msa-clear">${__("Clear")}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="iss-multiselect-opts"></div>`);
        const $foot = $(`<div class="iss-multiselect-foot"></div>`);
        $drop.append($head).append($opts).append($foot);
        $g.append($lab).append($ms).append($drop);
        const $search = $head.find(".iss-multiselect-search");

        // ── chip strip (with "+N more" collapse beyond 3 picks)
        const renderChips = () => {
            $ms.empty();
            const arr = this.state[key] || [];
            if (!arr.length) {
                $ms.append(`<span class="iss-multiselect-placeholder">${__("Select…")}</span>`);
                $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
                return;
            }
            const visible = arr.slice(0, 3);
            visible.forEach(v => {
                const $c = $(`<span class="iss-chip">${_esc(v)}<span class="iss-chip-x" title="${_esc(__("Remove"))}">&times;</span></span>`);
                $c.find(".iss-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    this.state[key] = (this.state[key] || []).filter(z => z !== v);
                    renderChips();
                    renderFoot();
                    this._refresh();
                });
                $ms.append($c);
            });
            if (arr.length > 3) {
                $ms.append(`<span class="iss-chip iss-chip-more" title="${_esc(arr.slice(3).join(", "))}">+${arr.length - 3} ${__("more")}</span>`);
            }
            $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
        };

        const renderFoot = () => {
            const sel = (this.state[key] || []).length;
            const tot = options.length;
            $foot.text(__("{0} of {1} selected", [sel, tot]));
        };

        // ── option list (with disabled + filtered states)
        let currentList = options.slice();
        const renderOpts = (filter = "") => {
            $opts.empty();
            const blocked = new Set(opts.blocked || []);
            currentList = options.slice();
            if (filter) {
                const f = filter.toLowerCase();
                currentList = currentList.filter(x => String(x).toLowerCase().includes(f));
            }
            if (!currentList.length) {
                $opts.append(`<div class="iss-multiselect-empty">
                    <i class="fa fa-search-minus"></i> ${__("No matches")}
                </div>`);
                return;
            }
            currentList.forEach(v => {
                const isBlocked = blocked.has(v);
                const isSel = (this.state[key] || []).includes(v);
                const $o = $(`
                    <label class="iss-multiselect-option ${isSel ? "selected" : ""} ${isBlocked ? "disabled" : ""}">
                        <input type="checkbox" ${isSel ? "checked" : ""} ${isBlocked ? "disabled" : ""}>
                        <span class="iss-multiselect-option-text">${_esc(v)}</span>
                        ${isBlocked ? `<span class="iss-multiselect-tag" title="${_esc(__("Always excluded for data integrity"))}">${__("excluded")}</span>` : ""}
                    </label>`);
                $o.on("click", (e) => {
                    if (isBlocked) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const current = this.state[key] || [];
                    if (current.includes(v)) {
                        this.state[key] = current.filter(z => z !== v);
                    } else {
                        this.state[key] = [...current, v];
                    }
                    renderChips();
                    renderFoot();
                    const nowSel = (this.state[key] || []).includes(v);
                    $o.toggleClass("selected", nowSel)
                      .find("input").prop("checked", nowSel);
                    this._refresh();
                });
                $opts.append($o);
            });
        };

        // ── Select all (filtered) / Clear
        $head.find(".iss-msa-all").on("click", (e) => {
            e.stopPropagation();
            const blocked = new Set(opts.blocked || []);
            const merge = currentList.filter(v => !blocked.has(v));
            const set = new Set([...(this.state[key] || []), ...merge]);
            this.state[key] = Array.from(set);
            renderChips();
            renderFoot();
            renderOpts($search.val());
            this._refresh();
        });
        $head.find(".iss-msa-clear").on("click", (e) => {
            e.stopPropagation();
            this.state[key] = [];
            renderChips();
            renderFoot();
            renderOpts($search.val());
            this._refresh();
        });

        // ── Open / close — fixed-position panel anchored to trigger
        const reposition = () => positionDropdownToTrigger($ms[0], $drop[0]);
        const closeDrop = () => {
            $drop.removeClass("open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };
        $ms.on("click", (e) => {
            if ($(e.target).hasClass("iss-chip-x")) return;
            // Close any other open dropdown
            $(".iss-multiselect-dropdown.open").not($drop).removeClass("open");
            const wasOpen = $drop.hasClass("open");
            if (wasOpen) { closeDrop(); return; }
            $search.val("");
            renderOpts();
            renderFoot();
            // Append to body to escape any transformed ancestor
            if ($drop[0].parentNode !== document.body) {
                document.body.appendChild($drop[0]);
            }
            $drop.addClass("open");
            // Position after the dropdown is visible so scrollHeight is correct
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });
        $search.on("input", (e) => renderOpts(e.target.value));
        $search.on("keydown", (e) => {
            if (e.key === "Escape") closeDrop();
        });
        $(document).on("click.iss-ms-" + key, (e) => {
            if ($drop[0].contains(e.target)) return;
            if (!$g[0].contains(e.target)) closeDrop();
        });

        renderChips();
        return $g[0];
    }

    /* v0.0.26 — Combined Status + Workflow State multi-select widget.
       Options are {key, label, status, workflow_state} objects from the
       backend (one per real (status, workflow_state) pair that exists in
       the data). State stores `key` strings; chip label uses `label`
       (e.g. "Draft : WO Approved").

       Architectural note: this is THE chip the user interacts with.
       Splitting back into two filters for SQL is the backend's job, not
       the JS's. The widget is opinion-free about what the pair means —
       it just lets the user multi-pick from the existing pairs. */
    _mkPairMulti(key, label, options) {
        // options = [{key, label, status, workflow_state}, ...]
        const $g    = $(`<div class="iss-filter-group"></div>`);
        const $lab  = $(`<label class="iss-filter-label">${_esc(label)}</label>`);
        const $ms   = $(`<div class="iss-multiselect" tabindex="0"></div>`);
        const $drop = $(`<div class="iss-multiselect-dropdown"></div>`);
        const $head = $(`
            <div class="iss-multiselect-head">
                <div class="iss-multiselect-search-wrap">
                    <i class="fa fa-search iss-multiselect-search-icon"></i>
                    <input type="search" class="iss-multiselect-search"
                           placeholder="${_esc(__("Search status or workflow…"))}">
                </div>
                <div class="iss-multiselect-actions">
                    <button class="iss-msa iss-msa-all">${__("Select all")}</button>
                    <button class="iss-msa iss-msa-clear">${__("Clear")}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="iss-multiselect-opts"></div>`);
        const $foot = $(`<div class="iss-multiselect-foot"></div>`);
        $drop.append($head).append($opts).append($foot);
        $g.append($lab).append($ms).append($drop);
        const $search = $head.find(".iss-multiselect-search");

        // Build a key -> option lookup so chips can show the human label
        // for keys saved in state (e.g., from localStorage).
        const byKey = {};
        options.forEach(o => { byKey[o.key] = o; });

        const renderChips = () => {
            $ms.empty();
            const arr = this.state[key] || [];
            if (!arr.length) {
                $ms.append(`<span class="iss-multiselect-placeholder">${__("Pick pending pairs…")}</span>`);
                $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
                return;
            }
            const visible = arr.slice(0, 2);
            visible.forEach(k => {
                const opt = byKey[k] || { label: k };
                const $c = $(`<span class="iss-chip iss-chip-pair" title="${_esc(opt.label)}">${_esc(opt.label)}<span class="iss-chip-x" title="${_esc(__("Remove"))}">&times;</span></span>`);
                $c.find(".iss-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    this.state[key] = (this.state[key] || []).filter(z => z !== k);
                    renderChips();
                    renderFoot();
                    this._refresh();
                });
                $ms.append($c);
            });
            if (arr.length > 2) {
                const moreLabels = arr.slice(2).map(k => (byKey[k] && byKey[k].label) || k).join(", ");
                $ms.append(`<span class="iss-chip iss-chip-more" title="${_esc(moreLabels)}">+${arr.length - 2} ${__("more")}</span>`);
            }
            $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
        };

        const renderFoot = () => {
            const sel = (this.state[key] || []).length;
            const tot = options.length;
            $foot.text(__("{0} of {1} selected", [sel, tot]));
        };

        let currentList = options.slice();
        const renderOpts = (filter = "") => {
            $opts.empty();
            currentList = options.slice();
            if (filter) {
                const f = filter.toLowerCase();
                currentList = currentList.filter(o =>
                    String(o.label).toLowerCase().includes(f) ||
                    String(o.status).toLowerCase().includes(f) ||
                    String(o.workflow_state).toLowerCase().includes(f));
            }
            if (!currentList.length) {
                $opts.append(`<div class="iss-multiselect-empty">
                    <i class="fa fa-search-minus"></i> ${__("No matching pairs")}
                </div>`);
                return;
            }
            currentList.forEach(opt => {
                const isSel = (this.state[key] || []).includes(opt.key);
                // Render with two visual chips inside the row: a status pill
                // and a workflow pill, separated by a colon. Makes the pair
                // structure obvious at a glance.
                const stHtml = opt.status
                    ? `<span class="iss-pair-pill iss-pair-pill--status">${_esc(opt.status)}</span>`
                    : `<span class="iss-pair-empty">—</span>`;
                const wfHtml = opt.workflow_state
                    ? `<span class="iss-pair-pill iss-pair-pill--workflow">${_esc(opt.workflow_state)}</span>`
                    : `<span class="iss-pair-empty">—</span>`;
                const $o = $(`
                    <label class="iss-multiselect-option iss-multiselect-option--pair ${isSel ? "selected" : ""}">
                        <input type="checkbox" ${isSel ? "checked" : ""}>
                        <span class="iss-pair-cell">
                            ${stHtml}
                            <span class="iss-pair-sep">:</span>
                            ${wfHtml}
                        </span>
                    </label>`);
                // 2026-06-05 FIX — drive selection off the checkbox `change`
                // event, not a label `click`. A click on a <label> that wraps a
                // checkbox double-fires (label click + synthetic input click),
                // which made the tick not settle until the dropdown was reopened.
                // `change` fires exactly once and the native tick is instant, so
                // the box checks the moment you click. The label click handler
                // only stops the dropdown from closing.
                $o.find("input").on("change", (e) => {
                    e.stopPropagation();
                    const checked = e.target.checked;
                    const current = this.state[key] || [];
                    if (checked && !current.includes(opt.key)) {
                        this.state[key] = [...current, opt.key];
                    } else if (!checked) {
                        this.state[key] = current.filter(z => z !== opt.key);
                    }
                    $o.toggleClass("selected", checked);
                    renderChips();
                    renderFoot();
                    this._refresh();
                });
                $o.on("click", (e) => { e.stopPropagation(); });
                $opts.append($o);
            });
        };

        // Select-all-filtered / Clear actions
        $head.find(".iss-msa-all").on("click", (e) => {
            e.stopPropagation();
            const merge = currentList.map(o => o.key);
            const set = new Set([...(this.state[key] || []), ...merge]);
            this.state[key] = Array.from(set);
            renderChips();
            renderFoot();
            renderOpts($search.val());
            this._refresh();
        });
        $head.find(".iss-msa-clear").on("click", (e) => {
            e.stopPropagation();
            this.state[key] = [];
            renderChips();
            renderFoot();
            renderOpts($search.val());
            this._refresh();
        });

        // Open / close — same fixed-position handling as _mkMulti
        const reposition = () => positionDropdownToTrigger($ms[0], $drop[0]);
        const closeDrop = () => {
            $drop.removeClass("open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };
        $ms.on("click", (e) => {
            if ($(e.target).hasClass("iss-chip-x")) return;
            $(".iss-multiselect-dropdown.open").not($drop).removeClass("open");
            const wasOpen = $drop.hasClass("open");
            if (wasOpen) { closeDrop(); return; }
            $search.val("");
            renderOpts();
            renderFoot();
            if ($drop[0].parentNode !== document.body) {
                document.body.appendChild($drop[0]);
            }
            $drop.addClass("open");
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });
        $search.on("input", (e) => renderOpts(e.target.value));
        $search.on("keydown", (e) => {
            if (e.key === "Escape") closeDrop();
        });
        $(document).on("click.iss-pair-" + key, (e) => {
            if ($drop[0].contains(e.target)) return;
            if (!$g[0].contains(e.target)) closeDrop();
        });

        renderChips();
        return $g[0];
    }

    /* Professional Link-backed multi-select widget. Fetches options live
       from frappe.db.get_list as the user types. Mirrors _mkMulti's
       chrome (sticky search, Clear action, "N selected" footer, chip
       collapse beyond 3). Native setTimeout debouncer — no lodash. */
    _mkLinkMulti(key, label, doctype, opts = {}) {
        // v0.0.30 — opts.title_field (e.g., "item_name") enriches option
        // and chip labels with `<name> : <title>` for operator-friendly
        // display. STORAGE stays the doctype's `name` (so SQL filters
        // are unaffected). Title-by-name cache lets chips render the
        // combined label even when loaded from localStorage (where we
        // only persisted the code).
        const titleField = opts.title_field || null;
        // Lookup cache: name -> title. Populated by fetchAndRender and
        // by an initial primer call for any state already in localStorage.
        if (!this._linkTitleCache) this._linkTitleCache = {};
        if (!this._linkTitleCache[doctype]) this._linkTitleCache[doctype] = {};
        const titleCache = this._linkTitleCache[doctype];
        const fmtLabel = (name) => {
            if (!titleField) return name;
            const t = titleCache[name];
            return t ? `${name} : ${t}` : name;
        };

        // v0.0.36 — opts.size = "wide" | "xwide" widens the wrapper card.
        const sizeCls = opts.size === "xwide" ? " iss-filter-group--xwide"
                      : opts.size === "wide"  ? " iss-filter-group--wide"  : "";
        const $g    = $(`<div class="iss-filter-group${sizeCls}"></div>`);
        const $lab  = $(`<label class="iss-filter-label">${_esc(label)}</label>`);
        const $ms   = $(`<div class="iss-multiselect" tabindex="0"></div>`);
        const $drop = $(`<div class="iss-multiselect-dropdown"></div>`);
        const $head = $(`
            <div class="iss-multiselect-head">
                <div class="iss-multiselect-search-wrap">
                    <i class="fa fa-search iss-multiselect-search-icon"></i>
                    <input type="search" class="iss-multiselect-search"
                           placeholder="${_esc(__("Search {0}…", [doctype]))}">
                </div>
                <div class="iss-multiselect-actions">
                    <button class="iss-msa iss-msa-clear">${__("Clear")}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="iss-multiselect-opts"></div>`);
        const $foot = $(`<div class="iss-multiselect-foot"></div>`);
        $drop.append($head).append($opts).append($foot);
        $g.append($lab).append($ms).append($drop);
        const $search = $head.find(".iss-multiselect-search");

        const renderChips = () => {
            $ms.empty();
            const arr = this.state[key] || [];
            if (!arr.length) {
                $ms.append(`<span class="iss-multiselect-placeholder">${__("Select…")}</span>`);
                $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
                return;
            }
            const visible = arr.slice(0, 3);
            visible.forEach(v => {
                const $c = $(`<span class="iss-chip" title="${_esc(fmtLabel(v))}">${_esc(fmtLabel(v))}<span class="iss-chip-x" title="${_esc(__("Remove"))}">&times;</span></span>`);
                $c.find(".iss-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    this.state[key] = (this.state[key] || []).filter(z => z !== v);
                    renderChips();
                    renderFoot();
                    this._refresh();
                });
                $ms.append($c);
            });
            if (arr.length > 3) {
                const moreLabels = arr.slice(3).map(fmtLabel).join(", ");
                $ms.append(`<span class="iss-chip iss-chip-more" title="${_esc(moreLabels)}">+${arr.length - 3} ${__("more")}</span>`);
            }
            $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
        };

        const renderFoot = () => {
            const sel = (this.state[key] || []).length;
            $foot.text(sel ? __("{0} selected", [sel]) : __("Type to search"));
        };

        // v0.0.30 — Prime the title cache for any items already in state
        // (loaded from localStorage on first paint). One fetch, no UI hit.
        const primeTitlesForState = () => {
            if (!titleField) return;
            const need = (this.state[key] || []).filter(n => !(n in titleCache));
            if (!need.length) return;
            frappe.db.get_list(doctype, {
                filters: [["name", "in", need]],
                fields: ["name", titleField],
                limit: need.length || 50,
            }).then(rows => {
                (rows || []).forEach(r => { titleCache[r.name] = r[titleField] || ""; });
                renderChips();
            }).catch(() => { /* non-fatal — chip falls back to plain code */ });
        };

        // 2026-06-05 — Build ONE option row. Selection is driven by the
        // checkbox `change` event (instant native tick + no <label> double-fire),
        // and an unchecked row removes the item from state. This is what makes
        // EVERY selected item removable from the dropdown — even ones hidden
        // behind the "+N more" chip — so the operator is never stuck with an
        // item they can't take off.
        const renderRow = (name, title) => {
            if (titleField && title != null) {
                titleCache[name] = title || titleCache[name] || "";
            }
            const isSel = (this.state[key] || []).includes(name);
            const t = titleField ? (title != null ? title : titleCache[name]) : null;
            const display = (titleField && t)
                ? `<span class="iss-link-code">${_esc(name)}</span><span class="iss-link-sep">:</span><span class="iss-link-title">${_esc(t)}</span>`
                : _esc(name);
            const $o = $(`
                <label class="iss-multiselect-option ${isSel ? "selected" : ""}">
                    <input type="checkbox" ${isSel ? "checked" : ""}>
                    <span class="iss-multiselect-option-text">${display}</span>
                </label>`);
            $o.find("input").on("change", (e) => {
                e.stopPropagation();
                const checked = e.target.checked;
                const current = this.state[key] || [];
                if (checked && !current.includes(name)) {
                    this.state[key] = [...current, name];
                } else if (!checked) {
                    this.state[key] = current.filter(z => z !== name);
                }
                $o.toggleClass("selected", checked);
                renderChips();
                renderFoot();
                this._refresh();
            });
            $o.on("click", (e) => { e.stopPropagation(); });
            return $o;
        };

        const fetchAndRender = (term = "") => {
            $opts.html(`<div class="iss-multiselect-empty">
                <i class="fa fa-spinner fa-spin"></i> ${__("Searching {0}…", [doctype])}
            </div>`);
            const fields = titleField ? ["name", titleField] : ["name"];
            frappe.db.get_list(doctype, {
                filters: term ? [["name", "like", `%${term}%`]] : {},
                fields,
                limit: 50,
                order_by: "name asc",
            }).then(rows => {
                $opts.empty();
                const termL = (term || "").toLowerCase();
                const selAll = this.state[key] || [];
                // Selected items go FIRST (filtered by the search term, or all
                // of them when the search box is empty) so the operator always
                // sees — and can untick — what is currently chosen.
                const selMatch = selAll.filter(n => !termL || fmtLabel(n).toLowerCase().includes(termL));
                const selSet = new Set(selAll);
                const others = (rows || []).filter(r => !selSet.has(r.name));

                if (!selMatch.length && !others.length) {
                    $opts.append(`<div class="iss-multiselect-empty">
                        <i class="fa fa-search-minus"></i> ${__("No {0} found", [doctype])}
                    </div>`);
                    return;
                }
                if (selMatch.length) {
                    $opts.append(`<div class="iss-ms-section">${__("Selected")} (${selMatch.length})</div>`);
                    selMatch.forEach(n => $opts.append(renderRow(n, titleCache[n])));
                    if (others.length) {
                        $opts.append(`<div class="iss-ms-section">${__("More results")}</div>`);
                    }
                }
                others.forEach(r => $opts.append(renderRow(r.name, titleField ? r[titleField] : null)));
            }).catch(() => {
                $opts.html(`<div class="iss-multiselect-empty iss-error">
                    <i class="fa fa-exclamation-triangle"></i> ${__("Search failed")}
                </div>`);
            });
        };

        let debounceTimer = null;
        const debouncedFetch = (term) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => fetchAndRender(term), 250);
        };

        $head.find(".iss-msa-clear").on("click", (e) => {
            e.stopPropagation();
            this.state[key] = [];
            renderChips();
            renderFoot();
            fetchAndRender($search.val());
            this._refresh();
        });

        const reposition = () => positionDropdownToTrigger($ms[0], $drop[0]);
        const closeDrop = () => {
            $drop.removeClass("open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };
        $ms.on("click", (e) => {
            if ($(e.target).hasClass("iss-chip-x")) return;
            $(".iss-multiselect-dropdown.open").not($drop).removeClass("open");
            const wasOpen = $drop.hasClass("open");
            if (wasOpen) { closeDrop(); return; }
            $search.val("");
            fetchAndRender("");
            renderFoot();
            if ($drop[0].parentNode !== document.body) {
                document.body.appendChild($drop[0]);
            }
            $drop.addClass("open");
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });
        $search.on("input", (e) => debouncedFetch(e.target.value));
        $search.on("keydown", (e) => {
            if (e.key === "Escape") closeDrop();
        });
        $(document).on("click.iss-link-" + key, (e) => {
            if ($drop[0].contains(e.target)) return;
            if (!$g[0].contains(e.target)) closeDrop();
        });

        renderChips();
        // v0.0.30 — Title-field prime for state loaded from localStorage.
        // Runs once after mount so chips display `<code> : <name>` even
        // without the user opening the dropdown.
        primeTitlesForState();
        return $g[0];
    }

    /* v0.0.25 — Single-value Link picker matching the multi-select chrome.
       Same widget shape (trigger + fixed-position dropdown + search +
       option list) but click selects exactly one option then closes.
       Used for Company. */
    _mkSingleLink(key, label, doctype, opts = {}) {
        // v0.0.36 — opts.size = "wide" | "xwide" widens the wrapper.
        const sizeCls = opts.size === "xwide" ? "iss-filter-group--xwide"
                      : opts.size === "wide"  ? "iss-filter-group--wide"
                                              : "iss-filter-group--narrow";
        const $g    = $(`<div class="iss-filter-group ${sizeCls}"></div>`);
        const $lab  = $(`<label class="iss-filter-label">${_esc(label)}</label>`);
        const $ms   = $(`<div class="iss-multiselect" tabindex="0"></div>`);
        const $drop = $(`<div class="iss-multiselect-dropdown"></div>`);
        const $head = $(`
            <div class="iss-multiselect-head">
                <div class="iss-multiselect-search-wrap">
                    <i class="fa fa-search iss-multiselect-search-icon"></i>
                    <input type="search" class="iss-multiselect-search"
                           placeholder="${_esc(__("Search {0}…", [doctype]))}">
                </div>
                <div class="iss-multiselect-actions">
                    <button class="iss-msa iss-msa-clear">${__("Clear")}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="iss-multiselect-opts"></div>`);
        $drop.append($head).append($opts);
        $g.append($lab).append($ms).append($drop);
        const $search = $head.find(".iss-multiselect-search");

        const renderChip = () => {
            $ms.empty();
            const v = this.state[key];
            if (!v) {
                $ms.append(`<span class="iss-multiselect-placeholder">${__("Any")}</span>`);
            } else {
                const $c = $(`<span class="iss-chip">${_esc(v)}<span class="iss-chip-x" title="${_esc(__("Clear"))}">&times;</span></span>`);
                $c.find(".iss-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    this.state[key] = "";
                    renderChip();
                    this._refresh();
                });
                $ms.append($c);
            }
            $ms.append(`<i class="fa fa-caret-down iss-multiselect-caret"></i>`);
        };

        // For Company (typically 1-5), pre-load all options instead of
        // hitting the server on every search.
        const _seed = (doctype === "Company")
            ? (this.options.options.companies || [])
            : null;

        const fetchAndRender = (term = "") => {
            const renderRows = (rows) => {
                $opts.empty();
                if (!rows.length) {
                    $opts.append(`<div class="iss-multiselect-empty">
                        <i class="fa fa-search-minus"></i> ${__("No matches")}
                    </div>`);
                    return;
                }
                rows.forEach(name => {
                    const isSel = this.state[key] === name;
                    const $o = $(`
                        <label class="iss-multiselect-option ${isSel ? "selected" : ""}">
                            <span class="iss-multiselect-option-text">${_esc(name)}</span>
                            ${isSel ? `<i class="fa fa-check" style="color: var(--primary-color, #2563eb);"></i>` : ""}
                        </label>`);
                    $o.on("click", (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.state[key] = isSel ? "" : name;
                        renderChip();
                        closeDrop();
                        this._refresh();
                    });
                    $opts.append($o);
                });
            };

            if (_seed) {
                let list = _seed.slice();
                if (term) {
                    const t = term.toLowerCase();
                    list = list.filter(x => String(x).toLowerCase().includes(t));
                }
                renderRows(list);
                return;
            }
            $opts.html(`<div class="iss-multiselect-empty">
                <i class="fa fa-spinner fa-spin"></i> ${__("Searching {0}…", [doctype])}
            </div>`);
            frappe.db.get_list(doctype, {
                filters: term ? [["name", "like", `%${term}%`]] : {},
                fields: ["name"],
                limit: 50,
                order_by: "name asc",
            }).then(rows => renderRows(rows.map(r => r.name)))
              .catch(() => $opts.html(`<div class="iss-multiselect-empty iss-error">
                <i class="fa fa-exclamation-triangle"></i> ${__("Search failed")}
              </div>`));
        };

        let debounceTimer = null;
        const debouncedFetch = (term) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => fetchAndRender(term), 250);
        };

        const reposition = () => positionDropdownToTrigger($ms[0], $drop[0]);
        const closeDrop = () => {
            $drop.removeClass("open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };

        $head.find(".iss-msa-clear").on("click", (e) => {
            e.stopPropagation();
            this.state[key] = "";
            renderChip();
            fetchAndRender($search.val());
            this._refresh();
        });

        $ms.on("click", (e) => {
            if ($(e.target).hasClass("iss-chip-x")) return;
            $(".iss-multiselect-dropdown.open").not($drop).removeClass("open");
            const wasOpen = $drop.hasClass("open");
            if (wasOpen) { closeDrop(); return; }
            $search.val("");
            fetchAndRender("");
            if ($drop[0].parentNode !== document.body) {
                document.body.appendChild($drop[0]);
            }
            $drop.addClass("open");
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });
        $search.on("input", (e) => debouncedFetch(e.target.value));
        $search.on("keydown", (e) => {
            if (e.key === "Escape") closeDrop();
        });
        $(document).on("click.iss-single-" + key, (e) => {
            if ($drop[0].contains(e.target)) return;
            if (!$g[0].contains(e.target)) closeDrop();
        });

        renderChip();
        return $g[0];
    }

    _reset() {
        // v0.0.30 — Reset goes back to TOC Settings defaults, NOT blank.
        // Operator spec: "user can change on report level as well if needed"
        // → Reset means "give me what TOC Settings says is pending", not
        // "wipe everything". For a true wipe, the chip widget's per-field
        // Clear button still works.
        const d = (this.options && this.options.defaults) || {};
        this.state = {
            item: [], item_group: [],
            // v0.0.35 — Reset restores TOC Settings defaults for Warehouses
            // (Inventory-purpose warehouses) and Company (Global Defaults).
            warehouses: Array.isArray(d.warehouses) ? d.warehouses.slice() : [],
            company:    d.company || "",
            so_pairs: Array.isArray(d.so_pairs) ? d.so_pairs.slice() : [],
            wo_pairs: Array.isArray(d.wo_pairs) ? d.wo_pairs.slice() : [],
            po_pairs: Array.isArray(d.po_pairs) ? d.po_pairs.slice() : [],
            active_so: 0, active_wo: 0, active_po: 0, active_wo_consume: 0,
            no_so: 0,     no_wo: 0,     no_po: 0,     no_wo_consume: 0,
            so_no_wo: 0,  wo_with_shortage: 0, so_with_shortage: 0,
            // Status-only views — by mode
            shortage_only: 0,    surplus_only: 0,    // projected
            shortage_only_cs: 0, surplus_only_cs: 0, // current stock
            // Composite views — key off the Current-Stock status
            po_with_shortage_cs: 0,
            so_with_shortage_cs: 0,
        };
        this._renderFilterBar();
        this._refresh();
    }

    // ── DATA FETCH + RENDER ────────────────────────────────────────────────
    _refresh() {
        this._saveStateToLocalStorage();
        this._showLoading();
        frappe.call({
            method: "chaizup_toc.api.item_short_surplus_api.get_report",
            args: { filters: this.state },
        }).then(r => {
            const d = r.message || { rows: [], columns: [] };
            this.lastRows = d.rows || [];
            this.lastColumns = d.columns || [];
            this._renderTable();
            this.$footer.text(__("{0} items shown · generated {1}", [
                (d.rows || []).length, _fmtTs(d.generated_at)]));
        }).catch(err => {
            console.error("ISS get_report error:", err);
            this.$gridHost.html(`<div class="iss-error">${_esc(err.message || String(err))}</div>`);
        });
    }

    _showLoading() {
        this.$gridHost.html(`<div class="iss-loading"><i class="fa fa-spinner fa-spin"></i> ${__("Loading…")}</div>`);
    }

    // ─────────────────────────────────────────────────────────────────
    // v0.0.35 — Universal search (client-side).
    // CONTEXT: Operator wants a single search box that finds rows by
    //          ANY visible text — item code, name, group, UOMs, status.
    //          Live, instant, no server round-trip. Works on whatever
    //          the server filters down to (so chips still apply first).
    // INSTRUCTIONS: Debounce 120 ms to avoid thrash on rapid typing.
    //          Search across a fixed set of text fields; case-insensitive
    //          substring match. Empty term clears the filter entirely.
    // DANGER: Do NOT swap out `this.lastRows` — that breaks downstream
    //          consumers (footer count, export). Use Tabulator's
    //          setFilter() which only changes what's RENDERED.
    // ─────────────────────────────────────────────────────────────────
    // v0.0.36 — Font-size picker (S / M / L).
    // CONTEXT: Operators on 13" laptops want more columns visible; large
    //          monitor users want easier-on-the-eyes text. Applied via a
    //          CSS scale multiplier on .iss-root, so EVERY descendant
    //          (header, qty cards, modal, filter chips) scales together.
    // INSTRUCTIONS: One <button data-fs="sm|md|lg"> per option. Click
    //          flips the active button + sets a data-fs attribute on
    //          .iss-root. CSS reads that attribute to apply the scale.
    //          Persisted in localStorage per-user.
    _fontSizeLsKey() {
        return `chaizup_toc.iss.fontsize.${frappe.session.user || "guest"}`;
    }
    _bindFontSize() {
        const apply = (fs) => {
            this.$root.attr("data-fs", fs);
            this.$fontSize.find(".iss-fontsize-btn").removeClass("iss-fontsize-btn--active");
            this.$fontSize.find(`.iss-fontsize-btn[data-fs="${fs}"]`).addClass("iss-fontsize-btn--active");
            // Trigger Tabulator redraw so column widths re-fit at the new size
            if (this.table) {
                try { this.table.redraw(true); } catch (e) { /* noop */ }
            }
        };
        // v0.0.37 — Default to "sm" (Small) on first load so more
        // columns fit on small/medium laptops without horizontal
        // scrolling. Operator's explicit pick (localStorage) wins.
        let saved = "sm";
        try {
            const v = localStorage.getItem(this._fontSizeLsKey());
            if (v === "sm" || v === "md" || v === "lg") saved = v;
        } catch (e) { /* ignore */ }
        apply(saved);

        this.$fontSize.on("click", ".iss-fontsize-btn", (ev) => {
            const fs = $(ev.currentTarget).data("fs");
            if (!fs || fs === this.$root.attr("data-fs")) return;
            apply(fs);
            try { localStorage.setItem(this._fontSizeLsKey(), fs); }
            catch (e) { /* ignore */ }
        });
    }

    // v0.0.36 — Filter-bar collapse toggle (Hide/Show Filters).
    // Persisted per-user in localStorage so the operator's preference
    // sticks across page loads.
    _filterToggleLsKey() {
        return `chaizup_toc.iss.filterbar_collapsed.${frappe.session.user || "guest"}`;
    }
    _bindFilterToggle() {
        const apply = (collapsed) => {
            this.$filterBar.toggleClass("iss-filter-bar--collapsed", collapsed);
            // v0.0.36 r2 — flag the root so the grid-host CSS rule
            // switches height (table grows when filters hidden).
            this.$root.toggleClass("iss-filters-collapsed", collapsed);
            this.$filterToggle.attr("aria-expanded", String(!collapsed));
            this.$filterToggle.find(".iss-filter-toggle-icon")
                .toggleClass("fa-chevron-up",   !collapsed)
                .toggleClass("fa-chevron-down", collapsed);
            this.$filterToggle.find(".iss-filter-toggle-label")
                .text(collapsed ? __("Show Filters") : __("Hide Filters"));
            // Force Tabulator to re-measure now that its container resized.
            if (this.table) {
                try { this.table.redraw(true); } catch (e) { /* noop */ }
            }
        };
        // Initial state from localStorage
        let collapsed = false;
        try { collapsed = localStorage.getItem(this._filterToggleLsKey()) === "1"; }
        catch (e) { /* localStorage unavailable */ }
        apply(collapsed);

        this.$filterToggle.off("click.iss").on("click.iss", () => {
            const nowCollapsed = !this.$filterBar.hasClass("iss-filter-bar--collapsed");
            apply(nowCollapsed);
            try { localStorage.setItem(this._filterToggleLsKey(), nowCollapsed ? "1" : "0"); }
            catch (e) { /* ignore */ }
        });
    }

    // ─────────────────────────────────────────────────────────────────
    // v0.0.37 — Sort picker (replaces header-click sorting).
    // CONTEXT: Operator wants a single place to choose which column the
    //          table sorts by + direction, AND to have the chosen
    //          column auto-scroll into view (so they don't have to
    //          manually horizontal-scroll to find it).
    // INSTRUCTIONS: Searchable dropdown to pick the column, ↑/↓ button
    //          to flip direction, × button to clear. On apply:
    //            1. table.setSort(field, dir)
    //            2. table.scrollToColumn(field, "center", true)
    //          Header clicks are disabled via headerSort: false on
    //          every column in _buildMergedColumns (v0.0.37).
    // DANGER: Don't try to "remember" the sort across refreshes — the
    //          column field list can shift if the schema changes. State
    //          lives in memory only; default is initialSort (shortfall).
    // ─────────────────────────────────────────────────────────────────
    _bindSortPicker() {
        const closeDrop = () => {
            this.$sortDrop.removeClass("open");
            this.$sortPicker.attr("aria-expanded", "false");
        };
        const openDrop = () => {
            this._refreshSortOptions();
            this.$sortDrop.addClass("open");
            this.$sortPicker.attr("aria-expanded", "true");
            this.$sortSearch.val("").focus();
            this._filterSortOptions("");
        };
        this.$sortPicker.off("click.iss").on("click.iss", (e) => {
            e.stopPropagation();
            this.$sortDrop.hasClass("open") ? closeDrop() : openDrop();
        });
        this.$sortPicker.off("keydown.iss").on("keydown.iss", (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDrop(); }
            if (e.key === "Escape") closeDrop();
        });
        $(document).off("click.iss-sortpicker").on("click.iss-sortpicker", (e) => {
            if (this.$sortBar[0].contains(e.target)) return;
            closeDrop();
        });
        this.$sortSearch.off("input.iss").on("input.iss", (e) => {
            this._filterSortOptions(String(e.target.value || "").trim().toLowerCase());
        });
        // Direction toggle
        this.$sortDir.off("click.iss").on("click.iss", () => {
            this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
            this._renderSortDirLabel();
            if (this._sortField) this._applySort();
        });
        // Clear
        this.$sortClear.off("click.iss").on("click.iss", () => {
            this._sortField = null;
            this.$sortValue.text(__("—"));
            this.$sortClear.hide();
            if (this.table) {
                try { this.table.clearSort(); } catch (e) { /* noop */ }
            }
        });
        this._renderSortDirLabel();
        this.$sortClear.hide();
    }

    _renderSortDirLabel() {
        const asc = this._sortDir === "asc";
        this.$sortDirLabel.text(asc ? __("Low → High") : __("High → Low"));
        this.$sortDirIcon
            .toggleClass("fa-arrow-up",   asc)
            .toggleClass("fa-arrow-down", !asc);
    }

    _refreshSortOptions() {
        // v0.0.37 r2 — Source options from the LIVE Tabulator columns,
        // not the server metadata. The merged dashboard view pairs
        // (higher, stock) UOM fields into one column; setSort() on a
        // "stock"-suffix field would silently no-op because Tabulator
        // doesn't know it. Pulling from getColumns() guarantees every
        // option corresponds to a real, sortable Tabulator column.
        this.$sortOpts.empty();
        this._sortTitleMap = {};
        if (!this.table) {
            this.$sortOpts.append(`<div class="iss-sortpicker-opt iss-sortpicker-opt--disabled">${__("Loading…")}</div>`);
            return;
        }
        const defs = this.table.getColumns()
            .map(c => c.getDefinition())
            .filter(d => d && d.field && d.title);
        defs.forEach(d => { this._sortTitleMap[d.field] = String(d.title); });
        defs.forEach(d => {
            const isActive = d.field === this._sortField;
            const title    = String(d.title);
            const $opt = $(`<div class="iss-sortpicker-opt${isActive ? " iss-sortpicker-opt--active" : ""}"
                                 data-field="${_esc(d.field)}"
                                 data-title="${_esc(title)}">
                ${_esc(title)}
            </div>`);
            $opt.on("click", () => {
                this._sortField = d.field;
                this.$sortValue.text(title);
                this.$sortClear.show();
                this.$sortDrop.removeClass("open");
                this.$sortPicker.attr("aria-expanded", "false");
                // Mark this option active visually (next open will rebuild,
                // but we want immediate feedback).
                this.$sortOpts.find(".iss-sortpicker-opt").removeClass("iss-sortpicker-opt--active");
                $opt.addClass("iss-sortpicker-opt--active");
                this._applySort();
            });
            this.$sortOpts.append($opt);
        });
    }

    _filterSortOptions(term) {
        if (!term) {
            this.$sortOpts.find(".iss-sortpicker-opt").show();
            return;
        }
        this.$sortOpts.find(".iss-sortpicker-opt").each(function () {
            const t = String($(this).data("title") || "").toLowerCase();
            const f = String($(this).data("field") || "").toLowerCase();
            $(this).toggle(t.includes(term) || f.includes(term));
        });
    }

    _applySort() {
        if (!this.table || !this._sortField) return;
        const field = this._sortField;
        try {
            // v0.0.37 r4 — Suppress the legacy scroll-preservation guard
            // (from v0.0.34, originally for header-click sorting) so it
            // doesn't fight our deliberate horizontal scroll below.
            this._suppressScrollGuard = true;

            // v0.0.37 r2 — Array form of setSort works reliably across
            // every Tabulator 6.x column variant.
            this.table.setSort([{ column: field, dir: this._sortDir }]);

            // v0.0.37 r4 — Custom scroll that accounts for the frozen
            // Item column overlay. Tabulator's scrollToColumn doesn't
            // know the first column is sticky, so a centered scroll
            // can leave the sorted column hidden behind the overlay.
            // Run after Tabulator's own redraw / sort settles.
            setTimeout(() => {
                this._scrollColumnIntoView(field);
                this._flashColumnHeader(field);
                // Clear the suppression flag after a beat so legitimate
                // header-click guarding (if ever re-enabled) still works.
                setTimeout(() => { this._suppressScrollGuard = false; }, 200);
            }, 100);
        } catch (e) {
            console.warn("ISS setSort failed:", e);
            this._suppressScrollGuard = false;
            frappe.show_alert({ message: __("Could not sort by this column."), indicator: "orange" });
        }
    }

    // v0.0.37 r4 — Manual horizontal-scroll that respects frozen columns.
    //
    // CONTEXT: The Item column is `frozen: true`, so Tabulator renders
    //   it with position:sticky and it sits OVER any column scrolled
    //   underneath it. If we use scrollToColumn(field, "center"), a
    //   freshly-sorted column near the start of the table can end up
    //   visually hidden behind the sticky overlay.
    //
    // INSTRUCTIONS: Sum the widths of every frozen column to find the
    //   "safe" left edge of the visible area, then compute the scrollLeft
    //   value that lands the target column in the middle of the
    //   POST-FROZEN visible area. Skip the scroll entirely if the column
    //   itself is frozen (it's always visible by definition).
    _scrollColumnIntoView(field) {
        if (!this.table) return;
        let col;
        try { col = this.table.getColumn(field); } catch (e) { return; }
        if (!col) return;
        const def = col.getDefinition() || {};
        if (def.frozen) return; // frozen cols are permanently visible
        const colEl = col.getElement();
        const holder = this.table.element.querySelector(".tabulator-tableholder");
        if (!colEl || !holder) return;

        // Total width of all frozen columns at the LEFT of the table.
        // (Right-frozen would belong on the other side; we don't use any.)
        const frozenWidth = this.table.getColumns()
            .filter(c => (c.getDefinition() || {}).frozen === true)
            .reduce((acc, c) => {
                const el = c.getElement();
                return acc + (el ? el.offsetWidth : 0);
            }, 0);

        // Column's left edge relative to the holder's scroll origin.
        const holderRect = holder.getBoundingClientRect();
        const colRect    = colEl.getBoundingClientRect();
        const colLeftInScrollSpace = colRect.left - holderRect.left + holder.scrollLeft;
        const colWidth   = colEl.offsetWidth;
        const visibleWidth = holder.clientWidth - frozenWidth;

        // Center the column in the post-frozen visible area. Subtract
        // frozenWidth so the column's center lines up with the centre
        // of the unobscured area, not the centre of the whole holder.
        let targetScrollLeft = colLeftInScrollSpace - frozenWidth
                             - Math.max(0, (visibleWidth - colWidth) / 2);

        // Clamp into the scrollable range.
        const maxScroll = holder.scrollWidth - holder.clientWidth;
        targetScrollLeft = Math.max(0, Math.min(targetScrollLeft, maxScroll));

        holder.scrollLeft = targetScrollLeft;
    }

    // v0.0.37 r3 — Yellow blink on the sorted column's header so the
    // operator can locate which column the table just re-ordered by.
    // Adds a CSS class for one animation cycle, then removes it so
    // re-applying on a quick second sort restarts cleanly.
    _flashColumnHeader(field) {
        if (!this.table) return;
        let col;
        try { col = this.table.getColumn(field); } catch (e) { return; }
        if (!col) return;
        const el = col.getElement();
        if (!el) return;
        // Remove any in-flight animation class so a rapid re-sort
        // gets a fresh visible pulse instead of being mid-cycle.
        el.classList.remove("iss-col-flash");
        // Force reflow so the browser registers the class removal
        // before we re-add it — required for the keyframes to restart.
        // eslint-disable-next-line no-unused-expressions
        void el.offsetWidth;
        el.classList.add("iss-col-flash");
        // Cleanup the class after the animation finishes (1.4 s) so the
        // DOM stays clean and the next flash starts identically.
        setTimeout(() => { el.classList.remove("iss-col-flash"); }, 1500);
    }

    _bindSearchBar() {
        const apply = () => {
            this._searchTerm = (this.$searchIn.val() || "").trim().toLowerCase();
            this.$searchClr.toggle(this._searchTerm.length > 0);
            this._applySearchFilter();
        };
        this.$searchIn.off("input.iss").on("input.iss", () => {
            clearTimeout(this._searchDebounce);
            this._searchDebounce = setTimeout(apply, 120);
        });
        this.$searchClr.off("click.iss").on("click.iss", () => {
            this.$searchIn.val("");
            apply();
            this.$searchIn.focus();
        });
        this.$searchClr.hide();
    }

    _applySearchFilter() {
        if (!this.table) {
            this._updateSearchCount();
            return;
        }
        const term = this._searchTerm;
        if (!term) {
            this.table.clearFilter();
            this._updateSearchCount();
            return;
        }
        // Searchable fields — every text the user sees in the row.
        const FIELDS = [
            "item_code", "item_name", "item_group",
            "stock_uom", "higher_uom", "demand_status",
        ];
        this.table.setFilter((row) => {
            for (const f of FIELDS) {
                const v = row[f];
                if (v != null && String(v).toLowerCase().includes(term)) return true;
            }
            return false;
        });
        this._updateSearchCount();
    }

    _updateSearchCount() {
        if (!this.table) {
            this.$searchCnt.text("");
            return;
        }
        const total = (this.lastRows || []).length;
        const visible = (this.table.getRows("active") || []).length;
        if (this._searchTerm) {
            this.$searchCnt.text(__("{0} of {1}", [visible, total]));
        } else {
            this.$searchCnt.text("");
        }
    }

    _renderTable() {
        if (this.table) { try { this.table.destroy(); } catch (e) {} this.table = null; }
        this.$gridHost.empty();

        if (!this.lastRows.length) {
            this.$gridHost.html(`<div class="iss-empty">
                <i class="fa fa-inbox fa-2x"></i><br><br>
                ${__("No items match the current filters.")}
            </div>`);
            return;
        }

        const hostId = "iss-tab-" + Date.now();
        this.$gridHost.append(`<div id="${hostId}" style="width:100%;height:100%;"></div>`);

        const cols = this._buildMergedColumns();
        this.table = new Tabulator("#" + hostId, {
            data: this.lastRows,
            layout: "fitDataStretch",
            // v0.0.36 — 100% so the table fills the flex grid host. When
            // the filter bar collapses, the grid host grows and the
            // table follows automatically (no manual setHeight call).
            height: "100%",
            // v0.0.37 r2 PERF — switch to virtual DOM. "basic" rendered
            // all 1137 rows up-front (~15k cells), making every sort /
            // filter cycle re-paint the whole grid. "virtual" only
            // renders the rows currently in the viewport (~30-40 rows
            // depending on row height + viewport), so sort completes
            // in milliseconds instead of seconds.
            renderVertical: "virtual",
            // Buffer extra rows above/below the viewport for smooth
            // scrolling (default is 600 — generous enough that the
            // operator never sees a render gap during fast scrolls).
            renderVerticalBuffer: 600,
            placeholder: __("No data"),
            columns: cols,
            initialSort: [{ column: "shortfall_higher", dir: "desc" }],
            responsiveLayout: false,
            // v0.0.35 — Items with open Sales Order qty get a red row
            // tint. v0.0.37 r2 — micro-opt: only touch the DOM when the
            // flag actually changes (toggle is no-op'd on equal state).
            rowFormatter: (row) => {
                const el = row.getElement();
                const hasSO = Number(row.getData().pending_so_stock || 0) > 0;
                if (hasSO !== el.classList.contains("iss-row-has-so")) {
                    el.classList.toggle("iss-row-has-so", hasSO);
                }
            },
        });

        // ─────────────────────────────────────────────────────────────
        // v0.0.34 — Horizontal scroll preservation across column sort.
        // CONTEXT: Tabulator 6 resets scrollLeft to 0 on every sort/
        //          redraw — operator has to re-scroll the wide qty cols
        //          each click. Multi-frame restoration loses the race
        //          against Tabulator's async virtual-DOM rebuild.
        // INSTRUCTIONS: SCROLL GUARD pattern — capture scrollLeft on
        //          header mousedown, set a guard flag, then attach a
        //          scroll listener that snaps scrollLeft back to the
        //          saved value any time Tabulator zeroes it within
        //          the guard window. Clear the guard after 400 ms.
        // DANGER:  Do NOT preserve scrollTop — user explicitly wants
        //          vertical scroll to reset so the new top row shows.
        //          Also: clear the guard early on user-initiated scroll
        //          so a real horizontal scroll attempt during the guard
        //          window isn't fought.
        // ─────────────────────────────────────────────────────────────
        let _savedScrollLeft = 0;
        let _guardUntil = 0;
        let _guardActive = false;
        const _holder = () => this.table.element.querySelector(".tabulator-tableholder");
        const _captureScrollLeft = () => {
            const h = _holder();
            if (h) _savedScrollLeft = h.scrollLeft;
        };
        const _armGuard = () => {
            // v0.0.37 r4 — Skip the guard entirely when the sort came
            // from the inline picker (we want the picker's centering
            // scroll to win, not the pre-sort scrollLeft).
            if (this._suppressScrollGuard) return;
            _captureScrollLeft();
            if (_savedScrollLeft <= 0) return;
            _guardActive = true;
            _guardUntil = Date.now() + 400;
            const h = _holder();
            if (!h) return;
            const onScroll = () => {
                if (!_guardActive) {
                    h.removeEventListener("scroll", onScroll, true);
                    return;
                }
                if (Date.now() > _guardUntil) {
                    _guardActive = false;
                    h.removeEventListener("scroll", onScroll, true);
                    return;
                }
                // If Tabulator zeroed the scroll, snap back. If the user
                // is actually scrolling (delta non-zero from saved),
                // accept their position and disarm the guard.
                if (h.scrollLeft === 0 && _savedScrollLeft > 0) {
                    h.scrollLeft = _savedScrollLeft;
                }
            };
            h.addEventListener("scroll", onScroll, true);
            // Belt-and-suspenders: also try a direct restore on the
            // next frames — usually one of these wins before any scroll
            // event fires.
            const restore = () => { if (h && _guardActive) h.scrollLeft = _savedScrollLeft; };
            requestAnimationFrame(restore);
            setTimeout(restore, 0);
            setTimeout(restore, 50);
            setTimeout(restore, 150);
            setTimeout(() => { _guardActive = false; }, 450);
        };
        $(this.table.element).on("mousedown", ".tabulator-col.tabulator-sortable", _armGuard);
        this.table.on("dataSorting", _armGuard);
        this.table.on("dataSorted", _armGuard);

        // v0.0.35 — re-apply universal search after every render so the
        // active term survives a Refresh, Reset, sort, or chip toggle.
        this.table.on("tableBuilt", () => this._applySearchFilter());
        this.table.on("dataFiltered", () => this._updateSearchCount());

        // v0.0.37 — sync the sort-picker label with whatever sort is
        // currently in effect (initialSort on first render, or the
        // operator's pick on subsequent ones). Doesn't auto-scroll —
        // initialSort shouldn't yank the viewport on page load.
        this.table.on("tableBuilt", () => {
            try {
                const sorters = this.table.getSorters() || [];
                if (sorters.length) {
                    const s = sorters[0];
                    this._sortField = s.field;
                    this._sortDir   = s.dir || "desc";
                    this.$sortValue.text(this._sortTitleFor(s.field));
                    this.$sortClear.show();
                    this._renderSortDirLabel();
                }
            } catch (e) { /* noop */ }
        });
    }

    _sortTitleFor(field) {
        // Source of truth: server column descriptions. Falls back to
        // a friendly mirror of the merged-column titles. Used by the
        // sort picker to show a human label after initialSort fires.
        const SERVER = {};
        (this.lastColumns || []).forEach(c => {
            if (c && c.field) SERVER[c.field] = c.title;
        });
        const MERGED = {
            item_code: __("Item"),
            current_stock_higher:  __("Current Stock"),
            pending_so_higher:     __("Pending SO"),
            pending_wo_higher:     __("Pending WO"),
            pending_po_higher:     __("Pending PO"),
            remain_wo_higher:      __("Remain WO Consumption"),
            total_demand_higher:   __("Total Demand"),
            shortfall_higher:      __("Shortage as per Projected"),
            surplus_higher:        __("Surplus as per Projected"),
            shortfall_cs_higher:   __("Shortage as per Current Stock"),
            surplus_cs_higher:     __("Surplus as per Current Stock"),
        };
        return MERGED[field] || SERVER[field] || field;
    }

    /* Build dashboard-side merged columns. The backend ships pairs
       (foo_higher, foo_stock); we render them as ONE column with the
       stacked two-line cell. XLSX export still uses separate columns
       — backend keeps both fields in the row payload. */
    _buildMergedColumns() {
        const that = this;
        // v0.0.35 — Build a fast lookup from the server's column metadata
        // so every Tabulator column can carry the layman-language tooltip
        // text. Keyed by `field` so the header tooltip stays in sync with
        // whatever the backend declares (single source of truth).
        const _descMap = {};
        (this.lastColumns || []).forEach(c => {
            if (c && c.field && c.description) _descMap[c.field] = c.description;
        });
        const _tip = (...keys) => keys.map(k => _descMap[k]).filter(Boolean).join("\n\n");

        // v0.0.32 — Each cell renders TWO DISTINCT CARDS so operators can
        // visually distinguish stock UOM vs higher UOM without reading the
        // UOM label. Stock UOM gets a slate card (canonical); higher UOM
        // gets an indigo card (derived). Both cards are clickable when a
        // drill-down source is set.
        const mergedQty = (higherField, stockField, source, title) => ({
            title,
            field: higherField,
            sorter: "number",
            minWidth: 170,
            hozAlign: "right",
            headerSort: false, // v0.0.37 — sort handled by the inline sort picker
            headerTooltip: _tip(higherField, stockField) || title,
            cssClass: "iss-qty iss-qty-cards",
            formatter: (cell) => {
                const data = cell.getRow().getData();
                const h = Number(data[higherField] || 0);
                const s = Number(data[stockField]  || 0);
                const hu = _esc(data.higher_uom || "");
                const su = _esc(data.stock_uom  || "");
                if (!h && !s) return `<span class="iss-qty-zero">0</span>`;
                const hStr = frappe.format(h, {fieldtype: "Float", precision: 3});
                const sStr = frappe.format(s, {fieldtype: "Float", precision: 0});
                const clickable = source ? "iss-qty-clickable" : "";
                return `<div class="iss-qty-twocards ${clickable}">
                    <div class="iss-qty-card iss-qty-card--stock" title="${__("Stock UOM")}">
                        <div class="iss-qty-card-num">${sStr}</div>
                        <div class="iss-qty-card-uom">${su}</div>
                    </div>
                    <div class="iss-qty-card iss-qty-card--higher" title="${__("Higher UOM")}">
                        <div class="iss-qty-card-num">${hStr}</div>
                        <div class="iss-qty-card-uom">${hu}</div>
                    </div>
                </div>`;
            },
            cellClick: source ? (e, cell) => {
                e.stopPropagation();
                that._openDrilldown(cell.getRow().getData(), source);
            } : undefined,
        });

        // v0.0.35 — colored variants. `tone` picks the background tint
        // matching the column's purpose (proj-short / proj-surp / cs-short / cs-surp).
        const mergedQtyTone = (higherField, stockField, tone, title) => {
            const c = mergedQty(higherField, stockField, null, title);
            c.cssClass = `iss-qty iss-qty-cards iss-qty-tone iss-qty-tone--${tone}`;
            return c;
        };

        // v0.0.35 — pill renderer for Status columns. `variant` controls
        // the column background tint: "proj" (very light gray) vs "cs"
        // (light gray) — matches the user's color spec.
        const statusCol = (field, title, variant) => ({
            title,
            field,
            minWidth: 130,
            hozAlign: "center",
            headerHozAlign: "center",
            headerSort: false, // v0.0.37 — sort handled by the inline sort picker
            headerTooltip: _tip(field) || title,
            cssClass: `iss-status-col iss-status-col--${variant}`,
            formatter: (cell) => {
                const v = cell.getValue();
                if (v === "Shortage") return `<span class="iss-pill iss-pill--shortage">${__("Shortage")}</span>`;
                if (v === "Surplus")  return `<span class="iss-pill iss-pill--surplus">${__("Surplus")}</span>`;
                return _esc(v || "");
            },
        });

        return [
            // v0.0.33 — Item is column 1 + frozen (sticky during horizontal
            // scroll). v0.0.35 — adds a small footer per row showing the
            // two statuses (Stock vs Projected) so operators see the
            // health summary right beside the item code without scrolling.
            { title: __("Item"), field: "item_code", minWidth: 280, widthGrow: 2, headerSort: false,
              frozen: true,
              cssClass: "iss-col-frozen iss-col-frozen-item",
              headerTooltip: _tip("item_name") || __("Item"),
              formatter: (cell) => {
                const d = cell.getRow().getData();
                const ps = d.demand_status_cs || "";
                const pp = d.demand_status || "";
                const badge = (label, val) => {
                    const cls = val === "Shortage" ? "iss-mini--short"
                              : val === "Surplus"  ? "iss-mini--surp"
                              : "iss-mini--neutral";
                    return `<span class="iss-mini ${cls}" title="${_esc(label)}: ${_esc(val)}">
                        <span class="iss-mini-label">${_esc(label)}</span>
                        <span class="iss-mini-val">${_esc(val || "—")}</span>
                    </span>`;
                };
                return `<div class="iss-item-cell-wrap">
                    <a class="iss-item-cell" href="/app/item/${encodeURIComponent(d.item_code)}" target="_blank" rel="noopener">
                        <span class="iss-item-code">${_esc(d.item_code)}</span>
                        <span class="iss-item-name">${_esc(d.item_name || "")}</span>
                    </a>
                    <div class="iss-item-footer">
                        ${badge(__("Stock"),     ps)}
                        ${badge(__("Projected"), pp)}
                    </div>
                </div>`;
              }
            },
            { title: __("Item Group"), field: "item_group", minWidth: 140, headerSort: false,
              headerTooltip: _tip("item_group") || __("Item Group"),
              formatter: (cell) => `<span class="iss-text-wrap">${_esc(cell.getValue() || "")}</span>` },
            mergedQty("current_stock_higher", "current_stock_stock", "stock",      __("Current Stock")),
            mergedQty("pending_so_higher",    "pending_so_stock",    "so",         __("Pending SO")),
            mergedQty("pending_wo_higher",    "pending_wo_stock",    "wo",         __("Pending WO")),
            mergedQty("pending_po_higher",    "pending_po_stock",    "po",         __("Pending PO")),
            mergedQty("remain_wo_higher",     "remain_wo_stock",     "wo_consume", __("Remain WO Consumption")),
            mergedQty("total_demand_higher",  "total_demand_stock",  "demand",     __("Total Demand")),
            // v0.0.35 — PROJECTED-mode group
            statusCol("demand_status", __("Status as per Projected"), "proj"),
            mergedQtyTone("shortfall_higher", "shortfall_stock", "proj-short", __("Shortage as per Projected")),
            mergedQtyTone("surplus_higher",   "surplus_stock",   "proj-surp",  __("Surplus as per Projected")),
            // v0.0.35 — CURRENT-STOCK-mode group
            statusCol("demand_status_cs", __("Status as per Current Stock"), "cs"),
            mergedQtyTone("shortfall_cs_higher", "shortfall_cs_stock", "cs-short", __("Shortage as per Current Stock")),
            mergedQtyTone("surplus_cs_higher",   "surplus_cs_stock",   "cs-surp",  __("Surplus as per Current Stock")),
        ];
    }

    // ── DRILL-DOWN MODAL ────────────────────────────────────────────────────
    _openDrilldown(rowData, source) {
        const sourceLabel = {
            stock:      __("Current Stock by Warehouse"),
            so:         __("Pending Sales Orders"),
            wo:         __("Pending Work Orders"),
            po:         __("Pending Purchase Orders"),
            wo_consume: __("Remaining WO Consumption"),
            demand:     __("Total Demand (SO + WO Consumption)"),
        }[source] || source;

        const dlg = new frappe.ui.Dialog({
            title: __("{0} — {1}", [rowData.item_code, sourceLabel]),
            size: "extra-large",
            fields: [{ fieldtype: "HTML", fieldname: "body" }],
        });
        dlg.show();
        const $body = $(dlg.fields_dict.body.wrapper);
        $body.html(`<div class="iss-loading"><i class="fa fa-spinner fa-spin"></i> ${__("Loading vouchers…")}</div>`);

        frappe.call({
            method: "chaizup_toc.api.item_short_surplus_api.get_voucher_drilldown",
            args: { item_code: rowData.item_code, source, filters: this.state },
        }).then(r => {
            const d = r.message || { rows: [] };
            this._renderDrillBody($body, rowData, d, sourceLabel);
        }).catch(err => {
            $body.html(`<div class="iss-error">${_esc(err.message || String(err))}</div>`);
        });
    }

    _renderDrillBody($body, rowData, drill, sourceLabel) {
        $body.empty();
        $body.addClass("iss-drill-root");

        const hu = drill.higher_uom || "—";
        const su = drill.stock_uom  || "—";
        const cf = Number(drill.cf || 1);
        const toH = (q) => cf ? Number(q || 0) / cf : 0;
        const fmt = (v) => v ? frappe.format(Number(v), {fieldtype: "Float"}) : "0";
        const totalPlannedStock = drill.rows.reduce((a, r) => a + Number(r.planned_stock || 0), 0);
        const totalActualStock  = drill.rows.reduce((a, r) => a + Number(r.actual_stock  || 0), 0);
        const totalPendingStock = drill.rows.reduce((a, r) => a + Number(r.pending_stock || 0), 0);

        // ── 1. Item card (item code + name + UOMs)
        $body.append(`
            <div class="iss-drill-itemcard">
                <div class="iss-drill-itemcard-left">
                    <div class="iss-drill-itemcard-code">${_esc(rowData.item_code || "")}</div>
                    <div class="iss-drill-itemcard-name">${_esc(rowData.item_name || "")}</div>
                </div>
                <div class="iss-drill-itemcard-right">
                    <div class="iss-drill-uom-pair">
                        <span class="iss-drill-uom-label">${__("Higher UOM")}</span>
                        <span class="iss-drill-uom-value">${_esc(hu)}</span>
                    </div>
                    <div class="iss-drill-uom-pair">
                        <span class="iss-drill-uom-label">${__("Stock UOM")}</span>
                        <span class="iss-drill-uom-value">${_esc(su)}</span>
                    </div>
                    <div class="iss-drill-uom-pair">
                        <span class="iss-drill-uom-label">${__("Conversion")}</span>
                        <span class="iss-drill-uom-value">1 ${_esc(hu)} = ${fmt(cf)} ${_esc(su)}</span>
                    </div>
                </div>
            </div>
        `);

        // ── 2. KPI tiles (Material 3 card style)
        const tileColor = (key) => ({
            planned: "var(--iss-tile-planned, #6366f1)",   // indigo
            actual:  "var(--iss-tile-actual,  #10b981)",   // emerald
            pending: "var(--iss-tile-pending, #f59e0b)",   // amber
        }[key] || "#64748b");
        // v0.0.34 — qty + UOM split into explicit <span> pair so the flex
        // layout below can keep them on the same baseline. Previously a
        // long qty (e.g. "3,61,674.8800") would wrap, dropping the UOM
        // span to its own visual line and breaking alignment.
        const tile = (key, label, stockVal, hu, su) => `
            <div class="iss-drill-tile" style="--iss-tile-color: ${tileColor(key)};">
                <div class="iss-drill-tile-label">${_esc(label)}</div>
                <div class="iss-drill-tile-main">
                    <span class="iss-drill-tile-num">${fmt(stockVal)}</span>
                    <span class="iss-drill-tile-uom">${_esc(su)}</span>
                </div>
                <div class="iss-drill-tile-sub">
                    <span class="iss-drill-tile-num">${fmt(toH(stockVal))}</span>
                    <span class="iss-drill-tile-uom">${_esc(hu)}</span>
                </div>
            </div>
        `;
        // For "stock" source, show four tiles — On-Hand / Reserved /
        // Incoming (Ordered PO + Planned WO) / Projected — so the
        // warehouse manager sees both the snapshot and the trajectory.
        if (drill.source === "stock") {
            const totalReservedStock  = drill.rows.reduce((a, r) => a + Number(r.reserved_stock  || 0), 0);
            const totalOrderedStock   = drill.rows.reduce((a, r) => a + Number(r.ordered_stock   || 0), 0);
            const totalPlannedWoStock = drill.rows.reduce((a, r) => a + Number(r.planned_stock   || 0), 0);
            const totalProjectedStock = drill.rows.reduce((a, r) => a + Number(r.projected_stock || 0), 0);
            const totalIncomingStock  = totalOrderedStock + totalPlannedWoStock;
            $body.append(`
                <div class="iss-drill-tiles">
                    ${tile("actual",  __("On-Hand"),   totalActualStock,    hu, su)}
                    ${tile("pending", __("Reserved"),  totalReservedStock,  hu, su)}
                    ${tile("planned", __("Incoming"),  totalIncomingStock,  hu, su)}
                    ${tile("actual",  __("Projected"), totalProjectedStock, hu, su)}
                </div>
            `);
        } else {
            $body.append(`
                <div class="iss-drill-tiles">
                    ${tile("planned", __("Planned"), totalPlannedStock, hu, su)}
                    ${tile("actual",  __("Actual"),  totalActualStock,  hu, su)}
                    ${tile("pending", __("Pending"), totalPendingStock, hu, su)}
                </div>
            `);
        }

        // ── 3. Vouchers table
        // ─────────────────────────────────────────────────────────────────
        // v0.0.33 — Section header now hosts an Export Excel button.
        // CONTEXT: Operator drilled into one item × one source and now wants
        //          to take the rows offline (share with planner, archive,
        //          file as audit evidence). We mirror the main report's
        //          export pattern via export_drilldown_xlsx.
        // INSTRUCTIONS: Always POST the same `item_code, source, filters`
        //          triple that the modal was opened with — re-deriving on
        //          the server keeps a single source of truth for filter
        //          semantics (Filter Accuracy Principle).
        // DANGER: Do NOT serialize `drill.rows` from the client and ship
        //          them up to the server — that bypasses live state and
        //          can leak stale snapshots into a "live" export.
        // ─────────────────────────────────────────────────────────────────
        const that = this;
        const stateForExport = JSON.stringify(this.state || {});
        $body.append(`
            <div class="iss-drill-section-title">
                <span class="iss-drill-section-title-text">
                    <i class="fa fa-list-ul"></i> ${_esc(sourceLabel)}
                    <span class="iss-drill-section-count">${drill.rows.length} ${drill.rows.length === 1 ? __("entry") : __("entries")}</span>
                </span>
                <button class="btn btn-sm iss-drill-export-btn"
                        data-item="${_esc(rowData.item_code || "")}"
                        data-source="${_esc(drill.source || "")}">
                    <i class="fa fa-file-excel-o"></i> ${__("Export Excel")}
                </button>
            </div>
        `);

        // ─────────────────────────────────────────────────────────────────
        // Wire export click → GET window.open to whitelisted endpoint.
        // DANGER: Do NOT use a form POST with CSRF token in the body — Frappe
        //          only validates X-Frappe-CSRF-Token in the HEADER, so a
        //          form POST returns 400 (CSRF rejected). The main report's
        //          Export XLSX already uses GET via window.open and works;
        //          we mirror that pattern.
        // INSTRUCTIONS: Always re-derive filters from `this.state` so the
        //          live filter (Filter Accuracy Principle) is honored — never
        //          ship a cached row snapshot from the client.
        // ─────────────────────────────────────────────────────────────────
        $body.find(".iss-drill-export-btn").on("click", function () {
            const $btn = $(this);
            const itemCode = $btn.data("item");
            const src      = $btn.data("source");
            $btn.prop("disabled", true).html(
                `<i class="fa fa-spinner fa-spin"></i> ${__("Exporting…")}`
            );
            const qs = [
                `item_code=${encodeURIComponent(itemCode)}`,
                `source=${encodeURIComponent(src)}`,
                `filters=${encodeURIComponent(stateForExport)}`,
            ].join("&");
            const url = `/api/method/chaizup_toc.api.item_short_surplus_api.export_drilldown_xlsx?${qs}`;
            window.open(url, "_blank");
            // Re-enable after a short pause — browser handles the download
            // natively so there's no completion callback to await.
            setTimeout(() => {
                $btn.prop("disabled", false).html(
                    `<i class="fa fa-file-excel-o"></i> ${__("Export Excel")}`
                );
            }, 1500);
        });

        if (!drill.rows.length) {
            $body.append(`
                <div class="iss-drill-empty">
                    <i class="fa fa-inbox fa-2x"></i><br><br>
                    ${__("No vouchers found for this filter combination.")}
                </div>
            `);
            return;
        }

        // v0.0.31 — `kind` property tags planned / actual / pending columns
        // so CSS can color-code BOTH the header and the cell in one rule.
        // v0.0.33 — Voucher Type column added at position 2 so operators
        // can scan the source type (Sales Order / Work Order / Purchase
        // Order / WO Consumption / Warehouse Bin) without inferring it
        // from the voucher number.
        let columns;
        if (drill.source === "stock") {
            // v0.0.36 — Warehouse-manager view: per-warehouse breakdown
            // covering on-hand, what's reserved by open SO, what's coming
            // in from open PO/WO, and the ERPNext-computed projected qty.
            columns = [
                { title: __("Warehouse"),    field: "voucher_no",        isLink: true, link_prefix: "warehouse" },
                { title: __("Company"),      field: "warehouse_company" },
                { title: `${__("On-Hand")} (${_esc(su)})`,    field: "actual_stock",     num: true, kind: "actual", bold: true },
                { title: `${__("On-Hand")} (${_esc(hu)})`,    field: "actual_higher",    num: true, kind: "actual", muted: true },
                { title: `${__("Reserved")} (${_esc(su)})`,   field: "reserved_stock",   num: true, kind: "pending" },
                { title: `${__("Reserved")} (${_esc(hu)})`,   field: "reserved_higher",  num: true, kind: "pending", muted: true },
                { title: `${__("Ordered PO")} (${_esc(su)})`, field: "ordered_stock",    num: true, kind: "planned" },
                { title: `${__("Ordered PO")} (${_esc(hu)})`, field: "ordered_higher",   num: true, kind: "planned", muted: true },
                { title: `${__("Planned WO")} (${_esc(su)})`, field: "planned_stock",    num: true, kind: "planned" },
                { title: `${__("Planned WO")} (${_esc(hu)})`, field: "planned_higher",   num: true, kind: "planned", muted: true },
                { title: `${__("Projected")} (${_esc(su)})`,  field: "projected_stock",  num: true, kind: "actual", bold: true },
                { title: `${__("Projected")} (${_esc(hu)})`,  field: "projected_higher", num: true, kind: "actual", muted: true },
            ];
        } else {
            columns = [
                { title: __("Voucher"),          field: "voucher_no",   isLink: true },
                { title: __("Voucher Type"),     field: "voucher_type", kind: "type" },
                { title: __("Date"),             field: "posting_date" },
                { title: `${__("Planned")} (${_esc(su)})`, field: "planned_stock",  num: true, kind: "planned" },
                { title: `${__("Planned")} (${_esc(hu)})`, field: "planned_higher", num: true, kind: "planned", muted: true },
                { title: `${__("Actual")} (${_esc(su)})`,  field: "actual_stock",   num: true, kind: "actual" },
                { title: `${__("Actual")} (${_esc(hu)})`,  field: "actual_higher",  num: true, kind: "actual", muted: true },
                { title: `${__("Pending")} (${_esc(su)})`, field: "pending_stock",  num: true, kind: "pending", bold: true },
                { title: `${__("Pending")} (${_esc(hu)})`, field: "pending_higher", num: true, kind: "pending", muted: true, bold: true },
            ];
        }

        const $wrap = $(`<div class="iss-drill-tablewrap"></div>`);
        const $tbl = $(`<table class="iss-drill-table"></table>`);
        const $tr = $(`<tr></tr>`);
        columns.forEach(c => {
            const cls = [];
            if (c.num) cls.push("num");
            if (c.kind) cls.push(`kind-${c.kind}`);
            $tr.append(`<th class="${cls.join(' ')}">${_esc(c.title)}</th>`);
        });
        $tbl.append($(`<thead></thead>`).append($tr));
        const $tbody = $(`<tbody></tbody>`);
        drill.rows.forEach(r => {
            const $row = $(`<tr></tr>`);
            columns.forEach(c => {
                let html;
                const classes = [];
                if (c.num) classes.push("num");
                if (c.muted) classes.push("muted");
                if (c.bold) classes.push("bold");
                if (c.kind) classes.push(`kind-${c.kind}`);
                if (c.isLink && r.voucher_link) {
                    html = `<a href="${_esc(r.voucher_link)}" target="_blank" rel="noopener" class="iss-drill-link">
                        ${_esc(r[c.field] || "")}
                        <i class="fa fa-external-link iss-drill-link-icon"></i>
                    </a>`;
                } else if (c.num) {
                    const v = Number(r[c.field] || 0);
                    html = v ? frappe.format(v, {fieldtype: "Float"})
                             : `<span class="iss-qty-zero">—</span>`;
                } else if (c.field === "posting_date") {
                    // v0.0.37 — friendly local format "dd-MMM-yyyy"
                    // (timestamps elsewhere get the longer "dd-MMM-yyyy hh:mm am/pm"
                    // via _fmtTs; posting_date is date-only on these vouchers).
                    html = r[c.field] ? _esc(_fmtDate(r[c.field]))
                                       : `<span class="iss-qty-zero">—</span>`;
                } else if (c.field === "voucher_type") {
                    // v0.0.33 — color-coded voucher type pill
                    const vt = r.voucher_type || "—";
                    const pillCls = {
                        "Sales Order":     "vt-pill--so",
                        "Work Order":      "vt-pill--wo",
                        "Purchase Order":  "vt-pill--po",
                        "WO Consumption":  "vt-pill--wocons",
                        "Warehouse Bin":   "vt-pill--bin",
                    }[vt] || "vt-pill--bin";
                    html = `<span class="vt-pill ${pillCls}">${_esc(vt)}</span>`;
                } else {
                    html = _esc(r[c.field] || "");
                }
                $row.append(`<td class="${classes.join(' ')}">${html}</td>`);
            });
            $tbody.append($row);
        });
        $tbl.append($tbody);
        $wrap.append($tbl);
        $body.append($wrap);
    }

    // ── EXPORT ──────────────────────────────────────────────────────────────
    _export() {
        const args = encodeURIComponent(JSON.stringify(this.state));
        const url = `/api/method/chaizup_toc.api.item_short_surplus_api.export_xlsx?filters=${args}`;
        window.open(url, "_blank");
    }
}
