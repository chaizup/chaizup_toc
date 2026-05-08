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
    },
});

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
