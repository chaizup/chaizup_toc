/**
 * supply_chain_tracker.js — Supply Chain Tracker Controller
 *
 * Two view modes:
 *   • Tracker (default) — one row per TOC item; shows full document chain with
 *     overdue indicators, age, progress, next-action recommendations.
 *   • Pipeline — horizontal 7-stage columns with SVG edge connections,
 *     lineage highlighting on click, marching-ants animation, port badges.
 *
 * Brand: Oswald + DM Sans fonts, --brand-500 #f97316 (Chaizup tiger orange),
 *        warm stone palette, flow-type colour accents (buy=cyan, mfg=violet).
 *
 * Client-side filtering: search, zone, type, doctype, overdue, auto-only.
 * Server-side re-fetch: days_back, supplier, warehouse.
 */

frappe.pages["supply-chain-tracker"].on_page_load = function (wrapper) {
  if (wrapper.sct_initialized) return;
  wrapper.sct_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "Supply Chain Tracker",
    single_column: true,
  });

  page.add_inner_button(__("Refresh"), () => window.sctApp.load()).addClass("btn-primary");
  page.add_menu_item(__("TOC Live Dashboard"),       () => frappe.set_route("toc-dashboard"));
  page.add_menu_item(__("Production Priority Board"),() => frappe.set_route("query-report", "Production Priority Board"));
  page.add_menu_item(__("Procurement Action List"),  () => frappe.set_route("query-report", "Procurement Action List"));
  page.add_menu_item(__("TOC Settings"),             () => frappe.set_route("Form", "TOC Settings", "TOC Settings"));

  $(frappe.render_template("supply_chain_tracker", {})).appendTo(page.body);

  window.sctApp = new SupplyChainTracker(page);
  window.sctApp.init();
};


// ═══════════════════════════════════════════════════════════════════════════
class SupplyChainTracker {
  constructor(page) {
    this.page    = page;
    this.nodes   = [];
    this.edges   = [];
    this.tracks  = [];
    this.nodeMap = {};
    this.cardEls = {};
    this.selectedId = null;

    // Active filter state
    this.f = {
      search:    "",
      type:      "All",
      zone:      "All",
      doctype:   "All",
      supplier:  "",
      warehouse: "",
      overdue:   false,
      auto:      false,
      noaction:  false,
      days_back: 30,
    };

    this.viewMode = "tracker";   // "tracker" | "pipeline"
    this._bomCache = new Map();  // item_code → BOM items array (null = no BOM)

    // Pipeline stages config — flow: item | both | buy | mfg | out
    this.stages = [
      { id: "items",            label: "Items",             sub: "TOC-managed",           icon: "📦", flow: "item", num: "01" },
      { id: "material_request", label: "Material Request",  sub: "Replenishment trigger",  icon: "📋", flow: "both", num: "02" },
      { id: "rfq_pp",           label: "RFQ / Prod. Plan",  sub: "Procurement or plan",    icon: "🔍", flow: "both", num: "03" },
      { id: "sq_wo",            label: "Quotation / WO",    sub: "Quote or Work Order",    icon: "⚙",  flow: "both", num: "04" },
      { id: "po_jc",            label: "PO / Job Card",     sub: "Confirmed order/op",     icon: "🛒", flow: "both", num: "05" },
      { id: "receipt_qc",       label: "Receipt / QC / SE", sub: "Goods or production",   icon: "✅", flow: "both", num: "06" },
      { id: "output",           label: "FG / SFG Buffer",   sub: "Current buffer state",  icon: "🏭", flow: "out",  num: "07" },
    ];

    // Flow colours (matches CSS vars)
    this._flowColors = {
      buy:  "#06b6d4",
      mfg:  "#8b5cf6",
      both: "#f97316",
      item: "#a8a29e",
      out:  "#10b981",
    };
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  init() {
    this._bindCommandBar();
    this._bindFilterPanel();
    this._bindPanel();
    this._bindSummaryClicks();
    this._loadFilterOptions();
    this.load();
  }

  // ── Load data from API ─────────────────────────────────────────────────────
  load() {
    this._setLoading(true);
    frappe.call({
      method: "chaizup_toc.api.pipeline_api.get_pipeline_data",
      args: {
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

  // ── Render (both views) ────────────────────────────────────────────────────
  render() {
    this._clearSelection();
    this._closePanel();

    const { visibleNodes, visibleTracks } = this._applyClientFilters();

    if (this.viewMode === "tracker") {
      this._renderTracker(visibleTracks);
    } else {
      this._renderPipeline(visibleNodes);
    }

    this._updateFilterBadge();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRACKER VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  _renderTracker(tracks) {
    const wrap = document.getElementById("sct-tracker-wrap");
    wrap.innerHTML = "";

    if (!tracks.length) {
      wrap.innerHTML = `<div class="sct-empty">
        <div class="sct-empty-icon">📭</div>
        <div>No items match the current filters</div>
      </div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    tracks.forEach(track => frag.appendChild(this._buildTrackEl(track)));
    wrap.appendChild(frag);
  }

  _buildTrackEl(track) {
    const el = document.createElement("div");
    el.className = "sct-track" + (track.overdue_count > 0 ? " overdue-track" : "");
    el.dataset.itemCode = track.item_code;

    const zoneColor = this._zoneBarColor(track.zone);
    const bp        = Math.min(track.bp_pct || 0, 100);
    const isUrgent  = track.zone === "Red" || track.zone === "Black";

    const hdr = document.createElement("div");
    hdr.className = "sct-track-header";
    hdr.innerHTML = `
      <div class="sct-track-zone-bar" style="background:${zoneColor}"></div>
      <div class="sct-track-item-info">
        <div class="sct-track-item-name">${track.item_code}
          <span style="font-size:11px;font-weight:400;color:var(--stone-500)"> — ${track.item_name}</span>
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
            ? `<span class="sct-track-count-chip count-done">✓ done</span>` : ""}
        </div>
        <div class="sct-track-next-action${isUrgent ? " urgent" : ""}" title="${track.next_action}">
          ${track.next_action}
        </div>
      </div>
      <span class="sct-track-toggle">▼</span>
    `;
    hdr.addEventListener("click", () => el.classList.toggle("expanded"));
    el.appendChild(hdr);

    // Body (lazy)
    const body = document.createElement("div");
    body.className = "sct-track-body";
    body.dataset.built = "0";
    el.appendChild(body);

    el.addEventListener("click", () => {
      if (!el.classList.contains("expanded")) return;
      if (body.dataset.built === "0") {
        body.innerHTML = this._buildTrackBody(track);
        body.dataset.built = "1";
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

  _buildTrackBody(track) {
    const parts = [];

    // Stock info chips
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

    // Next action box
    if (track.next_action) {
      const isUrgent = track.next_action.startsWith("⚠") || track.zone === "Red" || track.zone === "Black";
      parts.push(`
        <div class="sct-next-action-box${isUrgent ? " urgent" : ""}">
          <div class="sct-next-action-box-title">⬆ NEXT ACTION</div>
          <div class="sct-next-action-box-text">${track.next_action}</div>
        </div>`);
    }

    // Group docs by stage
    if (!track.documents || !track.documents.length) {
      parts.push(`<div class="sct-no-docs">No open documents in the last ${this.f.days_back} days</div>`);
    } else {
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

  _makeNodeFromDoc(dataset) {
    return this.nodeMap[dataset.nodeid] || {
      id: dataset.nodeid,
      doctype: dataset.doctype,
      doc_name: dataset.doc,
      label: dataset.doc,
      stage: "",
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PIPELINE VIEW
  // ═══════════════════════════════════════════════════════════════════════════
  _renderPipeline(visibleNodes) {
    const scroll = document.getElementById("sct-pipeline-scroll");
    [...scroll.querySelectorAll(".sct-col")].forEach(c => c.remove());
    this.cardEls = {};
    this.selectedId = null;

    const visibleIds = new Set(visibleNodes.map(n => n.id));

    this.stages.forEach(stage => {
      const col = this._buildPipelineCol(stage, visibleIds, visibleNodes);
      scroll.appendChild(col);
    });

    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._drawEdges(visibleIds);
      this._injectPorts(visibleIds);
    }));
  }

  _buildPipelineCol(stage, visibleIds, visibleNodes) {
    const stageNodes   = visibleNodes.filter(n => n.stage === stage.id);
    const overdueCount = stageNodes.filter(n => n.is_overdue).length;

    const col = document.createElement("div");
    col.className  = `sct-col flow-${stage.flow}`;
    col.dataset.stage = stage.id;

    // Collapse if no visible cards
    if (!stageNodes.length && visibleNodes.length > 0) {
      col.classList.add("hide-stage");
    }

    const hdr = document.createElement("div");
    hdr.className = "sct-col-header";
    hdr.innerHTML = `
      <div class="sct-col-header-top">
        <div class="sct-col-title-wrap">
          <span class="sct-stage-num">${stage.num}</span>
          <div class="sct-col-icon">${stage.icon}</div>
          <span class="sct-col-title">${stage.label}</span>
        </div>
        <div class="sct-col-meta">
          <span class="sct-col-count">${stageNodes.length}</span>
          ${overdueCount > 0
            ? `<span class="sct-col-overdue" style="display:inline">⚠ ${overdueCount}</span>`
            : ""}
        </div>
      </div>
      <div class="sct-col-sub">${stage.sub}</div>
    `;

    // Click on collapsed header to expand
    hdr.addEventListener("click", () => {
      if (col.classList.contains("hide-stage")) {
        col.classList.remove("hide-stage");
      }
    });
    col.appendChild(hdr);

    const cards = document.createElement("div");
    cards.className = "sct-col-cards";

    if (!stageNodes.length) {
      cards.innerHTML = `<div class="sct-col-empty">No documents</div>`;
    } else {
      stageNodes.forEach(node => {
        const card = this._buildPipelineCard(node);
        this.cardEls[node.id] = card;
        cards.appendChild(card);
      });
    }
    col.appendChild(cards);
    return col;
  }

  _buildPipelineCard(node) {
    const el = document.createElement("div");
    // Buffer-type accent class
    const btClass = this._btClass(node);
    el.className = `sct-card ${btClass}` + (node.is_overdue ? " sct-card-overdue" : "");
    el.dataset.id = node.id;

    const docTag     = this._docTag(node);
    const statusDot  = this._statusDot(node.status);
    const statusBadge = this._statusBadge(node.status);
    const zoneBadge  = node.zone ? this._zoneBadge(node.zone) : "";
    const autoTag    = node.recorded_by === "By System"
      ? `<span class="sct-auto-tag">TOC Auto</span>` : "";

    let extras = "";

    // Zone + BP% bar
    if (node.zone && node.bp_pct !== undefined) {
      const fill = Math.min(node.bp_pct, 100);
      extras += `
        <div class="sct-bp-row">
          <span class="sct-bp-lbl">BP%</span>
          <div class="sct-bp-track">
            <div class="sct-bp-fill bp-${node.zone}" style="width:${fill}%"></div>
          </div>
          <span class="sct-bp-val" style="color:${this._zoneBarColor(node.zone)}">${node.bp_pct}%</span>
        </div>`;
    }

    // WO/JC progress
    if ((node.sub_type === "wo" || node.sub_type === "jc") && node.qty > 0) {
      const pct  = node.progress_pct || 0;
      const done = node.produced_qty ?? node.completed_qty ?? 0;
      extras += `
        <div class="sct-progress-row">
          <div class="sct-progress-fill">
            <div class="sct-progress-bar" style="width:${pct}%"></div>
          </div>
          <span>${pct}% (${done}/${node.qty})</span>
        </div>`;
    }

    // Item / output chips (only for TOC-managed items — non-TOC have no buffer data)
    if ((node.stage === "items" || node.sub_type === "output") && node.toc_enabled) {
      extras += `
        <div class="sct-chip-row">
          <span class="sct-chip">OH: <b>${node.on_hand}</b></span>
          <span class="sct-chip">Tgt: <b>${node.target_buffer}</b></span>
          ${node.order_qty > 0
            ? `<span class="sct-chip warn">Def: <b>${node.order_qty}</b></span>`
            : ""}
        </div>`;
    }
    // Non-TOC badge on item cards in pipeline view
    if (node.stage === "items" && !node.toc_enabled) {
      extras += `<div style="margin-top:4px"><span class="sct-tag-non-toc">Non-TOC</span></div>`;
    }

    // PO pending
    if (node.sub_type === "po" && node.qty > 0) {
      const pending = Math.max(0, node.qty - (node.received_qty || 0));
      if (pending > 0) {
        extras += `<div class="sct-chip-row">
          <span class="sct-chip">Pending: <b>${pending}</b></span>
          <span class="sct-chip">Rcvd: <b>${node.received_qty || 0}</b></span>
        </div>`;
      }
    }

    // Supplier
    if (node.supplier) {
      extras += `<div class="sct-chip-row"><span class="sct-chip" style="max-width:140px;overflow:hidden;text-overflow:ellipsis">🏢 ${node.supplier}</span></div>`;
    }

    // Age / overdue
    if (node.days_open > 0 || node.is_overdue) {
      extras += `<div class="sct-card-age">
        ${node.days_open > 0  ? `<span class="sct-age-chip">${node.days_open}d old</span>` : ""}
        ${node.is_overdue     ? `<span class="sct-age-chip overdue">⚠ ${node.days_overdue}d overdue</span>` : ""}
      </div>`;
    }

    // Date
    const dateVal = node.required_date || node.expected_delivery || node.planned_start_date
      || node.transaction_date || node.posting_date || "";
    if (dateVal) {
      extras += `<div style="font-size:9.5px;color:var(--stone-400);margin-top:3px">📅 ${dateVal}</div>`;
    }

    el.innerHTML = `
      <div class="sct-card-top">
        <span class="sct-card-name" title="${node.doc_name}">${statusDot}${node.label}</span>
        <div class="sct-card-tags">${docTag}</div>
      </div>
      <div class="sct-card-desc" title="${node.description}">${node.description || "&nbsp;"}</div>
      <div class="sct-card-badges">${statusBadge}${zoneBadge}${autoTag}</div>
      ${extras}
      <button class="sct-card-view-btn">View →</button>
    `;

    el.addEventListener("click", e => {
      if (e.target.closest(".sct-card-view-btn")) {
        e.stopPropagation();
        if (node.doctype && node.doc_name && node.stage !== "output") {
          const url = `/app/${frappe.router.slug(node.doctype)}/${encodeURIComponent(node.doc_name)}`;
          window.open(url, "_blank");
        }
        return;
      }
      e.stopPropagation();
      this._pipelineSelect(node.id);
    });

    return el;
  }

  // Buffer-type CSS class for accent stripe
  _btClass(node) {
    const bt = (node.buffer_type || "").toLowerCase();
    const sub = node.sub_type || "";
    if (bt === "rm") return "bt-rm";
    if (bt === "pm") return "bt-pm";
    if (bt === "sfg") return "bt-sfg";
    if (bt === "fg") return "bt-fg";
    if (["rfq","sq","po","pr","qi"].includes(sub)) return "bt-buy";
    if (["pp","wo","jc","se"].includes(sub))       return "bt-mfg";
    if (node.stage === "items" || node.stage === "output") return "bt-item";
    return "";
  }

  // Status dot (tiny coloured circle based on status)
  _statusDot(status) {
    const s = String(status || "").toLowerCase();
    let cls = "didle";
    if (["completed", "to-bill", "submitted", "closed"].some(x => s.includes(x))) cls = "dok";
    else if (["open","ordered","in-process","not-started","material-transferred","pending"].some(x => s.includes(x))) cls = "dwarn";
    else if (["overdue","stopped","cancelled"].some(x => s.includes(x))) cls = "derr";
    return `<span class="sdot ${cls}"></span>`;
  }

  // Pipeline selection / lineage
  _pipelineSelect(id) {
    if (this.selectedId === id) {
      this._clearSelection();
      this._closePanel();
    } else {
      this.selectedId = id;
      this._applyLineageHighlight(id);
      this.showPanel(this.nodeMap[id]);
    }
  }

  _clearSelection() {
    this.selectedId = null;
    Object.values(this.cardEls).forEach(el => {
      el.classList.remove("selected", "ancestor", "descendant", "dimmed");
    });
    document.querySelectorAll(".sct-edge").forEach(p => {
      p.classList.remove("active", "ancestor", "descendant", "dimmed", "marching", "hl", "dim");
    });
  }

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
      el.classList.remove("selected", "ancestor", "descendant", "dimmed");
      if      (nid === id)           el.classList.add("selected");
      else if (ancestors.has(nid))   el.classList.add("ancestor");
      else if (descendants.has(nid)) el.classList.add("descendant");
      else                           el.classList.add("dimmed");
    });

    document.querySelectorAll(".sct-edge").forEach(path => {
      path.classList.remove("active", "ancestor", "descendant", "dimmed", "marching");
      const s = path.dataset.source, t = path.dataset.target;
      if (s === id || t === id) {
        path.classList.add("active", "marching");  // marching ants on direct connections
      } else if (relevant.has(s) && relevant.has(t)) {
        path.classList.add(ancestors.has(s) ? "ancestor" : "descendant");
      } else {
        path.classList.add("dimmed");
      }
    });
  }

  // ── SVG Edges ──────────────────────────────────────────────────────────────
  _getEdgeColor(edge) {
    const tgt = this.nodeMap[edge.target];
    const sub = tgt?.sub_type || "";
    if (["rfq","sq","po","pr","qi"].includes(sub)) return this._flowColors.buy;
    if (["pp","wo","jc","se"].includes(sub))       return this._flowColors.mfg;
    const stage = tgt?.stage || "";
    if (stage === "output") return this._flowColors.out;
    if (stage === "items")  return this._flowColors.item;
    return "#d6d3d1"; // stone-300 fallback
  }

  _getEdgeFlowClass(edge) {
    const tgt = this.nodeMap[edge.target];
    const sub = tgt?.sub_type || "";
    if (["rfq","sq","po","pr","qi"].includes(sub)) return "flow-buy";
    if (["pp","wo","jc","se"].includes(sub))       return "flow-mfg";
    if ((tgt?.stage || "") === "output")           return "flow-out";
    return "";
  }

  _drawEdges(visibleIds) {
    const scroll = document.getElementById("sct-pipeline-scroll");
    const svg    = document.getElementById("sct-svg-overlay");
    if (!scroll || !svg) return;

    const W = scroll.scrollWidth;
    const H = scroll.scrollHeight;
    svg.setAttribute("width",  W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const scrollRect = scroll.getBoundingClientRect();
    const sl = scroll.scrollLeft;
    const st = scroll.scrollTop;

    this.edges.forEach(edge => {
      if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return;
      const se = this.cardEls[edge.source];
      const te = this.cardEls[edge.target];
      if (!se || !te) return;
      const sr = se.getBoundingClientRect();
      const tr = te.getBoundingClientRect();
      const x1 = sr.right  - scrollRect.left + sl;
      const y1 = sr.top    + sr.height / 2 - scrollRect.top + st;
      const x2 = tr.left   - scrollRect.left + sl;
      const y2 = tr.top    + tr.height / 2 - scrollRect.top + st;
      const cx = (x1 + x2) / 2;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
      const flowClass = this._getEdgeFlowClass(edge);
      path.classList.add("sct-edge");
      if (flowClass) path.classList.add(flowClass);
      path.dataset.source = edge.source;
      path.dataset.target = edge.target;

      // Hover: highlight this edge and dim others
      path.style.pointerEvents = "stroke";
      path.addEventListener("mouseenter", () => {
        document.querySelectorAll(".sct-edge").forEach(p => p.classList.add("dim"));
        path.classList.remove("dim");
        path.classList.add("hl");
      });
      path.addEventListener("mouseleave", () => {
        document.querySelectorAll(".sct-edge").forEach(p => {
          p.classList.remove("dim", "hl");
        });
        if (this.selectedId) this._applyLineageHighlight(this.selectedId);
      });

      svg.appendChild(path);
    });

    if (this.selectedId) this._applyLineageHighlight(this.selectedId);
  }

  // Inject In/Out port badges onto each pipeline card
  _injectPorts(visibleIds) {
    const inDeg = {}, outDeg = {};
    this.edges.forEach(e => {
      if (visibleIds.has(e.source) && visibleIds.has(e.target)) {
        outDeg[e.source] = (outDeg[e.source] || 0) + 1;
        inDeg[e.target]  = (inDeg[e.target]  || 0) + 1;
      }
    });
    Object.entries(this.cardEls).forEach(([id, el]) => {
      let portDiv = el.querySelector(".sct-ports");
      if (!portDiv) {
        portDiv = document.createElement("div");
        portDiv.className = "sct-ports";
        el.appendChild(portDiv);
      }
      portDiv.innerHTML = [
        inDeg[id]  > 0 ? `<span class="sct-port sct-port-in">↑ ${inDeg[id]} in</span>`  : "",
        outDeg[id] > 0 ? `<span class="sct-port sct-port-out">↓ ${outDeg[id]} out</span>` : "",
      ].join("");
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DETAIL PANEL
  // ═══════════════════════════════════════════════════════════════════════════
  showPanel(node) {
    if (!node) return;
    document.getElementById("sct-panel-title").textContent    = node.doc_name || node.label;
    document.getElementById("sct-panel-subtitle").textContent = node.doctype  + (node.is_overdue ? " — ⚠ OVERDUE" : "");
    document.getElementById("sct-panel-body").innerHTML       = this._panelBody(node);
    document.getElementById("sct-panel-actions").innerHTML    = this._panelActions(node);
    document.getElementById("sct-panel").classList.add("open");

    // Wire up data-nav-id click handlers (avoids inline onclick XSS)
    document.querySelectorAll("#sct-panel-body [data-nav-id], #sct-panel-actions [data-nav-id]").forEach(el => {
      el.addEventListener("click", () => this._pipelineSelect(el.dataset.navId));
    });
    // Wire up data-route-item handlers
    document.querySelectorAll("#sct-panel-actions [data-route-item]").forEach(el => {
      el.addEventListener("click", () =>
        frappe.set_route("query-report", "Production Priority Board", { item_code: el.dataset.routeItem })
      );
    });
    // Wire up panel close button
    const closeBtn = document.querySelector("#sct-panel-actions [data-close-panel]");
    if (closeBtn) closeBtn.addEventListener("click", () => { this._closePanel(); });

    // Async: try to load BOM for manufactured items
    if (node.stage === "items" || node.sub_type === "output") {
      this._loadBomBlock(node.item_code || node.doc_name);
    }
  }

  _loadBomBlock(item_code) {
    if (!item_code) return;

    const _insertBlock = (items, bomName) => {
      const bodyEl = document.getElementById("sct-panel-body");
      if (!bodyEl) return;
      // Don't duplicate
      if (bodyEl.querySelector(".sct-bom-block")) return;
      const bomBlock = document.createElement("div");
      bomBlock.className = "sct-bom-block";
      bomBlock.innerHTML = `
        <div class="sct-bom-title">🔩 BOM — ${frappe.utils.escape_html(bomName)}</div>
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

    // Cache hit: null = no BOM exists, array = BOM items
    if (this._bomCache.has(item_code)) {
      const cached = this._bomCache.get(item_code);
      if (cached) _insertBlock(cached.items, cached.bomName);
      return;
    }

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
          this._bomCache.set(item_code, null);
          return;
        }
        const bomName = r.message[0].name;
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

  _closePanel() {
    this._clearSelection();
    document.getElementById("sct-panel").classList.remove("open");
  }

  _panelBody(node) {
    const parts = [];

    // Next action
    if (node.next_action) {
      const isUrgent = node.next_action.startsWith("⚠") || node.zone === "Red" || node.zone === "Black";
      parts.push(`
        <div class="sct-next-action-box${isUrgent ? " urgent" : ""}">
          <div class="sct-next-action-box-title">⬆ NEXT ACTION</div>
          <div class="sct-next-action-box-text">${node.next_action}</div>
        </div>`);
    }

    // Non-TOC notice
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

    // TOC buffer box
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
            F3: BP% = (Target − IP) / Target × 100<br>
            = (${node.target_buffer} − ${node.inventory_position}) / ${node.target_buffer} × 100
          </div>
          <div style="height:5px;background:var(--stone-100);border-radius:99px;overflow:hidden;margin-top:8px">
            <div style="width:${fill}%;height:100%;background:${this._zoneBarColor(node.zone)};border-radius:99px"></div>
          </div>
        </div>`);
    }

    // Age / overdue
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

    // Document fields
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

    // Connected documents
    const connected = this._connected(node.id);
    if (connected.upstream.length || connected.downstream.length) {
      parts.push(`
        <div class="sct-panel-section">
          <div class="sct-panel-section-title">Connected Documents</div>
          ${connected.upstream.map(n => `
            <div class="sct-panel-row" style="cursor:pointer" data-nav-id="${frappe.utils.escape_html(n.id)}">
              <span class="sct-panel-row-key" style="color:#34d399">← From</span>
              <span class="sct-panel-row-val">${frappe.utils.escape_html(n.doc_name)} <small style="color:var(--stone-400)">(${frappe.utils.escape_html(n.doctype)})</small></span>
            </div>`).join("")}
          ${connected.downstream.map(n => `
            <div class="sct-panel-row" style="cursor:pointer" data-nav-id="${frappe.utils.escape_html(n.id)}">
              <span class="sct-panel-row-key" style="color:#f59e0b">→ To</span>
              <span class="sct-panel-row-val">${frappe.utils.escape_html(n.doc_name)} <small style="color:var(--stone-400)">(${frappe.utils.escape_html(n.doctype)})</small></span>
            </div>`).join("")}
        </div>`);
    }

    return parts.join("") || `<p style="color:var(--stone-400);font-size:12px">No details available.</p>`;
  }

  _panelActions(node) {
    const actions = [];
    if (node.doctype && node.doc_name && node.stage !== "output") {
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
    // Always show a close button at the bottom
    actions.push(`<span class="sct-panel-btn sct-panel-btn-primary" data-close-panel>✕ Close</span>`);
    return actions.join("") || `<span style="font-size:12px;color:var(--stone-400)">No quick actions</span>`;
  }

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
          add("On-Hand",     node.on_hand);
          add("Target (F1)", node.target_buffer);
          add("IP (F2)",     node.inventory_position);
          add("Deficit (F4)", node.order_qty > 0 ? node.order_qty : "");
        }
        break;
    }
    return f;
  }

  _connected(id) {
    const upstream = [], downstream = [];
    this.edges.forEach(e => {
      if (e.target === id && this.nodeMap[e.source]) upstream.push(this.nodeMap[e.source]);
      if (e.source === id && this.nodeMap[e.target]) downstream.push(this.nodeMap[e.target]);
    });
    return { upstream, downstream };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CLIENT-SIDE FILTERS
  // ═══════════════════════════════════════════════════════════════════════════
  _applyClientFilters() {
    const q        = this.f.search.toLowerCase().trim();
    const fZone    = this.f.zone;
    const fDoctype = this.f.doctype;
    const fOverdue = this.f.overdue;
    const fAuto    = this.f.auto;
    const fNoaction= this.f.noaction;

    const docTypeMap = {
      "MR": "Material Request", "RFQ": "Request for Quotation",
      "SQ": "Supplier Quotation", "PP": "Production Plan",
      "WO": "Work Order", "PO": "Purchase Order", "JC": "Job Card",
      "PR": "Purchase Receipt", "SE": "Stock Entry",
    };
    const allowedDoctype = fDoctype !== "All" ? docTypeMap[fDoctype] : null;

    let visibleTracks = this.tracks.filter(track => {
      if (fZone !== "All" && track.zone !== fZone) return false;
      if (fOverdue && track.overdue_count === 0) return false;
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

    let visibleNodes = this.nodes.filter(node => {
      if (fZone !== "All") {
        if (node.stage === "items" && node.zone !== fZone) return false;
      }
      if (allowedDoctype && node.doctype !== allowedDoctype && node.stage !== "items" && node.stage !== "output") return false;
      if (fOverdue && !node.is_overdue && node.stage !== "items" && node.stage !== "output") return false;
      if (fAuto && node.stage !== "items" && node.stage !== "output" && node.recorded_by !== "By System") return false;

      if (q) {
        const s = `${node.doc_name} ${node.label} ${node.description} ${node.supplier || ""}`.toLowerCase();
        if (!s.includes(q)) return false;
      }
      return true;
    });

    // Propagate zone filter to reachable nodes
    if (fZone !== "All") {
      const seeds = new Set(visibleNodes.filter(n => n.stage === "items").map(n => n.id));
      visibleNodes = [...this._reachable(seeds, visibleNodes.map(n => n.id))].map(id => this.nodeMap[id]).filter(Boolean);
    }

    return { visibleNodes, visibleTracks };
  }

  _reachable(seeds, nodeIdSet) {
    const nodeSet = new Set(nodeIdSet);
    const fwd = {}, bwd = {};
    this.edges.forEach(e => {
      if (nodeSet.has(e.source)) (fwd[e.source] = fwd[e.source] || []).push(e.target);
      if (nodeSet.has(e.target)) (bwd[e.target] = bwd[e.target] || []).push(e.source);
    });
    const visited = new Set(seeds);
    const q = [...seeds];
    while (q.length) {
      const cur = q.shift();
      [...(fwd[cur] || []), ...(bwd[cur] || [])].forEach(nb => {
        if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
      });
    }
    return visited;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EVENT BINDINGS
  // ═══════════════════════════════════════════════════════════════════════════
  _bindCommandBar() {
    // Search input with debounce
    const searchEl = document.getElementById("sct-search");
    const clearEl  = document.getElementById("sct-search-clear");
    let debounce;
    searchEl?.addEventListener("input", () => {
      this.f.search = searchEl.value;
      clearEl.style.display = this.f.search ? "block" : "none";
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 280);
    });
    clearEl?.addEventListener("click", () => {
      searchEl.value = "";
      this.f.search  = "";
      clearEl.style.display = "none";
      this.render();
    });

    // View mode
    document.querySelectorAll(".sct-view-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (view === this.viewMode) return;
        this.viewMode = view;
        document.querySelectorAll(".sct-view-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("sct-tracker-wrap").classList.toggle("active",  view === "tracker");
        document.getElementById("sct-pipeline-wrap").classList.toggle("active", view === "pipeline");
        this._clearSelection();
        this._closePanel();
        if (view === "pipeline") this.render();
      });
    });

    // Filter toggle
    document.getElementById("sct-filter-toggle")?.addEventListener("click", () => {
      const panel = document.getElementById("sct-filter-panel");
      const btn   = document.getElementById("sct-filter-toggle");
      panel.classList.toggle("open");
      btn.classList.toggle("active", panel.classList.contains("open"));
    });

    // Days-back select
    document.getElementById("sct-days-select")?.addEventListener("change", (e) => {
      this.f.days_back = parseInt(e.target.value);
      this.load();
    });

    // Pipeline scroll redraw
    const scroll = document.getElementById("sct-pipeline-scroll");
    if (scroll) {
      let raf;
      const redraw = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const { visibleNodes } = this._applyClientFilters();
          this._drawEdges(new Set(visibleNodes.map(n => n.id)));
        });
      };
      scroll.addEventListener("scroll", redraw, { passive: true });
      window.addEventListener("resize", redraw);
    }

    // Click pipeline background to deselect
    document.getElementById("sct-pipeline-scroll")?.addEventListener("click", e => {
      if (!e.target.closest(".sct-card")) { this._clearSelection(); this._closePanel(); }
    });
  }

  _bindFilterPanel() {
    document.getElementById("sct-filter-panel")?.addEventListener("click", e => {
      const pill = e.target.closest(".sct-fpill");
      if (!pill) return;
      const group = pill.dataset.f;
      const val   = pill.dataset.v;
      document.querySelectorAll(`.sct-fpill[data-f="${group}"]`).forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      if      (group === "type")    this.f.type    = val;
      else if (group === "zone")    this.f.zone    = val;
      else if (group === "doctype") this.f.doctype = val;
    });

    document.getElementById("sct-btn-apply")?.addEventListener("click", () => {
      this.f.supplier  = document.getElementById("sct-f-supplier")?.value.trim()  || "";
      this.f.warehouse = document.getElementById("sct-f-warehouse")?.value.trim() || "";
      this.f.overdue   = document.getElementById("sct-f-overdue")?.checked  || false;
      this.f.auto      = document.getElementById("sct-f-auto")?.checked     || false;
      this.f.noaction  = document.getElementById("sct-f-noaction")?.checked || false;

      const needReload = this.f.supplier || this.f.warehouse;
      if (needReload) this.load(); else this.render();
    });

    document.getElementById("sct-btn-reset")?.addEventListener("click", () => {
      this.f = { ...this.f, type: "All", zone: "All", doctype: "All", supplier: "", warehouse: "", overdue: false, auto: false, noaction: false };
      document.querySelectorAll(".sct-fpill").forEach(p => {
        p.classList.toggle("active", p.dataset.v === "All");
      });
      // Clear custom dropdowns
      ["sct-dd-supplier", "sct-dd-warehouse"].forEach(id => {
        const wrap = document.getElementById(id);
        if (!wrap) return;
        const inp = wrap.querySelector(".sct-dd-input");
        if (inp) { inp.value = ""; inp.classList.remove("has-value"); }
        wrap.classList.remove("has-value", "open");
      });
      ["sct-f-overdue","sct-f-auto","sct-f-noaction"].forEach(id => { const el = document.getElementById(id); if (el) el.checked = false; });
      this.render();
    });
  }

  _bindPanel() {
    document.getElementById("sct-panel-close")?.addEventListener("click", () => {
      this._clearSelection();
      this._closePanel();
    });
  }

  _bindSummaryClicks() {
    document.querySelectorAll(".sct-stat[data-zone]").forEach(stat => {
      stat.addEventListener("click", () => {
        const zone = stat.dataset.zone;
        this.f.zone = zone;
        document.querySelectorAll(`.sct-fpill[data-f="zone"]`).forEach(p => {
          p.classList.toggle("active", p.dataset.v === zone);
        });
        this.render();
      });
    });
  }

  _loadFilterOptions() {
    frappe.call({
      method: "chaizup_toc.api.pipeline_api.get_filter_options",
      callback: (r) => {
        if (!r.message) return;
        const { suppliers = [], warehouses = [] } = r.message;
        this._initSearchDropdown("sct-dd-supplier",  "sct-f-supplier",  suppliers);
        this._initSearchDropdown("sct-dd-warehouse", "sct-f-warehouse", warehouses);
      },
    });
  }

  /**
   * Initialise a custom searchable dropdown.
   * The committed value is always readable from the input's .value property.
   *
   * @param {string}   wrapperId  – id of the .sct-dd wrapper element
   * @param {string}   inputId    – id of the text input inside it
   * @param {string[]} items      – full option list
   */
  _initSearchDropdown(wrapperId, inputId, items) {
    const wrap   = document.getElementById(wrapperId);
    const input  = document.getElementById(inputId);
    const list   = wrap?.querySelector(".sct-dd-list");
    const clear  = wrap?.querySelector(".sct-dd-clear");
    if (!wrap || !input || !list) return;

    // Internal state
    let focusIdx  = -1;
    let open      = false;
    let committed = "";   // the value that has been formally selected

    const _highlight = (text, query) => {
      if (!query) return frappe.utils.escape_html(text);
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx === -1) return frappe.utils.escape_html(text);
      return frappe.utils.escape_html(text.slice(0, idx))
        + `<mark>${frappe.utils.escape_html(text.slice(idx, idx + query.length))}</mark>`
        + frappe.utils.escape_html(text.slice(idx + query.length));
    };

    const _render = (q) => {
      const q_lower = (q || "").toLowerCase().trim();
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
          e.preventDefault();   // don't blur input
          _select(item);
        });
        list.appendChild(el);
      });
    };

    const _open = () => {
      if (open) return;
      open = true;
      wrap.classList.add("open");
      _render(input.value);
    };

    const _close = () => {
      if (!open) return;
      open = false;
      wrap.classList.remove("open");
      focusIdx = -1;
      // If user typed something that doesn't match a committed value, revert
      if (input.value !== committed) {
        input.value = committed;
        input.classList.toggle("has-value", !!committed);
        wrap.classList.toggle("has-value", !!committed);
      }
    };

    const _select = (val) => {
      committed = val;
      input.value = val;
      input.classList.add("has-value");
      wrap.classList.add("has-value");
      _close();
    };

    const _clearValue = () => {
      committed = "";
      input.value = "";
      input.classList.remove("has-value");
      wrap.classList.remove("has-value");
      _close();
    };

    const _moveFocus = (dir) => {
      const rows = list.querySelectorAll(".sct-dd-item");
      if (!rows.length) return;
      rows[focusIdx]?.classList.remove("focused");
      focusIdx = Math.max(0, Math.min(rows.length - 1, focusIdx + dir));
      rows[focusIdx].classList.add("focused");
      rows[focusIdx].scrollIntoView({ block: "nearest" });
    };

    // ── Event listeners ─────────────────────────────────────────────────────
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

    // Close when clicking outside
    document.addEventListener("mousedown", (e) => {
      if (!wrap.contains(e.target)) _close();
    }, { capture: true });

    // Clear button
    clear?.addEventListener("click", (e) => {
      e.stopPropagation();
      _clearValue();
      input.focus();
    });

    // Pre-populate if a value is already committed (e.g., after reset flow)
    if (committed) {
      input.value = committed;
      input.classList.add("has-value");
      wrap.classList.add("has-value");
    }
  }

  // ── Summary strip ──────────────────────────────────────────────────────────
  _updateSummary(s, meta) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v ?? "—"; };
    set("sct-s-red",    s.red    ?? 0);
    set("sct-s-yellow", s.yellow ?? 0);
    set("sct-s-green",  s.green  ?? 0);
    set("sct-s-mrs",    s.mrs    ?? 0);
    set("sct-s-wos",    s.wos    ?? 0);
    set("sct-s-pos",    s.pos    ?? 0);
    set("sct-s-items",  meta.total_items ?? 0);
    const overdueCount = this.tracks.filter(t => t.overdue_count > 0).length;
    set("sct-s-overdue", overdueCount);
  }

  _updateFilterBadge() {
    let count = 0;
    if (this.f.type    !== "All") count++;
    if (this.f.zone    !== "All") count++;
    if (this.f.doctype !== "All") count++;
    if (this.f.supplier)          count++;
    if (this.f.warehouse)         count++;
    if (this.f.overdue)           count++;
    if (this.f.auto)              count++;
    if (this.f.noaction)          count++;
    if (this.f.search)            count++;
    const badge = document.getElementById("sct-filter-badge");
    if (badge) {
      badge.style.display = count > 0 ? "inline" : "none";
      badge.textContent   = count;
    }
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  _setLoading(show) {
    const el = document.getElementById("sct-loading");
    if (el) el.style.display = show ? "flex" : "none";
  }

  // ── Badge / color helpers ──────────────────────────────────────────────────
  _zoneBadge(zone) {
    if (!zone) return "";
    const icons = { Red: "🔴", Yellow: "🟡", Green: "🟢", Black: "⚫" };
    return `<span class="sct-zone-badge zone-${zone}">${icons[zone] || ""} ${zone}</span>`;
  }

  _zoneBarColor(zone) {
    return { Red: "#dc2626", Yellow: "#d97706", Green: "#16a34a", Black: "#374151" }[zone] || "#78716c";
  }

  _statusBadge(status) {
    if (!status && status !== 0) return "";
    return `<span class="sct-badge ${this._statusBadgeClass(status)}">${status}</span>`;
  }

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
