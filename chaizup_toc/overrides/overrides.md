# overrides — ERPNext DocType Overrides

Hooks into built-in ERPNext DocType lifecycle events to enforce TOC rules. No new DocTypes — only modifies behavior of existing ones.

```
overrides/
├── item.py               ← Item validate: ADU validation, T/CU, BOM, mutual exclusion
├── material_request.py   ← MR validate: TOC compliance warning
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
if doc.custom_toc_buffer_type == "FG":
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

## How All Three Overrides Work Together

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

ERPNext scheduler tries to run reorder:
  → overrides/reorder_override.py:toc_reorder_item()
  → Intercepted, nothing created, auto_indent reset to 0
```
