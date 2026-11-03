/* The public website: interface language (same translations as the app), signed-in state, reveal on scroll. */
(() => {
  const LANGS = [["en", "English"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["pt", "Português"], ["nl", "Nederlands"], ["pl", "Polski"], ["sv", "Svenska"], ["da", "Dansk"], ["no", "Norsk"], ["fi", "Suomi"], ["is", "Íslenska"], ["cs", "Čeština"], ["sk", "Slovenčina"], ["hu", "Magyar"], ["ro", "Română"], ["bg", "Български"], ["el", "Ελληνικά"], ["hr", "Hrvatski"], ["sl", "Slovenščina"], ["sr", "Srpski"], ["et", "Eesti"], ["lv", "Latviešu"], ["lt", "Lietuvių"], ["ga", "Gaeilge"], ["mt", "Malti"], ["ca", "Català"], ["cy", "Cymraeg"], ["uk", "Українська"], ["tr", "Türkçe"]];
  const els = [...document.querySelectorAll("[data-i18n]")];
  els.forEach(el => { el.dataset.src = el.textContent.trim().replace(/\s+/g, " "); });
  const sel = document.getElementById("lang");
  LANGS.forEach(([c, n]) => { const o = document.createElement("option"); o.value = c; o.textContent = n; sel.append(o); });

  function saved() {
    try { const v = localStorage.getItem("uaim_lang"); if (v && LANGS.some(l => l[0] === v)) return v; } catch (e) { }
    const nav = (navigator.languages || [navigator.language || "en"]).map(x => String(x).slice(0, 2).toLowerCase()).map(x => (x === "nb" || x === "nn" ? "no" : x));
    return nav.find(x => LANGS.some(l => l[0] === x)) || "en";
  }
  async function apply(code, save) {
    if (save) { try { localStorage.setItem("uaim_lang", code); } catch (e) { } }
    sel.value = code;
    document.documentElement.lang = code;
    let tr = {};
    if (code !== "en") {
      document.body.style.cursor = "progress";
      try { const r = await fetch(`/api/ui-strings/${code}`, { headers: { "X-Requested-With": "ProcessCheck" } }); if (r.ok) tr = (await r.json()).strings || {}; } catch (e) { }
      document.body.style.cursor = "";
    }
    els.forEach(el => { el.textContent = (code !== "en" && tr[el.dataset.src]) || el.dataset.src; });
  }
  sel.addEventListener("change", () => apply(sel.value, true));
  apply(saved(), false);

  // Already signed in? Point the buttons at the reviews.
  fetch("/api/me", { headers: { "X-Requested-With": "ProcessCheck" } }).then(r => r.json()).then(d => {
    if (!d || !d.user) return;
    document.querySelectorAll("[data-when=out]").forEach(e => { e.style.display = "none"; });
    document.querySelectorAll("a[data-cta]").forEach(a => { a.href = "/app"; });
  }).catch(() => { });

  // Sections fade in as they come into view (not for people who prefer reduced motion).
  const items = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window) || matchMedia("(prefers-reduced-motion: reduce)").matches) { items.forEach(i => i.classList.add("in")); return; }
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
  items.forEach(i => io.observe(i));
})();
