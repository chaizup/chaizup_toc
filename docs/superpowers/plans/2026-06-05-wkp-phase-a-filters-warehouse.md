# WO Kitting Planner — Phase A (Filters + Warehouse Context + Table-First UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WO Kitting Planner's read-only TOC-Settings banner with editable SO/WO/PO `Status:Workflow` multiselects + a Warehouses multiselect + a Company picker + a Load button (defaulting from TOC Settings on load), scope the simulation to the selected warehouses/company across every tab, port the item-short-surplus inline sort, and slim the summary strip — without changing today's behavior for users who don't touch a filter.

**Architecture:** Backend adds optional `warehouses`/`company` kwargs (blank ⇒ today's behavior) to the existing endpoints + supply-pool helpers, scoping Bin/WO/PO/MR/SO by warehouse via `COALESCE(line.warehouse, header.set_warehouse) IN (...)`. Frontend ports the proven `item-short-surplus` multiselect + sort widgets (with the 2026-06-05 fixes baked in) under a `wkp-` prefix, seeds them from `get_toc_pending_filters` + a new options endpoint, and threads the selections through every `frappe.call`.

**Tech Stack:** Frappe v16, MariaDB, vanilla JS + jQuery + Tabulator 6.3.1, `frappe.db.sql`.

---

## ⚠️ Read before starting (codebase rules)

- **Files (all relative to `apps/chaizup_toc/`):**
  - Page: `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.{html,js,css,MD}`
  - API: `chaizup_toc/api/wo_kitting_api.py`
  - Reference (port FROM): `chaizup_toc/chaizup_toc/page/item_short_surplus/item_short_surplus.{js,css}` + `chaizup_toc/api/item_short_surplus_api.py`
- **HTML rule (POR-023):** ZERO raw single quotes in `wo_kitting_planner.html` outside HTML comments — a violation blanks the page. Use `&apos;` / `&quot;`. After any HTML edit run the lint in Task 9.
- **ERPNext fields:** WO finished good = `production_item` (NOT `item_code`); PO Item price = `rate`; Stock Entry→WO = `work_order`. WO target warehouse = `fg_warehouse`.
- **`frappe.db.has_column(..., "workflow_state")` guard** stays on every workflow_state branch. The helpers `_wkp_so_status_clause` / `_wkp_wo_status_clause` / `_wkp_po_status_clause` already do this — reuse them, do not write raw status SQL.
- **Don't break contracts:** keep API method names + return schemas; keep DOM IDs `#wsum-ready/partial/blocked/total/shortage-val`, `#wkp-pane-*`, `#wkp-tbody`, `#wkp-shortage-body`, `#wkp-dispatch-body`, `#wkp-iv-body`, and the hidden legacy `#wkp-status-filter`. New behavior = new optional kwargs, default = today.
- **No-surprise principle:** with no filter change, every tab MUST return the SAME numbers as today (defaults come from TOC Settings). Task 8 verifies this.
- **Run tests with:** `cd /workspace/development/frappe-bench && bench --site development.localhost console` (heredoc) or `bench --site development.localhost execute <dotted.fn>`. JS: `node --check <file>`. Build: `bench build --app chaizup_toc && bench --site development.localhost clear-cache`.
- **Branch:** work on the current branch `feat/configurable-automation-triggers`. There are PRE-EXISTING dirty files in the tree (item_projection_*, toc_item_settings.*, mr_generator.py, …) that are NOT part of this work — `git add` ONLY the exact files each task changes; never `git add -A`.

---

## File Structure (Phase A)

| File | Phase-A responsibility |
|---|---|
| `wo_kitting_api.py` | `_wkp_parse_warehouses`, `_wkp_company_warehouses`, `_wkp_wh_param`, warehouse/company scoping threaded into `get_open_work_orders`, `_build_stock_pool`, `simulate_kitting`, `get_dispatch_bottleneck`, `get_item_wo_summary`, `_get_open_so_detail`; new `wkp_get_filter_universe()` returning warehouse + company options + TOC-Settings defaults. |
| `wo_kitting_planner.html` | Replace `#wkp-pending-banner` with the editable filter row (SO/WO/PO/WH multiselect triggers + Company + Load); add the sort bar; keep hidden `#wkp-status-filter`. |
| `wo_kitting_planner.js` | Port the pair-multiselect + warehouse/company pickers + inline sort; onload seeding; thread `warehouses`/`company` into every `frappe.call`. |
| `wo_kitting_planner.css` | Filter-row + sort-bar styles (ported `wkp-` prefixed); slim `.wkp-summary` strip. |
| `wo_kitting_planner.MD` | TS-001-reversal note + warehouse-context + new sync block. |

---

## Task 1: Backend — warehouse/company parsing + clause helpers

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py` (add helpers next to the existing `_wkp_*` status helpers).

- [ ] **Step 1: Add the helpers**

Find the block of `_wkp_*` helpers (search `def _wkp_parse_status_list`). Add these new helpers immediately after it:

```python
def _wkp_parse_warehouses(value):
    """Parse the warehouses kwarg (list | JSON-string | None | "") into a clean
    list. EMPTY ⇒ [] which the callers treat as 'all warehouses' (today's
    behavior — NO warehouse predicate)."""
    import json as _json
    if value in (None, "", b""):
        return []
    if isinstance(value, str):
        try:
            value = _json.loads(value)
        except Exception:
            value = [value]
    return [str(w).strip() for w in (value or []) if str(w).strip()]


def _wkp_company_warehouses(company):
    """Return the list of warehouse names belonging to `company`, or [] when no
    company is given. Used to AND a company filter into the warehouse scope."""
    if not company:
        return []
    return frappe.get_all("Warehouse", filters={"company": company, "disabled": 0},
                          pluck="name") or []


def _wkp_resolve_wh_scope(warehouses=None, company=None):
    """Combine an explicit warehouse list with a company's warehouses.
    Returns (wh_list, active) where active=True means a predicate should be
    applied. When both are given, intersect; when only company, use its
    warehouses; when neither, active=False (scope everything — today's behavior).
    """
    whs = _wkp_parse_warehouses(warehouses)
    comp_whs = _wkp_company_warehouses(company)
    if whs and comp_whs:
        scope = [w for w in whs if w in comp_whs]
    elif whs:
        scope = whs
    elif comp_whs:
        scope = comp_whs
    else:
        return [], False
    return scope, True
```

- [ ] **Step 2: Verify import + helper behavior**

Run:
```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
from chaizup_toc.api.wo_kitting_api import _wkp_parse_warehouses, _wkp_resolve_wh_scope
print("parse json:", _wkp_parse_warehouses('["WH-A","WH-B"]'))
print("parse blank:", _wkp_parse_warehouses(""))
print("scope none:", _wkp_resolve_wh_scope(None, None))      # ([], False)
print("scope wh:", _wkp_resolve_wh_scope('["WH-A"]', None))  # (["WH-A"], True)
PY
```
Expected: `['WH-A', 'WH-B']`; `[]`; `([], False)`; `(['WH-A'], True)`.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): warehouse/company parse + scope helpers"
```

---

## Task 2: Backend — `wkp_get_filter_universe` (options + defaults for the new pickers)

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: Add the whitelisted endpoint**

Add near `wkp_get_default_statuses` (search `def wkp_get_default_statuses`):

```python
@frappe.whitelist()
def wkp_get_filter_universe():
    """One call that seeds the WKP filter bar:
      - statuses: same payload as wkp_get_default_statuses (SO/WO/PO universe +
        TOC-Settings defaults, with 'Workflow: <state>' entries),
      - warehouses: all enabled non-group warehouses (options) + the TOC Settings
        'Inventory' warehouses as the on-load default,
      - companies: all companies (options) + the default company.
    Blank warehouse default ⇒ the page loads across ALL warehouses (today's view).
    """
    statuses = wkp_get_default_statuses()

    warehouses = frappe.get_all(
        "Warehouse",
        filters={"disabled": 0, "is_group": 0},
        fields=["name", "company"],
        order_by="name asc",
    )
    wh_default = []
    try:
        toc = frappe.get_single("TOC Settings")
        for r in (toc.get("warehouse_rules") or []):
            if (r.warehouse_purpose or "").strip() == "Inventory" and r.warehouse:
                wh_default.append(r.warehouse)
    except Exception:
        wh_default = []

    companies = frappe.get_all("Company", pluck="name", order_by="name asc")
    company_default = ""
    try:
        company_default = frappe.db.get_single_value("Global Defaults", "default_company") or ""
    except Exception:
        company_default = ""
    if not company_default and len(companies) == 1:
        company_default = companies[0]

    return {
        "statuses": statuses,
        "warehouses": warehouses,
        "wh_default": wh_default,
        "companies": companies,
        "company_default": company_default,
    }
```

- [ ] **Step 2: Verify**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
from chaizup_toc.api.wo_kitting_api import wkp_get_filter_universe
u = wkp_get_filter_universe()
print("keys:", sorted(u.keys()))
print("wh options:", len(u["warehouses"]), "| wh_default:", u["wh_default"])
print("companies:", u["companies"], "| default:", u["company_default"])
print("status keys:", sorted(u["statuses"].keys())[:6])
PY
```
Expected: keys include `companies, company_default, statuses, warehouses, wh_default`; warehouse option count > 0; status payload present.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): wkp_get_filter_universe options+defaults endpoint"
```

---

## Task 3: Backend — scope `get_open_work_orders` + `_build_stock_pool` by warehouse

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: Thread warehouse into `get_open_work_orders`**

Change the signature and add the `fg_warehouse` predicate. Locate `def get_open_work_orders(status_filter=None, wo_statuses=None):` and:

1. New signature:
```python
def get_open_work_orders(status_filter=None, wo_statuses=None, warehouses=None, company=None):
```
2. After the existing status resolution, resolve the warehouse scope and build the WO SQL with the predicate. Find the `frappe.db.sql(...)` that selects from `tabWork Order` and add, inside its `WHERE`, the warehouse clause. Concretely, before the SQL, compute:
```python
    wh_scope, wh_active = _wkp_resolve_wh_scope(warehouses, company)
    wh_sql = " AND wo.fg_warehouse IN %(whs)s" if wh_active else ""
```
Append `wh_sql` to the WHERE string of the WO query (the query aliases Work Order as `wo`; if it does not, add `wo` alias or use the table's real alias — confirm by reading the query) and pass `"whs": tuple(wh_scope)` in the params dict (only when `wh_active`). Mirror the existing param-dict pattern in that function.

- [ ] **Step 2: Thread warehouse into `_build_stock_pool`**

`def _build_stock_pool(stock_mode, item_codes, wo_statuses=None, po_statuses=None):` → add `warehouses=None, company=None`. Then:

1. Compute scope once at the top:
```python
    wh_scope, wh_active = _wkp_resolve_wh_scope(warehouses, company)
```
2. **Bin query** — currently:
```sql
SELECT item_code, SUM(actual_qty) AS qty
FROM   `tabBin`
WHERE  item_code IN %(items)s
GROUP BY item_code
```
Add `AND warehouse IN %(whs)s` to the WHERE when `wh_active`, and add `"whs": tuple(wh_scope)` to that query's params. Use a conditional fragment string the same way as Task 3 Step 1 so the clause is omitted when not active.
3. **PO inbound query** (the `tabPurchase Order Item poi` SELECT) — add
   `AND COALESCE(NULLIF(poi.warehouse,''), NULLIF(po.set_warehouse,'')) IN %(whs)s`
   (ensure the query JOINs `tabPurchase Order po`; if it doesn't, add `JOIN tabPurchase Order po ON po.name = poi.parent`).
4. **MR inbound query** (the `tabMaterial Request Item` SELECT, used when `stock_mode == "current_and_expected"`) — add
   `AND COALESCE(NULLIF(mri.warehouse,''), NULLIF(mr.set_warehouse,'')) IN %(whs)s` (JOIN `tabMaterial Request mr` if needed).
5. **WO expected-output query** (open WO output for sub-assemblies) — add `AND wo.fg_warehouse IN %(whs)s`.

For each query, only append the fragment + add the `whs` param when `wh_active`.

- [ ] **Step 3: Verify scoping is wired (numbers narrow, blank = same)**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.api.wo_kitting_api import get_open_work_orders
allw = get_open_work_orders()
print("WOs (no filter):", len(allw))
# pick a warehouse that some WO uses
wh = frappe.db.get_value("Work Order", {"docstatus":1}, "fg_warehouse")
import json
scoped = get_open_work_orders(warehouses=json.dumps([wh])) if wh else []
print("scoped wh:", wh, "-> WOs:", len(scoped), "(<= unfiltered)")
assert len(scoped) <= len(allw)
PY
```
Expected: scoped count ≤ unfiltered; no SQL error.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): warehouse-scope get_open_work_orders + stock pool"
```

---

## Task 4: Backend — thread warehouse/company into `simulate_kitting`, `get_dispatch_bottleneck`, `get_item_wo_summary`, `_get_open_so_detail`

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: `simulate_kitting`** — add `warehouses=None, company=None` to the signature; pass them through to the internal `_build_stock_pool(...)` call (find the call site inside `simulate_kitting`) and to `get_open_work_orders` if it re-derives the WO list. Add `warehouses=warehouses, company=company` to those calls.

- [ ] **Step 2: `get_dispatch_bottleneck(stock_mode, so_statuses, po_statuses)`** — add `warehouses=None, company=None`. Resolve scope; the SO demand query (per `production_item`/item) gets `AND COALESCE(NULLIF(soi.warehouse,''), NULLIF(so.set_warehouse,'')) IN %(whs)s`; the FG-stock subquery (`tabBin`) gets `AND warehouse IN %(whs)s`; the FG PO-inbound (when `current_and_expected`) gets the PO COALESCE clause. Only when `wh_active`.

- [ ] **Step 3: `get_item_wo_summary(wo_statuses, so_statuses)`** — add `warehouses=None, company=None`. WO aggregate gets `AND wo.fg_warehouse IN %(whs)s`; the SO demand via `_get_open_so_detail` is scoped in Step 4.

- [ ] **Step 4: `_get_open_so_detail(item_codes, so_statuses)`** — add `warehouses=None, company=None`; the SO line query gets `AND COALESCE(NULLIF(soi.warehouse,''), NULLIF(so.set_warehouse,'')) IN %(whs)s` when active. Update its caller(s) to forward the kwargs.

- [ ] **Step 5: Verify all four endpoints accept the kwargs without error**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import json, frappe
from chaizup_toc.api.wo_kitting_api import (get_dispatch_bottleneck, get_item_wo_summary, simulate_kitting, get_open_work_orders)
wh = frappe.db.get_value("Work Order", {"docstatus":1}, "fg_warehouse")
w = json.dumps([wh]) if wh else "[]"
print("dispatch:", len(get_dispatch_bottleneck(warehouses=w) or {}))
print("item_view:", len(get_item_wo_summary(warehouses=w) or []))
wos = json.dumps([x["name"] for x in (get_open_work_orders(warehouses=w) or [])][:3])
print("simulate rows:", len((simulate_kitting(wos, warehouses=w) or {}).get("rows", [])))
print("OK")
PY
```
Expected: all run; `OK` printed; no SQL error.

- [ ] **Step 6: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): warehouse/company scope across simulate/dispatch/item-view/SO detail"
```

---

## Task 5: Frontend — filter-bar HTML (replace banner with editable pickers)

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html`.

- [ ] **Step 1: Replace the read-only banner block**

Find `<div class="wkp-pending-banner" id="wkp-pending-banner" ...> ... </div>` (the whole banner, ~lines 260-284) and replace it with the editable filter row below. **No raw single quotes** (POR-023):

```html
      <!-- 2026-06-05 — editable filter row (replaces the read-only TOC banner).
           Pre-filled from TOC Settings on load; user can override per session;
           Load recalculates every tab. Multiselect triggers are filled by JS. -->
      <div class="wkp-filter-row" id="wkp-filter-row">
        <div class="wkp-fr-group wkp-fr-wide">
          <label class="wkp-fr-label">SO Pending (Status : Workflow)</label>
          <div class="wkp-ms" id="wkp-so-ms" tabindex="0" data-key="so"></div>
        </div>
        <div class="wkp-fr-group wkp-fr-wide">
          <label class="wkp-fr-label">WO Pending (Status : Workflow)</label>
          <div class="wkp-ms" id="wkp-wo-ms" tabindex="0" data-key="wo"></div>
        </div>
        <div class="wkp-fr-group wkp-fr-wide">
          <label class="wkp-fr-label">PO Pending (Status : Workflow)</label>
          <div class="wkp-ms" id="wkp-po-ms" tabindex="0" data-key="po"></div>
        </div>
        <div class="wkp-fr-group wkp-fr-wide">
          <label class="wkp-fr-label">Warehouses</label>
          <div class="wkp-ms" id="wkp-wh-ms" tabindex="0" data-key="wh"></div>
        </div>
        <div class="wkp-fr-group">
          <label class="wkp-fr-label">Company</label>
          <div class="wkp-ms" id="wkp-company-ms" tabindex="0" data-key="company"></div>
        </div>
        <button class="wkp-btn wkp-btn-sm wkp-load-btn" id="wkp-load-btn" type="button"
                data-tip="Apply the selected statuses, warehouses and company. Recalculates every tab.">
          <i class="fa-solid fa-arrows-rotate"></i> Load
        </button>
      </div>
```

Keep the hidden `#wkp-status-filter <select>` exactly as-is (it sits just below the banner — do NOT delete it).

- [ ] **Step 2: Add the sort bar**

Immediately above the table host / first pane (search the HTML for `wkp-summary` to anchor; put the sort bar right after the summary strip), add (ported from item-short-surplus, `wkp-` prefixed, no apostrophes):

```html
  <!-- 2026-06-05 — inline column sort (ported from item-short-surplus). -->
  <div class="wkp-sortbar" id="wkp-sortbar">
    <div class="wkp-sortpicker" id="wkp-sortpicker" tabindex="0" role="combobox"
         aria-haspopup="listbox" aria-expanded="false"
         data-tip="Pick a column to sort the active table by.">
      <i class="fa-solid fa-sort"></i>
      <span class="wkp-sortpicker-label">Sort:</span>
      <span class="wkp-sortpicker-value" id="wkp-sortpicker-value">&mdash;</span>
      <i class="fa-solid fa-caret-down"></i>
    </div>
    <button class="wkp-sortdir" id="wkp-sortdir" type="button"
            data-tip="Toggle ascending / descending.">
      <i class="fa-solid fa-arrow-down" id="wkp-sortdir-icon"></i>
      <span id="wkp-sortdir-label">High to Low</span>
    </button>
    <button class="wkp-sortclear" id="wkp-sortclear" type="button" title="Clear sort">&times;</button>
    <div class="wkp-sortpicker-dropdown" id="wkp-sortpicker-dropdown" role="listbox">
      <div class="wkp-sortpicker-opts" id="wkp-sortpicker-opts"></div>
    </div>
  </div>
```

- [ ] **Step 3: HTML apostrophe lint + page-wrap sanity**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 - <<'PY'
import re
s=open("chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html").read()
# strip HTML comments, then look for raw single quotes
body=re.sub(r"<!--.*?-->","",s,flags=re.S)
n=body.count("'")
print("raw apostrophes outside comments:", n)
assert n==0, "POR-023 violation — remove raw single quotes"
print("OK")
PY
```
Expected: `raw apostrophes outside comments: 0` then `OK`.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html
git commit -m "feat(wkp): editable filter row + sort bar HTML (replaces read-only banner)"
```

---

## Task 6: Frontend — port the multiselect widget + warehouse/company pickers + onload seeding + kwarg threading

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js`.

This is the core JS port. The SOURCE widget is `item_short_surplus.js`:
- `_mkPairMulti(key, label, options)` — the SO/WO/PO `Status:Workflow` chip + dropdown widget (includes the **2026-06-05 fixes**: `change`-event checkboxes, selected-first ordering). PORT this as `this._wkpPairMulti($host, key, options)` mounting onto an existing `<div class="wkp-ms">` (instead of building its own `.iss-filter-group`).
- `_mkLinkMulti(...)` — the live Link multiselect (chips + selected-first dropdown + change-event). PORT as `this._wkpLinkMulti($host, key, doctype, opts)` for **Warehouses** (`doctype="Warehouse"`).
- `_mkSingleLink(...)` — single Link picker. PORT as `this._wkpSingleLink($host, key, "Company")` for **Company**.

- [ ] **Step 1: Add state fields**

In the controller constructor (search `this._selWo` — they currently exist as `[]`), keep `this._selWo/_selSo/_selPo` and add:
```javascript
    this._selWh      = [];     // selected warehouse names ([] = all)
    this._selCompany = "";     // selected company ("" = all)
    this._filterUniverse = null;
```

- [ ] **Step 2: Port the three widget builders**

Copy `_mkPairMulti`, `_mkLinkMulti`, `_mkSingleLink` (and their shared helpers `positionDropdownToTrigger` / `_readState` / `_writeState` if not already present in WKP) from `item_short_surplus.js` into `wo_kitting_planner.js`, renaming the CSS class strings from `iss-` to `wkp-ms-`, and changing the **commit** to write into `this._selXxx` arrays + flip the Load button dirty (do NOT auto-`this.load()`; Load is explicit per the WKP-034 RESTRICT). Mount each onto the `#wkp-*-ms` host `<div>` (use `$(host).empty().append(...)`), not a new `.iss-filter-group`. Keep the `change`-event checkbox + selected-first behavior verbatim (they are the 2026-06-05 fixes — do not regress).

> The widget code is ~150 lines per builder; port it faithfully. The ONLY deltas are: (a) class prefix `iss-`→`wkp-ms-`; (b) state target = `this._selWo/_selSo/_selPo/_selWh`; (c) on change call `this._markLoadDirty()` (Step 4) instead of a live reload; (d) mount target = the passed host div.

- [ ] **Step 3: Replace `_loadDynamicFilters` to seed the editable pickers**

Find `_loadDynamicFilters()` (it currently calls `get_toc_pending_filters` and `_renderPendingBanner`). Replace its body with a call to `wkp_get_filter_universe` that:
1. stores `this._filterUniverse = m`,
2. seeds `this._selWo/_selSo/_selPo` from `m.statuses` defaults (the `wo_statuses/so_statuses/po_statuses` arrays),
3. seeds `this._selWh = m.wh_default` and `this._selCompany = m.company_default`,
4. mounts the widgets via the Step-2 builders onto `#wkp-so-ms`, `#wkp-wo-ms`, `#wkp-po-ms`, `#wkp-wh-ms`, `#wkp-company-ms`,
5. clears the Load dirty flag.

```javascript
  _loadDynamicFilters() {
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.wkp_get_filter_universe",
      callback: (r) => {
        const m = (r && r.message) || {};
        this._filterUniverse = m;
        const st = m.statuses || {};
        this._selWo = (st.wo_statuses || []).slice();
        this._selSo = (st.so_statuses || []).slice();
        this._selPo = (st.po_statuses || []).slice();
        this._selWh = (m.wh_default || []).slice();
        this._selCompany = m.company_default || "";
        this._wkpPairMulti(document.getElementById("wkp-so-ms"), "so", st.all_so_statuses || []);
        this._wkpPairMulti(document.getElementById("wkp-wo-ms"), "wo", st.all_wo_statuses || []);
        this._wkpPairMulti(document.getElementById("wkp-po-ms"), "po", st.all_po_statuses || []);
        this._wkpLinkMulti(document.getElementById("wkp-wh-ms"), "wh", "Warehouse", {});
        this._wkpSingleLink(document.getElementById("wkp-company-ms"), "company", "Company");
        this._clearLoadDirty();
      },
    });
  }
```

> `_wkpPairMulti` maps the `key` ("so"/"wo"/"po") to `this._selSo/_selWo/_selPo`; `_wkpLinkMulti("wh", ...)` to `this._selWh`; `_wkpSingleLink("company", ...)` to `this._selCompany`. Implement that mapping inside the builders (a small `{so:"_selSo", wo:"_selWo", po:"_selPo", wh:"_selWh"}` lookup).

- [ ] **Step 4: Load button + dirty helpers**

In `_bindControls()` add:
```javascript
    const loadBtn = document.getElementById("wkp-load-btn");
    if (loadBtn) loadBtn.addEventListener("click", () => { this._clearLoadDirty(); this.load(); });
```
And add the two helpers on the class:
```javascript
  _markLoadDirty() {
    const b = document.getElementById("wkp-load-btn");
    if (b) b.classList.add("wkp-load-dirty");
  }
  _clearLoadDirty() {
    const b = document.getElementById("wkp-load-btn");
    if (b) b.classList.remove("wkp-load-dirty");
  }
```

- [ ] **Step 5: Thread `warehouses` + `company` into EVERY data `frappe.call`**

Find every `frappe.call` that passes `wo_statuses`/`so_statuses`/`po_statuses` (search `wo_statuses : JSON.stringify`). For `simulate_kitting`, `get_open_work_orders`, `get_dispatch_bottleneck`, `get_item_wo_summary` add to their `args`:
```javascript
        warehouses : JSON.stringify(this._selWh || []),
        company    : this._selCompany || "",
```
(Leave the AI/cost/audit calls alone.)

- [ ] **Step 6: node --check**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "JS OK"
```
Expected: `JS OK`.

- [ ] **Step 7: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js
git commit -m "feat(wkp): editable SO/WO/PO + warehouse + company pickers, onload from TOC Settings, kwarg threading"
```

---

## Task 7: Frontend — port the inline sort picker

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js`.

- [ ] **Step 1: Port the sort controller**

From `item_short_surplus.js`, port the sort logic that drives `.iss-sortpicker` / `.iss-sortdir` / `.iss-sortpicker-opts` (search `iss-sortpicker` in that file). Adapt:
- DOM ids → `#wkp-sortpicker`, `#wkp-sortpicker-opts`, `#wkp-sortpicker-value`, `#wkp-sortdir`, `#wkp-sortdir-icon`, `#wkp-sortdir-label`, `#wkp-sortclear`, `#wkp-sortpicker-dropdown`.
- Column source: build the searchable column list from the **active tab's table** columns. WKP renders plain HTML tables per pane (not one Tabulator) — so implement sort as: read the active pane's `<table>`, collect its `<th>` text as the column options, and on apply, sort the `<tbody>` rows by the chosen column cell text (numeric-aware: parse `data-sort` attribute if present, else the cell text stripped of commas/units), then re-append in order. Auto-scroll the table so the column header is visible.
- Wire it in `_bindControls()` (`this._initSortBar()`), and re-init the column list on `_switchTab()` (so the options match the active tab).

- [ ] **Step 2: node --check + manual sort test**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "JS OK"
```
Then (manual, after Task 9 build): open `/app/wo-kitting-planner`, pick a column in the Sort dropdown, toggle direction → the active table reorders and scrolls the column into view.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js
git commit -m "feat(wkp): ported inline column sort picker (item-short-surplus style)"
```

---

## Task 8: Frontend — slim the summary strip (table-first) + filter-row/sort-bar CSS

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.css`.

- [ ] **Step 1: Compact the summary cards**

Find `.wkp-summary` and `.wkp-sum-card` rules. Override (append at end of file so it wins) to make a single-line compact chip strip — keep the colors/metrics, shrink padding/font, drop the tall card layout:

```css
/* 2026-06-05 — table-first: compact the summary strip so the table dominates. */
.wkp-summary { display:flex; flex-wrap:wrap; gap:8px; padding:6px 0; }
.wkp-summary .wkp-sum-card {
    flex:0 0 auto; display:flex; align-items:center; gap:8px;
    padding:5px 10px; min-width:0; border-radius:8px;
}
.wkp-summary .wkp-sum-icon { font-size:13px; }
.wkp-summary .wkp-sum-val  { font-size:15px; line-height:1; }
.wkp-summary .wkp-sum-lbl  { font-size:10.5px; }
.wkp-summary .wkp-sum-hint { display:none; }     /* recover vertical space */
@media (max-width: 1100px) { .wkp-summary .wkp-sum-lbl { display:none; } }
```

- [ ] **Step 2: Add filter-row + sort-bar + multiselect CSS**

Port the `iss-multiselect*`, `iss-chip*`, `iss-sortbar`/`iss-sortpicker*` styles from `item_short_surplus.css` into `wo_kitting_planner.css` renamed `iss-`→`wkp-ms-` / `wkp-sort*`, plus the filter-row layout:

```css
.wkp-filter-row { display:flex; flex-wrap:wrap; gap:8px 10px; align-items:flex-end; }
.wkp-fr-group { display:flex; flex-direction:column; gap:3px; min-width:150px; }
.wkp-fr-group.wkp-fr-wide { flex:1 1 220px; }
.wkp-fr-label { font-size:10.5px; font-weight:600; color:var(--slate-500,#64748b);
    text-transform:uppercase; letter-spacing:.03em; }
.wkp-load-btn.wkp-load-dirty { animation: wkp-pulse 1.1s ease-in-out infinite; }
@keyframes wkp-pulse { 0%,100%{ box-shadow:0 0 0 0 rgba(99,102,241,.5);} 50%{ box-shadow:0 0 0 4px rgba(99,102,241,0);} }
```
(Port the `.wkp-ms-*` dropdown/chip/option styles verbatim from the `iss-` versions — they carry the proven chip strip + fixed-position dropdown + selected-first look.)

- [ ] **Step 3: Build + visual check**

```bash
cd /workspace/development/frappe-bench
bench build --app chaizup_toc 2>&1 | tail -2
bench --site development.localhost clear-cache
```
Then hard-reload `/app/wo-kitting-planner`: the filter row shows 5 editable pickers + Load; summary is a compact chip strip; the table has more vertical room.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.css
git commit -m "feat(wkp): slim summary strip + filter-row/sort-bar/multiselect CSS"
```

---

## Task 9: End-to-end verification (onload parity + warehouse scope + status + sort)

**Files:** none (verification only).

- [ ] **Step 1: Onload parity (no-surprise principle)**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import json
from chaizup_toc.api.wo_kitting_api import get_open_work_orders, get_toc_pending_filters, wkp_get_filter_universe
# defaults the UI seeds with:
u = wkp_get_filter_universe()
wo_def = u["statuses"]["wo_statuses"]
# get_open_work_orders with the seeded defaults must equal the no-arg call (TOC Settings is the same source)
a = get_open_work_orders()
b = get_open_work_orders(wo_statuses=json.dumps(wo_def))
print("no-arg WOs:", len(a), "| seeded-default WOs:", len(b), "| equal:", len(a)==len(b))
PY
```
Expected: `equal: True` (seeding from TOC Settings reproduces today's view).

- [ ] **Step 2: Warehouse scope narrows; all = today**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import json, frappe
from chaizup_toc.api.wo_kitting_api import get_open_work_orders
allw = get_open_work_orders()
whs = frappe.get_all("Work Order", filters={"docstatus":1}, pluck="fg_warehouse", limit=5)
wh = next((w for w in whs if w), None)
one = get_open_work_orders(warehouses=json.dumps([wh])) if wh else []
print("all:", len(allw), "| one wh:", len(one), "| narrowed:", len(one) <= len(allw))
PY
```
Expected: `narrowed: True`.

- [ ] **Step 3: Manual UI pass** (after build) on `/app/wo-kitting-planner`:
  - Filter row shows SO/WO/PO/Warehouses multiselects + Company + Load; all pre-checked to TOC Settings defaults.
  - Unticking a status pulses Load; clicking Load recalculates the tabs.
  - Selecting a warehouse + Load → WO list / shortage / dispatch narrow to it.
  - Sort dropdown sorts the active table; direction toggle works; clear resets.
  - Summary strip is compact; table has the vertical space.
  - No console errors; no blank page (POR-023 ok).

- [ ] **Step 4: Commit (verification notes, allow-empty)**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git commit --allow-empty -m "test(wkp): phase-A e2e verification (onload parity + warehouse scope + sort)"
```

---

## Task 10: Docs — update the page `.MD`

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.MD`.

- [ ] **Step 1: Add a Phase-A section + sync block**

Append a section documenting: the TS-001 **reversal** (per-report editable pickers are back, user-approved 2026-06-05; banner removed), the new `wkp_get_filter_universe` endpoint, the warehouse/company scoping (COALESCE line/header warehouse; blank = all = today), the ported multiselect + sort widgets, and the slim summary. Include the RESTRICTED notes: blank status ⇒ TOC Settings defaults; `has_column` guard on workflow_state; keep `#wkp-status-filter` hidden; new kwargs default to today's behavior; HTML zero-apostrophe rule. Add a `[chaizup_toc · wo_kitting_planner · WKP-PhaseA · 2026-06-05]` sync block summarizing the change.

- [ ] **Step 2: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.MD
git commit -m "docs(wkp): document phase-A filters + warehouse context + sort + slim UI"
```

---

## Final verification checklist (Phase A)

- [ ] `wkp_get_filter_universe` returns statuses + warehouse/company options + TOC-Settings defaults.
- [ ] Warehouse/company kwargs scope Bin/WO/PO/MR/SO; blank = identical to today (onload parity proven).
- [ ] Editable SO/WO/PO/Warehouse/Company pickers seed from TOC Settings; Load recalculates; per-keystroke does NOT.
- [ ] Inline sort sorts the active table + scrolls the column into view.
- [ ] Summary strip slim; table-first; no surprise for existing users.
- [ ] `node --check` clean; HTML zero raw apostrophes; `bench build` clean.
- [ ] DOM IDs `#wsum-*` / `#wkp-pane-*` / `#wkp-status-filter` preserved; API method names + schemas unchanged.

## Notes for the executor

- **No-surprise is the acceptance bar.** Task 9 Step 1 must show onload parity before you call Phase A done.
- The frontend widget/sort ports are from `item-short-surplus` — keep the **2026-06-05 fixes** (change-event checkboxes, selected-first dropdown, sort picker). Don't reintroduce the label-click double-fire.
- Backend: every warehouse clause is **conditional** — only emit it (and its `whs` param) when `wh_active`. Blank ⇒ no predicate.
- Don't touch the AI tab (it now uses OpenAI — separate, done). Phase B (dual-UOM + drill-down + XLSX) and the bug audit are separate plans.
