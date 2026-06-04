// Copyright (c) 2026, Chaizup and contributors
// For license information, please see license.txt
//
// =============================================================================
// CONTEXT: TOC Settings client-side handlers — manual trigger for Sales
//   Projection Automation (Calc A + Calc B). Server-side entry point is
//   `chaizup_toc.toc_engine.production_plan_engine.run_projection_automation_for_all_warehouses`.
// MEMORY: app_chaizup_toc.md § Sales Projection Automation
// RESTRICT:
//   - Do NOT change the whitelisted method name without updating the engine
//     decorator AND the projection_overview page if it also calls it.
//   - Do NOT remove the disabled-while-running guard — without it, an impatient
//     user can fire the cron mid-run and create duplicate Production Plans.
// =============================================================================

frappe.ui.form.on("TOC Settings", {
    refresh(frm) {
        _wire_projection_run_button(frm);
        _wire_so_shortage_run_button(frm);
        _wire_shortage_action_run_button(frm);
    },
});

function _wire_shortage_action_run_button(frm) {
    // SPA-001 (2026-05-14): manual trigger for run_shortage_action_automation.
    // Iterates Item Minimum Manufacture rows with auto_on_shortage=1 OR
    // auto_on_max_level=1 and creates PPs / MRs per row.action_type.
    if (!frm.fields_dict.run_shortage_action_automation_now) return;
    const $btn = frm.fields_dict.run_shortage_action_automation_now.$wrapper.find("button");
    if (!$btn.length) return;
    const reset_btn = () => $btn.prop("disabled", false).text(__("Run Shortage Action Now"));

    $btn.off("click.toc-sa").on("click.toc-sa", () => {
        frappe.confirm(
            __(
                "Iterate every <b>Item Minimum Manufacture</b> row where <i>Auto on Shortage</i> or <i>Auto on Max Level</i> is enabled, and create a Production Plan or Material Request per <i>Action Type</i> when a trigger fires.<br><br>" +
                    "<b>Shortage mode</b>: <code>(pending SO + WO required) &minus; (stock + open WO) &gt; 0</code><br>" +
                    "<b>Max-level mode</b>: <code>cover% &lt; row threshold</code> where <code>cover = (stock + open WO + open PO) &minus; (pending SO + WO required)</code>.<br><br>" +
                    "Continue?"
            ),
            () => {
                $btn.prop("disabled", true).text(__("Running…"));
                frappe.call({
                    method:
                        "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_shortage_action_automation",
                    args: { triggered_by: "shortage_action_manual" },
                    freeze: true,
                    freeze_message: __("Evaluating Shortage Action triggers and creating artifacts…"),
                    callback: (r) => {
                        reset_btn();
                        if (!r.message) return;
                        const m = r.message;
                        const log_link = m.run_log
                            ? `<a href="/app/toc-production-plan-run-log/${frappe.utils.escape_html(m.run_log)}" target="_blank">${frappe.utils.escape_html(m.run_log)}</a>`
                            : "&mdash;";
                        frappe.msgprint({
                            title: __("Shortage Action Run Complete"),
                            message:
                                `<div style="font-size:13px;line-height:1.7">` +
                                `<div><b>Run Log:</b> ${log_link}</div>` +
                                `<div><b>Rows evaluated:</b> ${m.evaluated || 0}</div>` +
                                `<div><b>Artifacts created:</b> ${m.created || 0}</div>` +
                                `<div><b>Skipped:</b> ${m.skipped || 0}</div>` +
                                `<div><b>Errors:</b> ${m.errors || 0}</div>` +
                                `<p style="margin-top:10px;color:#888;font-size:12px">${frappe.utils.escape_html(m.message || "")}</p>` +
                                `</div>`,
                            indicator: (m.created || 0) > 0 ? "green" : ((m.errors || 0) > 0 ? "red" : "orange"),
                        });
                    },
                    error: () => reset_btn(),
                });
            }
        );
    });
}

function _wire_so_shortage_run_button(frm) {
    // SPE-001 (2026-05-13): manual trigger for run_so_shortage_automation.
    // Independent of any Sales Projection. Same disabled-while-running
    // guard as the projection runner so a double-click cannot fire the
    // engine twice and create duplicate PPs before the first commit lands.
    if (!frm.fields_dict.run_so_shortage_automation_now) return;
    const $btn = frm.fields_dict.run_so_shortage_automation_now.$wrapper.find("button");
    if (!$btn.length) return;

    const reset_btn = () => $btn.prop("disabled", false).text(__("Run Sales Order Shortage Now"));

    $btn.off("click.toc-so").on("click.toc-so", () => {
        frappe.confirm(
            __(
                "Scan every <b>pending Sales Order</b> (across all items and warehouses) and create Production Plans for any (item &times; warehouse) where:<br>" +
                    "<code>pending SO qty &minus; stock &minus; open WO &gt; 0</code> (all in stock UOM)<br><br>" +
                    "PP qty = <code>max(shortage, MINMFG per-warehouse)</code>. Each decision is logged in <b>TOC Production Plan Run Log</b> with marker <code>[Calc SO]</code>.<br><br>" +
                    "Continue?"
            ),
            () => {
                $btn.prop("disabled", true).text(__("Running…"));
                frappe.call({
                    method:
                        "chaizup_toc.chaizup_toc.toc_engine.production_plan_engine.run_so_shortage_automation",
                    args: { triggered_by: "so_shortage_manual" },
                    freeze: true,
                    freeze_message: __("Scanning pending Sales Orders and creating Production Plans…"),
                    callback: (r) => {
                        reset_btn();
                        if (!r.message) return;
                        const m = r.message;
                        const log_link = m.run_log
                            ? `<a href="/app/toc-production-plan-run-log/${frappe.utils.escape_html(m.run_log)}" target="_blank">${frappe.utils.escape_html(m.run_log)}</a>`
                            : "&mdash;";
                        frappe.msgprint({
                            title: __("Sales Order Shortage Run Complete"),
                            message:
                                `<div style="font-size:13px;line-height:1.7">` +
                                `<div><b>Run Log:</b> ${log_link}</div>` +
                                `<div><b>Pairs scanned (item &times; warehouse):</b> ${m.pairs || 0}</div>` +
                                `<div><b>Production Plans created:</b> ${m.created || 0}</div>` +
                                `<div><b>Skipped:</b> ${m.skipped || 0}</div>` +
                                `<div><b>Errors:</b> ${m.errors || 0}</div>` +
                                `<p style="margin-top:10px;color:#888;font-size:12px">${frappe.utils.escape_html(m.message || "")}</p>` +
                                `</div>`,
                            indicator: (m.created || 0) > 0 ? "green" : ((m.errors || 0) > 0 ? "red" : "orange"),
                        });
                    },
                    error: () => reset_btn(),
                });
            }
        );
    });
}

function _wire_projection_run_button(frm) {
    // The Button field is rendered as a plain field; we attach our handler in JS.
    if (!frm.fields_dict.run_projection_automation_now) return;

    const $btn = frm.fields_dict.run_projection_automation_now.$wrapper.find("button");
    if (!$btn.length) return;

    $btn.off("click.toc").on("click.toc", () => {
        if (!frm.doc.enable_projection_automation) {
            frappe.msgprint({
                title: __("Automation disabled"),
                message: __("Enable 'Enable Projection Automation' first."),
                indicator: "orange",
            });
            return;
        }

        frappe.confirm(
            __(
                "Run Calc A (forecast) + Calc B (SO-driven) now for every submitted Sales Projection of the current month?<br><br>" +
                    "Each decision will be logged in <b>TOC Production Plan Run Log</b>. Production Plans are created (and submitted) for items with shortage > 0."
            ),
            () => {
                $btn.prop("disabled", true).text(__("Running…"));
                frappe.call({
                    method:
                        "chaizup_toc.toc_engine.production_plan_engine.run_projection_automation_for_all_warehouses",
                    args: { triggered_by: "manual_button" },
                    callback: (r) => {
                        $btn.prop("disabled", false).text(__("Run Now (Calc A + Calc B)"));
                        if (r.message) {
                            const summary = r.message;
                            frappe.msgprint({
                                title: __("Run Complete"),
                                message:
                                    `<b>Calc A (Forecast):</b> Created ${summary.calc_a_created || 0} · Skipped ${summary.calc_a_skipped || 0}<br>` +
                                    `<b>Calc B (SO-driven):</b> Created ${summary.calc_b_created || 0} · Skipped ${summary.calc_b_skipped || 0}<br><br>` +
                                    `<a href="/app/toc-production-plan-run-log?filters=%5B%5B%22run_started%22%2C%22%3E%3D%22%2C%22${frappe.datetime.now_datetime()}%22%5D%5D">View Run Log →</a>`,
                                indicator: "green",
                            });
                        }
                    },
                    error: () => {
                        $btn.prop("disabled", false).text(__("Run Now (Calc A + Calc B)"));
                    },
                });
            }
        );
    });
}


// =============================================================================
// v0.0.27 (2026-05-27) — Pending pair multi-select widget for the 6 pending
//   fields. Each field is stored as a Small Text where each line is a
//   `<status>|<workflow_state>` key (either side may be blank). The widget
//   below transforms the textarea control into:
//
//     - a chip strip showing each selected pair as a "Status : Workflow" pill
//     - a fixed-position dropdown with the live (status, workflow_state)
//       pairs found on the relevant voucher table
//     - a search box, Select-all / Clear actions, "N of M selected" footer
//
//   Six wirings: pending_so_statuses + pending_so_workflow_states +
//                pending_wo_statuses + pending_wo_workflow_states +
//                pending_po_statuses + pending_po_workflow_states.
//
//   Each widget calls the SAME backend whitelisted method
//   chaizup_toc.api.item_short_surplus_api.get_filter_options to fetch the
//   per-voucher pair list; this is the single source of truth for
//   "what pairs exist in the data right now". The pairs are then
//   rendered using the same dual-pill design used in the Item Short / Surplus
//   report (visual continuity across the app).
//
// RESTRICT (CRITICAL — read before changing):
//   - The underlying field STAYS `Small Text` (newline-separated lines).
//     This preserves backward compatibility with the engine's existing
//     parsers — switching to a JSON column would break every site already
//     running the v0.0.26 parser logic.
//   - Each line MUST be exactly `<status>|<workflow_state>`. The `|`
//     separator is safe because Frappe Status / Workflow State values
//     never contain `|`. If a future ERPNext version changes this,
//     update the backend `_extract_pair_side` AND this widget together.
//   - The 4 "Pending …" fields show only docstatus=1 pairs; the 2
//     "Draft … Workflow" fields show only docstatus=0 pairs. The
//     dropdown's `docstatus_scope` arg routes which list the API serves.
//   - DO NOT use frappe.ui.form.MultiSelect — it doesn't handle the
//     status:workflow dual-pill rendering or the fixed-position
//     overflow-safe panel that Frappe's transformed Desk layout requires.
//     The custom widget below is intentional.
//   - DO NOT remove the cleanup hook on form refresh — the dropdown is
//     appended to <body> to escape transformed ancestors, so leaving the
//     form un-cleaned would leave orphaned panels on screen.
// =============================================================================

(function () {
    // Pair-widget state attached to the form so multiple refreshes don't
    // double-mount. Each entry: { panel, btn, chips, optionsCache }.
    const PAIR_FIELDS = [
        // v0.0.28 — Sales Order pair field is the renamed
        // `projection_pending_so_statuses` (the legacy
        // `projection_confirmed_so_workflow_states` has been MERGED into
        // this single field by the v0.0.28 patch). One unified SO field
        // covering both submit-status pairs AND draft-workflow pairs.
        { field: "projection_pending_so_statuses", dtype: "Sales Order",    docstatus_scope: "both" },
        { field: "pending_wo_statuses",            dtype: "Work Order",     docstatus_scope: 1 },
        { field: "pending_wo_workflow_states",     dtype: "Work Order",     docstatus_scope: 0 },
        { field: "pending_po_statuses",            dtype: "Purchase Order", docstatus_scope: 1 },
        { field: "pending_po_workflow_states",     dtype: "Purchase Order", docstatus_scope: 0 },
    ];

    // Once-only CSS — defines the chip strip, dropdown panel, dual-pill rows.
    // Scoped via the `tocs-pair-` prefix so it doesn't collide with the
    // Item Short / Surplus styles that use `iss-` prefixes.
    function _ensureStyle() {
        if (document.getElementById("tocs-pair-style")) return;
        const css = `
            .tocs-pair-host { margin-top: 4px; }
            .tocs-pair-chips {
                display: flex; flex-wrap: wrap; gap: 4px;
                min-height: 32px; padding: 4px 28px 4px 6px; position: relative;
                background: var(--input-bg, #fff);
                border: 1px solid var(--border-color, #d1d5db);
                border-radius: var(--border-radius-sm, 4px);
                cursor: pointer; transition: border-color 120ms ease;
            }
            .tocs-pair-chips:hover { border-color: var(--primary, #2563eb); }
            .tocs-pair-chips.tocs-open { border-color: var(--primary, #2563eb);
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15); }
            .tocs-pair-caret {
                position: absolute; right: 8px; top: 50%;
                transform: translateY(-50%);
                color: var(--text-muted, #94a3b8); font-size: 11px; pointer-events: none;
            }
            .tocs-pair-placeholder {
                color: var(--text-muted, #94a3b8); font-size: 12px;
                padding: 4px 4px; font-style: italic;
            }
            .tocs-pair-chip {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 4px 2px 8px;
                background: linear-gradient(135deg, #2563eb, #7c3aed);
                color: #fff; border-radius: 10px;
                font-size: 11px; line-height: 1.5; font-weight: 500;
                max-width: 220px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .tocs-pair-chip-x {
                cursor: pointer; padding: 0 2px 0 4px;
                margin-left: 2px; font-weight: 700; opacity: 0.85;
                font-size: 13px; line-height: 1;
            }
            .tocs-pair-chip-x:hover { opacity: 1; }
            .tocs-pair-panel {
                position: fixed; min-width: 320px; max-width: 480px;
                background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
                box-shadow: 0 12px 28px -4px rgba(15, 23, 42, 0.16),
                            0 4px 12px -2px rgba(15, 23, 42, 0.08);
                z-index: 1050; display: none; overflow: hidden;
                flex-direction: column; max-height: 420px;
            }
            .tocs-pair-panel.tocs-open { display: flex; }
            .tocs-pair-head {
                position: sticky; top: 0; z-index: 1;
                background: #fff; border-bottom: 1px solid #e2e8f0;
                padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
            }
            .tocs-pair-search-wrap { position: relative; }
            .tocs-pair-search-icon {
                position: absolute; left: 8px; top: 50%;
                transform: translateY(-50%);
                color: #94a3b8; font-size: 11px; pointer-events: none;
            }
            .tocs-pair-search {
                width: 100%; padding: 6px 8px 6px 26px;
                border: 1px solid #e2e8f0; border-radius: 4px;
                font-size: 12px; background: #fff;
            }
            .tocs-pair-search:focus {
                outline: none; border-color: #2563eb;
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
            }
            .tocs-pair-actions { display: flex; gap: 6px; justify-content: flex-end; }
            .tocs-pair-action {
                border: 1px solid #e2e8f0; background: #f8fafc; color: #0f172a;
                padding: 3px 10px; border-radius: 4px;
                font-size: 11px; font-weight: 500; cursor: pointer;
                transition: all 100ms ease;
            }
            .tocs-pair-action:hover {
                background: #2563eb; color: #fff; border-color: #2563eb;
            }
            .tocs-pair-opts {
                flex: 1; overflow-y: auto; padding: 4px 0; max-height: 280px;
            }
            .tocs-pair-opt {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 12px; font-size: 13px; cursor: pointer;
                transition: background 80ms ease; user-select: none;
            }
            .tocs-pair-opt:hover { background: #f1f5f9; }
            .tocs-pair-opt.tocs-selected { background: rgba(37, 99, 235, 0.06); }
            .tocs-pair-opt input[type=checkbox] {
                margin: 0; cursor: pointer; accent-color: #2563eb;
            }
            .tocs-pair-cell {
                flex: 1; display: flex; align-items: center; gap: 6px;
                overflow: hidden;
            }
            .tocs-pair-pill {
                display: inline-block; padding: 2px 8px; border-radius: 10px;
                font-size: 11px; font-weight: 500; white-space: nowrap;
                max-width: 150px; overflow: hidden; text-overflow: ellipsis;
            }
            .tocs-pair-pill-status   { background: rgba(37, 99, 235, 0.1);  color: #1d4ed8; }
            .tocs-pair-pill-workflow { background: rgba(124, 58, 237, 0.1); color: #6d28d9; }
            .tocs-pair-sep { color: #cbd5e1; font-weight: 700; padding: 0 2px; }
            .tocs-pair-empty-side { color: #cbd5e1; font-size: 12px; padding: 0 4px; }
            .tocs-pair-empty {
                padding: 18px; text-align: center; color: #94a3b8; font-size: 12px;
            }
            .tocs-pair-foot {
                position: sticky; bottom: 0;
                background: #f8fafc; border-top: 1px solid #e2e8f0;
                padding: 5px 10px; font-size: 11px; color: #64748b;
                text-align: right;
            }
            .tocs-pair-chip-more {
                background: #64748b !important; cursor: help;
            }
        `;
        const tag = document.createElement("style");
        tag.id = "tocs-pair-style";
        tag.textContent = css;
        document.head.appendChild(tag);
    }

    // Position panel under trigger via getBoundingClientRect (escapes any
    // transformed ancestor). Same logic as Item Short / Surplus widget.
    function _positionPanel(triggerEl, panelEl) {
        if (!triggerEl || !panelEl) return;
        const rect = triggerEl.getBoundingClientRect();
        const vpH = window.innerHeight, vpW = window.innerWidth;
        const dropH = Math.min(420, panelEl.scrollHeight || 420);
        const minW = Math.max(320, Math.min(480, rect.width));
        let top = rect.bottom + 4, left = rect.left;
        if (top + dropH > vpH - 8 && rect.top > dropH + 8) top = rect.top - dropH - 4;
        if (left + minW > vpW - 8) left = Math.max(8, vpW - minW - 8);
        if (left < 8) left = 8;
        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.width = `${minW}px`;
    }

    function _esc(v) {
        return frappe.utils.escape_html(String(v == null ? "" : v));
    }

    // Read state from the textarea — array of pair-key strings.
    function _readState(textareaVal) {
        if (!textareaVal) return [];
        return textareaVal.trim().split("\n")
            .map(l => l.trim()).filter(l => l.length);
    }
    function _writeState(arr) {
        return (arr || []).join("\n");
    }

    // Fetch the pair list for this voucher type. Uses the same backend
    // method that powers the Item Short / Surplus filter chips so both
    // surfaces stay in sync.
    const _pairCache = {};
    async function _fetchPairs(doctype) {
        if (_pairCache[doctype]) return _pairCache[doctype];
        const r = await frappe.call({
            method: "chaizup_toc.api.item_short_surplus_api.get_filter_options",
        });
        const m = r.message || { options: {} };
        const map = {
            "Sales Order":    m.options.so_pairs || [],
            "Work Order":     m.options.wo_pairs || [],
            "Purchase Order": m.options.po_pairs || [],
        };
        Object.keys(map).forEach(k => { _pairCache[k] = map[k]; });
        return _pairCache[doctype] || [];
    }

    // Build and mount the widget over the field. Called once per refresh.
    async function _mountWidget(frm, cfg) {
        const field = frm.fields_dict[cfg.field];
        if (!field || !field.$wrapper) return;
        // Idempotency guard — don't double-mount on every refresh.
        if (field._tocsPairMounted) return;
        field._tocsPairMounted = true;

        // Hide the underlying textarea but keep it as the value source.
        const $textarea = field.$input;
        if ($textarea && $textarea.length) $textarea.hide();

        const pairs = await _fetchPairs(cfg.dtype);
        const byKey = {};
        pairs.forEach(p => { byKey[p.key] = p; });

        // ── Build trigger (chip strip) + panel
        const $host = $(`<div class="tocs-pair-host"></div>`);
        const $chips = $(`<div class="tocs-pair-chips" tabindex="0"></div>`);
        const $caret = $(`<i class="fa fa-caret-down tocs-pair-caret"></i>`);
        $chips.append($caret);
        $host.append($chips);
        const $panel = $(`<div class="tocs-pair-panel"></div>`);
        const $head = $(`
            <div class="tocs-pair-head">
                <div class="tocs-pair-search-wrap">
                    <i class="fa fa-search tocs-pair-search-icon"></i>
                    <input type="search" class="tocs-pair-search"
                           placeholder="${_esc(__("Search status or workflow…"))}">
                </div>
                <div class="tocs-pair-actions">
                    <button class="tocs-pair-action tocs-all">${_esc(__("Select all"))}</button>
                    <button class="tocs-pair-action tocs-clear">${_esc(__("Clear"))}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="tocs-pair-opts"></div>`);
        const $foot = $(`<div class="tocs-pair-foot"></div>`);
        $panel.append($head).append($opts).append($foot);
        field.$wrapper.append($host);

        // ── Read current value from the textarea
        let state = _readState(field.value || "");

        const renderChips = () => {
            $chips.find(".tocs-pair-chip, .tocs-pair-placeholder").remove();
            if (!state.length) {
                $chips.prepend(`<span class="tocs-pair-placeholder">${_esc(__("No pairs selected"))}</span>`);
                return;
            }
            const visible = state.slice(0, 4);
            visible.forEach(k => {
                const opt = byKey[k] || { label: k };
                const $c = $(`<span class="tocs-pair-chip" title="${_esc(opt.label)}">${_esc(opt.label)}<span class="tocs-pair-chip-x">&times;</span></span>`);
                $c.find(".tocs-pair-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    state = state.filter(z => z !== k);
                    _commit();
                    renderChips();
                    renderFoot();
                });
                $chips.find(".tocs-pair-caret").before($c);
            });
            if (state.length > 4) {
                const moreLabels = state.slice(4).map(k => (byKey[k] && byKey[k].label) || k).join(", ");
                $chips.find(".tocs-pair-caret").before(
                    `<span class="tocs-pair-chip tocs-pair-chip-more" title="${_esc(moreLabels)}">+${state.length - 4} ${_esc(__("more"))}</span>`
                );
            }
        };

        const renderFoot = () => {
            $foot.text(__("{0} of {1} selected", [state.length, pairs.length]));
        };

        let currentList = pairs.slice();
        const renderOpts = (filter = "") => {
            $opts.empty();
            currentList = pairs.slice();
            if (filter) {
                const f = filter.toLowerCase();
                currentList = currentList.filter(o =>
                    String(o.label).toLowerCase().includes(f) ||
                    String(o.status).toLowerCase().includes(f) ||
                    String(o.workflow_state).toLowerCase().includes(f));
            }
            if (!currentList.length) {
                $opts.append(`<div class="tocs-pair-empty">
                    <i class="fa fa-search-minus"></i> ${_esc(__("No matching pairs"))}
                </div>`);
                return;
            }
            currentList.forEach(opt => {
                const sel = state.includes(opt.key);
                const stHtml = opt.status
                    ? `<span class="tocs-pair-pill tocs-pair-pill-status">${_esc(opt.status)}</span>`
                    : `<span class="tocs-pair-empty-side">—</span>`;
                const wfHtml = opt.workflow_state
                    ? `<span class="tocs-pair-pill tocs-pair-pill-workflow">${_esc(opt.workflow_state)}</span>`
                    : `<span class="tocs-pair-empty-side">—</span>`;
                const $o = $(`
                    <label class="tocs-pair-opt ${sel ? "tocs-selected" : ""}">
                        <input type="checkbox" ${sel ? "checked" : ""}>
                        <span class="tocs-pair-cell">
                            ${stHtml}<span class="tocs-pair-sep">:</span>${wfHtml}
                        </span>
                    </label>
                `);
                $o.on("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (state.includes(opt.key)) {
                        state = state.filter(z => z !== opt.key);
                    } else {
                        state = [...state, opt.key];
                    }
                    const nowSel = state.includes(opt.key);
                    $o.toggleClass("tocs-selected", nowSel)
                      .find("input").prop("checked", nowSel);
                    _commit();
                    renderChips();
                    renderFoot();
                });
                $opts.append($o);
            });
        };

        // Persist back to the textarea + mark dirty so the user's Save works.
        const _commit = () => {
            const newVal = _writeState(state);
            if (field.value !== newVal) {
                field.set_value(newVal);
                frm.dirty();
            }
        };

        // Open / close
        const $search = $head.find(".tocs-pair-search");
        const reposition = () => _positionPanel($chips[0], $panel[0]);
        const closePanel = () => {
            $panel.removeClass("tocs-open");
            $chips.removeClass("tocs-open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };

        $chips.on("click", (e) => {
            if ($(e.target).hasClass("tocs-pair-chip-x")) return;
            // Close any other panel
            $(".tocs-pair-panel.tocs-open").not($panel).removeClass("tocs-open");
            $(".tocs-pair-chips.tocs-open").not($chips).removeClass("tocs-open");
            const wasOpen = $panel.hasClass("tocs-open");
            if (wasOpen) { closePanel(); return; }
            $search.val("");
            renderOpts();
            renderFoot();
            if ($panel[0].parentNode !== document.body) {
                document.body.appendChild($panel[0]);
            }
            $panel.addClass("tocs-open");
            $chips.addClass("tocs-open");
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });

        $search.on("input", (e) => renderOpts(e.target.value));
        $search.on("keydown", (e) => { if (e.key === "Escape") closePanel(); });

        $head.find(".tocs-all").on("click", (e) => {
            e.stopPropagation();
            const set = new Set([...state, ...currentList.map(o => o.key)]);
            state = Array.from(set);
            _commit();
            renderChips();
            renderFoot();
            renderOpts($search.val());
        });
        $head.find(".tocs-clear").on("click", (e) => {
            e.stopPropagation();
            state = [];
            _commit();
            renderChips();
            renderFoot();
            renderOpts($search.val());
        });

        $(document).on("click.tocs-pair-" + cfg.field, (e) => {
            if ($panel[0].contains(e.target)) return;
            if (!$host[0].contains(e.target)) closePanel();
        });

        // Sync if backend updates the value (e.g., reload from server)
        field.df.__tocs_resync = () => {
            state = _readState(field.value || "");
            renderChips();
        };

        renderChips();
    }

    frappe.ui.form.on("TOC Settings", {
        refresh(frm) {
            _ensureStyle();
            // Mount widget on each of the 6 pair fields.
            PAIR_FIELDS.forEach(cfg => _mountWidget(frm, cfg));
        },
        // When backend reload bumps the values, re-render chips from the new state.
        after_save(frm) {
            PAIR_FIELDS.forEach(cfg => {
                const field = frm.fields_dict[cfg.field];
                if (field && field.df.__tocs_resync) field.df.__tocs_resync();
            });
        },
    });

    // Clean up any orphaned panels on form re-route.
    document.addEventListener("page-change", () => {
        document.querySelectorAll(".tocs-pair-panel.tocs-open")
            .forEach(p => p.classList.remove("tocs-open"));
    });
})();


// =============================================================================
// Configurable Automation Triggers — Task 10 (frontend JS) — ADDITIVE BLOCK
// -----------------------------------------------------------------------------
// CONTEXT: A new child table `trigger_configurations` (doctype
//   "TOC Trigger Configuration") holds one row per automation engine. This
//   block adds the operator-facing UI WITHOUT touching the global pending-pair
//   widget IIFE above (lines ~227-641). Everything here is brand new,
//   mounted via additional `frappe.ui.form.on(...)` handlers (Frappe runs ALL
//   registered handlers for the same event, so adding more is safe).
//
//   (A) Engine overview panel + per-engine "Run Now" buttons, rendered into the
//       `automation_triggers_section` Section Break wrapper. Data comes from
//       chaizup_toc.api.trigger_runner.get_trigger_overview(). Each engine row
//       shows its name, schedule, enabled/disabled badge, an info tooltip with
//       the engine help text, and a ▶ Run Now button calling
//       chaizup_toc.api.trigger_runner.run_trigger_now(trigger_key).
//   (B) HH:MM validation on the child grid `schedule_time` cell.
//   (C) System-managed rows — the grid cannot add or delete rows (identity
//       fields are read-only, so a manual row would be useless).
//   (D) ★ The 3 child pending fields (pending_so_statuses / _wo_ / _po_) get the
//       SAME Status:WorkflowState chip+dropdown multiselect as the global
//       widget, mounted on each grid row's DETAIL form when the row is expanded
//       (form_render event). It COMMITS via frappe.model.set_value (child rows
//       go through the model, not field.set_value/frm.dirty). Only mounted for
//       vouchers the engine actually considers (row.considers_so/wo/po); a
//       not-considered voucher shows a small "Not applicable" note.
//
// RESTRICT (CRITICAL):
//   - This block is INTENTIONALLY self-contained (it duplicates the ~150 lines
//     of widget logic, adapted for frappe.model.set_value) so the working
//     global widget above is never refactored or risked. Duplication is the
//     safe choice here.
//   - The stored format for the 3 pending fields is UNCHANGED: newline-
//     separated `<Status>|<WorkflowState>` lines. Blank = inherit global
//     default. Do NOT change the storage format.
//   - Reuses the SAME `<style id="tocs-pair-style">` (id-guarded re-inject) and
//     the same `get_filter_options` backend method + a module-level pair cache.
// MEMORY: chaizup_automation_logging_plan.md (Configurable Automation Triggers)
// =============================================================================

(function () {
    "use strict";

    const PENDING_VOUCHER = {
        pending_so_statuses: { dtype: "Sales Order",    considers: "considers_so" },
        pending_wo_statuses: { dtype: "Work Order",     considers: "considers_wo" },
        pending_po_statuses: { dtype: "Purchase Order", considers: "considers_po" },
    };
    const PENDING_FIELDS = Object.keys(PENDING_VOUCHER);

    function _esc(v) {
        return frappe.utils.escape_html(String(v == null ? "" : v));
    }

    // ── Reuse the global widget's CSS. The id-guard means if the global IIFE
    //    already injected the <style id="tocs-pair-style">, we do nothing;
    //    otherwise we re-inject an identical copy so this block is independent.
    function _ensureStyle() {
        if (document.getElementById("tocs-pair-style")) return;
        const css = `
            .tocs-pair-host { margin-top: 4px; }
            .tocs-pair-chips {
                display: flex; flex-wrap: wrap; gap: 4px;
                min-height: 32px; padding: 4px 28px 4px 6px; position: relative;
                background: var(--input-bg, #fff);
                border: 1px solid var(--border-color, #d1d5db);
                border-radius: var(--border-radius-sm, 4px);
                cursor: pointer; transition: border-color 120ms ease;
            }
            .tocs-pair-chips:hover { border-color: var(--primary, #2563eb); }
            .tocs-pair-chips.tocs-open { border-color: var(--primary, #2563eb);
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15); }
            .tocs-pair-caret {
                position: absolute; right: 8px; top: 50%;
                transform: translateY(-50%);
                color: var(--text-muted, #94a3b8); font-size: 11px; pointer-events: none;
            }
            .tocs-pair-placeholder {
                color: var(--text-muted, #94a3b8); font-size: 12px;
                padding: 4px 4px; font-style: italic;
            }
            .tocs-pair-chip {
                display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 4px 2px 8px;
                background: linear-gradient(135deg, #2563eb, #7c3aed);
                color: #fff; border-radius: 10px;
                font-size: 11px; line-height: 1.5; font-weight: 500;
                max-width: 220px;
                overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .tocs-pair-chip-x {
                cursor: pointer; padding: 0 2px 0 4px;
                margin-left: 2px; font-weight: 700; opacity: 0.85;
                font-size: 13px; line-height: 1;
            }
            .tocs-pair-chip-x:hover { opacity: 1; }
            .tocs-pair-panel {
                position: fixed; min-width: 320px; max-width: 480px;
                background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
                box-shadow: 0 12px 28px -4px rgba(15, 23, 42, 0.16),
                            0 4px 12px -2px rgba(15, 23, 42, 0.08);
                z-index: 1050; display: none; overflow: hidden;
                flex-direction: column; max-height: 420px;
            }
            .tocs-pair-panel.tocs-open { display: flex; }
            .tocs-pair-head {
                position: sticky; top: 0; z-index: 1;
                background: #fff; border-bottom: 1px solid #e2e8f0;
                padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
            }
            .tocs-pair-search-wrap { position: relative; }
            .tocs-pair-search-icon {
                position: absolute; left: 8px; top: 50%;
                transform: translateY(-50%);
                color: #94a3b8; font-size: 11px; pointer-events: none;
            }
            .tocs-pair-search {
                width: 100%; padding: 6px 8px 6px 26px;
                border: 1px solid #e2e8f0; border-radius: 4px;
                font-size: 12px; background: #fff;
            }
            .tocs-pair-search:focus {
                outline: none; border-color: #2563eb;
                box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
            }
            .tocs-pair-actions { display: flex; gap: 6px; justify-content: flex-end; }
            .tocs-pair-action {
                border: 1px solid #e2e8f0; background: #f8fafc; color: #0f172a;
                padding: 3px 10px; border-radius: 4px;
                font-size: 11px; font-weight: 500; cursor: pointer;
                transition: all 100ms ease;
            }
            .tocs-pair-action:hover {
                background: #2563eb; color: #fff; border-color: #2563eb;
            }
            .tocs-pair-opts {
                flex: 1; overflow-y: auto; padding: 4px 0; max-height: 280px;
            }
            .tocs-pair-opt {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 12px; font-size: 13px; cursor: pointer;
                transition: background 80ms ease; user-select: none;
            }
            .tocs-pair-opt:hover { background: #f1f5f9; }
            .tocs-pair-opt.tocs-selected { background: rgba(37, 99, 235, 0.06); }
            .tocs-pair-opt input[type=checkbox] {
                margin: 0; cursor: pointer; accent-color: #2563eb;
            }
            .tocs-pair-cell {
                flex: 1; display: flex; align-items: center; gap: 6px;
                overflow: hidden;
            }
            .tocs-pair-pill {
                display: inline-block; padding: 2px 8px; border-radius: 10px;
                font-size: 11px; font-weight: 500; white-space: nowrap;
                max-width: 150px; overflow: hidden; text-overflow: ellipsis;
            }
            .tocs-pair-pill-status   { background: rgba(37, 99, 235, 0.1);  color: #1d4ed8; }
            .tocs-pair-pill-workflow { background: rgba(124, 58, 237, 0.1); color: #6d28d9; }
            .tocs-pair-sep { color: #cbd5e1; font-weight: 700; padding: 0 2px; }
            .tocs-pair-empty-side { color: #cbd5e1; font-size: 12px; padding: 0 4px; }
            .tocs-pair-empty {
                padding: 18px; text-align: center; color: #94a3b8; font-size: 12px;
            }
            .tocs-pair-foot {
                position: sticky; bottom: 0;
                background: #f8fafc; border-top: 1px solid #e2e8f0;
                padding: 5px 10px; font-size: 11px; color: #64748b;
                text-align: right;
            }
            .tocs-pair-chip-more {
                background: #64748b !important; cursor: help;
            }
        `;
        const tag = document.createElement("style");
        tag.id = "tocs-pair-style";
        tag.textContent = css;
        document.head.appendChild(tag);
    }

    // ── CSS scoped to the engine-overview panel only (its own id).
    function _ensureOverviewStyle() {
        if (document.getElementById("toc-engine-overview-style")) return;
        const css = `
            #toc-engine-overview {
                margin: 6px 0 14px; border: 1px solid var(--border-color, #e2e8f0);
                border-radius: 8px; overflow: hidden; background: #fff;
            }
            #toc-engine-overview .toc-eo-head {
                display: flex; align-items: center; gap: 8px;
                padding: 8px 12px; background: #f8fafc;
                border-bottom: 1px solid var(--border-color, #e2e8f0);
                font-size: 12px; font-weight: 600; color: #334155;
            }
            #toc-engine-overview .toc-eo-head .toc-eo-sub {
                font-weight: 400; color: #94a3b8; font-size: 11px;
            }
            #toc-engine-overview .toc-eo-row {
                display: flex; align-items: center; gap: 10px;
                padding: 9px 12px; border-bottom: 1px solid #f1f5f9;
            }
            #toc-engine-overview .toc-eo-row:last-child { border-bottom: none; }
            #toc-engine-overview .toc-eo-main { flex: 1; min-width: 0; }
            #toc-engine-overview .toc-eo-name {
                font-size: 13px; font-weight: 600; color: #0f172a;
                display: flex; align-items: center; gap: 6px;
            }
            #toc-engine-overview .toc-eo-help {
                color: #94a3b8; cursor: help; font-size: 11px;
            }
            #toc-engine-overview .toc-eo-sched {
                font-size: 11px; color: #64748b; margin-top: 2px;
            }
            #toc-engine-overview .toc-eo-badge {
                display: inline-block; padding: 2px 9px; border-radius: 10px;
                font-size: 10px; font-weight: 600; letter-spacing: 0.02em;
                text-transform: uppercase;
            }
            #toc-engine-overview .toc-eo-badge.on  { background: rgba(22,163,74,0.12); color: #15803d; }
            #toc-engine-overview .toc-eo-badge.off { background: rgba(100,116,139,0.12); color: #64748b; }
            #toc-engine-overview .toc-eo-considers {
                display: inline-flex; gap: 4px; margin-left: 4px;
            }
            #toc-engine-overview .toc-eo-tag {
                font-size: 9px; font-weight: 600; padding: 1px 5px;
                border-radius: 4px; background: rgba(37,99,235,0.08); color: #1d4ed8;
            }
            #toc-engine-overview .toc-eo-tag.muted {
                background: #f1f5f9; color: #cbd5e1;
            }
        `;
        const tag = document.createElement("style");
        tag.id = "toc-engine-overview-style";
        tag.textContent = css;
        document.head.appendChild(tag);
    }

    // ── State read/write helpers (identical semantics to the global widget).
    function _readState(v) {
        if (!v) return [];
        return v.trim().split("\n").map(l => l.trim()).filter(l => l.length);
    }
    function _writeState(arr) {
        return (arr || []).join("\n");
    }

    // ── Shared pair cache + fetch (own module-level cache so the global widget
    //    is untouched; backend method is the same single source of truth).
    const _pairCache = {};
    async function _fetchPairs(doctype) {
        if (_pairCache[doctype]) return _pairCache[doctype];
        const r = await frappe.call({
            method: "chaizup_toc.api.item_short_surplus_api.get_filter_options",
        });
        const m = (r && r.message) || { options: {} };
        const opt = m.options || {};
        const map = {
            "Sales Order":    opt.so_pairs || [],
            "Work Order":     opt.wo_pairs || [],
            "Purchase Order": opt.po_pairs || [],
        };
        Object.keys(map).forEach(k => { _pairCache[k] = map[k]; });
        return _pairCache[doctype] || [];
    }

    function _positionPanel(triggerEl, panelEl) {
        if (!triggerEl || !panelEl) return;
        const rect = triggerEl.getBoundingClientRect();
        const vpH = window.innerHeight, vpW = window.innerWidth;
        const dropH = Math.min(420, panelEl.scrollHeight || 420);
        const minW = Math.max(320, Math.min(480, rect.width));
        let top = rect.bottom + 4, left = rect.left;
        if (top + dropH > vpH - 8 && rect.top > dropH + 8) top = rect.top - dropH - 4;
        if (left + minW > vpW - 8) left = Math.max(8, vpW - minW - 8);
        if (left < 8) left = 8;
        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.width = `${minW}px`;
    }

    // -------------------------------------------------------------------------
    // (D) Mount the chip+dropdown multiselect on ONE child-row detail field.
    //     Commits through frappe.model.set_value(cdt, cdn, fieldname, val).
    //     `fieldObj` is the grid detail-form field control (.$wrapper, .$input,
    //     .value, .df). We do NOT call fieldObj.set_value / frm.dirty here.
    // -------------------------------------------------------------------------
    async function _mountChildPairWidget(fieldObj, dtype, cdt, cdn, fieldname) {
        if (!fieldObj || !fieldObj.$wrapper) return;
        if (fieldObj._tocTrigPairMounted) return;
        fieldObj._tocTrigPairMounted = true;

        // Hide the raw textarea but keep it as a value mirror.
        const $textarea = fieldObj.$input;
        if ($textarea && $textarea.length) $textarea.hide();

        const pairs = await _fetchPairs(dtype);
        const byKey = {};
        pairs.forEach(p => { byKey[p.key] = p; });

        const $host = $(`<div class="tocs-pair-host"></div>`);
        const $chips = $(`<div class="tocs-pair-chips" tabindex="0"></div>`);
        const $caret = $(`<i class="fa fa-caret-down tocs-pair-caret"></i>`);
        $chips.append($caret);
        $host.append($chips);
        const $panel = $(`<div class="tocs-pair-panel"></div>`);
        const $head = $(`
            <div class="tocs-pair-head">
                <div class="tocs-pair-search-wrap">
                    <i class="fa fa-search tocs-pair-search-icon"></i>
                    <input type="search" class="tocs-pair-search"
                           placeholder="${_esc(__("Search status or workflow…"))}">
                </div>
                <div class="tocs-pair-actions">
                    <button class="tocs-pair-action tocs-all">${_esc(__("Select all"))}</button>
                    <button class="tocs-pair-action tocs-clear">${_esc(__("Clear"))}</button>
                </div>
            </div>
        `);
        const $opts = $(`<div class="tocs-pair-opts"></div>`);
        const $foot = $(`<div class="tocs-pair-foot"></div>`);
        $panel.append($head).append($opts).append($foot);
        fieldObj.$wrapper.append($host);

        // Read current value from the live row (most authoritative source).
        const _rowVal = () => {
            const row = (locals[cdt] || {})[cdn];
            return (row && row[fieldname]) || fieldObj.value || "";
        };
        let state = _readState(_rowVal());

        const renderChips = () => {
            $chips.find(".tocs-pair-chip, .tocs-pair-placeholder").remove();
            if (!state.length) {
                // Blank cell = inherit the global default — make that explicit.
                $chips.prepend(`<span class="tocs-pair-placeholder">${_esc(__("Inheriting global default"))}</span>`);
                return;
            }
            const visible = state.slice(0, 4);
            visible.forEach(k => {
                const opt = byKey[k] || { label: k };
                const $c = $(`<span class="tocs-pair-chip" title="${_esc(opt.label)}">${_esc(opt.label)}<span class="tocs-pair-chip-x">&times;</span></span>`);
                $c.find(".tocs-pair-chip-x").on("click", (e) => {
                    e.stopPropagation();
                    state = state.filter(z => z !== k);
                    _commit();
                    renderChips();
                    renderFoot();
                });
                $chips.find(".tocs-pair-caret").before($c);
            });
            if (state.length > 4) {
                const moreLabels = state.slice(4).map(k => (byKey[k] && byKey[k].label) || k).join(", ");
                $chips.find(".tocs-pair-caret").before(
                    `<span class="tocs-pair-chip tocs-pair-chip-more" title="${_esc(moreLabels)}">+${state.length - 4} ${_esc(__("more"))}</span>`
                );
            }
        };

        const renderFoot = () => {
            $foot.text(__("{0} of {1} selected", [state.length, pairs.length]));
        };

        let currentList = pairs.slice();
        const renderOpts = (filter = "") => {
            $opts.empty();
            currentList = pairs.slice();
            if (filter) {
                const f = filter.toLowerCase();
                currentList = currentList.filter(o =>
                    String(o.label).toLowerCase().includes(f) ||
                    String(o.status).toLowerCase().includes(f) ||
                    String(o.workflow_state).toLowerCase().includes(f));
            }
            if (!currentList.length) {
                $opts.append(`<div class="tocs-pair-empty">
                    <i class="fa fa-search-minus"></i> ${_esc(__("No matching pairs"))}
                </div>`);
                return;
            }
            currentList.forEach(opt => {
                const sel = state.includes(opt.key);
                const stHtml = opt.status
                    ? `<span class="tocs-pair-pill tocs-pair-pill-status">${_esc(opt.status)}</span>`
                    : `<span class="tocs-pair-empty-side">—</span>`;
                const wfHtml = opt.workflow_state
                    ? `<span class="tocs-pair-pill tocs-pair-pill-workflow">${_esc(opt.workflow_state)}</span>`
                    : `<span class="tocs-pair-empty-side">—</span>`;
                const $o = $(`
                    <label class="tocs-pair-opt ${sel ? "tocs-selected" : ""}">
                        <input type="checkbox" ${sel ? "checked" : ""}>
                        <span class="tocs-pair-cell">
                            ${stHtml}<span class="tocs-pair-sep">:</span>${wfHtml}
                        </span>
                    </label>
                `);
                $o.on("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (state.includes(opt.key)) {
                        state = state.filter(z => z !== opt.key);
                    } else {
                        state = [...state, opt.key];
                    }
                    const nowSel = state.includes(opt.key);
                    $o.toggleClass("tocs-selected", nowSel)
                      .find("input").prop("checked", nowSel);
                    _commit();
                    renderChips();
                    renderFoot();
                });
                $opts.append($o);
            });
        };

        // ★ Child-row commit: write through the model so the row persists on
        //   Save. set_value auto-marks the parent dirty.
        const _commit = () => {
            const newVal = _writeState(state);
            const row = (locals[cdt] || {})[cdn];
            const cur = (row && row[fieldname]) || "";
            if (cur !== newVal) {
                frappe.model.set_value(cdt, cdn, fieldname, newVal);
            }
        };

        const $search = $head.find(".tocs-pair-search");
        const reposition = () => _positionPanel($chips[0], $panel[0]);
        const closePanel = () => {
            $panel.removeClass("tocs-open");
            $chips.removeClass("tocs-open");
            window.removeEventListener("scroll", reposition, true);
            window.removeEventListener("resize", reposition);
        };

        $chips.on("click", (e) => {
            if ($(e.target).hasClass("tocs-pair-chip-x")) return;
            $(".tocs-pair-panel.tocs-open").not($panel).removeClass("tocs-open");
            $(".tocs-pair-chips.tocs-open").not($chips).removeClass("tocs-open");
            const wasOpen = $panel.hasClass("tocs-open");
            if (wasOpen) { closePanel(); return; }
            // Re-sync from the row in case the value changed elsewhere.
            state = _readState(_rowVal());
            $search.val("");
            renderOpts();
            renderFoot();
            if ($panel[0].parentNode !== document.body) {
                document.body.appendChild($panel[0]);
            }
            $panel.addClass("tocs-open");
            $chips.addClass("tocs-open");
            requestAnimationFrame(reposition);
            window.addEventListener("scroll", reposition, true);
            window.addEventListener("resize", reposition);
            setTimeout(() => $search.focus(), 0);
        });

        $search.on("input", (e) => renderOpts(e.target.value));
        $search.on("keydown", (e) => { if (e.key === "Escape") closePanel(); });

        $head.find(".tocs-all").on("click", (e) => {
            e.stopPropagation();
            const set = new Set([...state, ...currentList.map(o => o.key)]);
            state = Array.from(set);
            _commit();
            renderChips();
            renderFoot();
            renderOpts($search.val());
        });
        $head.find(".tocs-clear").on("click", (e) => {
            e.stopPropagation();
            state = [];
            _commit();
            renderChips();
            renderFoot();
            renderOpts($search.val());
        });

        // Outer-click close — namespaced per row+field so multiple open rows
        // don't fight over the same handler.
        const ns = `click.tocTrig-${cdn}-${fieldname}`;
        $(document).off(ns).on(ns, (e) => {
            if (!document.body.contains($host[0])) {
                // Detail form closed/destroyed — detach the panel + handler.
                if ($panel[0] && $panel[0].parentNode) $panel[0].parentNode.removeChild($panel[0]);
                $(document).off(ns);
                return;
            }
            if ($panel[0].contains(e.target)) return;
            if (!$host[0].contains(e.target)) closePanel();
        });

        renderChips();
    }

    // ── Render a "Not applicable" note for vouchers an engine doesn't read.
    function _markChildFieldNotApplicable(fieldObj) {
        if (!fieldObj || !fieldObj.$wrapper) return;
        if (fieldObj._tocTrigNAMarked) return;
        fieldObj._tocTrigNAMarked = true;
        const $textarea = fieldObj.$input;
        if ($textarea && $textarea.length) {
            $textarea.prop("disabled", true)
                .attr("placeholder", __("Not applicable — this engine does not read this voucher"));
        }
        fieldObj.$wrapper.find(".tocs-trig-na").remove();
        fieldObj.$wrapper.append(
            `<div class="tocs-trig-na" style="margin-top:4px;font-size:11px;color:#94a3b8;font-style:italic">` +
            `${_esc(__("Not applicable for this engine."))}</div>`
        );
    }

    // -------------------------------------------------------------------------
    // (A) Render the engine overview panel into the section wrapper.
    // -------------------------------------------------------------------------
    function _formatSchedule(eng) {
        const freq = (eng.frequency || "").toLowerCase();
        const t = eng.schedule_time || "";
        if (freq === "cron") {
            return eng.cron_override ? `cron: ${eng.cron_override}` : __("custom cron");
        }
        if (freq === "weekly") {
            const wd = eng.weekday || __("(weekday unset)");
            return t ? `${wd} ${t}` : `${wd}`;
        }
        // default daily
        return t ? `${t} ${__("daily")}` : __("daily (time unset)");
    }

    function _renderEngineOverview(frm) {
        const sec = frm.fields_dict.automation_triggers_section;
        if (!sec || !sec.wrapper) return;
        const $w = $(sec.wrapper);
        // Idempotent: drop any prior panel before re-render.
        $w.find("#toc-engine-overview").remove();

        const $panel = $(`
            <div id="toc-engine-overview">
                <div class="toc-eo-head">
                    <i class="fa fa-bolt"></i>
                    <span>${_esc(__("Automation Engines"))}</span>
                    <span class="toc-eo-sub">${_esc(__("Schedules and on-demand runs"))}</span>
                </div>
                <div class="toc-eo-body">
                    <div class="toc-eo-loading" style="padding:12px;color:#94a3b8;font-size:12px">
                        ${_esc(__("Loading engines…"))}
                    </div>
                </div>
            </div>
        `);
        $w.prepend($panel);

        frappe.call({
            method: "chaizup_toc.api.trigger_runner.get_trigger_overview",
            callback: (r) => {
                const $body = $panel.find(".toc-eo-body");
                $body.empty();
                const engines = (r && r.message) || [];
                if (!engines.length) {
                    $body.append(`<div style="padding:12px;color:#94a3b8;font-size:12px">${_esc(__("No engines configured."))}</div>`);
                    return;
                }
                engines.forEach((eng) => {
                    const enabled = !!eng.enabled;
                    const considers = eng.considers || {};
                    const tag = (on, label) =>
                        `<span class="toc-eo-tag ${on ? "" : "muted"}">${_esc(label)}</span>`;
                    const helpTitle = eng.help ? _esc(eng.help) : "";
                    const $row = $(`
                        <div class="toc-eo-row">
                            <div class="toc-eo-main">
                                <div class="toc-eo-name">
                                    <span>${_esc(eng.name || eng.key)}</span>
                                    ${helpTitle ? `<i class="fa fa-info-circle toc-eo-help" title="${helpTitle}"></i>` : ""}
                                    <span class="toc-eo-considers">
                                        ${tag(considers.so, "SO")}${tag(considers.wo, "WO")}${tag(considers.po, "PO")}
                                    </span>
                                </div>
                                <div class="toc-eo-sched">${_esc(_formatSchedule(eng))}</div>
                            </div>
                            <span class="toc-eo-badge ${enabled ? "on" : "off"}">${enabled ? _esc(__("Enabled")) : _esc(__("Disabled"))}</span>
                            <button class="btn btn-xs btn-default toc-eo-run" type="button">
                                <i class="fa fa-play"></i> ${_esc(__("Run Now"))}
                            </button>
                        </div>
                    `);
                    const $btn = $row.find(".toc-eo-run");
                    $btn.on("click", () => {
                        frappe.confirm(
                            __("Run <b>{0}</b> now? This enqueues the engine on the long queue.", [_esc(eng.name || eng.key)]),
                            () => {
                                const orig = $btn.html();
                                $btn.prop("disabled", true)
                                    .html(`<i class="fa fa-spinner fa-spin"></i> ${_esc(__("Queuing…"))}`);
                                frappe.call({
                                    method: "chaizup_toc.api.trigger_runner.run_trigger_now",
                                    args: { trigger_key: eng.key },
                                    callback: (rr) => {
                                        $btn.prop("disabled", false).html(orig);
                                        const m = (rr && rr.message) || {};
                                        if (m.ok && m.queued) {
                                            frappe.show_alert({
                                                message: __("{0} queued (long queue). Check the Run Log / Error Log.",
                                                    [m.name || eng.name || eng.key]),
                                                indicator: "green",
                                            }, 7);
                                        } else {
                                            frappe.show_alert({
                                                message: __("{0} could not be queued.", [eng.name || eng.key]),
                                                indicator: "orange",
                                            }, 7);
                                        }
                                    },
                                    error: () => {
                                        $btn.prop("disabled", false).html(orig);
                                    },
                                });
                            }
                        );
                    });
                    $body.append($row);
                });
            },
            error: () => {
                $panel.find(".toc-eo-body").html(
                    `<div style="padding:12px;color:#dc2626;font-size:12px">${_esc(__("Failed to load engine overview."))}</div>`
                );
            },
        });
    }

    // -------------------------------------------------------------------------
    // (C) Lock the child grid: no manual add/delete (rows are system-managed).
    // -------------------------------------------------------------------------
    function _lockTriggerGrid(frm) {
        const fld = frm.fields_dict.trigger_configurations;
        if (!fld || !fld.grid) return;
        fld.grid.cannot_add_rows = true;
        // cannot_delete_rows is honored by newer Frappe grids; harmless on older.
        fld.grid.cannot_delete_rows = true;
        try {
            frm.set_df_property("trigger_configurations", "cannot_add_rows", true);
        } catch (e) { /* older Frappe — grid flag above already covers it */ }
        fld.grid.refresh();
    }

    // -------------------------------------------------------------------------
    // Parent-form handlers (ADDITIVE — Frappe runs all refresh handlers).
    // -------------------------------------------------------------------------
    frappe.ui.form.on("TOC Settings", {
        refresh(frm) {
            _ensureStyle();
            _ensureOverviewStyle();
            _renderEngineOverview(frm);   // (A)
            _lockTriggerGrid(frm);        // (C)
        },
    });

    // -------------------------------------------------------------------------
    // Child-row handlers.
    // -------------------------------------------------------------------------
    frappe.ui.form.on("TOC Trigger Configuration", {
        // (B) HH:MM validation.
        schedule_time(frm, cdt, cdn) {
            const row = locals[cdt][cdn];
            const v = (row.schedule_time || "").trim();
            if (!v) return;
            let bad = !/^\d{1,2}:\d{2}$/.test(v);
            if (!bad) {
                const [h, m] = v.split(":").map((x) => parseInt(x, 10));
                if (h > 23 || m > 59) bad = true;
            }
            if (bad) {
                frappe.msgprint({
                    title: __("Invalid time"),
                    message: __("Schedule Time must be in 24-hour <b>HH:MM</b> format (00:00 – 23:59). The value <b>{0}</b> was cleared.", [_esc(v)]),
                    indicator: "red",
                });
                frappe.model.set_value(cdt, cdn, "schedule_time", "");
            }
        },

        // (D) Mount the multiselect widgets when a grid row's detail form opens.
        form_render(frm, cdt, cdn) {
            _ensureStyle();
            const gridFld = frm.fields_dict.trigger_configurations;
            if (!gridFld || !gridFld.grid) return;
            const gridRow = gridFld.grid.grid_rows_by_docname[cdn];
            if (!gridRow || !gridRow.grid_form || !gridRow.grid_form.fields_dict) return;
            const row = locals[cdt][cdn];

            PENDING_FIELDS.forEach((fieldname) => {
                const fieldObj = gridRow.grid_form.fields_dict[fieldname];
                if (!fieldObj) return;
                const cfg = PENDING_VOUCHER[fieldname];
                const considered = !!(row && row[cfg.considers]);
                if (considered) {
                    _mountChildPairWidget(fieldObj, cfg.dtype, cdt, cdn, fieldname);
                } else {
                    _markChildFieldNotApplicable(fieldObj);
                }
            });
        },
    });
})();
