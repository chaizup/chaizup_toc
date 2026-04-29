// =============================================================================
// CONTEXT: TOC User Guide — Frappe Page JS controller.
//   Mounts the toc_user_guide HTML template (CSS + markup only — no inline script).
//   All JS logic for navigation, calculators, and search lives in THIS file because
//   inline <script> tags inside Frappe HTML templates break the page —
//   the browser terminates the outer <script> block at the first </script> it sees.
//
// MEMORY: app_chaizup_toc.md § TOC User Guide Page
// INSTRUCTIONS:
//   - The HTML template contains ONLY CSS + markup. No <script> tags.
//   - All tug* functions are defined here (after the template is appended).
//   - tugInit() runs immediately after appendTo() to wire calculators and nav.
//   - Page title is set on load; no filter bar needed.
//   - Menu items link back to key operational pages.
// DANGER:
//   - NEVER put <script> tags in toc_user_guide.html — breaks Frappe template wrapping.
//   - NEVER put single quotes in onclick/oninput attributes in the HTML template.
//   - After any .html change: redis-cli -h redis-cache -p 6379 FLUSHALL
// RESTRICT:
//   - Do NOT add frappe.call() — this page is static content only.
//   - Calculator input IDs (tug-f1-adu, tug-f1-rlt, etc.) must stay stable.
//   - Section IDs s00-s13 are used by tugScrollTo() nav links — do not rename.
// =============================================================================

frappe.pages["toc-user-guide"].on_page_load = function (wrapper) {
  if (wrapper.tug_initialized) return;
  wrapper.tug_initialized = true;

  const page = frappe.ui.make_app_page({
    parent: wrapper,
    title: "TOC User Guide",
    single_column: true,
  });

  page.add_menu_item(__("TOC Dashboard"), () => frappe.set_route("toc-dashboard"));
  page.add_menu_item(__("Item Settings"), () => frappe.set_route("toc-item-settings"));
  page.add_menu_item(__("TOC Settings"), () =>
    frappe.set_route("Form", "TOC Settings", "TOC Settings"));

  $(frappe.render_template("toc_user_guide", {})).appendTo(page.body);

  // Wire up all interactive behaviour after DOM is ready
  tugInit();
};

/* ══════════════════════════════════════════════════════════════════
   TUG — Navigation, Calculators, Search
   All functions prefixed tug* to avoid namespace collisions.
══════════════════════════════════════════════════════════════════ */

function tugInit() {
  tugCalcF1();
  tugCalcF3();
  tugCalcF2();
  tugWireNav();
  
  // Close sidebar when clicking outside on mobile
  document.addEventListener("click", function(e) {
    var sidebar = document.getElementById("tug-sidebar");
    var toggle = document.querySelector(".tug-mobile-toggle");
    if (window.innerWidth <= 992 && 
        sidebar.classList.contains("active") && 
        !sidebar.contains(e.target) && 
        !toggle.contains(e.target)) {
      tugToggleSidebar();
    }
  });
}

/* ── Mobile Sidebar Toggle ───────────────────────────────────────── */
function tugToggleSidebar() {
  var sidebar = document.getElementById("tug-sidebar");
  var toggle = document.querySelector(".tug-mobile-toggle");
  sidebar.classList.toggle("active");
  toggle.textContent = sidebar.classList.contains("active") ? "✕" : "☰";
}

/* ── Navigation ──────────────────────────────────────────────────── */
function tugScrollTo(id) {
  var el = document.getElementById(id);
  if (!el) return;
  
  // Smooth scroll with offset for mobile header if any
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  
  // Close sidebar on mobile after selection
  if (window.innerWidth <= 992) {
    var sidebar = document.getElementById("tug-sidebar");
    if (sidebar.classList.contains("active")) {
      tugToggleSidebar();
    }
  }

  document.querySelectorAll(".tug-nav-item").forEach(function(n) {
    n.classList.remove("active");
    if (n.getAttribute("onclick") && n.getAttribute("onclick").indexOf(id) !== -1) {
      n.classList.add("active");
    }
  });
}

function tugWireNav() {
  var sections = document.querySelectorAll(".tug-section[id]");
  if (!sections.length) return;
  var obs = new IntersectionObserver(function(entries) {
    entries.forEach(function(e) {
      if (e.isIntersecting) {
        var id = e.target.id;
        document.querySelectorAll(".tug-nav-item").forEach(function(n) {
          n.classList.remove("active");
          if (n.getAttribute("onclick") && n.getAttribute("onclick").indexOf(id) !== -1) {
            n.classList.add("active");
          }
        });
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  sections.forEach(function(s) { obs.observe(s); });
}

/* ── F1 Calculator ───────────────────────────────────────────────── */
function tugCalcF1() {
  var adu = parseFloat(document.getElementById("tug-f1-adu").value) || 0;
  var rlt = parseFloat(document.getElementById("tug-f1-rlt").value) || 0;
  var vf  = parseFloat(document.getElementById("tug-f1-vf").value)  || 0;
  var res = Math.round(adu * rlt * vf);
  document.getElementById("tug-f1-result").textContent = res.toLocaleString("en-IN");
}

/* ── F3 Calculator ───────────────────────────────────────────────── */
function tugCalcF3() {
  var target = parseFloat(document.getElementById("tug-f3-target").value) || 0;
  var ip     = parseFloat(document.getElementById("tug-f3-ip").value)     || 0;
  document.getElementById("tug-f3-target2").value = target;
  tugCalcF3render(target, ip);
}
function tugCalcF3b() {
  var target = parseFloat(document.getElementById("tug-f3-target2").value) || 0;
  var ip     = parseFloat(document.getElementById("tug-f3-ip").value)      || 0;
  document.getElementById("tug-f3-target").value = target;
  tugCalcF3render(target, ip);
}
function tugCalcF3render(target, ip) {
  var res = document.getElementById("tug-f3-result");
  if (!res) return;
  if (target === 0) { res.textContent = "—"; return; }
  var bp = (target - ip) / target * 100;
  res.textContent = bp.toFixed(1) + "%";
  if (bp > 100)     { res.style.color = "#475569"; }
  else if (bp > 67) { res.style.color = "#ef4444"; }
  else if (bp > 33) { res.style.color = "#f59e0b"; }
  else              { res.style.color = "#10b981"; }
}

/* ── F2 Calculator ───────────────────────────────────────────────── */
function tugCalcF2() {
  var oh = parseFloat(document.getElementById("tug-f2-oh").value) || 0;
  var oo = parseFloat(document.getElementById("tug-f2-oo").value) || 0;
  var cm = parseFloat(document.getElementById("tug-f2-cm").value) || 0;
  var ip = oh + oo - cm;
  var el = document.getElementById("tug-f2-result");
  if (!el) return;
  el.textContent = ip.toLocaleString("en-IN");
  el.style.color = ip < 0 ? "#ef4444" : "#0369a1";
}

/* ── Search ──────────────────────────────────────────────────────── */
function tugSearch(q) {
  var term = q.trim().toLowerCase();
  var sections = document.querySelectorAll(".tug-section");
  if (!term) {
    sections.forEach(function(s) { s.classList.remove("tug-hidden"); });
    return;
  }
  sections.forEach(function(s) {
    var text = s.textContent.toLowerCase();
    if (text.indexOf(term) !== -1) {
      s.classList.remove("tug-hidden");
    } else {
      s.classList.add("tug-hidden");
    }
  });
}
