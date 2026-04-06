# toc_item_group_rule — TOC Item Group Rule DocType (Child Table)

Maps ERPNext Item Groups to TOC buffer types (FG/SFG/RM/PM). Eliminates the need to manually set `custom_toc_buffer_type` on every item — instead, configure once at the group level and let the resolution algorithm handle classification.

`istable: 1` — child table, not a standalone document. Parent: `TOC Settings`, field: `item_group_rules`.

---

## Why This Exists

Without item group rules, every item enabled for TOC must have `custom_toc_buffer_type` manually set on the Item form. With 500+ items, this is unmanageable. Item Group Rules allow bulk classification:

```
"All items in 'Finished Products' group → FG"
"All items in 'Raw Materials' group (and sub-groups) → RM"
"All items in 'Packaging' group (and sub-groups) → PM"
```

Set once, applies to all current and future items in those groups.

---

## Fields

| Fieldname | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `item_group` | Link → Item Group | ✓ | — | The ERPNext Item Group to map |
| `buffer_type` | Select (FG/SFG/RM/PM) | ✓ | — | Buffer type assigned to items in this group |
| `include_sub_groups` | Check | — | 1 (checked) | Apply rule to all child groups in the hierarchy |
| `priority` | Int | — | 10 | Lower number = higher priority when multiple rules match |

---

## Resolution Algorithm — How Buffer Type is Determined Per Item

Called inside `buffer_calculator._resolve_buffer_type(item_code)`:

```python
def _resolve_buffer_type(item_code):
    """
    Priority order:
    1. Item-level manual setting (custom_toc_buffer_type on Item form)
    2. Item Group Rules (this table), sorted by priority ascending
    Returns: buffer_type string, or None (item skipped with Error Log)
    """
    # Step 1: Check item-level override first
    item_type = frappe.db.get_value("Item", item_code, "custom_toc_buffer_type")
    if item_type:
        return item_type
    
    # Step 2: Get item's group and ancestors
    item_group = frappe.db.get_value("Item", item_code, "item_group")
    group_hierarchy = _get_group_ancestors(item_group)  # [item_group, parent, grandparent, ...]
    
    # Step 3: Load rules sorted by priority (ascending — lowest priority number wins)
    settings = frappe.get_cached_doc("TOC Settings")
    rules = sorted(settings.item_group_rules or [], key=lambda r: r.priority or 10)
    
    # Step 4: Exact match first (item's direct group matches a rule)
    for rule in rules:
        if rule.item_group == item_group:
            return rule.buffer_type
    
    # Step 5: Ancestor walk (include_sub_groups=1)
    for ancestor_group in group_hierarchy[1:]:    # skip item_group itself (checked above)
        for rule in rules:
            if rule.include_sub_groups and rule.item_group == ancestor_group:
                return rule.buffer_type
    
    # Step 6: No match — log error and skip item
    frappe.log_error(
        f"TOC Buffer Type Unresolved for item {item_code} (group: {item_group})",
        "TOC Buffer Calculator"
    )
    return None
```

### Resolution Walk Example

Item: `CORIANDER-POWDER-50G` in group `Spices (Raw)`

ERPNext Item Group hierarchy:
```
All Item Groups
└── Raw Materials            ← Rule: RM, priority=10, include_sub_groups=1
    └── Spices               ← No rule
        └── Spices (Raw)     ← No rule (item's direct group)
```

Resolution steps:
1. `custom_toc_buffer_type` on item = blank → proceed to rules
2. Exact match: is "Spices (Raw)" in rules? No
3. Walk ancestors: "Spices" → in rules? No
4. Walk ancestors: "Raw Materials" → in rules? YES, include_sub_groups=1 → **return RM**

---

## Priority Field — Conflict Resolution

When an item's group appears in multiple rules (e.g., different classification schemes for overlapping hierarchies):

```
Priority 5 → "Finished Products / Biscuits"  → FG    (more specific)
Priority 10 → "Finished Products"             → FG    (broader)
```

An item in "Finished Products / Biscuits" would match **both** rules. Priority 5 wins (lower number = checked first).

**Example conflict scenario**: Company classifies most items by product line, but one sub-group should have different classification:

```
Priority 10 → "Raw Materials"             → RM    (broad rule)
Priority 3  → "Raw Materials / Semi-Proc" → SFG   (override for semi-processed)
```

Items in "Semi-Proc" sub-group resolve as SFG despite the broader "Raw Materials → RM" rule.

---

## Typical Production Setup

```
Item Group             Buffer Type   Include Sub-Groups   Priority
──────────────────     ────────────  ────────────────     ────────
Finished Products      FG            ✓                    10
Semi-Finished Goods    SFG           ✓                    10
Raw Materials          RM            ✓                    10
Packaging Material     PM            ✓                    10
```

With this configuration:
- Enable `custom_toc_enabled=1` on an item
- Buffer type resolves automatically
- No need to touch `custom_toc_buffer_type` on individual items
- New items added to these groups are automatically classified

---

## Item Group Hierarchy in ERPNext

Item Groups form a tree managed via the Item Group DocType:

```
All Item Groups
├── Finished Products
│   ├── Biscuits
│   │   ├── Cream Biscuits
│   │   └── Digestive
│   └── Namkeen
├── Semi-Finished Goods
│   ├── Bases and Blends
│   └── Intermediate Packs
├── Raw Materials
│   ├── Flours and Starches
│   ├── Oils and Fats
│   └── Spices
│       ├── Spices (Raw)
│       └── Spices (Processed)    ← may need separate SFG classification
└── Packaging Material
    ├── Primary Packaging
    │   ├── Pouches
    │   └── Sachets
    └── Secondary Packaging
        ├── Cartons
        └── Shrink Wrap
```

With `include_sub_groups=1` on "Raw Materials", items in "Spices (Raw)" and "Spices (Processed)" both resolve as RM — unless a more specific rule exists at lower priority number.

---

## Validation in toc_settings.py

```python
def _validate_item_group_rules(self):
    seen = {}
    for row in (self.item_group_rules or []):
        key = (row.item_group, row.buffer_type)
        if key in seen:
            frappe.msgprint(
                f"Item Group '{row.item_group}' appears more than once with "
                f"buffer_type='{row.buffer_type}'. Use Priority field to resolve.",
                alert=True
            )
        seen[key] = True
```

Non-blocking warning (not `frappe.throw()`). The priority field is the intended resolution mechanism — duplicate rules with different priorities are the expected pattern for overrides.

---

## Accessing Rules in Python

```python
settings = frappe.get_cached_doc("TOC Settings")

# Read all rules
for rule in (settings.item_group_rules or []):
    print(f"{rule.item_group} → {rule.buffer_type} "
          f"(priority={rule.priority}, sub_groups={rule.include_sub_groups})")

# Check if a specific group has a rule
groups = {r.item_group: r.buffer_type for r in (settings.item_group_rules or [])}
buffer_type = groups.get("Raw Materials")  # "RM" or None
```

---

## Manual Override (Item-Level)

If a specific item should be classified differently from its group:
1. Open the Item form
2. Go to TOC Settings tab
3. Set `custom_toc_buffer_type` explicitly (e.g., "SFG" even if item is in "Raw Materials" group)
4. This permanently overrides Item Group Rules for this item

The override is respected in `_resolve_buffer_type()` at step 1 before rules are consulted.

---

## Error Log — "TOC Buffer Type Unresolved"

If an item has no matching rule and no manual type set, the buffer calculator logs:

```
Error Log Title: "TOC Buffer Calculator"
Error: "TOC Buffer Type Unresolved for item ITEM-001 (group: Some Group)"
```

The item is silently skipped from buffer calculations. Check Frappe Error Log if items are mysteriously absent from the Production Priority Board.

**Fix**: Either add an Item Group Rule for the item's group, or set `custom_toc_buffer_type` directly on the item.
