/*
============================================================================
CONTEXT: chaizup_toc list-view extension for Work Order.

PURPOSE (post 2026-05-27 — v0.0.12):
  1. Inject framework audit columns (`creation`, `owner`) + `workflow_state`
     + standard `qty` into add_fields so Report View can render them as
     real columns (Report View's `set_default_fields` reads add_fields
     from frappe.listview_settings[doctype]).
  2. Override `get_indicator` to render a COMBINED "Work Order Actual Status"
     pill that fuses ERPNext's `status` and the site's `workflow_state`
     (chaizup-erp has a "WorkOrder-Wflow" Workflow attached). The synthetic
     `{type: "Status"}` column in the list_view_settings fixture surfaces
     this combined pill into Report View AS a column.

WHY MERGE INSTEAD OF OVERWRITE (architectural)
  ----------------------------------------------
  ERPNext ships `erpnext/manufacturing/doctype/work_order/work_order_list.js`
  which defines `frappe.listview_settings["Work Order"]` with status
  indicators + an `add_fields` list (bom_no, status, sales_order, qty,
  produced_qty, expected_delivery_date, planned_start_date,
  planned_end_date) needed by the WO list/indicator code. Object.assign
  preserves any keys ERPNext sets that we don't explicitly override.
  We DO override `get_indicator` here because the chaizup-erp Workflow
  changes what "actual status" means — see combined logic below.

INDICATOR PALETTE (M3-ish saturation tuned for list scan-ability)
  ---------------------------------------------------------------
  Workflow > Status > Default rule, applied in priority order:

    workflow_state == "WO Rejected"     → RED      (Hard stop, requires action)
    status == "Cancelled"               → GRAY     (Terminal, no action)
    status == "Stopped"                 → RED      (Halted mid-production)
    status == "Closed"                  → BLUE     (Manually closed)
    status == "Completed"               → GREEN    (Happy path)
    status == "Stock Reserved"          → BLUE
    status == "Stock Partially Reserved"→ ORANGE
    status == "In Process"              → ORANGE   (Active manufacturing)
    status == "Not Started" / "Submitted" → ORANGE
    status == "Draft"                   → RED      (Awaiting approval/submit)

  Label format:
    - If workflow_state present AND differs from status meaningfully:
        "<status> · <workflow_state>"
    - Else just <status>.

  Examples (live chaizup-erp WO snapshot 2026-05-27):
    "Draft · WO Rejected"               (red, 31 rows)
    "Draft"                              (red, 30 rows — workflow_state=="Draft" collapsed)
    "Completed · Taken In Production"    (green, 165 rows — happy path)
    "Stopped · Taken In Production"      (red, 2 rows — supply issue mid-prod)
    "Cancelled"                          (gray — workflow_state may be null)

MEMORY: app_chaizup_toc.md § v0.0.12 — Work Order combined status indicator (2026-05-27)

DANGER ZONE — DO NOT CHANGE
  ----------------------------
  - The 5 fields in add_fields (status, workflow_state, qty, creation, owner)
    MUST stay. Each is read by either the indicator callback below OR the
    explicit fixture columns. Removing `status` blanks the pill (proven
    failure mode, 2026-05-20 incident). Removing `workflow_state` collapses
    the combined indicator back to status-only and loses the chaizup-erp
    workflow signal. Removing `qty` blanks the new Qty fixture column.
  - The combined-indicator filter expression uses `status,=,X` (not
    workflow_state) because Frappe's list filter is keyed on the status
    field for the synthetic Status column. Clicking the pill MUST filter
    on status — that's what users expect from the indicator. Workflow
    filtering is available via the standard filter bar.
  - Object.assign({}, existing, {...}) → SHALLOW merge. ERPNext-provided
    keys we don't override (e.g., filters: [["status","!=","Stopped"]])
    are preserved. Don't switch to a deep merge — it would deduplicate
    add_fields entries in a way that breaks our explicit ordering.

RESTRICT
  ----------
  - Each add_fields string MUST be a real column on tabWork Order.
    Typo causes a SQL error at list-fetch time. The current five are
    framework + standard ERPNext + workflow column added by the site.
  - Do NOT add per-user mutating logic here (no save_user_settings,
    no localStorage). This file runs on every list-load for every user.
============================================================================
*/

(function () {
    const dt = "Work Order";
    const existing = frappe.listview_settings[dt] || {};

    // ── Indicator palette (status → color)  ───────────────────────────────
    // Frappe accepts color names: red, orange, yellow, green, blue,
    // gray, purple, pink, lightblue, darkgrey, cyan.
    const STATUS_COLOR = {
        "Draft":                  "red",
        "Not Started":            "orange",
        "Submitted":              "orange",
        "In Process":             "orange",
        "Completed":              "green",
        "Closed":                 "blue",
        "Stopped":                "red",
        "Stock Reserved":         "blue",
        "Stock Partially Reserved": "orange",
        "Cancelled":              "gray",
    };

    function combined_indicator(doc) {
        const status = (doc.status || "").trim();
        const wf     = (doc.workflow_state || "").trim();

        // Workflow_state "WO Rejected" is a HARD STOP — supersedes status colour.
        if (wf === "WO Rejected") {
            return [
                `${status || "Draft"} · ${wf}`,
                "red",
                "status,=," + (status || "Draft"),
            ];
        }

        // Normal path — pick color from status, append workflow_state when it
        // adds information (non-empty AND not the same word as status).
        const color = STATUS_COLOR[status] || "gray";
        let label = status || "Unknown";
        if (wf && wf.toLowerCase() !== status.toLowerCase()) {
            label = `${label} · ${wf}`;
        }
        return [__(label), color, "status,=," + status];
    }

    // 2026-05-27 v0.0.14 — add_fields gains `item_name` so the combined
    // "code : name" formatter below has data. Other 5 entries unchanged
    // from v0.0.12: status + workflow_state (combined indicator),
    // qty (Qty column), creation + owner (Created On / Created By).
    //
    // We DELIBERATELY drop ERPNext's add_fields (bom_no, sales_order,
    // produced_qty, expected_delivery_date, planned_start_date,
    // planned_end_date) — none are in the user-spec column set and they
    // bloat the per-row JSON payload.

    // v0.0.14 — Custom formatter for the "Item To Manufacture" column.
    // Renders the production_item cell as "<item_code> : <item_name>"
    // instead of just the item code. This matches the operator workflow
    // — code is canonical (used in stock vouchers) but name is the
    // human-readable identifier.
    //
    // The formatter signature `(value, df, doc)` lets us read sibling
    // fields from the row's doc; item_name is fetched via add_fields above.
    // Wrap in a span with text-muted on the name half so the code stays
    // visually prominent — matches Frappe's bold + muted convention.
    //
    // RESTRICT: never strip the escape on item_code or item_name. Both can
    // contain user-entered characters (colons, ampersands) that would
    // break the cell HTML if unescaped.
    const fmt_item_code_and_name = (value, df, doc) => {
        const esc = (s) => frappe.utils.escape_html(String(s || ""));
        const code = esc(value);
        const name = esc(doc.item_name);
        if (!code) return "";
        if (!name) return `<span class="bold">${code}</span>`;
        return `<span class="bold">${code}</span>` +
               `<span class="text-muted"> : ${name}</span>`;
    };

    // v0.0.16 — Batch No cell → hyperlink to /app/batch/<name>. Frappe's
    // Link-field list cells normally render as `${value}` plain text;
    // wrapping in <a target="_blank"> opens the linked Batch doc in a new
    // tab. Use rel="noopener" for security per OWASP guidance.
    //
    // RESTRICT: keep target="_blank" + rel="noopener". Opening in the same
    // tab would interrupt the operator's list-scanning workflow; rel is
    // required to prevent the opened page from window.opener-hijacking.
    const fmt_batch_no_link = (value) => {
        if (!value) return "";
        const esc = frappe.utils.escape_html(String(value));
        return `<a href="/app/batch/${encodeURIComponent(value)}"
                   target="_blank"
                   rel="noopener"
                   class="text-primary">${esc}</a>`;
    };

    // v0.0.21 — Production Plan cell → button-styled hyperlink that opens
    // the linked PP in a new tab. Renders in COLUMN 2 (Production Plan ID,
    // which is the second column per the v0.0.18 layout — the spec said
    // "first column" but column 1 is `name` which the framework reserves
    // for the WO's own ID; "Production Plan ID" at column 2 is the actual
    // PP column the user means).
    //
    // Empty cells get a muted "—" so the operator sees at-a-glance which
    // WOs have no PP (those are the manual ones, surfaceable via the
    // "Has Production Plan?" filter chip from v0.0.19).
    //
    // RESTRICT:
    //   - Keep `target="_blank"` + `rel="noopener"` (same as batch hyperlink).
    //   - The button-styled class (btn btn-xs btn-default) makes it visually
    //     distinct from the plain text Batch No hyperlink. Don't downgrade
    //     to a plain anchor — the user explicitly asked for a BUTTON.
    //   - URL-encode the PP name because it may contain slashes / colons
    //     in some site naming series.
    const fmt_pp_button = (value) => {
        if (!value) return `<span class="text-muted">—</span>`;
        const esc = frappe.utils.escape_html(String(value));
        return `<a href="/app/production-plan/${encodeURIComponent(value)}"
                   target="_blank"
                   rel="noopener"
                   class="btn btn-xs btn-default"
                   style="font-family: var(--font-stack-monospace); white-space: nowrap;"
                   title="${esc} — opens in new tab">
                    <svg style="width: 12px; height: 12px; vertical-align: -2px; margin-right: 3px;"
                         fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                    </svg>${esc}
                </a>`;
    };

    frappe.listview_settings[dt] = Object.assign({}, existing, {
        // v0.0.21 — add `production_plan` to add_fields so the PP-button
        // formatter has the value to render (production_plan is the
        // second column per v0.0.18, but its cell formatter needs the
        // field explicitly fetched).
        add_fields: ["status", "workflow_state", "qty", "item_name",
                     "production_plan", "creation", "owner"],
        get_indicator: combined_indicator,
        formatters: Object.assign({}, existing.formatters || {}, {
            production_item: fmt_item_code_and_name,
            custom_batch_no: fmt_batch_no_link,
            production_plan: fmt_pp_button,
        }),
        // v0.0.16 — onload: scope the standard-filter chips for `status`
        // and `workflow_state` to the values that actually exist on Work
        // Order.
        //
        //   - status: 7 enum values from ERPNext's Work Order DocType
        //     Select. Hardcoded here because Frappe sometimes auto-derives
        //     from distinct DB values, which can MISS states that haven't
        //     been used yet (e.g., "Stock Reserved" on a fresh install).
        //
        //   - workflow_state: 4 states from the chaizup WorkOrder-Wflow
        //     Workflow. Hardcoded because workflow_state is a Link →
        //     Workflow State (a global doctype with ALL states from every
        //     Workflow on the site). Without scoping, the chip would offer
        //     irrelevant states like "Pending Approval" (Sales Invoice
        //     Workflow), "Approved" (Leave Application Workflow), etc.
        //
        // The previous controller's onload (if any) is preserved by
        // calling existing.onload first.
        //
        // RESTRICT:
        //   - The WO_STATUSES list MUST mirror ERPNext's `Work Order.status`
        //     Select options. If ERPNext adds a status (e.g., a future
        //     "Paused" state), add it here too — otherwise users can't
        //     filter on it via the chip.
        //   - The WF_STATES list MUST mirror the chaizup-erp WorkOrder-Wflow
        //     Workflow's states. If new states are added there, add here.
        //     Out-of-sync lists silently hide the chip option.
        //   - Don't use frappe.db.get_list("Workflow State") to populate
        //     WF_STATES dynamically — that's the bug we're fixing. The
        //     scope is INTENTIONAL.
        onload(listview) {
            // Preserve any existing onload (ERPNext doesn't ship one, but
            // future framework upgrades might).
            if (existing.onload) {
                try { existing.onload(listview); }
                catch (e) { console.error("WO listview onload error:", e); }
            }

            const WO_STATUSES = [
                "Draft", "Submitted", "Not Started", "In Process",
                "Stock Reserved", "Stock Partially Reserved",
                "Completed", "Closed", "Stopped", "Cancelled",
            ];
            const WF_STATES = [
                "Draft", "WO Approved", "Taken In Production", "WO Rejected",
            ];

            // Hide the standard-filter dropdown's Frappe-auto options and
            // show ONLY our scoped list. We do this by overriding the
            // get_query on each filter field once the page is set up.
            //
            // Frappe ListView keeps filter fields in `listview.page.fields_dict`
            // keyed by fieldname. Patch each one's get_query to scope link
            // results to our allowed list.
            const scope_filter = (fieldname, values) => {
                const ctrl = listview.page && listview.page.fields_dict
                          && listview.page.fields_dict[fieldname];
                if (!ctrl) return;
                ctrl.get_query = () => ({
                    filters: { name: ["in", values] },
                });
                // Force a refresh of the awesomplete list if already shown.
                if (ctrl.awesomplete && ctrl.awesomplete.list !== undefined) {
                    ctrl.awesomplete.list = values;
                }
            };
            scope_filter("status",         WO_STATUSES);
            scope_filter("workflow_state", WF_STATES);

            // v0.0.20 — LIVE Item Group filter (replaces the broken v0.0.15
            // stale-snapshot custom_item_group field).
            //
            // CORRECTNESS REQUIREMENT (filter accuracy principle):
            //   Filters MUST reflect CURRENT state, never snapshot. v0.0.15's
            //   fetch_from approach captured Item.item_group at WO save time,
            //   so changing the Item's group later left old WOs filtering
            //   under the OLD group. v0.0.20 resolves Item Group at query
            //   time against the live tabItem rows — zero drift possible.
            //
            // IMPLEMENTATION:
            //   1. Add a custom toolbar button "Filter by Item Group" that
            //      opens a Link field picker for Item Group.
            //   2. On selection, query the live tabItem table for all items
            //      currently in that group (frappe.db.get_list).
            //   3. Apply the result as a `production_item in [...]` filter
            //      on the WO list, which is server-side fast (production_item
            //      is indexed) and ALWAYS reflects current Item Group
            //      membership.
            //
            // RESTRICT:
            //   - DO NOT add a stored mirror field to back this filter. The
            //     whole point is liveness. See memory:feedback_filter_accuracy_principle.
            //   - DO NOT cache the item-code resolution. Item.item_group
            //     reclassifications must propagate to the filter immediately.
            //   - DO NOT remove the button on subsequent refreshes — Frappe
            //     re-renders the toolbar on each list update; the page-level
            //     once-flag below guards against duplicate buttons.
            const setup_item_group_filter = () => {
                if (!listview.page || listview.__chaizup_ig_filter_setup) return;
                listview.__chaizup_ig_filter_setup = true;

                listview.page.add_inner_button(__("Filter by Item Group"), () => {
                    const d = new frappe.ui.Dialog({
                        title: __("Filter by Item Group (live)"),
                        fields: [
                            {
                                fieldtype: "Link", fieldname: "item_group",
                                label: __("Item Group"), options: "Item Group",
                                reqd: 1,
                                description: __("Resolves to all items currently in this group. Filter reflects CURRENT Item Group membership, never a saved snapshot."),
                            },
                        ],
                        primary_action_label: __("Apply filter"),
                        primary_action: (values) => {
                            d.hide();
                            // Live query — never cached, always current.
                            frappe.db.get_list("Item", {
                                filters: { item_group: values.item_group },
                                fields: ["name"],
                                limit: 0,        // no limit — all matching items
                            }).then(items => {
                                const codes = (items || []).map(i => i.name);
                                if (!codes.length) {
                                    frappe.show_alert({
                                        message: __("No items currently in Item Group {0}", [values.item_group]),
                                        indicator: "orange",
                                    });
                                    return;
                                }
                                // Apply as an `in` filter on production_item.
                                // listview.filter_area.add() adds to the chip
                                // strip + triggers a list refresh.
                                listview.filter_area.add([
                                    [dt, "production_item", "in", codes],
                                ]);
                                frappe.show_alert({
                                    message: __("Filtered to {0} items in Item Group {1}",
                                                [codes.length, values.item_group]),
                                    indicator: "green",
                                });
                            });
                        },
                    });
                    d.show();
                });
            };
            setup_item_group_filter();
        },
    });
})();
