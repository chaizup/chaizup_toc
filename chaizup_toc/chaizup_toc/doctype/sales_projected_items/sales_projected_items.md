# Sales Projected Items — Developer Documentation

## Purpose

Child table of `Sales Projection`. Each row = one item's minimum production target for the projection period.

Columns display the item in both the user's chosen UOM and the item's base stock UOM, to help the production team understand quantities without needing to do manual conversions.

---

## DocType Summary

| Property | Value |
|----------|-------|
| Is Table | Yes (child) |
| Parent DocType | Sales Projection |
| Parent field name | `table_mibv` |
| Editable Grid | Yes |

---

## Fields

| Fieldname | Type | In Grid | Description |
|-----------|------|---------|-------------|
| `item` | Link → Item | Yes | Item code. Required. Duplicate items blocked by parent validate. |
| `item_name` | Data (fetch_from item.item_name) | Yes | Item description. Auto-fetched. Read-only. |
| `uom_unit_of_measurement` | Link → UOM | Yes | Filtered to item's valid UOMs only. Required. |
| `qty` | Float | Yes | Planned quantity in selected UOM. Required. |
| `conversion_factor` | Float | Yes | Auto-fetched from UOM Conversion Detail. 1 if UOM = stock_uom. Read-only. |
| `stock_uom` | Data (fetch_from item.stock_uom) | Yes | Item's base unit. Auto-fetched. Read-only. |
| `qty_in_stock_uom` | Float | Yes | qty × conversion_factor. Auto-computed by JS. Read-only. |

---

## UOM Filter — get_item_uoms()

`get_item_uoms()` in `sales_projected_items.py` is a `@frappe.whitelist()` Frappe link-search function.

**Called by**: `sales_projection.js` via `get_query` on the `uom_unit_of_measurement` field.

**Returns**: All UOMs available for the selected item:
- Rows from `tabUOM Conversion Detail` where `parent = item_code`
- The item's own `stock_uom` (always included via UNION)

**Why UNION not UNION ALL**: ERPNext sometimes adds the stock_uom as a 1:1 conversion row; UNION deduplicates.

### Function Signature (Frappe link-search)
```python
def get_item_uoms(doctype, txt, searchfield, start, page_len, filters):
```
Parameter names are **fixed** — Frappe passes them positionally.

---

## Auto-Computed Logic (in sales_projection.js)

| Event | Action |
|-------|--------|
| `item` changed | Clear `uom_unit_of_measurement`, reset `conversion_factor` = 1, `qty_in_stock_uom` = 0 |
| `uom_unit_of_measurement` changed | Fetch `conversion_factor`; if UOM = stock_uom → 1; else query `UOM Conversion Detail` |
| `qty` changed | `qty_in_stock_uom = qty × conversion_factor` |
| `conversion_factor` set (programmatic) | Re-trigger `qty_in_stock_uom` recompute |

`item_name` and `stock_uom` are auto-populated by Frappe's `fetch_from` mechanism — no JS needed.

---

## DANGER ZONE — Critical Field Names

> **Do NOT rename without updating sales_projection.py and sales_projection.js.**

| Fieldname | Rename impact |
|-----------|---------------|
| `item` | Breaks `_validate_no_duplicate_items()` (uses `row.item`) and all JS item events |
| `uom_unit_of_measurement` | Breaks `_setup_uom_query()` get_field ref and `uom_unit_of_measurement` JS event |
| `stock_uom` | Breaks `_fetch_conversion_factor()` fast-path check (`row.stock_uom === row.uom_unit_of_measurement`) |
| `conversion_factor` | Breaks `_compute_stock_qty()` and `conversion_factor` JS event chain |
| `qty_in_stock_uom` | Breaks `_compute_stock_qty()` set_value call |

---

## RESTRICT — Do Not Remove

| Component | Why |
|-----------|-----|
| `get_item_uoms()` whitelist function | Without it UOM field shows ALL UOMs system-wide |
| UNION with `stock_uom` in SQL | stock_uom is always valid even with no UOM Conversion Detail row |
| `filters` JSON parse guard | Frappe sends filters as JSON string in some versions |

---

## File Map

```
sales_projected_items/
├── sales_projected_items.json   — DocType schema (7 fields, istable: 1)
├── sales_projected_items.py     — Controller (empty) + get_item_uoms() whitelist
├── sales_projected_items.md     — This file
└── (no .js file — child table JS lives in sales_projection.js)
```
