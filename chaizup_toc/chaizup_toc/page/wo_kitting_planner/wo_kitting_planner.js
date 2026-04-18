/**
 * wo_kitting_planner.js -- WO Kitting Planner Controller
 * ========================================================
 * Frappe Custom Page (page_name: wo-kitting-planner)
 *
 * PURPOSE
 * -------
 * Dynamic simulation of Work Order kitting feasibility.
 * Covers ALL open Work Orders — not restricted to TOC-enabled items.
 *
 * EXECUTIVE UX DESIGN
 * --------------------
 * Built for manufacturing executives who need to answer three questions fast:
 *   1. "Which orders can I produce TODAY?" → Green rows / Ready count
 *   2. "Which orders are blocked and why?" → Shortage chip → modal with recommendation
 *   3. "What do I need to order to unblock everything?" → One-click MR creation
 *
 * HELP SYSTEM
 * -----------
 * Three layers of contextual help for non-technical users:
 *   a) Floating tooltip (data-tip): hover any control for a plain-language description
 *   b) Column popover (? button): click ? to see a full column explanation with examples
 *   c) Modal recommendation card: every shortage modal starts with "what should I do"
 *
 * FEATURES
 * --------
 * - Stock Perspective X: physical Bin stock only
 * - Stock Perspective Y: Bin + open POs + open Purchase MRs + open WO expected output
 *   (Stock Mode now propagated to Dispatch tab — fg_stock includes FG PO inbound when Y)
 *   (Stock Mode change resets dispatch + item-view loaded flags → auto-refetch with new mode)
 * - Scenario A (Independent Check): each WO evaluated against FULL pool; order irrelevant
 * - Scenario B (Priority Queue): stock consumed in row order; drag rows to change priority
 * - Multi-level BOM toggle (Deep BOM Check — OFF by default for speed)
 * - Deep BOM chip (session 10): 🌳 Deep BOM shown per WO item if any component has its own BOM;
 *   click → _showBomTreeModal() → get_item_bom_tree() → collapsible tree up to 4 levels
 * - Summary strip: Ready / Partial / Blocked / Total / Shortage Value
 * - Shortage modal with recommendation card + per-component table (dual UOM + received qty)
 * - WO detail modal with decision guidance based on customer order pressure
 * - Warehouse picker dialog before MR creation (frappe.prompt — fixes Required Field error)
 * - Dispatch Bottleneck tab: SO-independent — shows ALL items with pending customer orders
 *   (submitted SOs AND draft SOs); customer column shows name + group + ERPNext ID;
 *   Draft SOs shown with amber "✏ Draft" badge; UOM on all qty columns;
 *   SO detail expand shows Ordered/Delivered/Pending in both stock UOM and secondary UOM;
 *   Coverage and Gap columns now show UOM label + secondary UOM (session 10)
 * - Material Shortage tab: dual UOM on all qty columns; per-WO breakdown; received_qty_po column;
 *   per-row checkboxes + "Create MR for Selected" button; MOQ + Lead Time columns;
 *   Details expand row shows per-WO shortage breakdown; UOM selector per row in MR dialog;
 *   Consolidated MR also uses the full review dialog (no longer a bare frappe.prompt);
 *   Item group filter bar (session 10): filter shortage table by item group;
 *   Material name is clickable (session 10) → _showMaterialSupplyModal(item_code)
 *     → get_material_supply_detail() → shows open POs / MRs / receipts / active batches;
 *   Duplicate WO detail bug fixed (session 10): same component in multiple BOM paths
 *     now sums shortage instead of pushing duplicate WO rows
 * - WO Kitting tab: "Already Produced" column (produced_qty) with dual UOM after "Qty to Produce"
 * - AI Advisor: model selector with cost estimates; auto-insight uses HTML formatting;
 *   context includes UOM fields (uom, secondary_uom, secondary_factor) for accurate quantity citation;
 *   8 function-calling tools (server-side); AI cites which tools it used via wkp-ai-tools-badge;
 *   item_code always included in AI responses — enforced via system prompt rule (session 10);
 *   Data points indicator (session 10): shows "Data fed to AI: N WOs, M materials, ..." under insight;
 *   compress_context_for_ai sends item_code in critical_wos + top_shortages (session 10)
 * - 360° Cost Audit per WO: "₹ Cost" button in last column → frappe.ui.Dialog showing:
 *   BOM standard cost breakdown (qty_per_unit × valuation_rate per component),
 *   actual consumed cost (Stock Entry Manufacture type), per-unit cost in stock UOM + secondary UOM,
 *   variance (actual − standard, color-coded), last 5 completed WOs for same item (historical)
 * - FG Item View tab: all items with active WOs or pending SOs grouped by item_code;
 *   columns: WO count, kit status summary, planned/produced/remaining, consumed (SE),
 *   SO demand, last historical production cost per unit with live UOM selector
 * - Export: CSV download (ALL tabs — wo-plan, shortage-report, emergency, dispatch, item-view);
 *   PDF via browser print (new tab)
 * - Email: frappe.ui.Dialog → To / CC / Subject / Report tab selector;
 *   Python send_dashboard_email() wraps inline-styled snapshot HTML in an email template
 *   with sender info, live dashboard link, and sent date; uses frappe.sendmail()
 * - UI polish (session 11): restored .wkp-btn base definition (buttons had no padding/bg/border
 *   after an earlier edit removed it); added explicit color:#ffffff to .wkp-btn-brand at all
 *   states (hover text was merging with the orange background); emergency/dispatch/AI panes
 *   now have slate-100 tinted backgrounds so white cards inside float with visible depth;
 *   AI pane has 10px/12px padding revealing tinted bg around cards; emergency cards converted
 *   from flat border-bottom list to card-list style (border + border-radius + shadow + margin gap);
 *   tab bar uses white bg + 2px bottom border + shadow for a clearer navigation layer;
 *   shortage/emergency/dispatch section headers explicitly use slate-50 tint
 * - Session 12 additions:
 *   Tab renamed: "Dispatch Risk" → "Dispatch Bottleneck" (HTML + data-tip updated)
 *   Global Search: #wkp-global-search in cmd bar; _applyGlobalSearch() filters rows in active tab;
 *     supports all tabs (wo-plan/shortage/emergency/dispatch/item-view); re-applies on tab switch;
 *     CSS .wkp-search-active / .wkp-search-match / .wkp-search-no-match for visual feedback
 *   Dispatch SO dedup: same Sales Order appearing multiple times in so_list (when SO has multiple
 *     child rows for the same item_code) is now merged client-side by so_name; soCount reflects
 *     true unique SO count; qty/pending/delivered/dn_qty summed; reserved_qty/pick_list_count maxed
 *   Item View Last Cost/Unit: removed manual UOM dropdown selector; now auto-shows all UOM costs
 *     stacked (stock UOM primary, secondary UOM derived, additional item_uoms from item_uoms list);
 *     cost per secondary UOM = baseCost × secondary_factor; no JS change required after render
 *   AI Decision Dashboard: #wkp-ai-dashboard-btn in AI right panel; _generateDecisionDashboard()
 *     sends structured prompt asking for 5-section management report (priorities, critical WOs,
 *     procurement, dispatch bottlenecks, actions); response shown as AI chat bubble
 *   360° Cost Audit improvements:
 *     - Horizontal scroll: .wkp-cost-section { overflow-x: auto } in CSS (was overflow: hidden)
 *     - Batch-wise consumed: _get_wo_actual_cost() now groups by (item_code, batch_no, posting_date);
 *       hasBatch flag shows/hides Batch + Date columns dynamically in actRows table
 *     - Source annotation: sub-header bar under each section title explains which doctype/field
 *       each value comes from (BOM: tabBOM Item × tabItem.valuation_rate; Actual: tabStock Entry Detail)
 *   Table headers: --stone-* CSS variables are undefined in :root (only --slate-* defined);
 *     session 12 CSS block adds !important overrides on all .wkp-*table thead th selectors
 *   Modal width: .wkp-modal and .wkp-modal-wide both set to max-width: 70vw
 *   Tooltip: uses innerHTML (not textContent) so HTML in data-tip renders correctly;
 *     \n in data-tip values is converted to <br> before injection; background forced via !important
 *
 * - Session 15 additions (2026-04-18):
 *   AI Advisor layout fix: .wkp-ai-model-row CSS added (previously missing — was using
 *     full-height .wkp-select padding=8px, inflating chat section and pushing input off-screen
 *     on 13-inch laptops). Model row now uses padding:4px 10px + font-size:11px.
 *   AI right column breakpoint raised: 1100px → 1300px. On 13-inch (1280px wide), right guide
 *     column (220px quick-questions) is now hidden, giving full width to the chat input area.
 *   AI pane padding reduced: 10px/12px → 6px/8px. Reclaims 8px vertical on small screens.
 *   @media (max-height:820px): .wkp-ai-input-hint hidden (saves 18px); model row compressed.
 *   Quick questions improved: 8 action-oriented prompts specific to factory decision-making.
 *   Auto-insight prompt (server): added "highest-risk item" sentence; Impact col now shows
 *     qty + days to delivery; action steps must be executable TODAY.
 *   System prompt (server): added "Be direct, specific, actionable" rule; no hedging.
 *   "Product View" tab renamed to "Item View" (data-tip updated: WO open or SO open).
 *   Purchase Priority heading frozen: .wkp-pp-pane overflow:hidden (was overflow-y:auto);
 *     #wkp-pp-body now overflow:auto — only the table body scrolls, header/legend/guide frozen.
 *   Purchase Priority item group filter: .wkp-pp-filter-bar above #wkp-pp-body;
 *     JS: data-group on each TR, filter binds in _renderPurchasePriority() after render.
 *     Filter bar shown only if >1 group in data; hides paired detail expand rows on filter.
 *   WKP-033: PP item group filter uses data-group attribute on <tr>. Do NOT remove this
 *     attribute or the filter binding in _renderPurchasePriority() will break silently.
 *
 * - Session 14 additions (2026-04-18):
 *   Purchase Priority tab (§11): new lazy-loaded tab showing materials to buy for WOs backed
 *     by open Sales Orders (any docstatus 0=Draft, 1=Submitted, 1=To Bill).
 *     Two-level BOM discovery:
 *       Level 1 (direct): BOM components of open WOs for FG items with open SOs.
 *       Level 2 (indirect): BOM components of open SFG WOs whose output is a Level-1 component.
 *     Per material: required_qty, in_stock, open_po_qty, open_mr_qty, net_gap, moq, lead_time_days.
 *     Sorted by: urgency (overdue > this_week > this_month > future), then earliest SO delivery, then net_gap.
 *     Urgency tiers: overdue (delivery < today), this_week (≤ 7 days), this_month (≤ 30 days), future.
 *     MR creation: reuses _openMRQtyDialog() + create_purchase_mr_for_wo_shortages (same as Shortage tab).
 *     Per-row checkboxes (.wkp-pp-chk) + "Create MR for Selected" + "Create MR All Gaps" buttons.
 *     Supply pipeline modal: reuses _showMaterialSupplyModal() (click material name).
 *     Details expand rows show linked WOs + SOs per material.
 *     CSV export: wkp_purchase_priority.csv via _exportCSV().
 *     Python API: get_purchase_priority() in wo_kitting_api.py (lazy — NOT called on load).
 *     Tab CSS class: .wkp-tab-btn-pp (teal accent). Pane: #wkp-pane-purchase-priority.
 *     Guide strip: What / Why / How / When — procurement decision guidance.
 *
 * - Session 13 additions (2026-04-18):
 *   Font Awesome 6 Free icons: all OS-dependent emoji replaced with FA icons.
 *     HTML: FA CDN <link> added before #wkp-root; all tab/summary/cmd-bar emoji → <i class="fa-solid ...">
 *     JS: _updateHintBar() uses innerHTML + FA icons instead of textContent + emoji
 *     IMPORTANT: FA icon <i> elements must use class="fa-solid fa-name" (double quotes only — WKP-001)
 *   Global Search bug fix (WKP-029): tabBodyMap["shortage-report"] was ".wkp-short-table tbody"
 *     (wrong class — table has class wkp-shortage-table and ID wkp-sr-table). Fixed to "#wkp-sr-table tbody".
 *     Also: search loop now skips .wkp-sr-detail-row — classifying them as no-match hid the expand
 *     rows permanently and broke the Details onclick button (CSS display:none blocked the toggle).
 *   Item group filter + BOM expand fix (WKP-030): item group filter loop now also hides the paired
 *     .wkp-sr-detail-row when a main shortage row is filtered out. Detail row ID = "wkp-sr-d-" +
 *     item_code with non-alphanumeric chars replaced by "_". Detail button text is also reset to
 *     "▼ Details" so it shows correctly when the filter is cleared.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔒 RESTRICTED — DO NOT CHANGE (these are load-bearing architectural choices)
 * ══════════════════════════════════════════════════════════════════════
 * WKP-001: NO single quotes anywhere in wo_kitting_planner.html.
 *          Frappe wraps the HTML file content in a JS single-quoted string at render time.
 *          Single quotes inside the HTML will break the entire page with a JS parse error.
 *          Use &apos; / &amp; / &gt; / &#x27; or template literals inside method strings.
 *
 * WKP-002: ALWAYS flush Redis cache after ANY file change:
 *          redis-cli -h redis-cache -p 6379 FLUSHALL
 *          Without this, Frappe serves the old file from cache.
 *
 * WKP-004: simulate() MUST use this.woOrder (not this.rows.map(r=>r.wo)) to preserve
 *          Scenario B drag-reorder. Using rows directly resets priority to original WO order.
 *
 * WKP-006: AI context: NEVER send rows or dispatch keys to the LLM.
 *          These are 300+ WOs × 10 shortage items each — HTTP 400 from DeepSeek.
 *          Always strip: context_for_ai = {k: v for k, v in ctx.items() if k not in ("rows","dispatch")}
 *
 * WKP-012: WO Kitting tab column order must stay in sync between HTML <th> and JS _buildRow() <td>.
 *          Current order: drag | seq | WO | item | qty_to_produce | produced_qty | status | cost |
 *          prev_so | curr_so | total_so | erp_status | view
 *          If columns are reordered in HTML without matching JS, data displays in wrong column.
 *
 * WKP-013: _openMRQtyDialog UOM selects are paired with qty inputs BY INDEX.
 *          CSS.escape is not universally available; the NodeLists must stay in sync.
 *
 * WKP-015/016: Sticky table headers REQUIRE flex layout on the pane + flex:1;overflow:auto
 *          on the scroll container child. Changing layout to block/grid will break sticky.
 *
 * WKP-027: Global search state is stateless — it reads #wkp-global-search.value on tab switch.
 *          Do not cache search state per tab; always re-run _applyGlobalSearch() on switch.
 *
 * WKP-028: Dispatch SO dedup (soListDedup) is purely client-side — the server returns one row
 *          per SO child table row. Do NOT remove the dedup logic; removing it re-introduces
 *          inflated SO counts and duplicate SO rows in the expand view.
 *
 * WKP-029: Cost audit batch column (hasBatch) uses a colspan on tfoot. If you add/remove
 *          columns from the actRows table, update actColSpan accordingly.
 *          ALSO: Global search selector for shortage-report tab is "#wkp-sr-table tbody" (by ID).
 *          Do NOT change back to a class selector — the shortage table has no class "wkp-short-table".
 *          Detail rows (.wkp-sr-detail-row) must be skipped in the search loop — they are expand
 *          rows, not data rows; classifying them as no-match permanently hides them via CSS.
 *
 * WKP-030: Item View cost display no longer uses a <select> UOM selector.
 *          The removal of wkp-iv-uom-sel / data-base-cost / data-base-factor is intentional.
 *          Costs are now stacked (stock UOM primary, secondary, extras). Do not re-add the select.
 *          ALSO: Item group filter in shortage table MUST sync .wkp-sr-detail-row visibility.
 *          When a main row is hidden by the filter, its paired detail row (ID = "wkp-sr-d-" +
 *          item_code.replace(/[^a-zA-Z0-9]/g,"_")) must also be hidden and the Details button
 *          text reset. Without this, expand rows float disconnected after filter+expand sequences.
 *
 * WKP-032: Purchase Priority tab — lazy-loaded; do NOT call get_purchase_priority() from
 *          simulate(), load(), or any auto-trigger path. It runs heavy multi-table SQL.
 *          _ppLoaded resets only when stockMode changes (same pattern as _dispatchLoaded).
 *          #wkp-pp-table is the global search selector for the tab (tabBodyMap key).
 *          .wkp-pp-chk checkboxes are bound after render inside _renderPurchasePriority().
 *          Do NOT bind them in constructor or bindControls — the table doesn't exist yet.
 *          Level "indirect" rows are sub-assembly components — they trace one BOM level deeper
 *          than the FG WO. Do NOT remove this distinction (CSV "Level" column preserves it).
 *          MR creation uses _openMRQtyDialog (same as Shortage tab) — items must have
 *          {item_code, item_name, uom, qty, moq, secondary_uom, secondary_factor} structure.
 *
 * WKP-033: PP item group filter uses `data-group` attribute on each main `<tr>` row in
 *          #wkp-pp-table. The filter in _renderPurchasePriority() reads `tr.dataset.group`.
 *          Do NOT remove the data-group attribute from the row template string.
 *          Filter bar (#wkp-pp-filter-bar) is shown/hidden by JS after render (not HTML style).
 *          Detail expand rows (class=wkp-sr-detail-row) are skipped by the filter loop.
 *          Paired detail row ID = "wkp-pp-d-" + item_code.replace(/[^a-zA-Z0-9]/g, "_").
 *
 * WKP-031: Icons — always use Font Awesome 6 Free <i class="fa-solid fa-name"> elements.
 *          NEVER revert to Unicode emoji (textContent) for any icon that JS sets dynamically.
 *          _updateHintBar() uses innerHTML = '<i ...>' not textContent = emoji.
 *          Reason: emoji render differently per OS/device/font; FA icons are consistent everywhere.
 *          FA CDN: cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css
 *          WKP-001 still applies: all HTML in this file and in template strings must use double
 *          quotes for HTML attributes (class="fa-solid fa-name" is correct; class='...' is NOT).
 *
 * _dispatchData, _dispatchLoaded, _dispatchLoading: keyed state for dispatch tab caching.
 *   Change these only if you also update _fetchDispatchData() and _switchTab().
 * _shortageAggList: set by _renderShortageReport(), consumed by _bindShortageCheckboxes().
 *   Do not pre-clear or share between tabs.
 * _aiContext, _aiSessionId: AI session state. _aiContext is the compressed context object.
 *   Do not strip data_points key — it is used by _updateAIDataPointsBadge().
 *
 * UOM DISPLAY (all tabs)
 * ----------------------
 * Every quantity is shown in BOTH the stock UOM and the next higher UOM.
 * Three rendering patterns:
 *   a) Stacked (table cells):
 *      "5,000 g" on line 1, "5.00 kg" in a smaller sub-line below
 *      Used by: _buildRow(), shortage report (_dualQtySR), shortage modal (_dualQty),
 *               dispatch tab qty cells
 *   b) Inline with parens (text/cards):
 *      "5,000 g (5.00 kg)" all on one line
 *      Used by: emergency cards (_dualInline), WO detail modal (_woDual),
 *               decision card (_dcDual), shortage modal subtitle
 *   c) Inline separator (compact headings):
 *      "380 kg / 380,000 g" — short 2-unit label
 *      Used by: shortage modal title suffix
 *
 * Backend provides secondary_uom + secondary_factor per item via _get_secondary_uom().
 * secondary_qty (pre-computed for remaining_qty) is on WO rows from simulate_kitting().
 *
 * UI FLOW
 * -------
 *   on_page_load → init() → _bindControls() + _initAIPanel() + load()
 *   load()      → API get_open_work_orders → this.woOrder → simulate()
 *   simulate()  → API simulate_kitting → this.rows → _render()
 *   _render()   → _updateSummary() + _renderTable() + _renderShortageReport()
 *   Shortage chip → _showShortageModal(row) [reco card + component table]
 *   Per-WO MR btn → frappe.prompt(warehouse) → _createMR(row)
 *   Checkbox MR  → _bindShortageCheckboxes() → select items → _showMRConfirmModal()
 *                  → uses a.moq from _shortageAggList → _openMRQtyDialog() (frappe.ui.Dialog)
 *                  → user edits qtys + selects UOM per row + picks warehouse
 *                  → create_purchase_mr_for_wo_shortages
 *   Consolidated → _createConsolidatedMR(allNetGapItems) → _openMRQtyDialog() same dialog
 *   Dispatch tab → _fetchDispatchData() → get_dispatch_bottleneck(stock_mode) →
 *                  _renderDispatchBottleneck() [merges SO data + WO will_produce]
 *                  SO detail shows: customer_name / customer_group / customer ID
 *                  stock_mode passed to API so FG PO inbound is added when mode=Y
 *   AI tab      → _initAIPanel() → get_available_ai_models() → populate #wkp-ai-model-select
 *              → simulate triggers compress_context_for_ai → get_ai_auto_insight(model)
 *              → user messages → chat_with_planner(model)
 *   Item View tab → _fetchItemView() → get_item_wo_summary() → _renderItemView()
 *              merges this.rows (kit_status counts) with API data (SO + cost)
 *              all UOM costs stacked automatically (stock UOM + secondary + extras)
 *   Export CSV → _exportCSV() → _downloadCSV() (all tabs: wo-plan, shortage-report,
 *              emergency, dispatch, item-view)
 *   Export PDF → _exportPDF() → window.open() + print() (landscape, email-safe HTML)
 *   Email      → _showEmailDialog() (frappe.ui.Dialog) → _buildEmailSnapshot(tab)
 *              → send_dashboard_email() → frappe.sendmail() with inline-styled HTML
 *
 * API CALLS
 * ---------
 *   chaizup_toc.api.wo_kitting_api.get_open_work_orders
 *   chaizup_toc.api.wo_kitting_api.simulate_kitting          → rows with secondary_uom fields
 *   chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages  → requires warehouse
 *   chaizup_toc.api.wo_kitting_api.get_items_min_order_qty   → (legacy; MOQ now from procInfo)
 *   chaizup_toc.api.wo_kitting_api.get_items_procurement_info → MOQ + lead_time_days per item;
 *                                                               called eagerly in _renderShortageReport
 *   chaizup_toc.api.wo_kitting_api.get_dispatch_bottleneck   → args: stock_mode; all SO items incl.
 *                                                               drafts; so_list includes customer_name/group,
 *                                                               so_docstatus (0=Draft,1=Submitted);
 *                                                               when stock_mode=current_and_expected,
 *                                                               FG PO inbound qty added to fg_stock
 *   chaizup_toc.api.wo_kitting_api.get_item_bom_tree         → args: item_code, max_depth=4
 *                                                               → hierarchical BOM tree (session 10)
 *   chaizup_toc.api.wo_kitting_api.get_material_supply_detail → args: item_code
 *                                                               → {open_pos, open_mrs,
 *                                                               recent_receipts, active_batches}
 *                                                               (session 10 — shortage tab modal)
 *   chaizup_toc.api.wo_kitting_api.compress_context_for_ai   → enriched summary + supply chain;
 *                                                               critical_wos includes uom fields +
 *                                                               item_code (session 10);
 *                                                               top_shortages includes item_code (s10);
 *                                                               data_points key for UI indicator (s10);
 *                                                               dispatch_alerts includes uom+item_name
 *   chaizup_toc.api.wo_kitting_api.get_ai_auto_insight       → args: context_json, model
 *   chaizup_toc.api.wo_kitting_api.chat_with_planner         → args: message, session_id,
 *                                                               context_json, model
 *                                                               → returns: {reply, session_id,
 *                                                               is_html, tools_used}
 *   chaizup_toc.api.wo_kitting_api.get_available_ai_models   → model list with cost estimates
 *   chaizup_toc.api.wo_kitting_api.get_wo_cost_audit        → args: wo_name
 *                                                               → {bom_components, actual_consumed,
 *                                                               std_cost_per_unit, total_actual_cost,
 *                                                               variance_total, variance_pct, historical}
 *   chaizup_toc.api.wo_kitting_api.get_item_wo_summary     → no args; returns list per item_code:
 *                                                               {item_code, item_name, item_group,
 *                                                               stock_uom, secondary_uom, secondary_factor,
 *                                                               item_uoms[], wo_count, wo_list[],
 *                                                               planned_qty, produced_qty, remaining_qty,
 *                                                               consumed_qty, consumed_cost,
 *                                                               so_count, so_pending_qty,
 *                                                               last_cost_per_unit, last_cost_wo, last_cost_date}
 *   chaizup_toc.api.wo_kitting_api.get_purchase_priority  → no args; returns list sorted by urgency:
 *                                                               [{item_code, item_name, item_group,
 *                                                               uom, secondary_uom, secondary_factor,
 *                                                               required_qty, in_stock, open_po_qty,
 *                                                               open_mr_qty, net_gap, moq, lead_time_days,
 *                                                               wo_count, so_count, earliest_delivery,
 *                                                               is_overdue, urgency, level,
 *                                                               wo_list[], so_list[]}]
 *                                                               (session 14 — Purchase Priority tab)
 *   chaizup_toc.api.wo_kitting_api.send_dashboard_email    → args: to_emails, cc_emails, subject,
 *                                                               snapshot_html, report_tab
 *                                                               → {sent, from_name, to[], cc[]}
 *
 * AI FUNCTION TOOLS (server-side, in _AI_TOOLS in wo_kitting_api.py)
 * -------------------------------------------------------------------
 *   get_wo_shortage_detail(wo_name)   → shortage_items for a specific WO
 *   get_dispatch_detail(item_code)    → SO breakdown for a specific FG item
 *   get_top_shortage_items(rank_by)   → top materials by value or frequency
 *   get_ready_to_produce()            → WOs with kit_status ok/kitted
 *   get_blocked_work_orders()         → WOs with kit_status block/partial + top blocker
 *   get_fulfillment_outlook()         → per-item demand vs production coverage
 *   get_overdue_customer_orders()     → WOs with prev_month_so > 0
 *   get_cost_audit(wo_name)           → BOM std vs actual, variance, historical avg cost
 *
 * KNOWN BUGS / GOTCHAS
 * --------------------
 * WKP-001: No single quotes in .html file (Frappe wraps HTML in JS single-quoted string).
 *          Dynamically generated JS strings (frappe.ui.Dialog, innerHTML in methods) are fine.
 * WKP-002: After any file change: redis-cli -h redis-cache -p 6379 FLUSHALL
 * WKP-003: _applyHeight() uses getBoundingClientRect().top — run after DOM paint
 * WKP-004: simulate() must use this.woOrder to preserve Scenario B drag order
 * WKP-005: Tooltip div #wkp-tooltip is inside wkp-root, positioned via fixed CSS
 * WKP-006: AI context: NEVER send rows/dispatch to LLM — HTTP 400 (too many tokens)
 *          Use: context_for_ai = {k: v for k, v in context.items() if k not in ("rows","dispatch")}
 * WKP-007: _shortageAggList is set in _renderShortageReport() and consumed by checkbox handlers.
 *          It is cleared to [] at the start of each render — stale references after re-render are safe.
 * WKP-010: Warehouse required on MR create — fixed via frappe.prompt in _createMR();
 *          _openMRQtyDialog uses frappe.ui.Dialog with a Link field (full autocomplete).
 * WKP-011: _appendChatBubble now takes 4th arg toolsUsed[] — tools-badge shown below AI reply.
 *          tools_used comes from chat_with_planner response (server tracks which fn names ran).
 * WKP-012: WO Kitting tab column order must stay in sync between HTML <th> and JS _buildRow() <td>.
 *          Current order: drag | seq | WO | item | qty_to_produce | produced_qty | status | cost |
 *          prev_so | curr_so | total_so | erp_status | view
 * WKP-013: _openMRQtyDialog UOM selects are paired with qty inputs BY INDEX (not by data-item)
 *          because CSS.escape is not universally available. The two NodeLists must stay in sync:
 *          one select per item row, immediately after the qty input column.
 * WKP-014: Dispatch SO detail — so.qty / so.delivered_qty / so.pending_qty are in item.uom (stock UOM).
 *          item.secondary_factor converts stock→secondary: secondary_qty = stock_qty / secondary_factor.
 *          Example: item.uom=gram, item.secondary_uom=kg, item.secondary_factor=1000 → 5000g → 5.00kg.
 * WKP-015: WO plan tab sticky heading requires #wkp-pane-wo-plan to be display:flex so
 *          .wkp-table-wrap (flex:1;overflow:auto) gets a definite height and becomes the
 *          scroll container. Without this, table-wrap expands to content height, pane scrolls,
 *          and position:sticky on thead th has no effect (overflow:auto intercepts before pane).
 * WKP-016: Shortage tab sticky heading — #wkp-pane-shortage must be display:flex and
 *          #wkp-shortage-body must be flex:1;overflow:auto. Without this, the sticky header
 *          sticks to top:0 of the pane (behind the shortage title bar), causing overlap.
 * WKP-017: Dispatch tab draft SOs — _get_open_so_detail() includes docstatus IN (0,1).
 *          Draft SOs carry so_docstatus=0; JS renders a "✏ Draft" amber badge. Draft SOs
 *          are never marked is_overdue (cannot be overdue until submitted).
 * WKP-018: Cost audit actual data: _get_wo_actual_cost() filters Stock Entry by
 *          purpose='Manufacture' AND s_warehouse IS NOT NULL. If the finished good row
 *          has BOTH s_warehouse and t_warehouse set (some ERPNext configs), it may appear
 *          in the consumed list. Guard: the finished good's item_code ≠ any BOM component,
 *          so a small mismatch is usually harmless. If std_cost_per_unit=0, the BOM has
 *          no active submitted BOM — check ERPNext BOM list for that item.
 * WKP-019: Item View UOM selector: cost recalculation is client-side only (factor × base_cost).
 *          This is an approximation — accurate cross-UOM cost requires SE data in that UOM.
 *          The selector is for display convenience only; do not use for P&L reporting.
 * WKP-020: Email snapshot is capped at 25 rows to avoid email size limits. The email always
 *          includes a live dashboard link. PDF export opens a new tab — some browsers may
 *          block pop-ups; instruct users to allow pop-ups for this site.
 * WKP-021: Deep BOM detection queries tabBOM for component items that have their own submitted
 *          active BOMs. Only first-level components are checked (not recursive). A component
 *          that is a sub-assembly in a WO BOM but has no submitted BOM will NOT be flagged.
 *          Multi-level toggle (Deep BOM Check) expands the BOM to sub-assembly components —
 *          separate from the has_deep_bom visual indicator (which is always shown).
 * WKP-022: Dispatch tab stock_mode propagation: when Stock Mode Y is selected, the dispatch
 *          API adds open FG PO inbound qty to fg_stock. This changes Total Coverage and Gap
 *          values on the dispatch tab. Mode change resets _dispatchLoaded so a fresh fetch
 *          occurs — without this reset, the old fg_stock would be shown after mode toggle.
 * WKP-023: Shortage report duplicate WO detail (fixed session 10): a component appearing in
 *          multiple BOM paths for the same WO was pushed to wo_detail multiple times, inflating
 *          WO count in the Details expand. Fix: find existing WO entry in wo_detail and sum
 *          shortage instead of pushing a new entry. wo_list.includes() already prevented
 *          duplicate WO names in the count; wo_detail needed the same dedup logic.
 * WKP-024: Material supply modal batch valuation uses a correlated subquery on SLE. For items
 *          with large SLE history this may be slow. If performance is an issue, add an index on
 *          (item_code, batch_no, posting_date) in tabStock Ledger Entry.
 * WKP-025: BOM tree modal toggle targets IDs built from item_code. IDs are scoped to the
 *          dialog DOM — no risk of collision with page elements. If item_code contains special
 *          chars, they are sanitised via replace(/[^a-zA-Z0-9]/g, "_").
 * WKP-026: .wkp-btn base styles are defined in the SESSION 11 block at the END of
 *          wo_kitting_planner.css. The session-7 "button polish" block (~mid-file) is
 *          an override only — it assumes the base definition exists and adds hover shadows.
 *          If the session-11 block is ever removed, all buttons will lose all visual styling.
 *          Do NOT remove that block without providing a replacement base definition.
 */

"use strict";


// ═══════════════════════════════════════════════════════════════════════
//  COLUMN HELP POPOVER CONTENT
//  Shown when the user clicks a ? button on a column header.
//  Write in plain business language — assume the reader is an executive,
//  not an ERP administrator.
// ═══════════════════════════════════════════════════════════════════════

const WKP_POPOVERS = {

  item_name: {
    title: "Item Name &amp; Item Group",
    body:  "The ERPNext item name (product description) for what this Work Order will produce.\n\nBelow the item name, the Item Group is shown &mdash; this is the category the item belongs to in your Item master (e.g. Finished Goods, Raw Materials, Packaging).",
    example: "Item Name: Masala Blend 500g Pouch\nItem Group: Finished Goods\nItem Code: MBLND-500G",
    action: "Use the Item Group filter above the table to narrow the list to a specific product category.",
  },

  remaining_qty: {
    title: "Qty Still to Produce",
    body:  "How many units of this product still need to be manufactured to complete this Work Order.\n\nCalculated as: Planned Qty &minus; Already Produced Qty.\n\nData source: Work Order &rarr; Qty, Produced Qty fields.",
    example: "Work Order planned: 500 kg\nAlready produced: 120 kg\nStill to produce: 380 kg",
    action: "Focus on WOs with high remaining qty AND unshipped customer orders &mdash; those are your highest urgency.",
  },

  produced_qty: {
    title: "Already Produced (Completed Qty)",
    body:  "How many units of this product have already been manufactured and received into the Finished Goods warehouse for this Work Order.\n\nThis quantity is physically in stock and is available for dispatch to customers right now.\n\nData source: Work Order &rarr; Produced Qty field in ERPNext.\n\nNote: This is different from Qty to Produce (remaining). The two together add up to the total Work Order planned quantity.",
    example: "Work Order planned: 500 kg\nAlready produced: 120 kg (in FG stock, ready to dispatch)\nStill to produce: 380 kg (production in progress or pending)",
    action: "If a WO shows both a large Produced Qty AND a blocked material status, some stock is already available for partial dispatch &mdash; check with your dispatch team before waiting for the full order.",
  },

  shortage: {
    title: "Material Status",
    body:  "Whether all the raw materials needed for this production run are available in the warehouse.\n\n\u2714 Ready to Produce &mdash; Everything is in stock. Can start now.\n\u26A0 N materials missing &mdash; Some items are short. Click to see which ones.\n\u26D4 Cannot Start &mdash; Critical materials are missing. Production is blocked.\n\nData source: BOM components vs Bin (warehouse stock).",
    example: "Masala Blend 500g BOM needs:\n  Chili Powder: need 80kg, have 120kg \u2714\n  Salt: need 50kg, have 20kg \u2716\n  Result: 1 material missing",
    action: "Click any chip to see the full material breakdown with PO/MR quantities and consumption data.",
  },

  est_cost: {
    title: "Estimated Production Cost",
    body:  "Rough cost estimate for the remaining production quantity.\n\nCalculation: Item master Valuation Rate \u00D7 Remaining Qty\n\nThis is a quick estimate only. For a full cost breakdown &mdash; BOM standard cost vs what was actually consumed, per-unit cost in all UOMs, cost variance, and historical comparison &mdash; click the <strong>\u20B9 Cost</strong> button at the end of each row.",
    example: "Remaining: 380 kg\nValuation rate: \u20B9120 per kg\nEst. cost: \u20B945,600\n\nClick \u20B9 Cost to see: BOM recipe cost vs actual Stock Entry consumption vs last 5 completed WOs.",
    action: "Use Est. Cost to spot high-value WOs quickly. Use the \u20B9 Cost audit to investigate valuation accuracy \u2014 incorrect costs here flow directly into your P&amp;L.",
  },

  prev_so: {
    title: "Last Month Unshipped Orders",
    body:  "Qty of this product that was due for delivery in the PREVIOUS calendar month but has NOT yet been shipped to customers.\n\nThese orders are OVERDUE. Customers are already waiting.\n\nData source: Sales Order Items where delivery_date is in previous month and delivered_qty &lt; qty.",
    example: "Today is April 15. This column shows undelivered customer orders with delivery dates in March.",
    action: "Any value here means overdue deliveries. Prioritize these WOs immediately.",
  },

  curr_so: {
    title: "This Month Customer Orders",
    body:  "Qty of this product that customers have ordered with delivery due in the CURRENT calendar month, not yet shipped.\n\nThese are upcoming commitments that need to be met.\n\nData source: Sales Order Items where delivery_date is in current month.",
    example: "Today is April 15. This shows undelivered orders due by April 30.",
    action: "Compare against Qty to Produce to check if you can fulfil this month&apos;s commitments.",
  },

  total_so: {
    title: "Total Unshipped Customer Orders",
    body:  "Total pending customer order quantity across both last month (overdue) and this month (due soon).\n\nThis is the total demand pressure on this Work Order.\n\nCalculation: Last Month Unshipped + This Month Orders.",
    example: "Last month unshipped: 200 kg\nThis month orders: 300 kg\nTotal unshipped: 500 kg",
    action: "If Total Unshipped &gt; Qty to Produce, you may need to create additional Work Orders.",
  },

  dispatch_coverage: {
    title: "Total Coverage (FG Stock + Will Produce)",
    body:  "How much of this finished good will be available to dispatch when all open Work Orders complete.\n\nCalculation:\n  FG In Stock = physical qty in warehouse (Bin.actual_qty)\n  Will Produce = sum of remaining_qty across all open WOs for this item\n  Total Coverage = FG In Stock + Will Produce",
    example: "FG In Stock: 200 kg\nOpen WOs remaining: 600 kg\nTotal Coverage: 800 kg\nCustomer Orders: 750 kg\nGap: -50 kg (surplus = on track)",
    action: "If Coverage is less than Customer Orders, you need either more WOs or to expedite blocked WOs.",
  },

  dispatch_gap: {
    title: "Dispatch Gap (Coverage vs Customer Orders)",
    body:  "Gap = Customer Orders (Pending Dispatch) minus Total Coverage (FG In Stock + Will Produce).\n\nPositive gap = SHORTAGE: customer demand exceeds what you can produce and deliver.\nNegative gap = SURPLUS: you will have more than enough.\nZero = exactly enough.\n\nNote: This does not account for WOs that are blocked or partially blocked.",
    example: "Customer Orders: 1,000 kg\nTotal Coverage: 800 kg\nGap: +200 kg = 200 kg SHORT\nAction: Create additional Work Orders or find alternative stock.",
    action: "Focus first on Critical items (positive gap) then At Risk items (enough coverage but WOs are blocked).",
  },

  wo_status: {
    title: "ERP Production Stage (ERPNext Status)",
    body:  "The exact Work Order status as it appears in ERPNext Manufacturing:\n\nNot Started &mdash; Work Order created but production has not begun. Materials may not yet be issued.\n\nIn Process &mdash; Production is actively ongoing. Materials have been partially consumed.\n\nMaterial Transferred &mdash; All required materials have been issued (transferred) to the production floor via a Stock Entry. Production can now start.\n\nCompleted &mdash; Production is done. Finished goods received into warehouse.\n\nStopped &mdash; Work Order was manually stopped.",
    example: "A WO showing Material Transferred but kit_status=block means the kitting simulation is using fresh stock (the transferred materials may have already been issued).",
    action: "Use the Show WOs filter in the command bar to narrow by this status.",
  },
};


// ─────────────────────────────────────────────────────────────────────────
//  BOM TREE RENDERER  (used by _showBomTreeModal)
//  Renders a recursive BOM node as indented HTML.
//  Each level shows a collapse toggle, item code+name, UOM, qty per unit.
// ─────────────────────────────────────────────────────────────────────────

function _renderBomNode(node, depth) {
  const nodeId = "wkp-bom-n-" + (node.item_code || "").replace(/[^a-zA-Z0-9]/g, "_") + "-" + depth;
  const hasChildren = node.children && node.children.length > 0;
  const indent = depth * 20;

  const toggle = hasChildren
    ? `<span class="wkp-bom-toggle" data-target="${nodeId}" style="cursor:pointer;margin-right:4px">\u25BC</span>`
    : `<span style="display:inline-block;width:16px;margin-right:4px"></span>`;

  const hasBomBadge = node.has_bom
    ? `<span class="wkp-bom-badge-has" title="Has its own BOM">\uD83C\uDF33 Has BOM</span>`
    : "";
  const truncBadge  = node.truncated
    ? `<span class="wkp-bom-badge-trunc" title="Tree truncated at depth limit">\u2026 deeper levels exist</span>`
    : "";

  const childrenHtml = hasChildren
    ? `<div id="${nodeId}" class="wkp-bom-children">${node.children.map(c => _renderBomNode(c, depth + 1)).join("")}</div>`
    : "";

  return `
<div class="wkp-bom-node" style="margin-left:${indent}px">
  <div class="wkp-bom-row">
    ${toggle}
    <span class="wkp-bom-item-code">${_esc(node.item_code)}</span>
    <span class="wkp-bom-item-name">${_esc(node.item_name || "")}</span>
    ${node.qty_per_unit && node.qty_per_unit !== 1
      ? `<span class="wkp-bom-qty">\u00D7${_fmt_num(node.qty_per_unit, 3)}\u00a0${_esc(node.uom || "")}</span>`
      : `<span class="wkp-bom-qty">${_esc(node.uom || "")}</span>`}
    ${hasBomBadge}${truncBadge}
  </div>
  ${childrenHtml}
</div>`;
}


// ═══════════════════════════════════════════════════════════════════════
//  PAGE ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

frappe.pages["wo-kitting-planner"].on_page_load = function (wrapper) {
  if (wrapper._wkp_initialized) return;
  wrapper._wkp_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "WO Kitting Planner",
    single_column: true,
  });

  $(frappe.render_template("wo_kitting_planner", {})).appendTo(page.body);

  const planner = new WOKittingPlanner(wrapper, page);
  wrapper._wkp_planner = planner;
  planner.init();
};

frappe.pages["wo-kitting-planner"].on_page_show = function (wrapper) {
  if (wrapper._wkp_planner) {
    requestAnimationFrame(() => wrapper._wkp_planner._applyHeight());
  }
};


// ═══════════════════════════════════════════════════════════════════════
//  MAIN CONTROLLER CLASS
// ═══════════════════════════════════════════════════════════════════════

class WOKittingPlanner {
  constructor(wrapper, page) {
    this.wrapper = wrapper;
    this.page    = page;

    this.stockMode    = "current_only";
    this.calcMode     = "isolated";
    this.multiLevel   = false;
    this.statusFilter = "";
    this._company     = frappe.defaults.get_default("company") || "";

    this.woOrder  = [];
    this.rows     = [];
    this._loading = false;
    this._dragSrc = null;

    // Tab system
    this._activeTab = "wo-plan";  // "wo-plan" | "shortage-report" | "emergency" | "dispatch" | "item-view"

    // Dispatch bottleneck data (fetched from separate API call after load)
    this._dispatchData   = {};   // {item_code: {fg_stock, total_pending, so_list, ...}}
    this._dispatchLoaded = false; // true once API responded
    this._dispatchLoading = false; // true while API call in-flight

    // Item View data (FG-wise WO + SO summary)
    this._itemViewData    = [];   // array from get_item_wo_summary()
    this._itemViewLoaded  = false;
    this._itemViewLoading = false;

    // Purchase Priority data (on-demand — loaded only when tab is first clicked)
    this._ppData    = [];   // array from get_purchase_priority()
    this._ppLoaded  = false;
    this._ppLoading = false;

    // Client-side filter state (applied in _getFilteredRows)
    this._filterItemGroup = "";   // item_group value from filter bar
    this._filterKitStatus = "";   // kit_status value
    this._filterUrgency   = "";   // "overdue" | "due" | "none" | ""

    // Help system
    this._tipEl    = null;   // floating tooltip element
    this._popEl    = null;   // column help popover element
    this._tipTimer = null;

    // ── AI Advisor state ──────────────────────────────────────────────
    // Session ID: UUID persisted in sessionStorage so it survives tab
    // navigation within the same browser session but resets on full refresh.
    this._aiSessionId     = this._getOrCreateAISession();
    this._aiContext       = null;   // compressed context object (set after simulate)
    this._aiInsightLoaded = false;  // true once auto-insight has been fetched
    this._aiTyping        = false;  // true while waiting for AI response
    // ──────────────────────────────────────────────────────────────────
  }

  // ─────────────────────────────────────────────────────────────────────
  //  INIT
  // ─────────────────────────────────────────────────────────────────────

  init() {
    this._bindControls();
    this._bindTabs();
    this._bindFilterBar();
    this._loadDynamicFilters();
    this._initHelpSystem();
    this._initAIPanel();
    this._setupFullHeight();
    this._updateHintBar();
    this.load();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  HELP SYSTEM
  //  Two layers:
  //    1. Floating tooltip: shows on hover for [data-tip] elements
  //    2. Column popover: shows on click of .wkp-th-help ? buttons
  // ─────────────────────────────────────────────────────────────────────

  _initHelpSystem() {
    // ── Tooltip setup ──
    this._tipEl = document.getElementById("wkp-tooltip");
    this._popEl = document.getElementById("wkp-popover");

    // Delegate tooltip for any [data-tip] element inside wkp-root
    const root = document.getElementById("wkp-root");
    if (!root || !this._tipEl) return;

    root.addEventListener("mouseover", e => {
      const target = e.target.closest("[data-tip]");
      if (!target) return;
      clearTimeout(this._tipTimer);
      this._tipTimer = setTimeout(() => {
        // innerHTML mode: convert newlines to <br>, allow safe HTML
        // data-tip values are hardcoded in HTML — not user input, safe to inject
        const raw = (target.dataset.tip || "").replace(/\n/g, "<br>");
        this._tipEl.innerHTML = raw;
        this._tipEl.classList.add("wkp-tip-visible");
        this._tipEl.style.display = "block";
        this._positionTip(e);
      }, 300);
    });

    root.addEventListener("mousemove", e => {
      if (this._tipEl && this._tipEl.classList.contains("wkp-tip-visible")) {
        this._positionTip(e);
      }
    });

    root.addEventListener("mouseout", e => {
      if (!e.target.closest("[data-tip]")) return;
      clearTimeout(this._tipTimer);
      this._tipEl.classList.remove("wkp-tip-visible");
      this._tipEl.style.display = "none";
    });

    // ── Column popover setup ──
    // Delegated — works even after table re-renders
    root.addEventListener("click", e => {
      const btn = e.target.closest(".wkp-th-help");
      if (btn) {
        e.stopPropagation();
        this._showPopover(btn, btn.dataset.popover);
        return;
      }
      // Click anywhere else → close popover
      if (!e.target.closest("#wkp-popover")) {
        this._hidePopover();
      }
    });

    const closeBtn = document.getElementById("wkp-pop-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this._hidePopover());

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        this._hidePopover();
        this._closeModal("wkp-modal");
        this._closeModal("wkp-wo-modal");
      }
    });
  }

  _positionTip(mouseEvent) {
    if (!this._tipEl) return;
    const x = mouseEvent.clientX;
    const y = mouseEvent.clientY;
    const tw = this._tipEl.offsetWidth  || 240;
    const th = this._tipEl.offsetHeight || 60;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + 14;
    let top  = y - th - 10;

    if (left + tw > vw - 10) left = x - tw - 10;
    if (top < 6)             top  = y + 16;
    if (top + th > vh - 6)  top  = vh - th - 6;

    this._tipEl.style.left = left + "px";
    this._tipEl.style.top  = top  + "px";
  }

  _showPopover(anchor, key) {
    const content = WKP_POPOVERS[key];
    if (!content || !this._popEl) return;

    document.getElementById("wkp-pop-title").textContent = content.title || "";
    document.getElementById("wkp-pop-body").textContent  = content.body  || "";

    const exEl  = document.getElementById("wkp-pop-example");
    const exTxt = document.getElementById("wkp-pop-ex-text");
    if (content.example) {
      exTxt.textContent     = content.example;
      exEl.style.display    = "";
    } else {
      exEl.style.display    = "none";
    }

    const actEl = document.getElementById("wkp-pop-action");
    if (content.action) {
      actEl.textContent  = "\uD83D\uDCA1 " + content.action;
      actEl.style.display = "";
    } else {
      actEl.style.display = "none";
    }

    // Position below anchor
    this._popEl.style.display = "block";
    const rect   = anchor.getBoundingClientRect();
    const popW   = 300;
    const popH   = this._popEl.offsetHeight || 180;
    const vw     = window.innerWidth;
    const vh     = window.innerHeight;

    let left = rect.left + rect.width / 2 - popW / 2;
    let top  = rect.bottom + 8;

    if (left + popW > vw - 10) left = vw - popW - 10;
    if (left < 6)              left = 6;
    if (top + popH > vh - 10)  top  = rect.top - popH - 8;

    this._popEl.style.left = left + "px";
    this._popEl.style.top  = top  + "px";
  }

  _hidePopover() {
    if (this._popEl) this._popEl.style.display = "none";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  FULL-HEIGHT SETUP
  // ─────────────────────────────────────────────────────────────────────

  _setupFullHeight() {
    window.addEventListener("resize", () => this._applyHeight());
    this._applyHeight();
  }

  _applyHeight() {
    const root = document.getElementById("wkp-root");
    if (!root) return;
    const top = Math.round(root.getBoundingClientRect().top);
    root.style.height = Math.max(300, window.innerHeight - top - 4) + "px";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CONTROL BINDING
  // ─────────────────────────────────────────────────────────────────────

  _bindControls() {
    // ── Summary Card Click-to-Filter ───────────────────────────────────────
    // WKP-026: Each card in the summary strip can be clicked to quickly
    // filter the main table by that status (Ready, Partial, Blocked).
    // This is a major UX win for layman users who want to see "just the bad ones".
    const cardStatusMap = {
      "wsum-ready"   : "ok",
      "wsum-partial" : "partial",
      "wsum-blocked" : "block",
    };
    Object.entries(cardStatusMap).forEach(([id, status]) => {
      const card = document.getElementById(id)?.closest(".wkp-sum-card");
      if (card) {
        card.style.cursor = "pointer";
        card.addEventListener("click", () => {
          const statusSel = document.getElementById("wkp-fbar-status");
          if (statusSel) {
            // Toggle logic: if already filtered by this status, clear it.
            const newVal = (this._filterKitStatus === status) ? "" : status;
            statusSel.value = newVal;
            statusSel.dispatchEvent(new Event("change"));

            // Visual feedback on the card
            document.querySelectorAll(".wkp-sum-card").forEach(c => c.style.borderColor = "");
            if (newVal) card.style.borderColor = "var(--brand-500)";
          }
        });
      }
    });

    // Stock X / Y toggle
    document.querySelectorAll("#wkp-seg-stock .wkp-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (this.stockMode === btn.dataset.val) return;
        document.querySelectorAll("#wkp-seg-stock .wkp-seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.stockMode = btn.dataset.val;
        // Stock mode affects dispatch FG stock calculation and item view — reset so they re-fetch
        this._dispatchLoaded  = false;
        this._dispatchLoading = false;
        this._itemViewLoaded  = false;
        this.simulate();
      });
    });

    // Scenario A / B toggle
    document.querySelectorAll("#wkp-seg-calc .wkp-seg-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        if (this.calcMode === btn.dataset.val) return;
        document.querySelectorAll("#wkp-seg-calc .wkp-seg-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.calcMode = btn.dataset.val;
        // Calc mode affects which WOs are blocked — dispatch and item view must re-fetch
        this._dispatchLoaded  = false;
        this._dispatchLoading = false;
        this._itemViewLoaded  = false;
        this._updateHintBar();
        this.simulate();
      });
    });

    // Deep BOM Check toggle
    const mlBtn        = document.getElementById("wkp-multilevel-btn");
    const mlDot        = document.getElementById("wkp-ml-dot");
    const mlSubLabel   = mlBtn && mlBtn.closest(".wkp-pill-group")
                          ? mlBtn.closest(".wkp-pill-group").querySelector(".wkp-pill-sublabel")
                          : null;

    if (mlBtn) {
      mlBtn.addEventListener("click", () => {
        this.multiLevel = !this.multiLevel;
        mlBtn.classList.toggle("active", this.multiLevel);
        mlDot.classList.toggle("active", this.multiLevel);
        if (mlSubLabel) {
          mlSubLabel.textContent = this.multiLevel
            ? "Sub-assemblies: ON"
            : "Sub-assemblies: OFF";
          mlSubLabel.style.color = this.multiLevel
            ? "var(--brand-600)"
            : "";
        }
        this.simulate();
      });
    }

    // Status filter
    document.getElementById("wkp-status-filter").addEventListener("change", e => {
      this.statusFilter = e.target.value;
      this.load();
    });

    // Refresh
    document.getElementById("wkp-refresh").addEventListener("click", () => this.load());

    // Export / Email buttons
    const csvBtn   = document.getElementById("wkp-export-csv");
    const pdfBtn   = document.getElementById("wkp-export-pdf");
    const emailBtn = document.getElementById("wkp-send-email");
    if (csvBtn)   csvBtn.addEventListener("click",   () => this._exportCSV());
    if (pdfBtn)   pdfBtn.addEventListener("click",   () => this._exportPDF());
    if (emailBtn) emailBtn.addEventListener("click", () => this._showEmailDialog());

    // Global search
    const searchInput = document.getElementById("wkp-global-search");
    const searchClear = document.getElementById("wkp-search-clear");
    if (searchInput) {
      let searchTimer;
      searchInput.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => this._applyGlobalSearch(searchInput.value), 200);
        if (searchClear) searchClear.style.display = searchInput.value ? "block" : "none";
      });
      searchInput.addEventListener("keydown", e => {
        if (e.key === "Escape") {
          searchInput.value = "";
          this._applyGlobalSearch("");
          if (searchClear) searchClear.style.display = "none";
        }
      });
    }
    if (searchClear) {
      searchClear.addEventListener("click", () => {
        if (searchInput) searchInput.value = "";
        this._applyGlobalSearch("");
        searchClear.style.display = "none";
      });
    }

    // Modal close buttons + backdrop click
    ["wkp-modal-close", "wkp-wo-close"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("click", () => {
        this._closeModal("wkp-modal");
        this._closeModal("wkp-wo-modal");
      });
    });

    document.getElementById("wkp-modal").addEventListener("click", e => {
      if (e.target.id === "wkp-modal") this._closeModal("wkp-modal");
    });
    document.getElementById("wkp-wo-modal").addEventListener("click", e => {
      if (e.target.id === "wkp-wo-modal") this._closeModal("wkp-wo-modal");
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  GLOBAL SEARCH (cross-tab row filtering)
  // ─────────────────────────────────────────────────────────────────────
  //
  //  Tab-aware: searches within whichever tab is currently active.
  //  Matches against the textContent of each <tr> in the tab's table.
  //  Rows that do not match get class wkp-search-no-match (CSS hides them).
  //  Rows that match get wkp-search-match (CSS highlights them subtly).
  //  The containing table gets wkp-search-active while a query is active.
  //
  //  Minimum 2 characters before filtering begins (single-char is noisy).
  //
  _applyGlobalSearch(query) {
    const q = query.trim().toLowerCase();
    const tab = this._activeTab;

    // Map tab name to which tbody to search
    // WKP-029: shortage-report uses #wkp-sr-table (id) not .wkp-short-table (class does not exist)
    const tabBodyMap = {
      "wo-plan"          : "#wkp-tbody",
      "shortage-report"  : "#wkp-sr-table tbody",
      "emergency"        : "#wkp-emerg-list .wkp-emerg-card",
      "dispatch"         : ".wkp-dsp-table tbody",
      "item-view"        : ".wkp-iv-table tbody",
      "purchase-priority": "#wkp-pp-table tbody",
    };

    const selector = tabBodyMap[tab];
    if (!selector) return;  // AI tab — no rows to filter

    if (tab === "emergency") {
      // Emergency tab uses card layout instead of table rows
      const cards = document.querySelectorAll(".wkp-emerg-card");
      const active = q.length >= 2;
      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        card.classList.remove("wkp-search-match", "wkp-search-no-match");
        if (active) {
          if (text.includes(q)) card.classList.add("wkp-search-match");
          else card.classList.add("wkp-search-no-match");
        }
      });
      const pane = document.getElementById("wkp-pane-emergency");
      if (pane) pane.classList.toggle("wkp-search-active", active);
      return;
    }

    const tbody = document.querySelector(selector);
    if (!tbody) return;

    const table = tbody.closest("table");
    const active = q.length >= 2;
    if (table) table.classList.toggle("wkp-search-active", active);

    // WKP-029: skip .wkp-sr-detail-row — they are expand rows, not searchable items.
    // Classifying them as no-match hides them via CSS and blocks the Detail onclick expand.
    const rows = tbody.querySelectorAll("tr");
    rows.forEach(tr => {
      if (tr.classList.contains("wkp-sr-detail-row")) return;
      tr.classList.remove("wkp-search-match", "wkp-search-no-match");
      if (!active) return;
      const text = tr.textContent.toLowerCase();
      if (text.includes(q)) tr.classList.add("wkp-search-match");
      else tr.classList.add("wkp-search-no-match");
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DATA LOADING
  // ─────────────────────────────────────────────────────────────────────

  load() {
    this._showLoader(true);
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_open_work_orders",
      args: { status_filter: this.statusFilter },
      callback: r => {
        if (r.exc) {
          this._showLoader(false);
          frappe.show_alert({ message: "Failed to load Work Orders.", indicator: "red" });
          return;
        }
        const wos = r.message || [];
        if (!wos.length) {
          this._showLoader(false);
          this._showEmpty(true);
          this._showAllPanes(false);
          this._resetSummary();
          this._setHintText("No open Work Orders found. Create Work Orders in the Manufacturing module.");
          return;
        }
        this.woOrder = wos.map(w => w.name);
        this.simulate();
      },
    });
  }

  simulate() {
    if (!this.woOrder.length) return;
    this._showLoader(true);
    this._hidePopover();
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.simulate_kitting",
      args: {
        work_orders_json : JSON.stringify(this.woOrder),
        stock_mode       : this.stockMode,
        calc_mode        : this.calcMode,
        multi_level      : this.multiLevel ? 1 : 0,
      },
      callback: r => {
        this._showLoader(false);
        if (r.exc) {
          frappe.show_alert({ message: "Simulation failed. Check console.", indicator: "red" });
          return;
        }
        this.rows = r.message || [];
        this._render();
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  RENDER
  // ─────────────────────────────────────────────────────────────────────

  _render() {
    if (!this.rows.length) {
      this._showEmpty(true);
      this._showAllPanes(false);
      const fbar = document.getElementById("wkp-filter-bar");
      if (fbar) fbar.style.display = "none";
      this._resetSummary();
      return;
    }
    const fbar = document.getElementById("wkp-filter-bar");
    if (fbar) fbar.style.display = this._activeTab === "wo-plan" ? "" : "none";
    this._showEmpty(false);
    this._updateSummary(this.rows);
    this._updateHintBar(this.rows);
    this._populateItemGroupFilter(this.rows);
    this._renderShortageReport(this.rows);
    this._renderEmergencyPanel(this.rows);
    // Prefetch dispatch data in background (independent of active tab)
    this._dispatchLoaded  = false;
    this._dispatchData    = {};
    this._fetchDispatchData();
    // Reset Item View so it reloads with fresh simulation data
    this._itemViewLoaded  = false;
    this._itemViewData    = [];
    // Reset AI insight so it regenerates with fresh simulation data
    this._aiInsightLoaded = false;
    this._aiContext       = null;
    this._compressContextAndFetchInsight();
    this._switchTab(this._activeTab);  // show/render the active pane
  }

  _updateSummary(rows) {
    let ready = 0, partial = 0, blocked = 0;
    let shortageVal = 0;
    for (const r of rows) {
      const s = r.kit_status;
      if (s === "ok" || s === "kitted") ready++;
      else if (s === "partial")         partial++;
      else if (s === "block")           blocked++;
      shortageVal += r.shortage_value || 0;
    }
    document.getElementById("wsum-ready").textContent   = ready;
    document.getElementById("wsum-partial").textContent = partial;
    document.getElementById("wsum-blocked").textContent = blocked;
    document.getElementById("wsum-total").textContent   = rows.length;
    document.getElementById("wsum-shortage-val").textContent =
      "\u20B9" + _fmt_num(shortageVal, 0);
  }

  _resetSummary() {
    ["wsum-ready", "wsum-partial", "wsum-blocked", "wsum-total", "wsum-shortage-val"]
      .forEach(id => { document.getElementById(id).textContent = "--"; });
  }

  _renderTable(rows) {
    const filtered = this._getFilteredRows(rows);
    const tbody    = document.getElementById("wkp-tbody");
    tbody.innerHTML = filtered.map((row, idx) => this._buildRow(row, idx)).join("");
    this._updateFilterCount(filtered.length, rows.length);
    this._bindRowActions();
    this._bindSeqInput();
    if (this.calcMode === "sequential") this._bindDragDrop();
    this._setDragHandleState(this.calcMode === "sequential");
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CLIENT-SIDE FILTERING
  // ─────────────────────────────────────────────────────────────────────

  _getFilteredRows(rows) {
    return rows.filter(r => {
      if (this._filterItemGroup && r.item_group !== this._filterItemGroup) return false;
      if (this._filterKitStatus && r.kit_status !== this._filterKitStatus) return false;
      if (this._filterUrgency === "overdue" && !(r.prev_month_so > 0)) return false;
      if (this._filterUrgency === "due"     && !(r.curr_month_so > 0 || r.prev_month_so > 0)) return false;
      if (this._filterUrgency === "none"    && (r.total_pending_so > 0)) return false;
      return true;
    });
  }

  _updateFilterCount(shown, total) {
    const el = document.getElementById("wkp-fbar-count");
    if (!el) return;
    if (shown < total) {
      el.textContent = "Showing " + shown + " of " + total + " WOs";
      el.style.display = "";
    } else {
      el.textContent = "";
      el.style.display = "none";
    }
  }

  _buildRow(row, idx) {
    const statusClass = {
      ok: "wkp-row-ok", partial: "wkp-row-warn",
      block: "wkp-row-block", kitted: "wkp-row-kitted",
    }[row.kit_status] || "";

    const chipClass = {
      ok: "wkp-short-ok", partial: "wkp-short-warn",
      block: "wkp-short-block", kitted: "wkp-short-kitted",
    }[row.kit_status] || "wkp-short-ok";

    // Business-language chip text
    const sc = row.shortage_count || 0;
    const chipText = {
      ok      : "\u2714 Ready to Produce",
      partial : sc + " material" + (sc === 1 ? "" : "s") + " missing \u2014 click to see",
      block   : "\u26D4 Cannot Start \u2014 click to see",
      kitted  : "\u2713 Already Kitted",
    }[row.kit_status] || "\u2014";

    // Customer urgency badge
    const totalSO = row.total_pending_so || 0;
    let urgencyBadge = "";
    let highPriorityClass = "";

    if (totalSO > 0) {
      const isOverdue = (row.prev_month_so || 0) > 0;
      const cls = isOverdue ? "wkp-pressure-high" : "wkp-pressure-med";
      const lbl = isOverdue ? "\u26A0 Overdue orders!" : "Orders due";
      urgencyBadge = `<span class="wkp-pressure ${cls}">${lbl}: ${_fmt_num(totalSO, 0)}</span>`;

      // WKP-027: Apply a subtle glow/highlight to rows with overdue SOs
      if (isOverdue) highPriorityClass = "wkp-row-priority-glow";
    }

    const estCostTxt = row.est_cost
      ? "\u20B9" + _fmt_num(row.est_cost, 0) : "\u2014";
    const prevSo  = (row.prev_month_so   || 0) > 0 ? _fmt_num(row.prev_month_so,   0) : "\u2014";
    const currSo  = (row.curr_month_so   || 0) > 0 ? _fmt_num(row.curr_month_so,   0) : "\u2014";
    const totalSoTxt = totalSO > 0
      ? `<span style="font-weight:700">${_fmt_num(totalSO, 0)}</span>${urgencyBadge}`
      : "\u2014";

    const isClickable = row.kit_status !== "kitted" && (row.shortage_items || []).length > 0;
    const chipTip  = isClickable
      ? "Click to see which materials are missing and what action to take"
      : (row.kit_status === "ok" ? "All materials available in warehouse" : "");
    const stageBadgeCls = _status_badge_class(row.status);

    // Use EXACT ERPNext status name — no translation, no alias.
    const stageLbl = row.status || "\u2014";

    const statusTip = {
      "Not Started"         : "Work Order created. Production has not started. Materials not yet issued.",
      "In Process"          : "Production is actively ongoing. Materials being consumed on the floor.",
      "Material Transferred": "All materials have been issued to the production floor via Stock Entry.",
      "Completed"           : "Production complete. Finished goods received into warehouse.",
      "Stopped"             : "Work Order manually stopped. No further production expected.",
    }[row.status] || row.status || "";

    // Sequence input (active in Mode B, read-only in Mode A)
    const seqInput = `<input class="wkp-seq-input" type="number" min="1"
      value="${idx + 1}" data-wo="${_esc(row.wo)}" data-idx="${idx}"
      title="Type a number to change priority order (applies only in Mode B &mdash; Priority Queue)"
      ${this.calcMode !== "sequential" ? "readonly" : ""}>`;

    // Modern row rendering with zebra striping and priority highlight
    const rowClasses = `wkp-tr ${statusClass} ${highPriorityClass} ${idx % 2 === 0 ? "wkp-row-even" : "wkp-row-odd"}`;

    return `
<tr class="${rowClasses}" data-wo="${_esc(row.wo)}" data-idx="${idx}">
  <td class="wkp-td-drag">
    <span class="wkp-drag-handle" title="Drag to change priority (Mode B only)">\u2630</span>
  </td>
  <td class="wkp-td-seq">${seqInput}</td>
  <td>
    <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-wo-link"
       title="Open this Work Order in ERPNext">${_esc(row.wo)}</a>
  </td>
  <td>
    <div class="wkp-item-name">${_esc(row.item_name || row.item_code)}</div>
    <div class="wkp-item-code">${_esc(row.item_code)}</div>
    ${row.item_group ? `<div class="wkp-item-group-tag">${_esc(row.item_group)}</div>` : ""}
    ${row.has_deep_bom
      ? `<span class="wkp-deep-bom-chip" data-action="bom-tree"
               data-item="${_esc(row.item_code)}" data-bom="${_esc(row.bom_no || "")}"
               title="This item has a multi-level BOM \u2014 some components are themselves manufactured. Click to explore."
               >\uD83C\uDF33 Deep BOM</span>`
      : ""}
  </td>
  <td class="ta-r"
      data-tip="Qty to Produce (Remaining)&#10;How many units still need to be manufactured.&#10;Formula: Work Order Planned Qty &minus; Already Produced Qty">
    <div class="wkp-qty-primary">${_fmt_num(row.remaining_qty, 0)}</div>
    <div class="wkp-qty-uom">${_esc(row.uom || "")}</div>
    ${row.secondary_uom ? `<div class="wkp-qty-secondary">${_fmt_num(row.secondary_qty || (row.remaining_qty / (row.secondary_factor || 1)), 2)}\u00a0${_esc(row.secondary_uom)}</div>` : ""}
  </td>
  <td class="ta-r"
      data-tip="Already Produced&#10;Qty already manufactured and received into Finished Goods warehouse.&#10;This stock is available for dispatch right now.&#10;Source: Work Order Produced Qty field in ERPNext.">
    ${(row.produced_qty || 0) > 0
      ? `<div class="wkp-qty-primary wkp-text-ok">${_fmt_num(row.produced_qty, 0)}</div>
         <div class="wkp-qty-uom">${_esc(row.uom || "")}</div>
         ${row.secondary_uom ? `<div class="wkp-qty-secondary">${_fmt_num((row.produced_qty) / (row.secondary_factor || 1), 2)}\u00a0${_esc(row.secondary_uom)}</div>` : ""}`
      : `<span style="color:var(--slate-300)">\u2014</span>`}
  </td>
  <td>
    <span class="wkp-short-chip ${chipClass}"
          data-wo="${_esc(row.wo)}"
          style="cursor:${isClickable ? "pointer" : "default"}"
          data-tip="${chipTip}">
      ${chipText}
    </span>
  </td>
  <td class="ta-r font-mono">${estCostTxt}</td>
  <td class="ta-r ${(row.prev_month_so || 0) > 0 ? "wkp-cell-red font-bold" : ""}">${prevSo}</td>
  <td class="ta-r">${currSo}</td>
  <td class="ta-r">${totalSoTxt}</td>
  <td>
    <span class="wkp-status-badge ${stageBadgeCls}"
          data-tip="${statusTip}"
          title="${_esc(row.status || "")}">
      ${_esc(stageLbl)}
    </span>
  </td>
  <td class="ta-r wkp-td-actions">
    <button class="wkp-btn wkp-btn-sm" data-action="wo-detail" data-wo="${_esc(row.wo)}"
            title="View full detail: quantities, customer orders, material breakdown">
      View
    </button>
    <button class="wkp-btn wkp-btn-sm wkp-btn-cost" data-action="cost-audit" data-wo="${_esc(row.wo)}"
            title="360\u00b0 Cost Audit \u2014 BOM standard vs actual consumed cost, per-unit cost in all UOMs, variance and historical comparison">
      \u20b9 Cost
    </button>
  </td>
</tr>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  ROW ACTION BINDING
  // ─────────────────────────────────────────────────────────────────────

  _bindRowActions() {
    document.querySelectorAll(".wkp-short-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === chip.dataset.wo);
        if (row && (row.shortage_items || []).length > 0) this._showShortageModal(row);
      });
    });

    document.querySelectorAll("[data-action='wo-detail']").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === btn.dataset.wo);
        if (row) this._showWOModal(row);
      });
    });

    document.querySelectorAll("[data-action='cost-audit']").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === btn.dataset.wo);
        if (row) this._showCostAuditModal(row);
      });
    });

    document.querySelectorAll("[data-action='bom-tree']").forEach(chip => {
      chip.addEventListener("click", () => {
        this._showBomTreeModal(chip.dataset.item, chip.dataset.bom);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DEEP BOM TREE MODAL
  //  Shows a collapsible hierarchical BOM tree for items with multi-level BOMs.
  //  Triggered by the 🌳 Deep BOM chip in _buildRow().
  // ─────────────────────────────────────────────────────────────────────

  _showBomTreeModal(item_code, _bom_no) {  // _bom_no reserved for future use
    const d = new frappe.ui.Dialog({
      title: "BOM Tree: " + item_code,
      size: "large",
      fields: [{ fieldtype: "HTML", fieldname: "tree_html" }],
    });
    d.fields_dict.tree_html.$wrapper.html(
      `<div style="padding:12px;color:var(--stone-400);font-style:italic">Loading BOM tree\u2026</div>`
    );
    d.show();

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_item_bom_tree",
      args: { item_code, max_depth: 4 },
      callback: r => {
        const tree = r && r.message;
        if (!tree) {
          d.fields_dict.tree_html.$wrapper.html(
            `<div class="wkp-bom-tree-empty">No active BOM found for ${_esc(item_code)}.</div>`
          );
          return;
        }
        d.fields_dict.tree_html.$wrapper.html(
          `<div class="wkp-bom-tree-wrap">${_renderBomNode(tree, 0)}</div>`
        );
        // Bind collapse toggles
        d.fields_dict.tree_html.$wrapper.find(".wkp-bom-toggle").on("click", function() {
          const target = document.getElementById(this.dataset.target);
          if (target) {
            const open = target.style.display !== "none";
            target.style.display = open ? "none" : "";
            this.textContent = open ? "\u25B6" : "\u25BC";
          }
        });
      },
      error: () => {
        d.fields_dict.tree_html.$wrapper.html(
          `<div class="wkp-bom-tree-empty">Error loading BOM tree.</div>`
        );
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DRAG AND DROP (Scenario B / Priority Queue)
  // ─────────────────────────────────────────────────────────────────────

  _bindDragDrop() {
    const tbody = document.getElementById("wkp-tbody");
    if (!tbody) return;
    tbody.querySelectorAll("tr.wkp-tr").forEach(tr => {
      tr.setAttribute("draggable", "true");
      tr.addEventListener("dragstart", e => this._onDragStart(e, tr));
      tr.addEventListener("dragover",  e => this._onDragOver(e, tr));
      tr.addEventListener("dragleave", ()  => tr.classList.remove("wkp-drag-over"));
      tr.addEventListener("drop",      e => this._onDrop(e, tr));
      tr.addEventListener("dragend",   ()  => {
        document.querySelectorAll(".wkp-dragging, .wkp-drag-over")
          .forEach(el => el.classList.remove("wkp-dragging", "wkp-drag-over"));
        this._dragSrc = null;
      });
    });
  }

  _onDragStart(e, tr) {
    this._dragSrc = tr;
    tr.classList.add("wkp-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tr.dataset.wo);
  }

  _onDragOver(e, tr) {
    e.preventDefault();
    if (!this._dragSrc || this._dragSrc === tr) return;
    e.dataTransfer.dropEffect = "move";
    document.querySelectorAll(".wkp-drag-over").forEach(el => el.classList.remove("wkp-drag-over"));
    tr.classList.add("wkp-drag-over");
  }

  _onDrop(e, tr) {
    e.preventDefault();
    if (!this._dragSrc || this._dragSrc === tr) return;
    tr.classList.remove("wkp-drag-over");
    this._dragSrc.classList.remove("wkp-dragging");

    const tbody   = document.getElementById("wkp-tbody");
    const allRows = [...tbody.querySelectorAll("tr.wkp-tr")];
    const srcIdx  = allRows.indexOf(this._dragSrc);
    const tgtIdx  = allRows.indexOf(tr);

    if (srcIdx < tgtIdx) tr.parentNode.insertBefore(this._dragSrc, tr.nextSibling);
    else                  tr.parentNode.insertBefore(this._dragSrc, tr);

    this.woOrder = [...tbody.querySelectorAll("tr.wkp-tr")].map(r => r.dataset.wo);
    tbody.querySelectorAll("tr.wkp-tr").forEach((row, i) => {
      const s = row.querySelector(".wkp-td-seq");
      if (s) s.textContent = i + 1;
    });
    this.simulate();
  }

  _setDragHandleState(enabled) {
    document.querySelectorAll(".wkp-drag-handle").forEach(h => {
      h.style.opacity = enabled ? "1" : "0.2";
      h.style.cursor  = enabled ? "grab" : "default";
    });
    document.querySelectorAll("tr.wkp-tr").forEach(tr => {
      tr.setAttribute("draggable", enabled ? "true" : "false");
    });
    const thDrag = document.querySelector(".wkp-th-drag");
    if (thDrag) thDrag.style.opacity = enabled ? "1" : "0.3";
    const dragHint = document.getElementById("wkp-drag-hint");
    if (dragHint) dragHint.style.display = enabled ? "" : "none";
    // Sequence inputs: active only in Mode B
    document.querySelectorAll(".wkp-seq-input").forEach(inp => {
      inp.readOnly = !enabled;
      inp.title = enabled
        ? "Type a number to change priority order"
        : "Sequence input is active only in Mode B (Priority Queue)";
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SEQUENCE NUMBER INPUT (Priority Queue numeric edit)
  //  Allows typing a sequence number as an alternative to drag-drop.
  //  Only reorders in Mode B; in Mode A shows a message and resets.
  // ─────────────────────────────────────────────────────────────────────

  _bindSeqInput() {
    document.querySelectorAll(".wkp-seq-input").forEach(inp => {
      inp.addEventListener("change", () => {
        if (this.calcMode !== "sequential") {
          inp.value = parseInt(inp.dataset.idx || 0) + 1;
          frappe.show_alert({
            message: "Sequence editing applies only in Mode B (Priority Queue). Switch mode to reorder.",
            indicator: "orange",
          });
          return;
        }
        const wo     = inp.dataset.wo;
        const maxSeq = this.woOrder.length;
        let   newSeq = parseInt(inp.value) || 1;
        newSeq = Math.max(1, Math.min(newSeq, maxSeq));
        inp.value = newSeq;
        this._applySeqChange(wo, newSeq - 1);  // convert 1-based → 0-based
      });
      // Prevent drag accidentally triggering when clicking the input
      inp.addEventListener("mousedown", e => e.stopPropagation());
    });
  }

  _applySeqChange(wo, newIdx) {
    const oldIdx = this.woOrder.indexOf(wo);
    if (oldIdx === -1 || oldIdx === newIdx) return;
    this.woOrder.splice(oldIdx, 1);
    this.woOrder.splice(newIdx, 0, wo);
    this.simulate();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  TAB SYSTEM
  //  Three tabs: WO Kitting Plan | Material Shortage Report | Emergency Priorities
  //  Data is pre-rendered for all tabs in _render(); switching is instant.
  // ─────────────────────────────────────────────────────────────────────

  _bindTabs() {
    const bar = document.getElementById("wkp-tab-bar");
    if (!bar) return;
    bar.addEventListener("click", e => {
      const btn = e.target.closest(".wkp-tab-btn");
      if (!btn) return;
      this._switchTab(btn.dataset.tab);
    });
  }

  _switchTab(tabName) {
    this._activeTab = tabName || "wo-plan";

    // Update tab button active state
    document.querySelectorAll(".wkp-tab-btn").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === this._activeTab);
    });

    // Show/hide filter bar (only relevant for WO plan tab)
    const filterBar = document.getElementById("wkp-filter-bar");
    if (filterBar) filterBar.style.display = this._activeTab === "wo-plan" ? "" : "none";

    // Show/hide panes
    const panes = {
      "wo-plan"          : "wkp-pane-wo-plan",
      "shortage-report"  : "wkp-pane-shortage",
      "emergency"        : "wkp-pane-emergency",
      "dispatch"         : "wkp-pane-dispatch",
      "ai-chat"          : "wkp-pane-ai-chat",
      "item-view"        : "wkp-pane-item-view",
      "purchase-priority": "wkp-pane-purchase-priority",
    };
    Object.entries(panes).forEach(([tab, paneId]) => {
      const pane = document.getElementById(paneId);
      if (pane) pane.style.display = tab === this._activeTab ? "" : "none";
    });

    // If switching to WO plan, render the table (respects current filters)
    if (this._activeTab === "wo-plan" && this.rows.length) {
      this._renderTable(this.rows);
    }

    // If switching to dispatch tab, render (or show loading if still fetching)
    if (this._activeTab === "dispatch") {
      if (this._dispatchLoaded) {
        this._renderDispatchBottleneck();
      } else if (!this._dispatchLoading) {
        this._fetchDispatchData();
      }
    }

    // If switching to AI tab, show insight if already loaded
    if (this._activeTab === "ai-chat" && this._aiInsightLoaded) {
      // Insight was pre-rendered; just ensure panel is visible
    }

    // If switching to Item View, fetch data if not yet loaded
    if (this._activeTab === "item-view") {
      if (this._itemViewLoaded) {
        this._renderItemView();
      } else if (!this._itemViewLoading) {
        this._fetchItemView();
      }
    }

    // If switching to Purchase Priority, fetch data if not yet loaded (heavy query — lazy)
    if (this._activeTab === "purchase-priority") {
      if (this._ppLoaded) {
        this._renderPurchasePriority(this._ppData);
      } else if (!this._ppLoading) {
        this._fetchPurchasePriority();
      }
    }

    // Re-apply global search to the newly active tab (if a query is active)
    const searchInput = document.getElementById("wkp-global-search");
    if (searchInput && searchInput.value) {
      this._applyGlobalSearch(searchInput.value);
    }
  }

  _showAllPanes(show) {
    ["wkp-pane-wo-plan", "wkp-pane-shortage", "wkp-pane-emergency",
     "wkp-pane-dispatch", "wkp-pane-ai-chat", "wkp-pane-item-view",
     "wkp-pane-purchase-priority"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? "" : "none";
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  FILTER BAR
  //  Client-side filters: item group, kit status, customer urgency.
  //  All filtering is done in _getFilteredRows() — no API call needed.
  // ─────────────────────────────────────────────────────────────────────

  _bindFilterBar() {
    const grpSel     = document.getElementById("wkp-fbar-group");
    const statusSel  = document.getElementById("wkp-fbar-status");
    const urgSel     = document.getElementById("wkp-fbar-urgency");
    const clearBtn   = document.getElementById("wkp-fbar-clear");

    if (grpSel) grpSel.addEventListener("change", e => {
      this._filterItemGroup = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (statusSel) statusSel.addEventListener("change", e => {
      this._filterKitStatus = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (urgSel) urgSel.addEventListener("change", e => {
      this._filterUrgency = e.target.value;
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
    if (clearBtn) clearBtn.addEventListener("click", () => {
      this._filterItemGroup = "";
      this._filterKitStatus = "";
      this._filterUrgency   = "";
      if (grpSel)    grpSel.value    = "";
      if (statusSel) statusSel.value = "";
      if (urgSel)    urgSel.value    = "";
      if (this._activeTab === "wo-plan" && this.rows.length) this._renderTable(this.rows);
    });
  }

  _populateItemGroupFilter(rows) {
    const sel = document.getElementById("wkp-fbar-group");
    if (!sel) return;
    const groups = [...new Set(rows.map(r => r.item_group || "").filter(Boolean))].sort();
    // Preserve current selection
    const current = sel.value;
    // Remove old options (keep first "All Groups" option)
    while (sel.options.length > 1) sel.remove(1);
    groups.forEach(g => {
      const opt = document.createElement("option");
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    });
    if (groups.includes(current)) sel.value = current;
  }

  _loadDynamicFilters() {
    // WKP-028: Fetch Work Order statuses dynamically instead of hardcoding
    // to support custom ERPNext setups and avoid "Not Started" missing etc.
    // 🔒 RESTRICTED: Never hardcode ERPNext document statuses in HTML/JS.
    // DOM ID #wkp-status-filter is used to bind the change event.
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_work_order_statuses",
      callback: r => {
        const statuses = r.message || [];
        const sel = document.getElementById("wkp-status-filter");
        if (!sel || !statuses.length) return;

        // Preserve "All Open WOs"
        while (sel.options.length > 1) sel.remove(1);
        statuses.forEach(s => {
          const opt = document.createElement("option");
          opt.value = s;
          opt.textContent = s;
          sel.appendChild(opt);
        });
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  MATERIAL SHORTAGE REPORT TAB
  //  Aggregates shortage_items across all WOs to show consolidated demand.
  //  Sorted by net_gap DESC (unmet shortages with no PO/MR action first).
  //  Computed entirely from this.rows — no extra API call.
  // ─────────────────────────────────────────────────────────────────────

  _renderShortageReport(rows) {
    // ─────────────────────────────────────────────────────────────────────
    //  Aggregate shortage items across all WOs, then:
    //    1. Fetch MOQ + lead time from server (get_items_procurement_info)
    //    2. Store on each aggList entry so the MR dialog can use them directly
    //    3. Render the table via _renderShortageTable()
    //
    //  The async procInfo fetch is done eagerly here (not lazily in the MR
    //  dialog) so that MOQ and Lead Time are visible in the table before the
    //  user opens the dialog — helping non-technical users make decisions.
    // ─────────────────────────────────────────────────────────────────────
    const body  = document.getElementById("wkp-shortage-body");
    const mrBtn = document.getElementById("wkp-shortage-mr-btn");
    const subEl = document.getElementById("wkp-shortage-sub");
    if (!body) return;

    // Clear — prevents stale data from previous render being visible
    this._shortageAggList = [];

    // Aggregate shortage items across all WOs
    // 🔒 RESTRICTED: shortage_items[].item_group must be the component's group,
    // NOT the parent WO's group, to allow proper dynamic filtering in this tab.
    const agg = {};  // item_code → aggregated data
    rows.forEach(row => {
      (row.shortage_items || []).forEach(comp => {
        if ((comp.shortage || 0) <= 0) return;
        const ic = comp.item_code;
        if (!agg[ic]) {
          agg[ic] = {
            item_code       : ic,
            item_name       : comp.item_name || ic,
            item_group      : comp.item_group || "",  // correctly use component group
            uom             : comp.uom || "",
            secondary_uom   : comp.secondary_uom || "",
            secondary_factor: comp.secondary_factor || 1.0,
            total_required  : 0,
            total_available : 0,
            total_shortage  : 0,
            total_value     : 0,
            po_qty          : 0,
            received_qty    : 0,
            mr_qty          : 0,
            wo_list         : [],
            wo_detail       : [],   // per-WO breakdown for Details expand row
            moq             : 0,   // filled by procInfo API response
            lead_time_days  : 0,   // filled by procInfo API response
          };
        }
        const a = agg[ic];
        a.total_required  += comp.required      || 0;
        a.total_available += comp.available     || 0;
        a.total_shortage  += comp.shortage      || 0;
        a.total_value     += comp.shortage_value || 0;
        a.po_qty           = Math.max(a.po_qty,       comp.po_qty          || 0);
        a.received_qty     = Math.max(a.received_qty, comp.received_qty_po || 0);
        a.mr_qty           = Math.max(a.mr_qty,       comp.mr_qty          || 0);
        if (!a.wo_list.includes(row.wo)) a.wo_list.push(row.wo);
        // Fix: deduplicate WO detail rows — same component can appear in multiple
        // BOM paths for the same WO; if WO already in wo_detail, sum the shortage
        // instead of creating a duplicate row (which caused inflated SO counts).
        const existingDetail = a.wo_detail.find(d => d.wo === row.wo);
        if (existingDetail) {
          existingDetail.shortage += (comp.shortage || 0);
        } else {
          a.wo_detail.push({
            wo       : row.wo,
            wo_item  : row.item_name || row.item_code || "",
            shortage : comp.shortage || 0,
          });
        }
      });
    });

    const aggList = Object.values(agg);
    // Sort: highest net gap (most unmet shortage) first
    aggList.sort((a, b) => {
      const gapA = a.total_shortage - a.po_qty - a.mr_qty;
      const gapB = b.total_shortage - b.po_qty - b.mr_qty;
      return gapB - gapA;
    });

    if (!aggList.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No material shortages found across any open Work Order.</div>
          <div class="wkp-reco-detail">All materials are available for all active Work Orders in this simulation.</div>
        </div>
      </div>`;
      if (mrBtn) mrBtn.style.display = "none";
      const selBtn = document.getElementById("wkp-shortage-mr-selected-btn");
      if (selBtn) selBtn.style.display = "none";
      if (subEl) subEl.textContent = " \u2014 No shortages found";
      return;
    }

    // Persist — used by checkbox handlers and MR dialog (moq/lead_time also stored here)
    this._shortageAggList = aggList;

    // Show subtitle immediately while API call is in flight
    const totalItems = aggList.length;
    const totalVal   = aggList.reduce((s, a) => s + a.total_value, 0);
    if (subEl) subEl.textContent =
      " \u2014 " + totalItems + " unique item" + (totalItems === 1 ? "" : "s") + " short"
      + " \u00B7 Total value: \u20B9" + _fmt_num(totalVal, 0);

    // Show a brief loading indicator while fetching procurement info
    body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--stone-400)">Loading procurement data\u2026</div>`;

    // Fetch MOQ + lead time eagerly — stored on aggList entries so MR dialog
    // can use them without an extra API call
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_items_procurement_info",
      args: { item_codes_json: JSON.stringify(aggList.map(a => a.item_code)) },
      callback: r => {
        const procInfo = (r && r.message) || {};
        aggList.forEach(a => {
          const info = procInfo[a.item_code] || {};
          a.moq            = info.moq            || 0;
          a.lead_time_days = info.lead_time_days || 0;
        });
        this._renderShortageTable(aggList, body, mrBtn);
      },
      error: () => this._renderShortageTable(aggList, body, mrBtn),
    });
  }

  _renderShortageTable(aggList, body, mrBtn) {
    // ─────────────────────────────────────────────────────────────────────
    //  Renders the material shortage table with:
    //    - Dual UOM on all qty columns
    //    - MOQ column: from Item master min_order_qty
    //    - Lead Time column: from Item master lead_time_days
    //    - Expandable "Details" row: per-WO shortage breakdown
    //    - Checkbox for selective MR creation
    //
    //  Called by _renderShortageReport() after procInfo is fetched.
    //  Also updates the "Create Consolidated MR" button state.
    // ─────────────────────────────────────────────────────────────────────

    // ── Dual-UOM helper (stacked style for table cells) ───────────────────
    const _dualQtySR = (qty, uom, secFactor, secUom) => {
      const base = `<div class="wkp-qty-primary">${_fmt_num(qty, 2)}</div>
                    <div class="wkp-qty-uom">${_esc(uom || "")}</div>`;
      if (secUom && secFactor > 1) {
        const secQty = qty / secFactor;
        return base + `<div class="wkp-qty-secondary">${_fmt_num(secQty, 2)}\u00a0${_esc(secUom)}</div>`;
      }
      return base;
    };
    // colspan = 13 (checkbox + material + 9 qty cols + MOQ + Lead Time + Details)
    const COL_SPAN = 13;

    const rowsHtml = aggList.map(a => {
      const netGap = Math.max(0, a.total_shortage - a.po_qty - a.mr_qty);
      const netCls = netGap > 0 ? "wkp-cell-red" : "wkp-cell-green";
      const netTxt = netGap > 0 ? _dualQtySR(netGap, a.uom, a.secondary_factor, a.secondary_uom) : "\u2714 Covered";
      const poTxt  = a.po_qty       > 0 ? _dualQtySR(a.po_qty,       a.uom, a.secondary_factor, a.secondary_uom) : "\u2014";
      const rcvTxt = a.received_qty > 0 ? _dualQtySR(a.received_qty, a.uom, a.secondary_factor, a.secondary_uom) : "\u2014";
      const mrTxt  = a.mr_qty       > 0 ? _dualQtySR(a.mr_qty,       a.uom, a.secondary_factor, a.secondary_uom) : "\u2014";

      // MOQ cell — show with UOM; "Not set" if 0
      const moqTxt = a.moq > 0
        ? `<strong>${_fmt_num(a.moq, 2)}</strong><div style="font-size:10px;color:var(--stone-500)">${_esc(a.uom || "")}</div>`
        : `<span style="color:var(--stone-400);font-size:11px">Not set</span>`;

      // Lead time cell — show days; "Not set" if 0
      const ltTxt = a.lead_time_days > 0
        ? `<strong>${a.lead_time_days}</strong><div style="font-size:10px;color:var(--stone-500)">days</div>`
        : `<span style="color:var(--stone-400);font-size:11px">Not set</span>`;

      // Expandable WO detail row — toggled by Details button
      const detailId = "wkp-sr-d-" + a.item_code.replace(/[^a-zA-Z0-9]/g, "_");
      const woDetailRows = a.wo_detail.map(d =>
        `<tr>
          <td style="padding:3px 10px">
            <a href="/app/work-order/${_esc(d.wo)}" target="_blank" class="wkp-wo-link">${_esc(d.wo)}</a>
            ${d.wo_item ? `<div style="font-size:10px;color:var(--stone-400)">${_esc(d.wo_item)}</div>` : ""}
          </td>
          <td style="padding:3px 10px;text-align:right">
            ${_dualQtySR(d.shortage, a.uom, a.secondary_factor, a.secondary_uom)}
          </td>
        </tr>`
      ).join("");

      return `
<tr>
  <td class="ta-c wkp-sr-chk-cell" data-tip="Tick to include this material in a selective Material Request.">
    <input type="checkbox" class="wkp-sr-chk" data-item="${_esc(a.item_code)}"
           title="Select to include in Material Request">
  </td>
  <td>
    <button class="wkp-sr-item-btn" data-item="${_esc(a.item_code)}"
            title="Click to see open Purchase Orders, Material Requests, recent receipts and active batches for this material">
      <div class="wkp-item-name">${_esc(a.item_name)}</div>
      <div class="wkp-item-code">${_esc(a.item_code)}</div>
    </button>
    ${a.item_group ? `<div class="wkp-item-group-tag">${_esc(a.item_group)}</div>` : ""}
  </td>
  <td class="ta-r" data-tip="Total qty of this material needed across all Work Orders.">${_dualQtySR(a.total_required, a.uom, a.secondary_factor, a.secondary_uom)}</td>
  <td class="ta-r" data-tip="Physical warehouse stock right now (Bin.actual_qty).">${_dualQtySR(a.total_available, a.uom, a.secondary_factor, a.secondary_uom)}</td>
  <td class="ta-r wkp-cell-red" data-tip="Total Shortage = Required &minus; In Stock.">${_dualQtySR(a.total_shortage, a.uom, a.secondary_factor, a.secondary_uom)}</td>
  <td class="ta-r" data-tip="Open Purchase Order qty (ordered from supplier, not yet received).">${poTxt}</td>
  <td class="ta-r" style="color:var(--ok-text)" data-tip="Qty already received from open POs (in transit or receiving bay).">${rcvTxt}</td>
  <td class="ta-r" data-tip="Open Material Request qty (not yet converted to a PO).">${mrTxt}</td>
  <td class="ta-r ${netCls}" data-tip="Net Gap = Shortage &minus; PO Raised &minus; MR Raised.&#10;Positive (red) = no procurement action yet.&#10;Covered (green) = existing PO or MR covers the shortage.">${netTxt}</td>
  <td class="ta-r" data-tip="Estimated purchase cost = Shortage Qty &times; Item valuation rate.">\u20B9${_fmt_num(a.total_value, 0)}</td>
  <td class="ta-r" data-tip="Minimum Order Qty from Item master.&#10;Suppliers may reject orders below this quantity.&#10;0 = not configured on Item.">${moqTxt}</td>
  <td class="ta-r" data-tip="Supplier Lead Time from Item master.&#10;Typical days from placing a Purchase Order to receiving materials.&#10;0 = not configured on Item.">${ltTxt}</td>
  <td class="ta-c" data-tip="Click Details to see which Work Orders need this material and how much each one requires.">
    ${a.wo_list.length > 0
      ? `<button class="wkp-btn wkp-btn-sm"
           onclick="var r=document.getElementById('${detailId}');if(r){r.style.display=r.style.display==='none'?'':'none';this.textContent=r.style.display===''?'\u25B2 Hide':'\u25BC Details'}"
           title="Show which Work Orders need this material">
           \u25BC Details
         </button>`
      : "\u2014"}
  </td>
</tr>
<tr class="wkp-sr-detail-row" id="${detailId}" style="display:none">
  <td colspan="${COL_SPAN}" style="padding:0 0 0 48px;background:var(--stone-50,#fafaf9);border-bottom:2px solid var(--stone-200)">
    <table style="width:auto;border-collapse:collapse;font-size:12px;margin:6px 0">
      <thead>
        <tr style="background:var(--stone-100)">
          <th style="padding:4px 12px;text-align:left;font-weight:600">Work Order (Production Order)</th>
          <th style="padding:4px 12px;text-align:right;font-weight:600">Shortage Qty</th>
        </tr>
      </thead>
      <tbody>${woDetailRows}</tbody>
    </table>
  </td>
</tr>`;
    }).join("");

    // Build item group filter options from aggList
    const igSet = new Set(aggList.map(a => a.item_group || "").filter(Boolean));
    const igOptions = [...igSet].sort().map(ig =>
      `<button class="wkp-sr-ig-btn" data-ig="${_esc(ig)}">${_esc(ig)}</button>`
    ).join("");
    const filterBar = igSet.size > 0
      ? `<div class="wkp-sr-filter-bar">
           <span class="wkp-sr-filter-lbl">Filter by Item Group:</span>
           <button class="wkp-sr-ig-btn active" data-ig="">All</button>
           ${igOptions}
         </div>`
      : "";

    body.innerHTML = filterBar + `
<div class="wkp-shortage-hint" data-tip="Items with positive Net Gap have no Purchase Order or Material Request raised yet. These need immediate procurement action.">
  <strong>How to use:</strong>
  Items sorted by Net Gap (highest unmet shortage first).
  Click any <strong>material name</strong> to see open POs, MRs, receipts and batches.
  Tick checkboxes to select items, then click <strong>Create MR for Selected</strong>.
  Click <strong>Details</strong> on any row to see which Work Orders are affected.
</div>
<table class="wkp-modal-table wkp-shortage-table" id="wkp-sr-table">
  <thead>
    <tr>
      <th class="ta-c wkp-sr-chk-cell" data-tip="Select / deselect all materials.">
        <input type="checkbox" id="wkp-sr-select-all" title="Select all materials">
      </th>
      <th>Material (Raw Material / Component)</th>
      <th class="ta-r" data-tip="Total quantity needed across all open Work Orders (both UOMs shown).">Total Required</th>
      <th class="ta-r" data-tip="Physical warehouse stock right now (Bin). This is what is actually in the store.">In Stock</th>
      <th class="ta-r" data-tip="Total Shortage = Required &minus; In Stock.">Shortage</th>
      <th class="ta-r" data-tip="Open Purchase Order qty (on order from supplier, not yet received).">PO Raised</th>
      <th class="ta-r" data-tip="Qty received from open POs (may be in receiving bay, not yet put-away into stock).">Received</th>
      <th class="ta-r" data-tip="Open Material Request qty (not yet converted to a Purchase Order).">MR Raised</th>
      <th class="ta-r" data-tip="Net Gap = Shortage &minus; PO Raised &minus; MR Raised.&#10;Positive (red) = no procurement action yet. Order immediately.&#10;Covered (green) = existing PO or MR addresses the shortage.">Net Gap</th>
      <th class="ta-r">Est. Value (\u20B9)</th>
      <th class="ta-r" data-tip="Minimum Order Qty (MOQ) from the Item master.&#10;This is the smallest quantity a supplier will accept per order.&#10;If blank, there is no minimum set for this item.">MOQ</th>
      <th class="ta-r" data-tip="Supplier Lead Time from Item master.&#10;Estimated number of days from placing a Purchase Order to receiving materials.&#10;Helps plan ahead for production schedules.">Lead Time</th>
      <th data-tip="Click the Details button to see which Work Orders (production orders) require this material and how much each one needs.">Affects WOs</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>`;

    // Item group filter binding
    body.querySelectorAll(".wkp-sr-ig-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        body.querySelectorAll(".wkp-sr-ig-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const ig = btn.dataset.ig || "";
        const table = body.querySelector("#wkp-sr-table");
        if (!table) return;
        // WKP-030: when hiding a main row, also hide its expand detail row (if open).
        // If the detail row is left visible after filtering, it floats disconnected from its parent.
        table.querySelectorAll("tbody tr:not(.wkp-sr-detail-row)").forEach(tr => {
          const ic = tr.querySelector("[data-item]") ? tr.querySelector("[data-item]").dataset.item : "";
          const entry = aggList.find(a => a.item_code === ic);
          const match = !ig || (entry && entry.item_group === ig);
          tr.style.display = match ? "" : "none";

          // Sync the paired detail row
          const detailId = "wkp-sr-d-" + ic.replace(/[^a-zA-Z0-9]/g, "_");
          const detailTr = document.getElementById(detailId);
          if (detailTr && !match) {
            detailTr.style.display = "none";
            // Reset the Details button text so it reads "Details" again when row becomes visible
            const detailBtn = tr.querySelector("button[onclick]");
            if (detailBtn) detailBtn.textContent = "\u25BC Details";
          }
        });
      });
    });

    // Material supply modal binding — click item name to see supply pipeline
    body.querySelectorAll(".wkp-sr-item-btn").forEach(btn => {
      btn.addEventListener("click", () => this._showMaterialSupplyModal(btn.dataset.item));
    });

    // "Create Consolidated MR" button — for all items with net gap > 0
    const hasNetGap = aggList.some(a => (a.total_shortage - a.po_qty - a.mr_qty) > 0);
    if (mrBtn) {
      mrBtn.style.display = hasNetGap ? "" : "none";
      if (hasNetGap) {
        mrBtn.onclick = () => this._createConsolidatedMR(
          aggList.filter(a => (a.total_shortage - a.po_qty - a.mr_qty) > 0)
        );
      }
    }

    // Activate checkbox selection system
    this._bindShortageCheckboxes();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  MATERIAL SUPPLY DETAIL MODAL
  //  Opens when user clicks on a material name in the shortage report.
  //  Shows the full procurement pipeline: open POs, open MRs,
  //  recent receipts, and active batches.
  // ─────────────────────────────────────────────────────────────────────

  _showMaterialSupplyModal(item_code) {
    const d = new frappe.ui.Dialog({
      title: "Supply Pipeline: " + item_code,
      size: "extra-large",
      fields: [{ fieldtype: "HTML", fieldname: "supply_html" }],
    });
    d.fields_dict.supply_html.$wrapper.html(
      `<div style="padding:16px;color:var(--stone-400);font-style:italic">Loading supply details\u2026</div>`
    );
    d.show();

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_material_supply_detail",
      args: { item_code },
      callback: r => {
        const data = r && r.message;
        if (!data) {
          d.fields_dict.supply_html.$wrapper.html(
            `<div class="wkp-supply-modal-empty">No supply data found for ${_esc(item_code)}.</div>`
          );
          return;
        }

        const uom = data.uom || "";

        // ── Open Purchase Orders ──
        const poRows = (data.open_pos || []).map(po => `
<tr>
  <td><a href="/app/purchase-order/${_esc(po.po_name)}" target="_blank" class="wkp-wo-link">${_esc(po.po_name)}</a></td>
  <td>${_esc(po.supplier || "")}</td>
  <td class="ta-r">${_fmt_num(po.qty, 2)}&nbsp;${_esc(uom)}</td>
  <td class="ta-r" style="color:var(--ok-text)">${_fmt_num(po.received_qty, 2)}&nbsp;${_esc(uom)}</td>
  <td class="ta-r wkp-cell-red"><strong>${_fmt_num(po.pending_qty, 2)}&nbsp;${_esc(uom)}</strong></td>
  <td>${_esc(po.schedule_date || "\u2014")}</td>
  <td class="ta-r">${po.valuation_rate > 0 ? "\u20B9" + _fmt_num(po.valuation_rate, 2) : "\u2014"}</td>
</tr>`).join("");

        // ── Open Material Requests ──
        const mrRows = (data.open_mrs || []).map(mr => `
<tr>
  <td><a href="/app/material-request/${_esc(mr.mr_name)}" target="_blank" class="wkp-wo-link">${_esc(mr.mr_name)}</a></td>
  <td class="ta-r">${_fmt_num(mr.qty, 2)}&nbsp;${_esc(uom)}</td>
  <td class="ta-r" style="color:var(--ok-text)">${_fmt_num(mr.ordered_qty, 2)}&nbsp;${_esc(uom)}</td>
  <td class="ta-r wkp-cell-red"><strong>${_fmt_num(mr.pending_qty, 2)}&nbsp;${_esc(uom)}</strong></td>
  <td>${_esc(mr.schedule_date || "\u2014")}</td>
</tr>`).join("");

        // ── Recent Receipts ──
        const rcvRows = (data.recent_receipts || []).map(rcv => `
<tr>
  <td><a href="/app/purchase-receipt/${_esc(rcv.receipt_name)}" target="_blank" class="wkp-wo-link">${_esc(rcv.receipt_name)}</a></td>
  <td class="ta-r">${_fmt_num(rcv.qty, 2)}&nbsp;${_esc(uom)}</td>
  <td class="ta-r">${rcv.valuation_rate > 0 ? "\u20B9" + _fmt_num(rcv.valuation_rate, 2) : "\u2014"}</td>
  <td>${_esc(rcv.posting_date || "\u2014")}</td>
  <td>${_esc(rcv.warehouse || "\u2014")}</td>
  <td>${rcv.batch_no ? `<a href="/app/batch/${_esc(rcv.batch_no)}" target="_blank" class="wkp-wo-link">${_esc(rcv.batch_no)}</a>` : "\u2014"}</td>
</tr>`).join("");

        // ── Active Batches ──
        const batchRows = (data.active_batches || []).map(b => `
<tr>
  <td><a href="/app/batch/${_esc(b.batch_id)}" target="_blank" class="wkp-wo-link">${_esc(b.batch_id)}</a></td>
  <td class="ta-r"><strong>${_fmt_num(b.qty, 2)}&nbsp;${_esc(uom)}</strong></td>
  <td class="ta-r">${b.valuation_rate > 0 ? "\u20B9" + _fmt_num(b.valuation_rate, 2) : "\u2014"}</td>
  <td>${_esc(b.warehouse || "\u2014")}</td>
  <td>${_esc(b.manufacturing_date || "\u2014")}</td>
  <td class="${b.expiry_date && b.expiry_date < new Date().toISOString().slice(0, 10) ? "wkp-cell-red" : ""}">${_esc(b.expiry_date || "\u2014")}</td>
</tr>`).join("");

        const _section = (title, tip, headers, rows, emptyMsg) => `
<div class="wkp-supply-section">
  <div class="wkp-supply-section-title" data-tip="${tip}">${title}</div>
  ${rows
    ? `<div class="wkp-supply-scroll"><table class="wkp-modal-table wkp-supply-table">
         <thead><tr>${headers}</tr></thead>
         <tbody>${rows}</tbody>
       </table></div>`
    : `<div class="wkp-supply-empty">${emptyMsg}</div>`}
</div>`;

        d.fields_dict.supply_html.$wrapper.html(`
<div class="wkp-supply-modal-body">
  <div class="wkp-supply-item-header">
    <strong>${_esc(data.item_name || item_code)}</strong>
    <span class="wkp-item-code">${_esc(item_code)}</span>
    <span style="color:var(--stone-400);font-size:12px">Stock UOM: ${_esc(uom)}</span>
  </div>
  ${_section("Open Purchase Orders",
    "Purchase Orders from suppliers that are not yet fully received. Pending qty = ordered minus received.",
    `<th>PO #</th><th>Supplier</th><th class="ta-r">Ordered</th><th class="ta-r">Received</th><th class="ta-r">Pending</th><th>Schedule Date</th><th class="ta-r">Val. Rate</th>`,
    poRows, "No open Purchase Orders for this material.")}
  ${_section("Open Material Requests (Purchase)",
    "Internal purchase requisitions not yet converted to a Purchase Order.",
    `<th>MR #</th><th class="ta-r">Qty</th><th class="ta-r">Ordered</th><th class="ta-r">Pending</th><th>Schedule Date</th>`,
    mrRows, "No open Purchase Material Requests for this material.")}
  ${_section("Recent Receipts (last 30 days)",
    "Purchase Receipts posted in the last 30 days. Includes batch number for traceability.",
    `<th>Receipt #</th><th class="ta-r">Qty</th><th class="ta-r">Val. Rate</th><th>Posting Date</th><th>Warehouse</th><th>Batch</th>`,
    rcvRows, "No recent receipts in the last 30 days.")}
  ${_section("Active Batches in Stock",
    "Batches currently in stock (positive qty). Sorted by expiry date. Red expiry = already expired.",
    `<th>Batch ID</th><th class="ta-r">Qty in Stock</th><th class="ta-r">Val. Rate</th><th>Warehouse</th><th>Mfg Date</th><th>Expiry Date</th>`,
    batchRows, "No active batches with stock for this material.")}
</div>`);
      },
      error: () => {
        d.fields_dict.supply_html.$wrapper.html(
          `<div class="wkp-supply-modal-empty">Error loading supply data.</div>`
        );
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SHORTAGE REPORT — CHECKBOX SELECTION SYSTEM
  //
  //  Lets users hand-pick materials from the shortage table, then create
  //  a targeted Material Request with custom quantities and MOQ validation.
  //
  //  Flow:
  //    1. User ticks rows in the shortage table (or ticks Select All)
  //    2. "Create MR for Selected" button count updates in real-time
  //    3. User clicks button → _showMRConfirmModal() is called
  //    4. API get_items_min_order_qty returns MOQ per item
  //    5. frappe.ui.Dialog shows: material table (editable qty), warehouse picker
  //    6. User reviews/adjusts quantities, selects warehouse, confirms
  //    7. create_purchase_mr_for_wo_shortages creates the MR
  //
  //  UX design notes:
  //    - Net Shortage is used as default qty (not total_shortage, so already-PO'd
  //      and MR'd quantities are not double-ordered)
  //    - If MOQ > net shortage, suggested qty = MOQ (avoids rejection by supplier)
  //    - Qty inputs are editable — user can override before confirming
  //    - The dialog uses frappe.ui.Dialog so the Warehouse Link field has full
  //      ERPNext autocomplete (same as native ERP forms)
  // ─────────────────────────────────────────────────────────────────────

  _bindShortageCheckboxes() {
    // Show "Create MR for Selected" button now that we have rows
    const selBtn = document.getElementById("wkp-shortage-mr-selected-btn");
    if (selBtn) {
      selBtn.style.display = "";
      selBtn.disabled      = true;   // starts disabled until at least one row is checked
      // Re-bind click handler (clean slate on each render)
      selBtn.onclick = () => {
        const selected = this._getSelectedShortageItems();
        if (!selected.length) {
          frappe.show_alert({
            message: "No materials selected. Tick the checkboxes in the table to select items.",
            indicator: "orange",
          });
          return;
        }
        this._showMRConfirmModal(selected);
      };
    }

    // Select-All checkbox in the header row
    const selectAll = document.getElementById("wkp-sr-select-all");
    if (selectAll) {
      selectAll.addEventListener("change", () => {
        const isChecked = selectAll.checked;
        document.querySelectorAll(".wkp-sr-chk").forEach(cb => { cb.checked = isChecked; });
        this._updateSelectedMRBtn();
      });
    }

    // Individual row checkboxes
    document.querySelectorAll(".wkp-sr-chk").forEach(cb => {
      cb.addEventListener("change", () => {
        // Sync select-all state: checked if ALL rows checked
        if (selectAll) {
          const total   = document.querySelectorAll(".wkp-sr-chk").length;
          const checked = document.querySelectorAll(".wkp-sr-chk:checked").length;
          selectAll.indeterminate = checked > 0 && checked < total;
          selectAll.checked       = checked === total;
        }
        this._updateSelectedMRBtn();
      });
    });
  }

  _updateSelectedMRBtn() {
    const btn   = document.getElementById("wkp-shortage-mr-selected-btn");
    const count = document.querySelectorAll(".wkp-sr-chk:checked").length;
    if (!btn) return;
    btn.disabled     = count === 0;
    btn.textContent  = count > 0
      ? "\u2713 Create MR for " + count + " Selected Item" + (count !== 1 ? "s" : "")
      : "\u2713 Create MR for Selected";
  }

  _getSelectedShortageItems() {
    const selectedCodes = new Set();
    document.querySelectorAll(".wkp-sr-chk:checked").forEach(cb => selectedCodes.add(cb.dataset.item));
    return (this._shortageAggList || []).filter(a => selectedCodes.has(a.item_code));
  }

  // ─────────────────────────────────────────────────────────────────────
  //  MR CONFIRMATION MODAL (for selected shortage items)
  //
  //  Step 1: fetch MOQ from server (get_items_min_order_qty)
  //  Step 2: open frappe.ui.Dialog with:
  //    - HTML table: Material | Net Shortage | MOQ | Your Qty (editable)
  //    - Warehouse Link field (full ERPNext autocomplete)
  //    - "Create Material Request" primary button
  //
  //  Suggested qty logic:
  //    net_shortage = total_shortage - po_qty - mr_qty  (unmet portion only)
  //    suggested    = max(net_shortage, MOQ)
  //    If MOQ not set or 0 → suggested = net_shortage
  //
  //  The user can edit any qty before confirming.
  //  Items with qty = 0 are silently skipped.
  // ─────────────────────────────────────────────────────────────────────

  _showMRConfirmModal(selectedItems) {
    // _shortageAggList items already have moq set by _renderShortageReport()
    // via get_items_procurement_info — no second API call needed here.
    const moqMap = {};
    selectedItems.forEach(a => { moqMap[a.item_code] = a.moq || 0; });
    this._openMRQtyDialog(selectedItems, moqMap);
  }

  _openMRQtyDialog(items, moqMap, titleOverride) {
    // ── Build the items table HTML for the dialog ──────────────────────────
    // WKP-001 note: this is dynamically generated JS string, NOT the HTML
    // template file. Single quotes are safe here.
    //
    // titleOverride: optional string for dialog title (used by _createConsolidatedMR).
    // UOM selector: each row has a <select> with stock UOM + secondary UOM (if available).
    // The selected UOM is passed to create_purchase_mr_for_wo_shortages, so users can
    // order in kg instead of gram, litre instead of ml, etc.
    const tableRows = items.map(a => {
      const moq        = flt(moqMap[a.item_code] || 0);
      const netShort   = Math.max(0, a.total_shortage - a.po_qty - a.mr_qty);
      const suggestedQty = moq > 0 && moq > netShort ? moq : netShort;
      const moqNote    = moq > 0
        ? `<span style="font-size:10px;color:var(--stone-500)"
                 title="Minimum Order Qty set on Item master. Order at least this much per purchase."
           >${_fmt_num(moq, 2)}\u00a0${_esc(a.uom || "")}</span>`
        : `<span style="font-size:10px;color:var(--stone-400)">Not set</span>`;
      const secNote = (a.secondary_uom && a.secondary_factor > 1)
        ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(netShort / a.secondary_factor, 2)}\u00a0${_esc(a.secondary_uom)}</div>`
        : "";
      // UOM selector — stock UOM always first; secondary UOM as second option if available.
      // Value stored in select.value flows into the MR line item uom field.
      const secOpt = (a.secondary_uom && a.secondary_factor > 1)
        ? `<option value="${_esc(a.secondary_uom)}">${_esc(a.secondary_uom)} (1 = ${_fmt_num(a.secondary_factor, 0)} ${_esc(a.uom || "")})</option>`
        : "";
      return `
<tr style="border-bottom:1px solid var(--border-light)">
  <td style="padding:8px 6px">
    <div style="font-weight:600">${_esc(a.item_name)}</div>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(a.item_code)}</div>
  </td>
  <td style="padding:8px 6px;text-align:right;vertical-align:top">
    <div>${_fmt_num(netShort, 2)}\u00a0${_esc(a.uom || "")}</div>${secNote}
  </td>
  <td style="padding:8px 6px;text-align:right;vertical-align:top">${moqNote}</td>
  <td style="padding:8px 6px;text-align:right;vertical-align:top">
    <input type="number" class="wkp-mr-qty-input"
           data-item="${_esc(a.item_code)}"
           data-uom="${_esc(a.uom || "")}"
           value="${suggestedQty}"
           min="0" step="0.001"
           style="width:90px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;text-align:right;font-size:13px"
           title="Edit order quantity. Suggested = max(Net Shortage, Min Order Qty).">
  </td>
  <td style="padding:8px 6px;vertical-align:top">
    <select class="wkp-mr-uom-select"
            data-item="${_esc(a.item_code)}"
            title="Select the UOM for this Material Request line. Default is the stock UOM."
            style="border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:12px;background:var(--control-bg,#fff);cursor:pointer">
      <option value="${_esc(a.uom || "")}">${_esc(a.uom || "")}</option>
      ${secOpt}
    </select>
  </td>
</tr>`;
    }).join("");

    const tableHtml = `
<div style="margin-bottom:10px;font-size:12px;color:var(--stone-600);line-height:1.6">
  Review the order quantities below. Each quantity is pre-filled with
  <strong>Net Shortage</strong> (what is still unordered) or the supplier
  <strong>Minimum Order Qty (MOQ)</strong>, whichever is larger.
  <br>You can edit any quantity and change the UOM. Items with 0 qty will be skipped.
</div>
<table style="width:100%;border-collapse:collapse;font-size:13px">
  <thead>
    <tr style="background:var(--bg-light,#f8f8f8);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.4px">
      <th style="padding:6px;text-align:left">Material</th>
      <th style="padding:6px;text-align:right"
          title="Net Shortage = Total Shortage minus any PO or MR already raised. This is the unmet portion.">Net Shortage</th>
      <th style="padding:6px;text-align:right"
          title="Minimum Order Qty from Item master. Supplier may refuse orders below this qty.">Min Order Qty</th>
      <th style="padding:6px;text-align:right"
          title="Your actual order qty. Edit as needed.">Your Order Qty</th>
      <th style="padding:6px"
          title="Unit of Measure for this order. Change to order in a different unit (e.g. kg instead of gram).">UOM</th>
    </tr>
  </thead>
  <tbody>${tableRows}</tbody>
</table>
<div style="margin-top:8px;font-size:11px;color:var(--stone-400)">
  <strong>ERPNext terms:</strong>
  Net Shortage = Shortage &minus; PO Raised &minus; MR Raised &nbsp;&bull;&nbsp;
  MOQ = Minimum Order Quantity (Item master field) &nbsp;&bull;&nbsp;
  MR = Material Request (sent to procurement to raise a Purchase Order)
</div>`;

    // ── Build frappe.ui.Dialog ─────────────────────────────────────────────
    // Uses Frappe's native Dialog so Warehouse has full Link-field autocomplete.
    // The HTML field renders the items table; Warehouse is a standard Link field.
    const self = this;
    const d    = new frappe.ui.Dialog({
      title           : titleOverride || ("Confirm Material Request \u2014 " + items.length + " Item" + (items.length !== 1 ? "s" : "")),
      fields          : [
        {
          fieldtype   : "HTML",
          fieldname   : "items_table",
          options     : tableHtml,
        },
        {
          fieldtype   : "Link",
          fieldname   : "warehouse",
          label       : "Target Warehouse (where materials will be received)",
          options     : "Warehouse",
          reqd        : 1,
          description : "Select the warehouse where purchased materials should be delivered. "
                      + "This becomes the warehouse on every Material Request line.",
        },
      ],
      primary_action_label: "Create Material Request",
      primary_action  : function(values) {
        if (!values.warehouse) {
          frappe.show_alert({ message: "Please select a Target Warehouse before creating the MR.", indicator: "red" });
          return;
        }
        // Collect edited quantities and selected UOMs from the dialog table.
        // Inputs and UOM selects are in the same order (one per row), so
        // we pair them by index to avoid CSS-escape issues with item codes.
        const payload = [];
        const qtyInputs  = [...document.querySelectorAll(".wkp-mr-qty-input")];
        const uomSelects = [...document.querySelectorAll(".wkp-mr-uom-select")];
        qtyInputs.forEach((inp, i) => {
          const qty = parseFloat(inp.value) || 0;
          if (qty > 0) {
            const uomSel = uomSelects[i];
            payload.push({
              item_code   : inp.dataset.item,
              shortage_qty: qty,
              uom         : (uomSel ? uomSel.value : "") || inp.dataset.uom || "",
              warehouse   : values.warehouse,
            });
          }
        });
        if (!payload.length) {
          frappe.show_alert({ message: "All quantities are 0. Enter a quantity for at least one item.", indicator: "orange" });
          return;
        }
        d.hide();
        frappe.call({
          method: "chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages",
          args: { items_json: JSON.stringify(payload), company: self._company },
          freeze: true,
          freeze_message: "Creating Material Request for " + payload.length + " item" + (payload.length !== 1 ? "s" : "") + "\u2026",
          callback: r => {
            if (r.exc) return;
            const mr = r.message && r.message.mr;
            frappe.show_alert({
              message: "Purchase MR <b><a href=\"/app/material-request/" + mr
                       + "\" target=\"_blank\">" + mr + "</a></b> created for "
                       + payload.length + " item" + (payload.length !== 1 ? "s" : "") + ".",
              indicator: "green",
            }, 12);
          },
        });
      },
    });
    d.show();
  }

  _createConsolidatedMR(items) {
    // Uses the same _openMRQtyDialog as selective MR so users can
    // review quantities and change UOM before creating the consolidated MR.
    // Items come from _shortageAggList (already have moq set by procInfo fetch).
    const moqMap = {};
    items.forEach(a => { moqMap[a.item_code] = a.moq || 0; });
    this._openMRQtyDialog(
      items,
      moqMap,
      "Confirm Consolidated MR \u2014 " + items.length + " Item" + (items.length !== 1 ? "s" : "") + " (All Shortages)"
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  //  EMERGENCY PRIORITIES TAB
  //  Shows WOs with unshipped customer orders, sorted by urgency.
  //  Overdue orders (prev_month_so > 0) appear first.
  //  Computed from this.rows — no extra API call.
  // ─────────────────────────────────────────────────────────────────────

  _renderEmergencyPanel(rows) {
    const body = document.getElementById("wkp-emerg-body");
    if (!body) return;

    // Only WOs with pending customer orders
    const urgent = rows
      .filter(r => (r.total_pending_so || 0) > 0)
      .sort((a, b) => {
        // Overdue first, then by total SO desc
        const aOver = (a.prev_month_so || 0) > 0 ? 1 : 0;
        const bOver = (b.prev_month_so || 0) > 0 ? 1 : 0;
        if (aOver !== bOver) return bOver - aOver;
        return (b.total_pending_so || 0) - (a.total_pending_so || 0);
      });

    if (!urgent.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No emergency priorities found.</div>
          <div class="wkp-reco-detail">None of the open Work Orders have unshipped customer orders in the last or current month.</div>
        </div>
      </div>`;
      return;
    }

    // ── Inline dual-UOM helper (used in emergency cards, WO modal) ────────
    // Shows "5000 g (5.00 kg)" when secondary UOM exists.
    // For emergency panel we keep numbers compact: show secondary in parens.
    const _dualInline = (qty, uom, secFactor, secUom) => {
      const base = _fmt_num(qty, 0) + "\u00a0" + _esc(uom || "");
      if (secUom && secFactor > 1 && qty > 0) {
        return base + ` <span style="color:var(--stone-500);font-size:10px">(${_fmt_num(qty / secFactor, 2)}\u00a0${_esc(secUom)})</span>`;
      }
      return base;
    };

    const cardsHtml = urgent.map((row, i) => {
      const isOverdue = (row.prev_month_so || 0) > 0;
      const badgeCls  = isOverdue ? "wkp-emerg-badge-red" : "wkp-emerg-badge-amber";
      const badgeTxt  = isOverdue ? "\u26A0 OVERDUE" : "Due This Month";
      const chipClass = {
        ok: "wkp-short-ok", partial: "wkp-short-warn",
        block: "wkp-short-block", kitted: "wkp-short-kitted",
      }[row.kit_status] || "wkp-short-ok";
      const chipText  = {
        ok      : "\u2714 Ready to Produce",
        partial : (row.shortage_count || 0) + " materials short",
        block   : "\u26D4 Blocked",
        kitted  : "\u2713 Kitted",
      }[row.kit_status] || row.kit_status;

      // secondary UOM shorthand for this row
      const sf  = row.secondary_factor || 1;
      const sUom = row.secondary_uom || "";

      const overdueLine = (row.prev_month_so || 0) > 0
        ? `<div class="wkp-emerg-detail wkp-emerg-overdue">
             \u26A0 Overdue (last month): ${_dualInline(row.prev_month_so, row.uom || "", sf, sUom)}
           </div>` : "";
      const dueLine = (row.curr_month_so || 0) > 0
        ? `<div class="wkp-emerg-detail">
             Due this month: ${_dualInline(row.curr_month_so, row.uom || "", sf, sUom)}
           </div>` : "";
      const coverCheck = row.total_pending_so > row.remaining_qty
        ? `<div class="wkp-emerg-alert">
             Customer demand (${_dualInline(row.total_pending_so, row.uom || "", sf, sUom)}) exceeds
             remaining production (${_dualInline(row.remaining_qty, row.uom || "", sf, sUom)}).
             Consider creating an additional Work Order.
           </div>` : "";

      return `
<div class="wkp-emerg-card wkp-emerg-${isOverdue ? "high" : "med"}">
  <div class="wkp-emerg-left">
    <span class="wkp-emerg-rank">#${i + 1}</span>
    <span class="wkp-emerg-badge ${badgeCls}">${badgeTxt}</span>
  </div>
  <div class="wkp-emerg-main">
    <div class="wkp-emerg-wo">
      <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-wo-link">${_esc(row.wo)}</a>
    </div>
    <div class="wkp-item-name">${_esc(row.item_name || row.item_code)}</div>
    <div class="wkp-item-code">${_esc(row.item_code)}</div>
    ${row.item_group ? `<div class="wkp-item-group-tag">${_esc(row.item_group)}</div>` : ""}
    ${coverCheck}
  </div>
  <div class="wkp-emerg-orders">
    <div class="wkp-emerg-so-label">Customer Orders (Unshipped Sales Orders)</div>
    ${overdueLine}
    ${dueLine}
    <div class="wkp-emerg-total">Total: ${_dualInline(row.total_pending_so, row.uom || "", sf, sUom)}</div>
  </div>
  <div class="wkp-emerg-prod">
    <div class="wkp-emerg-so-label">Production Status</div>
    <div style="margin-bottom:4px">
      <span class="wkp-status-badge ${_status_badge_class(row.status)}"
            title="${_esc(row.status || "")}">${_esc(row.status || "")}</span>
    </div>
    <div>Remaining to produce: ${_dualInline(row.remaining_qty, row.uom || "", sf, sUom)}</div>
    <div style="margin-top:4px">
      <span class="wkp-short-chip ${chipClass}" style="font-size:11px">${chipText}</span>
    </div>
  </div>
  <div class="wkp-emerg-actions">
    <button class="wkp-btn wkp-btn-brand wkp-btn-sm" data-action="emerg-plan" data-wo="${_esc(row.wo)}"
            title="Switch to WO Plan tab and see this Work Order">
      View in Plan
    </button>
    ${(row.shortage_items || []).some(i => i.shortage > 0) ? `
    <button class="wkp-btn wkp-btn-sm" data-action="emerg-shortage" data-wo="${_esc(row.wo)}"
            title="See which materials are missing for this Work Order">
      See Shortages
    </button>` : ""}
  </div>
</div>`;
    }).join("");

    body.innerHTML = cardsHtml;

    // Bind action buttons in emergency panel
    body.querySelectorAll("[data-action='emerg-plan']").forEach(btn => {
      btn.addEventListener("click", () => {
        this._switchTab("wo-plan");
        // Scroll to the WO row after a short delay for render
        setTimeout(() => {
          const tr = document.querySelector(`tr[data-wo="${btn.dataset.wo}"]`);
          if (tr) tr.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
      });
    });
    body.querySelectorAll("[data-action='emerg-shortage']").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = this.rows.find(r => r.wo === btn.dataset.wo);
        if (row) this._showShortageModal(row);
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SHORTAGE DETAIL MODAL
  //  Opens when a shortage chip is clicked.
  //  Shows:
  //    1. Recommendation card (plain-language: what does this mean + what to do)
  //    2. Per-component breakdown table (what is needed vs available)
  //    3. "Order Missing Materials" button (creates Purchase MR)
  // ─────────────────────────────────────────────────────────────────────

  _showShortageModal(row) {
    document.getElementById("wkp-modal-title").textContent =
      "Material Shortage Detail";
    // Show WO, item name, remaining qty with both UOMs — e.g. "380 kg (380,000 g)"
    const _modalSecTxt = (row.secondary_uom && row.secondary_factor > 1)
      ? " / " + _fmt_num(row.remaining_qty / row.secondary_factor, 2) + "\u00a0" + row.secondary_uom
      : "";
    document.getElementById("wkp-modal-sub").textContent =
      row.wo + " \u2014 " + (row.item_name || row.item_code) +
      " (" + _fmt_num(row.remaining_qty, 0) + "\u00a0" + (row.uom || "") + _modalSecTxt + " remaining to produce)";

    // ── Recommendation card ─────────────────────────────────────────
    document.getElementById("wkp-modal-reco").innerHTML = this._buildRecoCard(row);

    // ── Component breakdown table ───────────────────────────────────
    const items = row.shortage_items || [];
    let bodyHtml = "";

    if (!items.length) {
      bodyHtml = `<p class="wkp-modal-empty">
        No BOM components found. Please ensure an active BOM exists for this item.
      </p>`;
    } else {
      // ── UOM helper: show "5000 g (5 kg)" if secondary UOM available ──────
      const _dualQty = (qty, uom, secQty, secUom) => {
        const base = _fmt_num(qty, 2) + " " + _esc(uom || "");
        if (secUom && secQty != null && secQty !== 0)
          return base + `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(secQty, 2)}\u00a0${_esc(secUom)}</div>`;
        return base;
      };

      const rowsHtml = items.map(it => {
        const isShort  = (it.shortage || 0) > 0;
        const valTxt   = (it.shortage_value || 0) > 0
          ? "\u20B9" + _fmt_num(it.shortage_value, 0) : "\u2014";
        const stageCls = "wkp-stage-" + (it.stage_color || "green");
        const stageDesc = _stage_description(it.stage);

        const sec       = it.secondary_uom || "";
        const secFactor = (it.secondary_factor || 0) > 1 ? it.secondary_factor : 0;

        const reqHtml  = _dualQty(it.required,  it.uom, it.required_secondary,  sec);
        const avlHtml  = _dualQty(it.available, it.uom, it.available_secondary, sec);
        const shtHtml  = isShort ? _dualQty(it.shortage, it.uom, it.shortage_secondary, sec) : "\u2014";

        // Dual-UOM helper for qty fields without pre-computed secondary values.
        // Shows "2,500 g" + secondary line "2.50 kg" if secondary UOM exists,
        // or just "2,500 g" if no secondary. Returns "—" for zero/null.
        const _dq = (qty) => {
          if (!(qty > 0)) return "\u2014";
          return secFactor
            ? _dualQty(qty, it.uom, qty / secFactor, sec)
            : _fmt_num(qty, 2) + "\u00a0" + _esc(it.uom || "");
        };

        const consumedTxt = _dq(it.consumed_qty    || 0);
        const poTxt       = _dq(it.po_qty          || 0);
        const rcvTxt      = _dq(it.received_qty_po || 0);
        const mrTxt       = _dq(it.mr_qty          || 0);
        const netGap      = Math.max(0, (it.shortage || 0) - (it.po_qty || 0) - (it.mr_qty || 0));
        const netCls      = netGap > 0 ? "wkp-cell-red" : (isShort ? "wkp-cell-green" : "");
        const netTxt      = isShort
          ? (netGap > 0 ? _dq(netGap) : "\u2714 Covered")
          : "\u2014";

        return `
<tr class="${isShort ? "wkp-modal-row-short" : ""}">
  <td>
    <div class="wkp-item-name">${_esc(it.item_name || it.item_code)}</div>
    <div class="wkp-item-code">${_esc(it.item_code)}</div>
  </td>
  <td class="ta-r" data-tip="Total qty of this material needed for the remaining production quantity of this Work Order.&#10;Formula: BOM per_unit_qty &times; remaining_qty">
    <strong>${reqHtml}</strong>
  </td>
  <td class="ta-r ${isShort ? "" : "wkp-cell-green"}"
      data-tip="Physical qty available in warehouse (Bin.actual_qty across all warehouses).${this.stockMode === "current_and_expected" ? " Mode Y also adds open PO/MR/WO expected qty to available qty." : ""}">
    ${avlHtml}
  </td>
  <td class="ta-r ${isShort ? "wkp-cell-red" : "wkp-cell-green"}"
      data-tip="Shortage = Required &minus; Available. Zero or blank = enough in stock.">
    ${shtHtml}
  </td>
  <td class="ta-r"
      data-tip="Qty already consumed from warehouse for this Work Order (from submitted Manufacture Stock Entries).&#10;If this WO is In Process, some materials may already be partially consumed.">
    ${consumedTxt}
  </td>
  <td class="ta-r"
      data-tip="Qty on open Purchase Orders for this material.&#10;Source: Purchase Order Items where PO is submitted and not closed/cancelled.">
    ${poTxt}
  </td>
  <td class="ta-r" style="color:var(--ok-text)"
      data-tip="Qty already received from open Purchase Orders.&#10;This stock is in transit or staged in receiving — may not yet be in the production warehouse.">
    ${rcvTxt}
  </td>
  <td class="ta-r"
      data-tip="Qty on open Material Requests (Purchase type, not yet converted to PO).&#10;Source: Material Request Items where status is not Ordered/Stopped.">
    ${mrTxt}
  </td>
  <td class="ta-r ${netCls}"
      data-tip="Net Gap = Shortage &minus; PO Qty &minus; MR Qty.&#10;If positive, this material has NO procurement action and needs immediate attention.&#10;If zero or negative, existing POs/MRs should cover the shortage.">
    ${netTxt}
  </td>
  <td>${valTxt}</td>
  <td>
    <span class="wkp-stage-badge ${stageCls}"
          data-tip="${stageDesc}"
          title="${stageDesc}">${_esc(it.stage || "In Stock")}</span>
  </td>
</tr>`;
      }).join("");

      bodyHtml = `
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 4px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">
  Material-by-material breakdown &mdash; hover any cell for data source
</div>
<table class="wkp-modal-table wkp-modal-table-wide">
  <thead>
    <tr>
      <th>Material / Ingredient</th>
      <th class="ta-r" data-tip="Qty needed for the remaining production run">Need</th>
      <th class="ta-r" data-tip="Physical warehouse stock">In Stock</th>
      <th class="ta-r" data-tip="Qty still needed (Need &minus; In Stock)">Shortage</th>
      <th class="ta-r" data-tip="Already consumed via Stock Entry for this WO">Consumed</th>
      <th class="ta-r" data-tip="Open Purchase Order quantity (ordered, not received)">PO Raised</th>
      <th class="ta-r" data-tip="Qty already received from open POs (may still be in receiving warehouse)">Received</th>
      <th class="ta-r" data-tip="Open Material Request quantity (not yet ordered)">MR Raised</th>
      <th class="ta-r" data-tip="Net Gap = Shortage &minus; PO &minus; MR. Positive = needs urgent action.">Net Gap</th>
      <th class="ta-r">Value (\u20B9)</th>
      <th data-tip="Where this material is in the supply chain">Stage</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div style="font-size:11px;color:var(--stone-400);padding:8px 0 0;line-height:1.5">
  <strong>Stage legend:</strong>
  In Stock = available now &nbsp;|&nbsp; In Production = sub-assembly WO open &nbsp;|&nbsp;
  PO Raised = ordered from supplier &nbsp;|&nbsp; Received = arrived, pending put-away &nbsp;|&nbsp;
  MR Raised = requested, not yet ordered &nbsp;|&nbsp;
  Short = no action taken
</div>`;
    }

    document.getElementById("wkp-modal-body").innerHTML = bodyHtml;

    // ── Create MR button ────────────────────────────────────────────
    const hasShortage = items.some(i => (i.shortage || 0) > 0);
    const mrBtn = document.getElementById("wkp-create-mr-btn");
    const canCreate = hasShortage && frappe.user.has_role([
      "System Manager", "TOC Manager", "Stock Manager",
      "Purchase Manager", "Manufacturing Manager",
    ]);
    mrBtn.style.display = canCreate ? "" : "none";
    if (canCreate) mrBtn.onclick = () => this._createMR(row);

    document.getElementById("wkp-modal").style.display = "flex";
  }

  /**
   * Build a plain-language recommendation card for the shortage modal.
   * This is the first thing an executive sees — "what does this mean and what should I do?"
   */
  _buildRecoCard(row) {
    const sc = row.shortage_count || 0;
    const sv = row.shortage_value || 0;

    const configs = {
      ok: {
        bg    : "wkp-reco-ok",
        icon  : "\u2705",
        head  : "This Work Order can start production immediately.",
        detail: "All required materials are available in the warehouse right now. No action needed on procurement.",
        action: null,
      },
      partial: {
        bg    : "wkp-reco-warn",
        icon  : "\u26A0\uFE0F",
        head  : sc + " material" + (sc === 1 ? "" : "s") + " need to be ordered"
                + (sv > 0 ? " (\u20B9" + _fmt_num(sv, 0) + " worth)" : "") + ".",
        detail: "Some ingredients are short. You can either partially produce what is possible now, or wait until all materials arrive and produce in full. Review the table below to decide which materials to expedite.",
        action: "Click \u201cOrder Missing Materials\u201d below to create a Purchase MR and send it to your procurement team.",
      },
      block: {
        bg    : "wkp-reco-err",
        icon  : "\uD83D\uDD34",
        head  : "Production is blocked \u2014 " + sc + " critical material" + (sc === 1 ? "" : "s") + " must be ordered first.",
        detail: "None of the required materials are available. This Work Order CANNOT start until procurement delivers the missing items."
                + (sv > 0 ? " Estimated purchase cost: \u20B9" + _fmt_num(sv, 0) + "." : ""),
        action: "Click \u201cOrder Missing Materials\u201d below to immediately create a Purchase MR. Mark it URGENT in your procurement workflow.",
      },
      kitted: {
        bg    : "wkp-reco-buy",
        icon  : "\u2705",
        head  : "Materials have already been transferred to the production floor.",
        detail: "This Work Order has been kitted. Check with the shop floor supervisor or production manager for current status.",
        action: null,
      },
    };

    const c = configs[row.kit_status] || configs.ok;
    return `
<div class="wkp-reco ${c.bg}">
  <div class="wkp-reco-icon">${c.icon}</div>
  <div class="wkp-reco-body">
    <div class="wkp-reco-headline">${c.head}</div>
    <div class="wkp-reco-detail">${c.detail}</div>
    ${c.action ? `<span class="wkp-reco-action">\uD83D\uDCA1 ${c.action}</span>` : ""}
  </div>
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  WO DETAIL MODAL
  //  Full picture of one Work Order: quantities, cost, customer orders, kitting status.
  //  Includes a "Decision Card" at the top with actionable business guidance.
  // ─────────────────────────────────────────────────────────────────────

  _showWOModal(row) {
    document.getElementById("wkp-wo-title").textContent = row.wo;
    document.getElementById("wkp-wo-sub").textContent   =
      (row.item_name || row.item_code) + " \u2014 " + (row.status || "");

    const totalSO     = (row.total_pending_so || 0);
    const isOverdue   = (row.prev_month_so || 0) > 0;
    const estCost     = row.est_cost ? "\u20B9" + _fmt_num(row.est_cost, 0) : "\u2014";

    // ── Inline dual-UOM helper for WO modal info rows ───────────────────────
    // Shows "380 kg (380,000 g)" when secondary UOM is set; plain "380 kg" otherwise.
    const sf   = row.secondary_factor || 1;
    const sUom = row.secondary_uom || "";
    const _woDual = (qty, decimals) => {
      const base = _fmt_num(qty, decimals) + "\u00a0" + _esc(row.uom || "");
      if (sUom && sf > 1 && qty > 0) {
        return base + ` <span style="color:var(--stone-500);font-size:10px">(${_fmt_num(qty / sf, 2)}\u00a0${_esc(sUom)})</span>`;
      }
      return base;
    };

    // ── Decision card (top of modal) ────────────────────────────────
    const decisionHtml = this._buildDecisionCard(row);

    // ── WO info grid ────────────────────────────────────────────────
    const pressureHtml = totalSO > 0
      ? `<span class="wkp-pressure ${isOverdue ? "wkp-pressure-high" : "wkp-pressure-med"}">
           ${isOverdue ? "\u26A0 Overdue: " : "Due: "}${_woDual(totalSO, 0)}
         </span>`
      : `<span class="wkp-pressure wkp-pressure-none">No pending customer orders</span>`;

    const html = `
${decisionHtml}

<div class="wkp-wo-grid">

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Work Order Info</div>
    <div class="wkp-wo-info-row">
      <span>Work Order No.</span>
      <span><a href="/app/work-order/${_esc(row.wo)}" target="_blank">${_esc(row.wo)}</a></span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Product (Item)</span>
      <span>${_esc(row.item_name || row.item_code)}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Item Code</span>
      <span class="mono">${_esc(row.item_code || "")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Bill of Materials (BOM)</span>
      <span class="mono">${_esc(row.bom_no || "\u2014")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>ERP Stage</span>
      <span>${_esc(row.status || "\u2014")}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Planned Start Date</span>
      <span>${_esc(row.planned_start_date || "\u2014")}</span>
    </div>
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Production Quantities</div>
    <div class="wkp-wo-info-row">
      <span>Planned Qty</span>
      <span>${_woDual(row.planned_qty, 0)}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Already Produced</span>
      <span>${_woDual(row.produced_qty || 0, 0)}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span><strong>Still to Produce</strong></span>
      <span><strong>${_woDual(row.remaining_qty, 0)}</strong></span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Stock Unit (UOM)</span>
      <span>${_esc(row.uom || "")}${sUom ? " \u2192 also shown in " + _esc(sUom) : ""}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Est. Production Cost</span>
      <span>${estCost}</span>
    </div>
    ${row.shortage_value > 0 ? `
    <div class="wkp-wo-info-row">
      <span>Missing Materials Cost</span>
      <span style="color:var(--err-text);font-weight:700">\u20B9${_fmt_num(row.shortage_value, 0)}</span>
    </div>` : ""}
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Customer Order Pressure (Sales Orders)</div>
    <div style="margin-bottom:10px">${pressureHtml}</div>
    <div class="wkp-wo-info-row">
      <span>Last Month Unshipped (Overdue)</span>
      <span ${(row.prev_month_so || 0) > 0 ? 'style="color:var(--err-text);font-weight:700"' : ""}>
        ${(row.prev_month_so || 0) > 0 ? _woDual(row.prev_month_so, 0) : "\u2014 No overdue orders"}
      </span>
    </div>
    <div class="wkp-wo-info-row">
      <span>This Month Orders</span>
      <span>${(row.curr_month_so || 0) > 0 ? _woDual(row.curr_month_so, 0) : "\u2014"}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span><strong>Total Unshipped Orders</strong></span>
      <span><strong>${totalSO > 0 ? _woDual(totalSO, 0) : "\u2014"}</strong></span>
    </div>
    ${totalSO > row.remaining_qty ? `
    <div style="margin-top:8px;font-size:11px;color:var(--err-text);font-weight:600">
      \u26A0 Customer demand (${_woDual(totalSO, 0)}) exceeds remaining production (${_woDual(row.remaining_qty, 0)}). Additional Work Orders may be needed.
    </div>` : ""}
  </div>

  <div class="wkp-wo-section">
    <div class="wkp-wo-section-title">Kitting / Material Status</div>
    <div class="wkp-wo-kit-status ${_kit_status_class(row.kit_status)}">
      ${_kit_status_label(row.kit_status)}
    </div>
    ${row.shortage_count > 0 ? `
    <div class="wkp-wo-info-row" style="margin-top:10px">
      <span>Materials missing</span>
      <span style="color:var(--err-text);font-weight:700">${row.shortage_count}</span>
    </div>
    <div class="wkp-wo-info-row">
      <span>Materials to buy</span>
      <span style="color:var(--err-text);font-weight:700">\u20B9${_fmt_num(row.shortage_value || 0, 0)}</span>
    </div>
    <div style="margin-top:8px">
      <button class="wkp-btn wkp-btn-sm" onclick="document.getElementById('wkp-wo-modal').style.display='none';
        document.querySelector('[data-action=wo-detail][data-wo=&quot;${_esc(row.wo)}&quot;]') && document.querySelector('.wkp-short-chip[data-wo=&quot;${_esc(row.wo)}&quot;]').click()">
        See Material Breakdown
      </button>
    </div>` : ""}
  </div>

</div>

<div class="wkp-wo-footer">
  <a href="/app/work-order/${_esc(row.wo)}" target="_blank" class="wkp-btn wkp-btn-brand">
    Open in ERPNext \u2192
  </a>
</div>`;

    document.getElementById("wkp-wo-body").innerHTML = html;
    document.getElementById("wkp-wo-modal").style.display = "flex";
  }

  // ─────────────────────────────────────────────────────────────────────
  //  360° COST AUDIT MODAL
  //
  //  PURPOSE: Show BOM standard cost vs actual consumed cost per WO.
  //
  //  WHY: Inventory valuation errors silently distort P&L. This panel
  //  lets managers spot when actual consumption > standard (scrap/rework),
  //  stale valuation rates, or wrong Stock Entry posting.
  //
  //  LAYOUT (frappe.ui.Dialog with HTML field):
  //    1. Summary strip: Std cost / Actual cost / Variance (color-coded)
  //    2. BOM Components table (standard cost breakdown)
  //    3. Actual Consumed table (from Stock Entry Manufacture)
  //    4. Historical table (last 5 completed WOs for same item)
  //
  //  DATA FLOW:
  //    _showCostAuditModal(row) → frappe.call get_wo_cost_audit(wo_name)
  //    → _buildCostAuditHtml(audit) → inject into frappe.ui.Dialog HTML field
  //
  //  NOTE: get_wo_cost_audit() uses current Item.valuation_rate — not the
  //  BOM snapshot rate — so std cost reflects today's material prices.
  // ─────────────────────────────────────────────────────────────────────

  _showCostAuditModal(row) {
    const dlg = new frappe.ui.Dialog({
      title: "\u20B9 360\u00b0 Cost Audit \u2014 " + row.wo,
      fields: [{ fieldtype: "HTML", fieldname: "audit_body" }],
      size: "large",
    });

    const $body = dlg.fields_dict.audit_body.$wrapper;
    $body.html(
      '<div style="padding:32px;text-align:center;color:var(--stone-400);font-size:13px">'
      + "Loading cost data\u2026</div>"
    );
    dlg.show();

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_wo_cost_audit",
      args: { wo_name: row.wo },
      callback: r => {
        if (!r || !r.message) {
          $body.html('<div class="wkp-cost-error">No cost data returned from server.</div>');
          return;
        }
        $body.html(this._buildCostAuditHtml(r.message));
      },
      error: () => {
        $body.html('<div class="wkp-cost-error">Failed to load cost data. Check Error Log.</div>');
      },
    });
  }

  _buildCostAuditHtml(a) {
    // ── Helpers ────────────────────────────────────────────────────────
    const fmt = (n, d) => n != null ? _fmt_num(n, d ?? 2) : "\u2014";

    // ── Summary strip ──────────────────────────────────────────────────
    const hasActual = a.total_actual_cost > 0;
    const vPct      = a.variance_pct;
    const vTotal    = a.variance_total;
    let varClass = "";
    let varSign  = "";
    if (vTotal != null) {
      if      (vTotal > 0) { varClass = "wkp-cost-var-over";  varSign = "+"; }
      else if (vTotal < 0) { varClass = "wkp-cost-var-under"; varSign = ""; }
    }

    const stdPerUnit = a.std_cost_per_unit
      ? `\u20B9${_fmt_num(a.std_cost_per_unit, 2)} / ${_esc(a.stock_uom)}`
        + (a.std_cost_per_secondary ? ` &nbsp;|&nbsp; \u20B9${_fmt_num(a.std_cost_per_secondary, 2)} / ${_esc(a.secondary_uom)}` : "")
      : "\u2014";

    const actPerUnit = a.actual_cost_per_unit != null
      ? `\u20B9${_fmt_num(a.actual_cost_per_unit, 2)} / ${_esc(a.stock_uom)}`
        + (a.actual_cost_per_secondary ? ` &nbsp;|&nbsp; \u20B9${_fmt_num(a.actual_cost_per_secondary, 2)} / ${_esc(a.secondary_uom)}` : "")
      : (hasActual ? "\u2014" : "<span style=\"color:var(--stone-400);font-size:11px\">No production yet</span>");

    const summaryHtml = `
<div class="wkp-cost-summary-strip">
  <div class="wkp-cost-sum-card wkp-cost-sum-std">
    <div class="wkp-cost-sum-label">BOM Standard Cost</div>
    <div class="wkp-cost-sum-value">\u20B9${_fmt_num(a.total_std_cost, 0)}</div>
    <div class="wkp-cost-sum-sub">for ${_fmt_num(a.remaining_qty, 0)}&nbsp;${_esc(a.stock_uom)} remaining</div>
    <div class="wkp-cost-sum-rate">${stdPerUnit}</div>
  </div>
  <div class="wkp-cost-sum-card ${hasActual ? (vTotal > 0 ? "wkp-cost-sum-over" : "wkp-cost-sum-under") : "wkp-cost-sum-neutral"}">
    <div class="wkp-cost-sum-label">Actual Consumed Cost</div>
    <div class="wkp-cost-sum-value">${hasActual ? "\u20B9" + _fmt_num(a.total_actual_cost, 0) : "\u2014"}</div>
    <div class="wkp-cost-sum-sub">for ${_fmt_num(a.produced_qty, 0)}&nbsp;${_esc(a.stock_uom)} produced</div>
    <div class="wkp-cost-sum-rate">${actPerUnit}</div>
  </div>
  ${vTotal != null ? `
  <div class="wkp-cost-sum-card ${vTotal > 0 ? "wkp-cost-sum-over" : "wkp-cost-sum-under"}">
    <div class="wkp-cost-sum-label">Variance (Actual \u2212 Standard)</div>
    <div class="wkp-cost-sum-value ${varClass}">${varSign}\u20B9${_fmt_num(Math.abs(vTotal), 0)}</div>
    <div class="wkp-cost-sum-sub ${varClass}">${varSign}${_fmt_num(vPct, 1)}% vs standard</div>
    <div class="wkp-cost-sum-rate">${vTotal > 0
      ? "<span class=\"wkp-cost-var-over\">Overspent \u2014 check scrap / extra issues</span>"
      : "<span class=\"wkp-cost-var-under\">Savings \u2014 or valuation rate too high</span>"}</div>
  </div>` : ""}
</div>`;

    // ── BOM Components table ───────────────────────────────────────────
    const bomRows = (a.bom_components || []).map(c =>
      `<tr>
        <td>${_esc(c.item_name)}</td>
        <td class="ta-r">${fmt(c.qty_per_unit, 4)}</td>
        <td>${_esc(c.uom)}</td>
        <td class="ta-r">\u20B9${fmt(c.valuation_rate, 2)}</td>
        <td class="ta-r">\u20B9${fmt(c.std_cost_per_unit, 4)}</td>
        <td class="ta-r wkp-cost-total-col">\u20B9${_fmt_num(c.total_std_cost, 0)}</td>
      </tr>`
    ).join("");

    const bomHtml = `
<div class="wkp-cost-section">
  <div class="wkp-cost-section-title">
    BOM Standard Cost Breakdown
    <span class="wkp-cost-section-note">BOM: ${_esc(a.bom_no || "\u2014")} &nbsp;|&nbsp; Batch size: ${fmt(a.bom_qty, 0)}&nbsp;${_esc(a.stock_uom)}</span>
  </div>
  <div style="font-size:10px;color:var(--slate-500);padding:6px 12px;background:var(--slate-50);border-bottom:1px solid var(--slate-100)">
    Source: <code>tabBOM Item</code> (stock_qty / bom_qty = qty per unit) \xd7
    <code>tabItem.valuation_rate</code> (current Item master rate \u2014 not BOM snapshot).
    Rate = live valuation rate; changes to Item master are reflected immediately.
  </div>
  ${bomRows.length ? `
  <table class="wkp-cost-table">
    <thead><tr>
      <th>Component</th><th class="ta-r">Qty/Unit</th><th>UOM</th>
      <th class="ta-r">Rate</th><th class="ta-r">Std Cost/Unit</th>
      <th class="ta-r wkp-cost-total-col">Total Std Cost</th>
    </tr></thead>
    <tbody>${bomRows}</tbody>
    <tfoot><tr>
      <td colspan="4"><strong>Total Standard Cost</strong></td>
      <td class="ta-r"><strong>\u20B9${fmt(a.std_cost_per_unit, 4)}</strong></td>
      <td class="ta-r wkp-cost-total-col"><strong>\u20B9${_fmt_num(a.total_std_cost, 0)}</strong></td>
    </tr></tfoot>
  </table>` : '<div class="wkp-cost-empty">No active BOM found for this Work Order.</div>'}
</div>`;

    // ── Actual Consumed table ──────────────────────────────────────────
    // Batch-aware: if batch_no is present, show it. Group visually by item.
    // Data source: tabStock Entry (Manufacture) → tabStock Entry Detail
    //   item_name: SED.item_name | uom: SED.stock_uom | avg_rate: valuation_rate at posting
    //   batch_no: SED.batch_no (empty string when item is not batch-tracked)
    //   total_amount: SED.amount (qty × valuation_rate at time of posting)
    const hasBatch = (a.actual_consumed || []).some(c => c.batch_no);
    const actRows = (a.actual_consumed || []).map(c => {
      const varAmt = c.variance;
      const varCls = varAmt == null ? "" : (varAmt > 0 ? "wkp-cost-var-over" : (varAmt < 0 ? "wkp-cost-var-under" : ""));
      const batchCell = hasBatch
        ? `<td style="font-size:10px;color:var(--slate-500)">${c.batch_no
            ? `<span style="background:var(--slate-100);border-radius:3px;padding:1px 5px;font-family:monospace">${_esc(c.batch_no)}</span>`
            : "<span style='color:var(--slate-300)'>\u2014</span>"}</td>`
        : "";
      const dateCell = hasBatch
        ? `<td style="font-size:10px;color:var(--slate-500)">${_esc(c.posting_date || "\u2014")}</td>`
        : "";
      return `<tr>
        <td>
          <span style="font-size:11px;font-weight:600">${_esc(c.item_name)}</span>
          <span style="font-size:10px;color:var(--slate-400);display:block"
                title="Source: tabStock Entry Detail.item_code">${_esc(c.item_code || "")}</span>
        </td>
        ${batchCell}${dateCell}
        <td class="ta-r" title="Source: tabStock Entry Detail.qty">${fmt(c.consumed_qty, 2)}</td>
        <td class="ta-r" title="Standard qty required for quantity produced so far">
          ${c.std_qty != null ? fmt(c.std_qty, 2) : "\u2014"}
        </td>
        <td title="Source: tabStock Entry Detail.stock_uom">${_esc(c.uom)}</td>
        <td class="ta-r" title="Source: tabStock Entry Detail.amount / qty (valuation_rate at posting)">\u20B9${fmt(c.avg_rate, 2)}</td>
        <td class="ta-r" title="Source: tabStock Entry Detail.amount (qty \xd7 valuation_rate)">\u20B9${fmt(c.total_amount, 0)}</td>
        <td class="ta-r ${varCls}"
            title="Variance = Actual Cost \u2212 (Std Cost/Unit \xd7 Produced Qty)">
          ${varAmt != null ? (varAmt >= 0 ? "+" : "") + "\u20B9" + _fmt_num(Math.abs(varAmt), 0) : "\u2014"}
        </td>
      </tr>`;
    }).join("");

    const actColSpan = hasBatch ? 7 : 5;
    const actHtml = `
<div class="wkp-cost-section">
  <div class="wkp-cost-section-title">
    Actual Consumed (Stock Entry \u2192 Manufacture)
    <span class="wkp-cost-section-note">${_fmt_num(a.produced_qty, 0)}&nbsp;${_esc(a.stock_uom)} produced so far
      ${hasBatch ? " &bull; Batch-wise breakdown" : ""}</span>
  </div>
  <div style="font-size:10px;color:var(--slate-500);padding:6px 12px;background:var(--slate-50);border-bottom:1px solid var(--slate-100)">
    Source: <code>tabStock Entry</code> (purpose=Manufacture, docstatus=1) \u2192
    <code>tabStock Entry Detail</code> (s_warehouse IS NOT NULL = consumed inputs).
    Avg Rate = valuation_rate at time of posting (may differ from current Item master rate).
  </div>
  ${actRows.length ? `
  <table class="wkp-cost-table">
    <thead><tr>
      <th>Material</th>
      ${hasBatch ? "<th>Batch</th><th>Date</th>" : ""}
      <th class="ta-r">Consumed</th><th class="ta-r">Std Qty</th><th>UOM</th>
      <th class="ta-r">Avg Rate</th><th class="ta-r">Actual Cost</th>
      <th class="ta-r">Variance</th>
    </tr></thead>
    <tbody>${actRows}</tbody>
    <tfoot><tr>
      <td colspan="${actColSpan}"><strong>Total Actual Cost</strong></td>
      <td class="ta-r"><strong>\u20B9${_fmt_num(a.total_actual_cost, 0)}</strong></td>
      <td class="ta-r ${vTotal != null && vTotal > 0 ? "wkp-cost-var-over" : "wkp-cost-var-under"}">
        ${vTotal != null ? (vTotal >= 0 ? "+" : "") + "\u20B9" + _fmt_num(Math.abs(vTotal), 0) : "\u2014"}
      </td>
    </tr></tfoot>
  </table>` : `<div class="wkp-cost-empty">
    No Manufacture Stock Entries found yet.<br>
    <span style="font-size:11px;color:var(--slate-400)">Standard cost shows BOM estimate. Actual cost will appear after materials are issued.</span>
  </div>`}
</div>`;

    // ── Historical table ───────────────────────────────────────────────
    const histRows = (a.historical || []).map(h => {
      const cPU = h.actual_cost_per_unit;
      const stdPU = a.std_cost_per_unit;
      let histCls = "";
      if (cPU != null && stdPU > 0) {
        const diff = (cPU - stdPU) / stdPU * 100;
        if (diff > 10) histCls = "wkp-cost-var-over";
        else if (diff < -10) histCls = "wkp-cost-var-under";
      }
      return `<tr>
        <td><a href="/app/work-order/${_esc(h.wo)}" target="_blank" class="wkp-wo-link">${_esc(h.wo)}</a></td>
        <td>${_esc(h.actual_end_date || "\u2014")}</td>
        <td class="ta-r">${_fmt_num(h.produced_qty || h.qty, 0)}&nbsp;${_esc(h.uom)}</td>
        <td class="ta-r">\u20B9${_fmt_num(h.actual_cost, 0)}</td>
        <td class="ta-r ${histCls}">${cPU != null ? "\u20B9" + _fmt_num(cPU, 2) + " /" + _esc(h.uom) : "\u2014"}</td>
      </tr>`;
    }).join("");

    const histHtml = `
<div class="wkp-cost-section">
  <div class="wkp-cost-section-title">
    Historical Cost \u2014 Last ${(a.historical || []).length} Completed WOs for ${_esc(a.item_name)}
  </div>
  ${histRows.length ? `
  <table class="wkp-cost-table">
    <thead><tr>
      <th>Work Order</th><th>Completed</th><th class="ta-r">Produced</th>
      <th class="ta-r">Total Cost</th><th class="ta-r">Cost / Unit</th>
    </tr></thead>
    <tbody>${histRows}</tbody>
  </table>
  <div class="wkp-cost-hist-note">
    Color: <span class="wkp-cost-var-over">red = cost/unit &gt;10% above current BOM std</span> &nbsp;
    <span class="wkp-cost-var-under">green = &gt;10% below current BOM std</span>
  </div>` : `<div class="wkp-cost-empty">No completed Work Orders found for this item.</div>`}
</div>`;

    const openERP = `
<div class="wkp-cost-footer">
  <a href="/app/work-order/${_esc(a.wo)}" target="_blank" class="wkp-btn wkp-btn-brand">
    Open Work Order in ERPNext \u2192
  </a>
</div>`;

    return summaryHtml + bomHtml + actHtml + histHtml + openERP;
  }

  /**
   * Builds the top decision card in the WO detail modal.
   * Tells the executive exactly what to do based on the situation.
   */
  _buildDecisionCard(row) {
    const totalSO = row.total_pending_so || 0;
    const pressure = totalSO > 0 ? (row.prev_month_so > 0 ? "high" : "medium") : "none";

    // Inline dual-UOM helper for decision card (same pattern as WO modal)
    const sf   = row.secondary_factor || 1;
    const sUom = row.secondary_uom || "";
    const _dcDual = (qty) => {
      const base = _fmt_num(qty, 0) + "\u00a0" + _esc(row.uom || "");
      if (sUom && sf > 1 && qty > 0)
        return base + ` (${_fmt_num(qty / sf, 2)}\u00a0${_esc(sUom)})`;
      return base;
    };

    const pressureLine = {
      high  : `\u26A0 <strong>URGENT</strong> \u2014 There are overdue customer orders (${_dcDual(row.prev_month_so || 0)} past due). Expedite this production.`,
      medium: `Customer orders of ${_dcDual(totalSO)} are due this month.`,
      none  : "No pending customer orders for this product this month.",
    }[pressure];

    const statusCfg = {
      ok: {
        cls : "wkp-decision-ok",
        text: "\u2705 This Work Order can start immediately \u2014 all materials are in stock.",
        sub : "Release this to the production floor today.",
      },
      partial: {
        cls : "wkp-decision-warn",
        text: "\u26A0 Partially blocked \u2014 " + (row.shortage_count || 0) + " materials need to be ordered.",
        sub : "Create a Purchase MR for missing materials. You may be able to start partial production meanwhile.",
      },
      block: {
        cls : "wkp-decision-err",
        text: "\uD83D\uDD34 Fully blocked \u2014 production cannot start without procurement.",
        sub : "Immediately create a Purchase MR for all " + (row.shortage_count || 0) + " missing materials.",
      },
      kitted: {
        cls : "wkp-decision-buy",
        text: "\u2705 Materials already kitted and on the production floor.",
        sub : "Follow up with the shop floor supervisor for production progress.",
      },
    };

    const s = statusCfg[row.kit_status] || statusCfg.ok;

    return `
<div class="wkp-decision ${s.cls}" style="margin-bottom:0">
  <div class="wkp-decision-label">What to do</div>
  <div class="wkp-decision-text">${s.text}</div>
  <div class="wkp-decision-sub">${s.sub}</div>
  <div class="wkp-decision-sub" style="margin-top:6px;border-top:1px solid rgba(0,0,0,.06);padding-top:6px">
    ${pressureLine}
  </div>
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CREATE PURCHASE MR
  // ─────────────────────────────────────────────────────────────────────

  _createMR(row) {
    // ── WKP-010: Warehouse required — prompt user before API call ──────────
    // create_purchase_mr_for_wo_shortages requires a warehouse on every MR line.
    // Without it the Material Request save fails with a Required Field error.
    // Solution: frappe.prompt() shows a modal asking the user to pick a warehouse
    // BEFORE we call the API. The chosen warehouse is applied to all MR lines.
    const items = (row.shortage_items || []).filter(i => (i.shortage || 0) > 0);
    if (!items.length) {
      frappe.show_alert({ message: "No shortage items to create MR for.", indicator: "orange" });
      return;
    }

    frappe.prompt(
      [{
        label      : "Target Warehouse",
        fieldname  : "warehouse",
        fieldtype  : "Link",
        options    : "Warehouse",
        reqd       : 1,
        description: "Warehouse where the purchased materials will be received.",
      }],
      (values) => {
        const payload = items.map(i => ({
          item_code   : i.item_code,
          shortage_qty: i.shortage,
          uom         : i.uom || "",
          warehouse   : values.warehouse,
        }));

        frappe.call({
          method: "chaizup_toc.api.wo_kitting_api.create_purchase_mr_for_wo_shortages",
          args: { items_json: JSON.stringify(payload), company: this._company },
          freeze: true,
          freeze_message: "Creating Material Request for " + items.length + " items\u2026",
          callback: r => {
            if (r.exc) return;
            const mr = r.message && r.message.mr;
            this._closeModal("wkp-modal");
            frappe.show_alert({
              message: "Purchase MR <b><a href=\"/app/material-request/" + mr
                       + "\" target=\"_blank\">" + mr + "</a></b> created for "
                       + items.length + " items. Send to procurement for action.",
              indicator: "green",
            }, 10);
          },
        });
      },
      "Select Warehouse for Material Request",
      "Create MR"
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  //  CONTEXT BAR (formerly hint bar)
  //  Shows mode + live simulation results in plain language after each run.
  // ─────────────────────────────────────────────────────────────────────

  _updateHintBar(rows) {
    const modeEl   = document.getElementById("wkp-hint-mode");
    const textEl   = document.getElementById("wkp-hint-text");
    const iconEl   = document.getElementById("wkp-hint-icon");
    if (!modeEl || !textEl) return;

    // ── Mode label ──────────────────────────────────────────────────
    const stockLabel = this.stockMode === "current_only"
      ? "Physical stock only"
      : "Physical + Expected stock";

    const modeLabel = this.calcMode === "isolated"
      ? "Mode A \u2014 Independent Check \u00B7 " + stockLabel
      : "Mode B \u2014 Priority Queue \u00B7 " + stockLabel;

    modeEl.textContent = modeLabel;

    // ── Results summary ─────────────────────────────────────────────
    if (!rows || !rows.length) {
      this._setHintText("Checking which Work Orders can start production today\u2026");
      if (iconEl) iconEl.innerHTML = '<i class="fa-solid fa-chart-bar"></i>';
      return;
    }

    let ready = 0, partial = 0, blocked = 0;
    for (const r of rows) {
      if (r.kit_status === "ok" || r.kit_status === "kitted") ready++;
      else if (r.kit_status === "partial")                     partial++;
      else if (r.kit_status === "block")                       blocked++;
    }

    const parts = [];
    if (ready)   parts.push(ready   + " ready to start");
    if (partial) parts.push(partial + " partially blocked");
    if (blocked) parts.push(blocked + " fully blocked");

    const summary = rows.length + " Work Orders \u2014 " + parts.join(" \u00B7 ");
    this._setHintText(summary);

    // WKP-029: Use FA icons (not emoji textContent) for consistent cross-device rendering
    if (iconEl) {
      if (blocked > 0)
        iconEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation" style="color:var(--err)"></i>';
      else if (partial > 0)
        iconEl.innerHTML = '<i class="fa-solid fa-circle-half-stroke" style="color:var(--warn)"></i>';
      else
        iconEl.innerHTML = '<i class="fa-solid fa-circle-check" style="color:var(--ok)"></i>';
    }
  }

  _setHintText(text) {
    const el = document.getElementById("wkp-hint-text");
    if (el) el.textContent = text;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  AI ADVISOR TAB (§9)
  //
  //  PURPOSE: Plain-language production decision support via DeepSeek AI.
  //    1. Auto-insight: generated after every simulation (stateless call)
  //    2. Chat: session-persistent Q&A about production/purchase/dispatch
  //
  //  ARCHITECTURE:
  //    Session ID stored in sessionStorage → survives tab navigation,
  //    resets on full page refresh (intentional — fresh simulation = fresh session).
  //
  //    Context: _compressContextAndFetchInsight() calls server-side
  //    compress_context_for_ai() which builds a ~400-token summary.
  //    This same context is sent with every chat message so the AI
  //    always has the current simulation snapshot.
  //
  //  ══════════════════════════════════════════════════════════════════
  //  🔒 RESTRICTED — DO NOT CHANGE (Core stability):
  //    JS STATE: this._aiSessionId, this._aiContext, this._aiInsightLoaded
  //    DOM IDs:  #wkp-ai-insight-body, #wkp-ai-messages, #wkp-ai-input, 
  //              #wkp-ai-send, #wkp-ai-status
  //    CSS VARS: --ok, --warn, --err, --brand-500, --slate-*, --mono, --font-display
  //
  //  ⚠️ DESIGN SYSTEM RULES:
  //    - Table rows: use .wkp-row-even/.wkp-row-odd and .wkp-row-priority-glow
  //    - Qty Cells: must use .wkp-qty-primary, .wkp-qty-uom, .wkp-qty-secondary
  //    - Buttons: use .wkp-btn and .wkp-btn-brand for primary actions
  //
  //  🤖 PROMPT RULES (Server-side & Client-side logic):
  //    - No preamble ("Based on...", "Here is...")
  //    - Exactly 3 action steps, one verb phrase each.
  //    - Summary: 1-2 sentences max.
  //    - Tables: max 4 cols, max 6 rows.
  //    - Always include (item_code) in parentheses when mentioning items.
  //  ══════════════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────────────────

  _getOrCreateAISession() {
    const key = "wkp_ai_session";
    let id = sessionStorage.getItem(key);
    if (!id) {
      // Generate UUID-like session ID
      id = "wkp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(key, id);
    }
    return id;
  }

  _initAIPanel() {
    // ── Model selector: load available models from server ──────────────────
    // Calls get_available_ai_models() which returns DEEPSEEK_MODELS config.
    // Each model entry: {id, name, description, est_cost_per_call}
    // The selector value is stored in this._aiModel for use in all API calls.
    // Default = first model (deepseek-chat, V3 Standard — fast and cheap).
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_available_ai_models",
      args: {},
      callback: r => {
        const models = (r && r.message) || [];
        const sel = document.getElementById("wkp-ai-model-select");
        if (sel && models.length) {
          sel.innerHTML = models.map(m =>
            `<option value="${_esc(m.id)}" title="${_esc(m.description)}">`
            + `${_esc(m.name)} (~$${m.est_cost_per_call.toFixed(3)}/chat)`
            + `</option>`
          ).join("");
          this._aiModel = models[0].id;
          sel.addEventListener("change", () => { this._aiModel = sel.value; });
        }
        const costEl = document.getElementById("wkp-ai-cost-hint");
        if (costEl && models.length) {
          const updateCost = () => {
            const m = models.find(x => x.id === this._aiModel);
            if (m) costEl.textContent =
              "Model: " + m.name + " \u00b7 Est. ~$" + m.est_cost_per_call.toFixed(3) + " per message";
          };
          updateCost();
          if (sel) sel.addEventListener("change", updateCost);
        }
      },
    });

    // ── Quick-question chips ───────────────────────────────────────────────
    // Each question is phrased to trigger a specific AI function call:
    //   "ready to start"   → get_ready_to_produce
    //   "blocked"          → get_blocked_work_orders
    //   "overdue"          → get_overdue_customer_orders
    //   "fulfil all"       → get_fulfillment_outlook
    //   "buy"/"shortage"   → get_top_shortage_items
    //   specific WO name   → get_wo_shortage_detail
    //   item/dispatch      → get_dispatch_detail
    const quickBtns = document.getElementById("wkp-ai-quick-btns");
    if (quickBtns) {
      const questions = [
        "Which Work Orders can start TODAY? List item names and ready quantities.",
        "What is blocking the most urgent WOs? Name the top 3 blockers and fix each.",
        "Which customer orders are overdue? Show days late and order value at risk.",
        "Give me a procurement action list: item name, gap quantity, urgency tier.",
        "Which WO has the biggest shortage value? Should I split or delay it?",
        "Which Work Orders should I release first to clear the most customer backlog?",
        "What will we FAIL to ship this month if we do nothing right now?",
        "Give me a 3-point action plan I can execute in the next 8 hours.",
      ];
      quickBtns.innerHTML = questions.map(q =>
        `<button class="wkp-ai-quick-btn" data-q="${_esc(q)}">${_esc(q)}</button>`
      ).join("");

      quickBtns.addEventListener("click", e => {
        const btn = e.target.closest(".wkp-ai-quick-btn");
        if (btn) this._sendAIMessage(btn.dataset.q);
      });
    }

    // Set textarea placeholder via JS (avoids single-quote risk in HTML)
    const inp = document.getElementById("wkp-ai-input");
    if (inp) {
      inp.placeholder = "Ask about your production plan... e.g. Which WOs can I start today?";
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter" && e.ctrlKey) {
          e.preventDefault();
          this._sendAIMessage(inp.value.trim());
        }
      });
    }

    const sendBtn = document.getElementById("wkp-ai-send");
    if (sendBtn) {
      sendBtn.addEventListener("click", () => {
        const inp2 = document.getElementById("wkp-ai-input");
        if (inp2) this._sendAIMessage(inp2.value.trim());
      });
    }

    const clearBtn = document.getElementById("wkp-ai-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const msgs = document.getElementById("wkp-ai-messages");
        if (msgs) msgs.innerHTML = "";
        // Generate a new session ID so server-side history is abandoned
        const newId = "wkp-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem("wkp_ai_session", newId);
        this._aiSessionId = newId;
      });
    }

    // Decision Dashboard button
    const dashBtn = document.getElementById("wkp-ai-dashboard-btn");
    if (dashBtn) {
      dashBtn.addEventListener("click", () => this._generateDecisionDashboard());
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  AI DECISION DASHBOARD
  //
  //  Feeds all current simulation data to the AI and requests a
  //  structured HTML management report covering:
  //    - Production priorities (which WOs to release today)
  //    - Critical Work Orders (blocked, overdue, high-SO-pressure)
  //    - Procurement needs (top shortage items to buy)
  //    - Dispatch bottlenecks (items that won't meet customer commitments)
  //    - Recommended actions (numbered, actionable steps)
  //
  //  Output is rendered in a new modal window for easy reading/printing.
  //  The AI is prompted to return full HTML (headings, tables, badges).
  //
  // ─────────────────────────────────────────────────────────────────────
  _generateDecisionDashboard() {
    if (this._aiTyping) {
      frappe.show_alert({ message: "AI is busy. Please wait.", indicator: "orange" });
      return;
    }
    if (!this._aiContext) {
      frappe.show_alert({ message: "Simulation data not yet loaded. Refresh first.", indicator: "orange" });
      return;
    }

    // Show busy state
    const dashBtn = document.getElementById("wkp-ai-dashboard-btn");
    if (dashBtn) {
      dashBtn.disabled = true;
      dashBtn.textContent = "\u23F3 Generating\u2026";
    }

    const dashPrompt = [
      "Generate a DECISION DASHBOARD for a production manager. Use structured HTML output.",
      "Based on the current simulation data, provide ALL of the following sections:",
      "",
      "1. PRODUCTION PRIORITIES (table: Work Order | Item | Qty Remaining | Kit Status | SO Pressure | Action)",
      "   - List top 5-8 WOs to release or push hardest today",
      "   - Use is_emergency, curr_month_so, kit_status to prioritise",
      "",
      "2. CRITICAL WORK ORDERS (table: WO | Item | Issue | Recommended Fix)",
      "   - WOs that are Blocked or have high SO pressure but are Partial/Blocked",
      "",
      "3. PROCUREMENT NEEDS (table: Material | Shortage Qty | Est. Value | Affected WOs | Action)",
      "   - Top 5 materials to purchase urgently",
      "",
      "4. DISPATCH BOTTLENECKS (table: Item | Customer Orders | Coverage | Gap | Risk)",
      "   - Items where coverage < demand (gap > 0)",
      "",
      "5. RECOMMENDED ACTIONS (numbered list, 5-7 items, each one specific and actionable)",
      "   - Reference actual WO names and item codes from the data",
      "",
      "Format rules:",
      "- Use <h3> for section headings with a colored badge (green/amber/red based on urgency)",
      "- Use <table> with compact headers for all tables",
      "- Use inline color badges: <span style='color:red'>BLOCKED</span> etc.",
      "- No preamble. Start directly with section 1.",
      "- End with a one-sentence OVERALL STATUS summary.",
    ].join("\n");

    // Switch to AI tab to show the response
    if (this._activeTab !== "ai-chat") this._switchTab("ai-chat");
    this._appendChatBubble("user", "\uD83D\uDCCA Generate Decision Dashboard", false);
    this._setAITyping(true);

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.chat_with_planner",
      args: {
        message     : dashPrompt,
        session_id  : this._aiSessionId,
        context_json: JSON.stringify(this._aiContext),
        model       : this._aiModel || null,
      },
      callback: r => {
        this._setAITyping(false);
        if (dashBtn) {
          dashBtn.disabled = false;
          dashBtn.textContent = "\uD83D\uDCCA Generate Dashboard";
        }
        const data  = r.message || {};
        const reply = data.reply || "<span class=\"wkp-ai-warn\">No dashboard returned.</span>";
        this._appendChatBubble("ai", reply, !!(data.is_html), data.tools_used || []);
      },
      error: () => {
        this._setAITyping(false);
        if (dashBtn) {
          dashBtn.disabled = false;
          dashBtn.textContent = "\uD83D\uDCCA Generate Dashboard";
        }
        this._appendChatBubble("ai",
          "<span class=\"wkp-ai-err\">Dashboard generation failed. Check server logs.</span>",
          true, []
        );
      },
    });
  }

  _compressContextAndFetchInsight() {
    // Called after every simulate() — sends full simulation data to server,
    // gets back compressed context for AI + auto-insight content.
    if (!this.rows.length) return;

    const insightBody = document.getElementById("wkp-ai-insight-body");
    if (insightBody) {
      insightBody.innerHTML =
        `<div class="wkp-ai-loading-row">
           <div class="wkp-ai-dots"></div>
           <span>Generating production briefing\u2026</span>
         </div>`;
    }

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.compress_context_for_ai",
      args: {
        simulation_rows_json: JSON.stringify(this.rows),
        dispatch_json        : JSON.stringify(this._dispatchData || {}),
        stock_mode           : this.stockMode,
        calc_mode            : this.calcMode,
      },
      callback: r => {
        if (r.exc || !r.message) {
          if (insightBody) insightBody.innerHTML =
            `<span class="wkp-ai-warn">Could not prepare AI context. Check server logs.</span>`;
          return;
        }
        this._aiContext = r.message;
        this._fetchAutoInsight();
      },
    });
  }

  _fetchAutoInsight() {
    if (this._aiInsightLoaded || !this._aiContext) return;

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_ai_auto_insight",
      args: {
        context_json: JSON.stringify(this._aiContext),
        model       : this._aiModel || null,
      },
      callback: r => {
        this._aiInsightLoaded = true;
        const insightBody = document.getElementById("wkp-ai-insight-body");
        if (!insightBody) return;
        const data = r.message || {};
        const text = data.insight || "<span class=\"wkp-ai-warn\">No insight returned.</span>";
        insightBody.innerHTML = data.is_html ? _sanitizeAIHtml(text) : _esc(text);
        // Show data points indicator under the insight
        this._updateAIDataPointsBadge();
      },
      error: () => {
        this._aiInsightLoaded = true;
        const insightBody = document.getElementById("wkp-ai-insight-body");
        if (insightBody) insightBody.innerHTML =
          `<span class="wkp-ai-warn">AI briefing failed. Verify API key and connectivity.</span>`;
      },
    });
  }

  _updateAIDataPointsBadge() {
    // Show a compact "Data fed to AI" indicator near the insight panel
    const ctx = this._aiContext;
    if (!ctx || !ctx.data_points) return;
    const dp  = ctx.data_points;
    const el  = document.getElementById("wkp-ai-data-points");
    if (!el) return;
    const parts = [
      dp.wos             ? dp.wos + " WOs"              : "",
      dp.shortage_items  ? dp.shortage_items + " materials short" : "",
      dp.dispatch_items  ? dp.dispatch_items + " dispatch items"  : "",
    ].filter(Boolean).join(" \u00b7 ");
    el.textContent = parts ? "\uD83D\uDCC1 Data fed to AI: " + parts : "";
    el.style.display = parts ? "" : "none";
  }

  _sendAIMessage(text) {
    if (!text || this._aiTyping) return;

    // Clear input
    const inp = document.getElementById("wkp-ai-input");
    if (inp) inp.value = "";

    // Switch to AI tab if not already there
    if (this._activeTab !== "ai-chat") this._switchTab("ai-chat");

    // Append user bubble
    this._appendChatBubble("user", text, false);

    // Show typing indicator
    this._setAITyping(true);

    // Ensure context is ready; if not, send minimal placeholder
    const ctx = this._aiContext || {
      summary: { note: "Simulation data still loading. Please refresh and try again." },
    };

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.chat_with_planner",
      args: {
        message     : text,
        session_id  : this._aiSessionId,
        context_json: JSON.stringify(ctx),
        model       : this._aiModel || null,
      },
      callback: r => {
        this._setAITyping(false);
        const data      = r.message || {};
        const reply     = data.reply || "<span class=\"wkp-ai-warn\">No response from AI.</span>";
        const toolsUsed = data.tools_used || [];
        this._appendChatBubble("ai", reply, !!(data.is_html), toolsUsed);
      },
      error: () => {
        this._setAITyping(false);
        this._appendChatBubble("ai",
          "<span class=\"wkp-ai-err\">Request failed. Check server logs or API key.</span>",
          true, []
        );
      },
    });
  }

  _appendChatBubble(role, content, isHtml, toolsUsed) {
    const msgs = document.getElementById("wkp-ai-messages");
    if (!msgs) return;

    const div = document.createElement("div");
    div.className = role === "user" ? "wkp-msg-user" : "wkp-msg-ai";

    if (role === "ai") {
      // Build tool-call badge — shows which data the AI looked up
      const TOOL_LABELS = {
        "get_wo_shortage_detail"      : "\uD83D\uDD0D WO shortage",
        "get_dispatch_detail"         : "\uD83D\uDE9A Dispatch",
        "get_top_shortage_items"      : "\uD83D\uDCCB Top shortages",
        "get_ready_to_produce"        : "\u2705 Ready WOs",
        "get_blocked_work_orders"     : "\u26D4 Blocked WOs",
        "get_fulfillment_outlook"     : "\uD83D\uDCC5 Fulfilment",
        "get_overdue_customer_orders" : "\u26A0 Overdue orders",
      };
      let toolsBadge = "";
      if (toolsUsed && toolsUsed.length) {
        const labels = toolsUsed.map(t => TOOL_LABELS[t] || t).join(" \u00b7 ");
        toolsBadge = `<div class="wkp-ai-tools-badge">\uD83D\uDD27 Checked live data: ${_esc(labels)}</div>`;
      }

      div.innerHTML = `
        <div class="wkp-msg-avatar">&#x1F916;</div>
        <div class="wkp-msg-bubble wkp-msg-bubble-ai">
          ${isHtml ? _sanitizeAIHtml(content) : _escHtml(content)}
          ${toolsBadge}
        </div>`;
    } else {
      div.innerHTML = `
        <div class="wkp-msg-bubble wkp-msg-bubble-user">${_escHtml(content)}</div>`;
    }

    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  _setAITyping(on) {
    this._aiTyping = on;
    const statusEl = document.getElementById("wkp-ai-status");
    if (statusEl) statusEl.style.display = on ? "flex" : "none";
    const sendBtn = document.getElementById("wkp-ai-send");
    if (sendBtn) {
      sendBtn.disabled   = on;
      sendBtn.textContent = on ? "Thinking\u2026" : "\u27A4 Send";
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  ITEM VIEW TAB (§10 — session 9)
  //
  //  PURPOSE: FG-wise summary of all items with active WOs or pending SOs.
  //  Unlike the WO Kitting Plan tab (one row per WO), this tab groups by
  //  item_code so the user can see totals across all WOs for the same item.
  //
  //  Data source: get_item_wo_summary() (server) — independent DB query.
  //  This tab also merges kit_status summary from this.rows (client-side)
  //  to show how many WOs are ok/partial/blocked per item.
  //
  //  Columns:
  //    Item Name + Code + Group
  //    Stock UOM | Secondary UOM | UOM list (for cost selector)
  //    WO Count | WO list (expandable)
  //    Planned Qty | Produced Qty | Remaining Qty (all dual UOM)
  //    Consumed Qty | Consumed Cost (from Stock Entry Manufacture)
  //    SO Count | SO Pending Qty
  //    Last Cost/Unit (from last completed WO) + UOM selector
  //    Kit Status Summary (ok/partial/blocked WO counts)
  //
  //  Restrictions:
  //    this._itemViewData / this._itemViewLoaded / this._itemViewLoading
  //    _fetchItemView() / _renderItemView() — called by _switchTab
  //    #wkp-iv-body — JS target for innerHTML injection
  //    #wkp-iv-loading — spinner shown while API in-flight
  // ─────────────────────────────────────────────────────────────────────

  _fetchItemView() {
    this._itemViewLoading = true;
    const loadEl = document.getElementById("wkp-iv-loading");
    if (loadEl) loadEl.style.display = "flex";

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_item_wo_summary",
      args: {},
      callback: r => {
        this._itemViewLoading = false;
        this._itemViewLoaded  = true;
        this._itemViewData    = r.message || [];
        if (loadEl) loadEl.style.display = "none";
        if (this._activeTab === "item-view") this._renderItemView();
      },
      error: () => {
        this._itemViewLoading = false;
        this._itemViewLoaded  = true;
        if (loadEl) loadEl.style.display = "none";
        const body = document.getElementById("wkp-iv-body");
        if (body) body.innerHTML =
          `<div class="wkp-reco wkp-reco-err" style="margin:16px">
             <div class="wkp-reco-icon">\u26A0\uFE0F</div>
             <div class="wkp-reco-body">
               <div class="wkp-reco-headline">Failed to load Item View data.</div>
               <div class="wkp-reco-detail">Check the browser console and server logs. Try refreshing.</div>
             </div>
           </div>`;
      },
    });
  }

  _renderItemView() {
    const body = document.getElementById("wkp-iv-body");
    if (!body) return;

    const items = this._itemViewData || [];

    if (!items.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No active Work Orders or Sales Orders found.</div>
          <div class="wkp-reco-detail">Create Work Orders or Sales Orders to see data here.</div>
        </div>
      </div>`;
      return;
    }

    // Build kit_status summary from simulation rows (client-side merge)
    const kitByItem = {};
    (this.rows || []).forEach(row => {
      const ic = row.item_code;
      if (!kitByItem[ic]) kitByItem[ic] = { ok: 0, partial: 0, block: 0, kitted: 0 };
      kitByItem[ic][row.kit_status] = (kitByItem[ic][row.kit_status] || 0) + 1;
    });

    // Build table
    const rows = items.map(item => {
      const kit    = kitByItem[item.item_code] || {};
      const sf     = item.secondary_factor || 1;
      const secUom = item.secondary_uom || "";

      // Dual UOM helper for table cells
      const dualCell = (qty, uom, secUom2, sf2) => {
        if (!qty && qty !== 0) return "\u2014";
        const prim = `<strong>${_fmt_num(qty, 0)}</strong>
          <div style="font-size:10px;color:var(--stone-400)">${_esc(uom)}</div>`;
        const sec2 = secUom2
          ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(qty / (sf2 || 1), 2)}\u00a0${_esc(secUom2)}</div>`
          : "";
        return prim + sec2;
      };

      // Kit status badge cluster
      let kitBadges = "";
      if (kit.ok)      kitBadges += `<span class="wkp-iv-kit-chip wkp-iv-kit-ok">\u2714 ${kit.ok} Ready</span>`;
      if (kit.partial) kitBadges += `<span class="wkp-iv-kit-chip wkp-iv-kit-warn">\u26A0 ${kit.partial} Partial</span>`;
      if (kit.block)   kitBadges += `<span class="wkp-iv-kit-chip wkp-iv-kit-block">\u26D4 ${kit.block} Blocked</span>`;
      if (kit.kitted)  kitBadges += `<span class="wkp-iv-kit-chip wkp-iv-kit-kitted">\u2713 ${kit.kitted} Kitted</span>`;
      if (!kitBadges)  kitBadges  = `<span class="wkp-iv-kit-chip wkp-iv-kit-none">\u2014 No WOs</span>`;

      // Last Cost/Unit — auto-show all UOM costs stacked (no manual dropdown needed)
      // Primary cost is per stock_uom; secondary cost derived from secondary_factor.
      // Additional UOMs from item_uoms are also stacked automatically.
      const baseCost = item.last_cost_per_unit || 0;

      // Build stacked UOM cost lines: stock UOM first, then secondary, then others
      let stackedCosts = "";
      if (baseCost) {
        stackedCosts += `<div style="font-size:10px;font-weight:600;color:var(--slate-700)">`
          + `\u20B9${_fmt_num(baseCost, 2)} / ${_esc(item.stock_uom)}</div>`;
        if (secUom && sf > 1) {
          const secCost = baseCost * sf;
          stackedCosts += `<div style="font-size:10px;color:var(--slate-500)">`
            + `\u20B9${_fmt_num(secCost, 2)} / ${_esc(secUom)}</div>`;
        }
        // Additional UOMs from item_uoms (excluding stock_uom and already-shown secondary)
        const uoms = (item.item_uoms || []).filter(u =>
          u.factor > 0 && u.uom !== item.stock_uom && u.uom !== secUom
        );
        uoms.forEach(u => {
          const uomCost = baseCost * u.factor;
          stackedCosts += `<div style="font-size:10px;color:var(--slate-400)">`
            + `\u20B9${_fmt_num(uomCost, 2)} / ${_esc(u.uom)}</div>`;
        });
      }

      // WO list as comma-separated links
      const woLinks = (item.wo_list || []).slice(0, 5).map(wo =>
        `<a href="/app/work-order/${_esc(wo)}" target="_blank" class="wkp-wo-link"
            style="font-size:10px;display:block">${_esc(wo)}</a>`
      ).join("");
      const woLinksExtra = (item.wo_list || []).length > 5
        ? `<span style="font-size:10px;color:var(--stone-400)">+${item.wo_list.length - 5} more</span>`
        : "";

      return `
<tr class="wkp-iv-tr" data-item="${_esc(item.item_code)}">
  <td>
    <div class="wkp-item-name">${_esc(item.item_name || item.item_code)}</div>
    <div class="wkp-item-code">${_esc(item.item_code)}</div>
    ${item.item_group ? `<div class="wkp-item-group-tag">${_esc(item.item_group)}</div>` : ""}
  </td>
  <td class="ta-c">
    <div style="font-size:12px;font-weight:600">${item.wo_count || 0}</div>
    <div style="margin-top:2px">${woLinks}${woLinksExtra}</div>
  </td>
  <td class="ta-c">${kitBadges}</td>
  <td class="ta-r">${dualCell(item.planned_qty,   item.stock_uom, secUom, sf)}</td>
  <td class="ta-r">${dualCell(item.produced_qty,  item.stock_uom, secUom, sf)}</td>
  <td class="ta-r">${dualCell(item.remaining_qty, item.stock_uom, secUom, sf)}</td>
  <td class="ta-r">
    ${item.consumed_qty
      ? `<strong>${_fmt_num(item.consumed_qty, 0)}</strong>
         <div style="font-size:10px;color:var(--stone-400)">${_esc(item.stock_uom)}</div>
         ${item.consumed_cost ? `<div style="font-size:10px;color:var(--stone-500)">\u20B9${_fmt_num(item.consumed_cost, 0)}</div>` : ""}`
      : `<span style="color:var(--stone-400)">\u2014</span>`}
  </td>
  <td class="ta-r">
    ${item.so_count
      ? `<div style="font-weight:600;color:var(--amber-700)">${_fmt_num(item.so_pending_qty, 0)}</div>
         <div style="font-size:10px;color:var(--stone-400)">${item.so_count} SO${item.so_count !== 1 ? "s" : ""}</div>
         ${secUom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(item.so_pending_qty / sf, 2)}\u00a0${_esc(secUom)}</div>` : ""}`
      : `<span style="color:var(--stone-400)">\u2014</span>`}
  </td>
  <td class="ta-r"
      data-tip="Last Cost/Unit: cost per unit from the most recently completed Work Order.&#10;Source: Stock Entry (Manufacture) \u2192 actual_cost / produced_qty.&#10;All UOM costs are auto-calculated from the stock UOM rate.">
    ${stackedCosts || `<span style="color:var(--slate-400)">\u2014</span>`}
    ${item.last_cost_date ? `<div style="font-size:10px;color:var(--slate-400);margin-top:3px">${_esc(item.last_cost_date)}</div>` : ""}
    ${item.last_cost_wo ? `<a href="/app/work-order/${_esc(item.last_cost_wo)}" target="_blank"
                             class="wkp-wo-link" style="font-size:10px">${_esc(item.last_cost_wo)}</a>` : ""}
  </td>
  <td>
    <div style="font-size:11px;color:var(--slate-600)">
      ${_esc(item.stock_uom)}${secUom ? ` / ${_esc(secUom)} (\xD71\u00f7${sf})` : ""}
    </div>
    ${(item.item_uoms || []).filter(u => u.factor > 0 && u.uom !== item.stock_uom).map(u =>
      `<div style="font-size:10px;color:var(--slate-400)">${_esc(u.uom)} \u00d7${u.factor}</div>`
    ).join("")}
  </td>
</tr>`;
    }).join("");

    body.innerHTML = `
<div class="wkp-iv-table-wrap">
  <table class="wkp-iv-table">
    <thead>
      <tr>
        <th>Item</th>
        <th class="ta-c">WO Count</th>
        <th class="ta-c">Kit Status</th>
        <th class="ta-r">Planned Qty</th>
        <th class="ta-r">Produced Qty</th>
        <th class="ta-r">Remaining Qty</th>
        <th class="ta-r">Consumed (SE)</th>
        <th class="ta-r">SO Demand</th>
        <th class="ta-r">Last Cost / Unit</th>
        <th>UOM Details</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

    // Bind UOM selects for live cost recalculation
    body.querySelectorAll(".wkp-iv-uom-sel").forEach(sel => {
      sel.addEventListener("change", () => {
        const ic       = sel.dataset.item;
        const baseCost = parseFloat(sel.dataset.baseCost || "0");
        const opt      = sel.options[sel.selectedIndex];
        const factor   = parseFloat(opt ? opt.dataset.factor || "1" : "1");
        const newCost  = factor > 0 ? baseCost * factor : 0;
        const valEl    = body.querySelector(`.wkp-iv-cost-val[data-item="${ic}"]`);
        if (valEl) valEl.textContent = newCost > 0 ? `\u20B9${_fmt_num(newCost, 2)}` : "\u2014";
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  PURCHASE PRIORITY TAB  (§11)
  //
  //  Lazy-loaded on first tab click. Calls get_purchase_priority() which
  //  does a two-level BOM walk:
  //    Level 1: BOM components of open WOs for FG items with open SOs.
  //    Level 2: BOM components of open SFG WOs whose output is a Level-1 component.
  //
  //  WKP-032 RESTRICTED:
  //    _ppData, _ppLoaded, _ppLoading must match the _switchTab trigger
  //    above and the reset in simulate(). Do NOT reset _ppLoaded on every
  //    simulation — only when stockMode changes (same as dispatch).
  //    #wkp-pp-table (id) is the selector used in tabBodyMap for global search.
  //    .wkp-pp-chk checkboxes are bound after render — do NOT bind in constructor.
  //    MR creation reuses _openMRQtyDialog() + create_purchase_mr_for_wo_shortages.
  // ─────────────────────────────────────────────────────────────────────

  _fetchPurchasePriority() {
    this._ppLoading = true;
    const loadEl  = document.getElementById("wkp-pp-loading");
    const bodyEl  = document.getElementById("wkp-pp-body");
    if (loadEl) loadEl.style.display = "flex";
    if (bodyEl) bodyEl.innerHTML = "";

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_purchase_priority",
      callback: r => {
        this._ppLoading = false;
        if (loadEl) loadEl.style.display = "none";
        if (r.exc) {
          frappe.show_alert({ message: "Failed to load Purchase Priority.", indicator: "red" });
          return;
        }
        this._ppData   = r.message || [];
        this._ppLoaded = true;
        this._renderPurchasePriority(this._ppData);
      },
    });
  }

  _renderPurchasePriority(data) {
    const bodyEl     = document.getElementById("wkp-pp-body");
    const mrBtn      = document.getElementById("wkp-pp-mr-btn");
    const mrSelBtn   = document.getElementById("wkp-pp-mr-sel-btn");
    if (!bodyEl) return;

    if (!data || !data.length) {
      bodyEl.innerHTML = `<div class="wkp-pp-empty">
        <i class="fa-solid fa-circle-check" style="font-size:32px;color:var(--ok);margin-bottom:8px"></i>
        <div style="font-weight:700;color:var(--slate-700)">No purchase gaps found</div>
        <div style="color:var(--slate-500);font-size:12px;margin-top:4px">
          All materials needed for Sales Order-backed Work Orders are covered by stock, POs, or MRs.
        </div>
      </div>`;
      if (mrBtn)    mrBtn.style.display    = "none";
      if (mrSelBtn) mrSelBtn.style.display = "none";
      return;
    }

    // ── Dual-UOM stacked helper ──────────────────────────────────────────
    const _dualPP = (qty, uom, secFactor, secUom) => {
      const primary = `<div class="wkp-qty-primary">${_fmt_num(qty, 2)}</div><div class="wkp-qty-uom">${_esc(uom || "")}</div>`;
      if (secUom && secFactor > 1) {
        return primary + `<div class="wkp-qty-secondary">${_fmt_num(qty / secFactor, 2)}\u00a0${_esc(secUom)}</div>`;
      }
      return primary;
    };

    // ── Urgency badge HTML ───────────────────────────────────────────────
    const _urgBadge = (item) => {
      const map = {
        overdue   : ["wkp-pp-overdue",    "fa-circle-exclamation", "Overdue"],
        this_week : ["wkp-pp-this-week",  "fa-clock",              "This Week"],
        this_month: ["wkp-pp-this-month", "fa-calendar",           "This Month"],
        future    : ["wkp-pp-future",     "fa-hourglass-half",     "Future"],
      };
      const [cls, icon, label] = map[item.urgency] || map.future;
      return `<span class="wkp-pp-badge ${cls}"><i class="fa-solid ${icon}"></i> ${label}</span>`;
    };

    const COL_SPAN = 14;  // checkbox + material + group + urgency + date + 5 qty + MOQ + LT + WOs + SOs

    const hasNetGap = data.some(d => d.net_gap > 0);

    const rowsHtml = data.map((item, idx) => {
      const netCls = item.net_gap > 0 ? "wkp-cell-red" : "wkp-cell-green";
      const netTxt = item.net_gap > 0
        ? _dualPP(item.net_gap, item.uom, item.secondary_factor, item.secondary_uom)
        : "<i class='fa-solid fa-check' style='color:var(--ok)'></i> Covered";

      const detailId = "wkp-pp-d-" + item.item_code.replace(/[^a-zA-Z0-9]/g, "_");

      const levelBadge = item.level === "indirect"
        ? `<span class="wkp-pp-level-badge" title="Component of a sub-assembly WO">SFG</span>`
        : "";

      // WO details in expand row
      const woRows = (item.wo_list || []).map(w =>
        `<tr>
          <td style="padding:3px 10px;font-family:monospace;font-size:11px">${_esc(w.wo_name)}</td>
          <td style="padding:3px 10px;font-size:11px">${_esc(w.fg_item_name || w.fg_item)}</td>
          <td style="padding:3px 10px;text-align:right;font-size:11px">${_fmt_num(w.required_qty, 2)}\u00a0${_esc(item.uom)}</td>
        </tr>`
      ).join("");

      const soRows = (item.so_list || []).map(s => {
        const overdue = s.delivery_date && s.delivery_date < new Date().toISOString().slice(0, 10);
        return `<tr>
          <td style="padding:3px 10px;font-family:monospace;font-size:11px">${_esc(s.so_name)}</td>
          <td style="padding:3px 10px;font-size:11px">${_esc(s.customer_name)}</td>
          <td style="padding:3px 10px;font-size:11px;${overdue ? "color:var(--err);font-weight:700" : ""}">${_esc(s.delivery_date) || "&mdash;"}</td>
        </tr>`;
      }).join("");

      return `<tr data-item="${_esc(item.item_code)}" data-idx="${idx}" data-group="${_esc(item.item_group)}">
  <td class="ta-c wkp-sr-chk-cell"><input type="checkbox" class="wkp-pp-chk" data-item="${_esc(item.item_code)}" data-idx="${idx}"></td>
  <td>
    <button class="wkp-sr-item-btn" data-item="${_esc(item.item_code)}"
            style="font-weight:600;background:none;border:none;cursor:pointer;color:var(--brand-600);padding:0;text-align:left"
            title="Click to see open POs, MRs, and stock batches for this material">
      ${_esc(item.item_code)}
    </button>
    <div style="font-size:11px;color:var(--slate-500)">${_esc(item.item_name)}</div>
    ${levelBadge}
  </td>
  <td style="font-size:11px;color:var(--slate-500)">${_esc(item.item_group)}</td>
  <td>${_urgBadge(item)}</td>
  <td style="font-size:11px;white-space:nowrap">${_esc(item.earliest_delivery) || "&mdash;"}</td>
  <td class="ta-r">${_dualPP(item.required_qty, item.uom, item.secondary_factor, item.secondary_uom)}</td>
  <td class="ta-r">${_dualPP(item.in_stock, item.uom, item.secondary_factor, item.secondary_uom)}</td>
  <td class="ta-r">${_dualPP(item.open_po_qty, item.uom, item.secondary_factor, item.secondary_uom)}</td>
  <td class="ta-r">${_dualPP(item.open_mr_qty, item.uom, item.secondary_factor, item.secondary_uom)}</td>
  <td class="ta-r ${netCls}">${netTxt}</td>
  <td class="ta-r" style="font-size:11px">${item.moq > 0 ? _fmt_num(item.moq, 0) + "\u00a0" + _esc(item.uom) : "&mdash;"}</td>
  <td class="ta-r" style="font-size:11px">${item.lead_time_days > 0 ? item.lead_time_days + " d" : "&mdash;"}</td>
  <td class="ta-c">
    ${item.wo_count > 0
      ? `<button class="wkp-btn wkp-btn-sm"
           onclick="var r=document.getElementById('${detailId}');if(r){r.style.display=r.style.display===''?'none':'';this.textContent=r.style.display===''?'\u25B2 Hide':'\u25BC Details'}"
           title="Show linked Work Orders and Sales Orders">\u25BC Details</button>`
      : "\u2014"}
  </td>
</tr>
<tr class="wkp-sr-detail-row" id="${detailId}" style="display:none">
  <td colspan="${COL_SPAN}" style="padding:4px 0 4px 48px;background:var(--slate-50);border-bottom:2px solid var(--slate-200)">
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      ${woRows ? `<div>
        <div style="font-size:11px;font-weight:700;color:var(--slate-600);margin-bottom:4px">Work Orders</div>
        <table style="border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--slate-100)">
            <th style="padding:3px 10px;text-align:left;font-weight:600">WO</th>
            <th style="padding:3px 10px;text-align:left;font-weight:600">FG Item</th>
            <th style="padding:3px 10px;text-align:right;font-weight:600">Required</th>
          </tr></thead>
          <tbody>${woRows}</tbody>
        </table>
      </div>` : ""}
      ${soRows ? `<div>
        <div style="font-size:11px;font-weight:700;color:var(--slate-600);margin-bottom:4px">Linked Sales Orders</div>
        <table style="border-collapse:collapse;font-size:12px">
          <thead><tr style="background:var(--slate-100)">
            <th style="padding:3px 10px;text-align:left;font-weight:600">SO</th>
            <th style="padding:3px 10px;text-align:left;font-weight:600">Customer</th>
            <th style="padding:3px 10px;text-align:left;font-weight:600">Delivery Date</th>
          </tr></thead>
          <tbody>${soRows}</tbody>
        </table>
      </div>` : ""}
    </div>
  </td>
</tr>`;
    }).join("");

    bodyEl.innerHTML = `
<div style="overflow-x:auto">
<table class="wkp-modal-table wkp-shortage-table" id="wkp-pp-table">
  <thead>
    <tr>
      <th class="ta-c wkp-sr-chk-cell" title="Select all">
        <input type="checkbox" id="wkp-pp-select-all" title="Select all materials">
      </th>
      <th>Material</th>
      <th>Group</th>
      <th>Urgency</th>
      <th>SO Delivery</th>
      <th class="ta-r" title="Total qty needed by all linked Work Orders">Required</th>
      <th class="ta-r" title="Current stock (Bin.actual_qty across all warehouses)">In Stock</th>
      <th class="ta-r" title="Open Purchase Order qty (ordered but not yet received)">Open PO</th>
      <th class="ta-r" title="Open Material Request qty (not yet converted to PO)">Open MR</th>
      <th class="ta-r" title="Net Gap = Required minus Stock minus PO minus MR. This must be ordered urgently.">Net Gap</th>
      <th class="ta-r" title="Minimum Order Qty from supplier">MOQ</th>
      <th class="ta-r" title="Supplier lead time in days">Lead (d)</th>
      <th class="ta-c">Details</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
</div>`;

    // ── Select-all checkbox ───────────────────────────────────────────────
    const selAll = document.getElementById("wkp-pp-select-all");
    if (selAll) {
      selAll.addEventListener("change", () => {
        bodyEl.querySelectorAll(".wkp-pp-chk").forEach(chk => {
          chk.checked = selAll.checked;
        });
        this._updatePPSelectedBtn();
      });
    }
    bodyEl.querySelectorAll(".wkp-pp-chk").forEach(chk => {
      chk.addEventListener("change", () => this._updatePPSelectedBtn());
    });

    // ── Supply pipeline modal (reuses existing _showMaterialSupplyModal) ─
    bodyEl.querySelectorAll(".wkp-sr-item-btn").forEach(btn => {
      btn.addEventListener("click", () => this._showMaterialSupplyModal(btn.dataset.item));
    });

    // ── MR buttons ────────────────────────────────────────────────────────
    if (mrSelBtn) {
      mrSelBtn.style.display = "flex";
      mrSelBtn.disabled = true;
      mrSelBtn.onclick = () => {
        const selected = this._getPPSelectedItems(data);
        if (selected.length) this._openMRQtyDialog(selected, {}, "Create MR for Selected (Purchase Priority)");
      };
    }

    if (mrBtn) {
      mrBtn.style.display = hasNetGap ? "flex" : "none";
      mrBtn.onclick = () => {
        const gapItems = data
          .filter(d => d.net_gap > 0)
          .map(d => ({
            item_code   : d.item_code,
            item_name   : d.item_name,
            uom         : d.uom,
            qty         : d.net_gap,
            moq         : d.moq,
            secondary_uom   : d.secondary_uom,
            secondary_factor: d.secondary_factor,
          }));
        if (gapItems.length) this._openMRQtyDialog(gapItems, {}, "Create MR for All Gaps (Purchase Priority)");
      };
    }

    // ── Item group filter bar ─────────────────────────────────────────────
    // Populated from render data; filters table rows + hides orphaned detail rows.
    const filterBar    = document.getElementById("wkp-pp-filter-bar");
    const filterSelect = document.getElementById("wkp-pp-filter-group");
    const filterCount  = document.getElementById("wkp-pp-filter-count");
    if (filterBar && filterSelect) {
      const groups = [...new Set(data.map(d => d.item_group).filter(Boolean))].sort();
      filterSelect.innerHTML = '<option value="">All Groups</option>' +
        groups.map(g => `<option value="${_esc(g)}">${_esc(g)}</option>`).join("");
      filterBar.style.display = groups.length > 1 ? "flex" : "none";

      const _applyPPFilter = () => {
        const sel = filterSelect.value;
        const tbody = document.querySelector("#wkp-pp-table tbody");
        if (!tbody) return;
        let shown = 0, total = 0;
        tbody.querySelectorAll("tr:not(.wkp-sr-detail-row)").forEach(tr => {
          total++;
          const match = !sel || (tr.dataset.group || "") === sel;
          tr.style.display = match ? "" : "none";
          if (match) shown++;
          if (!match) {
            // Collapse and hide the paired detail/expand row
            const itemCode = tr.dataset.item || "";
            if (itemCode) {
              const dId = "wkp-pp-d-" + itemCode.replace(/[^a-zA-Z0-9]/g, "_");
              const detailTr = document.getElementById(dId);
              if (detailTr) detailTr.style.display = "none";
              const toggleBtn = tr.querySelector("button[onclick]");
              if (toggleBtn) toggleBtn.innerHTML = "\u25BC Details";
            }
          }
        });
        if (filterCount) filterCount.textContent = sel ? `${shown} of ${total}` : "";
      };
      filterSelect.addEventListener("change", _applyPPFilter);
    }
  }

  _updatePPSelectedBtn() {
    const sel = document.querySelectorAll(".wkp-pp-chk:checked");
    const btn = document.getElementById("wkp-pp-mr-sel-btn");
    if (btn) {
      btn.disabled = sel.length === 0;
      btn.textContent = sel.length
        ? `\u2713 Create MR for ${sel.length} Selected`
        : "\u2713 Create MR for Selected";
    }
  }

  _getPPSelectedItems(data) {
    const checked = document.querySelectorAll(".wkp-pp-chk:checked");
    const items = [];
    checked.forEach(chk => {
      const idx = parseInt(chk.dataset.idx, 10);
      const d = data[idx];
      if (d) {
        items.push({
          item_code       : d.item_code,
          item_name       : d.item_name,
          uom             : d.uom,
          qty             : d.net_gap > 0 ? d.net_gap : d.required_qty,
          moq             : d.moq,
          secondary_uom   : d.secondary_uom,
          secondary_factor: d.secondary_factor,
        });
      }
    });
    return items;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  EXPORT  (CSV / PDF)
  // ─────────────────────────────────────────────────────────────────────

  _exportCSV() {
    const tab = this._activeTab;

    if (tab === "item-view" && this._itemViewData && this._itemViewData.length) {
      // Export Item View data
      const headers = [
        "Item Code", "Item Name", "Item Group", "Stock UOM", "Secondary UOM",
        "WO Count", "Planned Qty", "Produced Qty", "Remaining Qty",
        "Consumed Qty", "Consumed Cost (INR)", "SO Count", "SO Pending Qty",
        "Last Cost/Unit (INR)", "Last Cost WO", "Last Cost Date",
      ];
      const csvRows = this._itemViewData.map(d => [
        d.item_code, d.item_name, d.item_group, d.stock_uom, d.secondary_uom,
        d.wo_count, d.planned_qty, d.produced_qty, d.remaining_qty,
        d.consumed_qty, d.consumed_cost, d.so_count, d.so_pending_qty,
        d.last_cost_per_unit, d.last_cost_wo, d.last_cost_date,
      ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","));

      this._downloadCSV("wkp_item_view.csv", [headers.join(","), ...csvRows].join("\n"));
      return;
    }

    if (tab === "wo-plan" && this.rows && this.rows.length) {
      const headers = [
        "Work Order", "Item Code", "Item Name", "UOM", "Planned Qty",
        "Produced Qty", "Remaining Qty", "Kit Status", "Est. Cost (INR)",
        "Last Month SO", "This Month SO", "Total Pending SO", "ERP Status",
      ];
      const csvRows = this.rows.map(r => [
        r.wo, r.item_code, r.item_name, r.uom, r.planned_qty,
        r.produced_qty, r.remaining_qty, r.kit_status, r.est_cost,
        r.prev_month_so, r.curr_month_so, r.total_pending_so, r.status,
      ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","));

      this._downloadCSV("wkp_wo_plan.csv", [headers.join(","), ...csvRows].join("\n"));
      return;
    }

    if (tab === "shortage-report" && this._shortageAggList && this._shortageAggList.length) {
      const headers = [
        "Item Code", "Item Name", "Item Group", "UOM",
        "Total Required", "Total Available", "Total Shortage",
        "Shortage Value (INR)", "PO Qty", "Received Qty", "MR Qty",
        "MOQ", "Lead Time (Days)", "Affected WOs",
      ];
      const csvRows = this._shortageAggList.map(a => [
        a.item_code, a.item_name, a.item_group, a.uom,
        a.total_required, a.total_available, a.total_shortage,
        a.total_value, a.po_qty, a.received_qty, a.mr_qty,
        a.moq, a.lead_time_days,
        (a.wo_list || []).join("; "),
      ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","));

      this._downloadCSV("wkp_shortages.csv", [headers.join(","), ...csvRows].join("\n"));
      return;
    }

    if (tab === "emergency" && this.rows && this.rows.length) {
      const emergRows = this.rows.filter(r =>
        r.is_emergency || r.prev_month_so > 0 || r.curr_month_so > 0
      );
      if (emergRows.length) {
        const headers = [
          "Work Order", "Item Code", "Item Name", "UOM",
          "Planned Qty", "Remaining Qty", "Kit Status",
          "Last Month SO", "This Month SO", "Total Pending SO",
          "Is Emergency", "ERP Status",
        ];
        const csvRows = emergRows.map(r => [
          r.wo, r.item_code, r.item_name, r.uom,
          r.planned_qty, r.remaining_qty, r.kit_status,
          r.prev_month_so, r.curr_month_so, r.total_pending_so,
          r.is_emergency ? "Yes" : "No", r.status,
        ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","));

        this._downloadCSV("wkp_emergencies.csv", [headers.join(","), ...csvRows].join("\n"));
        return;
      }
    }

    if (tab === "dispatch" && this._dispatchData) {
      const dispItems = Object.values(this._dispatchData);
      if (dispItems.length) {
        const headers = [
          "Item Code", "Item Name", "Item Group", "UOM",
          "Customer Orders (Pending)", "FG In Stock", "Will Be Produced",
          "Total Coverage", "Gap", "Status",
          "SO Count", "Overdue SOs", "Pick List", "Reservation",
        ];
        const csvRows = dispItems.map(d => {
          const soListDedup = Object.values(
            (d.so_list || []).reduce((m, s) => {
              if (!m[s.so_name]) m[s.so_name] = Object.assign({}, s);
              else {
                m[s.so_name].pending_qty = (m[s.so_name].pending_qty || 0) + (s.pending_qty || 0);
              }
              return m;
            }, {})
          );
          return [
            d.item_code, d.item_name, d.item_group, d.uom,
            d.total_pending, d.fg_stock, d.will_produce,
            d.total_coverage, d.gap, d.dsp_status,
            soListDedup.length,
            soListDedup.filter(s => s.is_overdue).length,
            d.total_pick_list_count || 0,
            d.total_reserved || 0,
          ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",");
        });

        this._downloadCSV("wkp_dispatch.csv", [headers.join(","), ...csvRows].join("\n"));
        return;
      }
    }

    if (tab === "purchase-priority" && this._ppData && this._ppData.length) {
      const headers = [
        "Item Code", "Item Name", "Item Group", "UOM",
        "Urgency", "Earliest SO Delivery", "Required Qty",
        "In Stock", "Open PO Qty", "Open MR Qty", "Net Gap",
        "MOQ", "Lead Time (Days)", "WO Count", "SO Count", "Level",
      ];
      const csvRows = this._ppData.map(d => [
        d.item_code, d.item_name, d.item_group, d.uom,
        d.urgency, d.earliest_delivery, d.required_qty,
        d.in_stock, d.open_po_qty, d.open_mr_qty, d.net_gap,
        d.moq, d.lead_time_days, d.wo_count, d.so_count, d.level,
      ].map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","));

      this._downloadCSV("wkp_purchase_priority.csv", [headers.join(","), ...csvRows].join("\n"));
      return;
    }

    frappe.show_alert({ message: "No data to export for the current tab.", indicator: "orange" });
  }

  _downloadCSV(filename, csvContent) {
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    frappe.show_alert({ message: "CSV downloaded: " + filename, indicator: "green" });
  }

  _exportPDF() {
    // Build a print-ready HTML page and open it in a new tab for browser print
    const tab   = this._activeTab;
    let content = "";

    if (tab === "item-view" && this._itemViewData && this._itemViewData.length) {
      content = this._buildItemViewPrintHtml(this._itemViewData);
    } else if (tab === "wo-plan" && this.rows && this.rows.length) {
      content = this._buildWOPlanPrintHtml(this.rows);
    } else {
      frappe.show_alert({ message: "No data to export for the current tab.", indicator: "orange" });
      return;
    }

    const win = window.open("", "_blank");
    if (!win) {
      frappe.show_alert({ message: "Pop-up blocked. Allow pop-ups and try again.", indicator: "orange" });
      return;
    }
    win.document.write(content);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 800);
  }

  _buildItemViewPrintHtml(items) {
    const rows = items.map(d => `
<tr>
  <td>${_esc(d.item_code)}</td><td>${_esc(d.item_name)}</td><td>${_esc(d.item_group)}</td>
  <td>${d.wo_count}</td>
  <td style="text-align:right">${_fmt_num(d.planned_qty, 0)}</td>
  <td style="text-align:right">${_fmt_num(d.produced_qty, 0)}</td>
  <td style="text-align:right">${_fmt_num(d.remaining_qty, 0)}</td>
  <td style="text-align:right">${d.so_count || 0}</td>
  <td style="text-align:right">${_fmt_num(d.so_pending_qty, 0)}</td>
  <td style="text-align:right">${d.last_cost_per_unit ? "\u20B9" + _fmt_num(d.last_cost_per_unit, 2) : "\u2014"}</td>
  <td>${_esc(d.stock_uom)}</td>
</tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>WO Kitting Planner &mdash; Item View</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#1c1917;margin:20px}
  h2{font-size:16px;margin:0 0 4px}
  p{font-size:10px;color:#78716c;margin:0 0 12px}
  table{border-collapse:collapse;width:100%}
  th{background:#1c1917;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
  td{padding:5px 8px;border-bottom:1px solid #e7e5e4;vertical-align:top}
  tr:nth-child(even) td{background:#fafaf9}
  @media print{@page{size:landscape;margin:10mm}}
</style></head><body>
<h2>WO Kitting Planner &mdash; FG Item View</h2>
<p>Exported: ${new Date().toLocaleString()}</p>
<table>
<thead><tr>
  <th>Item Code</th><th>Item Name</th><th>Item Group</th><th>WOs</th>
  <th>Planned</th><th>Produced</th><th>Remaining</th>
  <th>SOs</th><th>SO Demand</th><th>Last Cost/Unit</th><th>UOM</th>
</tr></thead><tbody>${rows}</tbody></table>
</body></html>`;
  }

  _buildWOPlanPrintHtml(rows) {
    const trs = rows.map(r => `
<tr>
  <td>${_esc(r.wo)}</td><td>${_esc(r.item_name || r.item_code)}</td>
  <td style="text-align:right">${_fmt_num(r.remaining_qty, 0)}</td>
  <td>${_esc(r.uom)}</td>
  <td>${_esc(r.kit_status)}</td>
  <td style="text-align:right">${r.est_cost ? "\u20B9" + _fmt_num(r.est_cost, 0) : "\u2014"}</td>
  <td style="text-align:right">${r.total_pending_so ? _fmt_num(r.total_pending_so, 0) : "\u2014"}</td>
  <td>${_esc(r.status)}</td>
</tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>WO Kitting Planner &mdash; WO Plan</title>
<style>
  body{font-family:Arial,sans-serif;font-size:11px;color:#1c1917;margin:20px}
  h2{font-size:16px;margin:0 0 4px}
  p{font-size:10px;color:#78716c;margin:0 0 12px}
  table{border-collapse:collapse;width:100%}
  th{background:#1c1917;color:#fff;padding:6px 8px;text-align:left;font-size:10px}
  td{padding:5px 8px;border-bottom:1px solid #e7e5e4;vertical-align:top}
  tr:nth-child(even) td{background:#fafaf9}
  @media print{@page{size:landscape;margin:10mm}}
</style></head><body>
<h2>WO Kitting Planner &mdash; WO Plan</h2>
<p>Exported: ${new Date().toLocaleString()}</p>
<table>
<thead><tr>
  <th>Work Order</th><th>Item</th><th>Remaining Qty</th><th>UOM</th>
  <th>Kit Status</th><th>Est. Cost</th><th>Total Pending SO</th><th>ERP Status</th>
</tr></thead><tbody>${trs}</tbody></table>
</body></html>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  SEND EMAIL
  // ─────────────────────────────────────────────────────────────────────

  _showEmailDialog() {
    const tab = this._activeTab;
    const tabLabels = {
      "wo-plan"        : "WO Kitting Plan",
      "shortage-report": "Material Shortage Report",
      "emergency"      : "Emergency Priorities",
      "dispatch"       : "Dispatch Bottleneck",
      "item-view"      : "FG Item View",
      "ai-chat"        : "AI Advisor",
    };

    const dlg = new frappe.ui.Dialog({
      title  : "Send Dashboard Report by Email",
      fields : [
        {
          label     : "To (comma-separated emails)",
          fieldname : "to_emails",
          fieldtype : "Small Text",
          reqd      : 1,
          description: "e.g. manager@company.com, ceo@company.com",
        },
        {
          label     : "CC (comma-separated, optional)",
          fieldname : "cc_emails",
          fieldtype : "Small Text",
        },
        {
          label     : "Subject",
          fieldname : "subject",
          fieldtype : "Data",
          default   : `WO Kitting Planner \u2014 ${tabLabels[tab] || tab}`,
        },
        {
          label     : "Report to include",
          fieldname : "report_tab",
          fieldtype : "Select",
          options   : [
            "WO Kitting Plan|wo-plan",
            "Material Shortage Report|shortage-report",
            "Emergency Priorities|emergency",
            "Dispatch Bottleneck|dispatch",
            "FG Item View|item-view",
          ].join("\n"),
          default   : tab === "ai-chat" ? "wo-plan" : tab,
        },
        {
          fieldtype: "Section Break",
          label    : "Preview",
        },
        {
          fieldname: "preview_body",
          fieldtype: "HTML",
          options  : `<div style="font-size:12px;color:var(--stone-500);padding:8px 0">
            Email will include a live dashboard link and your name as sender.
            The snapshot table will be generated from current data on Send.
          </div>`,
        },
      ],
      primary_action_label: "Send Email",
      primary_action: vals => {
        if (!vals.to_emails || !vals.to_emails.trim()) {
          frappe.show_alert({ message: "Please enter at least one recipient email.", indicator: "red" });
          return;
        }

        // Map "Label|value" select options back to value
        const reportTab = (vals.report_tab || "").includes("|")
          ? vals.report_tab.split("|")[1]
          : (vals.report_tab || tab);

        const snapshotHtml = this._buildEmailSnapshot(reportTab);

        dlg.hide();

        frappe.call({
          method: "chaizup_toc.api.wo_kitting_api.send_dashboard_email",
          args: {
            to_emails    : vals.to_emails.trim(),
            cc_emails    : (vals.cc_emails || "").trim(),
            subject      : vals.subject || `WO Kitting Planner \u2014 ${tabLabels[reportTab] || reportTab}`,
            snapshot_html: snapshotHtml,
            report_tab   : reportTab,
          },
          callback: r => {
            if (!r.exc) {
              const d = r.message || {};
              frappe.show_alert({
                message  : `Email sent to ${(d.to || []).join(", ")} by ${d.from_name || "you"}`,
                indicator: "green",
              });
            }
          },
        });
      },
    });

    dlg.show();
  }

  _buildEmailSnapshot(tabName) {
    // Build an inline-styled HTML table snapshot for the given tab.
    // This is email-safe: no external CSS, all styles inline.
    const th = (txt) =>
      `<th style="background:#1c1917;color:#fff;padding:7px 10px;text-align:left;
                  font-size:11px;font-weight:600;white-space:nowrap">${txt}</th>`;
    const td = (txt, right) =>
      `<td style="padding:6px 10px;border-bottom:1px solid #e7e5e4;font-size:11px;
                  ${right ? "text-align:right;" : ""}vertical-align:top">${txt}</td>`;
    const tableWrap = (thead, tbodyRows) => {
      if (!tbodyRows.length) return `<p style="color:#78716c;font-size:12px">No data available.</p>`;
      return `<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbodyRows.join("")}</tbody>
      </table>`;
    };

    if (tabName === "item-view" && this._itemViewData && this._itemViewData.length) {
      const thead = [
        th("Item"), th("WOs"), th("Planned"), th("Produced"),
        th("Remaining"), th("SO Demand"), th("Last Cost/Unit"), th("UOM"),
      ].join("");
      const rows = this._itemViewData.slice(0, 25).map(d => {
        return `<tr>
          ${td(`<strong>${_esc(d.item_name || d.item_code)}</strong><br><span style="font-size:10px;color:#78716c">${_esc(d.item_code)}</span>`)}
          ${td(String(d.wo_count || 0))}
          ${td(_fmt_num(d.planned_qty, 0) + " " + _esc(d.stock_uom), true)}
          ${td(_fmt_num(d.produced_qty, 0) + " " + _esc(d.stock_uom), true)}
          ${td(_fmt_num(d.remaining_qty, 0) + " " + _esc(d.stock_uom), true)}
          ${td(d.so_pending_qty ? _fmt_num(d.so_pending_qty, 0) + " (" + d.so_count + " SO" + (d.so_count !== 1 ? "s" : "") + ")" : "\u2014", true)}
          ${td(d.last_cost_per_unit ? "\u20B9" + _fmt_num(d.last_cost_per_unit, 2) + " / " + _esc(d.stock_uom) : "\u2014", true)}
          ${td(_esc(d.stock_uom) + (d.secondary_uom ? " / " + _esc(d.secondary_uom) : ""))}
        </tr>`;
      });
      if (this._itemViewData.length > 25) {
        rows.push(`<tr><td colspan="8" style="padding:6px 10px;font-size:10px;color:#78716c">
          \u2026 and ${this._itemViewData.length - 25} more items (see live dashboard)</td></tr>`);
      }
      return tableWrap(thead, rows);
    }

    if (tabName === "wo-plan" && this.rows && this.rows.length) {
      const thead = [
        th("Work Order"), th("Item"), th("Remaining"), th("Kit Status"),
        th("Est. Cost"), th("SO Pending"), th("ERP Status"),
      ].join("");
      const rows = this.rows.slice(0, 25).map(r => `<tr>
        ${td(`<a href="/app/work-order/${_esc(r.wo)}" style="color:#1c1917">${_esc(r.wo)}</a>`)}
        ${td(_esc(r.item_name || r.item_code))}
        ${td(_fmt_num(r.remaining_qty, 0) + " " + _esc(r.uom), true)}
        ${td(_esc(r.kit_status))}
        ${td(r.est_cost ? "\u20B9" + _fmt_num(r.est_cost, 0) : "\u2014", true)}
        ${td(r.total_pending_so ? _fmt_num(r.total_pending_so, 0) : "\u2014", true)}
        ${td(_esc(r.status))}
      </tr>`);
      if (this.rows.length > 25) {
        rows.push(`<tr><td colspan="7" style="padding:6px 10px;font-size:10px;color:#78716c">
          \u2026 and ${this.rows.length - 25} more WOs (see live dashboard)</td></tr>`);
      }
      return tableWrap(thead, rows);
    }

    // Fallback for other tabs or no data
    return `<p style="color:#78716c;font-size:12px">
      This tab does not support inline snapshot export. Open the live dashboard for full detail.
    </p>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  DISPATCH BOTTLENECK TAB
  //
  //  PURPOSE: Answer "Can we fulfill ALL customer orders?"
  //  Shows every item customers are waiting for, independent of the current WO
  //  simulation. Items with SOs but no WO appear with will_produce = 0 ("No WO").
  //
  //  Data sources:
  //    Server (get_dispatch_bottleneck) → ALL items with pending Sales Orders
  //      fg_stock, total_pending, so_list, item_name, uom, secondary_uom
  //    Client (this.rows) → WO simulation: will_produce per item_code
  //
  //  Per-item columns:
  //    Customer Orders  — open SO qty not yet shipped (all dates, all customers)
  //    FG In Stock      — physical warehouse qty (Bin.actual_qty)
  //    Will Produce     — remaining WO qty (0 if no active WO)
  //    Total Coverage   = FG In Stock + Will Produce
  //    Gap              = Customer Orders − Total Coverage
  //
  //  STATUS LOGIC (computed in JS):
  //    Critical  → Gap > 0  (demand exceeds total supply even with all WOs done)
  //    At Risk   → Gap ≤ 0 but some WOs for this item are blocked/partial
  //    On Track  → Gap ≤ 0 and all WOs ready
  //    Surplus   → Negative gap with >25% excess coverage
  //    No Orders → Item has WOs but no pending customer orders
  //
  //  UOM display: primary UOM + secondary higher UOM (e.g. "5000 g / 5 kg")
  //
  //  API: chaizup_toc.api.wo_kitting_api.get_dispatch_bottleneck
  //  Data merges with this.rows (WO simulation results from simulate_kitting)
  //
  //  ══════════════════════════════════════════════════════════════════
  //  🔒 RESTRICTED — do not rename:
  //    this._dispatchData   (keyed by item_code from API response)
  //    this._dispatchLoaded / this._dispatchLoading (state flags)
  //    _renderDispatchBottleneck() / _fetchDispatchData() (called by _switchTab)
  //    #wkp-dispatch-body (HTML target for innerHTML injection)
  //    #wkp-dispatch-loading (spinner shown while API is in-flight)
  //  ✅ SAFE to change: column labels, badge text, colours, sort order,
  //    SO detail row layout, number of SO detail columns shown.
  //  ══════════════════════════════════════════════════════════════════
  // ─────────────────────────────────────────────────────────────────────

  _fetchDispatchData() {
    // ── Dispatch tab is now independent of WO simulation ────────────────────
    // The server queries ALL items with pending Sales Orders, not just items in
    // the current WO list. Will-produce quantities are computed here in JS from
    // this.rows and merged into the dispatch data for the coverage calculation.
    // No item_codes arg needed — the API discovers all SO items itself.
    this._dispatchLoading = true;
    const loadingEl = document.getElementById("wkp-dispatch-loading");
    if (loadingEl) loadingEl.style.display = "flex";

    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_dispatch_bottleneck",
      args: { stock_mode: this.stockMode },
      callback: r => {
        this._dispatchLoading = false;
        this._dispatchLoaded  = true;
        this._dispatchData    = r.message || {};
        if (loadingEl) loadingEl.style.display = "none";
        // If user is already on the dispatch tab, render now
        if (this._activeTab === "dispatch") this._renderDispatchBottleneck();
      },
      error: () => {
        this._dispatchLoading = false;
        this._dispatchLoaded  = true;
        if (loadingEl) loadingEl.style.display = "none";
        const body = document.getElementById("wkp-dispatch-body");
        if (body) body.innerHTML =
          `<div class="wkp-reco wkp-reco-err" style="margin:16px">
             <div class="wkp-reco-icon">\u26A0\uFE0F</div>
             <div class="wkp-reco-body">
               <div class="wkp-reco-headline">Failed to load dispatch data.</div>
               <div class="wkp-reco-detail">Check the browser console and server logs. Try refreshing the page.</div>
             </div>
           </div>`;
      },
    });
  }

  _renderDispatchBottleneck() {
    const body = document.getElementById("wkp-dispatch-body");
    if (!body) return;

    // ── Dispatch tab is SO-driven — shows ALL items customers are waiting for ─
    //
    // DESIGN: The server (get_dispatch_bottleneck) queries all open Sales Orders
    // independently and returns every item with pending demand. This tab is NOT
    // limited to items in the current WO simulation. The will_produce figure is
    // computed here by merging WO simulation rows (this.rows) where available.
    // Items with SOs but no WO will show will_produce = 0 (no production planned).
    //
    // Data flow:
    //   this._dispatchData  — {item_code: {fg_stock, total_pending, so_list,
    //                           item_name, uom, secondary_uom, secondary_factor, ...}}
    //   this.rows           — [{item_code, remaining_qty, kit_status, wo, ...}]
    //
    // Step 1: index WO data by item_code (will_produce + blocking status)
    const woByItem = {};
    (this.rows || []).forEach(row => {
      const ic = row.item_code;
      if (!woByItem[ic]) {
        woByItem[ic] = { will_produce: 0, wos: [], kit_statuses: new Set() };
      }
      woByItem[ic].will_produce += (row.remaining_qty || 0);
      woByItem[ic].wos.push(row.wo);
      woByItem[ic].kit_statuses.add(row.kit_status);
    });

    // Step 2: build item list from dispatch API — primary source is SO data
    const dispEntries = Object.entries(this._dispatchData || {});

    if (!dispEntries.length) {
      body.innerHTML = `<div class="wkp-reco wkp-reco-ok" style="margin:16px">
        <div class="wkp-reco-icon">\u2705</div>
        <div class="wkp-reco-body">
          <div class="wkp-reco-headline">No pending customer orders found.</div>
          <div class="wkp-reco-detail">There are no open Sales Orders with undelivered qty in the system right now.</div>
        </div>
      </div>`;
      return;
    }

    const items = dispEntries.map(([ic, d]) => {
      const wo           = woByItem[ic] || { will_produce: 0, wos: [], kit_statuses: new Set() };
      const fg_stock     = d.fg_stock      || 0;
      const total_pending= d.total_pending || 0;
      const total_coverage = fg_stock + wo.will_produce;
      const gap          = total_pending - total_coverage;

      let dspStatus;
      if (total_pending === 0) {
        dspStatus = "no-orders";
      } else if (gap > 0) {
        dspStatus = "critical";
      } else {
        const hasBlocked = wo.kit_statuses.has("block") || wo.kit_statuses.has("partial");
        dspStatus = hasBlocked ? "atrisk" : "ok";
      }
      if (total_pending > 0 && gap < -(total_coverage * 0.25)) dspStatus = "surplus";

      return {
        item_code       : ic,
        item_name       : d.item_name || ic,
        item_group      : d.item_group || "",
        uom             : d.uom || "",
        secondary_uom   : d.secondary_uom || "",
        secondary_factor: d.secondary_factor || 1.0,
        will_produce    : wo.will_produce,
        wos             : wo.wos,
        kit_statuses    : wo.kit_statuses,
        fg_stock,
        total_pending,
        total_coverage,
        gap,
        dsp_status     : dspStatus,
        total_reserved : d.total_reserved || 0,
        has_pick_list  : d.has_pick_list  || false,
        so_list        : d.so_list        || [],
      };
    });

    // Step 3: sort — Critical first, At Risk, On Track, Surplus, No Orders
    const sortOrder = { critical: 0, atrisk: 1, ok: 2, surplus: 3, "no-orders": 4 };
    items.sort((a, b) => {
      const sd = (sortOrder[a.dsp_status] || 0) - (sortOrder[b.dsp_status] || 0);
      return sd !== 0 ? sd : (b.total_pending - a.total_pending);
    });

    // ── Step 4: Build table rows ───────────────────────────────────────────
    const rowsHtml = items.map(item => {
      const statusCfg = {
        critical  : { cls: "wkp-dsp-critical",  icon: "\uD83D\uDD34", label: "Critical",  tip: "Demand exceeds total supply even with all WOs complete. Create more Work Orders." },
        atrisk    : { cls: "wkp-dsp-atrisk",    icon: "\uD83D\uDFE1", label: "At Risk",   tip: "Coverage is enough IF all WOs complete. But some WOs are blocked or partially short." },
        ok        : { cls: "wkp-dsp-ok",        icon: "\uD83D\uDFE2", label: "On Track",  tip: "Sufficient production + stock to cover all customer orders." },
        surplus   : { cls: "wkp-dsp-surplus",   icon: "\uD83D\uDD35", label: "Surplus",   tip: "Production output exceeds current customer demand." },
        "no-orders": { cls: "wkp-dsp-noorders", icon: "\u2610",       label: "No Orders", tip: "No open customer orders for this item. WOs exist but no dispatch demand." },
      }[item.dsp_status] || { cls: "", icon: "?", label: item.dsp_status, tip: "" };

      const gapCls  = item.gap > 0 ? "wkp-cell-red" : (item.gap < 0 ? "wkp-cell-green" : "");
      const gapTxt  = item.gap > 0
        ? `+${_fmt_num(item.gap, 0)} SHORT`
        : (item.gap < 0 ? `\u2714 +${_fmt_num(-item.gap, 0)} surplus` : "\u2714 Exact");

      // Pick list badge
      const plBadge = item.has_pick_list
        ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok"
                 data-tip="At least one Pick List has been created for a Sales Order of this item.&#10;Materials are being (or have been) picked for delivery.">\u2714 Pick List</span>`
        : `<span class="wkp-dsp-pill wkp-dsp-pill-none"
                 data-tip="No Pick List has been created yet for any open Sales Order of this item.">\u2610 No Pick List</span>`;

      // Stock reservation badge
      const resBadge = item.total_reserved > 0
        ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok"
                 data-tip="Stock Reservation: ${_fmt_num(item.total_reserved, 2)} units are reserved against open Sales Orders.&#10;This stock is earmarked and cannot be used for other purposes.">\uD83D\uDD12 Reserved: ${_fmt_num(item.total_reserved, 0)}</span>`
        : `<span class="wkp-dsp-pill wkp-dsp-pill-none"
                 data-tip="No Stock Reservation entries exist for this item&apos;s open Sales Orders.">\u26AA No Reservation</span>`;

      // Deduplicate SO list by so_name — same Sales Order may appear multiple times
      // when the SO child table has more than one line for the same item_code.
      // Fix: merge entries with the same so_name, summing qty/delivered/pending/dn_qty,
      //      taking OR for is_overdue, and MAX for pick_list_count and reserved_qty.
      const soMap = {};
      (item.so_list || []).forEach(so => {
        if (!soMap[so.so_name]) {
          soMap[so.so_name] = Object.assign({}, so);  // shallow copy
        } else {
          const m = soMap[so.so_name];
          m.qty           = (m.qty           || 0) + (so.qty           || 0);
          m.delivered_qty = (m.delivered_qty || 0) + (so.delivered_qty || 0);
          m.pending_qty   = (m.pending_qty   || 0) + (so.pending_qty   || 0);
          m.dn_qty        = (m.dn_qty        || 0) + (so.dn_qty        || 0);
          m.reserved_qty  = Math.max(m.reserved_qty  || 0, so.reserved_qty  || 0);
          m.pick_list_count = Math.max(m.pick_list_count || 0, so.pick_list_count || 0);
          m.is_overdue    = m.is_overdue || so.is_overdue;
        }
      });
      const soListDedup = Object.values(soMap);

      // SO count
      const soCount = soListDedup.length;
      const overdueCount = soListDedup.filter(s => s.is_overdue).length;

      // Expandable SO detail table (hidden by default)
      const soRowsHtml = soListDedup.length ? soListDedup.map(so => {
        const isOverdue = so.is_overdue;
        const dueCls    = isOverdue ? "wkp-cell-red" : "";
        const dateStr   = so.delivery_date || "\u2014";
        const plPill    = so.pick_list_count > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Pick List created for this SO">\u2714 PL (${so.pick_list_count})</span>`
          : `<span class="wkp-dsp-pill wkp-dsp-pill-none" data-tip="No Pick List for this SO">\u2610</span>`;
        const resPill   = (so.reserved_qty || 0) > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Reserved qty: ${_fmt_num(so.reserved_qty, 2)}">\uD83D\uDD12 ${_fmt_num(so.reserved_qty, 0)}</span>`
          : `<span class="wkp-dsp-pill wkp-dsp-pill-none" data-tip="No stock reserved for this SO">&mdash;</span>`;
        const dnPill    = (so.dn_qty || 0) > 0
          ? `<span class="wkp-dsp-pill wkp-dsp-pill-ok" data-tip="Partial Delivery Note shipped: ${_fmt_num(so.dn_qty, 2)}">\uD83D\uDE9A ${_fmt_num(so.dn_qty, 0)} shipped</span>`
          : "";
        const overdueLbl= isOverdue
          ? `<span class="wkp-dsp-overdue-badge" data-tip="Delivery date was ${_esc(dateStr)} &mdash; this order is overdue">\u26A0 OVERDUE</span>`
          : "";

        // Customer display: name (primary), group (secondary), ID (muted)
      // customer_name = human-readable display (e.g. "Sharma Exports Pvt Ltd")
      // customer_group = segment from Customer master (e.g. "Wholesale", "Retail")
      // customer = ERPNext document ID (e.g. "CUST-00001") — link to open in ERP
      const custName  = so.customer_name || so.customer || "";
      const custGroup = so.customer_group || "";
      const custId    = so.customer || "";

      // Draft badge — shown when SO is saved but not yet submitted (docstatus=0)
      const isDraft = (so.so_docstatus === 0);
      const draftBadge = isDraft
        ? `<span class="wkp-dsp-pill wkp-dsp-pill-draft" data-tip="This Sales Order is a Draft (not yet submitted/confirmed). Quantities are indicative only.">\u270F Draft</span>`
        : "";

      return `
<tr class="wkp-dsp-so-row ${isOverdue ? "wkp-dsp-so-overdue" : ""}">
  <td>
    <a href="/app/sales-order/${_esc(so.so_name)}" target="_blank" class="wkp-wo-link">${_esc(so.so_name)}</a>
    ${overdueLbl}${draftBadge}
  </td>
  <td>
    <div style="font-weight:600">${_esc(custName)}</div>
    ${custGroup ? `<div style="font-size:10px;color:var(--stone-500)">${_esc(custGroup)}</div>` : ""}
    ${custId !== custName ? `<div style="font-size:10px;color:var(--stone-400)">${_esc(custId)}</div>` : ""}
  </td>
  <td class="ta-r">
    <div>${_fmt_num(so.qty, 0)}\u00a0${_esc(item.uom)}</div>
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(so.qty / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
  </td>
  <td class="ta-r" style="color:var(--ok-text)">
    <div>${_fmt_num(so.delivered_qty, 0)}\u00a0${_esc(item.uom)}</div>
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(so.delivered_qty / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
  </td>
  <td class="ta-r ${dueCls}" data-tip="Qty still to be shipped for this Sales Order">
    <div><strong>${_fmt_num(so.pending_qty, 0)}\u00a0${_esc(item.uom)}</strong></div>
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(so.pending_qty / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
  </td>
  <td class="${dueCls}" data-tip="Target delivery date from Sales Order">${_esc(dateStr)}</td>
  <td>${plPill}</td>
  <td>${resPill}</td>
  <td>${dnPill}</td>
</tr>`;
      }).join("") : `<tr><td colspan="9" style="color:var(--slate-400);font-style:italic;padding:12px">No open Sales Orders for this item.</td></tr>`;

      const soDetailId = "wkp-dsp-so-" + item.item_code.replace(/[^a-zA-Z0-9]/g, "_");

      return `
<tr class="wkp-dsp-row wkp-dsp-${item.dsp_status}" data-item="${_esc(item.item_code)}">
  <td>
    <span class="wkp-dsp-status-badge ${statusCfg.cls}" data-tip="${statusCfg.tip}">
      ${statusCfg.icon} ${statusCfg.label}
    </span>
  </td>
  <td>
    <div class="wkp-item-name">${_esc(item.item_name)}</div>
    <div class="wkp-item-code">${_esc(item.item_code)}</div>
    ${item.item_group ? `<div class="wkp-item-group-tag">${_esc(item.item_group)}</div>` : ""}
    <div class="wkp-dsp-wo-chips">
      ${item.wos.slice(0, 3).map(wo => `<span class="wkp-dsp-wo-chip">${_esc(wo)}</span>`).join("")}
      ${item.wos.length > 3 ? `<span class="wkp-dsp-wo-chip">+${item.wos.length - 3} more</span>` : ""}
    </div>
  </td>
  <td class="ta-r"
      data-tip="Customer Orders (Pending Dispatch)&#10;Total qty across all open Sales Orders not yet delivered.&#10;Source: Sales Order Items where (qty - delivered_qty) &gt; 0">
    <strong>${_fmt_num(item.total_pending, 0)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(item.uom)}</div>
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(item.total_pending / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
    ${overdueCount > 0 ? `<div class="wkp-dsp-overdue-note" data-tip="${overdueCount} order(s) with overdue delivery dates">\u26A0 ${overdueCount} overdue</div>` : ""}
  </td>
  <td class="ta-r"
      data-tip="FG In Stock&#10;Physical finished-good stock in all warehouses right now.&#10;Source: Bin.actual_qty (tabBin) for this item code.">
    ${_fmt_num(item.fg_stock, 0)}
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(item.fg_stock / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
  </td>
  <td class="ta-r"
      data-tip="Will Be Produced&#10;Sum of remaining_qty (Planned - Produced) across all open Work Orders for this item.&#10;0 = no active Work Order for this item (customer order with no production plan yet).">
    ${_fmt_num(item.will_produce, 0)}
    ${item.secondary_uom && item.will_produce > 0 ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(item.will_produce / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
    ${item.wos.length > 0 ? `<div style="font-size:10px;color:var(--stone-400)">${item.wos.length} WO${item.wos.length !== 1 ? "s" : ""}</div>` : `<div style="font-size:10px;color:var(--err-text)">No WO</div>`}
  </td>
  <td class="ta-r wkp-dsp-coverage"
      data-tip="Total Coverage = FG In Stock + Will Produce&#10;This is the maximum quantity available for dispatch once all open WOs complete.&#10;Does NOT account for WOs that are blocked or partially short.">
    <strong>${_fmt_num(item.total_coverage, 0)}</strong>
    <div style="font-size:10px;color:var(--stone-400)">${_esc(item.uom)}</div>
    ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(item.total_coverage / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}
    <span class="wkp-th-help" data-popover="dispatch_coverage" title="How is this calculated?">?</span>
  </td>
  <td class="ta-r ${gapCls}"
      data-tip="Gap = Customer Orders &minus; Total Coverage&#10;Positive (red) = shortage even if all WOs complete. Action needed.&#10;Negative (green) = surplus.&#10;Zero = exactly meets demand.">
    <strong>${gapTxt}</strong>
    ${item.gap !== 0 && item.uom
      ? `<div style="font-size:10px;color:var(--stone-400)">${_esc(item.uom)}</div>
         ${item.secondary_uom ? `<div style="font-size:10px;color:var(--stone-500)">${_fmt_num(Math.abs(item.gap) / item.secondary_factor, 2)}\u00a0${_esc(item.secondary_uom)}</div>` : ""}`
      : ""}
    <span class="wkp-th-help" data-popover="dispatch_gap" title="What does Gap mean?">?</span>
  </td>
  <td>
    <div class="wkp-dsp-badges">${plBadge} ${resBadge}</div>
    ${item.so_list.length
      ? `<div>${soCount} SO${soCount !== 1 ? "s" : ""}${overdueCount > 0 ? ` (${overdueCount} overdue)` : ""}</div>` : ""}
  </td>
  <td class="ta-r">
    ${soCount > 0
      ? `<button class="wkp-btn wkp-btn-sm" onclick="document.getElementById('${soDetailId}').style.display =
           document.getElementById('${soDetailId}').style.display === 'none' ? '' : 'none'"
           title="Expand to see each Sales Order with delivery dates, pick list status, and reservations">
           Details
         </button>` : ""}
  </td>
</tr>
<tr class="wkp-dsp-detail-row" id="${soDetailId}" style="display:none">
  <td colspan="9" style="padding:0 0 0 40px">
    <table class="wkp-modal-table wkp-dsp-so-table">
      <thead>
        <tr>
          <th data-tip="Sales Order number (click to open in ERPNext)">Sales Order</th>
          <th data-tip="Customer name, group, and ERPNext customer ID">Customer</th>
          <th class="ta-r" data-tip="Total qty in the Sales Order. Both stock UOM and higher UOM shown.">Ordered</th>
          <th class="ta-r" data-tip="Qty already delivered via Delivery Notes. Both stock UOM and higher UOM shown.">Delivered</th>
          <th class="ta-r" data-tip="Qty still pending dispatch (Ordered &minus; Delivered). Both stock UOM and higher UOM shown.">Pending</th>
          <th data-tip="Delivery date committed to customer in the Sales Order">Due Date</th>
          <th data-tip="Has a Pick List been created? Pick Lists initiate warehouse picking before dispatch.">Pick List</th>
          <th data-tip="Is stock reserved via Stock Reservation entry?">Reserved</th>
          <th data-tip="Partial deliveries already shipped via Delivery Note">Shipped</th>
        </tr>
      </thead>
      <tbody>${soRowsHtml}</tbody>
    </table>
  </td>
</tr>`;
    }).join("");

    // ── Render summary banner ─────────────────────────────────────────────
    const critCount = items.filter(i => i.dsp_status === "critical").length;
    const riskCount = items.filter(i => i.dsp_status === "atrisk").length;
    const okCount   = items.filter(i => i.dsp_status === "ok").length;

    const bannerHtml = `
<div class="wkp-dispatch-summary">
  <div class="wkp-dispatch-sum-card wkp-dsp-critical" data-tip="Items where customer demand exceeds total supply. Immediate action required.">
    <div class="wkp-dispatch-sum-num">${critCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDD34 Critical</div>
  </div>
  <div class="wkp-dispatch-sum-card wkp-dsp-atrisk" data-tip="Items with enough coverage IF all WOs complete, but some WOs are blocked.">
    <div class="wkp-dispatch-sum-num">${riskCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDFE1 At Risk</div>
  </div>
  <div class="wkp-dispatch-sum-card wkp-dsp-ok" data-tip="Items fully covered with all WOs on track.">
    <div class="wkp-dispatch-sum-num">${okCount}</div>
    <div class="wkp-dispatch-sum-lbl">\uD83D\uDFE2 On Track</div>
  </div>
  <div class="wkp-dispatch-sum-card" style="background:var(--stone-50);border-color:var(--stone-200)" data-tip="Unique finished-good items across all open Work Orders.">
    <div class="wkp-dispatch-sum-num">${items.length}</div>
    <div class="wkp-dispatch-sum-lbl">Total Items</div>
  </div>
</div>`;

    body.innerHTML = bannerHtml + `
<table class="wkp-table wkp-dsp-table">
  <thead>
    <tr>
      <th data-tip="Overall dispatch status for this item. Click Details to see individual Sales Orders.">Status</th>
      <th>
        Item
        <span class="wkp-th-help" data-popover="item_name" title="What is shown here?">?</span>
      </th>
      <th class="ta-r"
          data-tip="Total open customer order qty for this item (all open SOs, all dates).&#10;Source: Sales Order Items where status is not Closed/Cancelled.">
        Customer Orders
      </th>
      <th class="ta-r"
          data-tip="Physical finished-good stock in all warehouses.&#10;Source: SUM(Bin.actual_qty) for this item across all warehouses.">
        FG In Stock
      </th>
      <th class="ta-r"
          data-tip="Sum of remaining production qty across all open Work Orders for this item.&#10;Remaining = Planned Qty &minus; Already Produced Qty">
        Will Produce
      </th>
      <th class="ta-r"
          data-tip="Total Coverage = FG In Stock + Will Produce&#10;Maximum available supply once all open WOs complete.">
        Total Coverage
        <span class="wkp-th-help" data-popover="dispatch_coverage" title="How is Coverage calculated?">?</span>
      </th>
      <th class="ta-r"
          data-tip="Gap = Customer Orders &minus; Total Coverage&#10;Positive = short (cannot fulfill all orders). Negative = surplus.">
        Gap
        <span class="wkp-th-help" data-popover="dispatch_gap" title="What does Gap mean?">?</span>
      </th>
      <th data-tip="Pick List and Stock Reservation status. Click Details to see per-SO breakdown.">Fulfillment Tracking</th>
      <th></th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div class="wkp-dispatch-footer">
  <strong>How to read this table:</strong>
  Critical = demand cannot be met even if all WOs complete &mdash; need more WOs or stock transfer.
  At Risk = enough coverage on paper but blocked WOs must be unblocked first.
  Click &ldquo;Details&rdquo; on any row to see individual Sales Orders with pick list, reservation, and delivery status.
</div>`;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  UI HELPERS
  // ─────────────────────────────────────────────────────────────────────

  _showLoader(show) {
    this._loading = show;
    const loader = document.getElementById("wkp-loader");
    if (loader) loader.style.display = show ? "flex" : "none";
    if (show) { this._showEmpty(false); this._showAllPanes(false); }
  }

  _showEmpty(show) {
    const el = document.getElementById("wkp-empty");
    if (el) el.style.display = show ? "flex" : "none";
  }

  _closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
}


// ═══════════════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Float parse with safe fallback (mirrors Python's flt()).
 * Used in _openMRQtyDialog for MOQ comparisons.
 */
function flt(val, precision) {
  const n = parseFloat(val) || 0;
  return precision != null ? parseFloat(n.toFixed(precision)) : n;
}

function _fmt_num(val, decimals) {
  const n = parseFloat(val) || 0;
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function _esc(val) {
  if (val == null) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape plain text for innerHTML (used for user messages in AI chat).
 * Same as _esc but preserves newlines as <br>.
 */
function _escHtml(val) {
  if (val == null) return "";
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

/**
 * Sanitise AI-generated HTML before injecting into the DOM.
 * Allows safe formatting tags and our custom CSS classes.
 * Strips <script>, event handlers (on*=), javascript: hrefs, and iframes.
 *
 * This is a defence-in-depth measure — DeepSeek is trusted but we still
 * sanitise to prevent accidental XSS from unexpected model output.
 *
 * SAFE tags: table, thead, tbody, tr, th, td, ul, ol, li, p, br, strong,
 *   em, span, div, a, code, h3, h4
 * STRIPPED: script, iframe, object, embed, form, input, button
 * STRIPPED attributes: on*, javascript:, data: URIs
 */
function _sanitizeAIHtml(html) {
  if (!html) return "";

  // Remove script and dangerous tags entirely
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<input[^>]*>/gi, "")
    .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, "");

  // Strip event handler attributes (onclick, onload, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
  clean = clean.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, "");

  // Strip javascript: and data: URIs in href/src
  clean = clean.replace(/href\s*=\s*["']\s*javascript:[^"']*/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*["']\s*data:[^"']*/gi, 'src=""');

  return clean;
}

function _status_badge_class(status) {
  return {
    "Not Started"          : "wkp-badge-gray",
    "Material Transferred" : "wkp-badge-blue",
    "In Process"           : "wkp-badge-amber",
    "Completed"            : "wkp-badge-green",
    "Stopped"              : "wkp-badge-red",
  }[status] || "wkp-badge-gray";
}

function _kit_status_class(status) {
  return {
    ok: "wkp-status-ok", partial: "wkp-status-warn",
    block: "wkp-status-block", kitted: "wkp-status-kitted",
  }[status] || "wkp-status-ok";
}

function _kit_status_label(status) {
  return {
    ok      : "\u2705 Ready to Produce \u2014 All materials available",
    partial : "\u26A0 Partially Blocked \u2014 Some materials missing",
    block   : "\uD83D\uDD34 Fully Blocked \u2014 Cannot start production",
    kitted  : "\u2713 Kitted \u2014 Materials on production floor",
  }[status] || "\u2014";
}

/**
 * Plain-English tooltip for the supply stage badge shown in shortage table.
 * Helps executives understand what each stage means without ERP knowledge.
 */
function _stage_description(stage) {
  return {
    "In Stock"     : "Available in warehouse right now",
    "In Production": "Being manufactured in another Work Order (sub-assembly)",
    "PO Raised"    : "Purchase Order sent to supplier — awaiting delivery",
    "MR Raised"    : "Material Request created — needs to be converted to PO",
    "Short"        : "Not available, not ordered — action needed immediately",
  }[stage] || stage || "";
}
