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
- **HTML Safety**: All event handlers in `toc_user_guide.html` must use `&quot;` for string arguments to avoid breaking the Frappe single-quoted template cache.
- **No raw apostrophes anywhere in the file body** (POR-023 / 2026-05-13). `frappe.build.scrub_html_template` strips only HTML `<!-- -->` comments — apostrophes in `<style>` CSS or markup terminate the wrap string and blank the page. Use `&apos;`, or rephrase contractions ("does not" / "did not") and possessives ("the X used by Y" instead of "Y&apos;s X").
- **Section IDs**: IDs `s00` through `s13` are hardcoded in the navigation logic; do not rename them without updating the `toc_user_guide.js` `tugScrollTo` mapping.

## Sync Block — 2026-04-27
- **UI Refactor**: Transitioned to native Frappe CSS variables and layout patterns.
- **Responsiveness**: Fixed mobile sidebar and viewport scaling.
- **Navigation Fix**: Resolved issues with section jumping and active state synchronization.
- **Ecosystem Integration**: Documented the connection between the User Guide and the modernized `toc-item-settings` page (Bulk Configuration Dashboard).

## Sync Block — 2026-05-13 (POR-023 follow-on)
- **Page-blank fix**: Removed 10 raw apostrophes from the HTML body that were terminating the wrap string `frappe.templates["toc_user_guide"] = '...'` at byte 47339 of an 85565-byte body — every byte after the first stray apostrophe was being parsed as JS, throwing SyntaxError and rendering the page blank. Wrap now closes cleanly; body length 85565 matches the HTML.
- **Same root cause as Production Overview POR-023.** `frappe/build.py:424` reads `content.replace("'", "'")` (a no-op — the escape backslash was lost long ago), and `HTML_COMMENT_PATTERN` strips only `<!-- -->` comments. So every raw apostrophe in `<style>` CSS, `<style>` CSS comments, and markup ends up wrapped verbatim and breaks the JS string literal.
- **Edits made**: rephrased possessives ("Calc A&apos;s" → "the Calc A", "ERPNext&apos;s" → "the ERPNext", etc.), replaced one possessive with `&apos;` (`item&apos;s`), and replaced "didn&apos;t" with "did not".
- **New maintenance rule**: zero raw apostrophes anywhere in `toc_user_guide.html` outside HTML `<!-- -->` comments. Same lint as Production Overview; see that page&apos;s `production_overview.md` POR-023 section for the one-liner check.
