# Projection Engine — Developer Documentation

## File

`chaizup_toc/chaizup_toc/toc_engine/projection_engine.py`

## Purpose

Handles **email notifications** for the Sales Projection DocType lifecycle only.
The Production Plan creation logic has moved to `production_plan_engine.py`.

---

## Functions

### `on_sales_projection_update(doc, method)`

Doc event: fires after every save on Sales Projection.
Sends an "edited" email notification to users with `notify_on_edit` flag in TOC Settings.

**Guard**: `doc.docstatus == 0` — only sends for Draft saves. Frappe fires `on_update` again
after `on_submit`, so without this guard the "edited" email would also send on submit.

### `on_sales_projection_submit(doc, method)`

Doc event: fires once when Sales Projection is submitted.
Sends a "submitted" email to users with `notify_on_submit` flag.

---

## Doc Events (hooks.py)

```python
"Sales Projection": {
    "on_update": "...projection_engine.on_sales_projection_update",
    "on_submit": "...projection_engine.on_sales_projection_submit",
}
```

---

## Email Templates

| Template | Recipients flag | Subject |
|----------|----------------|---------|
| `_send_sp_edit_email` | `notify_on_edit` | "Sales Projection Updated: {month} {year}" |
| `_send_sp_submit_email` | `notify_on_submit` | "Sales Projection Submitted: {month} {year} / {warehouse} — PP Automation Will Run" |

---

## RESTRICT

- Do NOT remove the `docstatus == 0` guard in `on_sales_projection_update`. Without it,
  submitting a projection sends both an "edited" and a "submitted" email.
- Do NOT merge `on_sales_projection_update` and `on_sales_projection_submit` — they use
  different recipient flag fields (`notify_on_edit` vs `notify_on_submit`).
- Do NOT add automation/PP logic back here — it belongs in `production_plan_engine.py`.
