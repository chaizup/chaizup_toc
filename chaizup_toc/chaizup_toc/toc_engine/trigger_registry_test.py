import unittest

from chaizup_toc.chaizup_toc.toc_engine import trigger_registry as reg


class TestTriggerRegistry(unittest.TestCase):
    def test_all_triggers_has_nine_engines(self):
        keys = [t["key"] for t in reg.all_triggers()]
        self.assertEqual(
            sorted(keys),
            sorted([
                "min_order_sync", "adu_max_level", "sales_projection",
                "buffer_mr_run", "so_shortage", "procurement_monitor",
                "buffer_snapshot", "weekly_dbm", "shortage_action",
            ]),
        )

    def test_keys_are_unique(self):
        keys = [t["key"] for t in reg.all_triggers()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_get_trigger_returns_dict(self):
        t = reg.get_trigger("so_shortage")
        self.assertEqual(t["name"], "Sales Order Shortage (Calc SO)")
        self.assertTrue(t["considers"]["po"])

    def test_get_trigger_unknown_raises(self):
        with self.assertRaises(KeyError):
            reg.get_trigger("does_not_exist")

    def test_job_method_for_returns_dotted_path(self):
        self.assertEqual(
            reg.job_method_for("buffer_snapshot"),
            "chaizup_toc.tasks.daily_tasks.daily_buffer_snapshot",
        )

    def test_only_three_engines_consider_vouchers(self):
        considering = [t["key"] for t in reg.all_triggers()
                       if any(t["considers"].values())]
        self.assertEqual(
            sorted(considering),
            sorted(["sales_projection", "so_shortage", "shortage_action"]),
        )

    def test_shortage_action_seed_disabled(self):
        self.assertEqual(reg.get_trigger("shortage_action")["seed_enabled"], 0)


if __name__ == "__main__":
    unittest.main()
