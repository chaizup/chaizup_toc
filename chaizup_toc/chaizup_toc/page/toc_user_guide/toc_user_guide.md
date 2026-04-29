# TOC User Guide — Developer Documentation

## Purpose
The `toc-user-guide` is a comprehensive, whitelisted page providing end-users and administrators with a centralized reference for the Chaizup TOC application. It covers formulas, schedules, configurations, and troubleshooting steps.

## Technical Implementation
- **Template**: `toc_user_guide.html` contains the markup and embedded CSS (standardized to Frappe Desk variables).
- **Controller**: `toc_user_guide.js` handles navigation logic, smooth scrolling, and mobile sidebar toggling.
- **Route**: Whitelisted at `/app/toc-user-guide`.

## UI Structure
### 1. Responsive Sidebar
- Collapsible navigation on mobile (<= 992px) with a dedicated toggle button.
- Smooth scrolling and active-section tracking via `IntersectionObserver`.

### 2. Decision Support (Where to Start?)
- Use-case cards to guide different user roles (Setup, Procurement, Production).
- Formula decision tree explaining when each TOC rule (F1-F8) applies.

### 3. Interactive Calculators
- Inline JS calculators for Target Buffer (F1), Inventory Position (F2), and Buffer Penetration (F3) to help users validate their configurations.

## Maintenance Guidelines
- **HTML Safety**: All event handlers in `toc_user_guide.html` must use `&quot;` for string arguments to avoid breaking Frappe's single-quoted template cache.
- **Section IDs**: IDs `s00` through `s13` are hardcoded in the navigation logic; do not rename them without updating the `toc_user_guide.js` `tugScrollTo` mapping.

## Sync Block — 2026-04-27
- **UI Refactor**: Transitioned to native Frappe CSS variables and layout patterns.
- **Responsiveness**: Fixed mobile sidebar and viewport scaling.
- **Navigation Fix**: Resolved issues with section jumping and active state synchronization.
- **Ecosystem Integration**: Documented the connection between the User Guide and the modernized `toc-item-settings` page (Bulk Configuration Dashboard).
