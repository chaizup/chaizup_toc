# TOC Projection Notification User — Developer Documentation

## Purpose

Child table of TOC Settings → Sales Projection Automation section.
Each row is one Frappe user who receives email notifications when:
- A Sales Projection is edited (saved in draft state)
- A Sales Projection is submitted
- The WO automation engine runs (daily or manual trigger) — receives full WO creation summary

## Fields

| Fieldname | Type | Description |
|-----------|------|-------------|
| `user` | Link → User | Frappe user. Required. |
| `user_name` | Data (fetch_from) | Auto-fetched: user's full name. Read-only. |
| `notify_on_edit` | Check | Email on every draft save. Default: ON. |
| `notify_on_submit` | Check | Email on submission. Default: ON. |
| `notify_on_wo_create` | Check | Email after every automation run. Default: ON. |

## DANGER ZONE

- Do NOT rename `notify_on_edit`, `notify_on_submit`, `notify_on_wo_create`.
  `projection_engine._get_emails()` uses `getattr(row, flag_field, 0)` — renaming breaks email delivery silently.

## File Map

```
toc_projection_notification_user/
├── toc_projection_notification_user.json  — DocType schema
├── toc_projection_notification_user.py   — Empty controller
└── toc_projection_notification_user.md  — This file
```
