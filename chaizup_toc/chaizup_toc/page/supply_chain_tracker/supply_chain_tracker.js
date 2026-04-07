/*
 * supply_chain_tracker.js -- Supply Chain Tracker Controller
 * ===========================================================
 *
 * ARCHITECTURE OVERVIEW
 * ---------------------
 * The page operates in two mutually-exclusive view modes that share the
 * same server data pipeline:
 *
 *   Tracker View (default)
 *     One collapsible row per TOC-managed item. Each row shows a buffer
 *     zone bar (BP%), next-action hint, and an expandable document chain
 *     (MR -> RFQ/PP -> SQ/WO -> PO/JC -> PR/SE/QI). Bodies are lazy-built
 *     on first expand to keep the initial render fast.
 *
 *   Pipeline View
 *     A horizontal 7-stage Kanban. Cards sit in stage columns; directed SVG
 *     Bezier edges connect source -> target. Clicking a card:
 *       1. Runs BFS forward (descendants) + BFS backward (ancestors)
 *       2. Hides (display:none) all non-lineage cards so the layout
 *          collapses around the relevant chain
 *       3. After a double-rAF browser reflow, redraws only relevant edges
 *          with marching-ants animation (.live class)
 *
 * DATA MODEL (from server: pipeline_api.get_pipeline_data)
 * ---------------------------------------------------------
 *   nodes[]  -- Every pipeline entity: item buffers, MRs, RFQs, POs, WOs,
 *               JCs, PRs, SEs, QIs. Key fields per node:
 *                 id, stage, sub_type, doctype, doc_name, status, zone,
 *                 bp_pct, is_overdue, days_open, days_overdue, supplier...
 *               Node IDs are stable composite keys (e.g. "MR::MR-0001").
 *
 *   edges[]  -- Directed pairs { source, target } encoding document lineage.
 *               e.g. { source:"MR::MR-0001", target:"PO::PO-0001" }
 *
 *   tracks[] -- Item-centric aggregations for the Tracker view. Each track
 *               bundles its documents with pending/overdue counts and a
 *               pre-computed next_action recommendation string.
 *
 *   summary  -- Server-side aggregate counts (red/yellow/green items, open
 *               MRs, WOs, POs) for the summary strip.
 *
 * FILTER TIERS
 * ------------
 *   Server-side (trigger load()):
 *     days_back, supplier -- change the underlying dataset.
 *
 *   Client-side (trigger render() only):
 *     search, zone, item_group, doctype, overdue, auto, noaction
 *     Applied in _applyClientFilters() against already-loaded arrays.
 *     Zone filter uses BFS propagation: seed items matching the zone, then
 *     expand to all reachable nodes via the edge graph.
 *
 * SVG EDGE COORDINATE SYSTEM
 * --------------------------
 *   The SVG overlay lives INSIDE .sct-pl-grid (the expanding flex container
 *   that also holds stage columns). This is critical: SVG must scroll with
 *   the cards. If SVG were a direct child of .sct-pl-scroll instead,
 *   it would stay fixed while cards scroll, breaking all coordinates.
 *
 *   Coordinate anchor: (card.getBoundingClientRect().right - grid.getBCR().left)
 *   Both rects are in viewport space. When the user scrolls the scroll
 *   container, BOTH shift by the same delta, so the subtraction stays
 *   constant -- a stable grid-space coordinate.
 *
 *   Bezier curve formula: M x1,y1 C x1+dx,y1 x2-dx,y2 x2,y2
 *   where dx = |x2-x1| * 0.42 (tension factor).
 *   - 0.42 produces smooth S-curves that elongate proportionally when
 *     nodes span multiple skipped stages.
 *   - Lower values make straighter lines; higher values tighten bends.
 *
 * ANIMATION SYSTEM (edge wire behaviour)
 * ---------------------------------------
 *   State 1 -- Default (no selection):
 *     All edges drawn at opacity 0.15 via CSS .sct-edge rule.
 *     Hover over a card -> direct edges get .hl (opacity 0.9), others .dim.
 *
 *   State 2 -- Card selected:
 *     _applyLineageHighlight(id):
 *       a. BFS ancestors (bwd graph) + BFS descendants (fwd graph)
 *       b. Non-lineage cards: .hide -> display:none -> layout collapses
 *       c. double-rAF: waits for browser reflow after layout change
 *       d. _drawEdges(relevant, liveMode=true):
 *            - Skips cards with .hide (getBCR would return zeros)
 *            - All drawn paths get .live -> marching-ants CSS animation
 *
 *   State 3 -- Clear selection:
 *     _clearSelection(): removes .hide from all cards, double-rAF redraws
 *     all edges at default opacity 0.15 (liveMode=false).
 *
 *   WHY hide instead of dim: display:none removes the card from layout,
 *   so the remaining cards repack into the column. After reflow, the bezier
 *   coordinates are computed only from visible cards, giving clean paths.
 *   Opacity-based dimming leaves cards in layout, causing wires to route
 *   around invisible obstacles.
 *
 * TOC FORMULA REFERENCE
 * ---------------------
 *   F1: Target = ADU x RLT x VF
 *   F2a (FG):  IP = On-Hand + WIP - Backorders
 *   F2b (RM):  IP = On-Hand + On-Order - Committed
 *   F3: BP% = (Target - IP) / Target * 100
 *   F4: Order Qty = Target - IP   (replenishment deficit)
 *
 * Brand: Oswald (headings) + DM Sans (body)
 *        --brand-500 #f97316 (Chaizup tiger orange)
 *        Warm stone: buy=cyan #06b6d4, mfg=violet #8b5cf6, out=emerald #10b981
 */
frappe.pages["supply-chain-tracker"].on_page_load = function (wrapper) {
  if (wrapper.sct_initialized) return;
  wrapper.sct_initialized = true;

  // Build the Frappe app page shell (toolbar, breadcrumb, etc.)
  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "Supply Chain Tracker",
    single_column: true,
  });

  // Top-bar quick actions
  page.add_inner_button(__("Refresh"), () => window.sctApp.load()).addClass("btn-primary");
  page.add_menu_item(__("TOC Live Dashboard"),       () => frappe.set_route("toc-dashboard"));
  page.add_menu_item(__("Production Priority Board"),() => frappe.set_route("query-report", "Production Priority Board"));
  page.add_menu_item(__("Procurement Action List"),  () => frappe.set_route("query-report", "Procurement Action List"));
  page.add_menu_item(__("TOC Settings"),             () => frappe.set_route("Form", "TOC Settings", "TOC Settings"));

  // Render the page HTML template (supply_chain_tracker.html) into the page body
  $(frappe.render_template("supply_chain_tracker", {})).appendTo(page.body);

  // Instantiate the controller and kick off initial data fetch
  window.sctApp = new SupplyChainTracker(page);
  window.sctApp.init();
};


// ===============================================================================
//  SupplyChainTracker  -- main controller class
//  All state, rendering logic, and event handling lives here.
// ===============================================================================
class SupplyChainTracker {
  constructor(page) {
    this.page    = page;   // Frappe app-page reference (for future toolbar use)

    // -- Raw server data (refreshed by load()) ---------------------------------
    this.nodes   = [];     // All pipeline nodes (items + documents)
    this.edges   = [];     // Directed edges { source, target } for the DAG
    this.tracks  = [];     // Tracker-view rows (item-centric aggregations)
    this.nodeMap = {};     // nodes keyed by id for O(1) lookup: { [id]: node }

    // -- Pipeline view state ---------------------------------------------------
    this.cardEls    = {};     // DOM element map { [nodeId]: HTMLElement } for edge anchoring
    this.selectedId = null;   // Currently selected node id (null = no selection)

    // -- Active filter state ----------------------------------------------------
    // search, zone, item_group, doctype are client-side (no server round-trip).
    // supplier requires a new API call (server-side SQL join).
    // days_back changes the look-back window for open documents.
    this.f = {
      search:     "",      // Free-text search across item codes, doc names, suppliers
      type:       "All",   // Buffer type: "All" | "FG" | "SFG" | "RM" | "PM"
      zone:       "All",   // TOC zone: "All" | "Red" | "Yellow" | "Green" | "Black"
      doctype:    "All",   // Document type abbreviation: "All" | "MR" | "PO" | ...
      supplier:   "",      // Supplier name (server-side filter -- triggers load())
      item_group: "",      // Item group (client-side filter)
      overdue:    false,   // Show only items/docs with at least one overdue document
      auto:       false,   // Show only TOC-auto-generated MRs (recorded_by = "By System")
      noaction:   false,   // Show only items with NO open Material Request
      days_back:  30,      // Look-back window in days (server-side)
    };

    this.viewMode  = "tracker";   // Active view: "tracker" | "pipeline"
    this._bomCache = new Map();   // BOM lookup cache: item_code -> { bomName, items[] } | null

    // -- Pipeline stage definitions --------------------------------------------
    // The seven columns of the pipeline view, left-to-right.
    // flow: "item" | "buy" | "mfg" | "both" | "out" controls the column header
    // accent colour (matches CSS .sl-* classes and _flowColors).
    this.stages = [
      { id: "items",            label: "Items",             sub: "TOC-managed",           icon: "📦", flow: "item", num: "01" },
      { id: "material_request", label: "Material Request",  sub: "Replenishment trigger",  icon: "📋", flow: "both", num: "02" },
      { id: "rfq_pp",           label: "RFQ / Prod. Plan",  sub: "Procurement or plan",    icon: "🔍", flow: "both", num: "03" },
      { id: "sq_wo",            label: "Quotation / WO",    sub: "Quote or Work Order",    icon: "⚙",  flow: "both", num: "04" },
      { id: "po_jc",            label: "PO / Job Card",     sub: "Confirmed order/op",     icon: "🛒", flow: "both", num: "05" },
      { id: "receipt_qc",       label: "Receipt / QC / SE", sub: "Goods or production",   icon: "✅", flow: "both", num: "06" },
      { id: "output",           label: "FG / SFG Buffer",   sub: "Current buffer state",  icon: "🏭", flow: "out",  num: "07" },
    ];

    // Edge stroke colours -- must be hex values, NOT CSS vars, because SVG
    // presentation attributes do not resolve CSS custom properties.
    this._flowColors = {
      buy:  "#06b6d4",   // cyan-500  -- purchase flow
      mfg:  "#8b5cf6",   // violet-500 -- manufacturing flow
      both: "#f97316",   // brand orange -- mixed/MR stage
      item: "#a8a29e",   // stone-400  -- item -> MR edges
      out:  "#10b981",   // emerald-500 -- output (FG/SFG buffer) edges
    };
  }

  // ==============================================================================
  //  INIT
  //  Wire up all static DOM events, load initial dropdown options, then fetch data.
  // ==============================================================================
  init() {
    this._bindCommandBar();     // Search, view-mode toggle, days select, scroll/resize
    this._bindFilterPanel();    // Filter pills, apply/reset buttons
    this._bindPanel();          // Detail panel close button
    this._bindSummaryClicks();  // Stat strip zone-filter shortcuts
    this._loadFilterOptions();  // Async: fetch supplier & warehouse lists for dropdowns
    this.load();                // Initial server fetch
  }

  // ==============================================================================
  //  DATA FETCH
  //  Sends server-side filter parameters to get_pipeline_data.
  //  Server handles: time window, supplier join, warehouse join.
  //  All other filters (zone, search, doctype, etc.) are applied client-side
  //  in _applyClientFilters() to avoid slow page loads on every keypress.
  // ==============================================================================
  load() {
    this._setLoading(true);
    frappe.call({
      method: "chaizup_toc.api.pipeline_api.get_pipeline_data",
      args: {
        // Only pass filter values that are non-default (null = no filter on server)
        buffer_type: this.f.type    !== "All" ? this.f.type    : null,
        zone:        this.f.zone    !== "All" ? this.f.zone    : null,
        supplier:    this.f.supplier  || null,
        warehouse:   this.f.warehouse || null,
        days_back:   this.f.days_back,
      },
      callback: (r) => {
        this._setLoading(false);
        if (r.exc || !r.message) {
          frappe.show_alert({ message: __("Failed to load tracker data"), indicator: "red" });
          return;
        }
        const d = r.message;

        // Store raw arrays; nodeMap is built for O(1) access during rendering
        this.nodes  = d.nodes  || [];
        this.edges  = d.edges  || [];
        this.tracks = d.tracks || [];
        this.nodeMap = {};
        this.nodes.forEach(n => (this.nodeMap[n.id] = n));

        this._updateSummary(d.summary || {}, d.meta || {});
        this.render();
      },
    });
  }

  // ==============================================================================
  //  RENDER DISPATCH
  //  Single entry point called after every filter change or data load.
  //  Clears any active pipeline selection/panel, applies client-side filters,
  //  then delegates to the active view renderer.
  // ==============================================================================
  render() {
    this._clearSelection();   // Reset pipeline highlight & edge state
    this._closePanel();       // Close detail panel if open

    const { visibleNodes, visibleTracks } = this._applyClientFilters();

    if (this.viewMode === "tracker") {
      this._renderTracker(visibleTracks);
    } else {
      this._renderPipeline(visibleNodes);
    }

    this._updateFilterBadge();   // Keep the "Filters (N)" badge current
  }

  // ==============================================================================
  //  TRACKER VIEW
  //  Renders a vertical list of collapsible item rows, one per track.
  //  Uses DocumentFragment for a single DOM insertion to minimise reflow.
  // ==============================================================================
  _renderTracker(tracks) {
    const wrap = document.getElementById("sct-view-tracker");
    wrap.innerHTML = "";

    if (!tracks.length) {
      wrap.innerHTML = `<div class="sct-empty">
        <div class="sct-empty-icon">📭</div>
        <div>No items match the current filters</div>
      </div>`;
      return;
    }

    // DocumentFragment batches all DOM insertions into one reflow
    const frag = document.createDocumentFragment();
    tracks.forEach(track => frag.appendChild(this._buildTrackEl(track)));
    wrap.appendChild(frag);
  }

  /**
   * Build a single tracker row element for one TOC item.
   *
   * Structure:
   *   .sct-track                (adds .overdue-track if any doc is overdue)
   *     .sct-track-header       (always visible; click to expand)
   *       .sct-track-zone-bar   (left coloured stripe -- Red/Yellow/Green)
   *       .sct-track-item-info  (item code + name, tags)
   *       .sct-track-meta       (BP% bar, zone badge, doc counts, next-action)
   *     .sct-track-body         (hidden by default; built lazily on first expand)
   *
   * The body is lazily rendered: data-built="0" on first render, flipped to "1"
   * when the user first expands the row. This keeps the initial paint fast when
   * there are hundreds of tracks.
   */
  _buildTrackEl(track) {
    const el = document.createElement("div");
    el.className = "sct-track" + (track.overdue_count > 0 ? " overdue-track" : "");
    el.dataset.itemCode = track.item_code;

    const zoneColor = this._zoneBarColor(track.zone);
    const bp        = Math.min(track.bp_pct || 0, 100);   // Cap at 100% for the bar fill
    const isUrgent  = track.zone === "Red" || track.zone === "Black";

    const hdr = document.createElement("div");
    hdr.className = "sct-track-header";
    hdr.innerHTML = `
      <div class="sct-track-zone-bar" style="background:${zoneColor}"></div>
      <div class="sct-track-item-info">
        <div class="sct-track-item-name">${track.item_code}
          <span style="font-size:11px;font-weight:400;color:var(--stone-500)"> -- ${track.item_name}</span>
        </div>
        <div class="sct-track-item-sub">
          ${track.buffer_type ? `<span class="sct-doc-tag tag-item">${track.buffer_type}</span>` : ""}
          ${!track.toc_enabled ? `<span class="sct-tag-non-toc">Non-TOC</span>` : ""}
          ${track.item_group  ? `<span style="font-size:10px;color:var(--stone-400);margin-left:4px">${track.item_group}</span>` : ""}
          ${track.warehouse   ? `<span style="font-size:10px;color:var(--stone-400);margin-left:4px">📍 ${track.warehouse}</span>` : ""}
        </div>
      </div>
      <div class="sct-track-meta">
        ${track.zone ? `
          <div class="sct-track-bp">
            <div class="sct-track-bp-bar">
              <div class="sct-track-bp-fill bp-${track.zone}" style="width:${bp}%"></div>
            </div>
            <span class="sct-track-bp-val" style="color:${zoneColor}">${track.bp_pct}%</span>
          </div>
          ${this._zoneBadge(track.zone)}
        ` : ""}
        <div class="sct-track-counts">
          ${track.pending_count > 0  ? `<span class="sct-track-count-chip count-open">${track.pending_count} open</span>`         : ""}
          ${track.overdue_count > 0  ? `<span class="sct-track-count-chip count-overdue">⚠ ${track.overdue_count} overdue</span>` : ""}
          ${track.doc_count > 0 && track.pending_count === 0
            ? `<span class="sct-track-count-chip count-done">v done</span>` : ""}
        </div>
        <div class="sct-track-next-action${isUrgent ? " urgent" : ""}" title="${track.next_action}">
          ${track.next_action}
        </div>
      </div>
      <span class="sct-track-toggle">v</span>
    `;
    // Toggle the expanded class (CSS shows/hides the body via max-height transition)
    hdr.addEventListener("click", () => el.classList.toggle("expanded"));
    el.appendChild(hdr);

    // Lazy body container -- innerHTML is empty until first expand
    const body = document.createElement("div");
    body.className = "sct-track-body";
    body.dataset.built = "0";
    el.appendChild(body);

    // On any click on the expanded row, check if the body needs building yet.
    // Using data-built flag avoids re-rendering on every click inside the body.
    el.addEventListener("click", () => {
      if (!el.classList.contains("expanded")) return;
      if (body.dataset.built === "0") {
        body.innerHTML = this._buildTrackBody(track);
        body.dataset.built = "1";
        // Wire up document row click -> detail panel (delegated, not inline onclick)
        body.querySelectorAll(".sct-doc-row[data-doc]").forEach(row => {
          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const nodeId = row.dataset.nodeid;
            const node   = this.nodeMap[nodeId] || this._makeNodeFromDoc(row.dataset);
            this.showPanel(node || { doctype: row.dataset.doctype, doc_name: row.dataset.doc, label: row.dataset.doc, stage: "" });
          });
        });
      }
    });

    return el;
  }

  /**
   * Build the HTML string for the expanded body of a track row.
   *
   * Sections rendered (in order):
   *   1. Stock info chips -- shows F1 Target, F2 IP, F3 BP%, F4 Deficit
   *   2. Next action box  -- urgent styling when zone is Red/Black or action starts with ⚠
   *   3. Documents        -- grouped by stage, each stage as a labelled section
   *                         Order follows supply chain flow: MR -> RFQ/PP -> SQ/WO -> PO/JC -> PR/SE
   */
  _buildTrackBody(track) {
    const parts = [];

    // -- Stock info chips (TOC buffer formulas) ---------------------------------
    if (track.zone) {
      const deficit = track.order_qty > 0;
      parts.push(`
        <div class="sct-stock-row">
          <div class="sct-stock-chip">
            <span class="sct-stock-chip-val">${track.on_hand}</span>
            <span class="sct-stock-chip-lbl">On-Hand</span>
          </div>
          <div class="sct-stock-chip">
            <span class="sct-stock-chip-val">${track.inventory_position}</span>
            <span class="sct-stock-chip-lbl">IP (F2)</span>
          </div>
          <div class="sct-stock-chip">
            <span class="sct-stock-chip-val">${track.target_buffer}</span>
            <span class="sct-stock-chip-lbl">Target (F1)</span>
          </div>
          ${deficit ? `
          <div class="sct-stock-chip urgent">
            <span class="sct-stock-chip-val">${track.order_qty}</span>
            <span class="sct-stock-chip-lbl">Deficit (F4)</span>
          </div>` : ""}
          <div class="sct-stock-chip">
            <span class="sct-stock-chip-val">${track.bp_pct}%</span>
            <span class="sct-stock-chip-lbl">BP% (F3)</span>
          </div>
        </div>`);
    }

    // -- Next action recommendation ---------------------------------------------
    if (track.next_action) {
      const isUrgent = track.next_action.startsWith("⚠") || track.zone === "Red" || track.zone === "Black";
      parts.push(`
        <div class="sct-next-action-box${isUrgent ? " urgent" : ""}">
          <div class="sct-next-action-box-title">⬆ NEXT ACTION</div>
          <div class="sct-next-action-box-text">${track.next_action}</div>
        </div>`);
    }

    // -- Document rows grouped by pipeline stage --------------------------------
    if (!track.documents || !track.documents.length) {
      parts.push(`<div class="sct-no-docs">No open documents in the last ${this.f.days_back} days</div>`);
    } else {
      // Stage order follows the supply chain flow left-to-right
      const stageLabels = {
        material_request: "Material Request",
        rfq_pp:           "RFQ / Production Plan",
        sq_wo:            "Supplier Quotation / Work Order",
        po_jc:            "Purchase Order / Job Card",
        receipt_qc:       "Receipt / QC / Stock Entry",
        output:           "FG/SFG Output",
      };
      const stageOrder = Object.keys(stageLabels);
      const byStage    = {};
      track.documents.forEach(d => (byStage[d.stage] = byStage[d.stage] || []).push(d));

      stageOrder.forEach(stage => {
        if (!byStage[stage] || !byStage[stage].length) return;
        parts.push(`
          <div class="sct-doc-stage-group">
            <div class="sct-doc-stage-label">${stageLabels[stage]}</div>
            ${byStage[stage].map(doc => this._buildDocRow(doc, track.item_code)).join("")}
          </div>`);
      });
    }

    return parts.join("");
  }

  /**
   * Build an HTML string for a single document row within the tracker body.
   *
   * The row carries:
   *   data-doc      -- document name (used to open Frappe form)
   *   data-doctype  -- ERPNext doctype string
   *   data-nodeid   -- composite node id (e.g., "PO::PO-0001") used to look up
   *                   the node in this.nodeMap for the detail panel
   *
   * Visual elements:
   *   left icon    -- doctype emoji
   *   body         -- doc name, TOC-Auto tag, MR type, sub-text (supplier/qty/due), progress bar
   *   right column -- status badge, age, overdue warning
   */
  _buildDocRow(doc, item_code) {
    const icons = {
      "Material Request": "📋", "Request for Quotation": "🔍",
      "Supplier Quotation": "💬", "Production Plan": "📅",
      "Work Order": "⚙", "Purchase Order": "🛒", "Job Card": "🔧",
      "Purchase Receipt": "📦", "Quality Inspection": "🔬", "Stock Entry": "📝",
    };
    const icon   = icons[doc.doctype] || "📄";
    const ageTxt = doc.days_open ? `${doc.days_open}d old` : "";
    const overdueCls = doc.is_overdue ? " overdue" : "";

    // Abbreviation prefix used in the composite node id ("MR::", "PO::", etc.)
    const docTypePfx = {
      "Material Request": "MR", "Request for Quotation": "RFQ",
      "Supplier Quotation": "SQ", "Production Plan": "PP",
      "Work Order": "WO", "Purchase Order": "PO", "Job Card": "JC",
      "Purchase Receipt": "PR", "Quality Inspection": "QI", "Stock Entry": "SE",
    };
    const fullId = `${docTypePfx[doc.doctype] || ""}::${doc.doc_name}`;

    let subText = [];
    if (doc.supplier)  subText.push(`Supplier: ${doc.supplier}`);
    if (doc.qty)       subText.push(`Qty: ${doc.qty}`);
    if (doc.operation) subText.push(doc.operation);
    if (doc.due_date)  subText.push(`Due: ${doc.due_date}`);

    // Progress bar shown only when progress_pct is meaningful (> 0)
    let progressHtml = "";
    if (doc.progress_pct > 0) {
      progressHtml = `
        <div class="sct-doc-row-progress">
          <div class="sct-doc-row-progress-bar">
            <div class="sct-doc-row-progress-fill" style="width:${doc.progress_pct}%"></div>
          </div>
          <span>${doc.progress_pct}%</span>
        </div>`;
    }

    return `
      <div class="sct-doc-row${overdueCls}" data-doc="${doc.doc_name}"
           data-doctype="${doc.doctype}" data-nodeid="${fullId}"
           title="Click to view details">
        <div class="sct-doc-row-icon">${icon}</div>
        <div class="sct-doc-row-body">
          <div class="sct-doc-row-name">
            ${doc.doc_name}
            ${doc.recorded_by === "By System" ? `<span class="sct-auto-tag">TOC Auto</span>` : ""}
            ${doc.mr_type ? `<span class="sct-badge sct-badge-default" style="font-size:9px;margin-left:3px">${doc.mr_type}</span>` : ""}
          </div>
          <div class="sct-doc-row-sub">${subText.join(" · ") || "&nbsp;"}</div>
          ${progressHtml}
          ${doc.zone ? `<div style="margin-top:3px">${this._zoneBadge(doc.zone)} <span style="font-size:9px;color:var(--stone-400)">BP: ${doc.bp_pct}%</span></div>` : ""}
        </div>
        <div class="sct-doc-row-right">
          <span class="sct-doc-row-status ${this._statusBadgeClass(doc.status)}">${doc.status}</span>
          ${ageTxt ? `<span class="sct-doc-row-age">${ageTxt}</span>` : ""}
          ${doc.is_overdue ? `<span class="sct-doc-row-overdue">⚠ ${doc.days_overdue}d overdue</span>` : ""}
        </div>
      </div>`;
  }

  /**
   * Construct a minimal synthetic node from a tracker doc-row's dataset attributes.
   * Used as a fallback when a tracker-view document doesn't appear in this.nodeMap
   * (e.g., documents outside the pipeline edge graph but present in the track's docs).
   */
  _makeNodeFromDoc(dataset) {
    return this.nodeMap[dataset.nodeid] || {
      id: dataset.nodeid,
      doctype: dataset.doctype,
      doc_name: dataset.doc,
      label: dataset.doc,
      stage: "",
    };
  }

  // ==============================================================================
  //  PIPELINE VIEW
  //  Renders a 7-column Kanban with SVG bezier edges connecting related nodes.
  //
  //  DOM structure produced:
  //    .sct-pl-scroll                 (overflow-x:auto scroll container)
  //      .sct-pl-grid                           (min-width:max-content flex row)
  //        #sct-svg-overlay                 (SVG absolute-positioned, full grid size)
  //        .stage[data-stage="items"]       (column 1)
  //          .st-head                       (column header with flow accent)
  //          .st-body                       (scrollable card body)
  //            .track-sep.ts-buy            (buy/mfg section separator)
  //            .sct-card-v2                 (one node card)
  //            ...
  //        .stage[data-stage="material_request"]  (column 2)
  //        ...
  //
  //  WHY sct-pl-grid wrapper:
  //    The SVG overlay must be a sibling of the stage columns inside the same
  //    expanding container. If it were placed inside .sct-pl-scroll directly,
  //    the SVG would not scroll with the cards; coordinate references would drift.
  // ==============================================================================
  _renderPipeline(visibleNodes) {
    const scroll = document.getElementById("sct-pl-scroll");

    // Use the pre-existing grid from the HTML template (id="sct-pl-grid").
    // The HTML already contains the SVG inside this grid -- no need to move it.
    // Fallback: create the grid if somehow not present in the DOM.
    let grid = document.getElementById("sct-pl-grid");
    if (!grid) {
      grid = document.createElement("div");
      grid.id = "sct-pl-grid";
      grid.className = "pl-grid";
      const svg = document.getElementById("sct-svg-overlay");
      if (svg) grid.appendChild(svg);
      scroll?.appendChild(grid);
    }

    // Remove only stage columns (leave SVG in place)
    [...grid.querySelectorAll(".stage")].forEach(c => c.remove());

    // Reset selection state for the new render
    this.cardEls = {};
    this.selectedId = null;
    document.getElementById("sct-clear-btn")?.classList.remove("on");
    document.querySelectorAll(".track-sep").forEach(s => s.style.display = "");

    const visibleIds = new Set(visibleNodes.map(n => n.id));

    if (!visibleNodes.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "padding:40px 20px;color:var(--stone-400);font-size:13px;align-self:start";
      empty.textContent = "No pipeline data for current filters.";
      grid.appendChild(empty);
    } else {
      this.stages.forEach(stage => {
        grid.appendChild(this._buildPipelineCol(stage, visibleIds, visibleNodes));
      });
    }

    // double-rAF: wait two frames so the browser has fully laid out the columns
    // before we read getBoundingClientRect() for edge coordinate calculation.
    // A single rAF is not sufficient -- layout may still be in progress after frame 1.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._drawEdges(visibleIds);
      this._injectPorts(visibleIds);

      // Redraw edges when any column body scrolls vertically.
      // Preserve liveMode (marching ants) if a card is currently selected.
      grid.querySelectorAll(".st-body").forEach(b =>
        b.addEventListener("scroll", () => {
          const vn = this._applyClientFilters().visibleNodes;
          const ids = new Set(vn.map(n => n.id));
          this._drawEdges(this.selectedId ? new Set(Object.keys(this.cardEls)) : ids,
                          !!this.selectedId);
        }, { passive: true })
      );
    }));
  }

  /**
   * Build one stage column element.
   *
   * A column that has no nodes for the current filter still gets rendered as a
   * collapsed .hide-stage stub so empty stages don't waste horizontal space.
   * Flow class (sl-item, sl-buy, sl-mfg, etc.) colours the column header's
   * left-border accent to visually communicate which flow path the column belongs to.
   */
  _buildPipelineCol(stage, visibleIds, visibleNodes) {
    const stageNodes = visibleNodes.filter(n => n.stage === stage.id);

    const col = document.createElement("div");
    col.className = "stage";
    col.dataset.stage = stage.id;

    // Collapse empty columns to slim stubs (not completely hidden -- keeps consistent layout)
    if (!stageNodes.length && visibleNodes.length > 0) {
      col.classList.add("hide-stage");
    }

    // Map flow enum to CSS class for header accent colour
    const flowCls = {
      item: "sl-item", buy: "sl-buy", mfg: "sl-mfg", out: "sl-out", both: "sl-both"
    }[stage.flow] || "sl-both";

    const hdr = document.createElement("div");
    hdr.className = "st-head";
    hdr.innerHTML = `
      <div class="st-label ${flowCls}">
        <div class="st-n">${parseInt(stage.num, 10)}</div>
        ${stage.label}
      </div>`;
    col.appendChild(hdr);

    const body = document.createElement("div");
    body.className = "st-body";

    if (!stageNodes.length) {
      // Italic placeholder so empty columns don't look broken
      const empty = document.createElement("div");
      empty.style.cssText = "text-align:center;padding:18px 6px;color:var(--stone-400);font-size:10px;font-style:italic";
      empty.textContent = "No documents";
      body.appendChild(empty);
    } else {
      // Split nodes into buy/mfg sections with visual separators
      this._appendSeparatedCards(stage.id, stageNodes, body);
    }

    col.appendChild(body);
    return col;
  }

  /**
   * Append cards to a stage body with optional buy/mfg section separators.
   *
   * Mixed stages (rfq_pp, sq_wo, po_jc, receipt_qc) show two sections only when
   * BOTH flavours are present -- if only one type exists, no separator is added
   * to keep the column clean. Each stage has its own split logic:
   *
   *   items        -> RM/PM vs SFG/FG (by buffer_type)
   *   material_req -> Purchase MR vs Manufacture MR (by mr_type)
   *   rfq_pp       -> RFQ vs Production Plan (by sub_type)
   *   sq_wo        -> Supplier Quotation vs Work Order (by sub_type)
   *   po_jc        -> Purchase Order vs Job Card (by sub_type)
   *   receipt_qc   -> PR/QI vs Stock Entry (by sub_type)
   *   output       -> SFG Output vs FG Output (by buffer_type)
   */
  _appendSeparatedCards(stageId, nodes, body) {
    // Helper: build card element and register in cardEls map for edge anchoring
    const add = (n) => { const c = this._buildPipelineCard(n); this.cardEls[n.id] = c; body.appendChild(c); };

    if (stageId === "items") {
      const buy   = nodes.filter(n => ["rm","pm"].includes((n.buffer_type||"").toLowerCase()));
      const mfg   = nodes.filter(n => ["sfg","fg"].includes((n.buffer_type||"").toLowerCase()));
      const other = nodes.filter(n => !["rm","pm","sfg","fg"].includes((n.buffer_type||"").toLowerCase()));
      if (buy.length) { body.appendChild(this._makeSep("Raw Mat & Packaging", "ts-buy")); buy.forEach(add); }
      if (mfg.length) { body.appendChild(this._makeSep("Semi-FG & Finished", "ts-mfg")); mfg.forEach(add); }
      other.forEach(add);

    } else if (stageId === "material_request") {
      const buy = nodes.filter(n => (n.mr_type||"").toLowerCase().includes("purchase"));
      const mfg = nodes.filter(n => !(n.mr_type||"").toLowerCase().includes("purchase"));
      // Only add separators when both types are present
      if (buy.length && mfg.length) {
        body.appendChild(this._makeSep("Purchase", "ts-buy")); buy.forEach(add);
        body.appendChild(this._makeSep("Manufacture", "ts-mfg")); mfg.forEach(add);
      } else nodes.forEach(add);

    } else if (stageId === "rfq_pp") {
      const buy   = nodes.filter(n => n.sub_type === "rfq");
      const mfg   = nodes.filter(n => n.sub_type === "pp");
      const other = nodes.filter(n => n.sub_type !== "rfq" && n.sub_type !== "pp");
      if (buy.length && mfg.length) {
        body.appendChild(this._makeSep("RFQ", "ts-buy")); buy.forEach(add);
        body.appendChild(this._makeSep("Prod. Plan", "ts-mfg")); mfg.forEach(add);
      } else nodes.forEach(add);
      other.forEach(add);

    } else if (stageId === "sq_wo") {
      const buy   = nodes.filter(n => n.sub_type === "sq");
      const mfg   = nodes.filter(n => n.sub_type === "wo");
      const other = nodes.filter(n => n.sub_type !== "sq" && n.sub_type !== "wo");
      if (buy.length && mfg.length) {
        body.appendChild(this._makeSep("Supplier Quotation", "ts-buy")); buy.forEach(add);
        body.appendChild(this._makeSep("Work Order", "ts-mfg")); mfg.forEach(add);
      } else nodes.forEach(add);
      other.forEach(add);

    } else if (stageId === "po_jc") {
      const buy   = nodes.filter(n => n.sub_type === "po");
      const mfg   = nodes.filter(n => n.sub_type === "jc");
      const other = nodes.filter(n => n.sub_type !== "po" && n.sub_type !== "jc");
      if (buy.length && mfg.length) {
        body.appendChild(this._makeSep("Purchase Order", "ts-buy")); buy.forEach(add);
        body.appendChild(this._makeSep("Job Card", "ts-mfg")); mfg.forEach(add);
      } else nodes.forEach(add);
      other.forEach(add);

    } else if (stageId === "receipt_qc") {
      const buy   = nodes.filter(n => ["pr","qi"].includes(n.sub_type));
      const mfg   = nodes.filter(n => n.sub_type === "se");
      const other = nodes.filter(n => !["pr","qi","se"].includes(n.sub_type));
      if (buy.length && mfg.length) {
        body.appendChild(this._makeSep("Receipt + QC", "ts-buy")); buy.forEach(add);
        body.appendChild(this._makeSep("Stock Entry", "ts-mfg")); mfg.forEach(add);
      } else nodes.forEach(add);
      other.forEach(add);

    } else if (stageId === "output") {
      const sfg   = nodes.filter(n => (n.buffer_type||"").toLowerCase() === "sfg");
      const fg    = nodes.filter(n => (n.buffer_type||"").toLowerCase() === "fg");
      const other = nodes.filter(n => !["sfg","fg"].includes((n.buffer_type||"").toLowerCase()));
      if (sfg.length) { body.appendChild(this._makeSep("SFG Output", "ts-mfg")); sfg.forEach(add); }
      if (fg.length)  { body.appendChild(this._makeSep("FG Output", "ts-out")); fg.forEach(add); }
      other.forEach(add);

    } else {
      // Fallback: unseparated list for unrecognised stage ids
      nodes.forEach(add);
    }
  }

  /** Create a .track-sep labelled section divider element. */
  _makeSep(label, cls) {
    const sep = document.createElement("div");
    sep.className = `track-sep ${cls}`;
    sep.textContent = label;
    return sep;
  }

  /**
   * Build one pipeline card (.sct-card-v2).
   *
   * Card anatomy:
   *   .v2-type-chip    -- top-left coloured type label (e.g. "Purchase MR", "Work Order")
   *   .v2-top          -- name line + VIEW button + status widget (badge or dot)
   *   .v2-body         -- key-value rows specific to the node's doctype
   *   .v2-ports        -- in/out degree badges injected later by _injectPorts()
   *
   * Status widget:
   *   Item/output nodes -> .v2-dot (tiny coloured circle reflecting zone/status)
   *   Document nodes    -> .v2-badge (text badge: OPEN, IN PROCESS, COMPLETED, etc.)
   *
   * Click interactions (three separate behaviours):
   *   VIEW button click -> open detail panel AND trigger lineage selection
   *   Card click        -> toggle lineage selection only (no panel)
   *   Card hover        -> highlight directly connected edges (hl/dim classes)
   */
  _buildPipelineCard(node) {
    const el = document.createElement("div");
    el.className = `sct-card-v2 ${this._btClass(node)}`;
    el.dataset.id = node.id;

    const chip    = this._v2TypeChip(node);
    const { name, ref } = this._v2NameRef(node);
    const rows    = this._v2BodyRows(node);
    // Always escape HTML for values that come from the server to prevent XSS
    const safeName = frappe.utils.escape_html(name || node.doc_name);
    const safeRef  = frappe.utils.escape_html(ref || "");

    // Items and output buffer nodes use a status dot; all document nodes use a text badge
    const isItemNode = node.stage === "items" || node.sub_type === "output";
    const statusWidget = isItemNode
      ? `<div class="v2-dot ${this._v2Dot(node)}"></div>`
      : `<span class="v2-badge ${this._v2BadgeCls(node)}">${frappe.utils.escape_html(node.status || "Open")}</span>`;

    el.innerHTML = `
      ${chip}
      <div class="v2-top">
        <div style="min-width:0;flex:1">
          <div class="v2-name" title="${frappe.utils.escape_html(node.doc_name)}">${safeName}</div>
          ${safeRef ? `<div class="v2-ref">${safeRef}</div>` : ""}
        </div>
        <div class="v2-actions">
          <button class="v2-view-btn">VIEW</button>
          ${statusWidget}
        </div>
      </div>
      <div class="v2-body">${rows}</div>
    `;

    // VIEW button: selects lineage AND opens detail panel
    el.querySelector(".v2-view-btn").addEventListener("click", e => {
      e.stopPropagation();
      // Reset selectedId first so _pipelineSelect always re-triggers highlight
      if (this.selectedId !== node.id) {
        this.selectedId = null;
        this._pipelineSelect(node.id);
      }
      this.showPanel(this.nodeMap[node.id]);
    });

    // Card body click: toggles lineage selection only (no panel open/close)
    el.addEventListener("click", e => {
      if (e.target.closest(".v2-view-btn")) return;   // defer to VIEW button handler
      e.stopPropagation();
      this._pipelineSelect(node.id);
    });

    // Hover: temporarily highlight direct edges (suppressed when something is selected)
    el.addEventListener("mouseenter", () => {
      if (this.selectedId) return;
      document.querySelectorAll(".sct-edge").forEach(p => {
        const hit = p.dataset.source === node.id || p.dataset.target === node.id;
        p.classList.toggle("hl", hit);    // hl = highlighted edge (opacity 0.9)
        p.classList.toggle("dim", !hit);  // dim = background edge (opacity 0.04)
      });
    });
    el.addEventListener("mouseleave", () => {
      if (this.selectedId) return;
      document.querySelectorAll(".sct-edge").forEach(p => p.classList.remove("hl", "dim"));
    });

    return el;
  }

  // ==============================================================================
  //  PIPELINE CARD HELPER METHODS
  // ==============================================================================

  /**
   * Return the HTML for the coloured type-chip at the top of a card.
   * The chip label and CSS modifier class are derived from node.buffer_type
   * and node.sub_type using a priority-ordered lookup.
   */
  _v2TypeChip(node) {
    const bt  = (node.buffer_type || "").toLowerCase();
    const sub = node.sub_type || "";
    let cls = "v2tc-item", label = "ITEM";

    if      (sub === "output")  { cls = bt === "sfg" ? "v2tc-sfg" : "v2tc-out"; label = bt === "sfg" ? "SFG Output" : "FG Output"; }
    else if (bt === "rm")       { cls = "v2tc-rm";  label = "Raw Mat"; }
    else if (bt === "pm")       { cls = "v2tc-pm";  label = "Packaging"; }
    else if (bt === "sfg")      { cls = "v2tc-sfg"; label = "Semi-FG"; }
    else if (bt === "fg")       { cls = "v2tc-fg";  label = "Fin. Good"; }
    else if (sub === "mr")      {
      const isBuy = (node.mr_type || "").toLowerCase().includes("purchase");
      cls = isBuy ? "v2tc-buy" : "v2tc-mfg"; label = isBuy ? "Purchase MR" : "Mfg. MR";
    }
    else if (sub === "rfq")     { cls = "v2tc-buy"; label = "RFQ"; }
    else if (sub === "sq")      { cls = "v2tc-buy"; label = "Quotation"; }
    else if (sub === "po")      { cls = "v2tc-buy"; label = "Purch. Order"; }
    else if (sub === "pr")      { cls = "v2tc-buy"; label = "Receipt"; }
    else if (sub === "qi")      { cls = "v2tc-buy"; label = "Quality Insp."; }
    else if (sub === "pp")      { cls = "v2tc-mfg"; label = "Prod. Plan"; }
    else if (sub === "wo")      { cls = "v2tc-mfg"; label = "Work Order"; }
    else if (sub === "jc")      { cls = "v2tc-mfg"; label = "Job Card"; }
    else if (sub === "se")      { cls = "v2tc-mfg"; label = "Stock Entry"; }

    return `<div class="v2-type-chip ${cls}">${label}</div>`;
  }

  /**
   * Return the CSS modifier for the status dot on item/output cards.
   * Zone (TOC buffer state) takes precedence over document status when present.
   *   dok   = green  (healthy/complete)
   *   dwarn = yellow (in-progress/open)
   *   derr  = red    (overdue/error)
   *   didle = grey   (unknown/untracked)
   */
  _v2Dot(node) {
    if (node.is_overdue) return "derr";
    if (node.zone === "Red" || node.zone === "Black") return "derr";
    if (node.zone === "Yellow") return "dwarn";
    if (node.zone === "Green")  return "dok";
    const s = String(node.status || "").toLowerCase();
    if (["completed","to-bill","submitted","closed","received"].some(x => s.includes(x))) return "dok";
    if (["open","ordered","in process","in-process","not started","not-started","material transferred","pending"].some(x => s.includes(x))) return "dwarn";
    if (["overdue","stopped","cancelled","blocked"].some(x => s.includes(x))) return "derr";
    return "didle";
  }

  /**
   * Return the CSS modifier for the status badge on document cards.
   * Maps ERPNext status strings to badge colour variants:
   *   v2b-ok    = green  (completed/received/closed)
   *   v2b-run   = blue   (submitted/in process/ordered)
   *   v2b-draft = grey   (draft/open/pending)
   *   v2b-warn  = yellow (partial/in transit)
   *   v2b-err   = red    (overdue/stopped/cancelled)
   */
  _v2BadgeCls(node) {
    const s = String(node.status || "").toLowerCase();
    if (["completed","closed","fully received","received","to-bill"].some(x => s.includes(x)))    return "v2b-ok";
    if (["submitted","in process","in-process","ordered","approved","accepted"].some(x => s.includes(x))) return "v2b-run";
    if (["draft","not started","not-started","open","queued","pending"].some(x => s.includes(x))) return "v2b-draft";
    if (["overdue","stopped","cancelled","blocked"].some(x => s.includes(x)))                     return "v2b-err";
    if (["in transit","transit","partial","partially"].some(x => s.includes(x)))                  return "v2b-warn";
    return "v2b-draft";
  }

  /**
   * Return the display name and subtitle reference for a pipeline card.
   *
   *   Items / output nodes -> item_code as name, item_name as subtitle
   *   Buy-chain docs       -> doc_name, supplier as subtitle
   *   Mfg-chain docs       -> doc_name, item_code or operation as subtitle
   *   Generic              -> label (server-computed) or doc_name, description
   */
  _v2NameRef(node) {
    const sub   = node.sub_type || "";
    const stage = node.stage || "";
    let name = node.label || node.doc_name;
    let ref  = "";

    if (stage === "items" || sub === "output") {
      name = node.item_code || node.doc_name;
      ref  = node.item_name || node.item_group || "";
    } else if (["rfq","sq","po","pr"].includes(sub)) {
      ref = node.supplier || node.description || "";
    } else if (sub === "jc") {
      ref = node.operation || node.description || "";    // Operation name is the key context for a Job Card
    } else if (sub === "wo" || sub === "pp") {
      ref = node.item_code || node.description || "";    // For WO/PP the item being produced is most useful
    } else {
      ref = node.description || "";
    }
    return { name: name || node.doc_name, ref };
  }

  /**
   * Return the HTML string of key-value rows (.v2-row) for the card body.
   * Content is specific to each document sub_type. Only non-empty, non-zero
   * values are included. Helper `r()` returns "" for falsy values.
   *
   * Always appends an overdue or age row at the end when relevant:
   *   - Overdue: red "⚠ Nd overdue"
   *   - Age > 14 days: yellow age indicator (old but not yet technically overdue)
   */
  _v2BodyRows(node) {
    // Only render the row if value is meaningful
    const r = (lbl, val, cls = "") =>
      val !== null && val !== undefined && val !== "" && val !== 0
        ? `<div class="v2-row"><span class="v2-lbl">${lbl}</span><span class="v2-val${cls ? " " + cls : ""}">${val}</span></div>`
        : "";
    const fmtMoney = v => v > 0 ? `₹ ${Number(v).toLocaleString("en-IN")}` : "";
    const sub   = node.sub_type || "";
    const stage = node.stage   || "";
    const bt    = (node.buffer_type || "").toLowerCase();
    let rows = "";

    if (stage === "items" || sub === "output") {
      if (node.toc_enabled) {
        // Colour zone-related values: err=red, warn=yellow, ok=green
        const zCls = node.zone === "Red" || node.zone === "Black" ? "err" : node.zone === "Yellow" ? "warn" : node.zone === "Green" ? "ok" : "";
        rows += r("Stock",   node.on_hand,       zCls);
        rows += r("Reorder", node.target_buffer);
        if (node.zone)   rows += r("Zone",   node.zone, zCls);
        if (node.bp_pct) rows += r("BP%",    `${node.bp_pct}%`, zCls);
      } else {
        rows += r("Item Group", node.item_group || "");
        rows += `<div class="v2-row"><span class="v2-lbl">TOC</span><span class="sct-tag-non-toc">Non-TOC</span></div>`;
      }
    } else if (sub === "mr") {
      rows += r("Type",   node.mr_type || "");
      rows += r("Item",   node.item_code || "");
      rows += r("Qty",    node.required_qty || node.qty || "");
      if (node.recorded_by === "By System")   // System-generated by the TOC engine
        rows += `<div class="v2-row"><span class="v2-lbl">Source</span><span class="sct-auto-tag">TOC Auto</span></div>`;
    } else if (sub === "rfq") {
      rows += r("Item",  node.item_code || node.description || "");
      rows += r("Qty",   node.qty || "");
    } else if (sub === "sq") {
      rows += r("Rate",  node.rate   ? `₹${node.rate}` : "");
      rows += r("Total", fmtMoney(node.grand_total));
    } else if (sub === "pp") {
      rows += r("Target", node.planned_qty ? `${node.planned_qty} ${node.item_code||""}` : "");
      rows += r("Status", node.status || "");
    } else if (sub === "wo") {
      const pct = node.progress_pct || 0;
      rows += r("FG",       node.item_code || "", "mfg");
      rows += r("Progress", pct ? `${pct}%` : "", pct >= 100 ? "ok" : pct > 0 ? "warn" : "");
      const done = node.produced_qty || 0;
      if (node.qty > 0) rows += r("Qty", `${done} / ${node.qty}`);
    } else if (sub === "po") {
      rows += r("Total", fmtMoney(node.grand_total));
      rows += r("ETA",   node.expected_delivery || "", node.is_overdue ? "err" : "");
    } else if (sub === "jc") {
      const pct = node.progress_pct || 0;
      rows += r("Operation", node.operation || "");
      rows += r("Progress",  pct ? `${pct}%` : "", pct >= 100 ? "ok" : pct > 0 ? "warn" : "");
    } else if (sub === "pr") {
      rows += r("Received", node.qty ? `${node.qty} received` : "", "ok");
      if (node.rejected_qty > 0) rows += r("Rejected", node.rejected_qty, "err");
    } else if (sub === "qi") {
      rows += r("Status", node.status || "", node.status === "Accepted" ? "ok" : node.status === "Rejected" ? "err" : "warn");
    } else if (sub === "se") {
      rows += r("Type", node.description || "");
      if (node.produced_qty > 0) rows += r("Produced", `${node.produced_qty}`, "mfg");
    }

    // Append timing context -- always useful regardless of doctype
    if (node.is_overdue) {
      rows += r("Overdue", `⚠ ${node.days_overdue}d`, "err");
    } else if (node.days_open > 14) {
      // Warn about stale documents open longer than 2 weeks but not yet past due
      rows += r("Age", `${node.days_open}d`, "warn");
    }

    return rows;
  }

  /**
   * Return the CSS class that drives the left-edge accent stripe on a card.
   * Works for both .sct-card (tracker) and .sct-card-v2 (pipeline) elements.
   * The CSS ::before pseudo-element reads this class for its background colour.
   */
  _btClass(node) {
    const bt  = (node.buffer_type || "").toLowerCase();
    const sub = node.sub_type || "";
    if (bt === "rm")  return "bt-rm";   // stone/brown
    if (bt === "pm")  return "bt-pm";   // teal
    if (bt === "sfg") return "bt-sfg";  // violet
    if (bt === "fg")  return "bt-fg";   // brand orange
    if (["rfq","sq","po","pr","qi"].includes(sub)) return "bt-buy";  // cyan
    if (["pp","wo","jc","se"].includes(sub))       return "bt-mfg";  // purple
    if (node.stage === "items" || node.stage === "output") return "bt-item";
    return "";
  }

  /**
   * Return an HTML <span> for the tiny status dot used in the tracker view.
   * The pipeline view uses _v2Dot() instead (different class shapes).
   */
  _statusDot(status) {
    const s = String(status || "").toLowerCase();
    let cls = "didle";
    if (["completed","to-bill","submitted","closed"].some(x => s.includes(x))) cls = "dok";
    else if (["open","ordered","in-process","not-started","material-transferred","pending"].some(x => s.includes(x))) cls = "dwarn";
    else if (["overdue","stopped","cancelled"].some(x => s.includes(x))) cls = "derr";
    return `<span class="sdot ${cls}"></span>`;
  }

  // ==============================================================================
  //  PIPELINE SELECTION & LINEAGE HIGHLIGHT
  // ==============================================================================

  /**
   * Toggle selection on a pipeline node.
   * Clicking the same node twice deselects it (toggle behaviour).
   * Clicking a different node transitions directly to the new selection.
   */
  _pipelineSelect(id) {
    if (this.selectedId === id) {
      // Second click on same card -> clear everything
      this._clearSelection();
      this._closePanel();
    } else {
      this.selectedId = id;
      this._applyLineageHighlight(id);
      document.getElementById("sct-clear-btn")?.classList.add("on");
      this.showPanel(this.nodeMap[id]);
    }
  }

  /**
   * Clear all pipeline selection state and restore default edge opacity.
   *
   * Steps:
   *   1. Reset selectedId and remove all selection/highlight/hide classes from cards
   *   2. Restore collapsed stages and separators to their full-visible state
   *   3. After double-rAF reflow, redraw all edges at default opacity 0.15 (liveMode=false)
   *
   * The double-rAF is necessary because removing .hide (display:none) triggers layout
   * changes; the browser needs at least two frames to finalise card positions before
   * getBoundingClientRect() gives accurate coordinates for the bezier curves.
   */
  _clearSelection() {
    this.selectedId = null;
    Object.values(this.cardEls).forEach(el => {
      el.classList.remove("selected", "ancestor", "descendant", "dimmed", "hide");
    });
    // Restore any stages that were collapsed during lineage highlight
    document.querySelectorAll(".stage").forEach(s => s.classList.remove("hide-stage"));
    // Restore any separators that were hidden during lineage highlight
    document.querySelectorAll(".track-sep").forEach(s => s.style.display = "");
    document.getElementById("sct-clear-btn")?.classList.remove("on");
    // Redraw edges at default faint opacity -- wait for layout reflow first
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const visibleIds = new Set(Object.keys(this.cardEls));
      this._drawEdges(visibleIds);   // liveMode=false -> opacity 0.15, no animation
    }));
  }

  /**
   * Apply lineage highlight for a selected node.
   *
   * Algorithm:
   *   1. Build adjacency maps (fwd: source->[targets], bwd: target->[sources])
   *   2. BFS backward from id -> ancestors (all upstream nodes)
   *   3. BFS forward from id  -> descendants (all downstream nodes)
   *   4. relevant = union of { id, ancestors, descendants }
   *   5. All non-relevant cards get .hide (display:none) -- not dim!
   *      display:none collapses them from layout so the remaining cards repack
   *      into columns, shortening bezier paths and removing visual clutter.
   *   6. Stages where every card is hidden get .hide-stage (collapsed stub)
   *   7. Track separators with no visible cards below them are hidden inline
   *   8. double-rAF waits for browser to reflow after the hide operations
   *   9. _drawEdges(relevant, true) draws only relevant paths with .live class
   *      (marching-ants CSS animation, opacity 1)
   *
   * WHY double-rAF:
   *   After step 5, the browser must schedule a layout pass to process the
   *   display:none changes. requestAnimationFrame fires BEFORE that layout.
   *   The second rAF fires after the layout pass completes, so card positions
   *   from getBoundingClientRect() are accurate.
   */
  _applyLineageHighlight(id) {
    const fwd = {}, bwd = {};
    this.edges.forEach(e => {
      (fwd[e.source] = fwd[e.source] || []).push(e.target);
      (bwd[e.target] = bwd[e.target] || []).push(e.source);
    });

    const bfs = (start, adj) => {
      const visited = new Set();
      const q = [start];
      while (q.length) {
        const cur = q.shift();
        (adj[cur] || []).forEach(nb => { if (!visited.has(nb)) { visited.add(nb); q.push(nb); } });
      }
      return visited;
    };

    const ancestors   = bfs(id, bwd);
    const descendants = bfs(id, fwd);
    const relevant    = new Set([id, ...ancestors, ...descendants]);

    Object.entries(this.cardEls).forEach(([nid, el]) => {
      el.classList.remove("selected", "ancestor", "descendant", "dimmed", "hide");
      if      (nid === id)           el.classList.add("selected");
      else if (ancestors.has(nid))   el.classList.add("ancestor");
      else if (descendants.has(nid)) el.classList.add("descendant");
      else                           el.classList.add("hide");
    });

    document.querySelectorAll(".stage").forEach(stage => {
      const hasRelevant = Array.from(stage.querySelectorAll(".sct-card-v2"))
        .some(c => !c.classList.contains("hide"));
      stage.classList.toggle("hide-stage", !hasRelevant);
    });

    this._updateSeparatorVisibility();
    document.getElementById("sct-clear-btn")?.classList.add("on");

    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._drawEdges(relevant, true);
    }));
  }

  /**
   * Hide track separators that have no visible cards following them.
   *
   * Walks the children of each .st-body in DOM order:
   *   - When a .track-sep is encountered, save it as "pending"
   *   - When a .sct-card-v2 that is not .hide/.dimmed is found, the pending sep is visible
   *   - When the next .track-sep is found, finalise the previous sep's visibility
   *   - At end of children, finalise the last sep
   */
  _updateSeparatorVisibility() {
    document.querySelectorAll(".st-body").forEach(body => {
      let curSep = null, hasVisible = false;
      Array.from(body.children).forEach(child => {
        if (child.classList.contains("track-sep")) {
          // Finalise previous separator
          if (curSep) curSep.style.display = hasVisible ? "" : "none";
          curSep = child; hasVisible = false;
        } else if (child.classList.contains("sct-card-v2")) {
          // Count this card as visible unless it's in hide or dimmed state
          if (!child.classList.contains("hide") && !child.classList.contains("dimmed")) hasVisible = true;
        }
      });
      // Finalise the last separator in the column
      if (curSep) curSep.style.display = hasVisible ? "" : "none";
    });
  }

  // ==============================================================================
  //  SVG EDGES
  //  Draws cubic Bezier paths between connected card elements.
  //
  //  COORDINATE SYSTEM
  //  -----------------
  //  Both the card and the grid container are queried with getBoundingClientRect()
  //  which returns coordinates in viewport (window) space. Subtracting the grid's
  //  rect position from the card's rect position converts to grid-space:
  //
  //    x1 = card.right  - grid.left    <- source card right edge in grid coords
  //    y1 = card.top + card.height/2 - grid.top   <- vertical midpoint of card
  //
  //  This is stable under horizontal scrolling of .sct-pl-scroll because
  //  both card.right and grid.left shift by the same scroll delta.
  //
  //  BEZIER FORMULA
  //  --------------
  //  Path:  M x1,y1  C (x1+dx),y1  (x2-dx),y2  x2,y2
  //  where: dx = |x2 - x1| x 0.42  (tension = 42% of horizontal span)
  //
  //  The horizontal span factor (0.42) was chosen empirically:
  //    - Small values (< 0.3) produce near-straight lines
  //    - Large values (> 0.55) produce hairpin bends for adjacent columns
  //    - 0.42 gives smooth S-curves that remain readable across 1-6 skipped stages
  //
  //  LIVE MODE
  //  ---------
  //  liveMode=false (default): edges drawn at CSS opacity 0.15, no animation
  //  liveMode=true  (after lineage select): every drawn path gets .live class
  //                  -> marching-ants stroke-dasharray animation at opacity 1
  // ==============================================================================

  /** Return hex stroke colour for an edge (based on target node's sub_type). */
  _getEdgeColor(edge) {
    const tgt = this.nodeMap[edge.target];
    const sub = tgt?.sub_type || "";
    const mrType = (tgt?.mr_type || "").toLowerCase();
    // Buy-chain edges: RFQ, SQ, PO, PR, QI -> cyan
    if (["rfq","sq","po","pr","qi"].includes(sub))       return this._flowColors.buy;
    // Mfg-chain edges: PP, WO, JC, SE -> violet
    if (["pp","wo","jc","se"].includes(sub))             return this._flowColors.mfg;
    // MR edges inherit colour from MR type
    if (sub === "mr" && mrType.includes("purchase"))     return this._flowColors.buy;
    if (sub === "mr")                                    return this._flowColors.mfg;
    // Buffer output edges -> emerald
    const stage = tgt?.stage || "";
    if (stage === "output") return this._flowColors.out;
    if (stage === "items")  return this._flowColors.item;
    return "#a8a29e"; // stone-400 fallback for unclassified edges
  }

  /** Return the CSS flow class for an edge (used for additional CSS overrides if needed). */
  _getEdgeFlowClass(edge) {
    const tgt = this.nodeMap[edge.target];
    const sub = tgt?.sub_type || "";
    const mrType = (tgt?.mr_type || "").toLowerCase();
    if (["rfq","sq","po","pr","qi"].includes(sub))   return "flow-buy";
    if (["pp","wo","jc","se"].includes(sub))         return "flow-mfg";
    if (sub === "mr" && mrType.includes("purchase")) return "flow-buy";
    if (sub === "mr")                                return "flow-mfg";
    if ((tgt?.stage || "") === "output")             return "flow-out";
    return "";
  }

  /**
   * Completely redraw all SVG edges for the given set of visible node ids.
   *
   * @param {Set<string>}  visibleIds  -- only draw edges where both source AND target are in this set
   * @param {boolean}      liveMode    -- when true, add .live class to animate drawn paths
   *
   * The SVG is cleared and rebuilt from scratch on every call. This is intentional:
   * card positions change after show/hide operations, after scrolling, and after resize.
   * Incremental updates would require tracking stale paths -- full redraw is simpler
   * and fast enough for typical pipeline sizes (< 200 edges).
   */
  _drawEdges(visibleIds, liveMode = false) {
    const grid   = document.getElementById("sct-pl-grid");
    const svg    = document.getElementById("sct-svg-overlay");
    if (!grid || !svg) return;

    // Size the SVG to cover the entire .sct-pl-grid content area so paths never clip
    const W = grid.scrollWidth;
    const H = grid.scrollHeight;
    svg.setAttribute("width",   W);
    svg.setAttribute("height",  H);
    svg.style.width  = W + "px";
    svg.style.height = H + "px";
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    
    // Clear all existing paths before redrawing
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Anchor for coordinate translation: stable grid-space coordinates
    const gRect = grid.getBoundingClientRect();

    this.edges.forEach(edge => {
      // Skip edges whose endpoints are outside the current visible filter set
      if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return;
      const se = this.cardEls[edge.source];
      const te = this.cardEls[edge.target];
      if (!se || !te) return;
      if (se.classList.contains("hide") || te.classList.contains("hide")) return;

      const sr = se.getBoundingClientRect();
      const tr = te.getBoundingClientRect();

      // Convert viewport coordinates to grid-space by subtracting grid origin
      const x1 = sr.right  - gRect.left;
      const y1 = sr.top    + sr.height / 2 - gRect.top;
      const x2 = tr.left   - gRect.left;
      const y2 = tr.top    + tr.height / 2 - gRect.top;

      const dx = Math.abs(x2 - x1) * 0.42;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d",            `M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`);
      path.setAttribute("fill",         "none");
      path.setAttribute("stroke",       this._getEdgeColor(edge));
      path.setAttribute("stroke-width", "1.5");

      const flowClass = this._getEdgeFlowClass(edge);
      path.classList.add("sct-edge");
      if (flowClass) path.classList.add(flowClass);
      if (liveMode) path.classList.add("live");
      path.dataset.source = edge.source;
      path.dataset.target = edge.target;

      path.addEventListener("mouseenter", () => {
        if (this.selectedId) return;
        document.querySelectorAll(".sct-edge").forEach(p => {
          p.classList.toggle("hl",  p === path);
          p.classList.toggle("dim", p !== path);
        });
      });
      path.addEventListener("mouseleave", () => {
        if (this.selectedId) return;
        document.querySelectorAll(".sct-edge").forEach(p => p.classList.remove("hl", "dim"));
      });

      svg.appendChild(path);
    });
  }

  /**
   * Inject in/out degree port badges (.v2-ports) onto each pipeline card.
   *
   * Port badges show the edge count for each card:
   *   "<- 2 in"  -- 2 upstream sources feed into this node
   *   "3 out ->" -- this node feeds into 3 downstream targets
   *
   * Only cards with at least one edge get ports. Cards with neither in nor out
   * degree are standalone nodes (no ports rendered).
   * Called once after layout, after _drawEdges().
   */
  _injectPorts(visibleIds) {
    const inDeg = {}, outDeg = {};
    this.edges.forEach(e => {
      if (visibleIds.has(e.source) && visibleIds.has(e.target)) {
        outDeg[e.source] = (outDeg[e.source] || 0) + 1;
        inDeg[e.target]  = (inDeg[e.target]  || 0) + 1;
      }
    });
    Object.entries(this.cardEls).forEach(([id, el]) => {
      const iIn  = inDeg[id]  || 0;
      const iOut = outDeg[id] || 0;
      if (!iIn && !iOut) return;
      // Remove stale port div from previous render if present
      el.querySelector(".v2-ports,.sct-ports")?.remove();
      const portDiv = document.createElement("div");
      portDiv.className = "v2-ports";
      portDiv.innerHTML = [
        iIn  > 0 ? `<span class="v2-port v2-port-in"><- ${iIn} in</span>`    : "",
        iOut > 0 ? `<span class="v2-port v2-port-out">${iOut} out -></span>` : "",
      ].join("");
      el.appendChild(portDiv);
    });
  }

  // ==============================================================================
  //  DETAIL PANEL
  //  A slide-in side panel (.sct-panel) that shows full document details,
  //  TOC buffer analysis, connected nodes, and quick action buttons.
  //
  //  The panel is populated purely via innerHTML; event handlers for interactive
  //  elements are wired up via data-* attributes (not inline onclick) to avoid
  //  XSS risks. Specifically:
  //    data-nav-id       -> _pipelineSelect(id)    (navigate to another node)
  //    data-route-item   -> route to Production Priority Board
  //    data-close-panel  -> close the panel
  // ==============================================================================

  /**
   * Open and populate the detail panel for a given node.
   * Also triggers an async BOM block insertion for item/output nodes.
   */
  showPanel(node) {
    if (!node) return;
    document.getElementById("sct-panel-title").textContent    = node.doc_name || node.label;
    document.getElementById("sct-panel-subtitle").textContent = node.doctype  + (node.is_overdue ? " -- ⚠ OVERDUE" : "");
    document.getElementById("sct-panel-body").innerHTML       = this._panelBody(node);
    document.getElementById("sct-panel-actions").innerHTML    = this._panelActions(node);
    document.getElementById("sct-panel").classList.add("open");

    // Wire up navigation links via data attributes (no inline onclick -> no XSS)
    document.querySelectorAll("#sct-panel-body [data-nav-id], #sct-panel-actions [data-nav-id]").forEach(el => {
      el.addEventListener("click", () => this._pipelineSelect(el.dataset.navId));
    });
    // Route to Production Priority Board report
    document.querySelectorAll("#sct-panel-actions [data-route-item]").forEach(el => {
      el.addEventListener("click", () =>
        frappe.set_route("query-report", "Production Priority Board", { item_code: el.dataset.routeItem })
      );
    });
    // Close button wired up last so it exists in the DOM
    const closeBtn = document.querySelector("#sct-panel-actions [data-close-panel]");
    if (closeBtn) closeBtn.addEventListener("click", () => { this._closePanel(); });

    // Async BOM block: only meaningful for item/output buffer nodes that have a BOM.
    // Fetched lazily with in-memory cache to avoid repeated API calls on re-open.
    if (node.stage === "items" || node.sub_type === "output") {
      this._loadBomBlock(node.item_code || node.doc_name);
    }

    // Async production block: for Work Orders -- shows what was produced (batch, stock)
    // and what materials were consumed (item, qty, batch, warehouse).
    if (node.sub_type === "wo") {
      this._loadProductionBlock(node);
    }

    // Async receipt block: for Purchase Receipts -- shows received/accepted/rejected
    // quantities per item, batch numbers, and current warehouse stock.
    if (node.sub_type === "pr") {
      this._loadReceiptBlock(node);
    }

    // Fulfillment summary: for Material Requests -- shows the full pipeline progress
    // (requested qty -> PO raised -> received) by traversing connected pipeline nodes.
    // No extra API call -- uses already-loaded nodeMap + edges.
    if (node.sub_type === "mr") {
      this._loadMRFulfillmentBlock(node);
    }
  }

  /**
   * Asynchronously fetch and insert the BOM component list into the open panel.
   *
   * Uses a two-step API call:
   *   1. frappe.client.get_list("BOM", { item, is_default:1, docstatus:1 }) -> get BOM name
   *   2. frappe.client.get_list("BOM Item", { parent: bomName }) -> get component rows
   *
   * Results are cached in this._bomCache (Map):
   *   null                 = item has no default active BOM
   *   { bomName, items[] } = BOM found with component list
   *
   * The BOM block is inserted BEFORE the first .sct-panel-section or .sct-toc-box
   * so it appears near the top of the panel body.
   */
  _loadBomBlock(item_code) {
    if (!item_code) return;

    const _insertBlock = (items, bomName) => {
      const bodyEl = document.getElementById("sct-panel-body");
      if (!bodyEl) return;
      if (bodyEl.querySelector(".sct-bom-block")) return;  // Don't duplicate
      const bomBlock = document.createElement("div");
      bomBlock.className = "sct-bom-block";
      bomBlock.innerHTML = `
        <div class="sct-bom-title">🔩 BOM -- ${frappe.utils.escape_html(bomName)}</div>
        ${items.map(i => `
          <div class="sct-bom-row">
            <span class="sct-bom-item">${frappe.utils.escape_html(i.item_code)} <small style="color:var(--stone-400)">${frappe.utils.escape_html(i.item_name || "")}</small></span>
            <span class="sct-bom-qty">${frappe.utils.escape_html(String(i.qty))} ${frappe.utils.escape_html(i.uom || "")}</span>
          </div>`).join("")}
      `;
      const firstSection = bodyEl.querySelector(".sct-panel-section, .sct-toc-box");
      if (firstSection) bodyEl.insertBefore(bomBlock, firstSection);
      else              bodyEl.appendChild(bomBlock);
    };

    // Cache lookup: avoid re-fetching for the same item
    if (this._bomCache.has(item_code)) {
      const cached = this._bomCache.get(item_code);
      if (cached) _insertBlock(cached.items, cached.bomName);
      return;
    }

    // Step 1: find the default active BOM for this item
    frappe.call({
      method: "frappe.client.get_list",
      args: {
        doctype: "BOM",
        filters: { item: item_code, is_default: 1, docstatus: 1 },
        fields: ["name"],
        limit_page_length: 1,
      },
      callback: (r) => {
        if (!r.message || !r.message.length) {
          this._bomCache.set(item_code, null);  // No BOM -- cache the miss
          return;
        }
        const bomName = r.message[0].name;
        // Step 2: fetch BOM component rows
        frappe.call({
          method: "frappe.client.get_list",
          args: {
            doctype: "BOM Item",
            filters: { parent: bomName },
            fields: ["item_code","item_name","qty","uom"],
            limit_page_length: 20,
          },
          callback: (r2) => {
            if (!r2.message || !r2.message.length) {
              this._bomCache.set(item_code, null);
              return;
            }
            this._bomCache.set(item_code, { bomName, items: r2.message });
            _insertBlock(r2.message, bomName);
          },
        });
      },
    });
  }

  // ==============================================================================
  //  ASYNC DETAIL BLOCKS -- Production, Purchase Receipt, MR Fulfillment
  //  Each method inserts a rich HTML section into #sct-panel-body after the
  //  synchronous panel content is already visible. They follow the same
  //  pattern as _loadBomBlock: check for existing block -> API fetch -> insert.
  // ==============================================================================

  /**
   * Load production detail block for a Work Order panel.
   *
   * Two-section block:
   *   📦 Production Output
   *     One row per FG/SFG item produced (t_warehouse items in Manufacture SEs).
   *     Shows: item code, qty produced, batch number, warehouse, current stock.
   *
   *   🔩 Materials Consumed
   *     One row per component consumed (s_warehouse items in Manufacture SEs).
   *     Shows: item code, qty consumed, batch number, source warehouse.
   *
   * Queries:
   *   1. Stock Entry (type=Manufacture, work_order=WO name, docstatus=1)
   *   2. Stock Entry Detail (parent = each SE name)
   *   3. Bin (item_code, warehouse) for current stock of produced items
   */
  _loadProductionBlock(node) {
    const bodyEl = document.getElementById("sct-panel-body");
    if (!bodyEl || bodyEl.querySelector(".sct-prod-block")) return;

    // Insert a placeholder while loading
    const placeholder = document.createElement("div");
    placeholder.className = "sct-prod-block sct-detail-loading";
    placeholder.innerHTML = `<div class="sct-detail-loading-txt">⏳ Loading production details...</div>`;
    bodyEl.appendChild(placeholder);

    // Step 1: find all submitted Manufacture Stock Entries for this WO
    frappe.call({
      method: "frappe.client.get_list",
      args: {
        doctype: "Stock Entry",
        filters: { work_order: node.doc_name, stock_entry_type: "Manufacture", docstatus: 1 },
        fields: ["name", "posting_date", "posting_time"],
        limit_page_length: 20,
        order_by: "posting_date asc",
      },
      callback: (r) => {
        if (!r.message || !r.message.length) {
          placeholder.innerHTML = `<div class="sct-detail-empty">No submitted Stock Entries found for this Work Order yet.</div>`;
          return;
        }
        const seNames = r.message.map(s => s.name);

        // Step 2: fetch all SE Detail rows for all linked SEs in one call
        frappe.call({
          method: "frappe.client.get_list",
          args: {
            doctype: "Stock Entry Detail",
            filters: [["parent", "in", seNames]],
            fields: ["parent", "item_code", "item_name", "qty", "transfer_qty",
                     "uom", "stock_uom", "batch_no", "s_warehouse", "t_warehouse",
                     "basic_rate", "basic_amount"],
            limit_page_length: 200,
            order_by: "parent asc, idx asc",
          },
          callback: (r2) => {
            if (!r2.message) { placeholder.remove(); return; }

            // Separate items into produced (t_warehouse set, no s_warehouse)
            // and consumed (s_warehouse set)
            const produced  = r2.message.filter(i => i.t_warehouse && !i.s_warehouse);
            const consumed  = r2.message.filter(i => i.s_warehouse);

            const fmtQty = (q, u) => `${(+q || 0).toLocaleString("en-IN", {maximumFractionDigits: 3})} ${u || ""}`;
            const esc    = v => frappe.utils.escape_html(String(v || ""));

            // -- Produced section -----------------------------------------------
            let producedHtml = "";
            if (produced.length) {
              producedHtml = produced.map(i => `
                <div class="sct-prod-row sct-prod-out">
                  <div class="sct-prod-row-item">
                    <span class="sct-prod-item-code">${esc(i.item_code)}</span>
                    <span class="sct-prod-item-name">${esc(i.item_name)}</span>
                  </div>
                  <div class="sct-prod-row-meta">
                    <span class="sct-prod-qty ok">^ ${fmtQty(i.qty, i.uom)}</span>
                    ${i.batch_no ? `<span class="sct-prod-batch">Batch: <strong>${esc(i.batch_no)}</strong></span>` : ""}
                    ${i.t_warehouse ? `<span class="sct-prod-wh">-> ${esc(i.t_warehouse)}</span>` : ""}
                  </div>
                </div>`).join("");
            } else {
              producedHtml = `<div class="sct-detail-empty" style="margin:4px 0">No output entries yet</div>`;
            }

            // -- Consumed section -----------------------------------------------
            let consumedHtml = "";
            if (consumed.length) {
              consumedHtml = consumed.map(i => `
                <div class="sct-prod-row sct-prod-in">
                  <div class="sct-prod-row-item">
                    <span class="sct-prod-item-code">${esc(i.item_code)}</span>
                    <span class="sct-prod-item-name">${esc(i.item_name)}</span>
                  </div>
                  <div class="sct-prod-row-meta">
                    <span class="sct-prod-qty used">v ${fmtQty(i.qty, i.uom)}</span>
                    ${i.batch_no ? `<span class="sct-prod-batch">Batch: <strong>${esc(i.batch_no)}</strong></span>` : ""}
                    ${i.s_warehouse ? `<span class="sct-prod-wh"><- ${esc(i.s_warehouse)}</span>` : ""}
                  </div>
                </div>`).join("");
            } else {
              consumedHtml = `<div class="sct-detail-empty" style="margin:4px 0">No consumption entries yet</div>`;
            }

            placeholder.outerHTML = `
              <div class="sct-prod-block">
                <div class="sct-detail-block-title">📦 Production Output
                  <span class="sct-detail-block-sub">${seNames.length} Stock Entr${seNames.length > 1 ? "ies" : "y"}</span>
                </div>
                ${producedHtml}
                <div class="sct-detail-block-title" style="margin-top:10px">🔩 Materials Consumed</div>
                ${consumedHtml}
              </div>`;

            // Step 3: fetch current stock (Bin) for each produced item/warehouse
            produced.forEach(i => {
              if (!i.t_warehouse) return;
              frappe.call({
                method: "frappe.client.get_value",
                args: {
                  doctype: "Bin",
                  filters: { item_code: i.item_code, warehouse: i.t_warehouse },
                  fieldname: "actual_qty",
                },
                callback: (rb) => {
                  const qty = rb.message?.actual_qty ?? null;
                  if (qty === null) return;
                  // Find and update the matching produced row
                  document.querySelectorAll(".sct-prod-out").forEach(row => {
                    if (row.querySelector(".sct-prod-item-code")?.textContent === i.item_code) {
                      const meta = row.querySelector(".sct-prod-row-meta");
                      if (meta && !meta.querySelector(".sct-prod-stock")) {
                        const chip = document.createElement("span");
                        chip.className = "sct-prod-stock";
                        chip.innerHTML = `Stock: <strong>${(+qty).toLocaleString("en-IN", {maximumFractionDigits: 2})} ${i.uom}</strong>`;
                        meta.appendChild(chip);
                      }
                    }
                  });
                },
              });
            });
          },
        });
      },
    });
  }

  /**
   * Load purchase receipt detail block for a Purchase Receipt panel.
   *
   * One card per line item showing:
   *   Item code / name, received qty, accepted qty, rejected qty,
   *   batch number, warehouse, and current warehouse stock (from Bin).
   *
   * Queries:
   *   1. Purchase Receipt Item (parent = PR name)
   *   2. Bin (item_code, warehouse) per line item for current stock
   */
  _loadReceiptBlock(node) {
    const bodyEl = document.getElementById("sct-panel-body");
    if (!bodyEl || bodyEl.querySelector(".sct-recv-block")) return;

    const placeholder = document.createElement("div");
    placeholder.className = "sct-recv-block sct-detail-loading";
    placeholder.innerHTML = `<div class="sct-detail-loading-txt">⏳ Loading receipt details...</div>`;
    bodyEl.appendChild(placeholder);

    // Step 1: fetch all line items from this Purchase Receipt
    frappe.call({
      method: "frappe.client.get_list",
      args: {
        doctype: "Purchase Receipt Item",
        filters: { parent: node.doc_name },
        fields: ["item_code", "item_name", "qty", "received_qty",
                 "rejected_qty", "accepted_qty", "batch_no",
                 "warehouse", "uom", "rate", "amount",
                 "purchase_order", "material_request"],
        limit_page_length: 50,
        order_by: "idx asc",
      },
      callback: (r) => {
        if (!r.message || !r.message.length) {
          placeholder.innerHTML = `<div class="sct-detail-empty">No line items found.</div>`;
          return;
        }

        const esc    = v => frappe.utils.escape_html(String(v || ""));
        const fmtQty = (q, u) => `${(+q || 0).toLocaleString("en-IN", {maximumFractionDigits: 3})} ${u || ""}`;
        const fmtMon = v => v > 0 ? `₹ ${(+v).toLocaleString("en-IN", {minimumFractionDigits: 2})}` : "";

        const rows = r.message.map(i => {
          const accepted = i.accepted_qty > 0 ? i.accepted_qty : (i.received_qty - (i.rejected_qty || 0));
          const hasRej   = (i.rejected_qty || 0) > 0;
          return `
            <div class="sct-recv-row" data-item="${esc(i.item_code)}" data-wh="${esc(i.warehouse)}">
              <div class="sct-recv-row-item">
                <span class="sct-prod-item-code">${esc(i.item_code)}</span>
                <span class="sct-prod-item-name">${esc(i.item_name)}</span>
              </div>
              <div class="sct-recv-row-grid">
                <div class="sct-recv-cell">
                  <span class="sct-recv-lbl">Received</span>
                  <span class="sct-recv-val">${fmtQty(i.received_qty || i.qty, i.uom)}</span>
                </div>
                <div class="sct-recv-cell">
                  <span class="sct-recv-lbl">Accepted</span>
                  <span class="sct-recv-val ok">${fmtQty(accepted, i.uom)}</span>
                </div>
                ${hasRej ? `
                <div class="sct-recv-cell">
                  <span class="sct-recv-lbl">Rejected</span>
                  <span class="sct-recv-val err">${fmtQty(i.rejected_qty, i.uom)}</span>
                </div>` : ""}
                <div class="sct-recv-cell">
                  <span class="sct-recv-lbl">Rate</span>
                  <span class="sct-recv-val">${fmtMon(i.rate)}</span>
                </div>
              </div>
              <div class="sct-recv-row-meta">
                ${i.batch_no ? `<span class="sct-prod-batch">Batch: <strong>${esc(i.batch_no)}</strong></span>` : `<span class="sct-prod-batch" style="color:var(--stone-400)">No batch</span>`}
                ${i.warehouse ? `<span class="sct-prod-wh">-> ${esc(i.warehouse)}</span>` : ""}
                <span class="sct-recv-stock" data-item="${esc(i.item_code)}" data-wh="${esc(i.warehouse)}">...</span>
              </div>
              ${i.material_request ? `<div style="font-size:9px;color:var(--stone-400);margin-top:2px">From MR: ${esc(i.material_request)}</div>` : ""}
            </div>`;
        }).join("");

        placeholder.outerHTML = `
          <div class="sct-recv-block">
            <div class="sct-detail-block-title">📬 Receipt Line Items</div>
            ${rows}
          </div>`;

        // Step 2: fetch current Bin stock for each item/warehouse and inject inline
        r.message.forEach(i => {
          if (!i.warehouse) return;
          frappe.call({
            method: "frappe.client.get_value",
            args: {
              doctype: "Bin",
              filters: { item_code: i.item_code, warehouse: i.warehouse },
              fieldname: "actual_qty",
            },
            callback: (rb) => {
              const qty = rb.message?.actual_qty;
              if (qty === undefined || qty === null) return;
              // Update the stock chip for this item in the rendered block
              document.querySelectorAll(`.sct-recv-stock[data-item="${CSS.escape(i.item_code)}"][data-wh="${CSS.escape(i.warehouse)}"]`).forEach(el => {
                el.innerHTML = `Current Stock: <strong>${(+qty).toLocaleString("en-IN", {maximumFractionDigits: 2})} ${i.uom}</strong>`;
                el.classList.add(qty > 0 ? "ok" : "err");
              });
            },
          });
        });
      },
    });
  }

  /**
   * Build the MR fulfillment summary block entirely from already-loaded data.
   * No API call -- traverses this.edges and this.nodeMap to find downstream nodes.
   *
   * Shows:
   *   Requested Qty  -- from node.required_qty
   *   PO Raised      -- total qty across downstream PO nodes
   *   Received       -- total received_qty across downstream PR nodes
   *   WO Raised      -- total qty across downstream WO nodes (manufacture MRs)
   *   Produced       -- total produced_qty across downstream WO nodes
   *
   * Progress bar shows: received/ordered percentage.
   */
  _loadMRFulfillmentBlock(node) {
    const bodyEl = document.getElementById("sct-panel-body");
    if (!bodyEl || bodyEl.querySelector(".sct-fulfill-block")) return;

    // BFS forward from this MR to collect all downstream nodes
    const fwd = {};
    this.edges.forEach(e => (fwd[e.source] = fwd[e.source] || []).push(e.target));
    const visited = new Set();
    const q = [node.id];
    while (q.length) {
      const cur = q.shift();
      (fwd[cur] || []).forEach(nb => { if (!visited.has(nb)) { visited.add(nb); q.push(nb); } });
    }
    visited.delete(node.id);  // exclude the MR itself

    // Collect downstream nodes by type
    const downstream = [...visited].map(id => this.nodeMap[id]).filter(Boolean);
    const pos  = downstream.filter(n => n.sub_type === "po");
    const prs  = downstream.filter(n => n.sub_type === "pr");
    const wos  = downstream.filter(n => n.sub_type === "wo");
    const jcs  = downstream.filter(n => n.sub_type === "jc");
    const rfqs = downstream.filter(n => n.sub_type === "rfq");
    const sqs  = downstream.filter(n => n.sub_type === "sq");

    const sum  = (arr, field) => arr.reduce((a, n) => a + (+n[field] || 0), 0);
    const fmt  = (q, u) => `${(+q || 0).toLocaleString("en-IN", {maximumFractionDigits: 2})} ${u || ""}`;
    const esc  = v => frappe.utils.escape_html(String(v || "--"));

    const reqQty  = node.required_qty || node.qty || 0;
    const uom     = node.uom || "";
    const isPurch = (node.mr_type || "").toLowerCase().includes("purchase");

    // -- Build fulfillment row data ---------------------------------------------
    const steps = [];

    steps.push({
      icon: "📋", label: "Requested",
      val: fmt(reqQty, uom), sub: node.required_date ? `Required by ${node.required_date}` : "",
      cls: "step-req",
    });

    if (isPurch) {
      // Purchase path: MR -> RFQ -> SQ -> PO -> PR
      if (rfqs.length) {
        steps.push({ icon: "🔍", label: "RFQ Raised",
          val: `${rfqs.length} RFQ${rfqs.length > 1 ? "s" : ""}`,
          sub: rfqs.map(n => esc(n.doc_name)).join(", "),
          cls: "step-rfq" });
      }
      if (sqs.length) {
        const sqTotal = sum(sqs, "grand_total");
        steps.push({ icon: "💬", label: "Supplier Quotes",
          val: `${sqs.length} SQ${sqs.length > 1 ? "s" : ""}`,
          sub: sqTotal > 0 ? `Total: ₹${sqTotal.toLocaleString("en-IN", {minimumFractionDigits: 2})}` : "",
          cls: "step-sq" });
      }
      if (pos.length) {
        const poQty = sum(pos, "qty");
        const poTot = sum(pos, "grand_total");
        steps.push({ icon: "🛒", label: "PO Raised",
          val: fmt(poQty, uom),
          sub: `${pos.length} PO${pos.length > 1 ? "s" : ""}${poTot > 0 ? " · ₹" + poTot.toLocaleString("en-IN") : ""}`,
          cls: poQty >= reqQty ? "step-ok" : "step-partial" });
      } else if (reqQty > 0) {
        steps.push({ icon: "⏳", label: "PO Raised", val: "--", sub: "No PO yet", cls: "step-missing" });
      }
      if (prs.length) {
        const recvQty = sum(prs, "qty") || sum(prs, "received_qty");
        const rejQty  = sum(prs, "rejected_qty");
        steps.push({ icon: "📦", label: "Received",
          val: fmt(recvQty, uom),
          sub: rejQty > 0 ? `${fmt(rejQty, uom)} rejected` : `${prs.length} receipt${prs.length > 1 ? "s" : ""}`,
          cls: recvQty >= reqQty ? "step-ok" : recvQty > 0 ? "step-partial" : "step-missing" });
      } else if (pos.length) {
        steps.push({ icon: "⏳", label: "Received", val: "--", sub: "Awaiting delivery", cls: "step-missing" });
      }
    } else {
      // Manufacture path: MR -> PP -> WO -> JC -> SE
      const pps = downstream.filter(n => n.sub_type === "pp");
      if (pps.length) {
        steps.push({ icon: "📅", label: "Prod. Plan",
          val: `${pps.length} plan${pps.length > 1 ? "s" : ""}`,
          sub: pps.map(n => esc(n.doc_name)).join(", "),
          cls: "step-rfq" });
      }
      if (wos.length) {
        const woQty   = sum(wos, "qty");
        const prodQty = sum(wos, "produced_qty");
        steps.push({ icon: "⚙", label: "Work Order",
          val: fmt(woQty, uom),
          sub: `${wos.length} WO${wos.length > 1 ? "s" : ""}`,
          cls: woQty >= reqQty ? "step-ok" : "step-partial" });
        if (prodQty > 0) {
          steps.push({ icon: "🏭", label: "Produced",
            val: fmt(prodQty, uom),
            sub: `${Math.round(prodQty / (woQty || 1) * 100)}% complete`,
            cls: prodQty >= woQty ? "step-ok" : "step-partial" });
        }
      } else if (reqQty > 0) {
        steps.push({ icon: "⏳", label: "Work Order", val: "--", sub: "No WO yet", cls: "step-missing" });
      }
      if (jcs.length) {
        steps.push({ icon: "🔧", label: "Job Cards",
          val: `${jcs.length} JC${jcs.length > 1 ? "s" : ""}`,
          sub: `${jcs.filter(n => n.status === "Completed").length} completed`,
          cls: "step-sq" });
      }
    }

    // -- Progress bar -----------------------------------------------------------
    const lastStep  = steps[steps.length - 1];
    const isOk      = lastStep?.cls === "step-ok";
    const isPartial = lastStep?.cls === "step-partial";
    const pct       = isOk ? 100 : isPartial ? 50 : 10;
    const barColor  = isOk ? "#16a34a" : isPartial ? "#d97706" : "#dc2626";

    const stepsHtml = steps.map(s => `
      <div class="sct-fulfill-step ${s.cls}">
        <div class="sct-fulfill-step-icon">${s.icon}</div>
        <div class="sct-fulfill-step-body">
          <div class="sct-fulfill-step-label">${s.label}</div>
          <div class="sct-fulfill-step-val">${s.val}</div>
          ${s.sub ? `<div class="sct-fulfill-step-sub">${s.sub}</div>` : ""}
        </div>
      </div>`).join('<div class="sct-fulfill-arrow">-></div>');

    const block = document.createElement("div");
    block.className = "sct-fulfill-block";
    block.innerHTML = `
      <div class="sct-detail-block-title">📊 MR Fulfillment Progress</div>
      <div style="height:4px;background:var(--stone-100);border-radius:99px;overflow:hidden;margin-bottom:10px">
        <div style="width:${pct}%;height:100%;background:${barColor};border-radius:99px;transition:width 0.4s ease"></div>
      </div>
      <div class="sct-fulfill-steps">${stepsHtml}</div>
    `;
    bodyEl.appendChild(block);
  }

  /**
   * Close the detail panel.
   * Also clears any active pipeline selection so the edge state stays consistent.
   */
  _closePanel() {
    this._clearSelection();
    document.getElementById("sct-panel").classList.remove("open");
  }

  /**
   * Build the HTML string for the detail panel body.
   *
   * Sections (in render order):
   *   1. Next action box          -- urgent styling for Red/Black zone or ⚠ prefix
   *   2. Non-TOC notice           -- shown when item exists but TOC not configured
   *   3. TOC buffer status        -- F3 BP% formula breakdown, visual bar
   *   4. Timeline                 -- days open, overdue days, creation date
   *   5. Document details         -- per-doctype key fields from _panelFields()
   *   6. Connected documents      -- pipeline view: p-link clickable cards
   *                                tracker view: simple rows with nav-id
   *   7. Chain stats              -- pipeline view only: total chain size, ancestors, descendants
   */
  _panelBody(node) {
    const parts = [];

    // -- Next action ------------------------------------------------------------
    if (node.next_action) {
      const isUrgent = node.next_action.startsWith("⚠") || node.zone === "Red" || node.zone === "Black";
      parts.push(`
        <div class="sct-next-action-box${isUrgent ? " urgent" : ""}">
          <div class="sct-next-action-box-title">⬆ NEXT ACTION</div>
          <div class="sct-next-action-box-text">${node.next_action}</div>
        </div>`);
    }

    // -- Non-TOC notice ---------------------------------------------------------
    if ((node.stage === "items" || node.stage === "output") && !node.toc_enabled) {
      parts.push(`
        <div class="sct-toc-box" style="border-color:#d1d5db;background:#f9fafb">
          <div class="sct-toc-box-title" style="color:#6b7280">ℹ TOC Buffer Not Configured</div>
          <div style="font-size:11px;color:#9ca3af;margin-top:4px">
            This item is tracked from live transactions but is not yet managed
            under TOC buffer rules. Enable TOC on the Item master to see buffer
            zone, BP%, and automated replenishment triggers.
          </div>
        </div>`);
    }

    // -- TOC buffer status (F3 formula breakdown) -------------------------------
    if (node.zone) {
      const bp   = node.bp_pct ?? 0;
      const fill = Math.min(bp, 100);
      parts.push(`
        <div class="sct-toc-box">
          <div class="sct-toc-box-title">🔁 TOC Buffer Status</div>
          <div class="sct-toc-box-row"><span>Zone</span>${this._zoneBadge(node.zone)}</div>
          <div class="sct-toc-box-row"><span>BP%</span><strong>${bp}%</strong></div>
          ${node.target_buffer !== undefined
            ? `<div class="sct-toc-box-row"><span>Target (F1)</span><strong>${node.target_buffer}</strong></div>` : ""}
          ${node.inventory_position !== undefined
            ? `<div class="sct-toc-box-row"><span>Inv. Position (F2)</span><strong>${node.inventory_position}</strong></div>` : ""}
          ${node.on_hand !== undefined
            ? `<div class="sct-toc-box-row"><span>On-Hand</span><strong>${node.on_hand}</strong></div>` : ""}
          ${node.order_qty > 0
            ? `<div class="sct-toc-box-row"><span>Order Qty (F4)</span><strong style="color:#dc2626">${node.order_qty}</strong></div>` : ""}
          <div class="sct-toc-formula">
            F3: BP% = (Target - IP) / Target x 100<br>
            = (${node.target_buffer} - ${node.inventory_position}) / ${node.target_buffer} x 100
          </div>
          <div style="height:5px;background:var(--stone-100);border-radius:99px;overflow:hidden;margin-top:8px">
            <div style="width:${fill}%;height:100%;background:${this._zoneBarColor(node.zone)};border-radius:99px"></div>
          </div>
        </div>`);
    }

    // -- Timeline ---------------------------------------------------------------
    if (node.days_open > 0) {
      parts.push(`
        <div class="sct-panel-section">
          <div class="sct-panel-section-title">Timeline</div>
          <div class="sct-panel-row">
            <span class="sct-panel-row-key">Open for</span>
            <span class="sct-panel-row-val">${node.days_open} day${node.days_open !== 1 ? "s" : ""}</span>
          </div>
          ${node.is_overdue ? `
            <div class="sct-panel-row">
              <span class="sct-panel-row-key" style="color:#b91c1c">Overdue by</span>
              <span class="sct-panel-row-val" style="color:#b91c1c">⚠ ${node.days_overdue} day${node.days_overdue !== 1 ? "s" : ""}</span>
            </div>` : ""}
          ${node.creation_date
            ? `<div class="sct-panel-row"><span class="sct-panel-row-key">Created</span>
               <span class="sct-panel-row-val">${node.creation_date || node.transaction_date || ""}</span></div>` : ""}
        </div>`);
    }

    // -- Document fields (per-doctype key-value pairs) --------------------------
    const fields = this._panelFields(node);
    if (fields.length) {
      parts.push(`
        <div class="sct-panel-section">
          <div class="sct-panel-section-title">Document Details</div>
          ${fields.map(([k, v]) => v !== "" && v !== undefined && v !== null
            ? `<div class="sct-panel-row">
                <span class="sct-panel-row-key">${k}</span>
                <span class="sct-panel-row-val">${v}</span>
               </div>` : "").join("")}
        </div>`);
    }

    // -- Connected documents (direct neighbours only, not full lineage) ---------
    const connected = this._connected(node.id);
    if (connected.upstream.length || connected.downstream.length) {
      if (this.viewMode === "pipeline") {
        // Pipeline mode: clickable .sct-p-link cards that navigate to each node
        parts.push(`
          <div class="sct-panel-section">
            <div class="sct-panel-section-title">↑ Previous Steps (Inputs)</div>
            ${connected.upstream.length ? connected.upstream.map(n => `
              <div class="sct-p-link" data-nav-id="${frappe.utils.escape_html(n.id)}">
                <span class="sct-p-link-name">${frappe.utils.escape_html(n.label || n.doc_name)}</span>
                <span class="sct-p-link-ref">${frappe.utils.escape_html(n.doctype || "")}</span>
              </div>`).join("") :
              `<div style="font-size:11px;color:var(--stone-400);font-style:italic;padding:2px 0">Origin -- no prior steps</div>`}
          </div>
          <div class="sct-panel-section">
            <div class="sct-panel-section-title">↓ Next Steps (Outputs)</div>
            ${connected.downstream.length ? connected.downstream.map(n => `
              <div class="sct-p-link" data-nav-id="${frappe.utils.escape_html(n.id)}">
                <span class="sct-p-link-name">${frappe.utils.escape_html(n.label || n.doc_name)}</span>
                <span class="sct-p-link-ref">${frappe.utils.escape_html(n.doctype || "")}</span>
              </div>`).join("") :
              `<div style="font-size:11px;color:var(--stone-400);font-style:italic;padding:2px 0">Terminal -- pipeline end</div>`}
          </div>`);

        // Chain summary stats (uses _chainCounts for full BFS count, not just direct neighbours)
        const counts = this._chainCounts(node.id);
        const total  = counts.upstream + counts.downstream + 1;
        parts.push(`
          <div class="sct-panel-section">
            <div class="sct-panel-section-title">Multi-Node Path Summary</div>
            <div class="sct-panel-row">
              <span class="sct-panel-row-key">Total Chain Size</span>
              <span class="sct-panel-row-val sct-chain-stat">${total} nodes</span>
            </div>
            <div class="sct-panel-row">
              <span class="sct-panel-row-key">Ancestors</span>
              <span class="sct-panel-row-val sct-chain-stat">${counts.upstream} upstream</span>
            </div>
            <div class="sct-panel-row">
              <span class="sct-panel-row-key">Descendants</span>
              <span class="sct-panel-row-val sct-chain-stat">${counts.downstream} downstream</span>
            </div>
          </div>`);
      } else {
        // Tracker mode: simple key-value rows (pipeline selection not available here)
        parts.push(`
          <div class="sct-panel-section">
            <div class="sct-panel-section-title">Connected Documents</div>
            ${connected.upstream.map(n => `
              <div class="sct-panel-row" style="cursor:pointer" data-nav-id="${frappe.utils.escape_html(n.id)}">
                <span class="sct-panel-row-key" style="color:#34d399"><- From</span>
                <span class="sct-panel-row-val">${frappe.utils.escape_html(n.doc_name)} <small style="color:var(--stone-400)">(${frappe.utils.escape_html(n.doctype)})</small></span>
              </div>`).join("")}
            ${connected.downstream.map(n => `
              <div class="sct-panel-row" style="cursor:pointer" data-nav-id="${frappe.utils.escape_html(n.id)}">
                <span class="sct-panel-row-key" style="color:#f59e0b">-> To</span>
                <span class="sct-panel-row-val">${frappe.utils.escape_html(n.doc_name)} <small style="color:var(--stone-400)">(${frappe.utils.escape_html(n.doctype)})</small></span>
              </div>`).join("")}
          </div>`);
      }
    }

    return parts.join("") || `<p style="color:var(--stone-400);font-size:12px">No details available.</p>`;
  }

  /**
   * Build the quick-action button bar at the bottom of the detail panel.
   *
   * Buttons generated based on node type:
   *   All doc nodes      -> "Open in ERPNext" (deep link to the actual document)
   *   Item/output nodes  -> "Priority Board" (routes to Production Priority Board report)
   *                        "Item Master" (direct link to Item form)
   *   WO / JC nodes      -> "Work Order List" shortcut
   *   PO / PR nodes      -> "Purchase Order List" shortcut
   *   All nodes          -> "Close" button (always last)
   */
  _panelActions(node) {
    const actions = [];
    if (node.doctype && node.doc_name && node.stage !== "output") {
      // Build Frappe URL: /app/purchase-order/PO-0001  (frappe.router.slug slugifies the doctype)
      const url = `/app/${frappe.router.slug(node.doctype)}/${encodeURIComponent(node.doc_name)}`;
      actions.push(`<a href="${url}" target="_blank" class="sct-panel-btn sct-panel-btn-brand">↗ Open in ERPNext</a>`);
    }
    if (node.stage === "items" || node.stage === "output") {
      actions.push(`
        <span class="sct-panel-btn sct-panel-btn-default" data-route-item="${frappe.utils.escape_html(node.doc_name)}">
          📊 Priority Board
        </span>`);
      actions.push(`<a href="/app/item/${encodeURIComponent(node.doc_name)}" target="_blank" class="sct-panel-btn sct-panel-btn-default">📦 Item Master</a>`);
    }
    if (node.sub_type === "wo" || node.sub_type === "jc") {
      actions.push(`<a href="/app/work-order" target="_blank" class="sct-panel-btn sct-panel-btn-default">🏭 Work Order List</a>`);
    }
    if (node.sub_type === "po" || node.sub_type === "pr") {
      actions.push(`<a href="/app/purchase-order" target="_blank" class="sct-panel-btn sct-panel-btn-default">🛒 Purchase Order List</a>`);
    }
    // Always add a close button at the bottom of the actions bar
    actions.push(`<span class="sct-panel-btn sct-panel-btn-primary" data-close-panel>✕ Close</span>`);
    return actions.join("") || `<span style="font-size:12px;color:var(--stone-400)">No quick actions</span>`;
  }

  /**
   * Build the flat array of [label, value] pairs for the "Document Details" section.
   * Switch on sub_type (or stage for item/output nodes) to show only relevant fields.
   * Fields with empty/null/zero values are excluded via the `add` helper guard.
   */
  _panelFields(node) {
    const f = [];
    const add = (k, v) => { if (v !== "" && v !== null && v !== undefined && v !== 0) f.push([k, v]); };
    const fmt = v => v > 0 ? `₹ ${Number(v).toLocaleString("en-IN", {minimumFractionDigits: 2})}` : "";

    switch (node.sub_type || node.stage) {
      case "mr":
        add("MR Type",     node.mr_type);
        add("Status",      node.status);
        add("Required By", node.required_date);
        add("Item Code",   node.item_code);
        add("Warehouse",   node.warehouse);
        add("Required Qty",node.required_qty);
        add("Recorded By", node.recorded_by || "Manual");
        break;
      case "rfq":
        add("Suppliers",  node.description);
        add("Status",     node.status);
        add("Qty",        node.qty);
        add("Date",       node.transaction_date);
        add("From MR",    node.mr_ref);
        add("Item Code",  node.item_code);
        break;
      case "pp":
        add("Status",      node.status);
        add("Planned Qty", node.planned_qty);
        add("Date",        node.posting_date);
        add("From MR",     node.mr_ref);
        add("Item Code",   node.item_code);
        break;
      case "sq":
        add("Supplier",    node.supplier);
        add("Status",      node.status);
        add("Qty",         node.qty);
        add("Rate",        fmt(node.rate));
        add("Grand Total", fmt(node.grand_total));
        add("Date",        node.transaction_date);
        add("From RFQ",    node.rfq_ref);
        add("Item Code",   node.item_code);
        break;
      case "wo":
        add("Item",            node.item_code);
        add("Status",          node.status);
        add("Planned Qty",     node.qty);
        add("Produced Qty",    node.produced_qty);
        add("Progress",        `${node.progress_pct}%`);
        add("Start Date",      node.planned_start_date);
        add("End Date",        node.planned_end_date);
        add("Actual Start",    node.actual_start_date);
        add("Production Plan", node.pp_ref);
        break;
      case "po":
        add("Supplier",    node.supplier);
        add("Status",      node.status);
        add("Item",        node.item_code);
        add("Qty",         node.qty);
        add("Received",    node.received_qty);
        add("Rate",        fmt(node.rate));
        add("Amount",      fmt(node.amount));
        add("Grand Total", fmt(node.grand_total));
        add("Expected",    node.expected_delivery);
        add("From SQ",     node.sq_ref);
        break;
      case "jc":
        add("Operation",   node.operation || node.description);
        add("Status",      node.status);
        add("Item",        node.item_code);
        add("For Qty",     node.for_quantity);
        add("Completed",   node.completed_qty);
        add("Progress",    `${node.progress_pct}%`);
        add("Expected End",node.expected_end_date);
        add("Actual Start",node.actual_start_date);
        add("Work Order",  node.wo_ref);
        break;
      case "pr":
        add("Supplier",       node.supplier);
        add("Status",         node.status);
        add("Item",           node.item_code);
        add("Received",       node.qty);
        add("Accepted",       node.received_qty);
        add("Rejected",       node.rejected_qty > 0 ? node.rejected_qty : "");
        add("Date",           node.posting_date);
        add("Purchase Order", node.po_ref);
        break;
      case "qi":
        add("Inspection Type", node.description);
        add("Status",          node.status);
        add("Item",            node.item_code);
        add("Receipt",         node.pr_ref);
        break;
      case "se":
        add("Entry Type", node.description);
        add("Status",     node.status);
        add("Item",       node.item_code);
        add("Produced",   node.produced_qty);
        add("Date",       node.posting_date);
        add("Work Order", node.wo_ref);
        break;
      case "output":
      case "items":
        add("Buffer Type", node.buffer_type);
        add("Item Group",  node.item_group);
        add("Warehouse",   node.warehouse);
        if (node.toc_enabled) {
          add("On-Hand",      node.on_hand);
          add("Target (F1)",  node.target_buffer);
          add("IP (F2)",      node.inventory_position);
          add("Deficit (F4)", node.order_qty > 0 ? node.order_qty : "");
        }
        break;
    }
    return f;
  }

  /**
   * Return the direct neighbours (depth-1) of a node in the edge graph.
   * Used by the panel to show "Previous Steps" and "Next Steps".
   *
   * For the full lineage (all depths), use _applyLineageHighlight()'s BFS instead.
   */
  _connected(id) {
    const upstream = [], downstream = [];
    this.edges.forEach(e => {
      if (e.target === id && this.nodeMap[e.source]) upstream.push(this.nodeMap[e.source]);
      if (e.source === id && this.nodeMap[e.target]) downstream.push(this.nodeMap[e.target]);
    });
    return { upstream, downstream };
  }

  // ==============================================================================
  //  CLIENT-SIDE FILTERS
  //  Applied to the already-loaded nodes/tracks arrays without a server round-trip.
  //  Returns { visibleNodes, visibleTracks } for the active view to render.
  // ==============================================================================

  /**
   * Apply all active client-side filters and return the sets of visible records.
   *
   * Filter logic:
   *   search   -- substring match across item code, name, doc names, supplier
   *   zone     -- for tracks: match track.zone; for nodes: match item-stage zone,
   *              then BFS-expand to include all reachable nodes in the edge graph
   *   doctype  -- filter nodes by ERPNext doctype (uses docTypeMap abbreviation -> full name)
   *   overdue  -- tracks: track.overdue_count > 0; nodes: node.is_overdue (items excluded)
   *   auto     -- tracks: has at least one "By System" doc; nodes: recorded_by === "By System"
   *   noaction -- tracks: no open MR for this item (items that need attention but have no trigger)
   *
   * NOTE: Zone filter on the pipeline view uses BFS propagation (_reachable) to
   *       include the full document chain of zone-matching items, not just the items
   *       themselves. This ensures the pipeline shows complete supply chains.
   */
  _applyClientFilters() {
    const q          = this.f.search.toLowerCase().trim();
    const fZone      = this.f.zone;
    const fDoctype   = this.f.doctype;
    const fOverdue   = this.f.overdue;
    const fAuto      = this.f.auto;
    const fNoaction  = this.f.noaction;
    const fItemGroup = (this.f.item_group || "").toLowerCase().trim();

    // Map filter-panel abbreviations to full ERPNext doctype names
    const docTypeMap = {
      "MR": "Material Request", "RFQ": "Request for Quotation",
      "SQ": "Supplier Quotation", "PP": "Production Plan",
      "WO": "Work Order", "PO": "Purchase Order", "JC": "Job Card",
      "PR": "Purchase Receipt", "SE": "Stock Entry",
    };
    const allowedDoctype = fDoctype !== "All" ? docTypeMap[fDoctype] : null;

    // -- Filter tracks for the Tracker view ----------------------------------
    let visibleTracks = this.tracks.filter(track => {
      if (fZone !== "All" && track.zone !== fZone) return false;
      if (fOverdue && track.overdue_count === 0) return false;
      // item_group: client-side substring match against the track's item group
      if (fItemGroup && !(track.item_group || "").toLowerCase().includes(fItemGroup)) return false;
      // noaction: exclude items that have an open (non-closed) MR -- keep items with NO open MR
      if (fNoaction && track.documents.some(d => d.stage === "material_request" && !d.is_closed)) return false;

      if (q) {
        const searchStr = `${track.item_code} ${track.item_name} ${track.warehouse} ${track.item_group}`.toLowerCase();
        const docMatch  = track.documents.some(d =>
          `${d.doc_name} ${d.supplier} ${d.item_code}`.toLowerCase().includes(q));
        if (!searchStr.includes(q) && !docMatch) return false;
      }

      if (fAuto && !track.documents.some(d => d.recorded_by === "By System")) return false;
      return true;
    });

    // -- Filter nodes for the Pipeline view ------------------------------------
    let visibleNodes = this.nodes.filter(node => {
      // Zone filter on items only -- non-item nodes are propagated by BFS below
      if (fZone !== "All") {
        if (node.stage === "items" && node.zone !== fZone) return false;
      }
      // item_group: filter item/output nodes only (documents don't carry item_group)
      if (fItemGroup && (node.stage === "items" || node.stage === "output")) {
        if (!(node.item_group || "").toLowerCase().includes(fItemGroup)) return false;
      }
      // Doctype filter: skip item and output nodes (they don't have a doctype match)
      if (allowedDoctype && node.doctype !== allowedDoctype && node.stage !== "items" && node.stage !== "output") return false;
      // Overdue filter: skip items/output nodes (they have no due date)
      if (fOverdue && !node.is_overdue && node.stage !== "items" && node.stage !== "output") return false;
      // Auto filter: skip non-item/output nodes not generated by TOC engine
      if (fAuto && node.stage !== "items" && node.stage !== "output" && node.recorded_by !== "By System") return false;

      if (q) {
        const s = `${node.doc_name} ${node.label} ${node.description} ${node.supplier || ""}`.toLowerCase();
        if (!s.includes(q)) return false;
      }
      return true;
    });

    // Zone filter BFS propagation:
    // When zone is active, start with items matching the zone, then expand bidirectionally
    // through the edge graph to include all connected document nodes.
    if (fZone !== "All") {
      const seeds = new Set(visibleNodes.filter(n => n.stage === "items").map(n => n.id));
      visibleNodes = [...this._reachable(seeds, visibleNodes.map(n => n.id))].map(id => this.nodeMap[id]).filter(Boolean);
    }

    return { visibleNodes, visibleTracks };
  }

  /**
   * Bidirectional BFS from a set of seed node ids, restricted to the nodeIdSet.
   * Returns a Set of all node ids reachable from any seed via forward or backward edges.
   * Used by _applyClientFilters() for zone-filter propagation.
   *
   * @param {Set<string>}  seeds      -- starting nodes
   * @param {string[]}     nodeIdSet  -- only traverse edges whose endpoints are in this set
   * @returns {Set<string>} -- all reachable node ids (inclusive of seeds)
   */
  _reachable(seeds, nodeIdSet) {
    const nodeSet = new Set(nodeIdSet);
    const fwd = {}, bwd = {};
    // Build adjacency restricted to the filtered node set
    this.edges.forEach(e => {
      if (nodeSet.has(e.source)) (fwd[e.source] = fwd[e.source] || []).push(e.target);
      if (nodeSet.has(e.target)) (bwd[e.target] = bwd[e.target] || []).push(e.source);
    });
    const visited = new Set(seeds);
    const q = [...seeds];
    while (q.length) {
      const cur = q.shift();
      // Traverse both directions so upstream and downstream documents are included
      [...(fwd[cur] || []), ...(bwd[cur] || [])].forEach(nb => {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
      });
    }
    return visited;
  }

  /**
   * Count the total number of unique ancestors and descendants of a node in the DAG.
   * Used by the panel "Multi-Node Path Summary" section.
   *
   * Runs two independent BFS traversals:
   *   upstream   -> BFS on the backward (bwd) adjacency map
   *   downstream -> BFS on the forward (fwd) adjacency map
   *
   * Returns { upstream: number, downstream: number }
   * The caller adds +1 for the node itself to get total chain size.
   */
  _chainCounts(id) {
    const fwd = {}, bwd = {};
    this.edges.forEach(e => {
      (fwd[e.source] = fwd[e.source] || []).push(e.target);
      (bwd[e.target] = bwd[e.target] || []).push(e.source);
    });
    const bfs = (start, adj) => {
      const v = new Set(), q = [start];
      while (q.length) {
        const cur = q.shift();
        (adj[cur] || []).forEach(nb => { if (!v.has(nb)) { v.add(nb); q.push(nb); } });
      }
      return v.size;
    };
    return { upstream: bfs(id, bwd), downstream: bfs(id, fwd) };
  }

  // ==============================================================================
  //  EVENT BINDINGS
  //  All event listeners set up once during init(). Subsequent re-renders do
  //  not re-bind these -- they remain active for the page lifetime.
  // ==============================================================================

  /**
   * Bind the command bar (top row of controls):
   *   Search input      -- debounced 280ms; shows/hides clear button
   *   Clear button      -- clears search and re-renders
   *   View-mode buttons -- toggle between Tracker and Pipeline views
   *   Filter toggle     -- show/hide the filter panel
   *   Days-back select  -- changes look-back window, triggers server reload
   *   Scroll/resize     -- redraws SVG edges when pipeline scroll position changes;
   *                       preserves liveMode if a card is currently selected
   *   Background click  -- clicking empty pipeline area deselects and closes panel
   */
  _bindCommandBar() {
    // -- Debounced search -------------------------------------------------------
    const searchEl = document.getElementById("sct-search");
    const clearEl  = document.getElementById("sct-search-clear");
    let debounce;
    searchEl?.addEventListener("input", () => {
      this.f.search = searchEl.value;
      clearEl.style.display = this.f.search ? "block" : "none";
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 280);  // 280ms lag prevents render on every keystroke
    });
    clearEl?.addEventListener("click", () => {
      searchEl.value = "";
      this.f.search  = "";
      clearEl.style.display = "none";
      this.render();
    });

    // -- View mode toggle --------------------------------------------------------
    document.querySelectorAll(".sct-view-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (view === this.viewMode) return;  // already active, no-op
        this.viewMode = view;
        document.querySelectorAll(".sct-view-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        // Show/hide the corresponding view container
        document.getElementById("sct-view-tracker").classList.toggle("active",  view === "tracker");
        document.getElementById("sct-view-pipeline").classList.toggle("active", view === "pipeline");
        this._clearSelection();
        this._closePanel();
        // Pipeline view must be explicitly re-rendered on switch (tracker is always up-to-date)
        if (view === "pipeline") this.render();
      });
    });

    // -- Pipeline Clear Selection ------------------------------------------------
    document.getElementById("sct-clear-btn")?.addEventListener("click", () => {
      this._clearSelection();
      this._closePanel();
    });

    // -- Filter panel toggle ----------------------------------------------------
    document.getElementById("sct-filter-toggle")?.addEventListener("click", () => {
      const panel = document.getElementById("sct-filter-panel");
      const btn   = document.getElementById("sct-filter-toggle");
      panel.classList.toggle("open");
      btn.classList.toggle("active", panel.classList.contains("open"));
    });

    // -- Days-back window change (server-side) ----------------------------------
    document.getElementById("sct-days-back")?.addEventListener("change", (e) => {
      this.f.days_back = parseInt(e.target.value);
      this.load();  // Requires new server fetch -- changes document set
    });

    // -- Pipeline scroll / resize: redraw edges ---------------------------------
    // When the user scrolls the pipeline container or resizes the window, card
    // positions shift, so edges must be redrawn from scratch.
    // We use a rAF-debounce to avoid firing dozens of times per scroll frame.
    // liveMode is preserved: if a card is selected, redrawn edges keep .live class.
    const scroll = document.getElementById("sct-pl-scroll");
    if (scroll) {
      let raf;
      const redraw = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const { visibleNodes } = this._applyClientFilters();
          const ids = new Set(visibleNodes.map(n => n.id));
          // Pass all cardEls ids (not just visibleNodes) so hidden-card skip in _drawEdges
          // handles filtering -- otherwise reselected-card edges could disappear on scroll
          this._drawEdges(this.selectedId ? new Set(Object.keys(this.cardEls)) : ids,
                          !!this.selectedId);
        });
      };
      scroll.addEventListener("scroll", redraw, { passive: true });
      window.addEventListener("resize", redraw);
    }

    // -- Background click: deselect ---------------------------------------------
    // Clicking empty canvas (not a card) clears selection and closes panel.
    // Must check both .sct-card (tracker) and .sct-card-v2 (pipeline).
    document.getElementById("sct-pl-scroll")?.addEventListener("click", e => {
      if (!e.target.closest(".sct-card") && !e.target.closest(".sct-card-v2")) {
        this._clearSelection();
        this._closePanel();
      }
    });
  }

  /**
   * Bind the filter panel interactions.
   * Pills apply immediately on click (no Apply button in new HTML).
   * data-filter="zone" and data-value="Red" are the attribute names in Tiger Theme HTML.
   */
  _bindFilterPanel() {
    // Single delegated listener on the panel for all pill clicks.
    // Pills apply immediately -- no Apply button needed.
    document.getElementById("sct-filter-panel")?.addEventListener("click", e => {
      const pill = e.target.closest(".sct-fpill");
      if (!pill) return;
      const group = pill.dataset.filter;   // "zone" (only zone pills in new HTML)
      const val   = pill.dataset.value;
      // Deactivate all pills in this group, then activate the clicked one
      document.querySelectorAll(`.sct-fpill[data-filter="${group}"]`).forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      if (group === "zone") this.f.zone = val;
      // Apply immediately on click
      this.render();
    });
  }

  /** Bind the ✕ close button inside the detail panel header. */
  _bindPanel() {
    document.getElementById("sct-panel-close")?.addEventListener("click", () => {
      this._clearSelection();
      this._closePanel();
    });
  }

  /**
   * Bind the summary strip zone-filter shortcuts via event delegation.
   * The strip is built dynamically by _updateSummary(), so we delegate from
   * #sct-summary rather than binding directly to (not-yet-existing) stat cards.
   */
  _bindSummaryClicks() {
    document.getElementById("sct-summary")?.addEventListener("click", e => {
      const stat = e.target.closest("[data-zone]");
      if (!stat) return;
      const zone = stat.dataset.zone;
      this.f.zone = zone;
      // Update filter pills to reflect the programmatic change
      document.querySelectorAll(`.sct-fpill[data-filter="zone"]`).forEach(p => {
        p.classList.toggle("active", p.dataset.value === zone);
      });
      this.render();
    });
  }

  /**
   * Fetch supplier and item group lists from the server once at startup.
   * Supplier selection triggers a server reload (SQL join).
   * Item group selection is applied client-side only.
   * New dropdown IDs match the Tiger Theme HTML: dd-supplier, dd-group.
   */
  _loadFilterOptions() {
    frappe.call({
      method: "chaizup_toc.api.pipeline_api.get_filter_options",
      callback: (r) => {
        if (!r.message) return;
        const { suppliers = [], item_groups = [], warehouses = [] } = r.message;
        // Supplier: server-side filter -- triggers load()
        this._initSearchDropdown("dd-supplier", suppliers, (val) => {
          this.f.supplier = val;
          this.load();
        });
        // Item group: client-side filter -- triggers render() only
        const groups = item_groups.length ? item_groups : warehouses;
        this._initSearchDropdown("dd-group", groups, (val) => {
          this.f.item_group = val;
          this.render();
        });
      },
    });
  }

  /**
   * Initialise a custom searchable dropdown widget.
   *
   * The dropdown handles:
   *   - Type-to-filter with live substring highlight in results
   *   - Keyboard navigation (ArrowDown/Up = move focus, Enter = select, Escape = close)
   *   - Click-outside to close (mousedown on capture phase to beat blur)
   *   - Clear button (x) to reset selection
   *   - Committed vs. typed state: if user types but doesn't select, input reverts
   *     to the previously committed value on blur/close
   *
   * The input element is found by class .sct-dd-input within the wrapper --
   * no separate inputId needed. onSelect callback fires immediately on selection
   * (no Apply button required in the Tiger Theme layout).
   *
   * @param {string}      wrapperId  -- id of the .sct-dd wrapper element
   * @param {string[]}    items      -- complete options list fetched from the server
   * @param {function}    onSelect   -- called with (value) when user commits a selection or clears
   */
  _initSearchDropdown(wrapperId, items, onSelect) {
    const wrap   = document.getElementById(wrapperId);
    const input  = wrap?.querySelector(".sct-dd-input");
    const list   = wrap?.querySelector(".sct-dd-list");
    const clear  = wrap?.querySelector(".sct-dd-clear");
    if (!wrap || !input || !list) return;

    let focusIdx  = -1;      // keyboard-focused list item index
    let open      = false;   // dropdown open state
    let committed = "";      // the last formally-selected value

    // Highlight the matched query substring in an item label
    const _highlight = (text, query) => {
      if (!query) return frappe.utils.escape_html(text);
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return frappe.utils.escape_html(text);
      return frappe.utils.escape_html(text.slice(0, idx))
        + `<mark>${frappe.utils.escape_html(text.slice(idx, idx + query.length))}</mark>`
        + frappe.utils.escape_html(text.slice(idx + query.length));
    };

    // Rebuild the visible list, filtered and highlighted
    const _render = (q) => {
      const q_lower = (q || "").toLowerCase().trim();
      // Cap at 80 results to keep the list performant for large supplier lists
      const matched = q_lower
        ? items.filter(s => s.toLowerCase().includes(q_lower)).slice(0, 80)
        : items.slice(0, 80);

      list.innerHTML = "";
      focusIdx = -1;

      if (!matched.length) {
        list.innerHTML = `<div class="sct-dd-empty">${q_lower ? "No matches found" : "No options available"}</div>`;
        return;
      }

      matched.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "sct-dd-item" + (item === committed ? " selected" : "");
        el.setAttribute("role", "option");
        el.innerHTML = _highlight(item, q_lower);
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();   // Prevent blur on input -- blur would close the list before click registers
          _select(item);
        });
        list.appendChild(el);
      });
    };

    const _open = () => {
      if (open) return;
      open = true;
      wrap.classList.add("open");
      _render(input.value);   // Show filtered list immediately
    };

    const _close = () => {
      if (!open) return;
      open = false;
      wrap.classList.remove("open");
      focusIdx = -1;
      // If user typed without selecting, revert input to the committed value
      if (input.value !== committed) {
        input.value = committed;
        input.classList.toggle("has-value", !!committed);
        wrap.classList.toggle("has-value", !!committed);
      }
    };

    // Formally select a value: update committed and close the dropdown.
    // Calls onSelect immediately so no Apply button is needed.
    const _select = (val) => {
      committed = val;
      input.value = val;
      input.classList.add("has-value");
      wrap.classList.add("has-value");
      _close();
      if (onSelect) onSelect(val);
    };

    // Clear the committed value and reset input.
    const _clearValue = () => {
      committed = "";
      input.value = "";
      input.classList.remove("has-value");
      wrap.classList.remove("has-value");
      _close();
      if (onSelect) onSelect("");
    };

    // Move keyboard focus within the list, scroll to keep focused item visible
    const _moveFocus = (dir) => {
      const rows = list.querySelectorAll(".sct-dd-item");
      if (!rows.length) return;
      rows[focusIdx]?.classList.remove("focused");
      focusIdx = Math.max(0, Math.min(rows.length - 1, focusIdx + dir));
      rows[focusIdx].classList.add("focused");
      rows[focusIdx].scrollIntoView({ block: "nearest" });
    };

    // -- Event listeners --------------------------------------------------------
    input.addEventListener("focus", () => _open());
    input.addEventListener("input", () => {
      wrap.classList.toggle("has-value", !!input.value);
      _render(input.value);
      if (!open) _open();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown")  { e.preventDefault(); _open(); _moveFocus(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); _moveFocus(-1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const focused = list.querySelector(".sct-dd-item.focused");
        if (focused) _select(focused.textContent.trim());
        else if (open) _close();
      }
      else if (e.key === "Escape") { _close(); input.blur(); }
    });

    // Close on click outside -- use capture phase to run before focus events
    document.addEventListener("mousedown", (e) => {
      if (!wrap.contains(e.target)) _close();
    }, { capture: true });

    clear?.addEventListener("click", (e) => {
      e.stopPropagation();
      _clearValue();
      input.focus();   // Return focus so keyboard nav works after clear
    });

    // Pre-populate display if a committed value already exists (e.g., after page revisit)
    if (committed) {
      input.value = committed;
      input.classList.add("has-value");
      wrap.classList.add("has-value");
    }
  }

  // ==============================================================================
  //  SUMMARY STRIP
  //  Builds stat cards dynamically -- the new Tiger Theme HTML has an empty
  //  #sct-summary div that we populate here. Each card is clickable to filter
  //  by zone (handled via event delegation in _bindSummaryClicks).
  //  overdue count is computed client-side from this.tracks.
  // ==============================================================================
  _updateSummary(s, meta) {
    const strip = document.getElementById("sct-summary");
    if (!strip) return;
    const overdueCount = this.tracks.filter(t => t.overdue_count > 0).length;
    const total = meta.total_items ?? 0;

    const stat = (zone, icon, label, count) =>
      `<div class="sct-stat clickable" data-zone="${zone}" title="Click to filter by ${label} zone">
        <span class="sct-stat-val">${count}</span>
        <span class="sct-stat-lbl">${icon} ${label}</span>
       </div>`;

    strip.innerHTML = [
      stat("Red",    "🔴", "Red",    s.red    ?? 0),
      stat("Yellow", "🟡", "Yellow", s.yellow ?? 0),
      stat("Green",  "🟢", "Green",  s.green  ?? 0),
      `<div class="sct-stat">
        <span class="sct-stat-val">${s.mrs ?? 0}</span>
        <span class="sct-stat-lbl">📋 Open MRs</span>
       </div>`,
      `<div class="sct-stat">
        <span class="sct-stat-val">${s.wos ?? 0}</span>
        <span class="sct-stat-lbl">⚙ Work Orders</span>
       </div>`,
      `<div class="sct-stat">
        <span class="sct-stat-val">${s.pos ?? 0}</span>
        <span class="sct-stat-lbl">🛒 Purchase Orders</span>
       </div>`,
      overdueCount > 0 ? `<div class="sct-stat sct-stat-warn">
        <span class="sct-stat-val">${overdueCount}</span>
        <span class="sct-stat-lbl">⚠ Overdue</span>
       </div>` : "",
      total ? `<div class="sct-stat">
        <span class="sct-stat-val">${total}</span>
        <span class="sct-stat-lbl">📦 Items</span>
       </div>` : "",
    ].join("");
  }

  /**
   * Update the "Filters (N)" badge on the filter toggle button.
   * Counts each active non-default filter dimension.
   */
  _updateFilterBadge() {
    let count = 0;
    if (this.f.type       !== "All") count++;
    if (this.f.zone       !== "All") count++;
    if (this.f.doctype    !== "All") count++;
    if (this.f.supplier)             count++;
    if (this.f.item_group)           count++;
    if (this.f.overdue)              count++;
    if (this.f.auto)                 count++;
    if (this.f.noaction)             count++;
    if (this.f.search)               count++;
    const badge = document.getElementById("sct-filter-badge");
    if (badge) {
      badge.style.display = count > 0 ? "inline" : "none";
      badge.textContent   = count;
    }
  }

  /** Show/hide the loading spinner. */
  _setLoading(show) {
    const el = document.getElementById("sct-loader");
    if (el) el.style.display = show ? "flex" : "none";
  }

  // ==============================================================================
  //  BADGE / COLOUR HELPERS
  //  Small, pure functions that produce HTML strings or CSS values.
  // ==============================================================================

  /** Return the HTML for a zone badge (🔴 Red, 🟡 Yellow, 🟢 Green, ⚫ Black). */
  _zoneBadge(zone) {
    if (!zone) return "";
    const icons = { Red: "🔴", Yellow: "🟡", Green: "🟢", Black: "⚫" };
    return `<span class="sct-zone-badge zone-${zone}">${icons[zone] || ""} ${zone}</span>`;
  }

  /** Return the solid colour used for zone bar fills and text accents. */
  _zoneBarColor(zone) {
    return { Red: "#dc2626", Yellow: "#d97706", Green: "#16a34a", Black: "#374151" }[zone] || "#78716c";
  }

  /** Return an HTML <span> status badge (used in tracker doc rows). */
  _statusBadge(status) {
    if (!status && status !== 0) return "";
    return `<span class="sct-badge ${this._statusBadgeClass(status)}">${status}</span>`;
  }

  /**
   * Return the CSS modifier class for a status badge.
   * Normalises status strings to lowercase hyphenated form for lookup.
   */
  _statusBadgeClass(status) {
    const s = String(status).toLowerCase().replace(/[\s\/]+/g, "-");
    const map = {
      "draft": "sct-badge-draft", "pending": "sct-badge-pending",
      "open": "sct-badge-open", "ordered": "sct-badge-ordered",
      "to-receive-and-bill": "sct-badge-ordered", "to-bill": "sct-badge-to-bill",
      "completed": "sct-badge-completed", "stopped": "sct-badge-stopped",
      "submitted": "sct-badge-submitted", "cancelled": "sct-badge-default",
      "in-process": "sct-badge-inprocess", "not-started": "sct-badge-draft",
      "material-transferred": "sct-badge-pending",
    };
    return map[s] || "sct-badge-default";
  }

  /**
   * Return the HTML for a document-type tag pill (MR, PO, WO, etc.).
   * Output nodes override the abbreviation to "OUT" regardless of doctype.
   */
  _docTag(node) {
    const map = {
      "Item": ["tag-item", "ITEM"], "Material Request": ["tag-mr", "MR"],
      "Request for Quotation": ["tag-rfq", "RFQ"], "Supplier Quotation": ["tag-sq", "SQ"],
      "Purchase Order": ["tag-po", "PO"], "Production Plan": ["tag-pp", "PP"],
      "Work Order": ["tag-wo", "WO"], "Job Card": ["tag-jc", "JC"],
      "Purchase Receipt": ["tag-pr", "PR"], "Quality Inspection": ["tag-qi", "QI"],
      "Stock Entry": ["tag-se", "SE"],
    };
    const [cls, abbr] = map[node.doctype] || ["tag-item", "DOC"];
    const label = node.sub_type === "output" ? "OUT" : abbr;
    return `<span class="sct-doc-tag ${cls}">${label}</span>`;
  }
}
