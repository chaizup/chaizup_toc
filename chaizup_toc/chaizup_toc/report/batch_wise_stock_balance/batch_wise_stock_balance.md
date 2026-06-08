# Batch-wise Stock Balance (Script Report)

**Module:** Chaizup Toc · **Ref DocType:** Stock Ledger Entry · **Type:** Script Report
**Path:** `chaizup_toc/chaizup_toc/report/batch_wise_stock_balance/`

## Use case
An ERPNext "Stock Balance"-style report resolved **per batch** and shown in **both
UOMs**, with the batch's **origin voucher**. Answers: *"How much of each batch is on
hand (as on a date), in stock and higher UOM, and which voucher created it?"* — useful
for batch traceability, FEFO/expiry review, and reconciling batch stock to vouchers.

## Columns
| Column | Source |
|---|---|
| Item Code | Link → Item |
| Item Name | Item.item_name (hyperlinked to the Item via JS formatter) |
| Item Group | Item.item_group |
| Batch | Link → Batch (auto-clickable) |
| Qty (Stock UOM) | closing batch balance as on `to_date` |
| Stock UOM | Item.stock_uom |
| Qty (Higher UOM) | Qty (Stock UOM) ÷ conversion_factor |
| Higher UOM | smallest `UOM Conversion Detail` UOM with CF > 1 |
| Origin Voucher | Batch.reference_name (Dynamic Link → Origin Voucher Type) |
| Origin Voucher Type | Batch.reference_doctype (e.g. Work Order / Purchase Receipt) |

## Filters
`from_date`, `to_date`, `company` (single), `warehouse` (multi), `item_code` (multi),
`item_group` (multi), `batch_no` (multi), `show_zero_balance` (check).

- **Qty** is the true closing balance **as on `to_date`** (all non-cancelled SLEs up to
  that date). Opening stock received before `from_date` is included — it is real on-hand
  stock.
- **`from_date` pairs with `show_zero_balance`:** by default only batches with a non-zero
  on-hand balance are listed. Tick *Show Zero Balance* to also reveal batches that had
  movement within `[from_date, to_date]` but netted to zero (depleted-in-period).

## How it works (ERPNext v16 — the important bit)
On this site batches are tracked **entirely through the Serial and Batch Bundle**:
`Stock Ledger Entry.batch_no` is always NULL; the per-batch movement lives in
`Serial and Batch Entry` (`sbe.qty` is signed and sums to `SLE.actual_qty`, joined via
`sbe.parent = sle.serial_and_batch_bundle`). The report therefore derives balances from
the bundle entries, with a legacy `UNION` branch on direct `SLE.batch_no` for robustness.

## Dependencies
- `tabStock Ledger Entry`, `tabSerial and Batch Entry` (batch movement)
- `tabItem` (name/group/stock UOM), `tabBatch` (origin voucher), `tabUOM Conversion Detail` (higher UOM)
- Reads only — never writes.

## Reasoning / guarantees
- Only `is_cancelled = 0` SLEs are summed (cancelled rows never double-count).
- Higher UOM qty is **always** `stock_qty / factor` (never multiply); items without a
  CF > 1 show only the stock UOM.
- All user filter values are passed as **bound parameters**; only fixed column-name
  fragments are concatenated into SQL.

## Verified (2026-06-08, restored chaizup-erp cloud data)
1,420 batch rows; dual-UOM correct (e.g. 1800 Pcs → 5 CFC/Master, factor 360); batch
balance reconciles to the Serial-and-Batch-Bundle SLE sum (360 == 360); batch + company
+ date filters all apply.

## Sync Block (cross-AI continuity)
```
[chaizup_toc · report · Batch-wise Stock Balance · 2026-06-08]
- New Script Report, module Chaizup Toc, ref_doctype Stock Ledger Entry. Triple path:
  apps/chaizup_toc/chaizup_toc/chaizup_toc/report/batch_wise_stock_balance/.
- Batch balance per (item_code, batch_no) as on to_date, BOTH UOMs + origin voucher.
- v16: batches via Serial and Batch Bundle -> Serial and Batch Entry (sbe.qty signed,
  parent = sle.serial_and_batch_bundle). SLE.batch_no always NULL here. UNION legacy
  branch kept. is_cancelled=0 only.
- higher uom = smallest UOM Conversion Detail CF>1; qty_higher = qty/factor.
- origin voucher = Batch.reference_name (+_doctype) as Dynamic Link.
- Filters: from/to date, company, warehouse[], item_code[], item_group[], batch_no[],
  show_zero_balance. from_date pairs with show_zero to reveal depleted-in-period batches.
- item_name hyperlinked via JS formatter; batch/origin auto-clickable.
- Verified on restored data: 1420 rows, reconciles to bundle SLE sum.
```
