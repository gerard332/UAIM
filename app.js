/* ================= UAIM process reviews (self-hosted website) ================= */
const S = {
  me: null, provider: "demo", allowSignup: true, view: "loading", authMode: "login",
  list: null, names: {}, R: null, tab: "summary", filter: "all",
  dirty: false, saving: false, timer: null, pendingLog: [], saveState: "",
  openNotes: new Set(), pendingRemote: false, busy: false, ctl: null, signing: false, rerunOpen: false,
  form: { text: "", priority: "Balanced review", size: "Not specified", runs: "", rate: "", cur: "GBP", lang: "en" },
  newImgs: null, newFileText: null, newFileName: null, status: "", statusErr: false, lastChanges: null, team: null, flash: "",
  billing: null, bill: null, needsPay: false, audiences: [], aud: "general", audOpen: false, lensBusy: null,
};
const app = document.getElementById("app");
const STATUS = { open: "Open", in_progress: "In progress", done: "Done", wont_do: "Not doing" };
// Report languages: [code, name shown in the menu, locale for dates]
const LANGS = [
  ["en", "English", "en-GB"], ["de", "Deutsch (German)", "de-DE"], ["fr", "Français (French)", "fr-FR"], ["es", "Español (Spanish)", "es-ES"],
  ["it", "Italiano (Italian)", "it-IT"], ["pt", "Português (Portuguese)", "pt-PT"], ["nl", "Nederlands (Dutch)", "nl-NL"], ["pl", "Polski (Polish)", "pl-PL"],
  ["sv", "Svenska (Swedish)", "sv-SE"], ["da", "Dansk (Danish)", "da-DK"], ["no", "Norsk (Norwegian)", "nb-NO"], ["fi", "Suomi (Finnish)", "fi-FI"],
  ["is", "Íslenska (Icelandic)", "is-IS"], ["cs", "Čeština (Czech)", "cs-CZ"], ["sk", "Slovenčina (Slovak)", "sk-SK"], ["hu", "Magyar (Hungarian)", "hu-HU"],
  ["ro", "Română (Romanian)", "ro-RO"], ["bg", "Български (Bulgarian)", "bg-BG"], ["el", "Ελληνικά (Greek)", "el-GR"], ["hr", "Hrvatski (Croatian)", "hr-HR"],
  ["sl", "Slovenščina (Slovenian)", "sl-SI"], ["sr", "Srpski (Serbian)", "sr-Latn-RS"], ["et", "Eesti (Estonian)", "et-EE"], ["lv", "Latviešu (Latvian)", "lv-LV"],
  ["lt", "Lietuvių (Lithuanian)", "lt-LT"], ["ga", "Gaeilge (Irish)", "ga-IE"], ["mt", "Malti (Maltese)", "mt-MT"], ["ca", "Català (Catalan)", "ca-ES"],
  ["cy", "Cymraeg (Welsh)", "cy-GB"], ["uk", "Українська (Ukrainian)", "uk-UA"], ["tr", "Türkçe (Turkish)", "tr-TR"],
];
const langOf = code => LANGS.find(l => l[0] === code) || LANGS[0];

/* ---------- Interface language ---------- */
let UI_LANG = "en", UI_TR = {};
function _t(key, args) {
  let s = (UI_LANG !== "en" && UI_TR[key]) || key;
  if (args) s = s.replace(/\{(\d+)\}/g, (_, i) => (args[+i] == null ? "" : String(args[+i])));
  return s;
}
function notify(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg; el.className = "show";
  clearTimeout(notify.t); notify.t = setTimeout(() => { el.className = ""; }, 6000);
}
function _pl(suffix) { return UI_LANG === "en" ? suffix : ""; } // English plural endings only
function uiLocale() { return langOf(UI_LANG)[2]; }
function savedUiLang() {
  return "en"; // English only for now: language pickers removed
}
async function setUiLang(code, save = true) {
  if (!LANGS.some(l => l[0] === code)) code = "en";
  if (save) { try { localStorage.setItem("uaim_lang", code); } catch (e) { } }
  document.documentElement.lang = code;
  if (!S.form.text) S.form.lang = code; // new reviews default to the interface language
  if (code === "en") { UI_LANG = "en"; UI_TR = {}; render(); return; }
  const slow = setTimeout(() => notify(_t("Translating the interface into {0}… This happens once per language.", [langOf(code)[1].split(" (")[0]])), 900);
  try {
    const d = await api("GET", `/api/ui-strings/${code}`);
    UI_TR = d.strings || {}; UI_LANG = code;
  } catch (e) { UI_LANG = "en"; UI_TR = {}; notify(_t("The interface couldn't be translated just now, so it's shown in English.")); }
  clearTimeout(slow);
  render();
}
// Report wording for the open review, in its language (the app's own buttons stay in English).
const rlang = () => (S.R && S.R.inputs && S.R.inputs.lang) || "en";
function RL(k, p) {
  const lb = (S.labels && S.labels[rlang()]) || {};
  return String(lb[k] || PDF_LABELS[k] || k).replace(/\{(\w+)\}/g, (_, x) => (p && p[x] != null ? p[x] : ""));
}
const apT = a => RL("ap" + a);
const typeT = t => ({ decision: RL("tDecision"), wait: RL("tWait"), handoff: RL("tHandoff"), automated: RL("tAutomated") })[t] || "";
const tfT = v => ({ "30 days": RL("tf30"), "90 days": RL("tf90"), "6 months+": RL("tf6") })[v] || v || "";
const lvT = v => ({ high: RL("lvHigh"), medium: RL("lvMedium"), low: RL("lvLow") })[v] || v || "";
const STAT = k => RL({ open: "sOpen", in_progress: "sProgress", done: "sDone", wont_do: "sWont" }[k || "open"]);
async function ensureLabels(lang) {
  S.labels = S.labels || {}; S.labelsLoading = S.labelsLoading || {};
  if (!lang || lang === "en" || S.labels[lang] || S.labelsLoading[lang]) return S.labels[lang] || {};
  S.labelsLoading[lang] = true;
  try { S.labels[lang] = (await api("POST", "/api/labels", { lang, labels: PDF_LABELS })).labels || {}; render(); }
  catch (e) { S.labels[lang] = null; }
  finally { S.labelsLoading[lang] = false; }
  return S.labels[lang] || {};
}

/* ---------- helpers ---------- */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const clamp = v => Math.max(1, Math.min(10, Math.round(Number(v) || 1)));
const rpn = f => f.severity * f.occurrence * f.detection;
function apFor(f) {
  const s = f.severity, o = f.occurrence, d = f.detection;
  if (s >= 9) return (o >= 4 || (o >= 2 && d >= 7)) ? "H" : (o >= 2 || d >= 5) ? "M" : "L";
  if (s >= 7) return (o >= 6 || (o >= 4 && d >= 5)) ? "H" : (o >= 4 || (o >= 2 && d >= 7)) ? "M" : "L";
  if (s >= 4) return (o >= 8 && d >= 5) ? "H" : (o >= 6 || (o >= 4 && d >= 7)) ? "M" : "L";
  if (s >= 2) return (o >= 8 && d >= 5) ? "M" : "L";
  return "L";
}
function allFms(A) { const out = []; (A?.steps || []).forEach((s, si) => (s.failureModes || []).forEach(f => out.push({ s, si, f }))); return out; }
const hasAction = f => f.action && f.action !== "None";
const canWrite = () => S.me && S.me.role !== "viewer";
const isAdmin = () => S.me && S.me.role === "admin";
const name = id => (id != null && S.names[String(id)]) || "Former member";
function when(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60e3) return _t("just now");
  if (d < 3600e3) return Math.round(d / 60e3) + _t(" min ago");
  if (d < 86400e3) return Math.round(d / 3600e3) + _t(" h ago");
  return new Date(ts).toLocaleDateString(uiLocale(), { day: "numeric", month: "short", year: "numeric" });
}
function money(n, cur) {
  n = Number(n);
  if (!isFinite(n) || n <= 0) return _t("Not sized");
  try { return new Intl.NumberFormat(langOf(rlang())[2], { style: "currency", currency: cur || "GBP", notation: n >= 1e5 ? "compact" : "standard", maximumFractionDigits: n >= 1e5 ? 1 : 0 }).format(n); }
  catch (e) { return Math.round(n).toLocaleString() + " " + cur; }
}
async function api(method, path, body, signal) {
  const r = await fetch(path, {
    method, credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", "X-Requested-With": "ProcessCheck" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { }
  if (!r.ok) {
    const e = new Error((data && data.error) || `Something went wrong (${r.status}).`);
    e.status = r.status; e.data = data;
    if (r.status === 401 && path !== "/api/login") { S.me = null; S.view = "auth"; render(); }
    throw e;
  }
  return data;
}
function setReview(data) {
  S.R = { meta: data.meta, analysis: data.analysis, inputs: data.inputs || {}, comments: data.comments || [], history: data.history || [], flowCalc: data.flowCalc || null, workflow: data.workflow || { stage: "complete", confirmed: {}, reviewed: {} }, raciChecks: data.raciChecks || [], insights: data.insights || null };
  if (data.names) S.names = data.names;
}

/* ---------- start-up & navigation ---------- */
(async () => {
  setUiLang(savedUiLang(), false);
  try {
    const d = await api("GET", "/api/me");
    S.provider = d.provider || "demo"; S.allowSignup = d.allowSignup !== false; S.legal = d.legal || null;
    S.billing = d.billing || null; S.audiences = d.audiences || [];
    const qs = new URLSearchParams(location.search);
    const bq = qs.get("billing"), vq = qs.get("view"), rq = qs.get("reset");
    if (qs.get("signup")) { S.authMode = "register"; history.replaceState(null, "", location.pathname); }
    if (bq || vq || rq) history.replaceState(null, "", location.pathname);
    if (rq) {
      // Arrived from a password-reset email.
      let valid = false;
      try { valid = (await api("POST", "/api/reset/check", { token: rq })).valid; } catch (e) { }
      S.resetToken = valid ? rq : null;
      S.authMode = valid ? "reset" : "forgot";
      if (!valid) { S.status = _t("This reset link has expired or has already been used. Enter your email to get a new one."); S.statusErr = true; }
      S.view = "auth"; render(); return;
    }
    if (!d.user) { S.view = "auth"; render(); return; }
    S.me = d.user;
    if (bq === "success") { S.flash = _t("Payment received, thank you. Your reviews will appear here within a few seconds."); await goBilling(true); }
    else if (bq === "cancelled") { S.flash = _t("Payment cancelled. Nothing was charged."); await goBilling(); }
    else if (vq === "billing") await goBilling();
    else await goHome();
  } catch (e) { S.view = "auth"; S.status = _t("Can't reach the server."); S.statusErr = true; render(); }
})();
/* Browser Back/Forward move between the pages of a review and back to the list. */
function go(tab) {
  if (S.tab === tab) return;
  S.tab = tab; S.walk = null;
  try { history.pushState({ v: "review", id: S.R && S.R.meta.id, tab }, "", location.pathname); } catch (e) { }
  render(); window.scrollTo(0, 0);
}
window.addEventListener("popstate", async e => {
  const st = e.state || {};
  if (S.edit) { try { history.pushState(st, "", location.pathname); } catch (x) { } S.flash = _t("Save or cancel your edits first."); render(); return; }
  if (st.v === "review" && st.id != null) {
    if (!S.R || String(S.R.meta.id) !== String(st.id)) await openReview(st.id, true);
    S.tab = st.tab || S.tab; render(); window.scrollTo(0, 0);
  } else if (S.me) { await goHome(true); }
});
function pageNav(A) {
  const pages = [["summary", "Summary"], ...JOURNEY.map(([k, l]) => [k, l]), ["actions", "Actions"], ["activity", "Activity"]].filter(([k]) => tabOpen(k, A));
  const i = pages.findIndex(([k]) => k === S.tab);
  if (i < 0) return null;
  const prev = pages[i - 1], next = pages[i + 1];
  return h("nav", { class: "pagenav", "aria-label": _t("Previous and next page") },
    prev ? h("button", { class: "btn", onclick: () => go(prev[0]) }, _t("\u2190 {0}", [_t(prev[1])])) : h("span"),
    next ? h("button", { class: "btn", onclick: () => go(next[0]) }, _t("{0} \u2192", [_t(next[1])])) : h("span"));
}
async function goHome(fromHistory) {
  if (S.edit && S.edit.dirty && !confirmLeave()) return;
  if (fromHistory !== true) { try { history.pushState({ v: "home" }, "", location.pathname); } catch (e) { } }
  S.edit = null;
  await flushNow();
  S.view = "home"; S.R = null; S.status = ""; S.list = null; render();
  try { const d = await api("GET", "/api/reviews"); S.list = d.reviews; S.names = d.names; } catch (e) { S.list = []; }
  if (S.view === "home") render();
}
async function openReview(id, fromHistory) {
  if (!fromHistory) { try { history.pushState({ v: "review", id, tab: null }, "", location.pathname); } catch (e) { } }
  await flushNow();
  S.view = "review"; S.R = null; S.tab = "summary"; S.filter = "all"; S.openNotes = new Set();
  S.signing = false; S.rerunOpen = false; S.status = ""; S.lastChanges = null; S.saveState = "";
  S.needsPay = false; S.edit = null; S.inlineRisk = null; S.confirmCancel = false; S.walk = null; S.showAllSteps = false; S.backOpen = false; S.backTo = null; S.files = null;
  window.scrollTo(0, 0); render();
  try { setReview(await api("GET", `/api/reviews/${id}`)); } catch (e) { S.status = e.message; S.statusErr = true; }
  if (S.R) { const st = S.R.workflow.stage; S.tab = st === "complete" ? (S.R.analysis.headline ? "summary" : "sipoc") : JOURNEY.find(j => j[2] === st)[0]; }
  render();
  if (S.R) ensureLabels(rlang());
}
async function refreshBilling() {
  try { const d = await api("GET", "/api/me"); S.billing = d.billing || null; } catch (e) { }
}
async function goBilling(waitForPayment) {
  await flushNow();
  S.view = "billing"; S.bill = null; render();
  try { S.bill = await api("GET", "/api/billing"); } catch (e) { S.bill = { error: e.message }; }
  render();
  if (waitForPayment && S.bill && !S.bill.error) {
    const before = JSON.stringify([S.bill.credits, S.bill.subscription && S.bill.subscription.status, S.bill.payments.length]);
    for (let i = 0; i < 12 && S.view === "billing"; i++) {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const b = await api("GET", "/api/billing");
        if (JSON.stringify([b.credits, b.subscription && b.subscription.status, b.payments.length]) !== before) {
          S.bill = b; S.flash = _t("Payment received, thank you. Your account has been updated."); await refreshBilling(); render(); return;
        }
      } catch (e) { }
    }
    if (S.view === "billing") { S.flash = _t("Payment received. If your balance hasn't updated yet, refresh this page in a minute."); render(); }
  }
}
async function startCheckout(plan, btn) {
  btn.disabled = true; btn.textContent = _t("Opening secure checkout…");
  try { const d = await api("POST", "/api/billing/checkout", { plan }); location.href = d.url; }
  catch (e) { alert(e.message); btn.disabled = false; btn.textContent = _t("Buy"); }
}
async function openPortal(btn) {
  btn.disabled = true;
  try { const d = await api("POST", "/api/billing/portal"); location.href = d.url; }
  catch (e) { alert(e.message); btn.disabled = false; }
}
async function goTeam() {
  await flushNow();
  S.view = "team"; S.team = null; render();
  try { S.team = await api("GET", "/api/team"); } catch (e) { S.team = { error: e.message }; }
  render();
}
// Check for other people's changes every 15 seconds.
setInterval(async () => {
  if (S.view !== "review" || !S.R || S.dirty || S.saving || S.busy || document.hidden) return;
  try {
    const st = await api("GET", `/api/reviews/${S.R.meta.id}/stamp`);
    if (st.rev !== S.R.meta.rev || st.comments !== S.R.comments.length || st.updatedAt !== S.R.meta.updatedAt) {
      setReview(await api("GET", `/api/reviews/${S.R.meta.id}`));
      remoteChanged();
    }
  } catch (e) { }
}, 15000);
function remoteChanged() {
  const a = document.activeElement;
  if (a && app.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "checkbox"))) { S.pendingRemote = true; return; }
  render();
}
app.addEventListener("focusout", () => { if (S.pendingRemote) { S.pendingRemote = false; setTimeout(render, 0); } });
window.addEventListener("beforeunload", e => { if (S.dirty || (S.edit && S.edit.dirty)) { e.preventDefault(); e.returnValue = ""; } });
function confirmLeave() {
  if (S.leaveOk) { S.leaveOk = false; return true; }
  S.flash = _t("You have unsaved text edits. Save or cancel them first (or click again to leave without saving).");
  S.leaveOk = true; render(); return false;
}

/* ---------- saving team edits ---------- */
function queueSave(log) {
  if (!canWrite()) return;
  if (log) S.pendingLog.push(log);
  S.dirty = true; S.saveState = _t("Saving…"); paintSave();
  clearTimeout(S.timer);
  S.timer = setTimeout(flush, 800);
}
async function flushNow() {
  clearTimeout(S.timer);
  for (let i = 0; i < 100 && S.saving; i++) await new Promise(r => setTimeout(r, 100));
  if (S.dirty) await flush();
}
async function flush() {
  if (S.saving || !S.R) return;
  S.saving = true;
  const log = S.pendingLog.splice(0);
  try {
    const d = await api("PUT", `/api/reviews/${S.R.meta.id}/analysis`, { analysis: S.R.analysis, rev: S.R.meta.rev, log });
    S.R.meta.rev = d.rev;
    S.R.meta.updatedAt = Date.now(); S.R.meta.updatedBy = S.me.id;
    if (S.R.meta.status === "validated") S.R.meta.changedSinceSignoff = true;
    S.saveState = _t("All changes saved");
    S.dirty = S.pendingLog.length > 0;
  } catch (e) {
    if (e.status === 409 && e.data && e.data.review) {
      setReview(e.data.review);
      S.dirty = false; S.pendingLog = [];
      S.saveState = "";
      S.flash = _t("Someone else changed this review at the same time. The latest version is loaded: please re-apply your last change.");
      render();
    } else {
      S.saveState = _t("Couldn't save: ") + e.message;
      S.pendingLog = log.concat(S.pendingLog);
    }
  } finally {
    S.saving = false;
    paintSave();
    if (S.dirty && S.pendingLog.length) { clearTimeout(S.timer); S.timer = setTimeout(flush, 800); }
  }
}
function paintSave() { const el = document.getElementById("savestate"); if (el) el.textContent = S.saveState; }

/* ---------- actions ---------- */
/* Terms & Conditions: the acceptance checkbox (sign-up, and renewed acceptance when switched on). */
function legalLinks() {
  return [
    h("a", { href: "/terms-and-privacy", target: "_blank", rel: "noopener" }, _t("Terms & Conditions and Privacy Policy")),
  ];
}

function privacyLink() {
  return h("a", { href: "/terms-and-privacy#privacy", target: "_blank", rel: "noopener" }, _t("Privacy Policy"));
}
function termsCheckbox(name) {
  const [doc] = legalLinks();
  const box = h("input", { type: "checkbox", name, required: true, "aria-describedby": "terms-help",
    onchange: e => { const f = e.target.form || e.target.closest("form, section"); f.querySelectorAll("[data-needs-terms]").forEach(b => { b.disabled = !e.target.checked || S.busy; }); } });
  box.checked = false; // never pre-ticked
  return h("div", { class: "termsbox" },
    h("label", { class: "termsline" }, box, h("span", null, _t("I have read and agree to the UAIM "), doc, ".")),
    h("span", { id: "terms-help" }));
}
function termsRenewal() {
  const cfgError = S.legal && S.legal.acceptanceError;
  return h("main", { class: "wrap narrow" }, h("section", { class: "panel authbox" },
    h("h1", null, _t(cfgError ? "Terms & Conditions unavailable" : "Updated Terms & Conditions")),
    h("p", { class: cfgError ? "status err" : null },
      _t(cfgError || "The UAIM Terms & Conditions have changed. Please read the current version and accept it to continue.")),
    cfgError ? null : h("div", null,
      termsCheckbox("acceptTermsRenewal"),
      h("div", { class: "row actions" }, h("button", { class: "btn primary", "data-needs-terms": "1", disabled: true, onclick: async e => {
      e.currentTarget.disabled = true;
      try { const r = await api("POST", "/api/terms/accept", { acceptTerms: true, termsVersion: S.legal.legalVersion }); S.legal.needsAcceptance = false; S.legal.accepted = r.accepted; render(); }
      catch (x) { S.status = x.message; S.statusErr = true; render(); }
    } }, _t("Accept and continue")))),
    h("div", { class: "row actions" }, h("button", { class: "btn", onclick: logout }, _t("Sign out"))),
    h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status)));
}
async function submitAuth(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  S.authDraft = Object.fromEntries(Object.entries(data).filter(([k]) => !/password/.test(k)));
  if (S.authMode === "forgot") {
    S.busy = true; S.status = ""; render();
    try { const r = await api("POST", "/api/forgot", { email: data.email }); S.status = r.message; S.statusErr = false; S.forgotSent = true; }
    catch (e) { S.status = e.message; S.statusErr = true; }
    S.busy = false; render(); return;
  }
  if (S.authMode === "reset") {
    if (data.password !== data.password2) { S.status = _t("The two passwords don't match."); S.statusErr = true; return render(); }
    S.busy = true; S.status = ""; render();
    try {
      await api("POST", "/api/reset", { token: S.resetToken, password: data.password });
      S.resetToken = null; S.authMode = "login";
      const d = await api("GET", "/api/me");
      S.me = d.user; S.billing = d.billing || null; S.audiences = d.audiences || S.audiences; S.legal = d.legal || S.legal; S.busy = false;
      S.flash = _t("Your password has been changed, and you've been signed out on every other device.");
      await goHome(); return;
    } catch (e) { S.busy = false; S.status = e.message; S.statusErr = true; render(); return; }
  }
  if (S.authMode === "register" && data.password !== data.password2) { S.status = _t("The two passwords don't match. Type the same password in both boxes."); S.statusErr = true; return render(); }
  if (S.authMode === "register") {
    const box = form.querySelector('input[name="acceptTerms"]');
    if (!box || !box.checked) { S.status = _t("Please accept the Terms & Conditions and acknowledge the Privacy Policy before creating your account."); S.statusErr = true; return render(); }
    delete data.acceptTerms;
    data.acceptTerms = true; data.termsVersion = (S.legal && S.legal.legalVersion) || "";
  }
  S.status = ""; S.busy = true; render();
  try {
    await api("POST", S.authMode === "login" ? "/api/login" : "/api/register", data);
    const d = await api("GET", "/api/me");
    S.me = d.user; S.billing = d.billing || null; S.audiences = d.audiences || S.audiences; S.legal = d.legal || S.legal; S.busy = false; await goHome();
  } catch (e) { S.busy = false; S.status = e.message; S.statusErr = true; render(); }
}
async function logout() {
  await flushNow();
  try { await api("POST", "/api/logout"); } catch (e) { }
  S.me = null; S.view = "auth"; S.authMode = "login"; S.status = ""; render();
}
async function createReview() {
  const f = S.form;
  const text = [S.newFileText ? `From file ${S.newFileName}:\n${S.newFileText}` : "", f.text.trim()].filter(Boolean).join("\n\n");
  if (!text && !(S.newImgs && S.newImgs.length)) { S.status = _t("Add a process first: upload a file, paste the steps, or try the example."); S.statusErr = true; return render(); }
  S.busy = true; S.ctl = new AbortController(); S.status = _t("Reviewing your process. This usually takes one to two minutes."); S.statusErr = false; render();
  try {
    // One key per click-through: a double-click or retry can't create a second review or use a second credit.
    if (!S.requestId) S.requestId = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2));
    const d = await api("POST", "/api/reviews", { ...f, text, images: S.newImgs || [], requestId: S.requestId, knownIssues: f.knownIssues || "", issuesText: f.knownIssues === "yes" ? (f.issuesText || "") : "" }, S.ctl.signal);
    S.requestId = null;
    if (S.newFile) { S.status = _t("Keeping the original file…"); render(); await keepOriginal(d.id, S.newFile); }
    S.newFile = null;
    S.busy = false; S.form.text = ""; S.form.knownIssues = ""; S.form.issuesText = ""; S.newImgs = S.newFileText = S.newFileName = null;
    refreshBilling();
    await openReview(d.id);
  } catch (e) {
    S.busy = false;
    S.needsPay = !!(e.data && e.data.needsPayment);
    S.status = e.name === "AbortError" ? _t("Stopped. (The server may still finish the analysis; check your reviews list.)") : e.message;
    S.statusErr = e.name !== "AbortError"; refreshBilling(); render();
  }
}
async function rerun(notes) {
  await flushNow();
  S.busy = true; S.ctl = new AbortController(); S.status = _t("Re-analysing with the team's input. This usually takes one to two minutes."); S.statusErr = false; render();
  try {
    const d = await api("POST", `/api/reviews/${S.R.meta.id}/rerun`, { notes }, S.ctl.signal);
    setReview(d); S.lastChanges = d.changes || [];
    S.busy = false; S.rerunOpen = false; S.status = ""; S.tab = "summary"; render();
  } catch (e) {
    S.busy = false; S.status = e.name === "AbortError" ? _t("Stopped.") : e.message; S.statusErr = e.name !== "AbortError"; render();
  }
}
async function addNote(fmId, ta) {
  const text = ta.value.trim();
  if (!text) return;
  await flushNow();
  try { setReview(await api("POST", `/api/reviews/${S.R.meta.id}/comments`, { fmId, text })); ta.value = ""; render(); }
  catch (e) { alert(e.message); }
}
async function signOff(note) {
  await flushNow();
  try { setReview(await api("POST", `/api/reviews/${S.R.meta.id}/signoff`, { note })); S.signing = false; render(); }
  catch (e) { alert(e.message); }
}
async function deleteReview() {
  if (!confirm(_t("Delete this review for everyone in your company? This can't be undone."))) return;
  try { await api("DELETE", `/api/reviews/${S.R.meta.id}`); S.dirty = false; await goHome(); } catch (e) { alert(e.message); }
}
function loadScript(urls) {
  return urls.reduce((p, url) => p.catch(() => new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = url; s.onload = res; s.onerror = () => { s.remove(); rej(); };
    document.head.append(s);
  })), Promise.reject());
}
function fileBase() {
  return (S.R.analysis.processName || "process-review").replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 60) + "-v" + (S.R.meta.version || 1);
}
/* Original files and downloaded reports are kept on the server (the website only, not the Claude version). */
async function sendFile(path, fields) {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => (v instanceof Blob ? fd.append(k, v, v.name || k) : fd.append(k, String(v))));
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "X-Requested-With": "ProcessCheck" }, body: fd });
  let d = null; try { d = await r.json(); } catch (e) { }
  if (!r.ok) throw new Error((d && d.error) || `Upload failed (${r.status}).`);
  return d;
}
async function keepReportCopy(blob, format, lang) {
  if (typeof Backend !== "undefined" || !S.R) return;
  const rid = S.R.meta.id, version = S.R.meta.version;
  try { await sendFile(`/api/reviews/${rid}/reports`, { file: blob, format, lang, version }); if (S.R && S.R.meta.id === rid) S.files = null; }
  catch (e) { console.warn("The report copy wasn't kept:", e.message); }
}
async function keepOriginal(rid, file) {
  if (typeof Backend !== "undefined" || !file) return;
  try { await sendFile(`/api/reviews/${rid}/files`, { file }); }
  catch (e) { S.flash = _t("The review was created, but the original file couldn't be kept: {0}", [e.message]); }
}
async function loadFiles() {
  if (typeof Backend !== "undefined" || !S.R) return;
  const rid = S.R.meta.id;
  try { const d = await api("GET", `/api/reviews/${rid}/files`); if (S.R && S.R.meta.id === rid) { S.files = d.files; render(); } } catch (e) { }
}
function filesBlock() {
  if (typeof Backend !== "undefined") return null;
  if (S.files == null) { if (!S.filesLoading) { S.filesLoading = true; loadFiles().finally(() => { S.filesLoading = false; }); } return h("p", { class: "muted small" }, _t("Loading files…")); }
  const size = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
  const row = f => h("li", null, h("a", { href: f.url, download: f.name }, f.name), h("span", { class: "muted small" },
    ` \u00b7 ${size(f.size)} \u00b7 ${name(f.by)} \u00b7 ${when(f.at)}`));
  const ups = S.files.filter(f => f.kind === "upload"), reps = S.files.filter(f => f.kind === "report");
  return h("section", { class: "files" },
    h("h2", null, _t("Files")),
    h("h3", null, _t("Original files")),
    ups.length ? h("ul", null, ups.map(row)) : h("p", { class: "muted small" }, _t("No original file: this review was created from typed or pasted text.")),
    h("h3", null, _t("Downloaded reports")),
    reps.length ? h("ul", null, reps.map(row)) : h("p", { class: "muted small" }, _t("No reports downloaded yet. A copy of each PDF or Word report is kept here when someone downloads it.")));
}
async function saveFile(blob, filename) {
  if (typeof Backend !== "undefined" && Backend.downloads) {
    try { await Backend.downloads.save({ filename, data: new Uint8Array(await blob.arrayBuffer()) }); }
    catch (e) { if (!(e && e.code === "declined")) throw e; }
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function getLabels(lang, btn) {
  if (lang === "en") return {};
  if (S.labels && S.labels[lang]) return S.labels[lang];
  const before = btn.textContent;
  btn.textContent = _t("Translating report wording…");
  try { const lb = (await api("POST", "/api/labels", { lang, labels: PDF_LABELS })).labels || {}; S.labels = S.labels || {}; S.labels[lang] = lb; return lb; }
  catch (e) { alert(_t("The report headings couldn't be translated, so they're in English this time.")); return {}; }
  finally { btn.textContent = before; }
}
async function exportWord(btn) {
  await flushNow();
  const label = btn.textContent; btn.disabled = true; btn.textContent = _t("Preparing Word file…");
  try {
    if (!window.docx) await loadScript(["/static/vendor/docx.iife.js", "https://cdn.jsdelivr.net/npm/docx@9.5.1/dist/index.iife.js"]);
const lang = S.R.inputs.lang || "en";
    const labels = await getLabels(lang, btn);
    const Lc = (k, p) => String(labels[k] || PDF_LABELS[k] || k).replace(/\{(\w+)\}/g, (_, x) => (p && p[x] != null ? p[x] : ""));
    let images = null;
    try { images = { flow: flowPng(S.R.analysis, Lc), map: mapPng(allFms(S.R.analysis).map(x => x.f), Lc), vsm: vsmPng(S.R.analysis, S.R.flowCalc, Lc), sipoc: sipocPng(S.R.analysis, Lc) }; } catch (e) { images = null; }
    const doc = buildDocx(window.docx, lastDocxArgs = { meta: S.R.meta, A: S.R.analysis, flowCalc: S.R.flowCalc, raciChecks: S.R.raciChecks, inputs: S.R.inputs, raciConfirmed: !!(S.R.workflow && S.R.workflow.confirmed && S.R.workflow.confirmed.raci), raciConfirmedBy: (S.R.workflow.confirmed.raci && (S.names[S.R.workflow.confirmed.raci.by] || "")) || "", raciConfirmedOn: S.R.workflow.confirmed.raci ? new Date(S.R.workflow.confirmed.raci.at * 1000).toLocaleDateString(langOf(lang)[2], { day: "numeric", month: "long", year: "numeric" }) : "", insights: S.R.insights, comments: S.R.comments, names: S.names, cur: S.R.inputs.cur, generatedAt: Date.now(),
      labels, locale: langOf(lang)[2], lang, images, logos: await getBrand(), embedFonts: await docxFonts(),
 });
    let blob;
    try { blob = await window.docx.Packer.toBlob(doc); }
    catch (e) { // if embedding the fonts fails in this browser, make the file without them
      S.noEmbed = true;
      blob = await window.docx.Packer.toBlob(buildDocx(window.docx, { ...lastDocxArgs, embedFonts: undefined }));
    }
    await saveFile(blob, fileBase() + ".docx");
    keepReportCopy(blob, "docx", lang);
  } catch (e) { alert(_t("The Word file couldn't be created. Check your internet connection and try again.")); }
  finally { btn.disabled = false; btn.textContent = _t(label); }
}
/* Brand assets for the reports: fonts (Manrope body, Sora titles) and logos. The claude.ai version embeds them as PC_FONTS / PC_BRAND. */
async function fetchBytes(u) { return new Uint8Array(await (await fetch(u)).arrayBuffer()); }
function toB64(b) { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(s) { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; }
async function getFonts() {
  if (S.fonts !== undefined) return S.fonts;
  try {
    if (window.PC_FONTS) S.fonts = window.PC_FONTS;
    else S.fonts = { normal: toB64(await fetchBytes("/static/fonts/Manrope-Regular.ttf")), bold: toB64(await fetchBytes("/static/fonts/Manrope-Bold.ttf")),
      title: toB64(await fetchBytes("/static/fonts/Sora-Bold.ttf")) };
  } catch (e) { S.fonts = null; }
  return S.fonts;
}
let lastDocxArgs = null;
async function docxFonts() {
  if (S.noEmbed) return undefined;
  try {
    const f = await getFonts(); if (!f || !f.title) return undefined;
    return [{ name: "Manrope", data: fromB64(f.normal) }, { name: "Sora", data: fromB64(f.title) }];
  } catch (e) { return undefined; }
}
async function getBrand() {
  if (S.brand !== undefined) return S.brand;
  try {
    const src = window.PC_BRAND || {};
    const get = async (k, file) => src[k] ? fromB64(src[k]) : await fetchBytes("/static/brand/" + file);
    const pics = { horizontal: await get("horizontal", "logo-horizontal.png"), reversed: await get("reversed", "logo-primary-reversed.png") };
    const dims = async b => { const im = new Image(); const url = URL.createObjectURL(new Blob([b], { type: "image/png" })); im.src = url; await im.decode(); URL.revokeObjectURL(url); return [im.naturalWidth, im.naturalHeight]; };
    const [hw, hh] = await dims(pics.horizontal), [rw, rh] = await dims(pics.reversed);
    S.brand = { horizontal: "data:image/png;base64," + toB64(pics.horizontal), horizontalRatio: hh / hw,
      reversed: "data:image/png;base64," + toB64(pics.reversed), reversedRatio: rh / rw,
      horizontalPng: { data: pics.horizontal, width: Math.round(hw / 2), height: Math.round(hh / 2) } };
  } catch (e) { S.brand = null; }
  return S.brand;
}
async function exportPdf(btn) {
  await flushNow();
  const label = btn.textContent; btn.disabled = true; btn.textContent = _t("Preparing PDF…");
  try {
    if (!window.jspdf) await loadScript(["https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"]);
    const jsPDF = window.jspdf.jsPDF;
    if (typeof jsPDF.API.autoTable !== "function") await loadScript(["https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js", "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js"]);
const lang = S.R.inputs.lang || "en";
    const labels = await getLabels(lang, btn);
    const fonts = await getFonts();
    const data = buildPdf(jsPDF, { meta: S.R.meta, A: S.R.analysis, flowCalc: S.R.flowCalc, raciChecks: S.R.raciChecks, inputs: S.R.inputs, raciConfirmed: !!(S.R.workflow && S.R.workflow.confirmed && S.R.workflow.confirmed.raci), raciConfirmedBy: (S.R.workflow.confirmed.raci && (S.names[S.R.workflow.confirmed.raci.by] || "")) || "", raciConfirmedOn: S.R.workflow.confirmed.raci ? new Date(S.R.workflow.confirmed.raci.at * 1000).toLocaleDateString(langOf(lang)[2], { day: "numeric", month: "long", year: "numeric" }) : "", insights: S.R.insights, comments: S.R.comments, names: S.names, cur: S.R.inputs.cur, generatedAt: Date.now(),
      labels, locale: langOf(lang)[2], lang, logos: await getBrand(),
      fonts: fonts && ["el", "bg", "uk"].includes(lang) ? { normal: fonts.normal, bold: fonts.bold } : fonts,
 });
    const pdfBlob = new Blob([data], { type: "application/pdf" });
    await saveFile(pdfBlob, fileBase() + ".pdf");
    keepReportCopy(pdfBlob, "pdf", lang);
  } catch (e) { alert(_t("The PDF couldn't be created. Check your internet connection and try again.")); }
  finally { btn.disabled = false; btn.textContent = _t(label); }
}

/* ---------- rendering ---------- */
function render() {
  const y = window.scrollY;
  app.textContent = "";
  app.append(topbar());
  if (S.view === "loading") app.append(h("p", { class: "muted wrap" }, _t("Loading…")));
  else if (S.view === "auth") app.append(authView());
  else if (S.me && S.legal && S.legal.needsAcceptance) app.append(termsRenewal());
  else if (S.view === "home") app.append(home());
  else if (S.view === "new") app.append(newView());
  else if (S.view === "team") app.append(teamView());
  else if (S.view === "billing") app.append(billingView());
  else app.append(review());
  app.append(h("footer", { class: "sitefoot" }, h("p", { class: "sig" }, _t("Understand first. Improve what matters.")), h("p", null, _t("UAIM reviews are generated by artificial intelligence and may contain mistakes. Costs and savings are estimates for indication purposes only. Translations are automated. Always check the findings with the people who run the process before acting on them.")),
    typeof Backend === "undefined" ? h("p", { class: "legal" }, h("a", { href: "/terms-and-privacy" }, _t("Terms & Conditions & Privacy Policy")),
      " \u00b7 ", _t("UAIM is a project operated by GTurk Projects Ltd.")) : null));
  window.scrollTo(0, y);
}
function topbar() {
  return h("header", { class: "topbar" },
    h("button", { class: "brand", "aria-label": _t("UAIM, home"), onclick: () => S.me && goHome() },
      h("img", { src: (window.PC_BRAND && window.PC_BRAND.headerUrl) || "/static/brand/logo-horizontal-reversed.png", alt: "UAIM" })),
    h("div", { class: "barright" },
      S.view === "review" ? h("span", { id: "savestate", class: "save" }, S.saveState) : null,
      S.me ? h("button", { class: "btn link", onclick: goTeam }, _t("Team")) : null,
      S.me && S.billing && S.billing.enabled ? h("button", { class: "btn link", onclick: () => goBilling() }, _t("Billing")) : null,
      S.me ? h("button", { class: "btn link", onclick: logout }, _t("Sign out")) : null));
}
function authView() {
  const mode = S.authMode, login = mode === "login";
  const keep = S.authDraft || {};
  const field = (n, label, type, extra) => h("label", { class: "sel" }, _t(label), h("input", { name: n, type: type || "text", required: !extra?.optional, autocomplete: extra?.ac, minlength: extra?.min,
    value: type === "password" ? "" : (keep[n] || "") }));
  const sw = (m, label) => h("button", { type: "button", class: "btn link", onclick: () => { S.authMode = m; S.status = ""; S.statusErr = false; S.forgotSent = false; render(); } }, _t(label));
  let form;
  if (mode === "forgot") {
    form = h("form", { class: "panel authbox", onsubmit: e => { e.preventDefault(); submitAuth(e.target); } },
      h("h1", null, _t("Reset your password")),
      h("p", { class: "muted" }, _t("Enter the email you sign in with, and we'll send you a link to choose a new password.")),
      field("email", "Work email", "email", { ac: "email" }),
      h("div", { class: "row actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy }, S.busy ? _t("Please wait…") : S.forgotSent ? _t("Send the link again") : _t("Send reset link"))),
      h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status),
      h("p", { class: "small" }, _t("Remembered it? "), sw("login", "Back to sign in")));
  } else if (mode === "reset") {
    form = h("form", { class: "panel authbox", onsubmit: e => { e.preventDefault(); submitAuth(e.target); } },
      h("h1", null, _t("Choose a new password")),
      field("password", "New password (at least 10 characters)", "password", { ac: "new-password", min: 10 }),
      field("password2", "Type it again", "password", { ac: "new-password", min: 10 }),
      h("div", { class: "row actions" }, h("button", { class: "btn primary", type: "submit", disabled: S.busy }, S.busy ? _t("Please wait…") : _t("Save new password"))),
      h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status),
      h("p", { class: "muted small" }, _t("Saving signs you out on every other device.")));
  } else {
    form = h("form", { class: "panel authbox", onsubmit: e => { e.preventDefault(); submitAuth(e.target); } },
      h("h1", null, login ? _t("Sign in") : _t("Create your account")),
      login ? null : field("name", "Your name", "text", { ac: "name" }),
      field("email", "Work email", "email", { ac: "email" }),
      field("password", login ? "Password" : "Password (at least 10 characters)", "password", { ac: login ? "current-password" : "new-password", min: login ? null : 10 }),
      login ? null : field("password2", "Type the password again", "password", { ac: "new-password", min: 10 }),
      login ? h("p", { class: "small forgot" }, sw("forgot", "Forgot your password?")) : null,
      login ? null : h("label", { class: "sel" }, _t("Your role (optional)"), h("select", { name: "position" }, h("option", { value: "" }, _t("Prefer not to say")),
        S.audiences.filter(a => a.id !== "general").map(a => h("option", { value: a.id }, a.label)))),
      login ? null : h("fieldset", null, h("legend", null, _t("Your company")),
        field("company", "Company name (to start a new team)", "text", { optional: true, ac: "organization" }),
        h("p", { class: "muted small" }, _t("Or join a colleague's team instead:")),
        field("inviteCode", "Invite code", "text", { optional: true })),
      login ? null : h("p", { class: "muted small" }, _t("Your first review is free. No payment details needed.")),
      login ? null : termsCheckbox("acceptTerms"),
      h("div", { class: "row actions" }, h("button", { class: "btn primary", type: "submit", "data-needs-terms": login ? null : "1", disabled: S.busy || !login }, S.busy ? _t("Please wait…") : login ? _t("Sign in") : _t("Create account"))),
      h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status),
      S.allowSignup ? h("p", { class: "small" }, login ? _t("New here? ") : _t("Already have an account? "), sw(login ? "register" : "login", login ? "Create an account" : "Sign in")) : null);
  }
  return h("main", { class: "wrap narrow" },
    h("p", { class: "lede" }, _t("Understand first. Improve what matters. See how your processes really work, where they lose time, money and customers, and what to fix first: an expert-level review in minutes, then a living document your team corrects, tracks and signs off.")),
    form);
}
function home() {
  const m = h("main", { class: "wrap" },
    S.flash ? h("p", { class: "note" }, S.flash, " ", h("button", { class: "btn link", onclick: () => { S.flash = ""; render(); } }, _t("Dismiss"))) : null,
    S.provider === "demo" ? h("p", { class: "note" }, h("b", null, _t("Demo mode. ")), _t("No AI is connected yet, so every new review returns the built-in example analysis. Set AI_PROVIDER in the server's .env file to use Mistral, Claude or a local model.")) : null,
    h("section", { class: "hero" },
      h("h1", null, _t("Process reviews")),
      h("p", { class: "lede" }, _t("Describe any process and see in minutes where it loses time, money and customers. Treat it as a discussion starter: the team adjusts ratings, adds notes, tracks actions, re-runs the analysis with their input, and signs it off.", [S.me.company])),
      allowanceLine(),
      canWrite() ? h("button", { class: "btn primary big", onclick: () => { S.view = "new"; S.status = ""; S.needsPay = false; render(); } }, _t("New review")) :
        h("p", { class: "note" }, _t("You have view-only access. Ask an admin to make you a member to create or edit reviews."))));
  const list = S.list;
  if (list == null) m.append(h("p", { class: "muted" }, _t("Loading reviews…")));
  else if (!list.length) m.append(h("div", { class: "empty" }, h("p", null, _t("No reviews yet.")), canWrite() ? h("p", { class: "muted" }, _t("Start with New review. Try an example is a quick way to see how it works.")) : null));
  else {
    const grid = h("div", { class: "cards" });
    list.forEach(r => {
      const pct = r.actionsTotal ? Math.round(100 * (r.actionsDone || 0) / r.actionsTotal) : 0;
      grid.append(h("button", { class: "rcard", onclick: () => openReview(r.id) },
        h("div", { class: "rtop" }, statusBadge(r), h("span", { class: "muted small" }, (r.lang && r.lang !== "en" ? langOf(r.lang)[1].split(" (")[0] + " · " : "") + "v" + (r.version || 1))),
        h("h3", null, r.title || _t("Untitled process")),
        h("p", { class: "muted small clamp" }, r.headline || ""),
        h("div", { class: "rstats" },
          h("span", null, h("b", null, r.score ?? "-"), _t("/100 health")),
          h("span", { class: r.high ? "hi" : "" }, h("b", null, r.high || 0), _t(" high risks")),
          h("span", null, h("b", null, `${r.actionsDone || 0}/${r.actionsTotal || 0}`), _t(" actions done"))),
        h("div", { class: "prog" }, h("i", { style: `width:${pct}%` })),
        h("p", { class: "muted small" }, _t("Updated {0} by {1}", [when(r.updatedAt), name(r.updatedBy)]))));
    });
    m.append(grid);
  }
  return m;
}
function allowanceLine() {
  const b = S.billing;
  if (!b || !b.enabled) return null;
  const n = b.available || 0;
  const sub = b.subscription && b.subscription.active ? ` (${b.subscription.label}: ${Math.max(0, b.subscription.monthly - b.subscription.used)} left this month${b.credits ? `, plus ${b.credits} credit${b.credits === 1 ? "" : "s"}` : ""})` : "";
  return h("p", { class: "allow" + (n ? "" : " none") },
    n ? h("span", null, h("b", null, n), _t(" review{0} available{1}. ", [_pl(n === 1 ? "" : "s"), _t(sub)])) : h("span", null, h("b", null, _t("No reviews left. ")), _t("Buy review credits to create new reviews. ")),
    h("button", { class: "btn link", onclick: () => goBilling() }, n ? _t("Billing") : _t("Buy credits")));
}
function statusBadge(r) {
  if (r.stage && r.stage !== "complete") {
    const n = STAGE_ORDER.indexOf(r.stage) + 2, l = { steps: "Steps", sipoc: "SIPOC", risk: "Risk analysis", flow: "Process Efficiency Analysis", swot: "SWOT", raci: "RACI" }[r.stage];
    return h("span", { class: "badge stage" }, _t("Stage {0} of 7: {1}", [n, _t(l)]));
  }
  return r.status === "validated"
    ? h("span", { class: "badge " + (r.changedSinceSignoff ? "warn" : "ok") }, r.changedSinceSignoff ? _t("Changed since sign-off") : _t("Validated"))
    : h("span", { class: "badge draft" }, _t("Draft for discussion"));
}
function newView() {
  const f = S.form;
  const sel = (key, opts, label) => h("label", { class: "sel" }, _t(label), h("select", { onchange: e => { f[key] = e.target.value; } }, opts.map(o => h("option", { value: o, selected: f[key] === o }, _t(o)))));
  const num = (key, label, ph) => h("label", { class: "sel" }, _t(label), h("input", { type: "number", min: "0", inputmode: "decimal", placeholder: _t(ph), value: f[key], oninput: e => { f[key] = e.target.value; } }));
  // Kept in the page (visually hidden, not display:none) so every browser and app opens the picker.
  const fileInput = h("input", { type: "file", class: "vh", tabindex: "-1", "aria-hidden": "true",
    accept: ".pdf,application/pdf,.txt,.md,.csv,.json,.tsv,text/plain,text/markdown,text/csv,application/json,image/png,image/jpeg,image/webp",
    onchange: e => { const fl = e.target.files && e.target.files[0]; e.target.value = ""; if (fl) takeFile(fl); } });
  S.fileInput = fileInput;
  const drop = h("div", { class: "drop", ondragover: e => { e.preventDefault(); drop.classList.add("over"); }, ondragleave: () => drop.classList.remove("over"), ondrop: e => { e.preventDefault(); drop.classList.remove("over"); const fl = e.dataTransfer.files[0]; if (fl) takeFile(fl); } },
    h("p", null, _t("Drop a file here: a PDF, a text file (.txt, .md, .csv, .json), or an image of a process map.")),
    h("button", { class: "btn", type: "button", onclick: e => { e.stopPropagation(); fileInput.click(); } }, _t("Choose file")), fileInput);
  return h("main", { class: "wrap" },
    h("button", { class: "back", onclick: goHome }, _t("← All reviews")),
    h("h1", null, _t("New review")),
    h("ol", { class: "journeyintro" }, ["Your process", "Steps", "SIPOC", "Risk analysis", "Process Efficiency Analysis", "SWOT", "RACI"].map((l, i) => h("li", { class: i === 0 ? "cur" : "" }, h("b", null, i + 1), " " + _t(l)))),
    h("p", { class: "muted small" }, _t("Stage 1 of 7. After you describe the process, you'll first check its steps, then each stage before the next one is built, so everything rests on information your team has confirmed. One credit covers all seven stages.")),
    h("p", { class: "lede" }, _t("Describe how the process runs today: who does what, in what order, with which systems, and where it waits for someone.")),
    h("section", { class: "panel" },
      drop,
      S.newFileName ? h("span", { class: "chip" }, S.newFileName, h("button", { "aria-label": _t("Remove file"), onclick: () => { S.newFileName = S.newFileText = S.newImgs = S.newFile = null; S.status = ""; render(); } }, "✕")) : null,
      h("p", { class: "muted small pickhint" }, _t("If the file picker doesn't open, your app may not allow file uploads inside pages like this one. Open this page in a web browser instead, or copy the text from your document and paste it below. You can also paste a screenshot or a copied file straight into the box.")),
      h("textarea", { placeholder: _t("Or describe the process here…"), oninput: e => { f.text = e.target.value; },
        onpaste: e => {
          const items = [...((e.clipboardData && e.clipboardData.files) || [])];
          const fl = items.find(x => /^image\/|application\/pdf/.test(x.type) || /\.(pdf|txt|md|csv|json)$/i.test(x.name || ""));
          if (fl) { e.preventDefault(); takeFile(fl.name ? fl : new File([fl], "pasted-image.png", { type: fl.type })); }
        } }, f.text),
      h("div", { class: "row" },
        sel("priority", ["Balanced review", "Margin and cost", "Speed and cycle time", "Ready to scale with growth", "Compliance and risk exposure", "Customer experience", "Automation and AI readiness"], "Your priority"),
        sel("size", ["Not specified", "Under 50 people", "50 to 250 people", "250 to 1,000 people", "Over 1,000 people"], "Company size")),
      h("fieldset", { class: "issuesq" }, h("legend", null, _t("Are there any known issues or problems with this process?"), " ", h("span", { class: "muted small" }, _t("(optional)"))),
        h("p", { class: "muted small" }, _t("Tell us about any difficulties, frustrations or recurring problems experienced when carrying out this process. This will help us understand your concerns and provide additional context for the review.")),
        h("div", { class: "choices", role: "radiogroup" }, [["yes", "Yes, there are known issues."], ["no", "No known issues."], ["unsure", "I'm not sure."]].map(([v, l]) =>
          h("label", { class: "choice" + (f.knownIssues === v ? " on" : "") }, h("input", { type: "radio", name: "knownIssues", value: v, checked: f.knownIssues === v,
            onchange: () => { f.knownIssues = v; render(); } }), " ", _t(l))),
          f.knownIssues ? h("button", { type: "button", class: "btn link", onclick: () => { f.knownIssues = ""; f.issuesText = ""; render(); } }, _t("Clear answer")) : null),
        f.knownIssues === "yes" ? h("textarea", { class: "short", "aria-label": _t("Please describe the issues you are experiencing..."), maxlength: 4000,
          placeholder: _t("Please describe the issues you are experiencing... For example: delays, errors, rework, customer complaints, communication problems, bottlenecks or unnecessary activities."),
          oninput: e => { f.issuesText = e.target.value; } }, f.issuesText || "") : null),
      h("fieldset", null, h("legend", null, _t("Size the cost (optional)")),
        h("div", { class: "row" }, num("runs", "Times it runs per month", "e.g. 400"), num("rate", "Loaded cost per staff hour", "e.g. 45"),
          sel("cur", ["GBP", "EUR", "USD", "CAD", "AUD", "CHF"], "Currency"))),
      h("p", { class: "muted small" }, _t("Reviews are generated by AI and may contain mistakes. Cost figures are indicative only, and reviews in languages other than English are produced automatically.")),
      h("div", { class: "row actions" },
        h("button", { class: "btn primary", disabled: S.busy, onclick: createReview }, S.busy ? _t("Reviewing…") : _t("Review this process")),
        S.busy ? h("button", { class: "btn", onclick: () => S.ctl && S.ctl.abort() }, _t("Stop waiting")) : null,
        S.busy ? null : h("button", { class: "btn link", onclick: () => { f.text = EXAMPLE; f.runs = "400"; f.rate = "45"; render(); } }, _t("Try an example"))),
      h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status),
      S.needsPay ? h("button", { class: "btn primary", onclick: () => goBilling() }, _t("Go to Billing")) : null,
      S.billing && S.billing.enabled && !S.busy ? h("p", { class: "muted small" }, S.billing.available ? _t("Running a review uses 1 of your {0} available review{1}.", [S.billing.available, _pl(S.billing.available === 1 ? "" : "s")])
        : S.billing.freeReview && S.billing.freeReview.eligible && !S.billing.freeReviewUsed ? _t("This is your free review: a complete review, plus a few changes. Editing, notes, actions, sign-off and downloads are always unlimited.")
        : _t("You have no reviews left.")) : null));
}
const PDFJS = "3.11.174";
async function loadPdfJs() {
  if (!window.pdfjsLib) await loadScript([`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS}/pdf.min.js`, `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS}/build/pdf.min.js`]);
  // Loading the worker as a normal script lets PDF.js run on the page itself, which works everywhere.
  if (!window.pdfjsWorker) await loadScript([`https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS}/pdf.worker.min.js`, `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS}/build/pdf.worker.min.js`]);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS}/pdf.worker.min.js`;
  return window.pdfjsLib;
}
async function readPdf(fl) {
  const lib = await loadPdfJs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await readBuffer(fl)), isEvalSupported: false, disableFontFace: true, useSystemFonts: true }).promise;
  let text = "";
  const pages = Math.min(pdf.numPages, 80);
  for (let i = 1; i <= pages && text.length < 40000; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    const pageText = tc.items.map(it => (it.str || "") + (it.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (pageText) text += (pdf.numPages > 1 ? `\n--- Page ${i} ---\n` : "") + pageText + "\n";
  }
  return { pdf, text: text.trim().slice(0, 40000), numPages: pdf.numPages };
}
async function renderPdfPages(pdf, max) {
  const out = [];
  for (let i = 1; i <= Math.min(max, pdf.numPages); i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: Math.min(2, 1400 / base.width) });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(cv.toDataURL("image/jpeg", 0.85));
  }
  return out;
}
const readAs = (fl, how) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r[how](fl); });
const readText = fl => (typeof fl.text === "function" ? fl.text() : readAs(fl, "readAsText"));
const readBuffer = fl => (typeof fl.arrayBuffer === "function" ? fl.arrayBuffer() : readAs(fl, "readAsArrayBuffer"));
const readDataUrl = fl => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(fl); });
async function takeFile(fl) {
  S.newImgs = null; S.newFileText = null; S.newFileName = fl.name; S.newFile = fl; S.statusErr = false;
  const isPdf = fl.type === "application/pdf" || /\.pdf$/i.test(fl.name);
  try {
    if (isPdf) {
      if (fl.size > 25e6) throw Object.assign(new Error("That PDF is over 25 MB. Try a smaller file, or export just the pages about the process."), { user: true });
      S.status = _t("Reading the PDF…"); render();
      const { pdf, text, numPages } = await readPdf(fl);
      if (text.replace(/\s/g, "").length >= 200) {
        S.newFileText = text;
        S.status = _t("Read {0} page{1} of text from the PDF", [Math.min(numPages, 80), _pl(numPages === 1 ? "" : "s")]) + (text.length >= 40000 ? _t(" (the first 40,000 characters will be used).") : ".");
      } else {
        // Little or no text: probably a scan or a diagram. Send the first pages as pictures instead.
        S.status = _t("This PDF looks like a scan or a diagram. Preparing its pages as images…"); render();
        S.newImgs = await renderPdfPages(pdf, 4);
        S.status = _t("The PDF has little text, so its first {0} page{1} will be read as images.", [S.newImgs.length, _pl(S.newImgs.length === 1 ? "" : "s")]);
      }
    } else if (fl.type.startsWith("image/")) {
      if (fl.size > 5e6) throw Object.assign(new Error("That image is over 5 MB. Use a smaller screenshot."), { user: true });
      S.newImgs = [await readDataUrl(fl)];
      S.status = "";
    } else {
      if (fl.size > 200e3) throw Object.assign(new Error("That file is over 200 KB. Paste the relevant section instead."), { user: true });
      S.newFileText = await readText(fl);
      S.status = "";
    }
  } catch (e) {
    S.newFileName = null; S.newImgs = null; S.newFileText = null; S.newFile = null;
    S.status = e && e.user ? e.message
      : e && e.name === "PasswordException" ? _t("This PDF is password-protected. Remove the password and try again, or paste the text instead.")
      : isPdf ? _t("This PDF couldn't be read. Check your internet connection, or paste the text instead.") : _t("That file couldn't be read.");
    S.statusErr = true;
  }
  render();
}

function teamView() {
  const t = S.team;
  const m = h("main", { class: "wrap" }, h("button", { class: "back", onclick: goHome }, _t("← All reviews")), h("h1", null, _t("Team")));
  if (!t) { m.append(h("p", { class: "muted" }, _t("Loading…"))); return m; }
  if (t.error) { m.append(h("p", { class: "status err" }, t.error)); return m; }
  m.append(h("p", { class: "lede" }, t.company));
  if (t.inviteCode) m.append(h("section", { class: "panel" },
    h("h3", null, _t("Invite colleagues")),
    h("p", { class: "muted small" }, _t("Colleagues create an account on this site and enter this code to join your team as members.")),
    h("div", { class: "row actions" }, h("code", { class: "code" }, t.inviteCode),
      h("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(t.inviteCode) }, _t("Copy")),
      h("button", { class: "btn link", onclick: async () => { if (confirm(_t("Make a new code? The old one stops working."))) { try { t.inviteCode = (await api("POST", "/api/team/code")).inviteCode; render(); } catch (e) { alert(e.message); } } } }, _t("Make a new code")))));
  const roleNote = { admin: "Admin: everything, plus team and deleting reviews", member: "Member: create and edit reviews", viewer: "Viewer: read only" };
  m.append(h("h2", null, _t("Members")), h("div", { class: "members" }, t.members.map(u => h("div", { class: "member" },
    h("div", null, h("b", null, u.name, u.id === S.me.id ? _t(" (you)") : ""), h("div", { class: "muted small" }, [u.email, (S.audiences.find(a => a.id === u.position) || {}).label].filter(Boolean).join(" · "))),
    isAdmin() && u.id !== S.me.id
      ? h("div", { class: "row actions" },
        h("select", { "aria-label": _t("Role"), onchange: async e => { try { await api("POST", "/api/team/role", { userId: u.id, role: e.target.value }); u.role = e.target.value; } catch (er) { alert(er.message); } } },
          ["admin", "member", "viewer"].map(r => h("option", { value: r, selected: u.role === r }, r[0].toUpperCase() + r.slice(1)))),
        h("button", { class: "btn link red", onclick: async () => { if (confirm(_t("Remove {0} from the team?", [u.name]))) { try { await api("POST", "/api/team/remove", { userId: u.id }); t.members = t.members.filter(x => x.id !== u.id); render(); } catch (er) { alert(er.message); } } } }, _t("Remove")))
      : h("span", { class: "muted small" }, roleNote[u.role] || u.role)))));
  return m;
}

function billingView() {
  const b = S.bill;
  const m = h("main", { class: "wrap" }, h("button", { class: "back", onclick: goHome }, _t("← All reviews")), h("h1", null, _t("Billing")));
  if (S.flash) m.append(h("p", { class: "note" }, S.flash, " ", h("button", { class: "btn link", onclick: () => { S.flash = ""; render(); } }, _t("Dismiss"))));
  if (!b) { m.append(h("p", { class: "muted" }, _t("Loading…"))); return m; }
  if (b.error) { m.append(h("p", { class: "status err" }, b.error)); return m; }
  if (!b.enabled) { m.append(h("p", { class: "lede" }, _t("Billing is switched off on this site, so reviews are unlimited."))); return m; }
  const sym = b.symbol || "£";
  const sub = b.subscription;
  const fmt = t => new Date(t).toLocaleDateString(uiLocale(), { day: "numeric", month: "short", year: "numeric" });
  m.append(h("p", { class: "lede" }, _t("Pay as you go. One credit creates one new process review. There are no subscriptions or monthly commitments.")));
  m.append(h("section", { class: "balance" },
    h("div", { class: "bal" }, h("div", { class: "k" }, _t("Review credits")), h("div", { class: "v" }, b.credits), h("div", { class: "s" }, _t("Credits don't expire while your account is in use"))),
    b.freeReview ? h("div", { class: "bal" }, h("div", { class: "k" }, _t("Free first review")), h("div", { class: "v small2" }, b.freeReview.eligible ? (b.freeReviewUsed ? _t("Used") : _t("Available")) : _t("Not included")),
      h("div", { class: "s" }, b.freeReview.eligible && !b.freeReviewUsed ? _t("Start your free review on the home page.") : _t("One free review per account."))) : null,
    sub && sub.active ? h("div", { class: "bal" }, h("div", { class: "k" }, _t("Existing subscription")), h("div", { class: "v small2" }, sub.label),
      h("div", { class: "s" }, _t("{0} of {1} reviews left this month · {2} {3}. Honoured until you cancel it.", [Math.max(0, sub.monthly - sub.used), sub.monthly, sub.cancelAtEnd ? _t("ends") : _t("renews"), fmt(sub.periodEnd)]))) : null));
  m.append(h("section", { class: "panel" }, h("h3", null, _t("What a credit includes")),
    h("ul", { class: "incl" },
      h("li", null, _t("One new process review: steps, risks, actions, scorecard, SWOT and recommendations")),
      h("li", null, _t("Unlimited editing, notes, action tracking, sign-off and PDF and Word downloads")),
      h("li", null, _t("All the AI work a review needs is included: analyses, re-analyses, audience versions and refreshes")),
      h("li", null, _t("Editing, notes, action tracking, sign-off and downloads are always unlimited")),
      h("li", null, _t("Versions tailored to your CEO, CFO, COO and other readers, at no extra cost")))));
  if (b.hasPortal && b.isAdmin) m.append(h("p", null, h("button", { class: "btn", onclick: e => openPortal(e.currentTarget) }, sub && sub.active ? _t("Manage subscription, invoices and payment details") : _t("Invoices and payment details"))));
  if (!b.isAdmin) m.append(h("p", { class: "note" }, _t("Only your company's admins can buy credits.")));
  const card = p => h("div", { class: "plan" + (p.id === "pack10" ? " best" : "") },
    p.id === "pack10" ? h("span", { class: "tag" }, _t("Best value")) : null,
    h("h3", null, p.label),
    h("div", { class: "price" }, sym + p.price.toLocaleString(uiLocale())),
    h("p", { class: "muted small" }, (p.credits === 1 ? _t("One new process review.") : _t("{0} new process reviews, {1}{2} each.", [p.credits, sym, (p.price / p.credits).toFixed(2).replace(/\.00$/, "")]))),
    b.isAdmin ? h("button", { class: "btn primary", disabled: !p.available, onclick: e => startCheckout(p.id, e.currentTarget) }, !p.available ? _t("Not available yet") : _t("Buy")) : null);
  m.append(h("h2", null, _t("Buy review credits")), h("div", { class: "plans" }, b.plans.filter(p => p.kind === "pack").map(card)));
  m.append(h("p", { class: "muted small" }, _t("One-off payments, processed securely by Stripe. Card details never reach this site. Prices exclude VAT where applicable.")));
  if (b.payments.length) m.append(h("h2", null, _t("Payment history")), h("div", { class: "members" }, b.payments.map(p => h("div", { class: "member" },
    h("div", null, h("b", null, p.description), h("div", { class: "muted small" }, fmt(p.at))),
    h("span", null, p.amount != null ? `${p.currency === "GBP" ? "£" : p.currency === "EUR" ? "€" : p.currency === "USD" ? "$" : p.currency + " "}${(p.amount / 100).toFixed(2)}` : "", p.credits ? _t(" · +{0} credit{1}", [p.credits, _pl(p.credits === 1 ? "" : "s")]) : "")))));
  return m;
}
function review() {
  if (!S.R) return h("main", { class: "wrap" }, h("button", { class: "back", onclick: goHome }, _t("← All reviews")),
    h("p", { class: S.status ? "status err" : "muted" }, S.status || _t("Loading review…")));
  const { analysis: A, meta } = S.R;
  const tabs = S.edit ? editTabs(A) : viewTabs(A);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
  const m = h("main", { class: "wrap" },
    h("button", { class: "back", onclick: goHome }, _t("← All reviews")),
    S.flash ? h("p", { class: "note warnbox" }, S.flash, " ", h("button", { class: "btn link", onclick: () => { S.flash = ""; render(); } }, _t("Dismiss"))) : null,
    h("div", { class: "rhead" },
      h("div", null,
        h("div", { class: "rtop" }, statusBadge(meta),
          S.R.inputs.lang && S.R.inputs.lang !== "en" ? h("span", { class: "badge lang" }, langOf(S.R.inputs.lang)[1].split(" (")[0]) : null,
          h("span", { class: "muted small" }, _t("Version {0} · updated {1} by {2}", [meta.version || 1, when(meta.updatedAt), name(meta.updatedBy)]))),
        h("h1", { class: "rtitle" }, A.processName || meta.title),
        A.processScope ? h("p", { class: "muted" }, A.processScope) : null),
      S.edit ? h("div", { class: "tools" },
          h("button", { class: "btn primary", disabled: !!S.edit.saving, onclick: saveEdit }, S.edit.saving ? _t("Saving…") : _t("Save changes")),
          h("button", { class: "btn", onclick: cancelEdit }, S.confirmCancel ? _t("Discard my changes?") : _t("Cancel")))
      : h("div", { class: "tools" },
        canWrite() && S.R.workflow.stage === "complete" ? h("button", { class: "btn primary", disabled: S.busy, onclick: () => { S.rerunOpen = !S.rerunOpen; render(); } }, _t("Re-analyse with team input")) : null,
        canWrite() ? h("button", { class: "btn", onclick: startEdit }, _t("Edit text")) : null,
        h("button", { class: "btn", onclick: e => exportPdf(e.currentTarget) }, _t("Download PDF")),
        h("button", { class: "btn", onclick: e => exportWord(e.currentTarget) }, _t("Download Word")))),
    !canWrite() ? h("p", { class: "note" }, _t("You have view-only access to this review.")) : null,
    S.rerunOpen ? rerunPanel() : null,
    S.status ? h("p", { class: "status" + (S.statusErr ? " err" : ""), role: "status" }, S.status) : null,
    S.needsPay && S.view === "review" ? h("button", { class: "btn primary", onclick: () => goBilling() }, _t("Go to Billing")) : null,
    S.edit ? null : journeyBar(),
    S.edit ? null : stagePanel(),
    h("div", { class: "starter" }, h("b", null, _t("Discussion starter. ")), _t("Go through each step with the people who run this process. Adjust ratings, add notes where the analysis is wrong or incomplete, then re-analyse with the team's input and sign it off.")),
    !S.edit ? null : h("nav", { class: "tabs", role: "tablist" }, tabs.map(([k, l]) => h("button", { role: "tab", "aria-selected": S.tab === k ? "true" : "false", onclick: () => { S.tab = k; render(); } }, _t(l),
      k === "worksheet" && S.R.comments.length ? h("span", { class: "count" }, S.R.comments.length) : null))));
  if (S.edit) {
    m.append(h("p", { class: "note editbar" }, h("b", null, _t("Editing text. ")), _t("Change any wording, add or remove items, then press Save changes. Nothing is saved until you do. Edited items are kept when the review is re-analysed.")));
    if (S.tab === "summary") m.append(summaryEdit(S.edit.A));
    else if (S.tab === "flow") m.append(flowEdit(S.edit.A));
    else if (S.tab === "sipoc") m.append(sipocEdit(S.edit.A));
    else if (S.tab === "raci") m.append(raciEdit(S.edit.A));
    else m.append(worksheetEdit(S.edit.A));
    return m;
  }
  m.append(stageTools(A) || "");
  if (S.tab === "process") m.append(processTab());
  if (S.tab === "steps") m.append(stepsTab(A));
  if (S.tab === "sipoc") m.append(sipocTab(A));
  if (S.tab === "swot") m.append(swotTab(A));
  if (S.tab === "raci") m.append(raciTab(A));
  if (S.tab === "summary") m.append(summaryTab(A, meta));
  if (S.tab === "worksheet") m.append(worksheetTab(A));
  if (S.tab === "flow") m.append(flowTab(A));
  if (S.tab === "actions") m.append(actionsTab(A));
  if (S.tab === "activity") m.append(activityTab());
  if (!S.edit) { const pn = pageNav(A); if (pn) m.append(pn); }
  if (!S.edit && A.headline) m.append(signoffPanel(meta));
  if (isAdmin()) m.append(h("div", { class: "danger" }, h("button", { class: "btn link red", onclick: deleteReview }, _t("Delete this review"))));
  return m;
}

function rerunPanel() {
  const ta = h("textarea", { class: "short", placeholder: _t("Optional: anything the analysis should know, e.g. \"Finance now reviews twice a day\" or \"Step 3 has been automated\".") });
  const n = S.R.comments.length, general = S.R.comments.filter(c => c.fmId === "general").length;
  return h("section", { class: "panel rerun" },
    h("h3", null, _t("Re-analyse with the team's input")),
    h("p", { class: "muted small" }, _t("The AI will update the analysis using {0} note{1} ({2} general), the team's rating changes, and anything you add below. Ratings the team changed are kept; owners, due dates and statuses carry over; the changes are logged in Activity.", [n, _pl(n === 1 ? "" : "s"), general])),
    ta,
    h("div", { class: "row actions" },
      h("button", { class: "btn primary", disabled: S.busy, onclick: () => rerun(ta.value.trim()) }, S.busy ? _t("Re-analysing…") : _t("Run update")),
      S.busy ? h("button", { class: "btn", onclick: () => S.ctl && S.ctl.abort() }, _t("Stop waiting")) : h("button", { class: "btn", onclick: () => { S.rerunOpen = false; render(); } }, _t("Cancel"))));
}
function kpi(k, v, s, cls) { return h("div", { class: "kpi " + (cls || "") }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), s ? h("div", { class: "s" }, s) : null); }
function srcTag(k) { return h("span", { class: "src " + (k === "you" ? "stated" : k === "team" ? "user" : "ai") }, RL(k === "you" ? "srcYou" : k === "team" ? "srcTeam" : "srcAI")); }
function riskChip(r) { return h("span", { class: "lchip r" + r.ap, title: RL("problemAt", { n: r.stepNo, name: r.step }) }, h("span", { class: "ap " + r.ap }, apT(r.ap)), " ", r.mode, " ", h("small", null, "(" + r.score + ")")); }
function execBlock(A, ins, cur) {
  const ex = A.executive;
  if (!ex) return null;
  const probs = (ins && ins.problems) || ex.problems || [];
  return h("section", { class: "exec" },
    h("h2", null, RL("execTitle")),
    probs.length ? h("div", null, h("h3", null, RL("bigProblems")), h("ol", { class: "probs" }, probs.map(p => h("li", null,
      h("b", null, p.title), p.basis ? h("span", { class: "basis " + p.basis }, RL("basis_" + p.basis)) : null, p.evidence ? h("p", null, p.evidence) : null,
      h("div", { class: "links" }, (p.steps || []).map(st => h("span", { class: "lchip" }, RL("problemAt", { n: st.no, name: st.name }))), (p.risks || []).map(riskChip)))))) : null,
    (A.issueCheck || []).length ? h("div", { class: "issuecheck" }, h("h3", null, RL("issueCheckTitle")), h("ul", null, A.issueCheck.map(x =>
      h("li", null, h("b", null, x.issue), " ", h("span", { class: "basis " + (x.assessment === "supported" ? "evidence" : x.assessment === "not supported" ? "inferred" : "reported") }, RL("ic_" + x.assessment.replace(" ", "_"))),
        x.note ? h("div", { class: "muted small" }, x.note) : null,
        x.likelyCause ? h("p", { class: "icrow" }, h("b", null, RL("icCause") + ": "), x.likelyCause) : null,
        x.answer ? h("p", { class: "icrow answer" }, h("b", null, RL("icAnswer") + ": "), x.answer,
          (x.moves || []).length ? h("span", { class: "muted small" }, "  (" + RL(x.moves.length > 1 ? "icMovesN" : "icMoves", { n: x.moves.join(", ") }) + ")") : null) : null)))) : null,
    ex.exposure && (ex.exposure.summary || (ex.exposure.items || []).length) ? h("div", { class: "expo" }, h("h3", null, RL("exposure")),
      ins && ins.cost && ins.cost.total != null ? h("p", { class: "big" }, money(ins.cost.total, cur), h("span", { class: "muted small" }, " " + RL("cYear").toLowerCase() + " ", h("span", { class: "src calc" }, RL("srcCalc")))) : null,
      ex.exposure.summary ? h("p", null, ex.exposure.summary) : null, h("ul", null, (ex.exposure.items || []).map(x => h("li", null, x)))) : null,
    ex.firstAction && ex.firstAction.title ? h("div", { class: "first" }, h("h3", null, RL("firstAction")), h("p", { class: "fa" }, ex.firstAction.title),
      ex.firstAction.why ? h("p", null, ex.firstAction.why) : null,
      h("p", { class: "muted small" }, RL("ownerWithin", { x: ex.firstAction.owner || RL("unassigned"), t: ex.firstAction.within || "" }))) : null,
    (ex.targets || []).length ? h("div", null, h("h3", null, RL("targets")), h("div", { class: "tablewrap" }, h("table", { class: "flowtable" },
      h("thead", null, h("tr", null, ["tMetric", "tNow", "tTarget", "tBy", "tHow"].map(k => h("th", null, RL(k))))),
      h("tbody", null, ex.targets.map(t => h("tr", null, h("td", null, h("b", null, t.metric)), h("td", null, t.now), h("td", null, h("b", null, t.target)), h("td", null, t.by), h("td", null, t.measure))))))) : null);
}
function planBlock(A, ins) {
  const moves = A.moves || [];
  if (!moves.length) return null;
  const links = (ins && ins.moves) || [];
  const inp = (S.R && S.R.inputs) || {}, cur = inp.cur || "GBP";
  const runsPerMonth = parseFloat(inp.runs) || 0, ratePerHour = parseFloat(inp.rate) || 0;
  const cov = ins && ins.coverage;
  const allFm = allFms(A), linked = new Set(links.flatMap(l => l.risks.map(r => r.id)));
  const unc = allFm.filter(x => x.f.ap === "H" && !linked.has(x.f.id)).map(x => x.f.mode);
  return h("section", null, h("h2", null, RL("planTitle")),
    cov && cov.highRisks ? h("p", { class: "muted small" }, RL("coverageNote", { n: cov.highRisksWithAction, total: cov.highRisks }),
      unc.length ? " " + RL("uncovered", { x: unc.slice(0, 4).join("; ") }) : "") : null,
    cov && cov.actions ? h("p", { class: "muted small" }, RL("coverageActions", { n: cov.actionsCovered, total: cov.actions })) : null,
    h("ol", { class: "moves" }, moves.map((x, i) => {
      const l = links[i] || { risks: [], waits: [] };
      const waitTxt = l.waitNow != null && l.waitSaved != null ? RL("waitSaved", { saved: fmtMinutes(l.waitSaved), now: fmtMinutes(l.waitNow), p: Math.round(l.waitReductionPct) })
        : (l.waits || []).length ? l.waits.map(w => RL("waitAt", { n: w.no, t: w.waitMinutes == null ? "?" : fmtMinutes(w.waitMinutes) })).join(", ") : "";
      const calcSaving = l.waitSaved > 0 && runsPerMonth > 0 && ratePerHour > 0 ? l.waitSaved / 60 * ratePerHour * runsPerMonth * 12 : null;
      const estSaving = calcSaving == null && x.savingPerYear > 0 ? x.savingPerYear : null;
      return h("li", { class: "move" }, h("h3", null, x.title), h("p", null, x.detail),
        x.benefit ? h("p", { class: "benefit" }, x.benefit) : null,
        calcSaving != null ? h("div", { class: "links" }, h("span", { class: "lk" }, _t("Saving:")), h("span", { class: "lchip w" }, _t("Up to {0} per year", [money(calcSaving, cur)])), " ",
          h("span", { class: "src calc", title: _t("Calculated from the waiting time the move removes, how often the process runs and the loaded cost per staff hour.") }, RL("srcCalc"))) : null,
        estSaving != null ? h("div", { class: "links" }, h("span", { class: "lk" }, _t("Saving:")), h("span", { class: "lchip w" }, _t("About {0} per year", [money(estSaving, cur)])), " ",
          h("span", { class: "src ai", title: _t("Estimated from the process description; check it with the team.") }, RL("srcAI"))) : null,
        l.risks.length ? h("div", { class: "links" }, h("span", { class: "lk" }, RL("linksRisk") + ":"), l.risks.map(riskChip)) : null,
        waitTxt ? h("div", { class: "links" }, h("span", { class: "lk" }, RL("linksWait") + ":"), h("span", { class: "lchip w" }, waitTxt), " ",
          l.waitSaved != null ? h("span", { class: "src calc", title: _t("Calculated from your process efficiency timings and the estimated reduction") }, RL("srcCalc")) : null) : null,
        l.measure ? h("div", { class: "links" }, h("span", { class: "lk" }, RL("linksMeasure") + ":"), h("span", null, l.measure)) : null,
        l.risks.some(r => r.action) ? h("details", { class: "covered" }, h("summary", null, RL("coveredActions") + " (" + RL("resActions", { n: l.result ? l.result.actionsDone : 0, total: l.risks.filter(r => r.action).length }) + ")"),
          h("ul", null, l.risks.filter(r => r.action).map(r => h("li", null, h("span", { class: "st st-" + r.status }, STAT(r.status)), " ", r.action, " ",
            h("span", { class: "muted small" }, (r.owner ? r.owner + " \u00b7 " : "") + RL("problemAt", { n: r.stepNo, name: r.step })),
            r.status === "done" && r.baseScore != null && r.score === r.baseScore ? h("div", { class: "warnline small" }, RL("notReRated")) : null)))) : null,
        l.result && l.result.riskBefore != null && (l.result.riskBefore !== l.result.riskNow || l.result.actionsDone) ? h("div", { class: "links" }, h("span", { class: "lk" }, RL("resultsSoFar") + ":"),
          h("span", { class: "lchip" }, RL("resRisk", { a: l.result.riskBefore, b: l.result.riskNow })),
          l.result.waitBefore != null && l.result.waitNowMeasured != null ? h("span", { class: "lchip" }, RL("resWait", { a: fmtMinutes(l.result.waitBefore), b: fmtMinutes(l.result.waitNowMeasured) })) : null) : null,
        h("div", { class: "meta" }, h("span", { class: "pill" }, RL("ownerIs", { x: x.owner || RL("unassigned") })), h("span", { class: "pill" }, tfT(x.timeframe)),
          h("span", { class: "pill" }, RL("impactIs", { x: lvT(x.impact) })), h("span", { class: "pill" }, RL("effortIs", { x: lvT(x.effort) }))));
    })));
}
function costBlock(A, ins, cur) {
  const c = ins && ins.cost;
  if (!c || !c.rows.length) return (A.impact || {}).basis ? h("section", null, h("h2", null, RL("costTitle")), h("p", null, A.impact.basis)) : null;
  const num = (v, unit) => (v == null ? "?" : (unit === "money" ? money(v, cur) : String(Math.round(v * 10) / 10)));
  return h("section", null, h("h2", null, RL("costTitle")), h("p", { class: "muted small" }, RL("costIntro")),
    h("div", { class: "tablewrap" }, h("table", { class: "flowtable cost" },
      h("thead", null, h("tr", null, ["cItem", "cVol", "cMin", "cRate", "cExtra", "cYear"].map(k => h("th", null, RL(k))))),
      h("tbody", null, c.rows.map(r => h("tr", null,
        h("td", null, h("b", null, r.label), r.basis ? h("div", { class: "muted small" }, r.basis) : null),
        h("td", null, num(r.volumePerMonth), h("div", null, srcTag(r.src.volume))),
        h("td", null, num(r.minutesPerItem), h("div", null, srcTag(r.src.minutes))),
        h("td", null, num(r.hourlyRate, "money"), h("div", null, srcTag(r.src.rate))),
        h("td", null, r.extraCostPerMonth ? money(r.extraCostPerMonth, cur) : "\u2013"),
        h("td", null, h("b", null, money(r.annual, cur)))))),
      h("tfoot", null, h("tr", null, h("td", { colspan: "5" }, h("b", null, RL("cTotal")), " ", h("span", { class: "muted small" }, RL("cHours", { n: Math.round(c.hoursPerMonth || 0) }))),
        h("td", null, h("b", null, money(c.total, cur)), " ", h("span", { class: "src calc" }, RL("srcCalc"))))))));
}
function healthBlock(ins) {
  const hs = ins && ins.health; if (!hs) return null;
  return h("details", { class: "healthx", open: true }, h("summary", null, RL("healthTitle"), " ", h("span", { class: "src calc" }, RL("srcCalc"))),
    h("p", { class: "muted small" }, RL("healthIntro")),
    h("div", { class: "tablewrap" }, h("table", { class: "flowtable" },
      h("thead", null, h("tr", null, ["hDim", "hRating", "hWeight", "hPoints"].map(k => h("th", null, RL(k))))),
      h("tbody", null, hs.rows.map(r => h("tr", null, h("td", null, r.name), h("td", null, r.score + "/10"), h("td", null, r.weight + "%"), h("td", null, `${r.score} \u00d7 10 \u00d7 ${r.weight}% = ${r.points}`)))),
      h("tfoot", null, h("tr", null, h("td", { colspan: "3" }, h("b", null, RL("healthTotal"))), h("td", null, h("b", null, hs.total + "/100")))))),
    hs.equalWeights ? h("p", { class: "muted small" }, RL("equalWeights")) : null,
    h("p", null, h("b", null, RL("healthIs", { n: hs.total, band: RL("band_" + hs.band).replace(/^[0-9-]+ /, "") }))),
    h("ul", { class: "bands" }, ["strong", "sound", "attention", "atrisk"].map(b => h("li", { class: b === hs.band ? "on" : "" }, RL("band_" + b)))),
    h("p", { class: "small" }, RL("weakest", { name: hs.weakest.name, s: hs.weakest.score })),
    h("p", { class: "muted small" }, RL("healthCaveat")));
}
function resultsBlock(ins) {
  const r = ins && ins.results; if (!r || r.riskBefore == null) return null;
  const pct = (a, b) => (a ? Math.round(100 * (b - a) / a) : 0);
  const cmp = (a, b, fmt) => (a == null || b == null ? "?" : a === b ? `${fmt(a)} (${RL("resNoChange")})` : `${fmt(a)} \u2192 ${fmt(b)} (${pct(a, b) > 0 ? "+" : ""}${pct(a, b)}%)`);
  const since = r.since ? new Date(r.since * 1000).toLocaleDateString(uiLocale(), { day: "numeric", month: "short", year: "numeric" }) : "";
  return h("section", { class: "results" }, h("h2", null, RL("resultsTitle"), " ", h("span", { class: "src calc" }, RL("srcCalc"))),
    h("p", { class: "muted small" }, RL("resultsIntro", { since: since ? " (" + since + ")" : "" })),
    h("div", { class: "kpis" },
      kpi(RL("resActionsDone"), RL("nOfM", { n: r.actionsDone, total: r.actions }), "", "c3"),
      kpi(RL("resTotalRisk"), r.riskBefore === r.riskNow ? String(r.riskNow) : `${r.riskBefore} \u2192 ${r.riskNow}`, r.riskBefore === r.riskNow ? RL("resNoChange") : `${pct(r.riskBefore, r.riskNow)}%`, "c2"),
      kpi(RL("resHigh"), r.highBefore === r.highNow ? String(r.highNow) : `${r.highBefore} \u2192 ${r.highNow}`, "", "c1"),
      kpi(RL("resLead"), r.leadBefore == null ? "?" : r.leadBefore === r.leadNow ? fmtMinutes(r.leadNow) : `${fmtMinutes(r.leadBefore)} \u2192 ${fmtMinutes(r.leadNow)}`, "", "c4")),
    (r.doneButNotReRated || []).length ? h("div", { class: "note" }, h("b", null, RL("notReRated")), h("ul", null, r.doneButNotReRated.map(x => h("li", null, `${x.action} (${RL("problemAt", { n: x.stepNo, name: x.step })})`)))) : null);
}
function summaryTab(A, meta) {
  const fms = allFms(A), cur = S.R.inputs.cur || "GBP", imp = A.impact || {}, ins = S.R.insights;
  const acts = fms.filter(x => hasAction(x.f)), done = acts.filter(x => x.f.status === "done").length;
  const order = { H: 0, M: 1, L: 2 };
  const top = fms.slice().sort((a, b) => order[a.f.ap] - order[b.f.ap] || rpn(b.f) - rpn(a.f)).slice(0, 5);
  const generalNotes = S.R.comments.filter(c => c.fmId === "general");
  const gta = h("textarea", { class: "short", placeholder: _t("Add a note about the whole process…") });
const costNow = ins && ins.cost && ins.cost.total != null ? ins.cost.total : imp.annualCost;
  const hoursNow = ins && ins.cost && ins.cost.hoursPerMonth != null ? ins.cost.hoursPerMonth : imp.hoursLostPerMonth;
  return h("div", null,
    S.lastChanges && S.lastChanges.length ? h("section", { class: "changes" }, h("h3", null, RL("changes")), h("ul", null, S.lastChanges.map(c => h("li", null, c)))) : null,
    h("div", { class: "kpis" },
      kpi(RL("kCost"), money(costNow, cur), hoursNow ? RL("sHours", { n: Math.round(hoursNow) }) : "", "c1"),
      kpi(RL("kHigh"), RL("nOfM", { n: fms.filter(x => x.f.ap === "H").length, total: fms.length }), RL("sRisks"), "c2"),
      kpi(RL("kActions"), RL("nOfM", { n: done, total: acts.length }), acts.length ? RL("sComplete", { p: Math.round(100 * done / acts.length) }) : "", "c3"),
      kpi(RL("kHealth"), `${ins && ins.health ? ins.health.total : Math.round(A.overallScore || 0)}/100`, imp.cycleTimeNow ? RL("sCycle", { t: imp.cycleTimeNow }) : "", "c4")),
    h("p", { class: "headline" }, A.headline || ""),
    A.executive ? execBlock(A, ins, cur) : h("ol", { class: "findings" }, (A.keyFindings || []).map(x => h("li", null, x))),
    planBlock(A, ins),
    ins && (ins.uncoveredActions || []).length ? h("details", { class: "covered" }, h("summary", null, RL("uncoveredTitle") + " (" + ins.uncoveredActions.length + ")"),
      h("p", { class: "muted small" }, RL("uncoveredNote")),
      h("ul", null, ins.uncoveredActions.map(r => h("li", null, h("span", { class: "st st-" + r.status }, STAT(r.status)), " ", r.action, " ", h("span", { class: "muted small" }, RL("problemAt", { n: r.stepNo, name: r.step })))))) : null,
    resultsBlock(ins),
    costBlock(A, ins, cur),
    h("h2", null, RL("glance")),
    h("p", { class: "muted small" }, RL("screenGlanceNote")),
    processFlow(A),
    h("h2", null, RL("topRisks")),
    h("ol", { class: "toprisks" }, top.map(({ s, si, f }) => h("li", { class: "risk" },
      h("div", { class: "rpn" }, h("b", null, rpn(f)), h("small", null, RL("hScore"))),
      h("div", null, h("div", { class: "t" }, h("span", { class: "ap " + f.ap }, apT(f.ap)), " ", f.mode),
        h("div", { class: "muted small" }, RL("stepOf", { n: si + 1, name: s.name }) + " " + (f.effects || "")))))),
    h("h2", null, RL("riskMap")),
    h("p", { class: "muted small" }, RL("screenMapNote")),
    riskMap(fms),
    h("details", { class: "limits" },
      h("summary", null, RL("limitsTitle")),
      h("p", null, RL("limitsText")),
      (A.assumptions || []).length ? h("div", null, h("b", null, RL("assumed")), h("ul", null, A.assumptions.map(a => h("li", null, a)))) : null),
    (A.dimensions || []).length ? h("div", null, h("h2", null, RL("scorecard")), h("div", { class: "dims" }, A.dimensions.map(d => {
      const v = Math.max(0, Math.min(10, Number(d.score) || 0));
      return h("div", { class: "dim" }, h("span", { class: "n" }, d.name), h("div", { class: "bar" }, h("i", { style: `width:${v * 10}%;background:${v >= 7 ? "var(--good)" : v >= 5 ? "var(--warn)" : "var(--bad)"}` })), h("span", { class: "v" }, v), h("span", { class: "note2" }, d.note || ""));
    })), healthBlock(ins)) : null,
    h("h2", null, RL("generalNotes")),
    h("div", { class: "notes" }, generalNotes.length ? generalNotes.map(noteItem) : h("p", { class: "muted small" }, RL("noGeneralNotes")),
      canWrite() ? h("div", { class: "addnote" }, gta, h("button", { class: "btn", onclick: () => addNote("general", gta) }, _t("Add note"))) : null));
}
function swotBlock(A) {
  const w = A.swot;
  if (!w) return h("div", { class: "panel" },
    h("p", { class: "muted" }, _t("This review was created before SWOT analyses were added.")),
    canWrite() ? h("button", { class: "btn", disabled: !!S.swotBusy, onclick: makeSwot }, S.swotBusy ? _t("Writing the SWOT…") : _t("Add a SWOT analysis")) : null);
  const q = (k, title, sub) => h("div", { class: "sq " + k }, h("h3", null, _t(title)), h("p", { class: "sqsub" }, _t(sub)),
    h("ul", null, (w[k] || []).map(x => h("li", null, x))));
  return h("div", null,
    h("div", { class: "swot" },
      q("strengths", RL("strengths"), RL("swotS")), q("weaknesses", RL("weaknesses"), RL("swotW")),
      q("opportunities", RL("opportunities"), RL("swotO")), q("threats", RL("threats"), RL("swotT"))),
    canWrite() ? h("p", { class: "small" }, h("button", { class: "btn link", disabled: !!S.swotBusy, onclick: makeSwot }, S.swotBusy ? _t("Refreshing…") : _t("Refresh the SWOT with the team's notes"))) : null);
}
async function makeSwot() {
  await flushNow();
  S.swotBusy = true; render();
  try { setReview(await api("POST", `/api/reviews/${S.R.meta.id}/swot`)); }
  catch (e) { notifyOrAlert(e.message); }
  S.swotBusy = false; render();
}
function notifyOrAlert(m) { if (typeof notify === "function") notify(m); else alert(m); }
/* ---------- text editing ---------- */
function startEdit() {
  S.edit = { A: JSON.parse(JSON.stringify(S.R.analysis)), orig: JSON.stringify(S.R.analysis), dirty: false, saving: false };
  if (!S.edit.A.swot) S.edit.A.swot = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  ["keyFindings", "assumptions", "questions", "moves", "dimensions"].forEach(k => { S.edit.A[k] = S.edit.A[k] || []; });
  S.edit.A.impact = S.edit.A.impact || {};
  S.rerunOpen = false; S.confirmCancel = false;
  if (!editTabs(S.edit.A).some(t => t[0] === S.tab)) S.tab = editTabs(S.edit.A)[0][0];
  S.edit.A.sipoc = S.edit.A.sipoc || { suppliers: [], inputs: [], outputs: [], customers: [] };
  ["suppliers", "inputs", "outputs", "customers"].forEach(k => { S.edit.A.sipoc[k] = S.edit.A.sipoc[k] || []; });
  S.edit.A.steps.forEach(st => { st.suppliers = st.suppliers || []; st.customers = st.customers || []; });
  S.edit.A.steps.forEach(st => { st.flow = st.flow || {}; });
  render(); window.scrollTo(0, 0);
}
function cancelEdit() {
  if (S.edit && S.edit.dirty && !S.confirmCancel) { S.confirmCancel = true; render(); return; }
  S.edit = null; S.confirmCancel = false; S.flash = "";
  if (!tabOpen(S.tab, S.R.analysis) || (S.tab === "worksheet" && S.R.workflow.stage === "steps")) {
    const st = S.R.workflow.stage; S.tab = st === "complete" ? "summary" : (JOURNEY.find(j => j[2] === st) || ["summary"])[0];
  }
  render();
}
function editSummary(o, n) {
  const out = [];
  const ch = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  [["processName", "process name"], ["processScope", "scope"], ["headline", "headline"], ["keyFindings", "key findings"], ["assumptions", "assumptions"],
   ["impact", "cost and time figures"], ["overallScore", "health score"], ["moves", "recommended moves"], ["swot", "SWOT analysis"],
   ["dimensions", "scorecard"], ["questions", "questions"]].forEach(([k, l]) => { if (ch(o[k], n[k])) out.push("edited the " + l); });
  const spn = sp => JSON.stringify(sipocNorm(sp || {}));
  if (spn(o.sipoc) !== spn(n.sipoc)) out.push("edited the SIPOC of the whole process");
  if (ch(o.raci || null, n.raci || null)) out.push("edited the RACI matrix");
  const ids = a => (a.steps || []).map(s => s.id).filter(Boolean).join(",");
  if ((o.steps || []).length === (n.steps || []).length && ids(o) !== ids(n)) out.push("reordered the steps");
  const os = o.steps || [], ns = n.steps || [];
  if (ns.length > os.length) out.push(`added ${ns.length - os.length} step${ns.length - os.length > 1 ? "s" : ""}`);
  if (ns.length < os.length) out.push(`removed ${os.length - ns.length} step${os.length - ns.length > 1 ? "s" : ""}`);
  const strip = s => JSON.stringify({ ...s, failureModes: undefined, textEdited: undefined, flow: undefined, suppliers: (s.suppliers || []), customers: (s.customers || []) });
  const oFlow = {}; os.forEach(s => { oFlow[s.id] = JSON.stringify(cleanFlow(s.flow)); });
  const flowChanged = ns.filter(s => s.id && oFlow[s.id] !== undefined && oFlow[s.id] !== JSON.stringify(cleanFlow(s.flow))).length;
  if (flowChanged) out.push(`edited timings for ${flowChanged} step${flowChanged > 1 ? "s" : ""}`);
  const oNames = os.map(strip), changedSteps = ns.filter(s => !oNames.includes(strip(s))).length;
  if (changedSteps && ns.length === os.length) out.push(`edited ${changedSteps} step${changedSteps > 1 ? "s" : ""}`);
  const of = {}; os.forEach(s => s.failureModes.forEach(f => { of[f.id] = f; }));
  let add = 0, edit = 0; const seen = new Set();
  ns.forEach(s => s.failureModes.forEach(f => { const x = of[f.id]; if (!x) add++; else { seen.add(f.id); if (ch({ ...x, textEdited: 0 }, { ...f, textEdited: 0 })) edit++; } }));
  const del = Object.keys(of).filter(id => !seen.has(id)).length;
  if (add) out.push(`added ${add} risk${add > 1 ? "s" : ""}`);
  if (del) out.push(`removed ${del} risk${del > 1 ? "s" : ""}`);
  if (edit) out.push(`edited ${edit} risk${edit > 1 ? "s" : ""}`);
  return out.map(x => x[0].toUpperCase() + x.slice(1));
}
async function saveEdit() {
  if (!S.edit) return;
  const log = editSummary(JSON.parse(S.edit.orig), S.edit.A);
  if (!log.length) { S.edit = null; render(); return; }
  await flushNow();
  S.edit.saving = true; render();
  try {
    setReview(await api("PUT", `/api/reviews/${S.R.meta.id}/content`, { analysis: S.edit.A, rev: S.R.meta.rev, log }));
    S.edit = null; S.flash = ""; S.saveState = _t("All changes saved");
    if (!tabOpen(S.tab, S.R.analysis) || (S.tab === "worksheet" && S.R.workflow.stage === "steps")) {
      const st = S.R.workflow.stage; S.tab = st === "complete" ? "summary" : (JOURNEY.find(j => j[2] === st) || ["summary"])[0];
    }
  } catch (e) {
    S.edit.saving = false;
    if (e.status === 409 && e.data && e.data.review) {
      S.flash = _t("Someone else changed this review while you were editing. Your edits are still here: copy anything you need, then press Cancel to load their version and edit again.");
    } else S.flash = _t("Couldn't save: ") + e.message;
  }
  render();
}
const touch = () => { if (S.edit && !S.edit.dirty) { S.edit.dirty = true; } };
function eText(o, k, label, opts = {}) {
  const el = h(opts.multi ? "textarea" : "input", { class: "ed" + (opts.multi ? " short" : ""), type: opts.multi ? null : "text", placeholder: opts.ph || "",
    "aria-label": _t(label), oninput: e => { o[k] = e.target.value; touch(); if (opts.mark) opts.mark.textEdited = true; } });
  el.value = o[k] == null ? "" : o[k];
  return label && !opts.bare ? h("label", { class: "edl" + (opts.wide ? " wide" : "") }, _t(label), el) : el;
}
function eNum(o, k, label, ph) {
  const el = h("input", { class: "ed", type: "number", min: "0", inputmode: "decimal", placeholder: _t(ph) || "", "aria-label": _t(label),
    oninput: e => { o[k] = e.target.value === "" ? null : Number(e.target.value); touch(); } });
  el.value = o[k] == null ? "" : o[k];
  return h("label", { class: "edl" }, _t(label), el);
}
function eSel(o, k, label, options, after) {
  return h("label", { class: "edl" }, _t(label), h("select", { class: "ed", onchange: e => { o[k] = /^\d+$/.test(e.target.value) ? +e.target.value : e.target.value; touch(); if (after) after(); } },
    options.map(([v, t]) => h("option", { value: v, selected: String(o[k]) === String(v) }, t))));
}
function eList(arr, label, ph, mark) {
  return h("div", { class: "elist" }, h("div", { class: "elhead" }, _t(label)),
    arr.map((v, i) => h("div", { class: "elrow" },
      (() => { const t = h("textarea", { class: "ed short1", "aria-label": `${_t(label)} ${i + 1}`, oninput: e => { arr[i] = e.target.value; touch(); if (mark) mark.textEdited = true; } }); t.value = v; return t; })(),
      h("button", { class: "btn link red", "aria-label": _t("Remove"), onclick: () => { arr.splice(i, 1); touch(); if (mark) mark.textEdited = true; render(); } }, _t("Remove")))),
    h("button", { class: "btn link", onclick: () => { arr.push(""); touch(); render(); } }, _t("+ Add ") + (_t(ph) || _t("item"))));
}
const LEVELS = [["high", "High"], ["medium", "Medium"], ["low", "Low"]];
function summaryEdit(A) {
  const imp = A.impact;
  return h("div", { class: "editwrap" },
    h("section", { class: "panel" }, h("h3", null, _t("Overview")),
      eText(A, "processName", "Process name", { wide: true }), eText(A, "processScope", "Scope", { multi: true, wide: true }),
      eText(A, "headline", "Headline", { multi: true, wide: true }), eList(A.keyFindings, "Key findings", "finding")),
    h("section", { class: "panel" }, h("h3", null, _t("Cost and time figures")),
      h("p", { class: "muted small" }, _t("These are estimates for indication only. Update them if you have better numbers.")),
      h("div", { class: "edgrid" }, eNum(imp, "annualCost", "Avoidable cost per year"), eNum(imp, "hoursLostPerMonth", "Staff hours lost per month"),
        eText(imp, "cycleTimeNow", "Cycle time now"), eText(imp, "cycleTimeTarget", "Achievable cycle time"), eNum(A, "overallScore", "Process health (0-100)")),
      eText(imp, "basis", "How the cost was sized", { multi: true, wide: true }),
      eList(A.assumptions, "Assumptions", "assumption")),
    h("section", { class: "panel" }, h("h3", null, _t("Recommended moves")),
      A.moves.map((mv, i) => h("div", { class: "edcard" },
        h("div", { class: "edcardhead" }, h("b", null, _t("Move {0}", [i + 1])), h("span", null,
          i > 0 ? h("button", { class: "btn link", onclick: () => { [A.moves[i - 1], A.moves[i]] = [A.moves[i], A.moves[i - 1]]; touch(); render(); } }, _t("Move up")) : null,
          h("button", { class: "btn link red", onclick: () => { A.moves.splice(i, 1); touch(); render(); } }, _t("Remove")))),
        eText(mv, "title", "Title", { wide: true }), eText(mv, "detail", "Detail", { multi: true, wide: true }), eText(mv, "benefit", "Expected result", { multi: true, wide: true }),
        h("div", { class: "edgrid" }, eText(mv, "owner", "Owner"), eSel(mv, "timeframe", "Timeframe", [["30 days", "30 days"], ["90 days", "90 days"], ["6 months+", "6 months+"]]),
          eSel(mv, "impact", "Impact", LEVELS), eSel(mv, "effort", "Effort", LEVELS)))),
      h("button", { class: "btn", onclick: () => { A.moves.push({ title: "", detail: "", benefit: "", owner: "", timeframe: "90 days", impact: "medium", effort: "medium" }); touch(); render(); } }, _t("+ Add a move"))),
    h("section", { class: "panel" }, h("h3", null, _t("SWOT analysis")),
      h("div", { class: "swot" }, [["strengths", "Strengths"], ["weaknesses", "Weaknesses"], ["opportunities", "Opportunities"], ["threats", "Threats"]]
        .map(([k, l]) => h("div", { class: "sq " + k }, eList(A.swot[k] = A.swot[k] || [], l, l.toLowerCase().replace(/s$/, "")))))),
    h("section", { class: "panel" }, h("h3", null, _t("Scorecard")),
      A.dimensions.map(d => h("div", { class: "edgrid dimrow" }, eText(d, "name", "Area"), eSel(d, "score", "Score", Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)])), eText(d, "note", "Note", { wide: true })))),
    null);
}
function newRisk() { return { id: "new", mode: "", effects: "", severity: 5, occurrence: 5, detection: 5, ap: "M", causes: "", preventionControls: "", detectionControls: "", action: "", owner: "", status: "open", confidence: "medium", textEdited: true, edited: true }; }
function worksheetEdit(A) {
  const types = [["manual", "Manual"], ["automated", "Automated"], ["decision", "Decision"], ["handoff", "Handoff"], ["wait", "Waiting"]];
  const wrap = h("div", { class: "editwrap" });
  A.steps.forEach((st, si) => {
    const card = h("article", { class: "stepcard edcard" },
      h("div", { class: "edcardhead" }, h("b", null, _t("Step {0}", [si + 1])), h("span", null,
        si > 0 ? h("button", { class: "btn link", onclick: () => { [A.steps[si - 1], A.steps[si]] = [A.steps[si], A.steps[si - 1]]; touch(); render(); } }, _t("Move up")) : null,
        si < A.steps.length - 1 ? h("button", { class: "btn link", onclick: () => { [A.steps[si + 1], A.steps[si]] = [A.steps[si], A.steps[si + 1]]; touch(); render(); } }, _t("Move down")) : null,
        A.steps.length > 1 ? h("button", { class: "btn link red", onclick: () => { A.steps.splice(si, 1); touch(); render(); } }, _t("Delete step")) : null)),
      h("div", { class: "edgrid" }, eText(st, "name", "Step name", { mark: st }), eText(st, "actor", "Who does it", { mark: st }), eSel(st, "type", "Type", types, () => { st.textEdited = true; })),
      eText(st, "function", "Purpose", { multi: true, wide: true, mark: st }),
      h("div", { class: "edgrid two" }, eList(st.inputs, "Inputs", "input", st), eList(st.outputs, "Outputs", "output", st)));
    st.failureModes.forEach((f, fi) => {
      const sod = (k, l) => eSel(f, k, l, Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), () => { f.edited = true; f.ap = apFor(f); render(); });
      card.append(h("div", { class: "fm edfm" + (f.ap === "H" ? " hi" : f.ap === "M" ? " mid" : "") },
        h("div", { class: "edcardhead" }, h("b", null, _t("What can go wrong "), h("span", { class: "ap " + f.ap }, f.ap)),
          h("button", { class: "btn link red", onclick: () => { st.failureModes.splice(fi, 1); touch(); render(); } }, _t("Delete risk"))),
        eText(f, "mode", "Description", { multi: true, wide: true, mark: f }),
        h("div", { class: "edgrid" }, sod("severity", "Severity"), sod("occurrence", "Occurrence"), sod("detection", "Detection")),
        h("div", { class: "edgrid two" }, eText(f, "effects", "Effects", { multi: true, mark: f }), eText(f, "causes", "Causes", { multi: true, mark: f }),
          eText(f, "preventionControls", "Prevention controls", { multi: true, mark: f }), eText(f, "detectionControls", "Detection controls", { multi: true, mark: f })),
        h("div", { class: "edgrid two" }, eText(f, "action", "Recommended action", { multi: true, mark: f }),
          (() => { const el = eText(f, "owner", "Owner", { mark: f }); el.addEventListener("input", () => { f.ownerSet = true; }); return el; })())));
    });
    card.append(h("button", { class: "btn", onclick: () => { st.failureModes.push(newRisk()); touch(); render(); } }, _t("+ Add a risk to this step")));
    wrap.append(card);
  });
  wrap.append(h("button", { class: "btn", onclick: () => { A.steps.push({ name: "New step", actor: "", type: "manual", function: "", suppliers: [], inputs: [], outputs: [], customers: [], failureModes: [], flow: {}, textEdited: true }); touch(); render(); } }, _t("+ Add a step")));
  return wrap;
}
/* ---------- Process Efficiency Analysis (flow) ---------- */
const FLOW_UNITS = [["min", "minutes"], ["h", "hours"], ["d", "working days"], ["wk", "weeks"]];
const UNIT_MIN = { min: 1, h: 60, d: 480, wk: 2400 };
const VA_LABEL = { value: "Adds value", necessary: "Necessary", waste: "Waste" };
function cleanFlow(f) { const o = {}; Object.entries(f || {}).forEach(([k, v]) => { if (v && v.v != null && v.v !== "") o[k] = { v: v.v, u: v.u, conf: !!v.conf }; }); return o; }
function fmtFlow(f, kind) {
  if (!f || f.v == null) return "–";
  if (kind === "reworkPct") return f.v + "%";
  if (kind === "queue") return String(f.v);
  if (kind === "valueAdd") return _t(VA_LABEL[f.v] || f.v);
  return `${f.v} ${_t((FLOW_UNITS.find(u => u[0] === f.u) || [f.u, f.u])[1].replace(/s$/, f.v === 1 ? "" : "s"))}`;
}
function srcInfo(f) {
  if (!f || f.v == null) return { cls: "gap", label: _t("Not provided"), tip: _t("Nobody has entered this yet. Measure it or ask the people who do the work.") };
  const ov = f.orig ? (typeof f.orig.v === "string" ? _t(VA_LABEL[f.orig.v] || f.orig.v) : f.orig.u ? fmtFlow(f.orig, "processTime") : String(f.orig.v)) : "";
  const orig = f.orig ? ` Originally (${f.orig.src === "stated" ? "from your description" : "AI assumption"}): ${ov}${f.orig.quote ? `, \u201c${f.orig.quote}\u201d` : ""}.` : "";
  if (f.conf) return { cls: "conf", label: _t("User confirmed"), tip: (f.src === "user" ? _t("Entered by the team and confirmed.") : _t("Confirmed by the team.")) + orig };
  if (f.src === "user") return { cls: "user", label: _t("User amended"), tip: _t("Entered or changed by the team, not yet confirmed.") + orig };
  if (f.src === "stated") return { cls: "stated", label: _t("From your description"), tip: f.quote ? _t("Taken from your description: “{0}”", [f.quote]) : _t("Taken from your description.") };
  return { cls: "ai", label: _t("AI assumption"), tip: (f.note || _t("Suggested by the AI and not yet checked.")) + _t(" Check it with the team.") };
}
function srcBadge(f) { const i = srcInfo(f); return h("span", { class: "src " + i.cls, title: i.tip, tabindex: "0", "aria-label": i.label + ". " + i.tip }, i.label); }
function srcLegend() {
  return h("p", { class: "srclegend" }, _t("Where each value comes from: "),
    [{ src: "stated", v: 1 }, { src: "ai", v: 1 }, { src: "user", v: 1 }, { src: "user", v: 1, conf: true }, null].map(f => srcBadge(f)), " ",
    h("span", { class: "src calc" }, _t("Calculated")));
}
function fmtMinutes(m) {
  if (m == null) return "–";
  if (m < 60) return _t("{0} min", [Math.round(m)]);
  if (m < 480) return `${+(m / 60).toFixed(1)} h`;
  const d = +(m / 480).toFixed(1);
  return _t("{0} working day{1}", [d, _pl(d === 1 ? "" : "s")]);
}
async function findFlow(btn) {
  btn.disabled = true; btn.textContent = _t("Looking for timings…");
  try {
    const d = await api("POST", `/api/reviews/${S.R.meta.id}/flow`);
    setReview(d);
    S.flash = d.flowAdded ? _t("Found {0} value{1} in your description and notes. Nothing the team entered was changed.", [d.flowAdded, _pl(d.flowAdded > 1 ? "s" : "")]) : _t("No new timings were found in your description or notes. Enter them in Edit text → Flow and timings.");
  } catch (e) { S.flash = e.message; }
  render();
}
function flowTab(A) {
  const c = S.R.flowCalc || {};
  const steps = A.steps || [];
  const tiles = h("div", { class: "kpis flowkpis" },
    kpi("Lead time", fmtMinutes(c.leadTime), c.complete ? "Start to finish, per case" : "Incomplete: some timings missing", "c1"),
    kpi("Processing time", fmtMinutes(c.processTime), `${c.withProcessTime || 0} of ${c.steps || 0} steps timed`, "c3"),
    kpi("Waiting time", fmtMinutes(c.waitTime), `${c.withWaitTime || 0} of ${c.steps || 0} waits known`, "c2"),
    kpi("Value-added share", c.valueAddedPct == null ? "–" : c.valueAddedPct + "%", c.valueAddedPct == null ? "Needs all timings" : "of the lead time", "c4"));
  const map = h("div", { class: "vsm" });
  steps.forEach((st, i) => {
    const f = st.flow || {};
    const w = f.waitBefore;
    map.append(h("div", { class: "vwait" + (c.biggestWait && c.biggestWait.stepId === st.id ? " big" : "") },
      h("span", { class: "tri", "aria-hidden": "true" }, "▲"), h("span", { class: "wv" }, w ? fmtFlow(w, "waitBefore") : "?"),
      f.queue ? h("span", { class: "wq" }, _t("{0} waiting", [f.queue.v])) : null, w ? srcBadge(w) : null));
    const va = (f.valueAdd || {}).v;
    map.append(h("div", { class: "vstep va-" + (va || "none") },
      h("div", { class: "vnum" }, i + 1), h("div", { class: "vname" }, st.name), h("div", { class: "vact" }, st.actor || ""),
      h("div", { class: "vpt" }, h("b", null, f.processTime ? fmtFlow(f.processTime, "processTime") : "?"), f.processTime ? srcBadge(f.processTime) : null),
      f.reworkPct ? h("div", { class: "vrw" }, _t("{0}% rework", [f.reworkPct.v])) : null,
      h("div", { class: "vva" }, va ? _t(VA_LABEL[va]) : _t("Not classified"), f.valueAdd ? srcBadge(f.valueAdd) : null)));
  });
  const ladder = h("div", { class: "ladder", "aria-label": _t("Timeline: waiting time above the line, processing time below") },
    steps.flatMap(st => [h("div", { class: "lw" }, fmtFlow((st.flow || {}).waitBefore, "waitBefore")), h("div", { class: "lp" }, fmtFlow((st.flow || {}).processTime, "processTime"))]),
    h("div", { class: "lt" }, h("div", null, _t("Waiting "), h("b", null, fmtMinutes(c.waitTime))), h("div", null, _t("Processing "), h("b", null, fmtMinutes(c.processTime)))));
  const rows = steps.map((st, i) => {
    const f = st.flow || {};
    const cell = k => h("td", null, h("div", null, fmtFlow(f[k], k)), srcBadge(f[k]));
    return h("tr", null, h("td", null, h("b", null, `${i + 1}. ${st.name}`)), cell("processTime"), cell("waitBefore"), cell("queue"), cell("reworkPct"), cell("valueAdd"));
  });
  const gaps = (A.dataGaps || []);
  return h("div", null,
    h("p", { class: "muted" }, _t("Analyse how work flows through your business, identify bottlenecks, delays and unnecessary activities, and highlight opportunities to improve efficiency, reduce costs and save time."), " ", _t("Timings are never invented: anything not in your description stays empty until your team enters it.")),
    srcLegend(),
    tiles,
    h("p", { class: "muted small" }, h("span", { class: "src calc" }, _t("Calculated")), " ", c.basis || "", _t(" A working day is {0} hours.", [c.workdayHours || 8])),
    c.biggestWait || c.longestStep ? h("div", { class: "callouts" },
      c.biggestWait ? h("div", { class: "callout" }, h("b", null, _t("Biggest wait: ")), _t("before \"{0}\", {1}", [c.biggestWait.name, fmtMinutes(c.biggestWait.minutes)]) + (c.biggestWait.share != null ? _t(" ({0}% of the known lead time)", [c.biggestWait.share]) : "") + ".") : null,
      c.longestStep ? h("div", { class: "callout" }, h("b", null, _t("Longest step: ")), _t("\"{0}\", {1} per case.", [c.longestStep.name, fmtMinutes(c.longestStep.minutes)])) : null) : null,
    h("h2", null, _t("Process efficiency map")),
    h("div", { class: "vsmwrap" }, map, ladder),
    h("p", { class: "muted small" }, _t("Colour of each step: green adds value, grey is necessary, coral is waste. The amber triangles show waiting before each step; ? means not known yet.")),
    h("h2", null, _t("Timings by step")),
    h("div", { class: "tablewrap" }, h("table", { class: "flowtable" },
      h("thead", null, h("tr", null, [["Step", null], [FLOW_HELP.processTime[0], "processTime"], [FLOW_HELP.waitBefore[0], "waitBefore"], [FLOW_HELP.queue[0], "queue"], [FLOW_HELP.reworkPct[0], "reworkPct"], [FLOW_HELP.valueAdd[0], "valueAdd"]].map(([x, k]) => h("th", null, _t(x), k ? helpTip(k) : null)))), h("tbody", null, rows))),
    canWrite() ? h("div", { class: "row actions" },
      h("button", { class: "btn primary", onclick: () => { startEdit(); S.tab = "flow"; render(); } }, _t("Enter or correct timings")),
      h("button", { class: "btn", onclick: e => findFlow(e.currentTarget) }, _t("Find timings in the description and notes"))) : null,
    gaps.length ? h("div", null, h("h2", null, _t("What to measure next")),
      h("p", { class: "muted small" }, _t("Suggested by the AI to complete the map. Measuring a few real cases is enough to start.")),
      h("ul", { class: "gaps" }, gaps.map(g => h("li", null, g.step ? h("b", null, g.step + ": ") : null, g.what, g.how ? h("span", { class: "muted" }, _t(" How: {0}", [g.how])) : null)))) : null);
}
const FLOW_HELP = {
  processTime: ["Working time for one item", "How long someone actively works on one item at this step, for example one request, order or invoice. Count only hands-on time, not time spent waiting in an inbox or queue."],
  waitBefore: ["Waiting time before this step", "How long one item typically waits before anyone starts this step, for example sitting in an inbox, a queue or waiting for approval."],
  queue: ["Items usually waiting", "How many items are typically waiting to be worked on at this step at any moment. Leave it empty if you don't know."],
  reworkPct: ["Items sent back or redone (%)", "Out of every 100 items, how many have to be corrected, sent back or done again at this step."],
  valueAdd: ["Value to the customer", "Adds value: the customer would gladly pay for it. Necessary: needed for control or the law, but not valued by the customer. Waste: waiting, chasing, re-keying or duplicate checks."],
};
function helpTip(key) {
  const [label, text] = FLOW_HELP[key];
  const id = "help-" + key + "-" + Math.random().toString(36).slice(2, 7);
  return h("span", { class: "helptip" }, h("button", { type: "button", class: "qmark", "aria-label": _t("What is {0}?", [_t(label).toLowerCase()]), "aria-describedby": id,
    onclick: e => { e.currentTarget.parentNode.classList.toggle("open"); } }, "?"), h("span", { class: "tipbox", role: "tooltip", id }, _t(text)));
}
function teamSet(f, k, val, unit) {
  const prev = f[k];
  const nf = { ...(prev || (unit != null ? { u: unit } : {})), v: val, conf: false, src: "user" };
  if (unit != null) nf.u = unit;
  if (prev && prev.src && prev.src !== "user" && !prev.orig) nf.orig = { src: prev.src, v: prev.v, u: prev.u, quote: prev.quote };
  f[k] = nf;
}
function flowEdit(A) {
  const wrap = h("div", null,
    h("p", { class: "muted" }, _t("Enter the timings your team knows or has measured, for one typical item going through the process (for example one request or one order). Leave a box empty if it isn't known: empty is better than a guess. When the team has checked a step's figures, tick \u201cThe team has checked this step\u2019s figures\u201d.")),
    srcLegend());
  A.steps.forEach((st, i) => {
    st.flow = st.flow || {};
    const f = st.flow;
    const lab = k => h("span", { class: "ffl" }, _t(FLOW_HELP[k][0]), " ", helpTip(k), " ", srcBadge(f[k]));
    const timeField = k => {
      const cur = f[k] || {};
      const num = h("input", { class: "ed", type: "number", min: "0", step: "any", inputmode: "decimal", "aria-label": _t("{0} for {1}", [_t(FLOW_HELP[k][0]), st.name]), value: cur.v == null ? "" : cur.v,
        onchange: e => { const v = e.target.value; if (v === "") delete f[k]; else teamSet(f, k, Number(v), unit.value); touch(); render(); } });
      const unit = h("select", { class: "ed", "aria-label": _t("Unit for {0}", [st.name]), onchange: e => { if (f[k]) { f[k].u = e.target.value; f[k].conf = false; touch(); render(); } } },
        FLOW_UNITS.map(([u, n]) => h("option", { value: u, selected: (cur.u || (k === "waitBefore" ? "h" : "min")) === u }, _t(n))));
      return h("div", { class: "ff" }, lab(k), h("div", { class: "ffin" }, num, unit));
    };
    const numField = (k, max) => {
      const cur = f[k] || {};
      const num = h("input", { class: "ed", type: "number", min: "0", max: max || null, step: "any", inputmode: "decimal", "aria-label": _t("{0} for {1}", [_t(FLOW_HELP[k][0]), st.name]), value: cur.v == null ? "" : cur.v,
        onchange: e => { const v = e.target.value; if (v === "") delete f[k]; else teamSet(f, k, Number(v)); touch(); render(); } });
      return h("div", { class: "ff" }, lab(k), h("div", { class: "ffin" }, num));
    };
    const cur = f.valueAdd || {};
    const vaSel = h("select", { class: "ed", "aria-label": _t("Value of {0}", [st.name]), onchange: e => { if (!e.target.value) delete f.valueAdd; else teamSet(f, "valueAdd", e.target.value); touch(); render(); } },
      h("option", { value: "" }, _t("Not classified")), Object.entries(VA_LABEL).map(([v, l]) => h("option", { value: v, selected: cur.v === v }, _t(l))));
    const keys = ["processTime", "waitBefore", "queue", "reworkPct", "valueAdd"].filter(k => f[k]);
    const allConf = keys.length > 0 && keys.every(k => f[k].conf);
    const stepConf = h("label", { class: "stepconf" + (allConf ? " on" : "") }, h("input", { type: "checkbox", checked: allConf, disabled: !keys.length,
      onchange: e => { keys.forEach(k => { f[k].conf = e.target.checked; }); touch(); render(); } }),
      " ", keys.length ? _t("The team has checked this step's figures") : _t("Enter at least one figure to confirm this step"));
    wrap.append(h("section", { class: "flowedit" + (allConf ? " confirmed" : "") }, h("h3", null, `${i + 1}. ${st.name}`),
      h("div", { class: "ffgrid" }, timeField("processTime"), timeField("waitBefore"), numField("queue"), numField("reworkPct", 100),
        h("div", { class: "ff" }, lab("valueAdd"), h("div", { class: "ffin" }, vaSel))),
      stepConf));
  });
  return wrap;
}
/* ---------- The seven-stage journey ---------- */
const JOURNEY = [["process", "Process", null], ["steps", "Steps", "steps"], ["sipoc", "SIPOC", "sipoc"], ["worksheet", "Risk analysis", "risk"], ["flow", "Process Efficiency Analysis", "flow"], ["swot", "SWOT", "swot"], ["raci", "RACI", "raci"]];
const STAGE_ORDER = ["steps", "sipoc", "risk", "flow", "swot", "raci", "complete"];
const STAGE_HELP = {
  steps: ["Check the process steps", "The AI has set out the steps of your process from your description. Everything that follows is built on these steps, so take the time to get them right with the people who do the work: rename, add, delete or reorder steps, and check who does each one, in Edit. When the list is right, confirm it to build the SIPOC.", "Confirm the steps and build the SIPOC"],
  sipoc: ["Check the SIPOC", "The AI has set out the Suppliers, Inputs, Outputs and Customers of your confirmed steps, and linked each supplier to the input it provides and each output to the customer who receives it. Check the diagram and the table with the team and correct them in Edit. When it's right, confirm it to start the risk analysis.", "Confirm SIPOC and analyse the risks"],
  risk: ["Review the risks, step by step", "The AI has analysed what can go wrong in every confirmed step. Go through the steps one at a time: correct the risks, ratings and actions where needed, then mark each step as reviewed. When all steps are reviewed, confirm to move on to the Process Efficiency Analysis.", "Confirm the risk analysis"],
  flow: ["Add the timings", "Timings stated in your description have been filled in, and nothing else. Enter what your team knows or has measured (processing time, waiting time, queues), or leave gaps for now. Confirming prepares the SWOT and the executive summary.", "Confirm the Process Efficiency Analysis and write the SWOT"],
  swot: ["Check the SWOT and summary", "The AI has written the SWOT analysis and the executive summary from everything you've confirmed. Check and edit them, then confirm to build the RACI matrix.", "Confirm the SWOT and build the RACI"],
  raci: ["Check who does what (RACI)", "The AI has suggested who is Responsible, Accountable, Consulted and Informed for each step. Check it with the team and fix the problems flagged below the matrix, then confirm to complete the review.", "Confirm the RACI and complete the review"],
};
const stageIdx = st => STAGE_ORDER.indexOf(st);
function tabOpen(key, A) {
  const i = Math.max(stageIdx(S.R.workflow.stage), S.R.workflow.reached || 0);
  const legacy = S.R.workflow.legacy;
  return { process: true, steps: true, sipoc: i >= 1 || legacy, worksheet: i >= 2, flow: i >= 3, swot: i >= 4 && !!A.swot, raci: i >= 5 || !!A.raci || legacy,
    summary: !!A.headline, actions: A.steps.some(s => (s.failureModes || []).length), activity: true }[key];
}
function viewTabs(A) {
  const t = JOURNEY.filter(([k]) => tabOpen(k, A)).map(([k, l], i) => [k, `${JOURNEY.findIndex(j => j[0] === k) + 1}. ${l}`]);
  if (tabOpen("summary", A)) t.unshift(["summary", "Summary"]);
  if (tabOpen("actions", A)) t.push(["actions", "Actions"]);
  t.push(["activity", "Activity"]);
  return t;
}
function editTabs(A) {
  const i = Math.max(stageIdx(S.R.workflow.stage), S.R.workflow.reached || 0), legacy = S.R.workflow.legacy;
  const t = [["worksheet", i >= 2 || legacy ? "Steps and risks" : "Steps"]];
  if (i >= 1 || legacy) t.push(["sipoc", "SIPOC"]);
  if (i >= 3 || legacy) t.push(["flow", "Flow and timings"]);
  if (A.headline || A.swot) t.push(["summary", "Summary and SWOT"]);
  if (A.raci) t.push(["raci", "RACI"]);
  return t;
}
function journeyBar() {
  const wf = S.R.workflow, cur = stageIdx(wf.stage), A = S.R.analysis, reached = wf.reached || 0;
  const nav = h("nav", { class: "journey", "aria-label": _t("Review stages") }, JOURNEY.map(([k, l, st], i) => {
    const state = i === 0 || (st && stageIdx(st) < cur) ? "done" : st === wf.stage ? "current" : (st && stageIdx(st) <= reached) ? "redo" : "locked";
    const open = tabOpen(k, A);
    const ph = i <= 2 ? "ph-u" : i <= 5 ? "ph-a" : "ph-i";
    return h("button", { class: "jstep " + state + " " + ph + (S.tab === k ? " sel" : ""), disabled: !open, "aria-current": state === "current" ? "step" : null,
      onclick: () => go(k) },
      h("span", { class: "jnum" }, state === "done" ? "\u2713" : i + 1), h("span", { class: "jlab" }, _t(l)));
  }));
  const extra = [["summary", "Summary"], ["actions", "Actions"], ["activity", "Activity"]].filter(([k]) => tabOpen(k, A));
  nav.append(h("span", { class: "jsep", "aria-hidden": "true" }), ...extra.map(([k, l]) => h("button", { class: "jstep view" + (S.tab === k ? " sel" : ""),
    "aria-current": S.tab === k ? "page" : null, onclick: () => go(k) }, h("span", { class: "jlab" }, _t(l),
      k === "worksheet" && S.R.comments.length ? h("span", { class: "count" }, S.R.comments.length) : null))));
  const phases = h("div", { class: "phases", "aria-hidden": "true" }, h("span", { class: "u" }, _t("Understand 1–3")), h("span", { class: "a" }, _t("Analyse 4–6")),
    h("span", { class: "i" }, _t("Improve 7")), h("span", { class: "m" }, _t("Measure: actions")));
  return h("div", null, phases, nav, goBackControl());
}
function goBackControl() {
  const wf = S.R.workflow, cur = stageIdx(wf.stage);
  if (!canWrite() || wf.legacy || cur < 1) return null;
  const earlier = JOURNEY.filter(j => j[2] && stageIdx(j[2]) < cur);
  if (!S.backOpen) return h("p", { class: "goback" }, h("button", { class: "btn link", onclick: () => { S.backOpen = true; S.backTo = null; render(); } },
    wf.stage === "complete" ? _t("Reopen a stage") : _t("← Go back to an earlier stage")));
  const pick = S.backTo ? JOURNEY.find(j => j[2] === S.backTo) : null;
  return h("section", { class: "panel backpanel" },
    h("h3", null, wf.stage === "complete" ? _t("Reopen a stage") : _t("Go back to an earlier stage")),
    h("p", { class: "muted small" }, _t("Nothing is deleted. The stage you choose opens again for changes; the later stages keep their content and are confirmed again one by one. When you confirm again, only what's new or changed is sent to the AI: new steps get their SIPOC, risks and timings, steps you changed need reviewing again, and the team's SIPOC links and RACI are kept. The SWOT and summary are rewritten from the updated stages (the previous version stays in the version history).")),
    h("div", { class: "row actions" }, earlier.map(([k, l, st]) => h("button", { class: "fchip", "aria-pressed": S.backTo === st ? "true" : "false", onclick: () => { S.backTo = st; render(); } },
      `${JOURNEY.findIndex(j => j[2] === st) + 1}. ${_t(l)}`))),
    pick ? h("p", null, h("b", null, _t("Go back to stage {0}, {1}?", [JOURNEY.indexOf(pick) + 1, _t(pick[1])])),
      wf.stage === "complete" && S.R.meta.status === "validated" ? _t(" The sign-off will be marked as out of date.") : "") : null,
    h("div", { class: "row actions" },
      h("button", { class: "btn primary", disabled: !pick || S.busy, onclick: goBack }, pick ? _t("Go back to {0}", [_t(pick[1])]) : _t("Choose a stage")),
      h("button", { class: "btn", onclick: () => { S.backOpen = false; S.backTo = null; render(); } }, _t("Cancel"))));
}
async function goBack() {
  await flushNow();
  S.busy = true; render();
  try {
    setReview(await api("POST", `/api/reviews/${S.R.meta.id}/stage/back`, { to: S.backTo, rev: S.R.meta.rev }));
    S.tab = JOURNEY.find(j => j[2] === S.backTo)[0];
    S.flash = _t("You're back at the {0} stage. Make your changes, then confirm each stage again.", [_t(JOURNEY.find(j => j[2] === S.backTo)[1])]);
    S.backOpen = false; S.backTo = null; S.walk = null;
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.data && e.data.review) setReview(e.data.review);
    S.status = e.message === "conflict" ? _t("Someone else changed this review just now. The latest version is loaded: try again.") : e.message; S.statusErr = true;
  }
  S.busy = false; render();
}
function stagePanel() {
  const wf = S.R.workflow, A = S.R.analysis;
  if (wf.stage === "complete") return null;
  const [title, text, btnLabel] = STAGE_HELP[wf.stage].map(x => _t(x));
  const n = stageIdx(wf.stage) + 2;
  const nRev = A.steps.filter(s => wf.reviewed[s.id]).length;
  const blocked = wf.stage === "risk" && nRev < A.steps.length;
  const tabKey = JOURNEY.find(j => j[2] === wf.stage)[0];
  return h("section", { class: "stagepanel" },
    h("div", { class: "stagehead" }, h("span", { class: "stagetag" }, _t("Stage {0} of 7", [n])), h("h2", null, _t(title))),
    h("p", null, _t(text)),
    (wf.reached || 0) > stageIdx(wf.stage) ? h("p", { class: "note" }, h("b", null, _t("You've come back to this stage. ")), _t("Later stages kept their content and will be confirmed again after this one; only new or changed steps go to the AI again.")) : null,
    wf.stage === "risk" ? h("p", { class: "small" }, h("b", null, _t("{0} of {1} steps reviewed.", [nRev, A.steps.length])), blocked ? _t(" Review the rest to continue.") : _t(" All steps reviewed.")) : null,
    canWrite() ? h("div", { class: "row actions" },
      S.tab !== tabKey ? h("button", { class: "btn", onclick: () => { S.tab = tabKey; render(); } }, _t("Open the {0}", [JOURNEY.find(j => j[0] === tabKey)[1]])) : null,
      h("button", { class: "btn", onclick: () => { startEdit(); S.tab = tabKey === "steps" ? "worksheet" : editTabs(S.edit.A).some(t => t[0] === tabKey) ? tabKey : "worksheet"; render(); } }, _t("Edit")),
      h("button", { class: "btn primary", disabled: S.busy || blocked, onclick: confirmStage }, S.busy ? _t("Working… this can take a minute") : _t(btnLabel))) : null,
    canWrite() && wf.stage !== "raci" ? h("p", { class: "muted small" }, _t("Confirming prepares the next stage.")) : null,
    canWrite() ? null :
      h("p", { class: "note" }, _t("You have view-only access, so someone with edit access needs to confirm this stage.")));
}
async function confirmStage() {
  await flushNow();
  const wf = S.R.workflow, stage = wf.stage;
  S.busy = true; S.status = ""; render();
  try {
    setReview(await api("POST", `/api/reviews/${S.R.meta.id}/stage`, { stage, rev: S.R.meta.rev }));
    const nxt = S.R.workflow.stage;
    S.tab = nxt === "complete" ? "summary" : JOURNEY.find(j => j[2] === nxt)[0];
    S.flash = nxt === "complete" ? _t("All seven stages are confirmed. The review is complete: download the report, track the actions, and sign it off when the team agrees.") : "";
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.data && e.data.review) setReview(e.data.review);
    S.status = e.message === "conflict" ? _t("Someone else changed this review just now. The latest version is loaded: check it, then confirm again.") : e.message;
    S.statusErr = true;
  }
  S.busy = false; render();
}
function reviewControl(st) {
  const wf = S.R.workflow, r = wf.reviewed[st.id];
  if (stageIdx(wf.stage) < 2 || wf.legacy) return null;
  const next = () => {
    const A = S.R.analysis, cur = A.steps.findIndex(x => x.id === st.id);
    const after = A.steps.findIndex((x, j) => j > cur && !S.R.workflow.reviewed[x.id]);
    const i = after >= 0 ? after : A.steps.findIndex(x => !S.R.workflow.reviewed[x.id]);
    if (walkActive()) { if (i >= 0) walkGo(i); else { S.flash = _t("Every step has been reviewed. Confirm the risk analysis above to move on to the Process Efficiency Analysis."); render(); window.scrollTo(0, 0); } return; }
    if (i >= 0) { const el = document.getElementById("step-" + i); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  };
  return h("div", { class: "revctl" + (r ? " ok" : "") },
    r ? h("span", null, h("b", null, _t("✓ Reviewed")), _t(" by {0}, {1}", [name(r.by), when(r.at * 1000)])) : h("span", { class: "muted" }, _t("Not reviewed yet.")),
    canWrite() && wf.stage === "risk" ? h("button", { class: r ? "btn link" : "btn primary", onclick: async () => {
      try { setReview(await api("POST", `/api/reviews/${S.R.meta.id}/review-step`, { stepId: st.id, reviewed: !r })); render(); if (!r) next(); }
      catch (e) { S.flash = e.message; render(); }
    } }, r ? _t("Re-open") : walkActive() ? _t("Mark as reviewed and go to the next step →") : _t("Mark this step as reviewed")) : null);
}
/* On a completed stage's page: change it (reopen the stage) or edit its contents directly. */
function stageTools(A) {
  const wf = S.R.workflow, j = JOURNEY.find(x => x[0] === S.tab);
  if (!j || !j[2] || !canWrite() || S.edit) return null;
  const done = stageIdx(j[2]) < stageIdx(wf.stage) && !wf.legacy;
  const editTab = { steps: "worksheet", worksheet: "worksheet", sipoc: "sipoc", flow: "flow", swot: "summary", raci: "raci" }[S.tab];
  if (!done || j[2] === wf.stage) return null;
  return h("div", { class: "stagetools" },
    h("span", { class: "muted small" }, _t("This stage is confirmed.")),
    h("button", { class: "btn", onclick: () => { startEdit(); S.tab = editTabs(S.edit.A).some(t => t[0] === editTab) ? editTab : editTabs(S.edit.A)[0][0]; render(); } }, _t("Edit")),
    h("button", { class: "btn", title: _t("Reopen this stage to change it; later stages are confirmed again afterwards"), onclick: () => { S.backOpen = true; S.backTo = j[2]; render(); window.scrollTo(0, 0); } }, _t("Change this stage")));
}
function processTab() {
  const i = S.R.inputs || {};
  return h("div", null,
    h("h2", null, _t("The process as you described it")),
    i.knownIssues ? h("div", { class: "panel reported" }, h("h3", null, _t("Known issues you reported"), " ", h("span", { class: "src stated" }, _t("User-reported"))),
      h("p", null, _t({ yes: "Yes, there are known issues.", no: "No known issues.", unsure: "I'm not sure." }[i.knownIssues] || "")), i.issuesText ? h("p", null, i.issuesText) : null,
      h("p", { class: "muted small" }, _t("The review takes this into account, but always looks at the whole process independently, including problems you haven't mentioned."))) : null,
    h("p", { class: "muted small" }, _t("Everything in this review is built from this description and your team's confirmations.")),
    h("div", { class: "panel processtext" }, i.text ? i.text : h("span", { class: "muted" }, _t("This review was created from an image, so there's no text to show."))),
    h("p", { class: "muted small" }, [`Priority: ${i.priority || "Balanced review"}`, `Company size: ${i.size || "Not specified"}`, `Report language: ${langOf(i.lang || "en")[1]}`,
      i.runs ? `Runs per month: ${i.runs}` : "", i.rate ? `Cost per staff hour: ${i.rate} ${i.cur || ""}` : ""].filter(Boolean).join(" \u00b7 ")));
}
function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function sipocSvg(A) {
  const L = sipocLayout(A.sipoc, { title: A.processName || _t("Process"), desc: A.processScope || "", foot: `${A.steps.length} step${A.steps.length === 1 ? "" : "s"}` });
  if (!L) return null;
  const cls = { supplier: "spx", customer: "spx", input: "spi", output: "spo" };
  const lc = { supply: "lki", in: "lka", out: "lka", receive: "lko" };
  let g = `<svg class="sipocsvg" viewBox="0 0 ${L.W} ${L.H}" role="img" aria-labelledby="sipT sipD"><title id="sipT">SIPOC diagram</title><desc id="sipD">Suppliers link to the inputs they provide; inputs flow into the process; outputs flow out to the customers who receive them.</desc>`;
  g += `<defs><marker id="sipA" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round"/></marker></defs>`;
  L.headers.forEach(t => { g += `<text class="sph" x="${t.x}" y="${t.y}" text-anchor="middle">${esc(t.text)}</text>`; });
  L.links.forEach(k => {
    const mx = (k.x1 + k.x2) / 2, dl = k.from ? ` data-a="${esc(k.from)}" data-b="${esc(k.to)}"` : "";
    g += k.y1 === k.y2 ? `<line${dl} class="${lc[k.kind]}" x1="${k.x1}" y1="${k.y1}" x2="${k.x2}" y2="${k.y2}" marker-end="url(#sipA)"/>`
      : `<path${dl} class="${lc[k.kind]}" fill="none" d="M${k.x1} ${k.y1} C${mx} ${k.y1} ${mx} ${k.y2} ${k.x2} ${k.y2}" marker-end="url(#sipA)"/>`;
  });
  const P = L.proc;
  g += `<rect class="spp" x="${P.x}" y="${P.y}" width="${P.w}" height="${P.h}" rx="8"/>`;
  let y = P.y + 24;
  P.title.forEach(t => { g += `<text class="spt" x="${P.x + P.w / 2}" y="${y}" text-anchor="middle" dominant-baseline="central">${esc(t)}</text>`; y += 18; });
  y += 10;
  P.desc.forEach(t => { g += `<text class="sps" x="${P.x + P.w / 2}" y="${y}" text-anchor="middle" dominant-baseline="central">${esc(t)}</text>`; y += 16; });
  if (P.foot) g += `<text class="sps" x="${P.x + P.w / 2}" y="${P.y + P.h - 16}" text-anchor="middle" dominant-baseline="central">${esc(P.foot)}</text>`;
  L.nodes.forEach(n => {
    g += `<g class="${cls[n.kind]}" tabindex="0" data-n="${esc(n.name)}"><title>${esc(n.name)}</title><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6"/>`;
    const cy = n.y + n.h / 2, off = (n.lines.length - 1) * 7;
    n.lines.forEach((t, i) => { g += `<text x="${n.x + n.w / 2}" y="${cy - off + i * 14}" text-anchor="middle" dominant-baseline="central">${esc(t)}</text>`; });
    g += `</g>`;
  });
  g += `</svg>`;
  const wrap = h("div", { class: "sipocwrap" });
  wrap.innerHTML = g;
  const svg = wrap.firstChild;
  const hi = name => { svg.classList.toggle("focus", !!name); svg.querySelectorAll("[data-a]").forEach(l => l.classList.toggle("hl", !!name && (l.dataset.a === name || l.dataset.b === name))); };
  svg.querySelectorAll("g[data-n]").forEach(gr => { const n = gr.dataset.n; ["mouseenter", "focus"].forEach(ev => gr.addEventListener(ev, () => hi(n))); ["mouseleave", "blur"].forEach(ev => gr.addEventListener(ev, () => hi(null))); });
  wrap.append(h("p", { class: "muted small" }, _t("Point at (or tab to) a supplier, input, output or customer to highlight its links.")));
  return wrap;
}
function stepsTab(A) {
  const types = { manual: "Manual", automated: "Automated", decision: "Decision", handoff: "Handoff", wait: "Waiting" };
  return h("div", null,
    h("p", { class: "muted" }, _t("The steps of your process, in order. Everything after this (the SIPOC, risks, timings, SWOT and RACI) is built on these steps, so they need to be right first.")),
    processFlow(A),
    h("div", { class: "tablewrap" }, h("table", { class: "flowtable" },
      h("thead", null, h("tr", null, ["#", "Step", "Who does it", "Type", "Purpose"].map(x => h("th", null, _t(x))))),
      h("tbody", null, A.steps.map((st, i) => h("tr", null, h("td", null, h("b", null, i + 1)), h("td", null, h("b", null, st.name)), h("td", null, st.actor || ""), h("td", null, types[st.type] || st.type || ""), h("td", null, st.function || "")))))),
    (A.openPoints || []).length ? h("section", { class: "panel openpts" }, h("h3", null, _t("Questions to settle with the team "), h("span", { class: "src ai" }, _t("AI assumption"))),
      h("ul", null, A.openPoints.map(q => h("li", null, q)))) : null,
    (A.assumptions || []).length ? h("details", { class: "limits", open: true }, h("summary", null, _t("What the AI assumed (check these)")), h("ul", null, A.assumptions.map(x => h("li", null, x)))) : null,
    canWrite() && S.R.workflow.stage === "steps" ? h("button", { class: "btn", onclick: () => { startEdit(); S.tab = "worksheet"; render(); } }, _t("Edit the steps")) : null);
}
function sipocTab(A) {
  const sp = A.sipoc || {};
  const col = (k, title, items, cls) => h("div", { class: "sipcol " + cls }, h("div", { class: "siphead" }, h("b", null, title[0]), title.slice(1)),
    h("ul", null, (items && items.length ? items : ["\u2013"]).map(x => h("li", null, x))));
  const steps = A.steps.map((s, i) => `${i + 1}. ${s.name}`);
  const diagram = sipocSvg(A);
  return h("div", null,
    h("p", { class: "muted" }, _t("Who supplies what, what comes out, and who receives it. Each line links a supplier to the input it provides, and an output to the customer who receives it. Correct anything that's wrong in Edit → SIPOC.")),
    diagram || h("div", { class: "sipoc" }, col("suppliers", "Suppliers", sp.suppliers, "s"), col("inputs", "Inputs", (sp.inputs || []).map(x => x.name || x), "i"), col("process", "Process", steps, "p"), col("outputs", "Outputs", (sp.outputs || []).map(x => x.name || x), "o"), col("customers", "Customers", sp.customers, "c")),
    h("h2", null, _t("SIPOC by step")),
    h("div", { class: "tablewrap" }, h("table", { class: "flowtable" },
      h("thead", null, h("tr", null, ["Step", "Who", "Suppliers", "Inputs", "Outputs", "Customers"].map(x => h("th", null, _t(x))))),
      h("tbody", null, A.steps.map((s, i) => h("tr", null, h("td", null, h("b", null, `${i + 1}. ${s.name}`), s.function ? h("div", { class: "muted small" }, s.function) : null),
        h("td", null, s.actor || ""), ...["suppliers", "inputs", "outputs", "customers"].map(k => h("td", null, (s[k] || []).join(", ") || h("span", { class: "muted" }, "\u2013")))))))),
    (A.assumptions || []).length ? h("details", { class: "limits", open: true }, h("summary", null, _t("What the AI assumed (check these)")), h("ul", null, A.assumptions.map(a => h("li", null, a)))) : null);
}
function sipocEdit(A) {
  const lines = (obj, k, label, isStep) => {
    const t = h("textarea", { class: "ed short", "aria-label": _t(label), oninput: e => { obj[k] = e.target.value.split("\n").map(x => x.trim()).filter(Boolean); touch(); if (isStep) obj.textEdited = true; } });
    t.value = (obj[k] || []).join("\n");
    return h("label", { class: "edl" }, _t(label), h("span", { class: "muted small" }, _t(" one per line")), t);
  };
  const sp = A.sipoc = Object.assign({ suppliers: [], customers: [] }, A.sipoc || {});
  const norm = (v, key) => (Array.isArray(v) ? v : []).map(x => (x && typeof x === "object") ? { name: x.name || "", [key]: Array.isArray(x[key]) ? x[key] : [] } : { name: String(x || ""), [key]: [] });
  sp.inputs = norm(sp.inputs, "from"); sp.outputs = norm(sp.outputs, "to");
  const parties = (k, label) => {
    const t = h("textarea", { class: "ed short", "aria-label": _t(label), onchange: e => {
      const nw = e.target.value.split("\n").map(x => x.trim()).filter(Boolean);
      const old = sp[k];
      // keep links when a name is renamed in place, drop links to removed names
      const ren = {}; old.forEach((o, i) => { if (nw[i] && nw.length === old.length && nw[i] !== o) ren[o] = nw[i]; });
      sp[k] = nw;
      (k === "suppliers" ? sp.inputs : sp.outputs).forEach(it => { const key = k === "suppliers" ? "from" : "to"; it[key] = it[key].map(x => ren[x] || x).filter(x => nw.includes(x)); });
      touch(); render();
    } });
    t.value = sp[k].join("\n");
    return h("label", { class: "edl" }, _t(label), h("span", { class: "muted small" }, _t(" one per line")), t);
  };
  const itemRows = (list, key, partyList, label, partyLabel, addLabel) => h("div", { class: "spedit" },
    h("h4", null, _t(label)),
    list.map((it, i) => h("div", { class: "sprow" },
      h("input", { class: "ed", type: "text", value: it.name, "aria-label": _t(label) + " " + (i + 1), placeholder: label.slice(0, -1), oninput: e => { it.name = e.target.value; touch(); } }),
      h("div", { class: "spchips" }, h("span", { class: "muted small" }, _t(partyLabel) + ": "),
        partyList.length ? partyList.map(p => h("button", { type: "button", class: "fchip", "aria-pressed": it[key].includes(p) ? "true" : "false",
          onclick: () => { it[key] = it[key].includes(p) ? it[key].filter(x => x !== p) : [...it[key], p]; touch(); render(); } }, p)) : h("span", { class: "muted small" }, _t("add some first"))),
      h("button", { class: "btn link red", type: "button", onclick: () => { list.splice(i, 1); touch(); render(); } }, _t("Remove")))),
    h("button", { class: "btn link", type: "button", onclick: () => { list.push({ name: "", [key]: [] }); touch(); render(); } }, _t(addLabel)));
  return h("div", { class: "editwrap" },
    h("section", { class: "panel" }, h("h3", null, _t("SIPOC of the whole process")),
      h("p", { class: "muted small" }, _t("List the suppliers and customers, then tap them under each input and output to link them. The diagram is drawn from these links.")),
      h("div", { class: "edgrid two" }, parties("suppliers", "Suppliers"), parties("customers", "Customers")),
      itemRows(sp.inputs, "from", sp.suppliers, "Inputs", "Supplied by", "+ Add an input"),
      itemRows(sp.outputs, "to", sp.customers, "Outputs", "Received by", "+ Add an output"),
      h("p", { class: "muted small" }, _t("The process steps themselves are edited on the Steps tab: rename, add, delete or reorder them there."))),
    A.steps.map((st, i) => h("section", { class: "panel" }, h("h3", null, `${i + 1}. ${st.name}`),
      h("div", { class: "edgrid two" }, lines(st, "suppliers", "Suppliers", true), lines(st, "inputs", "Inputs", true), lines(st, "outputs", "Outputs", true), lines(st, "customers", "Customers", true)))));
}
function swotTab(A) {
  return h("div", null, h("p", { class: "muted" }, _t("Strengths and weaknesses inside the process; opportunities and threats from outside it. Written from everything your team confirmed in the earlier stages.")), swotBlock(A));
}
const RACI_VALUES = ["", "R", "A", "R/A", "C", "I"];
const RACI_TIP = { R: "Responsible: does the work", A: "Accountable: owns the outcome and signs off", "R/A": "Responsible and accountable", C: "Consulted: gives input before", I: "Informed: told afterwards" };
function raciTab(A) {
  const m = A.raci;
  if (!m) return h("div", { class: "panel" }, h("p", null, _t("This review doesn't have a RACI matrix yet.")),
    canWrite() ? h("button", { class: "btn primary", onclick: async e => { e.currentTarget.disabled = true; try { setReview(await api("POST", `/api/reviews/${S.R.meta.id}/raci`)); } catch (er) { S.flash = er.message; } render(); } }, _t("Create a RACI matrix")) : null);
  const names = {}; A.steps.forEach((s, i) => { names[s.id] = `${i + 1}. ${s.name}`; });
  const checks = S.R.raciChecks || [];
  const confirmed = S.R.workflow.confirmed.raci;
  return h("div", null,
    h("p", { class: "muted" }, _t("Who is Responsible, Accountable, Consulted and Informed for each step. Every step needs exactly one Accountable role and at least one Responsible role.")),
    h("p", null, confirmed ? h("span", { class: "src conf" }, S.R.meta.status === "validated" ? RL("raciStatusSigned") : _t("Stage confirmed")) : m.edited ? h("span", { class: "src user" }, _t("User amended")) : h("span", { class: "src ai" }, _t("AI assumption")),
      " ", h("span", { class: "muted small" }, confirmed ? (S.R.meta.status === "validated" ? "" : RL("raciStatusStage", { who: S.names[confirmed.by] || _t("the team"), date: new Date((confirmed.at || 0) * 1000).toLocaleDateString(uiLocale(), { day: "numeric", month: "short", year: "numeric" }) }))
        : _t("Suggested by the AI until the team confirms it."))),
    h("div", { class: "tablewrap" }, h("table", { class: "raci" },
      h("thead", null, h("tr", null, h("th", null, _t("Step")), m.roles.map(r => h("th", null, r)))),
      h("tbody", null, m.rows.map(row => h("tr", null, h("td", null, h("b", null, names[row.stepId] || "")),
        m.roles.map(r => { const v = row.cells[r] || ""; return h("td", { class: "rc rc-" + v.replace("/", ""), title: RACI_TIP[v] || _t("Not involved") }, v); })))))),
    h("p", { class: "raciKey muted small" }, Object.entries(RACI_TIP).map(([k, v]) => h("span", null, h("b", { class: "rc rc-" + k.replace("/", "") }, k), " " + v))),
    h("h2", null, RL("raciChecks").replace(/ \(.*\)$/, "") + " ", h("span", { class: "src calc" }, _t("Calculated"))),
    h("p", { class: "muted small" }, RL("raciChecksWhat")),
    checks.length ? h("ul", { class: "gaps" }, checks.map(c => h("li", null, c.text))) : h("p", { class: "okline" }, RL("raciOk")),
    (m.observations || []).length ? h("div", null, h("h2", null, RL("raciObs").replace(/ \(.*\)$/, "") + " ", h("span", { class: "src ai" }, _t("AI assumption"))),
      h("p", { class: "muted small" }, RL("raciObsWhat")), h("ul", { class: "gaps" }, m.observations.map(o => h("li", null, o)))) : null,
    canWrite() ? h("button", { class: "btn", onclick: () => { startEdit(); S.tab = "raci"; render(); } }, _t("Edit the RACI matrix")) : null);
}
function raciEdit(A) {
  const m = A.raci;
  const roleInput = (i) => { const t = h("input", { class: "ed", type: "text", "aria-label": _t("Role {0}", [i + 1]), oninput: e => {
    const old = m.roles[i], nw = e.target.value; m.roles[i] = nw; m.rows.forEach(r => { r.cells[nw] = r.cells[old] || ""; if (old !== nw) delete r.cells[old]; }); m.edited = true; touch(); } }); t.value = m.roles[i]; return t; };
  return h("div", { class: "editwrap" },
    h("p", { class: "muted" }, _t("Choose R, A, R/A, C or I for each step and role. Rename, add or remove roles in the header.")),
    h("div", { class: "tablewrap" }, h("table", { class: "raci edit" },
      h("thead", null, h("tr", null, h("th", null, _t("Step")), m.roles.map((r, i) => h("th", null, roleInput(i),
        h("button", { class: "btn link red", onclick: () => { const old = m.roles[i]; m.roles.splice(i, 1); m.rows.forEach(rw => delete rw.cells[old]); m.edited = true; touch(); render(); } }, _t("Remove")))))),
      h("tbody", null, m.rows.map(row => { const st = A.steps.find(s => s.id === row.stepId); return h("tr", null, h("td", null, h("b", null, st ? st.name : "")),
        m.roles.map(r => h("td", null, h("select", { class: "ed", "aria-label": `${r}, ${st ? st.name : ""}`, onchange: e => { row.cells[r] = e.target.value; m.edited = true; touch(); } },
          RACI_VALUES.map(v => h("option", { value: v, selected: (row.cells[r] || "") === v }, v || "\u2013")))))); })))),
    h("button", { class: "btn", onclick: () => { let n = "New role", k = 2; while (m.roles.includes(n)) n = `New role ${k++}`; m.roles.push(n); m.rows.forEach(r => { r.cells[n] = ""; }); m.edited = true; touch(); render(); } }, _t("+ Add a role")),
    h("p", { class: "muted small" }, _t("Steps added or removed on the Steps tab appear here after saving.")));
}
function topPriority(s) {
  const aps = s.failureModes.map(f => f.ap);
  return aps.includes("H") ? "H" : aps.includes("M") ? "M" : aps.length ? "L" : "";
}
function processFlow(A) {
  const kids = [];
  A.steps.forEach((s, i) => {
    if (i) kids.push(h("span", { class: "farrow", "aria-hidden": "true" }, "→"));
    const p = topPriority(s);
    kids.push(h("button", { class: "fstep p" + p, title: s.function || "", onclick: () => {
      S.tab = "worksheet"; S.filter = "all"; render();
      const el = document.getElementById("step-" + i); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    } },
      h("span", { class: "fnum" }, i + 1),
      ["decision", "wait", "handoff", "automated"].includes(s.type) ? h("span", { class: "ftype" }, typeT(s.type)) : null,
      h("span", { class: "fname" }, s.name),
      h("span", { class: "factor" }, s.actor || "")));
  });
  return h("div", { class: "flow" }, kids,
    h("div", { class: "flegend" }, RL("glanceNote")));
}
function zone(sv, ov) { const p = sv * ov; return (sv >= 9 && ov >= 4) || p >= 50 ? "z3" : (p >= 20 || sv >= 9) ? "z2" : "z1"; }
function riskMap(fms) {
  const counts = {};
  fms.forEach(({ f }) => { const k = f.severity + ":" + f.occurrence; counts[k] = (counts[k] || 0) + 1; });
  const cells = [];
  for (let sv = 10; sv >= 1; sv--) {
    cells.push(h("div", { class: "max" }, sv));
    for (let ov = 1; ov <= 10; ov++) {
      const n = counts[sv + ":" + ov] || 0;
      cells.push(n ? h("button", { class: "mc on " + zone(sv, ov), title: _t("{0} risk{1}: severity {2}, occurrence {3}", [n, _pl(n > 1 ? "s" : ""), sv, ov]),
        onclick: () => { S.tab = "worksheet"; S.filter = `cell:${sv}:${ov}`; render(); window.scrollTo(0, 0); } }, n)
        : h("div", { class: "mc " + zone(sv, ov) }));
    }
  }
  cells.push(h("div", { class: "max" }));
  for (let ov = 1; ov <= 10; ov++) cells.push(h("div", { class: "max" }, ov));
  const pr = { H: 0, M: 0, L: 0 };
  fms.forEach(({ f }) => { pr[f.ap]++; });
  const tot = fms.length || 1;
  return h("div", { class: "riskwrap" },
    h("div", { class: "rmwrap" }, h("div", { class: "rmy" }, _t("Severity")), h("div", null, h("div", { class: "rm" }, cells), h("div", { class: "rmx" }, _t("How often it happens (occurrence)")))),
    h("div", { class: "rside" },
      h("h3", null, RL("byPriority")),
      h("div", { class: "pbar" }, ["H", "M", "L"].map(k => pr[k] ? h("span", { class: "p" + k, style: `width:${100 * pr[k] / tot}%` }, pr[k]) : null)),
      h("ul", { class: "plist" }, h("li", null, h("span", { class: "sw pH" }), RL("pHigh", { n: pr.H })), h("li", null, h("span", { class: "sw pM" }), RL("pMed", { n: pr.M })), h("li", null, h("span", { class: "sw pL" }), RL("pLow", { n: pr.L }))),
      h("p", { class: "muted small" }, RL("mapDetNote"))));
}
function signoffPanel(meta) {
  const box = h("section", { class: "signoff" }, h("h2", null, RL("signoff")));
  if (meta.status === "validated" && meta.signoff) {
    box.append(h("p", null, h("b", null, RL("validatedBy", { name: name(meta.signoff.by), date: new Date(meta.signoff.at).toLocaleDateString(langOf(rlang())[2], { day: "numeric", month: "long", year: "numeric" }) }))));
    if (meta.signoff.note) box.append(h("p", { class: "muted" }, meta.signoff.note));
    if (meta.changedSinceSignoff) box.append(h("p", { class: "warnline" }, RL("changedWarn")));
  } else box.append(h("p", { class: "muted" }, RL("notValidated")));
  if (canWrite()) {
    if (S.signing) {
      const ta = h("textarea", { class: "short", placeholder: _t("Optional note, e.g. \"Reviewed in the ops meeting with finance and support\"") });
      box.append(ta, h("div", { class: "row actions" }, h("button", { class: "btn primary", onclick: () => signOff(ta.value.trim()) }, _t("Confirm sign-off")), h("button", { class: "btn", onclick: () => { S.signing = false; render(); } }, _t("Cancel"))));
    } else box.append(h("button", { class: "btn", onclick: () => { S.signing = true; render(); } }, meta.status === "validated" ? _t("Sign off again") : _t("Sign off as validated")));
  }
  return box;
}
function noteItem(c) { return h("div", { class: "noteitem" }, h("p", null, c.text), h("span", { class: "muted small" }, `${name(c.by)} · ${when(c.at)}`)); }
function sodSelect(label, f, key) {
  const s = h("select", { "aria-label": _t(label), disabled: !canWrite(), onchange: e => {
    const old = f[key]; f[key] = +e.target.value; f.ap = apFor(f); f.edited = true;
    queueSave(`${label} on "${f.mode}" ${old} → ${f[key]}`); render();
  } });
  for (let i = 1; i <= 10; i++) s.append(h("option", { value: i, selected: f[key] === i }, i));
  return h("label", { class: "sod", title: RL({ Severity: "sevFull", Occurrence: "occFull", Detection: "hDet" }[label]) }, RL({ Severity: "hSev", Occurrence: "hFreq", Detection: "hDetShort" }[label]), s);
}
function walkActive() { return S.R.workflow.stage === "risk" && !S.showAllSteps && S.filter === "all"; }
function walkIndex(A) {
  if (S.walk == null || S.walk >= A.steps.length) {
    const i = A.steps.findIndex(x => !S.R.workflow.reviewed[x.id]);
    S.walk = i >= 0 ? i : 0;
  }
  return S.walk;
}
function walkGo(i) { S.walk = i; render(); window.scrollTo(0, 0); }
function walkNav(A) {
  const wf = S.R.workflow, i = walkIndex(A), n = A.steps.length;
  return h("section", { class: "walk" },
    h("div", { class: "walkhead" }, h("span", { class: "stagetag" }, _t("Step {0} of {1}", [i + 1, n])), h("h2", null, A.steps[i].name)),
    h("p", { class: "muted small" }, _t("The AI has analysed what can go wrong in this step. Check each risk with the people who do the work: correct the wording, ratings and actions in Edit, add notes where it's wrong, then mark the step as reviewed to move to the next one.")),
    h("div", { class: "walksteps", role: "list" }, A.steps.map((st, j) => h("button", { role: "listitem", class: "wchip" + (j === i ? " cur" : "") + (wf.reviewed[st.id] ? " ok" : ""),
      title: st.name + (wf.reviewed[st.id] ? _t(" (reviewed)") : ""), "aria-current": j === i ? "step" : null, onclick: () => walkGo(j) }, wf.reviewed[st.id] ? "\u2713" : j + 1))),
    h("div", { class: "row actions" },
      h("button", { class: "btn", disabled: i === 0, onclick: () => walkGo(i - 1) }, _t("← Previous step")),
      h("button", { class: "btn", disabled: i === n - 1, onclick: () => walkGo(i + 1) }, _t("Next step →")),
      h("button", { class: "btn link", onclick: () => { S.showAllSteps = true; render(); } }, _t("Show all steps at once"))));
}
function worksheetTab(A) {
  const wf = S.R.workflow, nRev = A.steps.filter(s => wf.reviewed[s.id]).length;
  const walking = walkActive();
  const wrap = h("div", null,
    wf.stage === "risk" ? h("div", { class: "revbar" }, h("div", { class: "prog big" }, h("i", { style: `width:${A.steps.length ? 100 * nRev / A.steps.length : 0}%` })),
      h("span", null, h("b", null, _t("{0} of {1}", [nRev, A.steps.length])), _t(" steps reviewed"))) : null,
    walking ? walkNav(A) : null,
    wf.stage === "risk" && S.showAllSteps ? h("p", null, h("button", { class: "btn link", onclick: () => { S.showAllSteps = false; render(); } }, _t("Back to one step at a time"))) : null,
    walking ? null : h("div", { class: "filters" }, [["all", "All"], ["H", "High priority"], ["notes", "With notes"], ["low", "Low confidence"]].map(([k, l]) =>
      h("button", { class: "fchip", "aria-pressed": S.filter === k ? "true" : "false", onclick: () => { S.filter = k; render(); } }, _t(l))),
      S.filter.startsWith("cell:") ? h("button", { class: "fchip", "aria-pressed": "true", onclick: () => { S.filter = "all"; render(); } },
        _t("Severity {0} × occurrence {1}  ✕", [S.filter.split(":")[1], S.filter.split(":")[2]])) : null));
  const known = new Set();
  let shown = 0;
  A.steps.forEach((s, si) => {
    if (walking && si !== walkIndex(A)) { s.failureModes.forEach(f => known.add(f.id)); return; }
    const fmsShown = s.failureModes.filter(f => {
      known.add(f.id);
      if (S.filter === "H") return f.ap === "H";
      if (S.filter === "notes") return S.R.comments.some(c => c.fmId === f.id);
      if (S.filter === "low") return f.confidence === "low";
      if (S.filter.startsWith("cell:")) { const [, sv, ov] = S.filter.split(":"); return f.severity === +sv && f.occurrence === +ov; }
      return true;
    });
    if (S.filter !== "all" && !fmsShown.length) return;
    shown++;
    const card = h("article", { class: "stepcard", id: "step-" + si },
      h("div", { class: "stephead" }, h("div", { class: "num" }, si + 1),
        h("div", null, h("h3", null, s.name), h("div", { class: "muted small" }, [s.actor, typeT(s.type).toLowerCase()].filter(Boolean).join(", ")), h("p", { class: "fn" }, RL("purpose", { x: s.function || "" })))),
      h("div", { class: "io" },
        h("div", null, h("h4", null, RL("inputs")), h("div", { class: "chips" }, (s.inputs.length ? s.inputs : [RL("notDescribed")]).map(x => h("span", { class: "chip2" }, x)))),
        h("div", null, h("h4", null, RL("outputs")), h("div", { class: "chips" }, (s.outputs.length ? s.outputs : [RL("notDescribed")]).map(x => h("span", { class: "chip2" }, x))))));
    fmsShown.forEach(f => card.append(fmBlock(f)));
    if (canWrite()) card.append(h("div", { class: "addrisk" }, h("button", { class: "btn", onclick: () => addExtraRisk(si) }, _t("+ Add extra risk"))));
    card.append(inlineRiskEditor(si));
    card.append(reviewControl(s));
    wrap.append(card);
  });
  const orphans = S.R.comments.filter(c => c.fmId !== "general" && !known.has(c.fmId));
  if (orphans.length && S.filter === "all") wrap.append(h("section", { class: "panel" }, h("h3", null, _t("Notes on items no longer in the analysis")), orphans.map(noteItem)));
  if (!shown) wrap.append(h("p", { class: "muted" }, _t("Nothing matches this filter.")));
  return wrap;
}
function addExtraRisk(si) {
  if (!canWrite()) return;
  S.inlineRisk = { si, r: newRisk() };
  render();
  setTimeout(() => { const el = document.querySelector(".inlinerisk textarea"); if (el) el.focus(); }, 50);
}
function inlineRiskEditor(si) {
  const ir = S.inlineRisk;
  if (!ir || ir.si !== si) return null;
  const f = ir.r;
  const fld = (key, label, opts) => h("label", { class: "inlinef" + (opts && opts.wide ? " wide" : "") },
    h("span", null, _t(label)),
    opts && opts.multi
      ? h("textarea", { value: f[key], rows: 2, oninput: e => { f[key] = e.target.value; } })
      : h("input", { type: "number", min: 1, max: 10, value: f[key], oninput: e => { f[key] = Math.max(1, Math.min(10, +e.target.value || 5)); } }));
  return h("div", { class: "inlinerisk panel" },
    h("h3", null, _t("Add a risk to step {0}", [si + 1])),
    fld("mode", "Description", { multi: true, wide: true }),
    h("div", { class: "edgrid" }, fld("severity", "Severity"), fld("occurrence", "Occurrence"), fld("detection", "Detection")),
    fld("action", "Recommended action", { multi: true, wide: true }),
    h("div", { class: "row" },
      h("button", { class: "btn", disabled: S.busy, onclick: () => saveInlineRisk() }, S.busy ? _t("Saving…") : _t("Save risk")),
      h("button", { class: "btn link", onclick: () => { S.inlineRisk = null; render(); } }, _t("Cancel"))));
}
async function saveInlineRisk() {
  const ir = S.inlineRisk;
  if (!ir) return;
  if (!ir.r.mode.trim()) { S.status = _t("Describe the risk first."); S.statusErr = true; render(); return; }
  await flushNow();
  S.busy = true; S.status = ""; S.statusErr = false; render();
  try {
    const A = JSON.parse(JSON.stringify(S.R.analysis));
    A.steps[ir.si].failureModes.push(ir.r);
    const d = await api("PUT", "/api/reviews/" + S.R.meta.id + "/content",
      { analysis: A, rev: S.R.meta.rev, log: ["added 1 risk"] });
    setReview(d);
    S.inlineRisk = null; S.busy = false;
    S.flash = _t("Risk added to step {0}.", [ir.si + 1]);
    render();
  } catch (e) {
    S.busy = false; S.status = e.message; S.statusErr = true; render();
  }
}
function fmBlock(f) {
  const notes = S.R.comments.filter(c => c.fmId === f.id);
  const open = S.openNotes.has(f.id);
  const ta = h("textarea", { class: "short", placeholder: _t("Add a note: is this right? How does it really happen?") });
  return h("div", { class: "fm" + (f.ap === "H" ? " hi" : f.ap === "M" ? " mid" : "") },
    h("div", { class: "fmtop" },
      h("div", { class: "mode" }, h("small", null, RL("hWhat"),
        f.confidence === "low" ? h("span", { class: "conf low", title: _t("Mostly assumed from limited detail: check with the team") }, RL("confLow")) :
          f.confidence === "high" ? h("span", { class: "conf high" }, RL("confHigh")) : null,
        f.edited ? h("span", { class: "conf edited" }, RL("ratingsEdited")) : null), f.mode),
      h("div", { class: "score" }, sodSelect("Severity", f, "severity"), sodSelect("Occurrence", f, "occurrence"), sodSelect("Detection", f, "detection"),
        h("div", { class: "rpnbox" }, h("b", null, rpn(f)), h("small", null, RL("hScore"))), h("span", { class: "ap " + f.ap, title: RL("hPriority") }, apT(f.ap)))),
    h("div", { class: "fmgrid" },
      [[RL("hEffects"), f.effects], [RL("hCauses"), f.causes], [RL("hPrevFull"), f.preventionControls], [RL("hDetFull"), f.detectionControls]].map(([k, v]) => h("div", null, h("h4", null, k), h("p", null, v || _t("None"))))),
    hasAction(f) ? actionBox(f) : null,
    h("div", { class: "notesbar" },
      h("button", { class: "btn link", "aria-expanded": open ? "true" : "false", onclick: () => { open ? S.openNotes.delete(f.id) : S.openNotes.add(f.id); render(); } },
        notes.length ? _t("{0} note{1}", [notes.length, _pl(notes.length > 1 ? "s" : "")]) : _t("Add a note"), open ? " ▴" : " ▾")),
    open ? h("div", { class: "notes" }, notes.map(noteItem), canWrite() ? h("div", { class: "addnote" }, ta, h("button", { class: "btn", onclick: () => addNote(f.id, ta) }, _t("Add note"))) : null) : null);
}
function actionBox(f) {
  const overdue = f.due && f.status !== "done" && f.status !== "wont_do" && f.due < new Date().toISOString().slice(0, 10);
  const short = (f.action || "").slice(0, 40) + ((f.action || "").length > 40 ? "…" : "");
  return h("div", { class: "action" },
    h("p", null, h("b", null, RL("recAction") + " "), f.action),
    h("div", { class: "arow" },
      h("label", null, RL("hOwner"), h("input", { type: "text", value: f.owner || "", disabled: !canWrite(), onchange: e => { const o = f.owner; f.owner = e.target.value.trim(); f.ownerSet = true; queueSave(`Owner of "${short}" ${o || "unset"} → ${f.owner || "unset"}`); } })),
      h("label", null, RL("hDue"), h("input", { type: "date", value: f.due || "", class: overdue ? "overdue" : "", disabled: !canWrite(), onchange: e => { f.due = e.target.value; queueSave(`Due date of "${short}" set to ${f.due || "none"}`); render(); } })),
      h("label", null, RL("hStatus"), h("select", { disabled: !canWrite(), class: "st " + (f.status || "open"), onchange: e => { const o = f.status; f.status = e.target.value; queueSave(`"${short}" ${STATUS[o || "open"]} → ${STATUS[f.status]}`); render(); } },
        Object.keys(STATUS).map(k => h("option", { value: k, selected: (f.status || "open") === k }, STAT(k)))))),
    overdue ? h("p", { class: "warnline small" }, RL("overdue")) : null);
}
function actionsTab(A) {
  const items = allFms(A).filter(x => hasAction(x.f));
  const done = items.filter(x => x.f.status === "done").length;
  const pct = items.length ? Math.round(100 * done / items.length) : 0;
  const order = { H: 0, M: 1, L: 2 };
  return h("div", null,
    h("div", { class: "progwrap" }, h("div", { class: "prog big" }, h("i", { style: `width:${pct}%` })), h("p", null, h("b", null, RL("actionsDone", { n: done, total: items.length })))),
    ["open", "in_progress", "done", "wont_do"].map(g => {
      const list = items.filter(x => (x.f.status || "open") === g).sort((a, b) => order[a.f.ap] - order[b.f.ap] || rpn(b.f) - rpn(a.f));
      if (!list.length) return null;
      return h("section", { class: "agroup" }, h("h2", null, STAT(g), h("span", { class: "count" }, list.length)),
        list.map(({ s, si, f }) => h("div", { class: "aitem" },
          h("div", { class: "t" }, h("span", { class: "apt " + f.ap }, f.ap), " ", f.mode, h("span", { class: "muted small" }, _t(" · step {0}, {1}", [si + 1, s.name]))),
          actionBox(f))));
    }),
    !items.length ? h("p", { class: "muted" }, _t("No actions recommended yet.")) : null);
}
function activityTab() {
  const label = { created: "Created", edit: "Edited", text: _t("Text edited"), ai: "AI update", signoff: "Signed off", lens: "Audience version", file: _t("File") };
  return h("div", null, filesBlock(), h("h2", null, _t("Activity")), S.R.history.length ? h("ol", { class: "history" }, S.R.history.map(x => h("li", { class: "hitem " + (x.kind || "") },
    h("div", { class: "hmeta" }, h("span", { class: "htag" }, label[x.kind] || _t("Change")), h("span", { class: "muted small" }, `${name(x.by)} · ${when(x.at)}`)),
    h("p", null, x.summary || "")))) : h("p", { class: "muted" }, _t("No activity yet.")));
}

const EXAMPLE = `Customer refund process (current state)

1. Customer emails support asking for a refund.
2. Support agent checks the order in Shopify and copies details into a Google Sheet.
3. Agent emails the finance team with the sheet row number.
4. Finance checks the inbox once a day, reviews the request.
5. If refund is over £200, finance forwards to the operations manager for approval (manager is often travelling).
6. Once approved, finance issues the refund manually in Stripe.
7. Finance replies to the support agent that it's done.
8. Support agent emails the customer to confirm.
9. At month end, finance reconciles the Google Sheet against Stripe by hand.

Average time from request to refund: 6 business days. About 15% of requests are chased by the customer at least once.`;