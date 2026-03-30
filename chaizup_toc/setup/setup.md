# `setup/` — Installation & Uninstallation Hooks

## Purpose
Runs once during `bench install-app chaizup_toc` and once during `bench uninstall-app chaizup_toc`. Handles all one-time setup that cannot be expressed in fixtures or DocType JSON.

---

## `install.py`

### `after_install()`
Called via `hooks.py → after_install`.

Order of operations:
1. `_disable_default_auto_reorder()` — turns off ERPNext's stock auto-indent
2. `_install_custom_fields()` — adds all TOC fields to Item, Material Request, Work Order
3. `_setup_roles()` — creates `TOC Manager` and `TOC User` roles
4. `_create_number_cards()` — creates 4 workspace number cards
5. `_create_dashboard_charts()` — creates 1 donut chart
6. `frappe.db.commit()`

### `before_uninstall()`
Called via `hooks.py → before_uninstall`.
Re-enables `Stock Settings.auto_indent = 1` (safety net — user had it before TOC).

---

### `_disable_default_auto_reorder()`
Sets `Stock Settings.auto_indent = 0`.

This is critical: if left enabled, ERPNext's default scheduler would create standard reorder-level-based MRs that conflict with TOC's BP%-based MRs.

---

### `_install_custom_fields()`
Uses `frappe.custom.doctype.custom_field.create_custom_fields()` to add fields.

All custom fields have `module = "Chaizup Toc"` so they appear in `fixtures` exports.

#### Item Custom Fields (TOC Setting tab)

**Section 1 — Enable & Classification:**
| Field | Type | Description |
|-------|------|-------------|
| `custom_toc_tab` | Tab Break | Creates "TOC Setting" tab after reorder_levels |
| `custom_toc_enabled` | Check | Master switch |
| `custom_toc_buffer_type` | Select | FG / SFG / RM / PM |
| `custom_toc_auto_purchase` | Check | Creates Purchase MRs |
| `custom_toc_auto_manufacture` | Check | Creates Manufacture MRs |

**Section 2 — ADU (Average Daily Usage):**
| Field | Type | Description |
|-------|------|-------------|
| `custom_toc_custom_adu` | Check | R1: Manual ADU mode — skips auto-calculate |
| `custom_toc_adu_period` | Select | Lookback window (30/90/180/365 days) |
| `custom_toc_adu_value` | Float | ADU in units/day |
| `custom_toc_adu_last_updated` | Datetime | When auto-calc last ran |

**Section 3 — T/CU (FG only, collapsible):**
| Field | Type | Description |
|-------|------|-------------|
| `custom_toc_selling_price` | Currency | Selling price per unit |
| `custom_toc_tvc` | Currency | Truly Variable Cost (RM + PM only) |
| `custom_toc_constraint_speed` | Float | Units/minute on bottleneck machine |
| `custom_toc_tcu` | Currency | F5: (Price - TVC) × Speed, read-only |

**Section 4 — BOM/SFG (collapsible, FG/SFG only):**
| Field | Type | Description |
|-------|------|-------------|
| `custom_toc_default_bom` | Link→BOM | Default BOM for BOM availability check |
| `custom_toc_check_bom_availability` | Check | Enable BOM component check |

**Section 5 — Buffer Rules per Warehouse:**
| Field | Type | Description |
|-------|------|-------------|
| `custom_toc_buffer_rules` | Table→TOC Item Buffer | Child table: one row per warehouse |

#### Material Request Custom Fields (TOC App tab)
| Field | Type | Notes |
|-------|------|-------|
| `custom_toc_recorded_by` | Select (By User / By System) | Auto-set for system MRs |
| `custom_toc_zone` | Select (zone) | Zone at MR creation |
| `custom_toc_bp_pct` | Percent | BP% at MR creation |
| `custom_toc_target_buffer` | Float | F1 value at MR creation |
| `custom_toc_inventory_position` | Float | F2 value at MR creation |
| `custom_toc_sr_pct` | Percent | SR% at MR creation |

#### Work Order Custom Fields (TOC App tab)
| Field | Type | Notes |
|-------|------|-------|
| `custom_toc_recorded_by` | Select | Origin tracking |
| `custom_toc_zone` | Select | Zone at WO creation |
| `custom_toc_bp_pct` | Percent | BP% at WO creation |

---

### `_setup_roles()`
Creates Frappe Roles: `TOC Manager` and `TOC User` (desk access only).

---

### `_create_number_cards()`
Creates 4 Number Cards for the workspace:

| Card Name | Color | Method |
|-----------|-------|--------|
| TOC - Items in Red Zone | #E74C3C | `nc_red_zone_count` |
| TOC - Items in Yellow Zone | #F39C12 | `nc_yellow_zone_count` |
| TOC - Items in Green Zone | #27AE60 | `nc_green_zone_count` |
| TOC - Open Material Requests | #3498DB | `nc_open_mr_count` |

All use `type="Custom"` + `method=` to call Python APIs. This avoids Frappe's broken `"Today"` date filter parsing in Number Cards.

**Force-recreate pattern**: The function deletes existing cards before creating them. This handles the case where a previous install created broken cards (the fix_date_filters patch problem).

---

### `_create_dashboard_charts()`
Creates one Dashboard Chart:
- `chart_name`: "TOC - Zone Distribution"
- `chart_type`: "Group By", `group_by_based_on`: "zone", `type`: "Donut"
- `filters_json`: `"[]"` (no date filter — avoids Timespan parsing errors)
- Force-recreates same as Number Cards.

---

## Bugs / Notes in `setup/`

### Why force-delete+recreate for Number Cards and Charts?
Previous versions of the app created Number Cards with date filters using `"Today"` as a raw string, which breaks in Frappe v14+ (expects `"Timespan","today"`). The install code now deletes old broken cards and recreates them correctly. The `patches/v1_0/fix_date_filters.py` handles this for existing installs.
