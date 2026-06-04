import unittest

from chaizup_toc.chaizup_toc.toc_engine.trigger_scheduler import (
    compute_cron, CronValidationError,
)


class _Row:
    def __init__(self, **kw):
        self.frequency = kw.get("frequency", "Daily")
        self.schedule_time = kw.get("schedule_time", "02:00")
        self.weekday = kw.get("weekday", "")
        self.cron_override = kw.get("cron_override", "")


class TestComputeCron(unittest.TestCase):
    def test_daily(self):
        self.assertEqual(compute_cron(_Row(schedule_time="02:00")), "0 2 * * *")

    def test_daily_with_minutes(self):
        self.assertEqual(compute_cron(_Row(schedule_time="07:30")), "30 7 * * *")

    def test_weekly_sunday(self):
        r = _Row(frequency="Weekly", schedule_time="09:00", weekday="Sunday")
        self.assertEqual(compute_cron(r), "0 9 * * 0")

    def test_weekly_wednesday(self):
        r = _Row(frequency="Weekly", schedule_time="06:15", weekday="Wednesday")
        self.assertEqual(compute_cron(r), "15 6 * * 3")

    def test_cron_override_wins(self):
        r = _Row(schedule_time="02:00", cron_override="*/15 * * * *")
        self.assertEqual(compute_cron(r), "*/15 * * * *")

    def test_bad_time_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(schedule_time="25:00"))

    def test_bad_time_format_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(schedule_time="7am"))

    def test_bad_override_raises(self):
        with self.assertRaises(CronValidationError):
            compute_cron(_Row(cron_override="not a cron"))


if __name__ == "__main__":
    unittest.main()
