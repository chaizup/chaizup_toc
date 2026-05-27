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

    frappe.listview_settings[dt] = Object.assign({}, existing, {
        add_fields: ["status", "workflow_state", "qty", "item_name",
                     "creation", "owner"],
        get_indicator: combined_indicator,
        formatters: Object.assign({}, existing.formatters || {}, {
            production_item: fmt_item_code_and_name,
            custom_batch_no: fmt_batch_no_link,
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
        },
    });
})();
