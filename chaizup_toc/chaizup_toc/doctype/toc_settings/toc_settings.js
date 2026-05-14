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
