# dbm_analysis_report — DBM Analysis Report

The weekly health check for Dynamic Buffer Management. Answers: **"Which buffers are being correctly auto-sized by DBM — and which ones need manual intervention?"**

Type: **Script Report** (Frappe Query Report with Python `execute()`)

```
dbm_analysis_report/
├── dbm_analysis_report.json   ← Report metadata
├── dbm_analysis_report.py     ← execute() → columns, data only (no chart/summary)
└── dbm_analysis_report.js     ← Client-side status cell formatter
```

Primary audience: **Operations Manager, TOC Manager** — reviewed every Monday after Sunday's DBM auto-adjustment run.

---

## What It Answers

| Question | Column to Check |
|----------|----------------|
| "Which items had their buffers increased this week?" | `last_dbm_date` = last Sunday + `target_buffer` > prev target |
| "Which items are stuck in Red despite buffer increases?" | DBM Status = "⚠️ TMR Safeguard Hit" |
| "Which items could have their buffers reduced?" | DBM Status = "🟢 Trending Green — TMG possible" |
| "How many buffer increases has this item had consecutively?" | `tmr_count` column |
| "Is this item spending more time Red or Green?" | `% Days in Red` / `% Days in Green` columns |
| "When did DBM last evaluate this buffer?" | `last_dbm_date` column |

---

## Data Sources (Three Tables Combined)

```
1. Item table
   frappe.get_all("Item", filters={"custom_toc_enabled": 1})
   → gives list of all TOC-managed items

2. TOC Item Buffer (child table on Item)
   frappe.get_all("TOC Item Buffer",
       filters={"parent": item.name, "enabled": 1},
       fields=["warehouse","adu","rlt","variability_factor","target_buffer",
               "tmr_count","tmg_green_days","last_dbm_date"])
   → gives buffer rule parameters and DBM tracking fields

3. TOC Buffer Log (last 30 days per item+warehouse)
   frappe.get_all("TOC Buffer Log",
       filters={"item_code": ..., "warehouse": ...,
                "log_date": [">=", add_days(today(), -30)]},
       fields=["zone"])
   → gives zone distribution for trend calculation
```

**N+1 query concern**: The report runs one `TOC Item Buffer` query per item and one `TOC Buffer Log` query per item+warehouse pair. With 50 TOC items × 2 warehouses each, this is ~150 DB queries. Acceptable for a management report (not a live dashboard). For very large catalogs (500+ items), performance may degrade — consider adding a single-query aggregate approach.

---

## Columns

| Column | Fieldname | Source | Description |
|--------|-----------|--------|-------------|
| Item | `item_code` | Item | TOC-enabled item code |
| Item Name | `item_name` | Item | Item display name |
| Warehouse | `warehouse` | TOC Item Buffer | Buffer warehouse for this rule |
| Current Target (F1) | `target_buffer` | TOC Item Buffer | Current buffer size (may have been DBM-adjusted) |
| ADU | `adu` | TOC Item Buffer | Average Daily Usage (units/day) |
| RLT | `rlt` | TOC Item Buffer | Replenishment Lead Time (days) |
| VF | `variability_factor` | TOC Item Buffer | Variability Factor |
| Original Target | `original_target` | Calculated | ADU × RLT × VF (what F1 would give without DBM) |
| DBM Delta | `dbm_delta` | Calculated | target_buffer − original_target (+ means TMR increased it) |
| TMR Count (F7) | `tmr_count` | TOC Item Buffer | Consecutive Too-Much-Red increases |
| Last DBM Check | `last_dbm_date` | TOC Item Buffer | Date of most recent TMR/TMG evaluation |
| % Days in Red | `red_pct` | TOC Buffer Log (30d) | Proportion of last 30 log entries in Red/Black |
| % Days in Green | `green_pct` | TOC Buffer Log (30d) | Proportion of last 30 log entries in Green |
| DBM Status | `dbm_status` | Calculated | Categorical health indicator |

---

## DBM Status Logic — Exact Conditions

Evaluated in this priority order (first match wins):

```python
def _get_dbm_status(tmr_count, red_pct, green_pct, settings):
    max_tmr = cint(settings.max_tmr_consecutive) or 3

    if (tmr_count or 0) >= max_tmr:
        return "⚠️ TMR Safeguard Hit"       # Blocked — manual review needed

    if red_pct > 30:
        return "🔴 Trending Red — TMR likely"   # >30% of last 30 days in Red

    if green_pct > 80:
        return "🟢 Trending Green — TMG possible"  # >80% in Green — oversize candidate

    return "✅ Normal"
```

| Status | Condition | What To Do |
|--------|-----------|-----------|
| `⚠️ TMR Safeguard Hit` | `tmr_count >= max_tmr_consecutive` (default 3) | Manual review: Is demand permanently higher? Raise ADU or RLT instead of relying on TMR |
| `🔴 Trending Red — TMR likely` | >30% of last 30 logs were Red/Black | No action needed — TMR will fire next Sunday automatically if pattern continues |
| `🟢 Trending Green — TMG possible` | >80% of last 30 logs were Green | No action needed — TMG will fire next Sunday if N×RLT cycles of Green confirmed |
| `✅ Normal` | None of the above | Buffer is well-sized, DBM operating normally |

---

## How TMR Count Works

`tmr_count` on `TOC Item Buffer` tracks **consecutive** buffer increases without a TMG reset:

```
Week 1: Red% > threshold → TMR fires → target_buffer +33% → tmr_count = 1
Week 2: Still Red → TMR fires again → target_buffer +33% → tmr_count = 2
Week 3: Still Red → TMR fires again → target_buffer +33% → tmr_count = 3
Week 4: tmr_count = 3 = max_tmr_consecutive → BLOCKED → status = "⚠️ TMR Safeguard Hit"
         DBM refuses to increase further — requires human review
```

Once an item eventually goes Green and TMG fires:
```
TMG fires → target_buffer −33% → tmr_count = 0 (reset)
```

This prevents runaway buffer increases where demand is permanently elevated.

---

## % Days in Red / Green Calculation

```python
logs = frappe.get_all("TOC Buffer Log",
    filters={
        "item_code": item_code,
        "warehouse": warehouse,
        "log_date": [">=", add_days(today(), -30)]
    },
    fields=["zone"])

total = len(logs) or 1  # avoid ZeroDivisionError
red_days = len([l for l in logs if l.zone in ("Red", "Black")])
green_days = len([l for l in logs if l.zone == "Green"])

red_pct = round(red_days / total * 100, 1)
green_pct = round(green_days / total * 100, 1)
```

**Known issue**: Window is always 30 calendar days regardless of RLT. An item with RLT=20 days should technically be evaluated over 60 days (3 RLT cycles for TMG to confirm). The 30-day fixed window means:
- Short-RLT items (RLT=3): 30 days = 10 RLT cycles — overly generous window
- Long-RLT items (RLT=21): 30 days < 2 RLT cycles — may not show full pattern

**No data (new items)**: If no logs exist in last 30 days, `total=1` and both percentages = 0%. Status shows "Normal". A "No Data" status would be more accurate.

---

## execute() Return Signature

```python
def execute(filters=None):
    columns = get_columns()
    data = get_data(filters)
    return columns, data    # NO chart, NO summary, NO message
```

This is the only report in the app that returns just 2 values (not 5). All other reports return `(columns, data, None, chart, summary)`. This is intentional — the DBM report is a dense data grid where chart/summary would add noise, not clarity.

---

## Worked Example — Reading the Report

```
Item              Warehouse     Target  ADU  RLT   VF    Original  Delta  TMR  Last Check   Red%  Green%  Status
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
FG-MASALA-1KG    FG Store       192    10    7   1.5     105       +87    3   2026-03-30    52%    18%   ⚠️ TMR Safeguard Hit
FG-GINGER-500G   FG Store       105    5     7   1.5     105         0    0   2026-03-30    12%    71%   ✅ Normal
FG-CARDAMOM-200G FG Store        70    3     7   1.5      63       +7     1   2026-03-30    35%    45%   🔴 Trending Red — TMR likely
MASALA-BASE-SFG  WIP Store      180   15    6   1.5     135       +45    2   2026-03-30    8%     84%   🟢 Trending Green — TMG possible
```

**Reading Row 1 (FG-MASALA-1KG)**:
- F1 formula would give Target=105, but DBM has increased it to 192 (+87 units, or +83%)
- Three consecutive TMR increases → safeguard hit → blocked from further auto-increase
- 52% of last 30 days in Red → demand is genuinely elevated
- **Action**: Investigate root cause. If ADU has permanently increased, update ADU=15 → recalculate target naturally (F1 = 15×7×1.5 = 158), then reset tmr_count manually via bench console.

**Reading Row 4 (MASALA-BASE-SFG)**:
- Buffer increased once by TMR (delta +45), 84% of days in Green
- TMG will fire next Sunday to reduce the buffer back
- **Action**: None — system will self-correct.

---

## Usage Workflow — Every Monday

```
1. Open DBM Analysis Report (no filters needed)
2. Sort by DBM Status (group all "TMR Safeguard Hit" at top)
3. For each "⚠️ TMR Safeguard Hit":
   a. Check Buffer Status Report for this item (last 90 days)
   b. Is demand permanently higher? → Update ADU on TOC Item Buffer rule
   c. Is it a seasonal spike? → Apply DAF instead
   d. Resolved? → Reset tmr_count to 0 via bench console:
      frappe.db.set_value("TOC Item Buffer", rule_name, "tmr_count", 0)
      frappe.db.commit()
4. Note all "🔴 Trending Red" items — TMR will fire this Sunday if unresolved
5. Note all "🟢 Trending Green" items — TMG will fire this Sunday, buffer will shrink
```

---

## Integration with DBM Engine

The Sunday DBM run (`evaluate_all_dbm()`) reads the same `TOC Item Buffer` fields shown in this report and writes back to them:

```
Sunday DBM run reads:    tmr_count, last_dbm_date, target_buffer
Sunday DBM run writes:   tmr_count, target_buffer, last_dbm_date, tmg_green_days

DBM Analysis Report reads:  All of the above + TOC Buffer Log (last 30 days)
DBM Analysis Report writes: Nothing (read-only)
```

Run this report immediately after the Sunday DBM run (`04:00 AM`) to see what changed. If `last_dbm_date` column shows today's date on many rows, DBM ran successfully.
