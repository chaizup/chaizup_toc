# toc_item_buffer — TOC Item Buffer DocType (Child Table)

Per-warehouse buffer rule for a TOC-managed item. Lives as a child table row on `Item.custom_toc_buffer_rules`. One row = one warehouse buffer rule.

---

## Relationship

```
Item (built-in ERPNext)
└── custom_toc_buffer_rules (Table field)
    └── TOC Item Buffer (this DocType — istable=1)
        ├── Row 1: Warehouse = "FG Store", ADU=10, RLT=7, VF=1.5 → Target=105
        └── Row 2: Warehouse = "Branch", ADU=3, RLT=14, VF=1.8 → Target=76
```

`istable: 1` — never a standalone document. Always accessed as `item.custom_toc_buffer_rules`.

---

## Fields

### Core Buffer Inputs (F1)

| Fieldname | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `warehouse` | Link → Warehouse | ✓ | — | Buffer's home warehouse. On-hand stock, backorders, committed all measured here (or across classified warehouse groups if Warehouse Rules configured) |
| `adu` | Float | ✓ | — | Average Daily Usage in units/day. How many units consumed per day on average. Source: Delivery Notes (FG), Stock Entries (RM/PM/SFG). User enters manually or syncs from Item.custom_toc_adu_value |
| `rlt` | Float | ✓ | — | Replenishment Lead Time in days. FG: blend+fill+QC+move days. RM: PO to GRN average. Average last 10 replenishment cycles |
| `variability_factor` | Float | ✓ | 1.5 | VF: buffer size multiplier for variability. 1.0–1.3=stable, 1.3–1.6=moderate, 1.6–2.0=volatile/seasonal |

### Calculated Buffers (read-only, auto-set by validate)

| Fieldname | Type | Formula | Description |
|-----------|------|---------|-------------|
| `target_buffer` | Float | `ADU × RLT × VF` | F1: base buffer size without seasonal adjustment |
| `daf` | Float | — | F6: Demand Adjustment Factor. Default 1.0 (no adjustment) |
| `adjusted_buffer` | Float | `Target × DAF` | F6: seasonal buffer. Used instead of target when DAF ≠ 1.0. Set to 0 when DAF=1.0 (signals "use target_buffer") |
| `red_zone_qty` | Float | `effective × (yellow_threshold/100)` | Physical stock below this quantity = Red Zone |
| `yellow_zone_qty` | Float | `effective × (1 - yellow_threshold/100)` | Physical stock below this = Yellow Zone |

### DBM Tracking (collapsible, read-only)

| Fieldname | Type | Description |
|-----------|------|-------------|
| `tmr_count` | Int | Consecutive TMR (Too Much Red) increases. Safeguard blocks at max (default 3). Reset to 0 when TMG fires |
| `tmg_green_days` | Int | Not actively used in current DBM engine (TMG uses TOC Buffer Log query instead). Kept for future use |
| `last_dbm_date` | Date | Date of most recent TMR or TMG evaluation |

### Status

| Fieldname | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | Check | 1 | Uncheck to disable rule without deleting. Disabled rules are excluded from `calculate_all_buffers()` |

---

## Controller — toc_item_buffer.py

`validate()` runs all four methods in sequence whenever the Item is saved:

### 1. calculate_target_buffer() — F1

```python
def calculate_target_buffer(self):
    self.target_buffer = round(flt(self.adu) * flt(self.rlt) * flt(self.variability_factor))
```

**Example:**
```
ADU=10, RLT=7, VF=1.5
Target = 10 × 7 × 1.5 = 105 units
```

Note: `round()` (not `int()`) for proper rounding. A VF of 1.33 with ADU=10, RLT=7 gives 93.1 → rounds to 93.

### 2. calculate_adjusted_buffer() — F6

```python
def calculate_adjusted_buffer(self):
    daf = flt(self.daf) or 1.0
    if daf != 1.0:
        self.adjusted_buffer = round(flt(self.target_buffer) * daf)
    else:
        self.adjusted_buffer = 0   # Sentinel value: "not adjusted — use target_buffer"
```

**Why 0 as sentinel?** `_calculate_single()` reads:
```python
target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
```
`flt(0) or flt(105)` evaluates `0` as falsy → falls back to `target_buffer`. This is intentional — a stored value of 0 means "no DAF applied, use base target."

**Example:**
```
target_buffer=105, daf=1.6 (Diwali)
adjusted_buffer = round(105 × 1.6) = 168

Effective buffer in calculations: 168
F3 BP% = (168 − IP) / 168 × 100
```

### 3. calculate_zone_thresholds()

```python
def calculate_zone_thresholds(self):
    effective = flt(self.adjusted_buffer) or flt(self.target_buffer)
    try:
        settings = frappe.get_cached_doc("TOC Settings")
        yellow_threshold = flt(settings.yellow_zone_threshold)  # default 33
    except Exception:
        yellow_threshold = 33.0   # fallback for fresh install

    # Red zone: below 33% of effective buffer
    self.red_zone_qty   = round(effective * yellow_threshold / 100)
    # Yellow zone boundary: below 67% of effective buffer
    self.yellow_zone_qty = round(effective * (1 - yellow_threshold / 100))
```

**Example with effective=168, yellow_threshold=33:**
```
red_zone_qty   = round(168 × 0.33) = 55   ← stock < 55 = RED
yellow_zone_qty = round(168 × 0.67) = 113  ← stock < 113 = YELLOW
```

These are reference quantities for operators who prefer to think in units rather than percentages.

### 4. validate_inputs()

| Condition | Response | Why |
|-----------|----------|-----|
| `adu <= 0` | `frappe.throw()` | Zero ADU → Target=0 → item always skipped |
| `rlt <= 0` | `frappe.throw()` | Zero RLT → Target=0 → item always skipped |
| `vf < 1.0` | `frappe.throw()` | VF<1 would shrink buffer below expected consumption |
| `vf > 3.0` | `frappe.msgprint()` (warning) | Extremely high VF suggests misconfiguration |
| `daf < 0.1 or > 5.0` | `frappe.throw()` | DAF outside reasonable seasonal range |

---

## Effective Buffer Selection Logic

```
adjusted_buffer = 0    →  use target_buffer as effective
adjusted_buffer ≠ 0    →  use adjusted_buffer as effective (DAF applied)

This means DAF=1.0 stores adjusted_buffer=0, not 105.
DAF=1.6 stores adjusted_buffer=168.
```

In `_calculate_single()`:
```python
target = flt(rule.adjusted_buffer) or flt(rule.target_buffer)
```

---

## DBM Auto-Update (Weekly)

The `dbm_engine._evaluate_single()` writes directly via `frappe.db.set_value()`:

**TMR (Too Much Red — buffer increased):**
```python
frappe.db.set_value("TOC Item Buffer", rule.name, {
    "target_buffer": new_target,
    "tmr_count": (rule.tmr_count or 0) + 1,
    "tmg_green_days": 0,
    "last_dbm_date": today(),
})
```

**TMG (Too Much Green — buffer decreased):**
```python
frappe.db.set_value("TOC Item Buffer", rule.name, {
    "target_buffer": new_target,
    "tmr_count": 0,
    "tmg_green_days": 0,
    "last_dbm_date": today(),
})
```

Note: `set_value()` bypasses `validate()` — DBM changes do not trigger a full recalculation of zone thresholds or DAF. To recalculate all fields after DBM update, call `recalculate_item_buffers(item_code)` API.

---

## How to Read This in Python

```python
# Get all buffer rules for an item
item = frappe.get_doc("Item", "FG-MASALA-1KG")
for rule in item.get("custom_toc_buffer_rules") or []:
    print(rule.warehouse, rule.adu, rule.rlt, rule.target_buffer, rule.zone)

# Direct query (faster for batch processing)
rules = frappe.get_all("TOC Item Buffer",
    filters={"parent": "FG-MASALA-1KG", "parentfield": "custom_toc_buffer_rules", "enabled": 1},
    fields=["*"])
```

---

## Common Configuration Examples

### Typical FG Item (Manufactured)
```
Warehouse: Finished Goods Store
ADU: 10 units/day     (from 90-day Delivery Note average)
RLT: 7 days           (blend 2d + fill 2d + QC 2d + move 1d)
VF:  1.5              (moderate demand variability)
DAF: 1.6              (Diwali season — 60% uplift)

Target Buffer = 10 × 7 × 1.5 = 105 units
Adjusted Buffer = 105 × 1.6 = 168 units (effective during Diwali)
Red Zone < 55 units   (33% of 168)
Yellow Zone < 113 units  (67% of 168)
```

### Typical RM Item (Purchased, stable supplier)
```
Warehouse: Raw Material Store
ADU: 30 kg/day        (consumed in production, from Stock Entries)
RLT: 5 days           (local supplier, fast delivery)
VF:  1.2              (stable supplier and demand)

Target Buffer = 30 × 5 × 1.2 = 180 kg
Red Zone < 59 kg
Yellow Zone < 121 kg
```

### Volatile Seasonal RM (e.g., agricultural commodity)
```
ADU: 50 kg/day
RLT: 21 days          (imported, long lead time)
VF:  2.0              (high price/supply variability)

Target Buffer = 50 × 21 × 2.0 = 2,100 kg
```

---

## Fixed Bug History

### BUG-001: Missing hook target function (CRITICAL)
`hooks.py` referenced `chaizup_toc.overrides.item.on_buffer_rule_validate` as doc_event for "TOC Item Buffer". Function didn't exist → every Item save failed with AttributeError. **Fixed**: removed the `"TOC Item Buffer"` doc_event entry; all calculations in `TOCItemBuffer.validate()`.

### BUG-002: Dead variable `yel_pct`
`calculate_zone_thresholds()` computed `yel_pct = yellow_threshold / 100` but used `yellow_threshold / 100` in the formula directly. **Fixed**: removed unused variable.

### BUG-003: No fallback for missing TOC Settings
`frappe.get_cached_doc("TOC Settings")` without try/except → crash on fresh install before settings are saved. **Fixed**: wrapped in try/except with `yellow_threshold = 33.0` default.
