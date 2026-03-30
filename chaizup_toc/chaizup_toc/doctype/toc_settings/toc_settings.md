# `toc_settings/` — TOC Settings DocType

## Role
Single-instance ("singleton") configuration document for the entire app. One per site.

`issingle: 1` — no list view, accessed via `/app/toc-settings`.

## First-Time Setup Order

Configure sections in this priority order before enabling items:

| Step | Section | Why First? |
|------|---------|-----------|
| 1 | **Inventory Classification → Warehouse Rules** | Defines what counts as on-hand vs WIP vs excluded. Wrong setup → Scrap/Expiry stock counted in buffers. |
| 2 | **Inventory Classification → Item Group Rules** | Auto-assigns FG/SFG/RM/PM from item groups. Without this, every item needs manual type selection. |
| 3 | Zone Thresholds | Defaults (33/67%) work for most companies. |
| 4 | MR Generation | Toggle `auto_generate_mr`, choose zones. |
| 5 | Enable items | Buffer type resolves automatically from group rules. |
| 6 | DBM | Enable after first month of buffer log data. |

---

## Sections and Fields

### Inventory Classification (configure first)

| Field | Type | Description |
|-------|------|-------------|
| `warehouse_rules` | Table → `TOC Warehouse Rule` | Classify each warehouse: Inventory / WIP / Excluded |
| `item_group_rules` | Table → `TOC Item Group Rule` | Map item groups to FG/SFG/RM/PM buffer types |

See `toc_warehouse_rule/toc_warehouse_rule.md` and `toc_item_group_rule/toc_item_group_rule.md` for full details.

**If `warehouse_rules` is empty:** calculator falls back to per-rule warehouse (backward-compatible).
**If `item_group_rules` is empty:** items must have `custom_toc_buffer_type` set manually.

### Zone Thresholds (F3)

| Field | Default | Description |
|-------|---------|-------------|
| `red_zone_threshold` | 67 | BP% >= this → Red Zone |
| `yellow_zone_threshold` | 33 | BP% >= this → Yellow Zone |
| `auto_generate_mr` | 1 | Toggle daily automatic MR creation |
| `mr_zones` | "Red, Black, and Yellow" | Which zones trigger MR creation |
| `notify_on_red` | 1 | Send email when items enter Red/Black |
| `red_alert_roles` | "Stock Manager\nPurchase Manager" | Newline-separated role names for email recipients |

### Dynamic Buffer Management (DBM)
| Field | Default | Description |
|-------|---------|-------------|
| `enable_dbm` | 1 | Toggle weekly DBM auto-adjustment |
| `tmr_red_pct_of_rlt` | 20 | F7: Red days > 20% of RLT → increase buffer |
| `tmg_cycles_required` | 3 | F8: Must be Green for 3 full RLT cycles to decrease |
| `dbm_adjustment_pct` | 33 | F7/F8: Increase/decrease by ±33% |
| `max_tmr_consecutive` | 3 | Safeguard: Max consecutive TMR increases before manual review |
| `min_buffer_floor` | 50 | Safeguard: TMG never shrinks buffer below this qty |

### Calculation Defaults
| Field | Default | Description |
|-------|---------|-------------|
| `default_vf` | 1.5 | Default Variability Factor for new rules |
| `adu_lookback_days` | 90 | Default ADU calculation period |
| `default_daf` | 1.0 | Current global DAF (1.0 = normal) |
| `daf_event_name` | — | Label for current DAF event (e.g. "Diwali 2026") |

### Demo Data (hidden/collapsible)
| Field | Description |
|-------|-------------|
| `demo_data_manifest` | JSON tracking all demo documents. Hidden from UI. Used by `delete_demo_data()`. |

## Controller (`toc_settings.py`)

### `validate()`
Three validation rules:
1. `red_zone_threshold > yellow_zone_threshold` — throws if inverted.
2. `1 <= dbm_adjustment_pct <= 100` — throws if out of range.
3. `default_vf >= 1.0` — throws if below 1.

## Permissions
| Role | Read | Write | Create |
|------|------|-------|--------|
| System Manager | ✓ | ✓ | ✓ |
| Stock Manager | ✓ | ✓ | — |
| TOC Manager | ✓ | ✓ | — |

## Caching
The buffer calculator uses `frappe.get_cached_doc("TOC Settings")`. This means changes to settings take effect on the next cache clear or server restart. Immediate effect requires `bench clear-cache`.

## Access Patterns
```python
# Read (with cache)
settings = frappe.get_cached_doc("TOC Settings")
settings.red_zone_threshold  # 67

# Write (bypasses controller)
frappe.db.set_single_value("TOC Settings", "default_daf", 1.6)
frappe.db.set_single_value("TOC Settings", "daf_event_name", "Diwali 2026")

# Read single value
daf = frappe.db.get_single_value("TOC Settings", "default_daf")
```
