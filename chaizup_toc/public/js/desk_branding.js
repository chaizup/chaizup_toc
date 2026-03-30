/**
 * Chaizup TOC — Desk Enhancements
 * ─────────────────────────────────
 * Non-invasive: does NOT modify navbar, logos, or accent lines.
 * Only adds:
 *   1. Zone colour styling in list views
 *   2. Real-time buffer alerts (browser notifications)
 *   3. Quick-access keyboard shortcut (Ctrl+Shift+T → TOC workspace)
 *
 * Loaded via hooks.py → app_include_js
 */

(function () {
	"use strict";

	/* ═══════════════════════════════════════
	   1. ZONE COLOUR in List Views
	═══════════════════════════════════════ */
	function styleZoneCells() {
		var cells = document.querySelectorAll(
			'.list-row-col[data-field="zone"]:not(.toc-styled), ' +
			'.list-row-col[data-field="custom_toc_zone"]:not(.toc-styled)'
		);
		cells.forEach(function (cell) {
			var val = (cell.textContent || "").trim();
			var colors = {
				Red:    { bg: "#FADBD8", fg: "#E74C3C" },
				Yellow: { bg: "#FEF9E7", fg: "#F39C12" },
				Green:  { bg: "#D5F5E3", fg: "#27AE60" },
				Black:  { bg: "#D5D8DC", fg: "#2C3E50" },
			};
			var c = colors[val];
			if (c) {
				cell.style.background = c.bg;
				cell.style.color = c.fg;
				cell.style.borderRadius = "12px";
				cell.style.padding = "2px 10px";
				cell.style.fontWeight = "700";
				cell.style.fontSize = "12px";
				cell.style.textAlign = "center";
				cell.style.display = "inline-block";
				cell.classList.add("toc-styled");
			}
		});
	}

	/* ═══════════════════════════════════════
	   2. REAL-TIME Buffer Alerts
	═══════════════════════════════════════ */
	function setupRealtimeAlerts() {
		if (typeof frappe === "undefined" || !frappe.realtime) return;
		frappe.realtime.on("toc_buffer_alert", function (data) {
			var color = data.zone === "Red" ? "red" : "orange";
			frappe.show_alert({
				message: "<b>" + data.item_code + "</b> entered <b>" + data.zone +
					" Zone</b> (BP: " + data.bp_pct + "%)",
				indicator: color,
			}, 10);
		});
	}

	/* ═══════════════════════════════════════
	   3. KEYBOARD SHORTCUT  Ctrl+Shift+T
	═══════════════════════════════════════ */
	function setupKeyboardShortcut() {
		document.addEventListener("keydown", function (e) {
			if (e.ctrlKey && e.shiftKey && e.key === "T") {
				e.preventDefault();
				if (typeof frappe !== "undefined") {
					frappe.set_route("Workspaces", "TOC Buffer Management");
				}
			}
		});
	}

	/* ═══════════════════════════════════════
	   INIT
	═══════════════════════════════════════ */
	function init() {
		styleZoneCells();
		setupRealtimeAlerts();
		setupKeyboardShortcut();
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}

	$(document).on("page-change", function () {
		setTimeout(styleZoneCells, 500);
	});

	var observer = new MutationObserver(styleZoneCells);
	observer.observe(document.body, { childList: true, subtree: true });
})();
