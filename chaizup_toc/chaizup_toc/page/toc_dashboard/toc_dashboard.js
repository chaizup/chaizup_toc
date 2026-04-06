/**
 * toc_dashboard.js — Frappe Desk Page Controller
 * Modern Minimalist Design · Frappe Native Patterns
 */

frappe.pages["toc-dashboard"].on_page_load = function (wrapper) {
  if (wrapper.toc_initialized) return;
  wrapper.toc_initialized = true;

  var page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "TOC Dashboard",
    single_column: true,
  });

  // ── Primary button ──
  page.add_inner_button(__("Refresh Data"), () => dash.load()).addClass("btn-primary-dark");

  // ── Menu items ──
  page.add_menu_item(__("Full Kitting Report"), () =>
    frappe.set_route("kitting-report"));
  page.add_menu_item(__("TOC Settings"), () =>
    frappe.set_route("Form", "TOC Settings", "TOC Settings"));
  page.add_menu_item(__("Production Priority Board"), () =>
    frappe.set_route("query-report", "Production Priority Board"));
  page.add_menu_item(__("Procurement Action List"), () =>
    frappe.set_route("query-report", "Procurement Action List"));
  page.add_menu_item(__("User Guide"), () =>
    window.open("/toc-user-guide", "_blank"));

  // ── Demo Data (Administrator only) ──
  if (frappe.user.has_role("Administrator")) {
    page.add_menu_item(__("🧪 Create Demo Data"), function () {
      frappe.confirm(
        "<b>Create TOC Demo Data?</b><br><br>" +
        "Creates 7 test items (FG, SFG, RM, PM) with stock, BOMs, and delivery notes " +
        "to exercise all TOC scenarios (Red, Yellow, Green zones).<br><br>" +
        "All documents prefixed with <code>TOC-DEMO-</code> and tracked for one-click cleanup.",
        function () {
          frappe.call({
            method: "chaizup_toc.api.demo_data.create_demo_data",
            freeze: true,
            freeze_message: "Creating test items, stock, BOMs, delivery notes...",
            callback: function (r) {
              if (r.message && r.message.status === "success") {
                frappe.msgprint({
                  title: __("Demo Data Created"),
                  indicator: "green",
                  message: r.message.message +
                    "<br><br><b>Next:</b> Click Refresh to see demo items in the table."
                });
                if (window.dash) dash.load();
              }
            }
          });
        }
      );
    });

    page.add_menu_item(__("🗑️ Delete Demo Data"), function () {
      frappe.call({
        method: "chaizup_toc.api.demo_data.get_demo_status",
        callback: function (r) {
          if (!r.message || !r.message.exists) {
            frappe.msgprint("No demo data found.");
            return;
          }
          frappe.confirm(
            "<b>Delete ALL demo data?</b><br>" +
            "Will permanently delete <b>" + r.message.count + " documents</b>.",
            function () {
              frappe.call({
                method: "chaizup_toc.api.demo_data.delete_demo_data",
                freeze: true,
                freeze_message: "Deleting demo data...",
                callback: function (r) {
                  if (r.message) {
                    frappe.msgprint({
                      title: __("Deleted"),
                      indicator: "green",
                      message: r.message.message
                    });
                    if (window.dash) dash.load();
                  }
                }
              });
            }
          );
        }
      });
    });
  }

  // ── Filter bar ──
  page.add_field({
    label: __("Buffer Type"), fieldname: "buffer_type", fieldtype: "Select",
    options: ["All", "FG", "RM", "PM", "SFG"].join("\n"), default: "All",
    change() { dash.applyFilter(); },
  });
  page.add_field({
    label: __("Zone"), fieldname: "zone_filter", fieldtype: "Select",
    options: ["All", "Red", "Yellow", "Green", "Black"].join("\n"), default: "All",
    change() { dash.applyFilter(); },
  });
  page.add_field({
    label: __("Company"), fieldname: "company", fieldtype: "Link",
    options: "Company", default: frappe.defaults.get_user_default("Company"),
    change() { dash.load(); },
  });

  // ── Mount HTML template ──
  $(frappe.render_template("toc_dashboard", {})).appendTo(page.body);

  // ── Start controller ──
  window.dash = new TOCDashboard(page);
  dash.load();

  // Auto-refresh every 5 min
  dash._refreshTimer = setInterval(() => dash.load(), 5 * 60 * 1000);
};

frappe.pages["toc-dashboard"].on_page_hide = function () {
  if (window.dash && window.dash._refreshTimer) {
    clearInterval(window.dash._refreshTimer);
  }
};

/* ══════════════════════════════════════════════════════════════════
   DASHBOARD CONTROLLER
══════════════════════════════════════════════════════════════════ */
class TOCDashboard {
  constructor(page) {
    this.page = page;
    this.allData = [];
    this.filteredData = [];
  }

  load() {
    this._setLoading(true);
    const company = this.page.fields_dict.company.get_value();

    Promise.all([
      this._call("chaizup_toc.api.toc_api.get_buffer_summary"),
      this._call("chaizup_toc.api.toc_api.get_priority_board", {
        buffer_type: null,
        company: company || null,
      }),
    ])
      .then(([summary, board]) => {
        this.allData = board || [];
        this._renderSummaryCards(summary || {});
        this.applyFilter();
        this._updateTimestamp();
        this._setLoading(false);
      })
      .catch((err) => {
        this._setLoading(false);
        this._showError(err);
      });
  }

  applyFilter() {
    const bt = this.page.fields_dict.buffer_type.get_value();
    const zf = this.page.fields_dict.zone_filter.get_value();

    this.filteredData = this.allData.filter((r) => {
      const btOk = !bt || bt === "All" || r.buffer_type === bt;
      const zOk  = !zf || zf === "All" || r.zone === zf;
      return btOk && zOk;
    });

    this._renderPriorityTable(this.filteredData);
    this._renderZoneChart(this.filteredData);
  }

  _renderSummaryCards(s) {
    const cards = [
      { id: "sc-red", val: s.Red || 0 },
      { id: "sc-yel", val: s.Yellow || 0 },
      { id: "sc-grn", val: s.Green || 0 },
      { id: "sc-avg", val: (s.avg_bp_pct || 0) + "%" },
    ];
    cards.forEach((c) => {
      const el = document.getElementById(c.id);
      if (el) el.querySelector(".sc-val").textContent = c.val;
    });
  }

  _renderPriorityTable(data) {
    const tbody = document.getElementById("toc-tbody");
    if (!tbody) return;

    if (!data || data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="toc-table-placeholder">
        No buffer data found. <a href="/app/item" style="color:var(--primary-color,#2563eb);font-weight:500">
        Enable TOC on items</a> to begin.</td></tr>`;
      return;
    }

    // Only users with MR-trigger permission see the action button
    const canTrigger = frappe.user.has_role(["System Manager", "Stock Manager", "TOC Manager"]);

    tbody.innerHTML = data.map((r, i) => {
      const zone = r.zone || "Green";
      const bp   = parseFloat(r.bp_pct || 0).toFixed(1);
      const sr   = parseFloat(r.sr_pct || 0).toFixed(1);
      const oh   = this._fmt(r.on_hand);
      const tgt  = this._fmt(r.target_buffer);
      const qty  = this._fmt(Math.max(0, (r.target_buffer||0) - (r.inventory_position||0)));
      const zColors = { Red:"#dc2626", Yellow:"#d97706", Green:"#059669", Black:"#475569" };
      const zc   = zColors[zone] || zColors.Green;
      const bar  = this._barHTML(parseFloat(sr), zone);
      const pill = this._zonePill(zone);
      const isRed = zone === "Red" || zone === "Black";

      const actionBtn = canTrigger
        ? `<button class="toc-btn-mr ${isRed?"toc-btn-urgent":""}"
            onclick="dash._openMR('${r.item_code}','${r.warehouse||""}','${r.buffer_type||"FG"}',${Math.max(0,(r.target_buffer||0)-(r.inventory_position||0))})">
            ${isRed ? "Action Now" : "Plan"}
          </button>`
        : `<span style="color:#9ca3af;font-size:11px">${isRed ? "🔴 Urgent" : zone}</span>`;

      return `<tr>
        <td><span style="color:#9ca3af;font-size:12px;font-weight:600">${i+1}</span></td>
        <td>
          <a href="/app/item/${encodeURIComponent(r.item_code)}" class="toc-item-link">${r.item_name || r.item_code}</a>
          <div class="toc-item-sub">${r.item_code} · ${r.warehouse||""} · ${r.buffer_type||""}</div>
        </td>
        <td class="toc-num">${tgt}</td>
        <td class="toc-num" style="font-weight:600">${oh}</td>
        <td class="toc-num" style="color:${zc};font-weight:600">${bp}%</td>
        <td class="toc-num" style="color:#6b7280">${sr}%</td>
        <td>${pill}</td>
        <td>${bar}</td>
        <td class="toc-num" style="font-weight:600">${qty}</td>
        <td>${actionBtn}</td>
      </tr>`;
    }).join("");
  }

  _renderZoneChart(data) {
    const el = document.getElementById("toc-zone-chart");
    if (!el) return;

    const counts = { Red:0, Yellow:0, Green:0, Black:0 };
    data.forEach((r) => { counts[r.zone] = (counts[r.zone]||0) + 1; });
    const total = data.length || 1;

    const segments = [
      { zone:"Red",    color:"#ef4444", count:counts.Red },
      { zone:"Yellow", color:"#f59e0b", count:counts.Yellow },
      { zone:"Green",  color:"#10b981", count:counts.Green },
      { zone:"Black",  color:"#64748b", count:counts.Black },
    ];

    let offset = 0;
    const cx=50, cy=50, r=40, stroke=14;
    const circ = 2 * Math.PI * r;

    const arcs = segments.map((s) => {
      if (s.count === 0) return "";
      const pct = s.count / total;
      const dash = pct * circ;
      const arc = `<circle cx="${cx}" cy="${cy}" r="${r}"
        fill="none" stroke="${s.color}" stroke-width="${stroke}"
        stroke-linecap="round"
        stroke-dasharray="${Math.max(0, dash-2)} ${circ}"
        stroke-dashoffset="${-offset * circ}"
        style="transition:stroke-dasharray 0.6s ease,stroke-dashoffset 0.6s ease;transform-origin:50px 50px"/>`;
      offset += pct;
      return arc;
    });

    el.innerHTML = `
      <svg viewBox="0 0 100 100" width="100" height="100" style="transform:rotate(-90deg);filter:drop-shadow(0 1px 2px rgba(0,0,0,0.05))">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="${stroke}"/>
        ${arcs.join("")}
      </svg>
      <div class="toc-chart-legend">
        ${segments.map((s) => `
          <div class="toc-legend-row">
            <span style="background:${s.color}" class="toc-legend-dot"></span>
            <span>${s.zone}</span>
            <span class="toc-legend-val">${s.count}</span>
          </div>`).join("")}
      </div>`;
  }

  _openMR(itemCode, warehouse, bufferType, qty) {
    const isFG = bufferType === "FG" || bufferType === "SFG";
    const mrType = isFG ? "Manufacture" : "Purchase";

    frappe.confirm(
      `Run <b>${mrType}</b> Material Request generation for all <b>${bufferType}</b> items?<br><br>
       <span style="color:#6b7280;font-size:13px">Triggered by:</span> <b>${itemCode}</b>
       (Deficit: ${this._fmt(qty)})<br>
       <span style="color:#6b7280;font-size:13px">Note:</span>
       <span style="color:#6b7280;font-size:12px">This generates MRs for <b>all</b>
       Red/Black/Yellow ${bufferType} items — not just this one.</span>`,
      () => {
        frappe.call({
          method: "chaizup_toc.api.toc_api.trigger_manual_run",
          args: { buffer_type: bufferType, zone_filter: JSON.stringify(["Red","Black","Yellow"]) },
          callback(r) {
            if (r.message && r.message.status === "success") {
              frappe.show_alert({
                message: `Created ${r.message.created} Material Request(s)`,
                indicator: "green",
              });
              dash.load();
            }
          },
        });
      }
    );
  }

  /* ── Helpers ── */
  _call(method, args = {}) {
    return new Promise((resolve, reject) => {
      frappe.call({ method, args, callback: (r) => resolve(r.message), error: reject });
    });
  }

  _fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN");
  }

  _setLoading(on) {
    const el = document.getElementById("toc-loading");
    if (el) el.style.display = on ? "flex" : "none";
    const root = document.getElementById("toc-dash-root");
    if (root) {
      if (on) root.classList.add("is-loading");
      else root.classList.remove("is-loading");
    }
  }

  _showError(err) {
    const msg = err && err.message ? err.message : JSON.stringify(err);
    frappe.show_alert({ message: "Dashboard error: " + msg, indicator: "red" });
  }

  _updateTimestamp() {
    const el = document.getElementById("toc-last-updated");
    if (el) el.textContent = "Last sync: " + frappe.datetime.now_time();
  }

  _barHTML(srPct, zone) {
    const w = Math.min(100, Math.max(0, srPct)).toFixed(1);
    const colors = { Green:"#10b981", Yellow:"#f59e0b", Red:"#ef4444", Black:"#64748b" };
    return `<div class="toc-bar-track">
      <div class="toc-bar-fill" style="width:${w}%;background:${colors[zone]||colors.Green}"></div>
    </div>`;
  }

  _zonePill(zone) {
    const cfg = { Red:{cls:"toc-pill-red"}, Yellow:{cls:"toc-pill-yel"}, Green:{cls:"toc-pill-grn"}, Black:{cls:"toc-pill-blk"} };
    const c = cfg[zone] || cfg.Green;
    return `<span class="toc-pill ${c.cls}">${zone}</span>`;
  }
}
