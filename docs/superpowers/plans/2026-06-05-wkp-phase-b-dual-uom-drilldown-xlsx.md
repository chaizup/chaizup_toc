# WO Kitting Planner — Phase B (Dual UOM + Drill-down + XLSX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every qty cell on every WKP tab show both UOMs uniformly, let a user click any qty cell to open a both-UOM per-voucher drill-down modal, and add a branded multi-sheet XLSX export — without removing the existing CSV/PDF/email exports or changing any computed number.

**Architecture:** Backend already computes a per-item "secondary" (higher) UOM via `_get_secondary_uom` and already ships `secondary_uom`/`secondary_qty` for *some* fields. Phase B (1) standardises that into one decorator so EVERY qty field on EVERY tab payload carries a paired higher-UOM value, (2) adds a whitelisted both-UOM voucher-drilldown endpoint the JS opens on qty-cell click, and (3) adds a new `export_xlsx_kitting` whitelisted method built on openpyxl modelled on `item_short_surplus_api.export_xlsx`. Frontend gets one shared stacked-cell renderer applied everywhere, a `wkp-m2-*` modal, and an XLSX toolbar button.

**Tech Stack:** Frappe v16, MariaDB, `frappe.db.sql`, openpyxl, vanilla JS + Tabulator-free plain HTML tables.

---

## ⚠️ Read before starting (codebase rules)

- **Files (all relative to `apps/chaizup_toc/`):**
  - API: `chaizup_toc/api/wo_kitting_api.py`
  - Page: `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.{html,js,css,MD}`
  - Reference (XLSX model): `chaizup_toc/api/item_short_surplus_api.py` (`export_xlsx` ~line 1713, `_pick_higher_uoms` ~207)
- **Higher-UOM math is FIXED:** higher (secondary) qty = `stock_qty / conversion_factor`, where the chosen UOM is the SMALLEST `UOM Conversion Detail.conversion_factor > 1` (closest higher unit). This is exactly what `_get_secondary_uom(item_codes)` already returns: `{item_code: {"uom": str, "factor": float}}`. NEVER invent a different conversion. Items with no CF>1 show primary only (no secondary line).
- **Don't change any computed number.** Phase B is presentational + export + drilldown. The stock-UOM value stays the source of truth; the higher-UOM value is always derived `= stock/factor`, rounded to 3 dp for data, 2 dp for display.
- **HTML rule (POR-023):** ZERO raw single quotes in `wo_kitting_planner.html` outside HTML comments. Use `&apos;`/`&quot;`. Lint after any HTML edit (Task 1 of Phase A had the lint; reuse it).
- **DANGER (existing):** drill-down is **cell-click**, never row-click (row drag = priority reorder on the WO-plan tab). Keep qty-cell click isolated; `stopPropagation` so it never triggers row drag/seq handlers.
- **Additive exports:** the new XLSX button must NOT replace `#wkp-export-csv` / `#wkp-export-pdf` / `#wkp-send-email`. Those stay.
- **Keep contracts:** existing API method names + return schemas unchanged; only ADD fields (the `_higher` pairs) and ADD new endpoints. Existing cells that already render a secondary line must keep working.
- **JS↔CSS parity:** every new `wkp-m2-*` / `wkp-qty-*` class the JS emits must have a CSS rule (verify with `comm`, as in Phase A Task 8).
- **Run tests with:** `cd /workspace/development/frappe-bench && bench --site development.localhost console` (heredoc) or `bench --site development.localhost execute <dotted.fn>`. JS: `node --check`. Build: `bench build --app chaizup_toc && bench --site development.localhost clear-cache`. openpyxl is available in the bench venv (item-short-surplus already imports it).
- **Branch:** `feat/configurable-automation-triggers`. PRE-EXISTING dirty files (item_projection_*, toc_item_settings.*, mr_generator.py, FORMULAS.md, etc.) are NOT part of this work — `git add` ONLY the exact files each task changes; never `git add -A`.
- **No-surprise:** existing users must see the SAME numbers; only an extra higher-UOM line appears under each qty, a clickable affordance, and a new export button.

---

## File Structure (Phase B)

| File | Phase-B responsibility |
|---|---|
| `wo_kitting_api.py` | `_higher_uom_pair(item_code, stock_qty, sec_map)` helper; `_decorate_qty_pairs(rows, qty_fields, item_key)` that adds `<field>_higher` `{uom, qty}` for each row; apply it in `simulate_kitting`, `get_dispatch_bottleneck`, `get_item_wo_summary` payloads. New `get_qty_drilldown(item_code, metric, filters...)` (both-UOM per-voucher breakdown). New `export_xlsx_kitting(filters)` (openpyxl, multi-sheet). |
| `wo_kitting_planner.js` | `_qtyCell(stockQty, stockUom, higher)` shared stacked-cell renderer used by `_buildRow` + shortage + dispatch + item-view renderers; `_bindQtyCellClicks()` (cell-click → drilldown); `_openQtyDrilldown(...)` (`wkp-m2-*` modal, both UOMs); `_exportXLSX()` toolbar handler. |
| `wo_kitting_planner.html` | XLSX button in the export group; `wkp-m2-*` drill-down modal shell. |
| `wo_kitting_planner.css` | `.wkp-qty-*` uniform cell styles + `.wkp-qty-clickable` affordance; `wkp-m2-*` modal styles. |
| `wo_kitting_planner.MD` | Phase-B section + sync block. |

---

## Task 1: Backend — uniform dual-UOM decorator

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: Add the decorator helpers** next to `_get_secondary_uom` (search `def _get_secondary_uom`):

```python
def _higher_uom_pair(stock_qty, sec):
    """Given a stock-UOM qty and the item's secondary-UOM entry
    (sec = {"uom","factor"} from _get_secondary_uom, or falsy), return the
    paired higher-UOM dict {"uom": str, "qty": float}. When the item has no
    higher UOM, returns {"uom": "", "qty": None} (caller shows primary only).
    Higher qty is ALWAYS stock_qty / factor — never any other conversion."""
    if not sec or not sec.get("factor"):
        return {"uom": "", "qty": None}
    return {"uom": sec.get("uom", ""), "qty": round(flt(stock_qty) / flt(sec["factor"]), 3)}


def _decorate_qty_pairs(rows, qty_fields, item_key="item_code", sec_map=None):
    """For each row in `rows`, add `<field>_higher` = {"uom","qty"} for every
    field name in `qty_fields`, using the row's item (row[item_key]) higher-UOM.
    Mutates rows in place and returns them. `sec_map` (item_code -> sec) may be
    passed to avoid re-querying; otherwise it is built from the rows' items.
    Side-effect free except the added keys. Existing fields are untouched."""
    rows = rows or []
    if sec_map is None:
        items = {r.get(item_key) for r in rows if r.get(item_key)}
        sec_map = _get_secondary_uom(items)
    for r in rows:
        sec = sec_map.get(r.get(item_key))
        for f in qty_fields:
            if f in r:
                r[f"{f}_higher"] = _higher_uom_pair(r.get(f) or 0, sec)
    return rows
```

Add a CONTEXT/RESTRICT comment block above (match file style): note the fixed conversion rule and that this is additive/presentational.

- [ ] **Step 2: Verify the helpers**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
from chaizup_toc.api.wo_kitting_api import _higher_uom_pair, _decorate_qty_pairs
print("pair:", _higher_uom_pair(5000, {"uom":"Kg","factor":1000}))   # {'uom':'Kg','qty':5.0}
print("none:", _higher_uom_pair(5000, None))                         # {'uom':'','qty':None}
rows=[{"item_code":"X","qty":5000,"other":3}]
print("dec:", _decorate_qty_pairs(rows, ["qty"], sec_map={"X":{"uom":"Kg","factor":1000}}))
PY
```
Expected: `{'uom': 'Kg', 'qty': 5.0}`; `{'uom': '', 'qty': None}`; row gains `qty_higher: {'uom':'Kg','qty':5.0}`, `other` untouched.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): dual-UOM pair decorator helpers"
```

---

## Task 2: Backend — apply the decorator across tab payloads

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

The goal: every qty field returned by the three table endpoints carries a `<field>_higher`. READ each function's return shape first and list its qty fields; apply `_decorate_qty_pairs` to the row list (and to nested component lists where present) just before returning.

- [ ] **Step 1: `simulate_kitting`** — find the final rows list it returns (WO-plan rows). Identify the qty fields actually present on each row (e.g. `remaining_qty`, `produced_qty`, and any shortage/consume qty). The row already carries `secondary_uom`/`secondary_factor` for `remaining_qty` — do NOT remove those (back-compat); ADD `_higher` pairs for ALL qty fields via:
```python
    _decorate_qty_pairs(rows, ["remaining_qty", "produced_qty"], item_key="item_code")
```
Adjust the field list to the REAL qty fields on the row (read the row dict). If rows carry a nested `components`/`shortage` list with its own item + qty, decorate that list too with its own item key and qty fields.

- [ ] **Step 2: `get_dispatch_bottleneck`** — find its returned rows (per-FG-item: FG stock, SO demand, shortfall, etc.). Decorate with the real qty field names, `item_key` = the FG item field on those rows (verify; likely `item_code` or `production_item`).

- [ ] **Step 3: `get_item_wo_summary`** — decorate its rows' qty fields with the row's item key.

- [ ] **Step 4: Verify each endpoint now ships `_higher` on its qty fields**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import json, frappe
from chaizup_toc.api.wo_kitting_api import simulate_kitting, get_open_work_orders, get_dispatch_bottleneck, get_item_wo_summary
wos = json.dumps([w["name"] for w in (get_open_work_orders() or [])][:5])
sk = simulate_kitting(wos) or {}
rows = sk.get("rows", sk if isinstance(sk, list) else [])
print("simulate row0 higher keys:", [k for k in (rows[0].keys() if rows else []) if k.endswith("_higher")])
d = get_dispatch_bottleneck() or {}
drows = d.get("rows", d if isinstance(d, list) else [])
print("dispatch row0 higher keys:", [k for k in (drows[0].keys() if drows else []) if k.endswith("_higher")])
iv = get_item_wo_summary() or []
print("itemview row0 higher keys:", [k for k in (iv[0].keys() if iv else []) if k.endswith("_higher")])
print("OK")
PY
```
Expected: each non-empty rowset shows at least one `*_higher` key; `OK`. (Empty rowsets on dev are acceptable — then verify by reading the code that the decorate call is on the return path.)

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): ship dual-UOM pairs on simulate/dispatch/item-view rows"
```

---

## Task 3: Backend — both-UOM qty drill-down endpoint

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: Inspect existing drilldown** — grep for any existing per-voucher breakdown (`get_material_supply_detail`, `get_voucher_drilldown`, or the WO-modal data source around lines 1200-1400). If one exists that returns per-voucher rows (WO/SO/PO/MR contributing to a metric), EXTEND it to also return both UOMs; otherwise add a new endpoint. Decide based on what you find; document which you chose.

- [ ] **Step 2: Add (or extend to) `get_qty_drilldown`**

```python
@frappe.whitelist()
def get_qty_drilldown(item_code, metric, warehouses=None, company=None,
                      wo_statuses=None, so_statuses=None, po_statuses=None):
    """Per-voucher breakdown for one item's one metric, in BOTH UOMs.
    `metric` ∈ {"stock","pending_so","pending_wo","pending_po","pending_mr",
                "shortage","remaining_produce"} (support the metrics the qty
    cells expose; map unknown metric → empty list, never error).
    Returns {item_code, item_name, stock_uom, higher_uom, factor,
             rows: [{voucher_type, voucher, party_or_wh, qty_stock, qty_higher,
                     ...metric-specific cols...}], totals: {qty_stock, qty_higher}}.
    Warehouse/company/status kwargs scope it exactly like the table endpoints
    (reuse _wkp_resolve_wh_scope + the _wkp_*_status_clause helpers)."""
    sec = _get_secondary_uom({item_code}).get(item_code) or {}
    factor = flt(sec.get("factor")) or 0.0
    higher_uom = sec.get("uom", "")
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom") or ""
    item_name = frappe.db.get_value("Item", item_code, "item_name") or item_code

    def H(q):
        return round(flt(q) / factor, 3) if factor else None

    wh_scope, wh_active = _wkp_resolve_wh_scope(warehouses, company)
    rows = []
    # Build per-voucher rows for the requested metric. Implement the metrics
    # that the qty cells actually drill into; for each, SELECT the contributing
    # vouchers (scoped by wh_active/whs + the relevant _wkp_*_status_clause) and
    # append {voucher_type, voucher, party_or_wh, qty_stock, qty_higher: H(q)}.
    # EXAMPLES (adapt SQL to the real schema already used elsewhere in this file):
    #   "stock"      → tabBin rows per warehouse (scoped): qty = actual_qty
    #   "pending_po" → tabPurchase Order Item (open, status-scoped, wh COALESCE):
    #                  qty = qty - received_qty
    #   "pending_so" → tabSales Order Item (open): qty = qty - delivered_qty
    #   "pending_wo" → tabWork Order (open, fg_warehouse-scoped): qty = qty - produced_qty
    #   "pending_mr" → tabMaterial Request Item (open): qty = qty - ordered_qty
    # Reuse the SAME SQL fragments those metrics use in _build_stock_pool /
    # get_dispatch_bottleneck so the drilldown totals reconcile with the cell.
    total_stock = round(sum(flt(r["qty_stock"]) for r in rows), 3)
    return {
        "item_code": item_code, "item_name": item_name,
        "stock_uom": stock_uom, "higher_uom": higher_uom, "factor": factor,
        "rows": rows,
        "totals": {"qty_stock": total_stock, "qty_higher": H(total_stock)},
    }
```

Implement at least the metrics the qty cells expose today (read the JS cells / spec; `stock`, `pending_po`, `pending_so`, `pending_wo`, `pending_mr`, and the WO-plan `remaining_produce`). **Critical:** for each metric, reuse the EXACT scoping + status clauses + warehouse predicates the corresponding table query uses, so the drilldown total equals the cell value. If a metric is genuinely not drillable, return an empty `rows` with a correct `totals` and note it.

- [ ] **Step 3: Verify totals reconcile with a cell**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.api.wo_kitting_api import get_qty_drilldown
it = frappe.db.get_value("Item", {"is_stock_item":1}, "name")
d = get_qty_drilldown(it, "stock")
print("item:", it, "| stock_uom:", d["stock_uom"], "| higher:", d["higher_uom"], "| factor:", d["factor"])
print("rows:", len(d["rows"]), "| total_stock:", d["totals"]["qty_stock"], "| total_higher:", d["totals"]["qty_higher"])
# stock total should equal sum of Bin.actual_qty for this item
import frappe
binqty = frappe.db.sql("SELECT IFNULL(SUM(actual_qty),0) FROM `tabBin` WHERE item_code=%s", it)[0][0]
print("Bin sum:", binqty, "| reconciles:", abs(float(binqty) - d["totals"]["qty_stock"]) < 0.001)
PY
```
Expected: drilldown `stock` total == Σ Bin.actual_qty for the item; higher = total/factor (or None if no higher UOM).

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): both-UOM per-voucher qty drilldown endpoint"
```

---

## Task 4: Backend — `export_xlsx_kitting` (openpyxl, multi-sheet, both UOMs)

**Files:** Modify `chaizup_toc/api/wo_kitting_api.py`.

- [ ] **Step 1: Study the model** — read `item_short_surplus_api.export_xlsx` (~line 1713): the style tokens (header_fill/font, borders, zebra), the `_write_main` helper, `freeze_panes`, column widths, and the `frappe.response` streaming tail (`filename` + `filecontent` + `type="binary"` via `BytesIO`/`wb.save`). Mirror that structure.

- [ ] **Step 2: Add `export_xlsx_kitting`**

```python
@frappe.whitelist()
def export_xlsx_kitting(filters=None):
    """Branded multi-sheet XLSX for the WO Kitting Planner. Streams to browser
    via frappe.response (filename + filecontent + type=binary). Sheets:
      1. Main            — simulation rows, every qty in BOTH UOMs (paired cols)
      2. Filters & Run   — chosen statuses/warehouses/company + run timestamp
      3. Material Shortage (sorted) — shortage components, both UOMs
      4. Dispatch        — FG vs SO demand, both UOMs
    Additive: does NOT touch CSV/PDF/email. Model: item_short_surplus_api.export_xlsx.
    """
    import json
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    f = frappe.parse_json(filters) if isinstance(filters, str) else (filters or {})
    warehouses = json.dumps(f.get("warehouses") or [])
    company    = f.get("company") or ""
    wo_statuses = json.dumps(f.get("wo_statuses") or [])
    so_statuses = json.dumps(f.get("so_statuses") or [])
    po_statuses = json.dumps(f.get("po_statuses") or [])
    work_orders = json.dumps(f.get("work_orders") or [w["name"] for w in
                  (get_open_work_orders(wo_statuses=wo_statuses, warehouses=warehouses, company=company) or [])])

    sim   = simulate_kitting(work_orders, stock_mode=f.get("stock_mode","current_only"),
              calc_mode=f.get("calc_mode","isolated"), wo_statuses=wo_statuses,
              po_statuses=po_statuses, warehouses=warehouses, company=company) or {}
    rows  = sim.get("rows", sim if isinstance(sim, list) else [])
    disp  = get_dispatch_bottleneck(so_statuses=so_statuses, po_statuses=po_statuses,
              warehouses=warehouses, company=company) or {}
    drows = disp.get("rows", disp if isinstance(disp, list) else [])

    # ── brand style tokens (mirror item_short_surplus export_xlsx) ──
    header_fill = PatternFill("solid", fgColor="111827")
    header_font = Font(bold=True, color="FFFFFF", size=10)
    thin = Side(style="thin", color="E5E7EB")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    def write_sheet(ws, title, headers, data_rows):
        ws.title = title
        for c, h in enumerate(headers, 1):
            cell = ws.cell(row=1, column=c, value=h)
            cell.fill = header_fill; cell.font = header_font
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = border
        for ri, rr in enumerate(data_rows, 2):
            for ci, val in enumerate(rr, 1):
                cell = ws.cell(row=ri, column=ci, value=val)
                cell.border = border
                if ri % 2 == 0:
                    cell.fill = PatternFill("solid", fgColor="F9FAFB")
        ws.freeze_panes = "A2"
        for c, h in enumerate(headers, 1):
            ws.column_dimensions[get_column_letter(c)].width = max(12, min(40, len(str(h)) + 4))

    wb = Workbook()

    # Sheet 1 — Main (qty in both UOMs as paired columns). ADAPT field names to
    # the REAL row keys; use the *_higher pairs added in Task 2.
    main_headers = ["WO","Item Code","Item","Remaining (Stock)","UOM","Remaining (Higher)","Higher UOM",
                    "Produced (Stock)","Produced (Higher)"]
    main_data = []
    for r in rows:
        rh = r.get("remaining_qty_higher") or {}; ph = r.get("produced_qty_higher") or {}
        main_data.append([
            r.get("wo",""), r.get("item_code",""), r.get("item_name",""),
            r.get("remaining_qty",0), r.get("uom",""), rh.get("qty"), rh.get("uom",""),
            r.get("produced_qty",0), ph.get("qty"),
        ])
    write_sheet(wb.active, "Main", main_headers, main_data)

    # Sheet 2 — Filters & Run Info
    ws2 = wb.create_sheet("Filters & Run Info")
    info = [
        ("Generated", frappe.utils.now_datetime().strftime("%Y-%m-%d %H:%M:%S")),
        ("Company", company or "(all)"),
        ("Warehouses", ", ".join(f.get("warehouses") or []) or "(all)"),
        ("WO Statuses", ", ".join(f.get("wo_statuses") or []) or "(TOC default)"),
        ("SO Statuses", ", ".join(f.get("so_statuses") or []) or "(TOC default)"),
        ("PO Statuses", ", ".join(f.get("po_statuses") or []) or "(TOC default)"),
        ("Stock Mode", f.get("stock_mode","current_only")),
        ("Work Orders", str(len(rows))),
    ]
    write_sheet(ws2, "Filters & Run Info", ["Field","Value"], [[k, v] for k, v in info])

    # Sheet 3 — Material Shortage (sorted). Pull shortage rows from sim (the
    # shortage list the shortage tab uses) — read the real key; decorate both UOMs.
    short_rows = sim.get("shortage", []) if isinstance(sim, dict) else []
    sh_headers = ["Item Code","Item","Short Qty (Stock)","UOM","Short Qty (Higher)","Higher UOM"]
    sh_data = []
    for r in sorted(short_rows, key=lambda x: -(x.get("shortage_qty") or 0)):
        sh = r.get("shortage_qty_higher") or {}
        sh_data.append([r.get("item_code",""), r.get("item_name",""),
                        r.get("shortage_qty",0), r.get("uom",""), sh.get("qty"), sh.get("uom","")])
    write_sheet(wb.create_sheet("Material Shortage"), "Material Shortage", sh_headers, sh_data)

    # Sheet 4 — Dispatch (FG vs SO demand, both UOMs)
    dp_headers = ["Item Code","Item","FG Stock (Stock)","SO Demand (Stock)","Shortfall (Stock)","UOM",
                  "FG Stock (Higher)","Higher UOM"]
    dp_data = []
    for r in drows:
        fh = r.get("fg_stock_higher") or {}
        dp_data.append([r.get("item_code",""), r.get("item_name",""),
                        r.get("fg_stock",0), r.get("so_demand",0), r.get("shortfall",0),
                        r.get("uom",""), fh.get("qty"), fh.get("uom","")])
    write_sheet(wb.create_sheet("Dispatch"), "Dispatch", dp_headers, dp_data)

    buf = BytesIO(); wb.save(buf); buf.seek(0)
    frappe.response["filename"] = f"wo_kitting_planner_{frappe.utils.nowdate()}.xlsx"
    frappe.response["filecontent"] = buf.read()
    frappe.response["type"] = "binary"
```

**IMPORTANT:** the row-key names above (`remaining_qty`, `shortage_qty`, `fg_stock`, `so_demand`, `shortfall`, the `sim["shortage"]` key, the dispatch item key) are ASSUMPTIONS — VERIFY each against the real return shapes (you read them in Task 2/3) and adapt. The workbook must build from the SAME data the tabs render so numbers reconcile. If a sheet's source list isn't available from these endpoints, fetch it the same way the corresponding tab does.

- [ ] **Step 2b: Verify it builds a real workbook**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import frappe
from chaizup_toc.api.wo_kitting_api import export_xlsx_kitting
frappe.response.clear() if hasattr(frappe.response,"clear") else None
export_xlsx_kitting(filters="{}")
fc = frappe.response.get("filecontent")
print("filename:", frappe.response.get("filename"), "| type:", frappe.response.get("type"), "| bytes:", len(fc) if fc else 0)
# sanity: it's a real xlsx (zip magic 'PK')
print("xlsx magic:", fc[:2] == b"PK" if fc else False)
# open it back and list sheets
from io import BytesIO; from openpyxl import load_workbook
wb = load_workbook(BytesIO(fc))
print("sheets:", wb.sheetnames)
PY
```
Expected: non-zero bytes; `xlsx magic: True`; sheets == `['Main','Filters & Run Info','Material Shortage','Dispatch']`.

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/api/wo_kitting_api.py
git commit -m "feat(wkp): export_xlsx_kitting branded multi-sheet workbook (both UOMs)"
```

---

## Task 5: Frontend — uniform dual-UOM stacked cell

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js` and `.css`.

- [ ] **Step 1: Add the shared renderer** to the controller (near `_buildRow`). It produces the existing `.wkp-qty-primary/-uom/-secondary` markup so styling stays consistent, and tags the cell as clickable for drilldown:

```javascript
  // 2026-06-05 (Phase B): single source of truth for a qty cell. Renders the
  // stock value + UOM, and (when present) the higher-UOM line beneath. `higher`
  // is the backend `<field>_higher` = {uom, qty} pair. `drill` (optional) =
  // {item, metric} makes the cell click-to-drilldown. NEVER recompute higher
  // here — it is shipped by the backend (= stock / factor).
  _qtyCell(stockQty, stockUom, higher, drill) {
    const sec = (higher && higher.uom && higher.qty != null)
      ? `<div class="wkp-qty-secondary">${_fmt_num(higher.qty, 2)} ${_esc(higher.uom)}</div>`
      : "";
    const drillAttr = drill
      ? ` data-drill-item="${_esc(drill.item)}" data-drill-metric="${_esc(drill.metric)}"`
      : "";
    const cls = drill ? "wkp-qty-clickable" : "";
    return `<div class="wkp-qty-cell ${cls}"${drillAttr}>`
         + `<div class="wkp-qty-primary">${_fmt_num(stockQty, 0)}</div>`
         + `<div class="wkp-qty-uom">${_esc(stockUom || "")}</div>${sec}</div>`;
  }
```

- [ ] **Step 2: Use `_qtyCell` in every qty `<td>`** across `_buildRow` (WO-plan), the shortage renderer, the dispatch renderer, and the item-view renderer. For each qty cell, pass the row's stock qty, its uom, the matching `row.<field>_higher`, and `{item: row.item_code, metric: "<metric>"}` for the metrics the drilldown supports (Task 3). Keep the surrounding `<td class="ta-r" data-tip=...>` wrappers and tips. Where a cell currently inlines the `wkp-qty-secondary` markup (e.g. `remaining_qty`), REPLACE that inline block with `_qtyCell(...)` so there is one renderer. Do not change which columns exist — only how their qty content is produced.

- [ ] **Step 3: CSS** — append to `.css`: ensure `.wkp-qty-cell`, `.wkp-qty-primary`, `.wkp-qty-uom`, `.wkp-qty-secondary` are styled uniformly (they mostly exist — verify and consolidate), and add the clickable affordance:
```css
.wkp-qty-clickable { cursor:pointer; border-radius:6px; transition:background .12s; }
.wkp-qty-clickable:hover { background:var(--indigo-50,#eef2ff); box-shadow:inset 0 0 0 1px var(--indigo-200,#c7d2fe); }
.wkp-qty-secondary { font-size:10.5px; color:var(--slate-500,#64748b); }
```

- [ ] **Step 4: Verify**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "JS OK"
grep -c "_qtyCell(" chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js  # expect several call sites
cd /workspace/development/frappe-bench && bench build --app chaizup_toc 2>&1 | tail -2 && bench --site development.localhost clear-cache
```
Expected: `JS OK`; `_qtyCell(` used at multiple cells; build clean.

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.css
git commit -m "feat(wkp): uniform dual-UOM stacked qty cell across all tabs"
```

---

## Task 6: Frontend — cell-click both-UOM drill-down modal

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.{html,js,css}`.

- [ ] **Step 1: Add the modal shell** to `wo_kitting_planner.html` (near the other modals; zero raw apostrophes):

```html
  <!-- 2026-06-05 (Phase B) — qty drill-down modal (both UOMs). -->
  <div class="wkp-m2-overlay" id="wkp-m2-overlay" style="display:none">
    <div class="wkp-m2" role="dialog" aria-modal="true" aria-labelledby="wkp-m2-title">
      <div class="wkp-m2-head">
        <div class="wkp-m2-title" id="wkp-m2-title">Quantity breakdown</div>
        <button class="wkp-m2-close" id="wkp-m2-close" type="button" title="Close">&times;</button>
      </div>
      <div class="wkp-m2-sub" id="wkp-m2-sub"></div>
      <div class="wkp-m2-body" id="wkp-m2-body"></div>
      <div class="wkp-m2-foot" id="wkp-m2-foot"></div>
    </div>
  </div>
```

- [ ] **Step 2: Bind cell clicks + open the modal** in the JS. In `_bindControls()` add a delegated listener (cell-click, NOT row-click; stop propagation so it never triggers row drag/seq):

```javascript
    // Phase B: qty-cell click → both-UOM drilldown. Delegated; cell-scoped so it
    // never fires the WO-row drag/seq handlers (DANGER: stays cell-click).
    document.getElementById("wkp-app").addEventListener("click", (e) => {
      const cell = e.target.closest(".wkp-qty-clickable");
      if (!cell) return;
      e.stopPropagation();
      this._openQtyDrilldown(cell.dataset.drillItem, cell.dataset.drillMetric);
    });
```
(Use the real WKP root element id/selector — verify; if it is not `#wkp-app`, use the actual page root container.)

Add the methods:
```javascript
  _openQtyDrilldown(item, metric) {
    if (!item || !metric) return;
    frappe.call({
      method: "chaizup_toc.api.wo_kitting_api.get_qty_drilldown",
      args: {
        item_code: item, metric,
        warehouses: JSON.stringify(this._selWh || []),
        company: this._selCompany || "",
        wo_statuses: JSON.stringify(this._selWo || []),
        so_statuses: JSON.stringify(this._selSo || []),
        po_statuses: JSON.stringify(this._selPo || []),
      },
      callback: (r) => this._renderQtyDrilldown(r && r.message),
    });
  }

  _renderQtyDrilldown(d) {
    if (!d) return;
    const title = document.getElementById("wkp-m2-title");
    const sub   = document.getElementById("wkp-m2-sub");
    const body  = document.getElementById("wkp-m2-body");
    const foot  = document.getElementById("wkp-m2-foot");
    title.textContent = `${d.item_name || d.item_code} — ${d.metric || ""}`;
    sub.textContent = `Stock UOM: ${d.stock_uom}${d.higher_uom ? "  ·  Higher UOM: " + d.higher_uom : ""}`;
    const rows = (d.rows || []).map((x) => `
      <tr>
        <td>${_esc(x.voucher_type || "")}</td>
        <td><a href="/app/${_esc((x.voucher_type||"").toLowerCase().replace(/ /g,"-"))}/${_esc(x.voucher||"")}" target="_blank">${_esc(x.voucher||"")}</a></td>
        <td>${_esc(x.party_or_wh || "")}</td>
        <td class="ta-r">${_fmt_num(x.qty_stock, 2)} ${_esc(d.stock_uom)}</td>
        <td class="ta-r">${x.qty_higher != null ? _fmt_num(x.qty_higher, 2) + " " + _esc(d.higher_uom) : "&mdash;"}</td>
      </tr>`).join("");
    body.innerHTML = `<table class="wkp-m2-table"><thead><tr>
        <th>Type</th><th>Voucher</th><th>Party / Warehouse</th>
        <th class="ta-r">Qty (${_esc(d.stock_uom)})</th><th class="ta-r">Qty (${_esc(d.higher_uom||"—")})</th>
      </tr></thead><tbody>${rows || `<tr><td colspan="5" class="wkp-m2-empty">No contributing vouchers.</td></tr>`}</tbody></table>`;
    const t = d.totals || {};
    foot.innerHTML = `Total: <strong>${_fmt_num(t.qty_stock,2)} ${_esc(d.stock_uom)}</strong>`
      + (t.qty_higher != null ? `  ·  <strong>${_fmt_num(t.qty_higher,2)} ${_esc(d.higher_uom)}</strong>` : "");
    document.getElementById("wkp-m2-overlay").style.display = "flex";
  }
```
Wire close: `#wkp-m2-close` and overlay backdrop click hide `#wkp-m2-overlay` (mirror the existing modal close handlers in `_bindControls`). `_esc`/`_fmt_num` already exist in the file — reuse them; do not redefine.

- [ ] **Step 3: CSS** — append `wkp-m2-*` styles (overlay, centered card, header, scrollable body, zebra `.wkp-m2-table`, totals foot). Reuse the page palette; high z-index overlay so it sits above the table; no Tailwind CDN.

- [ ] **Step 4: Verify JS + class parity**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "JS OK"
echo "--- wkp-m2-* in JS+HTML but missing in CSS (should be empty) ---"
comm -23 <(grep -ohE "wkp-m2-[a-z0-9-]+" chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html | sort -u) <(grep -oE "wkp-m2-[a-z0-9-]+" chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.css | sort -u)
python3 -c "import re;s=open('chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html').read();print('raw apostrophes:',re.sub(r'<!--.*?-->','',s,flags=re.S).count(chr(39)))"
cd /workspace/development/frappe-bench && bench build --app chaizup_toc 2>&1 | tail -2 && bench --site development.localhost clear-cache
```
Expected: `JS OK`; empty `comm` (all `wkp-m2-*` styled); apostrophes `0`; build clean.

- [ ] **Step 5: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.css
git commit -m "feat(wkp): cell-click both-UOM qty drill-down modal"
```

---

## Task 7: Frontend — XLSX export button + handler

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.{html,js}`.

- [ ] **Step 1: Add the button** to the export group in `wo_kitting_planner.html` (right after `#wkp-export-pdf`; zero apostrophes):

```html
        <button class="wkp-btn wkp-btn-sm wkp-btn-export" id="wkp-export-xlsx"
                data-tip="Export a branded multi-sheet Excel workbook (Main, Filters, Shortage, Dispatch) with every quantity in both UOMs.">
          <i class="fa-solid fa-file-excel"></i> Excel
        </button>
```

- [ ] **Step 2: Handler** — in `_bindControls()` add:
```javascript
    const xlsxBtn = document.getElementById("wkp-export-xlsx");
    if (xlsxBtn) xlsxBtn.addEventListener("click", () => this._exportXLSX());
```
And the method (download via a form-post to the whitelisted method so the binary streams as a file — mirror how Frappe triggers file downloads; `open_url_post` is available in Desk):
```javascript
  _exportXLSX() {
    const filters = {
      warehouses: this._selWh || [],
      company: this._selCompany || "",
      wo_statuses: this._selWo || [],
      so_statuses: this._selSo || [],
      po_statuses: this._selPo || [],
      stock_mode: this.stockMode || "current_only",
      calc_mode: this.calcMode || "isolated",
      work_orders: (this.rows || []).map((r) => r.wo).filter(Boolean),
    };
    open_url_post("/api/method/chaizup_toc.api.wo_kitting_api.export_xlsx_kitting",
                  { filters: JSON.stringify(filters) });
  }
```
(Verify `open_url_post` is the right Desk helper in this codebase — `_exportCSV`/`_exportPDF` may already show the project's download idiom; match whatever they use. If the project streams via `frappe.call` + blob instead, follow that.)

- [ ] **Step 3: Verify**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "JS OK"
grep -n "wkp-export-xlsx\|_exportXLSX\|export_xlsx_kitting" chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html
# CSV/PDF/email buttons STILL present (additive)?
grep -c "wkp-export-csv\|wkp-export-pdf\|wkp-send-email" chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html
python3 -c "import re;s=open('chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html').read();print('raw apostrophes:',re.sub(r'<!--.*?-->','',s,flags=re.S).count(chr(39)))"
cd /workspace/development/frappe-bench && bench build --app chaizup_toc 2>&1 | tail -2 && bench --site development.localhost clear-cache
```
Expected: `JS OK`; the three greps find the new symbols; CSV/PDF/email still present (count 3); apostrophes 0; build clean.

- [ ] **Step 4: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html
git commit -m "feat(wkp): Excel (XLSX) export button + handler (additive to CSV/PDF/email)"
```

---

## Task 8: Bug audit pass (cross-cutting)

**Files:** none expected; fixes folded where found.

- [ ] **Step 1: Audit checklist** — review the Phase-A + Phase-B surface for:
  - Dual-UOM math: every higher value is `stock/factor` (grep for any place computing higher differently or multiplying). Items with no CF>1 show primary only (no `0`/`NaN` secondary).
  - Drilldown totals reconcile with the cell they open (the metric SQL reuses the table's scoping/status/warehouse clauses).
  - Cell-click never triggers row drag/seq on the WO-plan tab (`stopPropagation` present; clickable cells only on metrics that drill).
  - XLSX is additive (CSV/PDF/email intact); workbook opens; numbers match the tabs.
  - `_fmt_num`/`_esc` reused, not redefined; no `innerHTML` of untrusted data (item names go through `_esc`).
  - No raw apostrophes in HTML; JS↔CSS parity for `wkp-m2-*`/`wkp-qty-*`.
  - Warehouse-scope conditional guard (`wh_active`) still intact from Phase A (no regression).

- [ ] **Step 2: Run the full static gate**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
python3 -m py_compile chaizup_toc/api/wo_kitting_api.py && echo "py OK"
node --check chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.js && echo "js OK"
python3 -c "import re;s=open('chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.html').read();print('raw apostrophes:',re.sub(r'<!--.*?-->','',s,flags=re.S).count(chr(39)))"
for p in wkp-m2 wkp-qty; do echo "--- $p JS/HTML not in CSS ---"; comm -23 <(grep -ohE "$p-[a-z0-9-]+" chaizup_toc/chaizup_toc/page/wo_kitting_planner/*.js chaizup_toc/chaizup_toc/page/wo_kitting_planner/*.html | sort -u) <(grep -oE "$p-[a-z0-9-]+" chaizup_toc/chaizup_toc/page/wo_kitting_planner/*.css | sort -u); done
```
Expected: `py OK`; `js OK`; apostrophes 0; both `comm` blocks empty. Fix anything that fails, then commit `fix(wkp): phase-B bug-audit fixes` (or `--allow-empty` if clean).

- [ ] **Step 3: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git commit --allow-empty -am "fix(wkp): phase-B bug-audit pass (dual-UOM math, drilldown reconcile, additive export)"
```

---

## Task 9: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Backend reconciliation**

```bash
cd /workspace/development/frappe-bench
bench --site development.localhost console <<'PY'
import json, frappe
from chaizup_toc.api.wo_kitting_api import get_open_work_orders, simulate_kitting, get_qty_drilldown, export_xlsx_kitting
# 1) every simulate row qty has a paired higher
wos = json.dumps([w["name"] for w in (get_open_work_orders() or [])][:5])
sk = simulate_kitting(wos) or {}; rows = sk.get("rows", sk if isinstance(sk,list) else [])
ok = all(("remaining_qty_higher" in r) for r in rows) if rows else True
print("all rows have remaining_qty_higher:", ok, "| rows:", len(rows))
# 2) drilldown stock total == Bin sum
it = (rows[0]["item_code"] if rows else frappe.db.get_value("Item",{"is_stock_item":1},"name"))
d = get_qty_drilldown(it, "stock")
binqty = float(frappe.db.sql("SELECT IFNULL(SUM(actual_qty),0) FROM `tabBin` WHERE item_code=%s", it)[0][0])
print("drilldown stock reconciles:", abs(binqty - d["totals"]["qty_stock"]) < 0.001)
# 3) xlsx builds with 4 sheets
export_xlsx_kitting(filters="{}")
from io import BytesIO; from openpyxl import load_workbook
wb = load_workbook(BytesIO(frappe.response["filecontent"]))
print("xlsx sheets:", wb.sheetnames)
print("DONE")
PY
```
Expected: rows have `_higher`; drilldown reconciles; sheets == the 4 expected.

- [ ] **Step 2: Manual UI pass** (after build) on `/app/wo-kitting-planner`:
  - Every qty cell on every tab shows the stock value + UOM and (where the item has a higher UOM) the higher line beneath.
  - Clicking a qty cell opens the drill-down modal with per-voucher rows in BOTH UOMs and a reconciling total; close works; clicking a qty cell does NOT start a row drag.
  - The **Excel** button downloads a workbook with 4 sheets; CSV/PDF/email still work.
  - No console errors; no blank page (POR-023).

- [ ] **Step 3: Commit (verification notes)**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git commit --allow-empty -m "test(wkp): phase-B e2e verification (dual-UOM, drilldown reconcile, 4-sheet xlsx)"
```

---

## Task 10: Docs — page `.MD`

**Files:** Modify `chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.MD`.

- [ ] **Step 1: Add a Phase-B section + sync block** documenting: the uniform `_qtyCell` + backend `_decorate_qty_pairs` (every qty carries `<field>_higher = {uom,qty}`, higher = stock/factor, fixed conversion), `get_qty_drilldown` (cell-click, both UOMs, reconciles to the cell), `export_xlsx_kitting` (4 sheets, both UOMs, additive). Include RESTRICTED notes: fixed conversion math; drilldown stays cell-click; XLSX additive (don't remove CSV/PDF/email); JS↔CSS parity for `wkp-m2-*`/`wkp-qty-*`; HTML zero-apostrophe. Add a `[chaizup_toc · wo_kitting_planner · WKP-PhaseB · 2026-06-05]` sync block.

- [ ] **Step 2: Commit**

```bash
cd /workspace/development/frappe-bench/apps/chaizup_toc
git add chaizup_toc/chaizup_toc/page/wo_kitting_planner/wo_kitting_planner.MD
git commit -m "docs(wkp): document phase-B dual-UOM + drilldown + xlsx"
```

---

## Final verification checklist (Phase B)

- [ ] Every qty field on simulate/dispatch/item-view ships `<field>_higher = {uom, qty}`; higher = stock/factor (fixed conversion).
- [ ] One `_qtyCell` renderer used by every qty column on every tab; items without a higher UOM show primary only.
- [ ] Cell-click opens both-UOM drill-down; totals reconcile with the clicked cell; never triggers row drag.
- [ ] `export_xlsx_kitting` builds a real 4-sheet workbook with both UOMs; CSV/PDF/email untouched.
- [ ] `node --check` clean; HTML zero raw apostrophes; JS↔CSS parity for `wkp-m2-*` + `wkp-qty-*`; `bench build` clean.
- [ ] No computed number changed vs Phase A (only presentation + export + drilldown added).

## Notes for the executor

- **Reconciliation is the acceptance bar:** the drill-down total and the XLSX numbers must equal what the tab cell shows. Reuse the SAME SQL scoping/status/warehouse clauses the table endpoints use — do not write parallel queries that can drift.
- The higher-UOM value is ALWAYS `stock / conversion_factor` from `_get_secondary_uom`; never invent another conversion (Phase B RESTRICT).
- Keep drill-down cell-click (row-click = priority drag on WO-plan). `stopPropagation`.
- XLSX is additive. Don't touch CSV/PDF/email.
- Verify every assumed row-key name against the real return shapes before shipping — the plan's field names (`remaining_qty`, `fg_stock`, `so_demand`, `sim["shortage"]`, etc.) are best-effort and MUST be checked.
