### Chaizup TOC

Theory of Constraints Buffer Management for ERPNext — replaces the default Auto Material Request
with a BP%-driven (Buffer Penetration %) replenishment engine.

**Core Formulas:**
- `F1: Target Buffer = ADU × RLT × VF`
- `F2: IP (FG) = On-Hand + WIP − Backorders`
- `F2: IP (RM/PM) = On-Hand + On-Order − Committed`
- `F3: BP% = (Target − IP) ÷ Target × 100`
- `F4: Order Qty = Target − IP`
- `F5: T/CU = (Price − RM − PM) ÷ Constraint Minutes`

**Buffer Zones:**
| Zone | BP% | Action |
|------|-----|--------|
| 🔴 Red | > 67% | Expedite — order immediately |
| 🟡 Yellow | 33–67% | Order today |
| 🟢 Green | < 33% | Stock healthy — no action |

### Prerequisites

- ERPNext v14+ (v15/v16 recommended)
- `frappe` and `erpnext` must be installed on the bench

### Installation

```bash
cd $PATH_TO_YOUR_BENCH
bench get-app $URL_OF_THIS_REPO --branch main
bench --site your-site install-app chaizup_toc
```

On install, the app automatically **disables ERPNext's default Auto Reorder** scheduler to prevent
conflicts. Uninstalling re-enables it.

### Key Features

- **Daily Production Priority Run** (07:00 AM) — calculates FG buffer states, auto-generates Work Order MRs
- **Daily Procurement Run** (07:30 AM) — calculates RM/PM buffer states, auto-generates Purchase MRs
- **Buffer Snapshot Log** (08:00 AM) — archives daily buffer states for DBM trend analysis
- **Weekly DBM Check** (Sunday 08:00 AM) — evaluates TMR/TMG triggers and auto-adjusts buffer sizes
- **Real-time updates** — buffers recalculate on every Stock Ledger Entry, Sales Order, Work Order, and Purchase Order event
- **TOC Settings** single DocType — configure ADU lookback period, VF multiplier, zone thresholds per company

### Configuration

Go to **TOC Buffer Management → TOC Settings** and configure:
- ADU calculation period (default: 30 days)
- Variability Factor per item/category
- Red/Yellow zone thresholds
- Target warehouses

### Contributing

This app uses `pre-commit` for code formatting and linting. Install and enable it:

```bash
cd apps/chaizup_toc
pre-commit install
```

Pre-commit is configured to use:
- ruff (Python linting + formatting)
- eslint (JavaScript)
- prettier (JS/CSS)

### License

mit
