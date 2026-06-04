# Copyright (c) 2026, Chaizup and Contributors
# See license.txt

# import frappe
from frappe.tests import IntegrationTestCase


# On IntegrationTestCase, the doctype test records and all
# link-field test record dependencies are recursively loaded
# Use these module variables to add/remove to/from that list
EXTRA_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]
IGNORE_TEST_RECORD_DEPENDENCIES = []  # eg. ["User"]



class IntegrationTestTOCSettings(IntegrationTestCase):
	"""
	Integration tests for TOCSettings.
	Use this class for testing interactions between multiple components.
	"""

	# -------------------------------------------------------------------------
	# Configurable Automation Triggers (2026-06-04)
	# Regression guard for the per-trigger pending-status override resolver.
	# The contract: a BLANK row cell inherits the global TOC Settings value;
	# a filled cell overrides it. Blank == legacy behaviour byte-for-byte.
	# -------------------------------------------------------------------------
	def _so_shortage_row(self, s):
		for r in s.get("trigger_configurations") or []:
			if r.trigger_key == "so_shortage":
				return r
		return None

	def test_row_override_blank_inherits_global(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
		s = frappe.get_doc("TOC Settings")
		row = self._so_shortage_row(s)
		self.assertIsNotNone(row, "so_shortage row must be auto-seeded")
		row.pending_wo_statuses = ""
		s.flags.ignore_mandatory = True
		s.save(ignore_permissions=True)
		frappe.db.commit()
		self.assertEqual(row_override("wo", trigger_key="so_shortage"), "")

	def test_row_override_returns_cell_when_set(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine.pending_status import row_override
		s = frappe.get_doc("TOC Settings")
		row = self._so_shortage_row(s)
		row.pending_wo_statuses = "In Process"
		s.flags.ignore_mandatory = True
		s.save(ignore_permissions=True)
		frappe.db.commit()
		self.assertEqual(row_override("wo", trigger_key="so_shortage"), "In Process")
		# reset so other tests / the live row stay on the inherit default
		row.pending_wo_statuses = ""
		s.save(ignore_permissions=True)
		frappe.db.commit()

	def test_blank_row_matches_global_status_lists(self):
		"""The deep WO/PO helper must return the SAME lists with a blank
		override as it does with no active trigger (pure global read)."""
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine.production_plan_engine import (
			_toc_wo_statuses_and_wf, _toc_po_statuses_and_wf,
		)
		frappe.flags.toc_trigger_key = None
		g_wo, g_po = _toc_wo_statuses_and_wf(), _toc_po_statuses_and_wf()
		try:
			frappe.flags.toc_trigger_key = "so_shortage"
			self.assertEqual(_toc_wo_statuses_and_wf(), g_wo)
			self.assertEqual(_toc_po_statuses_and_wf(), g_po)
		finally:
			frappe.flags.toc_trigger_key = None

	def test_all_engines_seeded(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine import trigger_registry
		s = frappe.get_doc("TOC Settings")
		seeded = {r.trigger_key for r in s.get("trigger_configurations") or []}
		want = {t["key"] for t in trigger_registry.all_triggers()}
		self.assertTrue(want.issubset(seeded), f"missing seeded rows: {want - seeded}")

	def test_edit_time_updates_scheduled_job_type(self):
		import frappe
		from chaizup_toc.chaizup_toc.toc_engine import trigger_registry
		method = trigger_registry.job_method_for("buffer_snapshot")
		s = frappe.get_doc("TOC Settings")
		for r in s.trigger_configurations:
			if r.trigger_key == "buffer_snapshot":
				r.schedule_time = "08:00"
				r.enabled = 1
		s.flags.ignore_mandatory = True
		s.save(ignore_permissions=True)
		frappe.db.commit()
		cron = frappe.db.get_value("Scheduled Job Type", {"method": method}, "cron_format")
		self.assertEqual(cron, "0 8 * * *")
