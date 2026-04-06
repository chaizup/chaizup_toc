# setup — Installation & Uninstallation Hooks

Runs once during `bench install-app chaizup_toc` and once during `bench uninstall-app chaizup_toc`. Handles all one-time setup that cannot be expressed in fixtures or DocType JSON.

---

## install.py

### `after_install()`

Called via `hooks.py → after_install`. The full installation sequence:

```
bench install-app chaizup_toc
    └─► after_install()
            1. _disable_default_auto_reorder()
            2. _install_custom_fields()
            3. _setup_roles()
            4. _create_number_cards()
            5. _create_dashboard_charts()
            6. frappe.db.commit()
```

### `before_uninstall()`

Called via `hooks.py → before_uninstall`. Re-enables `Stock Settings.auto_indent = 1` so ERPNext's built-in reorder works after TOC is removed.

```python
def before_uninstall():
    frappe.db.set_single_value("Stock Settings", "auto_indent", 1)
    frappe.db.commit()
```

---

## _disable_default_auto_reorder()

```python
frappe.db.set_single_value("Stock Settings", "auto_indent", 0)
```

**Critical**: If `auto_indent` remains enabled, ERPNext's `reorder_item.reorder_item()` scheduler would create standard reorder-level MRs nightly — completely different logic from TOC BP%-based MRs. Running both simultaneously would produce duplicate and conflicting Material Requests.

Even if this fails (wrapped in try/except), the `override_whitelisted_methods` hook in `hooks.py` provides a belt-and-suspenders safeguard by intercepting any calls to `reorder_item`.

---

## _install_custom_fields()

Uses `frappe.custom.doctype.custom_field.create_custom_fields(update=True)` to add fields.

All custom fields use `module = "Chaizup Toc"` (matched by fixtures in `hooks.py`).

### Item Custom Fields — TOC Setting Tab

The tab is inserted after the existing `reorder_levels` tab. Five sections:

#### Section 1: Enable & Classification

| Fieldname | Type | Key |
|-----------|------|-----|
| `custom_toc_tab` | Tab Break | Creates "TOC Setting" tab |
| `custom_toc_enabled` | Check | Master switch for this item |
| `custom_toc_buffer_type` | Select (FG/SFG/RM/PM) | Determines IP formula and MR type |
| `custom_toc_auto_purchase` | Check | Creates Purchase MRs when buffer low |
| `custom_toc_auto_manufacture` | Check | Creates Manufacture MRs when buffer low |

Dependencies:
- `custom_toc_buffer_type` → `mandatory_depends_on="eval:doc.custom_toc_enabled"` (required only when enabled)
- `custom_toc_auto_purchase` → `depends_on="eval:doc.custom_toc_enabled"` (hidden when disabled)

#### Section 2: ADU — Average Daily Usage

| Fieldname | Type | Key |
|-----------|------|-----|
| `custom_toc_custom_adu` | Check | R1: Manual ADU mode (scheduler skips this item) |
| `custom_toc_adu_period` | Select | 30/90/180/365 days lookback; hidden in manual mode |
| `custom_toc_adu_value` | Float | units/day; read-only in auto mode |
| `custom_toc_adu_last_updated` | Datetime | When auto-calc last ran; hidden in manual mode |

Key dependency: `custom_toc_adu_period` → `depends_on="eval:doc.custom_toc_enabled && !doc.custom_toc_custom_adu"`
When Custom ADU is checked, period selector hides (irrelevant) and ADU Value becomes editable.

#### Section 3: T/CU (FG only, collapsible)

| Fieldname | Type | Description |
|-----------|------|-------------|
| `custom_toc_selling_price` | Currency | Selling price per unit |
| `custom_toc_tvc` | Currency | Truly Variable Cost (RM + PM only — NOT labour/rent) |
| `custom_toc_constraint_speed` | Float | VFFS speed in units/minute for this SKU |
| `custom_toc_tcu` | Currency | F5: read-only, auto-calculated = (Price − TVC) × Speed |

Only shown when `custom_toc_buffer_type == "FG"`. Collapsible to reduce clutter for RM/PM items.

#### Section 4: BOM & SFG Dependency (FG/SFG only, collapsible)

| Fieldname | Type | Description |
|-----------|------|-------------|
| `custom_toc_default_bom` | Link → BOM | Active BOM for this item (validated on save) |
| `custom_toc_check_bom_availability` | Check | Enable multi-level BOM component check |

Only shown for FG and SFG buffer types. Enables the system to check if all SFG/RM/PM components are available before recommending production.

#### Section 5: Buffer Rules per Warehouse

| Fieldname | Type | Description |
|-----------|------|-------------|
| `custom_toc_buffer_rules` | Table → TOC Item Buffer | One row per warehouse |

This is where ADU, RLT, VF, and DAF are stored per warehouse. F1 and F6 are calculated here.

---

### Material Request Custom Fields — TOC App Tab

Tab inserted after `terms`. All fields are read-only (set by system at MR creation time).

| Fieldname | Type | Notes |
|-----------|------|-------|
| `custom_toc_recorded_by` | Select (By User / By System) | "By System" = auto-generated; in_list_view=1, in_standard_filter=1 |
| `custom_toc_zone` | Select (zone) | Zone at MR creation time; in_list_view=1 |
| `custom_toc_bp_pct` | Percent | F3 at creation |
| `custom_toc_target_buffer` | Float | F1 at creation |
| `custom_toc_inventory_position` | Float | F2 at creation |
| `custom_toc_sr_pct` | Percent | SR% at creation (= 100 − BP%) |

**Why capture at creation time?** Buffer data changes continuously. The MR records the exact state that triggered its creation — important for audit trail ("this MR was created at BP=72%, IP=47, Target=168").

---

### Work Order Custom Fields — TOC App Tab

| Fieldname | Type | Notes |
|-----------|------|-------|
| `custom_toc_recorded_by` | Select | Origin tracking (By User / By System) |
| `custom_toc_zone` | Select | Zone when WO was created; in_standard_filter=1 |
| `custom_toc_bp_pct` | Percent | BP% at WO creation — priority indicator |

Red/Black WOs have **absolute priority** on the constraint machine (VFFS) — the supervisor uses this field to sequence work orders.

---

## _setup_roles()

Creates two Frappe Roles with `desk_access=1`:

| Role | Purpose |
|------|---------|
| `TOC Manager` | Full access: trigger MRs, apply DAF, view all reports, manage settings |
| `TOC User` | Read-only: view dashboard, reports, buffer logs |

These roles are also used in:
- `permissions.py has_app_permission()` — determines who sees the TOC tile
- `permissions.py has_buffer_log_permission()` — determines write access to Buffer Logs
- `trigger_manual_run()` — restricted to TOC Manager
- `apply_global_daf()` — restricted to TOC Manager

---

## _create_number_cards()

Creates 4 workspace Number Cards. All use `type="Custom"` + `method=` pattern.

**Why `type="Custom"` instead of standard count?**
Standard Number Cards use `filters_json` with date conditions like `"log_date","=","Today"`. Frappe v14+ changed how it parses date filter values — `"Today"` (string) stopped working and requires `"Timespan","today"` tuple format. The `type="Custom"` approach avoids this entirely by calling a Python method that handles date logic server-side.

**Force-recreate pattern:**
```python
if frappe.db.exists("Number Card", cd["name"]):
    frappe.delete_doc("Number Card", cd["name"], force=True, ignore_permissions=True)
nc = frappe.new_doc("Number Card")
nc.update(cd)
nc.insert()
```

This handles re-installation scenarios where old broken cards exist.

| Card | Method | Color |
|------|--------|-------|
| TOC - Items in Red Zone | `nc_red_zone_count` | #E74C3C |
| TOC - Items in Yellow Zone | `nc_yellow_zone_count` | #F39C12 |
| TOC - Items in Green Zone | `nc_green_zone_count` | #27AE60 |
| TOC - Open Material Requests | `nc_open_mr_count` | #3498DB |

---

## _create_dashboard_charts()

Creates one Donut chart showing zone distribution from `TOC Buffer Log`.

```python
c.chart_type = "Group By"
c.document_type = "TOC Buffer Log"
c.group_by_type = "Count"
c.group_by_based_on = "zone"
c.type = "Donut"
c.filters_json = "[]"   # Empty! No date filter — shows ALL logs (most recent in DB)
```

**Why empty filters?** Adding a date filter (e.g., "today only") would require the `"Timespan","today"` format which is version-sensitive. An empty filter shows a zone distribution across all historical logs — dominated by recent data since today's logs are the most numerous. The TOC Dashboard has its own real-time donut chart (SVG-based) that shows truly live data.

---

## Installation Verification Checklist

After `bench install-app chaizup_toc`, verify:

```bash
# 1. Custom fields installed
bench --site your-site execute frappe.db.exists "Custom Field" "Item-custom_toc_enabled"

# 2. Roles created
bench --site your-site execute frappe.db.exists "Role" "TOC Manager"

# 3. ERPNext auto-reorder disabled
bench --site your-site get-doc "Stock Settings" | grep auto_indent
# Expected: "auto_indent": 0

# 4. Number cards exist
bench --site your-site execute frappe.db.exists "Number Card" "TOC - Items in Red Zone"

# 5. Module registered
grep "Chaizup Toc" apps/chaizup_toc/chaizup_toc/modules.txt

# 6. Workspace visible
bench --site your-site execute frappe.db.exists "Workspace" "TOC Buffer Management"
```

---

## Re-installation Notes

If you need to reinstall custom fields after schema changes:
```bash
bench --site your-site migrate   # runs patches only
# OR
bench --site your-site execute \
    "chaizup_toc.setup.install._install_custom_fields()"
```

`create_custom_fields(update=True)` is idempotent — safe to run multiple times. Existing fields are updated with new properties without deleting data.
