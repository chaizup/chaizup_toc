# toc_settings — TOC Settings DocType (Singleton)

Single-instance configuration document for the entire TOC app. One record per site, stored as a Frappe Single doctype.

`issingle: 1` — no list view, accessed via `/app/toc-settings` or in code as `frappe.get_cached_doc("TOC Settings")`.

---

## First-Time Setup Order

Configure in this sequence before enabling items on production:

```
Step 1: Warehouse Classification (warehouse_rules)
        ↓ Defines what counts as "on-hand" vs "WIP" vs "excluded"
        ↓ Wrong setup → Scrap/Expiry stock artificially inflates buffers

Step 2: Item Group Rules (item_group_rules)
        ↓ Auto-assigns FG/SFG/RM/PM from item group hierarchy
        ↓ Without this, every item needs manual buffer type selection

Step 3: Zone Thresholds
        ↓ Defaults (33/67%) work for most companies
        ↓ Adjust if your operations have different risk tolerances

Step 4: MR Generation
        ↓ Toggle auto_generate_mr, choose which zones trigger MRs
        ↓ Start with "Red and Black Only" — easier to manage

Step 5: Enable items
        ↓ Set custom_toc_enabled=1 on first few items, verify calculations
        ↓ buffer_type resolves automatically from Step 2 rules

Step 6: Enable DBM
        Wait at least 1 month of buffer log data before enabling
        DBM needs historical patterns to make meaningful adjustments
```

---

## All Fields

### Zone Thresholds (F3)

| Field | Default | Description |
|-------|---------|-------------|
| `red_zone_threshold` | 67 | BP% >= this → Red Zone. Produce/order immediately |
| `yellow_zone_threshold` | 33 | BP% >= this → Yellow Zone. Plan replenishment |

**Relationship:** `red_zone_threshold` MUST be > `yellow_zone_threshold` (validated on save).

**Zone boundaries with defaults:**
```
BP% >= 100%    → Black  (stockout — IP is negative or zero)
67% ≤ BP% < 100% → Red    (URGENT)
33% ≤ BP% < 67%  → Yellow  (plan ahead)
0%  ≤ BP% < 33%  → Green   (comfortable)
```

**Adjusting thresholds**: Lower `yellow_zone_threshold` (e.g., 25%) gives more "Green" items, reducing noise. Raise `red_zone_threshold` (e.g., 75%) for stricter urgency signaling.

### MR Generation

| Field | Default | Description |
|-------|---------|-------------|
| `auto_generate_mr` | 1 (checked) | Master switch. If unchecked, `mr_generator` returns empty list immediately |
| `mr_zones` | "Red, Black, and Yellow" | Which zones trigger MR creation. Options: "Red and Black Only" or "Red, Black, and Yellow" |
| `notify_on_red` | 1 (checked) | Email alert when items enter Red/Black |
| `red_alert_roles` | "Stock Manager\nPurchase Manager" | Newline-separated role names. All users with these roles receive alerts |

### Dynamic Buffer Management (DBM) — F7/F8

| Field | Default | Description |
|-------|---------|-------------|
| `enable_dbm` | 1 | Weekly DBM auto-adjustment. Disable until 1 month of log data exists |
| `tmr_red_pct_of_rlt` | 20 | F7: If red_days > (RLT × 20%), trigger buffer increase. Lower % = more sensitive |
| `tmg_cycles_required` | 3 | F8: Must be Green for 3 full RLT cycles before decrease |
| `dbm_adjustment_pct` | 33 | F7/F8: ±33% change per DBM event (matches original TOC DDMRP methodology) |
| `max_tmr_consecutive` | 3 | Safety: block further TMR increases after 3 in a row — requires manual review |
| `min_buffer_floor` | 50 | TMG never shrinks buffer below this qty — prevents collapse to zero |

**DBM Parameter Sensitivity Examples:**

```
Conservative (less aggressive):
  tmr_red_pct_of_rlt = 33    (needs 1/3 of RLT in Red before increasing)
  tmg_cycles_required = 5    (needs 5 RLT cycles of Green before decreasing)
  dbm_adjustment_pct = 20    (smaller steps)

Aggressive (more responsive):
  tmr_red_pct_of_rlt = 10    (just 1 Red day in short RLT triggers increase)
  tmg_cycles_required = 2    (faster decrease when buffer is too large)
  dbm_adjustment_pct = 50    (larger steps)
```

### Calculation Defaults

| Field | Default | Description |
|-------|---------|-------------|
| `default_vf` | 1.5 | Suggested VF for new buffer rules |
| `adu_lookback_days` | 90 | Default lookback period for ADU auto-calculation |
| `default_daf` | 1.0 | Current global DAF (1.0 = normal operations) |
| `daf_event_name` | — | Label for current DAF event (e.g., "Diwali 2026") |

### Inventory Classification

| Field | Type | Description |
|-------|------|-------------|
| `warehouse_rules` | Table → TOC Warehouse Rule | Classify each warehouse: Inventory / WIP / Excluded |
| `item_group_rules` | Table → TOC Item Group Rule | Map item groups to FG/SFG/RM/PM buffer types |

**If `warehouse_rules` is empty**: Calculator falls back to single-warehouse mode (reads from the warehouse specified on each `TOC Item Buffer` rule). Backward-compatible.

**If `item_group_rules` is empty**: Items must have `custom_toc_buffer_type` set manually on each Item form.

### Demo Data (hidden)

| Field | Description |
|-------|-------------|
| `demo_data_manifest` | JSON string tracking all demo documents for `delete_demo_data()` cleanup. Hidden from UI. |

---

## Controller — toc_settings.py

```python
def validate(self):
    self._validate_zone_thresholds()
    self._validate_dbm_params()
    self._validate_warehouse_rules()
    self._validate_item_group_rules()
```

### _validate_zone_thresholds()
```python
if flt(self.red_zone_threshold) <= flt(self.yellow_zone_threshold):
    frappe.throw("Red Zone Threshold must be greater than Yellow Zone Threshold")
if flt(self.default_vf) < 1.0:
    frappe.throw("Default Variability Factor must be ≥ 1.0")
```

### _validate_dbm_params()
```python
if flt(self.dbm_adjustment_pct) <= 0 or flt(self.dbm_adjustment_pct) > 100:
    frappe.throw("DBM Adjustment % must be between 1 and 100")
```

### _validate_warehouse_rules()
- Warns if table is empty (fallback mode — Scrap/Expiry won't be excluded)
- Throws if any warehouse appears more than once
- Warns if no warehouse is classified as "Inventory" (would show 0 on-hand everywhere)

### _validate_item_group_rules()
- Warns (non-blocking) if same item group appears in multiple rules with same priority
- Use `priority` field to resolve conflicts explicitly

---

## Access Patterns in Code

```python
# Read with Frappe cache (recommended — no DB hit per call)
settings = frappe.get_cached_doc("TOC Settings")
threshold = settings.red_zone_threshold    # 67
enable = cint(settings.auto_generate_mr)  # 1

# Read single value (without full doc cache)
daf = frappe.db.get_single_value("TOC Settings", "default_daf")

# Write (bypasses controller — use cautiously)
frappe.db.set_single_value("TOC Settings", "default_daf", 1.6)
frappe.db.set_single_value("TOC Settings", "daf_event_name", "Diwali 2026")
frappe.db.commit()

# Access warehouse_rules child table
for row in (settings.warehouse_rules or []):
    print(row.warehouse, row.warehouse_purpose)

# Access item_group_rules child table
for row in (settings.item_group_rules or []):
    print(row.item_group, row.buffer_type, row.priority)
```

**Cache behavior**: `frappe.get_cached_doc("TOC Settings")` is cached in the request context. Changes via `frappe.db.set_single_value()` bypass the cache — call `frappe.clear_cache()` or restart the server for changes to take effect in scheduled jobs.

---

## Permissions

| Role | Read | Write |
|------|------|-------|
| System Manager | ✓ | ✓ |
| Stock Manager | ✓ | ✓ |
| TOC Manager | ✓ | ✓ |
| TOC User | ✓ | — |
| Others | — | — |

---

## Recommended Production Settings

```
Zone Thresholds:
  red_zone_threshold: 67     (industry standard)
  yellow_zone_threshold: 33  (industry standard)

MR Generation:
  auto_generate_mr: 1
  mr_zones: "Red, Black, and Yellow"
  notify_on_red: 1
  red_alert_roles: "Stock Manager\nPurchase Manager"

DBM (after 1 month of data):
  enable_dbm: 1
  tmr_red_pct_of_rlt: 20
  tmg_cycles_required: 3
  dbm_adjustment_pct: 33
  max_tmr_consecutive: 3
  min_buffer_floor: 50

Calculation Defaults:
  default_vf: 1.5
  adu_lookback_days: 90
```

---

## Integration with Other Components

```
TOC Settings is read by:
  buffer_calculator._get_settings()      → zone thresholds, warehouse_rules, item_group_rules
  buffer_calculator._get_warehouse_lists() → warehouse classification
  buffer_calculator._resolve_buffer_type() → item_group_rules
  dbm_engine.evaluate_all_dbm()          → enable_dbm, TMR/TMG params
  mr_generator.generate_material_requests() → auto_generate_mr, mr_zones, notify_on_red
  TOCItemBuffer.calculate_zone_thresholds() → yellow_zone_threshold

TOC Settings is written by:
  toc_api.apply_global_daf()             → default_daf, daf_event_name
  reorder_override.toc_reorder_item()    → auto-disables if re-enabled (NOT TOC Settings — Stock Settings)
  demo_data.create_demo_data()           → demo_data_manifest
```
