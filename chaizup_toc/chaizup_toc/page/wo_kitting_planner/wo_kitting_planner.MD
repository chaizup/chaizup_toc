# WO Kitting Planner

## Purpose & Architecture
The WO Kitting Planner is a production planning tool for Frappe/ERPNext, designed for food/FMCG manufacturing. It allows production managers to simulate material availability across all open Work Orders, identify shortages, and make data-driven decisions.

### Key Features
- **Simulation Engine**: Supports "Current Stock Only" and "Current & Expected" (including POs/MRs/WOs) modes.
- **Calculation Modes**: "Isolated" (each WO checked against full stock) and "Sequential" (WOs consume stock in priority order).
- **AI Advisor**: Powered by DeepSeek (V3/R1), providing automated insights and a persistent chat interface for production support.
- **Dispatch Bottleneck Analysis**: Compares FG stock and production plan against Sales Order demand.
- **Item View**: FG-wise summary of all items with active WOs or pending SOs.
- **Cost Audit**: 360-degree audit comparing BOM standard cost vs. actual consumed cost.

## Development Guidelines

### 🔒 RESTRICTED AREAS (Do Not Change)
Changing these will break core features or destroy the "Tiger Theme" design system:
1.  **JS State Variables**: `this._aiSessionId`, `this._aiContext`, `this._aiInsightLoaded`, `this.rows`, `this.woOrder`.
2.  **DOM IDs**: 
    - AI: `#wkp-ai-insight-body`, `#wkp-ai-messages`, `#wkp-ai-input`, `#wkp-ai-send`, `#wkp-ai-status`.
    - Summary: `#wsum-ready`, `#wsum-partial`, `#wsum-blocked`, `#wsum-total`, `#wsum-shortage-val`.
    - Layout: `#wkp-tbody`, `#wkp-shortage-body`, `#wkp-emerg-body`, `#wkp-dispatch-body`, `#wkp-iv-body`.
3.  **CSS Variable Names**: The `:root` tokens (e.g., `--slate-50`, `--brand-500`, `--ok`, `--err`) are referenced by both CSS and JS. Change values, but NEVER rename them.
4.  **HTML Constraint**: Strictly NO SINGLE QUOTES in HTML attributes (use `&quot;` if needed).
5.  **API Schema**: 
    - `get_dispatch_bottleneck` return keys (`fg_stock`, `total_pending`, `total_reserved`, `has_pick_list`, `so_list`).
    - `get_item_wo_summary` returns historical cost data for the Item View.
    - `get_material_supply_detail` provides PO and MR context for shortages.

### ⚠️ IMPORTANT: ERPNext Field Mapping
When writing SQL queries for this application, be extremely careful with field names as they often differ from common assumptions:
- **Work Order**: Use `production_item` (NOT `item_code`) for the finished good being produced.
- **Purchase Order Item**: Use `rate` (NOT `valuation_rate`) for the purchase price.
- **Material Request Item**: Use `item_code`.
- **Stock Entry**: Use `work_order` for the link to the originating WO.

### 🔍 Dynamic Filtering (Anti-Hardcoding)
- **Item Groups**: In the Material Shortage tab, item groups must be fetched from the actual components in the simulation (`shortage_items[].item_group`), not inherited from the parent Work Order.
- **WO Statuses**: The "Show WOs" filter is populated via `get_work_order_statuses` API. NEVER hardcode ERPNext document statuses in HTML or JS, as these can vary between sites.

### UI & UX Standards (Production Grade)
- **Typography**: 
    - `Geist Mono` for quantities, IDs, and costs.
    - `Oswald` for dashboard values and headings.
- **Color System**:
    - **Emerald (ok)**: Ready to Produce / In Stock.
    - **Amber (warn)**: Partial Shortage / Risk.
    - **Rose (err)**: Blocked / Overdue / Gap.
    - **Sky (buy)**: Procurement / Expected Stock.
- **UOM Display**: Always use the "Stacked" dual UOM format in tables:
    ```html
    <div class="wkp-qty-primary">1,000</div>
    <div class="wkp-qty-uom">Gram</div>
    <div class="wkp-qty-secondary">1.00 Kg</div>
    ```

### AI Advisor Prompt Rules
- **Auto-Insight**:
    - No preamble (never start with "Based on...").
    - Top 3 issues only (Item / WO / Impact / Fix).
    - Exactly 3 action steps, one verb phrase each.
    - One sentence status summary.
- **System Prompt (Chat)**:
    - Summary: 1-2 sentences max.
    - Tables: max 4 columns, max 6 rows.
    - Action steps: exactly 3, one short sentence each.
    - **Always include item_code** in parentheses when mentioning items.

## Database Connections
- **Primary**: `Work Order`, `BOM`, `Item`, `Bin`
- **Demand**: `Sales Order`, `Sales Order Item`
- **Supply**: `Purchase Order`, `Material Request`
- **Consumption**: `Stock Entry`, `Stock Entry Detail`

---

## 🔄 DEVELOPER STATE SYNC (Session 10)
**Sync Block for Context-Aware AI Development**

### Latest Logic & Architecture
- **Dynamic Filtering**: Main "Show WOs" filter is now populated via `get_work_order_statuses` API to avoid hardcoding ERPNext statuses.
- **Shortage Aggregation**: Components in the "Material Shortage Report" correctly use their own `item_group` (fetched via updated `_get_bom_items_bulk`) for accurate tab-level filtering.
- **UI Design**: Modernized "Tiger Theme" using Slate/Emerald/Rose palette. Summary cards are clickable for instant filtering.
- **Multi-level BOM**: Simulation supports recursive expansion (up to 6 levels) while preserving item metadata (`item_group`, `valuation_rate`).
- **Cost Audit**: 360-degree audit tool compares BOM standard vs actual consumed cost with variance tracking.

### Critical Implementation Details
- **Field Mapping**: WO production item is `production_item`. PO price is `rate`. SE link is `work_order`.
- **UOM Standard**: Always show "Stacked" dual UOMs in tables.
- **HTML Security**: No single quotes in `.html` template (strictly enforced).
- **AI Context**: Strip `rows` and `dispatch` keys before sending to LLM (token limit management).

### Restricted Areas (Do Not Modify)
- **JS State**: `_aiSessionId`, `_aiContext`, `rows`, `woOrder`.
- **DOM IDs**: `#wkp-ai-*`, `#wsum-*`, `#wkp-pane-*`.
- **API Return Schema**: Keyed by `item_code` for dispatch and item summary.
