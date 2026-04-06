# manufacturing_pipeline — Manufacturing Pipeline Page

Interactive 7-stage pipeline visualization showing every TOC-managed item's
procurement and production document chain in one horizontal scrollable view.

---

## Purpose

Answers the question: *"For each TOC-managed item, where is it in the supply chain
right now — from the first replenishment trigger to the goods in hand?"*

Designed for multiple audiences:
- **CEO / Management**: Summary bar shows Red/Yellow/Green item counts and open
  document counts at a glance. No detail required.
- **Production Manager**: See all Work Orders, Job Cards, and Stock Entries for FG/SFG
  items. Click any card to trace its full lineage.
- **Purchase Manager**: See all MRs, RFQs, Supplier Quotations, Purchase Orders, and
  Purchase Receipts for RM/PM items. Zone filters narrow to urgent items only.
- **Layman**: Color-coded zones (Red = urgent, Green = fine) make priority immediately
  obvious without knowing ERPNext terminology.

---

## Files

```
chaizup_toc/chaizup_toc/page/manufacturing_pipeline/
├── __init__.py
├── manufacturing_pipeline.json    ← Frappe Page metadata + role access
├── manufacturing_pipeline.html    ← CSS + HTML skeleton
├── manufacturing_pipeline.js      ← ManufacturingPipeline controller class
└── manufacturing_pipeline.md      ← This file

chaizup_toc/api/
└── pipeline_api.py                ← Python API: get_pipeline_data()
```

---

## Pipeline Stages

| Stage | Column | Documents Shown |
|-------|--------|----------------|
| 1 | **Items** | TOC-managed Items (seed nodes, always present) |
| 2 | **Material Request** | Open/Draft MRs for those items |
| 3 | **RFQ / Prod. Plan** | RFQ (RM/PM path) or Production Plan (FG/SFG path) |
| 4 | **Quotation / Work Order** | Supplier Quotation (RM/PM) or Work Order (FG/SFG) |
| 5 | **PO / Job Card** | Purchase Order (RM/PM) or Job Card (FG/SFG) |
| 6 | **Receipt / QC / SE** | Purchase Receipt + QI (RM/PM) or Stock Entry (FG/SFG) |
| 7 | **FG / SFG Output** | Final buffer state for FG/SFG items only |

---

## Card Anatomy

Each card shows:
- **Doc number** (top-left) + **DocType abbreviation tag** (top-right)
- **Description** — item name, supplier, operation, etc.
- **Status badge** — draft/open/ordered/completed/etc.
- **Zone badge** — Red/Yellow/Green/Black (only when TOC data available)
- **TOC Auto tag** — shown on MRs created by the 07:00 scheduler
- **BP% progress bar** — for item/MR/WO/output nodes
- **Production progress bar** — for Work Orders and Job Cards (produced/planned)
- **On-Hand / Target chips** — for item and output nodes
- **Date** — required date, start date, or transaction date

---

## Interaction

### Click a card
Highlights the card's full upstream (ancestors, green border) and downstream
(descendants, amber border) chain. All unrelated cards are dimmed.
A detail panel slides in from the right showing all document fields plus
TOC buffer breakdown (F1, F2, F3, F4 formulas).

### Click again / click background
Clears the selection and closes the detail panel.

### Filter Bar
- **Buffer Type** (All / FG / SFG / RM / PM): Re-fetches from API with
  `buffer_type` parameter. Triggers a full reload.
- **Zone** (All / Red / Yellow / Green / Black): In-memory filter.
  Shows only item nodes matching the zone and all documents reachable from them.
  No API call — instant.

### SVG Edges
Cubic Bezier curves connect related documents (right-center of source card →
left-center of target card). Edges:
- **Grey (default)**: No selection active
- **Blue**: Directly connected to the selected card
- **Green**: Ancestor chain
- **Amber**: Descendant chain
- **Faded**: Not in the selected lineage

Edges redraw on horizontal scroll and window resize via `requestAnimationFrame`.

---

## Python API — `get_pipeline_data()`

```
chaizup_toc.api.pipeline_api.get_pipeline_data
```

**Arguments:**
- `item_code`  — filter to one item (optional)
- `buffer_type` — "FG" | "SFG" | "RM" | "PM" | None
- `zone`       — "Red" | "Yellow" | "Green" | "Black" | None
- `days_back`  — how many days back to look (default 30)

**Returns:**
```json
{
  "nodes": [
    {
      "id":       "MR::MAT-MR-2026-00123",
      "stage":    "material_request",
      "doctype":  "Material Request",
      "sub_type": "mr",
      "doc_name": "MAT-MR-2026-00123",
      "label":    "MAT-MR-2026-00123",
      "description": "ITEM-001",
      "zone":     "Red",
      "bp_pct":   78.5,
      "recorded_by": "By System",
      ...
    }
  ],
  "edges": [
    {"source": "ITEM::ITEM-001", "target": "MR::MAT-MR-2026-00123"},
    {"source": "MR::MAT-MR-2026-00123", "target": "PP::MFG-PP-2026-00045"}
  ],
  "summary": {
    "red": 3, "yellow": 5, "green": 12,
    "mrs": 8, "wos": 4, "pos": 6
  }
}
```

### Edge relationships (ERPNext field references)

| Edge | ERPNext field |
|------|--------------|
| Item → MR | `tabMaterial Request Item.item_code` |
| MR → RFQ | `tabRequest for Quotation Item.material_request` |
| MR → PP | `tabProduction Plan Item.material_request` |
| RFQ → SQ | `tabSupplier Quotation Item.request_for_quotation` |
| PP → WO | `tabWork Order.production_plan` |
| SQ → PO | `tabPurchase Order Item.supplier_quotation` |
| MR → PO | `tabPurchase Order Item.material_request` (direct, when no SQ) |
| WO → JC | `tabJob Card.work_order` |
| PO → PR | `tabPurchase Receipt Item.purchase_order` |
| PR → QI | `tabQuality Inspection.reference_name` (reference_type = Purchase Receipt) |
| WO → SE | `tabStock Entry.work_order` |
| SE → OUT | matched by `item_code` on output node |

### docstatus filter
All queries use `docstatus < 2` (Draft + Submitted, exclude Cancelled).
TOC auto-MRs are Draft (docstatus=0) — this ensures they appear in the pipeline.

---

## Performance Notes

- Default `days_back=30` keeps queries fast. Increase to 90 for historical view.
- All queries have `LIMIT 200–300` per stage to prevent runaway load.
- `calculate_all_buffers()` is called once and shared across all item nodes.
- The zone filter operates entirely in JavaScript (no second API call).
- SVG edge redraw uses `requestAnimationFrame` to avoid layout thrashing.

---

## Access

Registered as a Frappe Page (`name: "manufacturing-pipeline"`).
Available via:
- TOC Buffer Management workspace → "Manufacturing Pipeline" shortcut
- Direct URL: `/app/manufacturing-pipeline`
- Keyboard shortcut `Ctrl+Shift+T` → TOC Buffer Management workspace → shortcut

Roles: System Manager, TOC Manager, TOC User, Stock Manager, Stock User,
       Purchase Manager, Purchase User, Manufacturing Manager, Manufacturing User.
