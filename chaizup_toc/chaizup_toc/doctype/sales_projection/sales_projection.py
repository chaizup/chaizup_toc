# =============================================================================
# CONTEXT: Sales Projection DocType controller. Enforces two business rules:
#   1. No duplicate item codes within the same projection's child table (table_mibv).
#   2. No two non-cancelled Sales Projections for the same month + year + warehouse.
#      The same month+year is allowed for different warehouses, and vice versa.
#   Both rules run on validate() (every save) and before_submit() (submit safety net).
# MEMORY:  sales_projection.md § Validation Rules
# INSTRUCTIONS:
#   - Child table fieldname in JSON is `table_mibv` — all self.table_mibv references
#     depend on this name. If JSON fieldname ever changes, update here too.
#   - frappe.db.commit() is NOT needed — Frappe auto-commits on successful save.
#   - _validate_required_header_fields() must run BEFORE the duplicate checks
#     to avoid misleading errors when month/year/warehouse/rows are empty.
# DANGER ZONE:
#   - `table_mibv` is the actual DB fieldname (from JSON) — not `projected_items`.
#     Renaming the JSON fieldname without updating this file breaks every method.
#   - _validate_unique_period_warehouse() filters `docstatus IN (0, 1)` —
#     a POSITIVE allowlist of Draft + Submitted. Cancelled docs are skipped by
#     omission, so a cancelled projection can NEVER block re-creation for the
#     same period+warehouse (this is the cancel→amend→resubmit unlock).
#   - self.name for a new (unsaved) document is a Frappe temp hash, never equal to
#     an existing doc name — the ("!=", self.name) filter is always safe.
#   - source_warehouse is reqd=1 in JSON AND checked in _validate_required_header_fields.
#     The DB uniqueness query assumes self.source_warehouse is always populated by this point.
# RESTRICT:
#   - Do not remove _validate_no_duplicate_items. Production team uses this doc as
#     the minimum-production target per item; duplicate rows cause silent data errors.
#   - Do not remove _validate_unique_period_warehouse. Two projections for the same
#     period+warehouse create conflicting production targets with no clear winner.
#   - Do not remove before_submit() — JS validate hook can be bypassed via API calls.
#   - Do not flip the docstatus filter back to a negative `!= 2` form. The positive
#     allowlist `["in", [0, 1]]` is intentional — it future-proofs against new
#     docstatus enum values and reads clearly as "Draft + Submitted block; nothing else".
#   - Do not collapse the uniqueness key back to month+year only — warehouse was added
#     intentionally to allow separate projections per warehouse per period.
# =============================================================================

# Copyright (c) 2026, Chaizup and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class SalesProjection(Document):

	def validate(self):
		self._validate_required_header_fields()
		self._validate_not_past_month()
		self._validate_no_duplicate_items()
		self._validate_unique_period_warehouse()

	def before_submit(self):
		# Server-side safety net — JS validate can be bypassed via API
		self._validate_not_past_month()
		self._validate_no_duplicate_items()
		self._validate_unique_period_warehouse()

	# =========================================================================
	# CONTEXT (CIRCULAR CANCEL DEADLOCK FIX — 2026-05-12):
	#   The PP Automation engine writes the Sales Projection's docname into
	#   `Production Plan.custom_projection_reference` (Link field). Frappe's
	#   default cancellation guard (`check_no_back_links_exist`) scans every
	#   DocType in the system for inbound Link fields pointing to this doc
	#   AND a docstatus < 2 — finds those PPs and throws LinkExistsError
	#   ("Cannot cancel — linked with Production Plan").
	#
	#   At the same time, the SP's own child table (Sales Projected Items)
	#   has `wo_name` as a Link → Production Plan, so the symmetric guard on
	#   the PP side blocks PP cancel ("Cannot cancel — linked with Sales
	#   Projection"). The user-visible result is a circular deadlock: each
	#   document tells the user to cancel the OTHER one first.
	#
	#   The break-out: tell Frappe to skip the back-link guard ONLY for this
	#   SP cancel. `self.flags.ignore_links = True` is the documented hook
	#   that `check_no_back_links_exist` honours (frappe/model/document.py).
	#
	# DANGER ZONE:
	#   - This bypass is scoped to ONE docstatus transition (1 → 2) of THIS
	#     SP only. It does NOT affect future cancels of other docs.
	#   - The PP keeps its `custom_projection_reference` value after the SP
	#     is cancelled. That's intentional — the reference is to a Sales
	#     Projection docname, which still exists (just with docstatus=2).
	#     Engine dedup, run-log linkage, and email reports all keep working
	#     because they query by docname, not docstatus.
	#   - The complementary PP-side severing of `Sales Projected Items.wo_name`
	#     happens in the `Production Plan.before_cancel` hook registered in
	#     hooks.py, NOT here. Do NOT collapse the two fixes into one place —
	#     each side owns its own half of the deadlock.
	# RESTRICT:
	#   - Do NOT switch the bypass mechanism to `frappe.flags.ignore_links`
	#     (the module-level flag). The instance flag is contained to this
	#     cancel call; the module flag leaks into unrelated cancels in the
	#     same request.
	#   - Do NOT clear `custom_projection_reference` on linked PPs here.
	#     Severing the link destroys audit traceability AND breaks the PP
	#     Automation dedup query that uses this field. Always keep the link
	#     value; only skip the existence check.
	#   - Do NOT remove this method. The SP→PP→SP deadlock is a hard block
	#     on operator workflows (cancel + new, cancel + amend); without it,
	#     users cannot cancel any SP that has produced PPs.
	# =========================================================================
	def before_cancel(self):
		self.flags.ignore_links = True

	# =========================================================================
	# CONTEXT: Blocks saving or submitting a Sales Projection for a past month.
	#   Users may only create/edit projections for the current month or future
	#   months. projection_month is a Select string ("January"…"December");
	#   projection_year is Int. Comparison uses (year, month_num) tuples.
	# DANGER ZONE:
	#   - Runs AFTER _validate_required_header_fields so month/year are guaranteed
	#     to be populated when this check executes.
	#   - Cancelled docs are still re-validated on save — but a cancelled
	#     projection is read-only in Frappe; this path is never normally reached.
	# RESTRICT:
	#   - Do not skip this in before_submit — API callers bypass JS guards.
	# =========================================================================
	_MONTH_NUM = {
		"January": 1, "February": 2, "March": 3, "April": 4,
		"May": 5, "June": 6, "July": 7, "August": 8,
		"September": 9, "October": 10, "November": 11, "December": 12,
	}

	def _validate_not_past_month(self):
		if not self.projection_month or not self.projection_year:
			return
		month_num = self._MONTH_NUM.get(self.projection_month)
		if not month_num:
			return
		today = getdate()
		proj_tuple = (int(self.projection_year), month_num)
		current_tuple = (today.year, today.month)
		if proj_tuple < current_tuple:
			frappe.throw(
				_(
					"Sales Projections can only be created or edited for the current month "
					"or future months. <b>{0} {1}</b> is in the past."
				).format(self.projection_month, self.projection_year)
			)

	# =========================================================================
	# CONTEXT: Ensures projection_month, projection_year, source_warehouse, and
	#   at least one row in the child table are present before running other
	#   validations. source_warehouse is part of the unique key so it must be
	#   checked here before the uniqueness query runs.
	# DANGER ZONE:
	#   - Must run FIRST — duplicate checks loop over self.table_mibv which throws
	#     confusing errors if header fields are None.
	# =========================================================================
	def _validate_required_header_fields(self):
		if not self.projection_month:
			frappe.throw(_("Please select a Projection Month."))
		if not self.projection_year:
			frappe.throw(_("Please enter the Projection Year."))
		if not self.source_warehouse:
			frappe.throw(_("Please select a Source Warehouse."))
		if not self.table_mibv:
			frappe.throw(_("Please add at least one item in the Projected Items table."))

	# =========================================================================
	# CONTEXT: Scans all rows in the child table for duplicate item codes.
	#   Collects all row idx values per item; if any item appears more than once,
	#   throws with a formatted message listing item + offending row numbers.
	# DANGER ZONE:
	#   - Uses row.item (Link fieldname) not row.item_name (the fetch_from Data field).
	#   - row.idx is 1-based (Frappe standard for child table row numbers).
	#   - Skips rows where row.item is falsy (blank/deleted rows during editing).
	# RESTRICT:
	#   - Do not swap frappe.throw for frappe.msgprint here — the duplicate must
	#     block saving, not just warn. JS warns (orange), Python blocks (red throw).
	# =========================================================================
	def _validate_no_duplicate_items(self):
		item_rows: dict[str, list[int]] = {}
		for row in self.table_mibv or []:
			if not row.item:
				continue
			item_rows.setdefault(row.item, []).append(row.idx)

		duplicates = {item: rows for item, rows in item_rows.items() if len(rows) > 1}
		if duplicates:
			lines = [
				f"<b>{item}</b>: rows {', '.join(str(r) for r in rows)}"
				for item, rows in duplicates.items()
			]
			frappe.throw(
				_("Duplicate items found in Projected Items table:<br>{0}").format(
					"<br>".join(lines)
				)
			)

	# =========================================================================
	# CONTEXT: Prevents two ACTIVE Sales Projections (Draft + Submitted only)
	#   for the same projection_month + projection_year + source_warehouse
	#   combination. The same month+year is allowed if the warehouse differs,
	#   and vice versa. Queries DB excluding self and ALL cancelled docs.
	#
	#   Filter uses an explicit positive allowlist `docstatus IN (0, 1)` rather
	#   than the negative `docstatus != 2` we previously had. The two are
	#   semantically equivalent today (docstatus is enum 0/1/2), but the
	#   allowlist form is more defensive — if Frappe ever introduces a new
	#   docstatus state (e.g. Pending), the allowlist auto-excludes it from
	#   "blocking duplicates" instead of silently treating it as active.
	#
	# DANGER ZONE:
	#   - docstatus must be on `["in", [0, 1]]` — Cancelled (docstatus=2) docs
	#     must NEVER block re-creation for the same period+warehouse after a
	#     correction workflow.
	#   - get_value here returns BOTH `name` and `docstatus` so the error
	#     message can label the blocker as Draft or Submitted. Do not collapse
	#     back to a single field — the user-facing distinction matters when
	#     the operator is trying to figure out which doc is in the way.
	#   - All three key fields (month, year, warehouse) must be in the filter.
	#     Removing any one turns this into a weaker partial-key check.
	# RESTRICT:
	#   - Do not narrow the allowlist to [1] (Submitted only) — Draft
	#     projections must also block a second Draft for the same key, or
	#     two operators editing in parallel will silently produce conflicting
	#     forecasts.
	#   - Do not flip the allowlist back to a negative `!= 2` filter. The
	#     positive list reads better and is robust against future docstatus
	#     enum additions.
	# =========================================================================
	def _validate_unique_period_warehouse(self):
		existing = frappe.db.get_value(
			"Sales Projection",
			{
				"projection_month": self.projection_month,
				"projection_year": self.projection_year,
				"source_warehouse": self.source_warehouse,
				"name": ("!=", self.name),
				"docstatus": ["in", [0, 1]],
			},
			["name", "docstatus"],
			as_dict=True,
		)
		if existing:
			state_label = "Submitted" if existing.docstatus == 1 else "Draft"
			frappe.throw(
				_(
					"A {0} Sales Projection for <b>{1} {2}</b> and warehouse <b>{3}</b> already exists: "
					'<a href="/app/sales-projection/{4}">{4}</a>. '
					"Cancelled projections are ignored — only Draft and Submitted projections block re-creation."
				).format(
					state_label,
					self.projection_month,
					self.projection_year,
					self.source_warehouse,
					existing.name,
				)
			)
