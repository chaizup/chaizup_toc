# `doctype/` — Custom DocTypes

## DocTypes in This App

| DocType | Type | Description |
|---------|------|-------------|
| `TOC Buffer Log` | Standard | Daily buffer snapshot archive (one row per item+warehouse per day) |
| `TOC Item Buffer` | Child Table (`istable=1`) | Per-warehouse buffer rule — child of `Item` |
| `TOC Settings` | Single (`issingle=1`) | App-wide configuration |
| `TOC Warehouse Rule` | Child Table (`istable=1`) | Classifies warehouses as Inventory / WIP / Excluded — child of `TOC Settings` |
| `TOC Item Group Rule` | Child Table (`istable=1`) | Maps item groups to buffer types (FG/SFG/RM/PM) — child of `TOC Settings` |

## Custom Fields on Built-in DocTypes

These are NOT DocTypes here — they are installed via `setup/install.py → _install_custom_fields()` and tracked in fixtures (`hooks.py → fixtures`).

| DocType | Custom Fields Added |
|---------|-------------------|
| `Item` | TOC Setting tab with 5 sections (Enable, ADU, T/CU, BOM, Buffer Rules) |
| `Material Request` | TOC App tab (zone, BP%, target, IP, SR%) |
| `Work Order` | TOC App tab (zone, BP%) |

## Fixture Management

All custom fields use `module = "Chaizup Toc"`. Fixtures in `hooks.py`:
```python
fixtures = [
    {"doctype": "Custom Field", "filters": [["module", "=", "Chaizup Toc"]]},
    {"doctype": "Property Setter", "filters": [["module", "=", "Chaizup Toc"]]},
]
```

To export updated fixtures after changes:
```bash
bench --site your-site export-fixtures --app chaizup_toc
```

## Relationship Diagram

```
Item (built-in ERPNext)
├── custom_toc_enabled         ← Custom Field
├── custom_toc_buffer_type     ← Custom Field
├── custom_toc_adu_value       ← Custom Field
└── custom_toc_buffer_rules    ← Table Field (custom)
    └── TOC Item Buffer (child table)
        ├── warehouse
        ├── adu, rlt, vf
        ├── target_buffer      ← F1 auto-calculated
        └── adjusted_buffer    ← F6 auto-calculated

TOC Buffer Log (daily snapshot)
├── item_code → Item
├── warehouse → Warehouse
├── log_date
├── zone, bp_pct, ip, target
└── mr_created → Material Request

TOC Settings (singleton)
├── zone thresholds
├── DBM parameters
├── DAF settings
├── warehouse_rules            ← TOC Warehouse Rule (child table)
│   └── warehouse, purpose (Inventory/WIP/Excluded)
├── item_group_rules           ← TOC Item Group Rule (child table)
│   └── item_group, buffer_type, include_sub_groups, priority
└── demo_data_manifest (hidden JSON)
```
