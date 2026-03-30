# `toc_item_group_rule/` — TOC Item Group Rule DocType (Child Table)

## Role
Maps ERPNext Item Groups to TOC buffer types (FG/SFG/RM/PM). Lives as a child table row on `TOC Settings` under field `item_group_rules`. Eliminates the need to manually set `custom_toc_buffer_type` on every item.

## Parent Relationship
- `istable: 1` — child table, not a standalone document.
- Parent DocType: `TOC Settings`
- Parent field: `item_group_rules`

## Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `item_group` | Link → Item Group | ✓ | — | The item group to map |
| `buffer_type` | Select (FG/SFG/RM/PM) | ✓ | — | Buffer type for items in this group |
| `include_sub_groups` | Check | — | 1 | Apply rule to all child item groups |
| `priority` | Int | — | 10 | Lower = higher priority on conflict |

## Resolution Logic

When `calculate_all_buffers()` processes an item with blank `custom_toc_buffer_type`:

1. **Item-level type always wins** — if `custom_toc_buffer_type` is set on the Item form, this table is never consulted for that item.
2. **Exact match** — check if item's `item_group` is directly in the rules table (sorted by `priority` ascending).
3. **Sub-group walk** — for rules with `include_sub_groups=1`, walk up the ERPNext Item Group hierarchy (parent → grandparent → ...) until a matching rule is found or `All Item Groups` is reached.
4. **No match** — item is **skipped** from buffer calculations with an Error Log entry ("TOC Buffer Type Unresolved"). Fix by adding a group rule or setting the type manually on the item.

## Priority Rules

When an item's group appears in multiple rules (common with nested groups):
- Rule with the **lowest priority number** wins.
- Default priority is 10. Use lower numbers (1–5) for more specific/overriding rules.

Example:
```
Priority 5 → "Finished Products / Biscuits" → FG
Priority 10 → "Finished Products" → FG
```
An item in "Finished Products / Biscuits" matches priority 5 first.

## Example Setup

```
Item Group          Buffer Type   Include Sub-Groups   Priority
─────────────────── ─────────────────────────────────────────────
Finished Products   FG            ✓                    10
Semi-Finished       SFG           ✓                    10
Raw Materials       RM            ✓                    10
Packaging           PM            ✓                    10
```

With this setup, you only need to enable `custom_toc_enabled = 1` on items — their `buffer_type` resolves automatically from their item group.

## Item Group Hierarchy

ERPNext Item Groups form a tree:
```
All Item Groups
├── Finished Products
│   ├── Biscuits
│   └── Namkeen
├── Raw Materials
│   ├── Flours
│   └── Oils
└── Packaging
    ├── Pouches
    └── Cartons
```

With `include_sub_groups=1` on "Raw Materials", items in "Flours" and "Oils" automatically resolve as RM. No separate rules needed for sub-groups.

## Validation
`toc_settings.py` warns (non-blocking) if the same item group appears more than once. Use `priority` to resolve the conflict rather than removing rules.
