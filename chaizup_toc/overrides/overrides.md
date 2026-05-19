# overrides — ERPNext DocType Overrides

Hooks into built-in ERPNext DocType lifecycle events to enforce TOC rules. No new DocTypes — only modifies behavior of existing ones.

```
overrides/
├── item.py               ← Item validate: ADU validation, T/CU, BOM, mutual exclusion
├── material_request.py   ← MR validate: TOC compliance warning
├── production_plan.py    ← ProductionPlan class override: stamp TOC UOM fields
│                            inside get_sub_assembly_items (button click)
├── purchase_order.py     ← PO before_insert: copy TOC metadata from source MR
└── reorder_override.py   ← Intercepts erpnext.stock.reorder_item.reorder_item()
```

---

## item.py

### `on_item_validate(doc, method)`

**Trigger**: `hooks.py → doc_events["Item"]["validate"]`
Fires on every Item save (both create and update) when `custom_toc_enabled = 1`.

```python
def on_item_validate(doc, method):
    if not doc.custom_toc_enabled:
        return   # fast exit for non-TOC items
    
    # 1. R1 — ADU manual mode validation
    # 2. R2 — Mutual exclusion: Purchase vs Manufacturing
    # 3. Monitor-only warning
    # 4. F5 — T/CU calculation (FG only)
    # 5. R3 — BOM link validation
    # 6. Buffer rules existence check
```

### Validation 1: Custom ADU (R1)

```python
if doc.custom_toc_custom_adu and flt(doc.custom_toc_adu_value) <= 0:
    frappe.msgprint(
        "You have 'Custom ADU' checked but ADU Value is 0. "
        "Please enter your manual ADU value (units/day).",
        indicator="orange", alert=True)   # non-blocking warning
```

This is informational only — the item still saves. A zero ADU will cause `target_buffer = 0` in F1, which means `_calculate_single()` returns `None` (item skipped from buffer calculations). The user needs to enter a valid value.

### Validation 2: Mutual Exclusion (R2)

```python
if doc.custom_toc_auto_purchase and doc.custom_toc_auto_manufacture:
    frappe.throw(
        "Choose ONE: 'Auto Purchase TOC' (for items you BUY) OR "
        "'Auto Manufacturing TOC' (for items you PRODUCE). "
        "An item cannot be both purchased and manufactured.",
        title="TOC: Choose Purchase or Manufacturing")
```

**Why throw and not warn?** The `mr_type` field in the generated MR is determined by these flags. Having both checked would cause ambiguous MR type. The system cannot create both "Purchase" and "Manufacture" type MRs for the same item in the same run.

```python
if not doc.custom_toc_auto_purchase and not doc.custom_toc_auto_manufacture:
    frappe.msgprint(
        "Neither 'Auto Purchase TOC' nor 'Auto Manufacturing TOC' is checked. "
        "TOC will monitor this item but will NOT auto-create Material Requests.",
        indicator="orange", alert=True)
```

Items with neither flag are still calculated (BP%, zone, IP) but `_create_mr()` would create an MR with `mr_type=None`. In practice, `mr_type = "Manufacture" if custom_toc_auto_manufacture else "Purchase"` — so unchecked items default to Purchase-type MR.

### Validation 3: F5 T/CU Calculation

```python
# T/CU calculated whenever selling_price and constraint_speed are set
price = flt(doc.custom_toc_selling_price)
tvc   = flt(doc.custom_toc_tvc)
speed = flt(doc.custom_toc_constraint_speed)
if price and speed > 0:
    doc.custom_toc_tcu = round((price - tvc) * speed, 2)
else:
    doc.custom_toc_tcu = 0
```

**Example:**
```
FG-MASALA-1KG:
  Selling Price  = ₹350
  TVC (RM + PM)  = ₹120   (NOT including labour, electricity, rent — those are fixed)
  VFFS Speed     = 8 units/minute

T/CU = (350 − 120) × 8 = ₹1,840 per constraint minute
```

Used as tie-breaker: when two items have identical BP%, the one with higher T/CU runs first on the VFFS (earns more revenue per constraint minute).

**TVC definition**: ONLY truly variable costs (raw material + packaging). Labour, electricity, rent are fixed costs — they don't change whether this SKU runs or not. Include only what changes per additional unit produced.

### Validation 4: BOM Link Validation (R3)

```python
if doc.custom_toc_default_bom:
    bom_item = frappe.db.get_value("BOM", doc.custom_toc_default_bom, "item")
    if bom_item != doc.name:
        frappe.throw(
            f"BOM '{doc.custom_toc_default_bom}' belongs to item '{bom_item}', "
            f"not '{doc.name}'.")
```

Prevents linking a BOM that belongs to a different item — would cause incorrect BOM availability checks.

### Validation 5: Buffer Rules Existence

```python
if not (doc.get("custom_toc_buffer_rules") or []):
    frappe.msgprint(
        "TOC is enabled but no buffer rules added. "
        "Add warehouse rules in Section 5 below.",
        indicator="orange", alert=True)
```

Non-blocking. An item with TOC enabled but no buffer rules is simply skipped in `calculate_all_buffers()` (no rules → no output rows).

---

## material_request.py

### `validate_toc_compliance(doc, method)`

**Trigger**: `hooks.py → doc_events["Material Request"]["validate"]`

```python
def validate_toc_compliance(doc, method):
    if doc.custom_toc_recorded_by == "By System":
        return   # System-generated MR — no warning needed
    
    toc_items = []
    for item in doc.items:
        if frappe.db.get_value("Item", item.item_code, "custom_toc_enabled"):
            toc_items.append(item.item_code)
    
    if toc_items:
        frappe.msgprint(
            msg=_(
                "<b>TOC Notice:</b> The following items are managed by TOC Buffer Management: "
                f"<br><b>{', '.join(toc_items)}</b><br><br>"
                "The TOC system auto-generates Material Requests daily at 7:00 AM based on "
                "Buffer Penetration %. Manual MRs may conflict with TOC calculations.<br><br>"
                "Formula: <b>F4: Order Qty = Target Buffer − Inventory Position</b>"
            ),
            title=_("TOC Managed Items Detected"),
            indicator="orange",
        )
```

**Design decision**: Warning only, never blocks. Reasons:
1. Users legitimately create manual MRs for urgent needs outside the daily cycle
2. The system MR already handles duplication check (`_has_open_mr`)
3. Blocking would make TOC hostile to operators

**When does "By System" appear?**
Set by `_create_mr()` in `mr_generator.py`:
```python
mr.custom_toc_recorded_by = "By System"
```
The validate hook checks this and returns early — no warning for auto-generated MRs (they're always correct).

---

## production_plan.py — `ChaizupProductionPlan`

**Trigger**: `hooks.py → override_doctype_class["Production Plan"]`

Subclass of `erpnext.manufacturing.doctype.production_plan.production_plan.ProductionPlan`. Closes the only gap left in the TOC UOM bi-directional sync.

### The gap it closes

The TOC UOM custom-field trio on the two PP child tables —

| Child table              | Custom fields                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `po_items`               | `custom_uom`, `custom_uom_conversion_factor`, `custom_qty_in_uom`                                   |
| `sub_assembly_items`     | `custom_uom`, `custom_uom_conversion_factor`, `custom_required_qty_in_uom`, `custom_projected_qty_in_uom`, `custom_qty_to_order_in_uom` |

— is populated by `production_plan_engine._stamp_uom_fields_on_pp()`. That stamper is fired from three places:

1. **`Production Plan.validate`** (every Save) — covers all manual edits.
2. **Engine auto-PP path** at Step 2.5 in `_save_and_submit_production_plan()` — covers Sales Projection auto-Production-Plan generation.
3. **`ChaizupProductionPlan.get_sub_assembly_items`** *(this override)* — covers the "Get Sub Assembly Items" button on the PP form.

Without #3, clicking the button populated the standard qty fields (`required_qty`, `projected_qty`, `qty`) but left the `*_in_uom` display fields at 0 until the user clicked Save. The JS reverse-fill child events on `production_plan_mrp_uom.js` don't fire on bulk row insertion from `frm.call`, so the validate path was the only sync gate.

### Implementation

```python
class ChaizupProductionPlan(ProductionPlan):
    @frappe.whitelist()
    def get_sub_assembly_items(self, manufacturing_type=None):
        super().get_sub_assembly_items(manufacturing_type=manufacturing_type)
        try:
            _stamp_uom_fields_on_pp(self)
        except Exception:
            frappe.log_error(frappe.get_traceback(), "TOC UOM stamp after Get Sub Assembly Items failed for ...")
```

Two important guarantees:

- **Shallow override.** ERPNext's BOM-explosion logic stays in place. If a future ERPNext release changes the row shape (new field, different traversal order), the stamper picks it up via `_stamp_uom_fields_on_pp` reading from whatever fields are now present.
- **`@frappe.whitelist()` re-decoration is mandatory.** The button calls `frm.call({method: "get_sub_assembly_items", doc: frm.doc})` → `runserverobj` → `frappe.is_whitelisted(method_obj)`. The subclass's bound method must be in `frappe.whitelisted` or the call 401s. Verified at boot:

  ```python
  ChaizupProductionPlan.get_sub_assembly_items in frappe.whitelisted   # → True
  ProductionPlan.get_sub_assembly_items        in frappe.whitelisted   # → True (base still registered)
  ```

### Live test (development.localhost, 2026-05-19)

```text
po_items:
  CZPFG638  planned_qty=4320  custom_uom=CFC / Master  cf=360  qty_in_uom=12

sub_assembly_items (after one get_sub_assembly_items() call on the override):
  CZMAT/1283  required_qty=63504  qty=63504
              custom_uom=Kg       cf=1000
              req_in_uom=63.504   proj_in_uom=0  qto_in_uom=63.504
```

The Kg UOM was auto-picked as the largest non-stock CF UOM for `CZMAT/1283`. Forward sync (CFC / Master → 4320 Pcs) was kept from the user's input on `po_items`.

### Restrictions

- **Do not add business logic here.** Anything beyond UOM stamping belongs in `production_plan_engine.py` and a `doc_event`/`validate` hook so it covers every save path (manual edit, engine auto-PP, REST API, scheduler).
- **Do not override other ProductionPlan methods** unless they have the same "Save-bypassing UI button" problem (`ignore_validate=True` on insert) — see `make_work_order` below for the second case.

### `make_work_order` — closes the WO-validate-hook gap

**Trigger**: clicking *Create > Work Order* on a Production Plan (`frm.call("make_work_order")`).

**The gap**: ERPNext's `create_work_order(item)` builds the new WO with:

```python
wo.flags.ignore_mandatory = True
wo.flags.ignore_validate  = True
wo.insert()
```

(`erpnext/manufacturing/doctype/production_plan/production_plan.py:946-949`). The `ignore_validate=True` flag is honoured by Frappe in `_validate`:

```python
if self.flags.ignore_validate:
    return
```

(`frappe/model/document.py:1331`). That early-return **skips both the `validate()` method AND the `validate` doc-event hook**. So the existing `Work Order.validate → stamp_uom_fields_on_wo_validate` wire (hooks.py:132) NEVER fires for WOs born from this button, and the TOC custom fields on the WO sit blank:

- `custom_uom` ("UOM [TOC]")
- `custom_uom_conversion_factor` ("Conversion Factor [TOC]")
- `custom_qty_in_uom` ("Qty in UOM [TOC]")
- `custom_mrp` ("MRP")
- `custom_mrp_source` ("MRP Source")  *(NB: the DB column has a default of `Auto from Item`, so this one only LOOKS right — the others stay blank.)*

The MRP fields have no server-side hook anywhere — they're populated by JS form events on the WO form (`production_item` change → fetch `Item.custom_mrp`), which also do not fire on programmatic insert.

**Implementation**:

```python
@frappe.whitelist()
def make_work_order(self):
    super().make_work_order()
    try:
        _stamp_toc_fields_on_work_orders(self.name, recorded_by=None)
    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC WO stamp after Make Work Order failed for ...")
```

Reuses the engine helper `_stamp_toc_fields_on_work_orders(pp_name, toc_data=None, recorded_by="By System")` — a 2026-05-19 refactor added the `recorded_by` parameter so the user-initiated override can pass `recorded_by=None` and SKIP the `custom_toc_recorded_by` write. That field must stay blank for user-driven WOs, because downstream PO/MR overrides gate behavior on `custom_toc_recorded_by == "By System"`; tagging button-driven WOs as "By System" would cause them to be treated as TOC-automation docs.

A second 2026-05-19 fix inside the helper: `if fields: frappe.db.set_value(...)` — when both `toc_data` AND `recorded_by` are skipped, `fields` is `{}` and the resulting empty UPDATE used to raise `MySQLdb.OperationalError (1065, 'Query was empty')`. The early-return guards against that and lets the UOM+MRP stamping inside the inner `try` block run as intended.

### Live test (development.localhost, 2026-05-19)

PP with `CZPFG638` × 12 `CFC / Master`, sub-asm `CZMAT/1283`:

| WO                    | Item       | qty   | UOM [TOC]     | CF   | qty_in_uom | MRP | MRP Source       |
| --------------------- | ---------- | ----- | ------------- | ---- | ---------- | --- | ---------------- |
| MFG-WO-2026-…(FG)     | CZPFG638   | 4320  | CFC / Master  | 360  | 12         | 10  | Auto from Item   |
| MFG-WO-2026-…(sub)    | CZMAT/1283 | 63504 | Kg            | 1000 | 63.504     | 0   | Auto from Item   |

(Sub-asm MRP is 0 because `Item.custom_mrp` is not set on CZMAT/1283 — expected.)

### Restrictions for `make_work_order` override

- **DO NOT pass `recorded_by="By System"` here.** That value is reserved for engine-created WOs and is consumed by `purchase_order.on_purchase_order_before_insert` and `material_request.validate_toc_compliance`. Mis-tagging user-driven WOs would route them through TOC-automation paths they don't belong on.
- **DO NOT remove the `if fields:` guard** in `_stamp_toc_fields_on_work_orders`. Without it, the helper crashes when called with `recorded_by=None` AND no `toc_data` (which is exactly how this override calls it).
- The helper stamps `custom_uom` / `custom_mrp_source` unconditionally — fine for the PP→WO flow because the WO is fresh, but DO NOT call it on already-stamped WOs without idempotency hardening, or you'll clobber user-picked custom_uom / Manual MRP source.

---

## purchase_order.py

### `on_purchase_order_before_insert(doc, method)`

**Trigger**: `hooks.py → doc_events["Purchase Order"]["before_insert"]`

Fires when a Purchase Order is being created (before it is written to the database). This is the correct hook for stamping computed/derived fields on the new document without triggering unnecessary validators.

**Purpose**: When purchasing staff converts a TOC-generated Material Request into a Purchase Order, the six TOC identification fields (zone, BP%, target buffer, IP, SR%) must carry over to the PO header. Without this, POs appear untagged — you cannot tell which replenishment trigger caused them.

```python
_TOC_FIELDS = [
    "custom_toc_recorded_by",
    "custom_toc_zone",
    "custom_toc_bp_pct",
    "custom_toc_sr_pct",
    "custom_toc_target_buffer",
    "custom_toc_inventory_position",
]

def on_purchase_order_before_insert(doc, method):
    try:
        for item in doc.items or []:
            mr_name = item.get("material_request")
            if not mr_name:
                continue

            mr_fields = frappe.db.get_value(
                "Material Request", mr_name, _TOC_FIELDS, as_dict=True
            )
            if not mr_fields or mr_fields.get("custom_toc_recorded_by") != "By System":
                continue

            # First TOC-generated MR found — copy all fields to PO header
            doc.custom_toc_recorded_by        = mr_fields["custom_toc_recorded_by"]
            doc.custom_toc_zone               = mr_fields.get("custom_toc_zone") or ""
            doc.custom_toc_bp_pct             = flt(mr_fields.get("custom_toc_bp_pct"))
            doc.custom_toc_sr_pct             = flt(mr_fields.get("custom_toc_sr_pct"))
            doc.custom_toc_target_buffer      = flt(mr_fields.get("custom_toc_target_buffer"))
            doc.custom_toc_inventory_position = flt(mr_fields.get("custom_toc_inventory_position"))
            break  # one source MR is enough

    except Exception:
        frappe.log_error(frappe.get_traceback(), "TOC PO field stamp failed")
```

### Logic Flow

```
PO before_insert fires
  └─ loop po.items
       └─ for each item: read item.material_request
            └─ frappe.db.get_value("Material Request", mr_name, _TOC_FIELDS)
                 └─ if custom_toc_recorded_by == "By System"
                      └─ copy 6 fields to PO header
                      └─ break  (first TOC MR wins)
```

**Why `before_insert` and not `on_submit`?**
- `before_insert` fires before the document is written to DB — field values set here are persisted with the initial INSERT.
- `on_submit` fires after docstatus changes to 1 — at that point you'd need `frappe.db.set_value()` to update the already-saved record.
- `before_insert` is cleaner: one write, no separate UPDATE query.

**Why first TOC MR wins?**
Multi-source POs (items from different MRs) are rare in a TOC context. When TOC generates MRs, each MR covers one item + one warehouse run. A mixed PO (TOC item + non-TOC item) still gets tagged correctly from the first TOC MR found. In practice all TOC items in a batch share the same buffer state snapshot.

**Why `frappe.db.get_value()` and not `frappe.get_doc()`?**
`frappe.get_doc("Material Request", mr_name)` would trigger MR validators (including `validate_toc_compliance` in `material_request.py`). That's unnecessary overhead and could cause side effects. `frappe.db.get_value()` is a direct DB read — safe and fast.

### TOC Fields on Purchase Order

All 8 TOC fields on the Purchase Order header (added via fixtures):

| Field | Type | Purpose |
|---|---|---|
| `custom_toc_recorded_by` | Select (By System / By User) | Was this PO triggered by TOC automation? |
| `custom_toc_zone` | Data | Buffer zone at time of MR creation (Red / Yellow / Green) |
| `custom_toc_bp_pct` | Float | BP% snapshot when MR was created |
| `custom_toc_sr_pct` | Float | SR% snapshot when MR was created |
| `custom_toc_target_buffer` | Float | Target Buffer (F1) at time of replenishment |
| `custom_toc_inventory_position` | Float | IP (F2) at time of replenishment |
| `custom_toc_col` | Section Break | Visual grouping on PO form |
| `custom_toc_section` | Column Break | Visual grouping on PO form |

### DANGER ZONE

- **Do NOT** use `frappe.get_doc("Material Request", ...)` — triggers MR validators unnecessarily.
- **Do NOT** raise exceptions — the entire function is wrapped in `try/except`. A failure logs to Error Log but never blocks PO creation.
- **Do NOT** modify `po.items` — only the PO header TOC fields are set here.
- **Do NOT** remove the `break` — multi-source PO logic intentionally uses first-TOC-MR-wins.

### RESTRICT

- Do NOT add `frappe.db.commit()` inside this hook — `before_insert` is inside a transaction; explicit commit would break the atomic write.
- Do NOT check `doc.docstatus` here — `before_insert` always has `docstatus = 0`.
- Do NOT add a fallback that copies TOC fields from non-TOC MRs — only `"By System"` MRs should tag the PO.

---

## reorder_override.py

### `toc_reorder_item()`

**Registration**: `hooks.py → override_whitelisted_methods`
```python
override_whitelisted_methods = {
    "erpnext.stock.reorder_item.reorder_item": "chaizup_toc.overrides.reorder_override.toc_reorder_item"
}
```

This completely replaces ERPNext's default reorder scheduler.

```python
def toc_reorder_item():
    frappe.logger("chaizup_toc").warning(
        "Default reorder_item() intercepted by Chaizup TOC. "
        "The built-in auto Material Request is disabled. "
        "TOC Buffer Management is the active replenishment engine. "
        "If you see this, check Stock Settings > auto_indent — it should be unchecked."
    )
    
    # Auto-disable the setting if someone turned it back on
    if frappe.db.get_single_value("Stock Settings", "auto_indent"):
        frappe.db.set_single_value("Stock Settings", "auto_indent", 0)
        frappe.db.commit()
        frappe.logger("chaizup_toc").warning(
            "Auto-disabled Stock Settings.auto_indent — someone had re-enabled it."
        )
    
    return None
```

**Why this is needed:**
1. `setup/install.py` sets `auto_indent = 0` on installation
2. But ERPNext Stock Settings UI allows users to re-enable it
3. If re-enabled, ERPNext's `reorder_item.reorder_item()` would create standard reorder-level-based MRs — completely different from TOC BP%-based MRs
4. This override ensures even if `auto_indent` is re-enabled, no default MRs are created
5. The function also auto-corrects the setting back to 0

**Integration with `setup/install.py`:**
- Install: `auto_indent = 0` → prevents default reorder from ever starting
- Override: intercepts any calls even if setting is accidentally re-enabled
- Uninstall (`before_uninstall`): `auto_indent = 1` → restores default behavior when TOC is removed

---

## Fixed Bug History

### BUG-CRITICAL (Fixed): Missing `on_buffer_rule_validate`

`hooks.py` previously contained:
```python
doc_events = {
    ...
    "TOC Item Buffer": {
        "validate": "chaizup_toc.overrides.item.on_buffer_rule_validate",  # DID NOT EXIST
    },
}
```

This function was never defined in `overrides/item.py`. Every time a user saved an Item with buffer rules, Frappe would:
1. Save the Item form
2. Trigger `doc_events["TOC Item Buffer"]["validate"]`
3. Attempt to import `chaizup_toc.overrides.item.on_buffer_rule_validate`
4. `AttributeError: module has no attribute 'on_buffer_rule_validate'`
5. Item save fails with a traceback

**Fix**: The entire `"TOC Item Buffer"` entry was removed from `doc_events` in `hooks.py`. All buffer calculations are handled by `TOCItemBuffer.validate()` in the controller (`toc_item_buffer.py`). No doc_event needed for the child table.

---

## How All Four Overrides Work Together

```
User saves Item (with TOC enabled):
  → overrides/item.py:on_item_validate()
  → Validates ADU, T/CU, BOM, mutual exclusion

User saves Item with buffer rules (child table):
  → TOCItemBuffer.validate() in toc_item_buffer.py (controller)
  → F1, F6 calculated here (NOT via overrides)

User creates Manual MR:
  → overrides/material_request.py:validate_toc_compliance()
  → Shows warning if any item is TOC-managed

User converts TOC-generated MR into Purchase Order:
  → overrides/purchase_order.py:on_purchase_order_before_insert()
  → Copies zone / BP% / target / IP / SR% from source MR to PO header

ERPNext scheduler tries to run reorder:
  → overrides/reorder_override.py:toc_reorder_item()
  → Intercepted, nothing created, auto_indent reset to 0
```
