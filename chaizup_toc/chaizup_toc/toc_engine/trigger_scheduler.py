"""
TOC Trigger Scheduler — sync child rows into native Scheduled Job Type.
========================================================================
# =============================================================================
# CONTEXT: Turns each TOC Trigger Configuration row into a cron string and
#   writes it onto Frappe's built-in `Scheduled Job Type` (matched by `method`),
#   so editing a trigger's time on TOC Settings changes when the job fires —
#   no bench restart / migrate needed.
# MEMORY: app_chaizup_toc.md § Configurable Automation Triggers (2026-06-04)
# INSTRUCTIONS:
#   - compute_cron is PURE + dependency-light (no frappe import) so it is unit
#     testable and raises CronValidationError on bad input.
#   - sync_one / sync_all import frappe lazily and convert CronValidationError
#     into frappe.throw so a bad time aborts the TOC Settings save cleanly.
# DANGER ZONE:
#   - Frappe's migrate runs `sync_jobs` which can RESET cron_format from hooks.
#     The after_migrate hook re-runs sync_all so the table stays authoritative.
# =============================================================================
"""

import re

_WEEKDAY_TO_CRON = {
    "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3,
    "Thursday": 4, "Friday": 5, "Saturday": 6,
}

_CRON_FIELD = re.compile(r"^[\d\*/,\-]+$")


class CronValidationError(ValueError):
    """Raised when a row cannot be turned into a valid 5-field cron."""


def _validate_cron(expr):
    parts = expr.split()
    if len(parts) != 5:
        raise CronValidationError(f"Cron must have 5 fields: {expr!r}")
    for p in parts:
        if not _CRON_FIELD.match(p):
            raise CronValidationError(f"Invalid cron field {p!r} in {expr!r}")
    return expr


def _parse_hhmm(value):
    if not value or not re.match(r"^\d{1,2}:\d{2}$", value.strip()):
        raise CronValidationError(f"Time must be HH:MM (24h), got {value!r}")
    hh, mm = value.strip().split(":")
    hh, mm = int(hh), int(mm)
    if not (0 <= hh <= 23 and 0 <= mm <= 59):
        raise CronValidationError(f"Time out of range: {value!r}")
    return hh, mm


def compute_cron(row):
    """Return a 5-field cron string for a TOC Trigger Configuration row.

    cron_override (when set) wins. Otherwise Daily -> 'M H * * *',
    Weekly -> 'M H * * <weekday>'. Raises CronValidationError on bad input.
    """
    override = (getattr(row, "cron_override", "") or "").strip()
    if override:
        return _validate_cron(override)

    hh, mm = _parse_hhmm(getattr(row, "schedule_time", "") or "")
    frequency = (getattr(row, "frequency", "Daily") or "Daily").strip()

    if frequency == "Weekly":
        wd = (getattr(row, "weekday", "") or "").strip()
        if wd not in _WEEKDAY_TO_CRON:
            raise CronValidationError(f"Weekly trigger needs a weekday, got {wd!r}")
        return f"{mm} {hh} * * {_WEEKDAY_TO_CRON[wd]}"

    return f"{mm} {hh} * * *"
