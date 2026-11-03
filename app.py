"""
UAIM: living process reviews (built on the PFMEA method internally).

Run locally:   python app.py            (then open http://localhost:5000)
Production:    gunicorn -w 2 -t 300 -b 127.0.0.1:8000 app:app
Configure everything in .env (see .env.example).
"""
import copy
import hashlib
import json
import os
import secrets
import sqlite3
import time
from functools import wraps

from flask import Flask, g, jsonify, redirect, request, send_from_directory, session
from markupsafe import escape
from werkzeug.security import check_password_hash, generate_password_hash

import ai
import allowances
import billing
import legal
import storage
import flow
import insights
import sipoc as sipocmod
import raci
import mailer
import share_card

BASE = os.path.dirname(os.path.abspath(__file__))


def load_env():
    path = os.path.join(BASE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

def secret_key():
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(BASE, ".secret_key")
    if not os.path.exists(path):
        with open(path, "w") as fh:
            fh.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    with open(path) as fh:
        return fh.read().strip()


app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config.update(
    SECRET_KEY=secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 14,
    MAX_CONTENT_LENGTH=30 * 1024 * 1024,
)
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE, "processcheck.db"))
ALLOW_SIGNUP = os.environ.get("ALLOW_SIGNUP", "1") == "1"

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT UNIQUE NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id), role TEXT NOT NULL DEFAULT 'member', created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT, headline TEXT, score INTEGER, high INTEGER, fm_count INTEGER,
  actions_total INTEGER, actions_done INTEGER,
  status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, changed_since_signoff INTEGER NOT NULL DEFAULT 0,
  signoff_by INTEGER, signoff_at REAL, signoff_note TEXT,
  created_by INTEGER, created_at REAL, updated_by INTEGER, updated_at REAL,
  analysis_json TEXT NOT NULL, inputs_json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  fm_id TEXT NOT NULL, text TEXT NOT NULL, user_id INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS history(
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, summary TEXT, user_id INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL, expires_at REAL NOT NULL, used_at REAL, created_at REAL NOT NULL, ip TEXT);
CREATE TABLE IF NOT EXISTS review_versions(
  id INTEGER PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  analysis_json TEXT NOT NULL, reason TEXT, user_id INTEGER, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_versions_review ON review_versions(review_id, version);
CREATE TABLE IF NOT EXISTS create_requests(
  company_id INTEGER NOT NULL, key TEXT NOT NULL, review_id INTEGER, created_at REAL NOT NULL, PRIMARY KEY(company_id, key));
CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS labels(
  key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_reviews_company ON reviews(company_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_comments_review ON comments(review_id);
CREATE INDEX IF NOT EXISTS ix_history_review ON history(review_id);
CREATE TABLE IF NOT EXISTS page_views(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, path TEXT NOT NULL, method TEXT,
  user_id INTEGER, company_id INTEGER, ip_hash TEXT, ua TEXT);
CREATE INDEX IF NOT EXISTS ix_views_ts ON page_views(ts);
CREATE TABLE IF NOT EXISTS login_events(
  id INTEGER PRIMARY KEY, ts REAL NOT NULL, event TEXT NOT NULL, ok INTEGER NOT NULL,
  user_id INTEGER, company_id INTEGER, email TEXT);
CREATE INDEX IF NOT EXISTS ix_logins_ts ON login_events(ts);
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=15)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def close_db(_):
    conn = g.pop("db", None)
    if conn:
        conn.close()


# Bump this whenever the database layout changes. Existing databases are backed up before they're upgraded.
SCHEMA_VERSION = 14
BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "backups"))


def backup_db(conn, label):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    path = os.path.join(BACKUP_DIR, f"processcheck-{label}-{time.strftime('%Y%m%d-%H%M%S')}-{os.getpid()}.db")
    dst = sqlite3.connect(path)
    with dst:
        conn.backup(dst)
    dst.close()
    return path


def init_db():
    existed = os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 0
    conn = sqlite3.connect(DB_PATH)
    if existed:
        try:
            row = conn.execute("SELECT value FROM app_meta WHERE key='schema'").fetchone()
        except sqlite3.OperationalError:
            row = None
        has_users = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
        if has_users and (not row or int(row[0]) < SCHEMA_VERSION):
            backup_db(conn, f"before-upgrade-to-{SCHEMA_VERSION}")
    conn.executescript(SCHEMA)
    conn.executescript(legal.SCHEMA)  # new table only: existing accounts and data are untouched
    conn.executescript(storage.SCHEMA)  # new table only
    conn.executescript(allowances.SCHEMA)  # new tables only: balances and payments are untouched
    conn.commit()
    billing.migrate(conn)
    conn.execute("INSERT OR REPLACE INTO app_meta(key, value) VALUES('schema', ?)", (str(SCHEMA_VERSION),))
    conn.commit()
    conn.close()


init_db()


# ------------------------------------------------------------------ helpers
def err(msg, code=400):
    return jsonify({"error": msg}), code


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    if "user" not in g:
        g.user = db().execute("SELECT u.*, c.name AS company_name, c.invite_code FROM users u JOIN companies c ON c.id=u.company_id WHERE u.id=?", (uid,)).fetchone()
        # A password change signs out every other session that was opened with the old password.
        if g.user and (g.user["session_version"] or 0) != session.get("sv", 0):
            session.clear()
            g.user = None
    return g.user


def login_required(role=None):
    order = {"viewer": 0, "member": 1, "admin": 2}

    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                return err("Please sign in.", 401)
            if role and order.get(u["role"], 0) < order[role]:
                return err("You don't have permission to do that.", 403)
            return fn(*a, **kw)
        return wrapper
    return deco


@app.before_request
def csrf_guard():
    # JSON API writes must come from our own page (fetch sets this header; plain cross-site forms cannot).
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "DELETE"):
        if request.headers.get("X-Requested-With") != "ProcessCheck":
            return err("Bad request.", 400)


# ------------------------------------------------------------------ usage analytics
def _log_event(con, event, ok, user_id=None, email=None):
    """One row per sign-in or sign-up attempt. Kept for the operator only:
    successful rows record who signed in and for which company."""
    cid = None
    if user_id:
        r = con.execute("SELECT company_id FROM users WHERE id=?", (user_id,)).fetchone()
        if r:
            cid = r[0]
    con.execute("INSERT INTO login_events(ts, event, ok, user_id, company_id, email) VALUES(?,?,?,?,?,?)",
                (time.time(), event, 1 if ok else 0, user_id, cid, email))


@app.before_request
def track_views():
    """Lightweight, privacy-friendly page-view logging (public pages only, never API calls).
    IP addresses are pseudonymised (salted hash, never stored in the clear), so the table
    shows unique visitors without identifying anyone. Analytics must never break the site."""
    if request.method != "GET" or request.path.startswith(("/static/", "/api/", "/favicon")):
        return
    try:
        u = current_user()
        con = db()
        ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "?").split(",")[0].strip()
        con.execute(
            "INSERT INTO page_views(ts, path, method, user_id, company_id, ip_hash, ua) VALUES(?,?,?,?,?,?,?)",
            (time.time(), request.path[:120], "GET", u["id"] if u else None,
             u["company_id"] if u else None,
             hashlib.sha256(("uaim-v1|" + ip).encode()).hexdigest()[:16],
             (request.headers.get("User-Agent") or "")[:120]))
        if int(time.time()) % 97 == 0:  # occasional housekeeping: keep 180 days of page views
            con.execute("DELETE FROM page_views WHERE ts < ?", (time.time() - 180 * 86400,))
        con.commit()
    except Exception:  # noqa: BLE001
        pass


def clamp(v):
    try:
        return max(1, min(10, int(round(float(v)))))
    except (TypeError, ValueError):
        return 1


def ap_for(f):
    s, o, d = f["severity"], f["occurrence"], f["detection"]
    if s >= 9:
        return "H" if (o >= 4 or (o >= 2 and d >= 7)) else ("M" if (o >= 2 or d >= 5) else "L")
    if s >= 7:
        return "H" if (o >= 6 or (o >= 4 and d >= 5)) else ("M" if (o >= 4 or (o >= 2 and d >= 7)) else "L")
    if s >= 4:
        return "H" if (o >= 8 and d >= 5) else ("M" if (o >= 6 or (o >= 4 and d >= 7)) else "L")
    if s >= 2:
        return "M" if (o >= 8 and d >= 5) else "L"
    return "L"


STATUSES = {"open", "in_progress", "done", "wont_do"}


def normalize(a):
    a.setdefault("steps", [])
    a.setdefault("moves", [])
    for s in a["steps"]:
        for k in ("inputs", "outputs", "failureModes", "suppliers", "customers"):
            s.setdefault(k, [])
        for f in s["failureModes"]:
            for k in ("severity", "occurrence", "detection"):
                f[k] = clamp(f.get(k))
            if f.get("ap") not in ("H", "M", "L"):
                f["ap"] = ap_for(f)
            if not f.get("id") or f.get("id") == "new":
                f["id"] = "fm" + secrets.token_hex(4)
            if f.get("status") not in STATUSES:
                f["status"] = "open"
            if f.get("confidence") not in ("high", "medium", "low"):
                f["confidence"] = "medium"
    norm_swot(a)
    return a


def apply_ai_flow(a, source_text, images_only=False):
    """Keep only the timings the AI can trace to the customer's own words (see flow.py)."""
    flow.ensure_step_ids(a)
    for s in a.get("steps", []):
        s["flow"] = flow.from_ai(s.get("flow"), source_text, images_only)
    a["dataGaps"] = flow.clean_gaps(a.get("dataGaps"), a.get("steps", []))
    return a


def clean_links(a):
    """Keep the executive summary, cost breakdown and move links tidy and pointing at steps and risks that exist."""
    sids, fids = insights.ids_of(a)
    imp = a.get("impact") if isinstance(a.get("impact"), dict) else {}
    if "breakdown" in imp:
        imp["breakdown"] = insights.clean_breakdown(imp.get("breakdown"))
    a["executive"] = insights.clean_executive(a.get("executive"), sids, fids)
    a["issueCheck"] = insights.clean_issue_check(a.get("issueCheck"))
    for m in a.get("moves", []) or []:
        if isinstance(m, dict):
            m["fixes"] = insights.clean_fixes(m.get("fixes"), sids, fids)
    a.pop("questions", None)  # no longer used
    hs = insights.health(a)
    if hs:
        a["overallScore"] = hs["total"]  # calculated from the scorecard, see insights.health
    return a


def norm_swot(a):
    a["swot"] = ai.clean_swot(a.get("swot")) if a.get("swot") else None
    return a


STEP_TYPES = {"manual", "automated", "decision", "handoff", "wait"}


def _txt(v, n):
    return str(v if v is not None else "")[:n]


def _strs(v, n_items, n_chars):
    return [_txt(x, n_chars) for x in (v if isinstance(v, list) else []) if str(x).strip()][:n_items]


def _num(v):
    try:
        x = float(v)
        return x if x >= 0 else None
    except (TypeError, ValueError):
        return None


def sanitize_content(new, stored):
    """Team text edits: keep only known fields, with sensible limits. Unknown keys are dropped."""
    out = {"meta": stored.get("meta") or {}}
    for k, n in (("processName", 200), ("processScope", 500), ("headline", 400)):
        out[k] = _txt(new.get(k), n)
    try:
        out["overallScore"] = max(0, min(100, int(round(float(new.get("overallScore"))))))
    except (TypeError, ValueError):
        out["overallScore"] = stored.get("overallScore", 0)
    out["keyFindings"] = _strs(new.get("keyFindings"), 10, 500)
    out["assumptions"] = _strs(new.get("assumptions"), 12, 500)
    out["questions"] = _strs(new.get("questions"), 12, 500)
    imp = new.get("impact") if isinstance(new.get("impact"), dict) else {}
    out["impact"] = {"hoursLostPerMonth": _num(imp.get("hoursLostPerMonth")), "annualCost": _num(imp.get("annualCost")),
                     "cycleTimeNow": _txt(imp.get("cycleTimeNow"), 80), "cycleTimeTarget": _txt(imp.get("cycleTimeTarget"), 80),
                     "basis": _txt(imp.get("basis"), 800), "breakdown": insights.clean_breakdown(imp.get("breakdown"))}
    steps = []
    stored_steps = {x.get("id"): x for x in stored.get("steps", []) if x.get("id")}
    stored_base = {f.get("id"): f.get("baseline") for x in stored.get("steps", []) for f in x.get("failureModes", []) if isinstance(f.get("baseline"), dict)}
    for s in (new.get("steps") if isinstance(new.get("steps"), list) else [])[:30]:
        if not isinstance(s, dict):
            continue
        sid = s.get("id") if isinstance(s.get("id"), str) and s.get("id") in stored_steps else None
        prev_flow = (stored_steps.get(sid) or {}).get("flow") if sid else None
        st = {"id": sid, "flow": flow.from_user(s.get("flow"), prev_flow),
              "name": _txt(s.get("name"), 160) or "Untitled step", "actor": _txt(s.get("actor"), 120),
              "type": s.get("type") if s.get("type") in STEP_TYPES else "manual", "function": _txt(s.get("function"), 500),
              "inputs": _strs(s.get("inputs"), 15, 200), "outputs": _strs(s.get("outputs"), 15, 200),
              "suppliers": _strs(s.get("suppliers"), 15, 200), "customers": _strs(s.get("customers"), 15, 200),
              "textEdited": bool(s.get("textEdited")), "failureModes": []}
        for f in (s.get("failureModes") if isinstance(s.get("failureModes"), list) else [])[:12]:
            if not isinstance(f, dict):
                continue
            fm = {"id": _txt(f.get("id"), 40) or "new"}
            if stored_base.get(fm["id"]):
                fm["baseline"] = stored_base[fm["id"]]
            for k, n in (("mode", 300), ("effects", 500), ("causes", 500), ("preventionControls", 400),
                         ("detectionControls", 400), ("action", 500), ("owner", 120)):
                fm[k] = _txt(f.get(k), n)
            for k in ("severity", "occurrence", "detection"):
                fm[k] = clamp(f.get(k))
            fm["ap"] = f.get("ap") if f.get("ap") in ("H", "M", "L") and not f.get("edited") else ap_for(fm)
            fm["status"] = f.get("status") if f.get("status") in STATUSES else "open"
            fm["due"] = _txt(f.get("due"), 10)
            fm["confidence"] = f.get("confidence") if f.get("confidence") in ("high", "medium", "low") else "medium"
            for k in ("edited", "ownerSet", "textEdited"):
                if f.get(k):
                    fm[k] = True
            if not fm["action"]:
                fm["action"] = "None"
            st["failureModes"].append(fm)
        steps.append(st)
    if not steps:
        raise ValueError("A review needs at least one step.")
    out["steps"] = steps
    moves = []
    for m in (new.get("moves") if isinstance(new.get("moves"), list) else [])[:10]:
        if isinstance(m, dict) and str(m.get("title") or "").strip():
            moves.append({"title": _txt(m.get("title"), 200), "detail": _txt(m.get("detail"), 800), "benefit": _txt(m.get("benefit"), 400),
                          "owner": _txt(m.get("owner"), 120), "timeframe": _txt(m.get("timeframe"), 40),
                          "impact": m.get("impact") if m.get("impact") in ("high", "medium", "low") else "medium",
                          "effort": m.get("effort") if m.get("effort") in ("high", "medium", "low") else "medium",
                          "fixes": m.get("fixes") if isinstance(m.get("fixes"), dict) else {}})
    out["moves"] = moves
    out["executive"] = new.get("executive") if isinstance(new.get("executive"), dict) else stored.get("executive")
    out["issueCheck"] = new.get("issueCheck") if isinstance(new.get("issueCheck"), list) else stored.get("issueCheck")
    dims = []
    for d in (new.get("dimensions") if isinstance(new.get("dimensions"), list) else [])[:10]:
        if isinstance(d, dict) and str(d.get("name") or "").strip():
            dims.append({"name": _txt(d.get("name"), 80), "score": max(1, min(10, clamp(d.get("score")))), "note": _txt(d.get("note"), 300)})
    out["dimensions"] = dims
    out["swot"] = ai.clean_swot(new.get("swot")) if new.get("swot") else None
    out["dataGaps"] = stored.get("dataGaps") or []
    if isinstance(stored.get("flowBaseline"), dict):
        out["flowBaseline"] = stored["flowBaseline"]
    flow.ensure_step_ids(out)
    clean_links(out)
    out["sipoc"] = sipocmod.clean(new.get("sipoc"))
    out["openPoints"] = stored.get("openPoints") or []
    flow.ensure_step_ids(out)
    if new.get("raci") or stored.get("raci"):
        cleaned = raci.clean(new.get("raci") or stored.get("raci"), out["steps"], stored.get("raci"))
        before = raci.clean(stored.get("raci"), out["steps"]) if stored.get("raci") else None
        strip = lambda x: {k: v for k, v in (x or {}).items() if k != "edited"}
        if cleaned and strip(cleaned) != strip(before):
            cleaned["edited"] = True
        out["raci"] = cleaned
    return normalize(out)


def all_fms(a):
    return [f for s in a.get("steps", []) for f in s.get("failureModes", [])]


def has_action(f):
    return bool(f.get("action")) and f.get("action") != "None"


def meta_from(a):
    fms = all_fms(a)
    acts = [f for f in fms if has_action(f)]
    return dict(title=(a.get("processName") or "Untitled process")[:200], headline=(a.get("headline") or "")[:400],
                score=int(round(float(a.get("overallScore") or 0))), high=sum(1 for f in fms if f["ap"] == "H"),
                fm_count=len(fms), actions_total=len(acts), actions_done=sum(1 for f in acts if f["status"] == "done"))


def get_review(rid, u):
    return db().execute("SELECT * FROM reviews WHERE id=? AND company_id=?", (rid, u["company_id"])).fetchone()


def snapshot(r, reason, uid):
    """Keep a copy of the review as it was before a new version replaces it."""
    db().execute("INSERT INTO review_versions(review_id, version, analysis_json, reason, user_id, created_at) VALUES(?,?,?,?,?,?)",
                 (r["id"], r["version"], r["analysis_json"], reason, uid, time.time()))


def log(rid, kind, summary, uid):
    db().execute("INSERT INTO history(review_id,kind,summary,user_id,created_at) VALUES(?,?,?,?,?)",
                 (rid, kind, (summary or "")[:2000], uid, time.time()))


def ms(t):
    return int(t * 1000) if t else None


STAGES = ["steps", "sipoc", "risk", "flow", "swot", "raci", "complete"]
STAGE_NAMES = {"steps": "process steps", "sipoc": "SIPOC", "risk": "risk analysis", "flow": "value stream", "swot": "SWOT and summary", "raci": "RACI"}


def get_wf(r):
    """Where a review is in the step-by-step journey. Reviews made before the journey existed count as complete."""
    try:
        wf = json.loads(r["workflow"]) if r["workflow"] else None
    except (TypeError, ValueError, IndexError, KeyError):
        wf = None
    if not isinstance(wf, dict) or wf.get("stage") not in STAGES:
        wf = {"stage": "complete", "legacy": True}
    wf.setdefault("confirmed", {})
    wf.setdefault("reviewed", {})
    # the furthest stage the review has ever reached (going back doesn't reduce it)
    wf["reached"] = max(int(wf.get("reached") or 0), STAGES.index(wf["stage"]))
    return wf


def step_sig(s):
    return (s.get("name") or "") + "|" + (s.get("function") or "") + "|" + (s.get("actor") or "")


def review_meta(r):
    return {"id": r["id"], "title": r["title"], "headline": r["headline"], "score": r["score"], "high": r["high"],
            "fmCount": r["fm_count"], "actionsTotal": r["actions_total"], "actionsDone": r["actions_done"],
            "status": r["status"], "version": r["version"], "changedSinceSignoff": bool(r["changed_since_signoff"]),
            "signoff": {"by": r["signoff_by"], "at": ms(r["signoff_at"]), "note": r["signoff_note"]} if r["signoff_at"] else None,
            "createdBy": r["created_by"], "createdAt": ms(r["created_at"]), "updatedBy": r["updated_by"], "updatedAt": ms(r["updated_at"]),
            "rev": r["rev"], "reruns": r["reruns"], "lang": r["lang"] or "en", "stage": get_wf(r)["stage"]}


def names_for(company_id):
    rows = db().execute("SELECT id, name FROM users WHERE company_id=?", (company_id,)).fetchall()
    return {str(r["id"]): r["name"] for r in rows}


def public_user(u):
    return {"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "company": u["company_name"],
            "position": u["position"]}


# ------------------------------------------------------------------ pages
@app.route("/")
def landing():
    """The public website. Prices come from billing.PLANS, so they're always the ones customers will pay."""
    with open(os.path.join(app.static_folder, "landing.html"), encoding="utf-8") as fh:
        page = fh.read()
    P = billing.PLANS
    each = lambda k: f'{P[k]["price"] / P[k]["credits"]:.2f}'.replace(".00", "")
    for k, v in {"SYM": billing.currency_symbol(), "SINGLE": P["single"]["price"], "PACK5": P["pack5"]["price"], "PACK10": P["pack10"]["price"],
                 "PACK5_EACH": each("pack5"), "PACK10_EACH": each("pack10")}.items():
        page = page.replace("{{" + k + "}}", str(v))
    page = page.replace("{{PRIVACY_LINK}}", '<a href="/terms-and-privacy" data-i18n>Terms &amp; Privacy</a>' if legal.combined_version() else "")
    return page


@app.route("/app")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/terms-and-privacy")
def terms_and_privacy_page():
    """The combined Terms & Conditions and Privacy Policy: one document, one URL."""
    return legal.render("terms-privacy", legal.LEGAL_VERSION) or err("Not found.", 404)


@app.route("/terms")
def terms_page():
    return redirect("/terms-and-privacy")  # the terms now live inside the combined document


@app.route("/terms/<version>")
def terms_version_page(version):
    page = legal.render("terms", version)  # archived versions only: for acceptances recorded before the documents were combined
    return page if page is not None else err("That version doesn't exist.", 404)


@app.route("/privacy")
def privacy_page():
    return redirect("/terms-and-privacy")


@app.route("/privacy/<version>")
def privacy_version_page(version):
    page = legal.render("privacy", version)  # archived versions only
    return page if page is not None else err("That version doesn't exist.", 404)


@app.after_request
def headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# Roles offered at sign-up (kept from the old audience list; only the label is used now)
ROLES = {"general": "Prefer not to say", "ceo": "CEO / Managing Director", "cfo": "CFO / Finance Director",
         "coo": "COO / Operations Director", "quality": "Quality / Compliance Manager",
         "it": "IT / Digital Director", "hr": "HR / People Director", "owner": "Process owner / Team lead"}
AUDIENCE_LIST = [{"id": k, "label": v} for k, v in ROLES.items()]


# ------------------------------------------------------------------ auth
@app.get("/api/me")
def me():
    u = current_user()
    if not u:
        return jsonify({"user": None, "allowSignup": ALLOW_SIGNUP, "provider": os.environ.get("AI_PROVIDER", "demo"), "audiences": AUDIENCE_LIST,
                        "legal": legal.status()})
    st = legal.status()
    st["needsAcceptance"] = legal.needs_acceptance(db(), u["id"])
    st["acceptanceError"] = legal.acceptance_config_error()
    st["accepted"] = legal.latest(db(), u["id"])
    return jsonify({"user": public_user(u), "provider": os.environ.get("AI_PROVIDER", "demo"),
                    "billing": billing.summary(db(), u["company_id"], u["id"]), "audiences": AUDIENCE_LIST, "legal": st})


@app.post("/api/terms/accept")
@login_required()
def accept_terms():
    """Accepting a newer version of the Terms later (only offered when renewed acceptance is switched on)."""
    u = current_user()
    d = request.get_json(silent=True) or {}
    if d.get("acceptTerms") is not True or d.get("termsVersion") != legal.LEGAL_VERSION:
        return jsonify({"error": "Please accept the current Terms & Conditions and Privacy Policy to continue.", "field": "acceptTerms"}), 400
    # Render once and fingerprint THAT instance, so the accepted text is exactly what was served.
    page = legal.render("terms-privacy", legal.LEGAL_VERSION)
    if page is None:  # the combined document file is missing server-side
        return err("The Terms & Privacy document is unavailable right now. Please try again shortly.", 503)
    legal.record(db(), u["id"], "renewal", content=page)
    db().commit()
    return jsonify({"ok": True, "accepted": legal.latest(db(), u["id"])})


@app.post("/api/register")
def register():
    if not ALLOW_SIGNUP:
        return err("Sign-up is closed on this site.", 403)
    d = request.get_json(silent=True) or {}
    # The Terms must be actively accepted. Checked here on the server, before anything is created,
    # so a crafted request can't skip it. Only a literal true counts; the version must be the current one.
    if d.get("acceptTerms") is not True:
        return jsonify({"error": "Please accept the Terms & Conditions and acknowledge the Privacy Policy before creating your account.", "field": "acceptTerms"}), 400
    if d.get("termsVersion") != legal.LEGAL_VERSION:
        return jsonify({"error": "The Terms & Conditions have been updated since this page was opened. Please reload the page, read the current version and accept it.", "field": "acceptTerms", "termsVersion": legal.LEGAL_VERSION}), 409
    email = (d.get("email") or "").strip().lower()
    name = (d.get("name") or "").strip()[:80]
    pw = d.get("password") or ""
    if "@" not in email or len(email) > 200:
        return err("Enter a valid email address.")
    if not name:
        return err("Enter your name.")
    if len(pw) < 10:
        return err("Use a password of at least 10 characters.")
    if d.get("password2") != pw:
        return jsonify({"error": "The two passwords don't match. Type the same password in both boxes.", "field": "password2"}), 400
    con = db()
    if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        return err("An account with that email already exists. Sign in instead.")
    now = time.time()
    code = (d.get("inviteCode") or "").strip().upper()
    if code:
        c = con.execute("SELECT * FROM companies WHERE invite_code=?", (code,)).fetchone()
        if not c:
            return err("That invite code isn't valid. Check it with your colleague.")
        cid, role = c["id"], "member"
    else:
        cname = (d.get("company") or "").strip()[:120]
        if not cname:
            return err("Enter your company name, or an invite code to join a colleague's team.")
        cur = con.execute("INSERT INTO companies(name, invite_code, created_at, credits) VALUES(?,?,?,?)",
                          (cname, secrets.token_hex(4).upper(), now, billing.free_reviews() if billing.enabled() else 0))
        cid, role = cur.lastrowid, "admin"
    position = d.get("position") if d.get("position") in ROLES and d.get("position") != "general" else None
    cur = con.execute("INSERT INTO users(email,name,password_hash,company_id,role,created_at,position) VALUES(?,?,?,?,?,?,?)",
                      (email, name, generate_password_hash(pw), cid, role, now, position))
    # ONE combined acceptance, in the same transaction as the account itself. If the acceptance
    # cannot be recorded (document file missing), roll the whole registration back: an account
    # must never be created that appears to have accepted a document that doesn't exist.
    if legal.record(con, cur.lastrowid, "registration") is None:
        con.rollback()
        return err("Your account could not be created because the Terms & Privacy document is unavailable. Please try again shortly or contact the site administrator.", 503)
    if billing.enabled():
        allowances.grant_on_signup(con, cur.lastrowid, cid, email, request.remote_addr, app.secret_key, invited=bool(code))
    _log_event(con, "register", True, cur.lastrowid, email)
    con.commit()
    session.clear()
    session.permanent = True
    session["uid"] = cur.lastrowid
    return jsonify({"ok": True})


_fails = {}


@app.post("/api/login")
def login():
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()
    key = (request.remote_addr or "?") + "|" + email
    tries = [t for t in _fails.get(key, []) if t > time.time() - 900]
    if len(tries) >= 8:
        return err("Too many attempts. Wait 15 minutes and try again.", 429)
    u = db().execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not u or not check_password_hash(u["password_hash"], d.get("password") or ""):
        _fails[key] = tries + [time.time()]
        try:
            con = db()
            _log_event(con, "login", False, None, email)
            con.commit()
        except Exception:  # noqa: BLE001
            pass
        return err("Email or password is incorrect.", 401)
    _fails.pop(key, None)
    try:
        con = db()
        _log_event(con, "login", True, u["id"], email)
        con.commit()
    except Exception:  # noqa: BLE001
        pass
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    session["sv"] = u["session_version"] or 0
    return jsonify({"ok": True})


RESET_MINUTES = 60


def _hash_token(t):
    return hashlib.sha256(t.encode()).hexdigest()


_reset_hits = {}


@app.post("/api/forgot")
def forgot_password():
    """Email a one-time reset link. Always gives the same answer, so nobody can find out which emails have accounts."""
    d = request.get_json(silent=True) or {}
    email = (d.get("email") or "").strip().lower()[:200]
    same = jsonify({"ok": True, "message": "If an account exists for that email, we've sent a link to reset the password. It works for 60 minutes. Check your spam folder if it doesn't arrive."})
    key = (request.remote_addr or "?")
    hits = [t for t in _reset_hits.get(key, []) if t > time.time() - 3600]
    hits_email = [t for t in _reset_hits.get(email, []) if t > time.time() - 3600]
    if len(hits) >= 10 or len(hits_email) >= 3:
        return err("Too many reset requests. Please wait an hour and try again.", 429)
    _reset_hits[key] = hits + [time.time()]
    _reset_hits[email] = hits_email + [time.time()]
    if "@" not in email:
        return same
    con = db()
    u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not u:
        return same
    token = secrets.token_urlsafe(32)
    now = time.time()
    con.execute("UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL", (now, u["id"]))  # only the newest link works
    con.execute("INSERT INTO password_resets(user_id, token_hash, expires_at, created_at, ip) VALUES(?,?,?,?,?)",
                (u["id"], _hash_token(token), now + RESET_MINUTES * 60, now, request.remote_addr))
    con.commit()
    base = os.environ.get("BASE_URL", request.host_url).rstrip("/")
    link = f"{base}/app?reset={token}"
    text = (f"Hello {u['name']},\n\nSomeone (hopefully you) asked to reset the password for your UAIM account.\n\n"
            f"Choose a new password here (the link works once, for {RESET_MINUTES} minutes):\n{link}\n\n"
            "If you didn't ask for this, you can ignore this email: your password stays the same.\n\nUAIM\nUnderstand first. Improve what matters.")
    html = (f"<p style=\"margin:0 0 16px\"><span style=\"font-family:Arial,sans-serif;font-weight:800;color:#0B2A4A;font-size:20px\">UAIM</span></p><p>Hello {escape(u['name'])},</p><p>Someone (hopefully you) asked to reset the password for your UAIM account.</p>"
            f"<p><a href=\"{escape(link)}\" style=\"display:inline-block;background:#0B2A4A;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none\">Choose a new password</a></p>"
            f"<p>The link works once, for {RESET_MINUTES} minutes. If you didn't ask for this, you can ignore this email: your password stays the same.</p><p>UAIM<br><span style=\"color:#14A89A\">Understand first. Improve what matters.</span></p>")
    mailer.send(u["email"], "Reset your UAIM password", text, html, app.logger)
    return same


def _valid_reset(token):
    if not token or len(token) > 200:
        return None
    return db().execute("SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
                        (_hash_token(token), time.time())).fetchone()


@app.post("/api/reset/check")
def reset_check():
    ok = _valid_reset((request.get_json(silent=True) or {}).get("token"))
    return jsonify({"valid": bool(ok)})


@app.post("/api/reset")
def reset_password():
    d = request.get_json(silent=True) or {}
    pw = d.get("password") or ""
    if len(pw) < 10:
        return err("Use a password of at least 10 characters.")
    con = db()
    row = _valid_reset(d.get("token"))
    if not row:
        return err("This reset link has expired or has already been used. Ask for a new one.", 400)
    now = time.time()
    con.execute("UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL", (now, row["user_id"]))
    con.execute("UPDATE users SET password_hash=?, session_version=COALESCE(session_version,0)+1 WHERE id=?",
                (generate_password_hash(pw), row["user_id"]))
    con.commit()
    u = con.execute("SELECT * FROM users WHERE id=?", (row["user_id"],)).fetchone()
    session.clear()
    session.permanent = True
    session["uid"] = u["id"]
    session["sv"] = u["session_version"]
    mailer.send(u["email"], "Your UAIM password was changed",
                f"Hello {u['name']},\n\nThe password for your UAIM account was just changed, and you've been signed out everywhere else.\n\n"
                "If this wasn't you, reset your password straight away and tell your company's admin.\n\nUAIM\nUnderstand first. Improve what matters.", None, app.logger)
    return jsonify({"ok": True})


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


# ------------------------------------------------------------------ team
@app.get("/api/team")
@login_required()
def team():
    u = current_user()
    rows = db().execute("SELECT id,name,email,role,position,created_at FROM users WHERE company_id=? ORDER BY created_at", (u["company_id"],)).fetchall()
    return jsonify({"company": u["company_name"], "inviteCode": u["invite_code"] if u["role"] == "admin" else None,
                    "members": [dict(r) for r in rows]})


@app.post("/api/team/role")
@login_required("admin")
def team_role():
    u = current_user()
    d = request.get_json(silent=True) or {}
    if d.get("role") not in ("admin", "member", "viewer"):
        return err("Unknown role.")
    if int(d.get("userId", 0)) == u["id"]:
        return err("You can't change your own role.")
    db().execute("UPDATE users SET role=? WHERE id=? AND company_id=?", (d["role"], int(d.get("userId", 0)), u["company_id"]))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/team/remove")
@login_required("admin")
def team_remove():
    u = current_user()
    d = request.get_json(silent=True) or {}
    uid = int(d.get("userId", 0))
    if uid == u["id"]:
        return err("You can't remove yourself.")
    db().execute("DELETE FROM users WHERE id=? AND company_id=?", (uid, u["company_id"]))
    db().commit()
    return jsonify({"ok": True})


@app.post("/api/team/code")
@login_required("admin")
def team_code():
    u = current_user()
    code = secrets.token_hex(4).upper()
    db().execute("UPDATE companies SET invite_code=? WHERE id=?", (code, u["company_id"]))
    db().commit()
    return jsonify({"inviteCode": code})


# ------------------------------------------------------------------ usage analytics (operator)
def _maybe_send_share_card(r, u):
    """Send the share-card email the first time this review is downloaded as a report or signed off.
    One email per review, ever. Claimed atomically via app_meta so two requests can't both send it."""
    key = f"sharecard:{r['id']}"
    try:
        con = db()
        cur = con.execute("INSERT OR IGNORE INTO app_meta(key, value) VALUES(?, ?)", (key, str(time.time())))
        first = cur.rowcount == 1
        con.commit()
    except Exception:  # noqa: BLE001
        return  # tracking must never break the site
    if first and share_card.enabled():
        share_card.send(r, u, app.logger)


@app.get("/api/admin/stats")
@login_required("admin")
def admin_stats():
    """Visitor and sign-in numbers for the site operator (admin role only)."""
    con = db()
    day, now = 86400, time.time()
    one = lambda q, a=(): con.execute(q, a).fetchone()[0]
    out = {
        "viewsToday": one("SELECT COUNT(*) FROM page_views WHERE ts>=?", (now - day,)),
        "views30d": one("SELECT COUNT(*) FROM page_views WHERE ts>=?", (now - 30 * day,)),
        "visitors30d": one("SELECT COUNT(DISTINCT ip_hash) FROM page_views WHERE ts>=?", (now - 30 * day,)),
        "logins30d": one("SELECT COUNT(*) FROM login_events WHERE ok=1 AND ts>=?", (now - 30 * day,)),
        "failedLogins30d": one("SELECT COUNT(*) FROM login_events WHERE ok=0 AND ts>=?", (now - 30 * day,)),
        "signups30d": one("SELECT COUNT(*) FROM login_events WHERE event='register' AND ts>=?", (now - 30 * day,)),
        "topPages30d": [{"path": r["path"], "views": r["views"]} for r in con.execute(
            "SELECT path, COUNT(*) AS views FROM page_views WHERE ts>=? GROUP BY path ORDER BY views DESC LIMIT 10",
            (now - 30 * day,))],
        "companies": [],
    }
    for c in con.execute("SELECT id, name FROM companies ORDER BY id").fetchall():
        last = one("SELECT MAX(ts) FROM login_events WHERE company_id=? AND ok=1", (c["id"],))
        out["companies"].append({
            "id": c["id"], "name": c["name"],
            "members": one("SELECT COUNT(*) FROM users WHERE company_id=?", (c["id"],)),
            "logins30d": one("SELECT COUNT(*) FROM login_events WHERE company_id=? AND ok=1 AND ts>=?",
                             (c["id"], now - 30 * day)),
            "views30d": one("SELECT COUNT(*) FROM page_views WHERE company_id=? AND ts>=?", (c["id"], now - 30 * day)),
            "lastLogin": last,
        })
    return jsonify(out)


# ------------------------------------------------------------------ reviews
@app.get("/api/reviews")
@login_required()
def list_reviews():
    u = current_user()
    rows = db().execute("SELECT * FROM reviews WHERE company_id=? ORDER BY updated_at DESC LIMIT 500", (u["company_id"],)).fetchall()
    return jsonify({"reviews": [review_meta(r) for r in rows], "names": names_for(u["company_id"])})


@app.post("/api/reviews")
@login_required("member")
def create_review():
    u = current_user()
    d = request.get_json(silent=True) or {}
    inputs = {k: str(d.get(k) or "")[:100] for k in ("priority", "size", "runs", "rate", "cur", "lang")}
    inputs["cur"] = inputs["cur"] or "GBP"
    inputs["lang"] = inputs["lang"] if inputs["lang"] in ai.LANGS else "en"
    ki = d.get("knownIssues")  # optional: "yes", "no" or "unsure"
    inputs["knownIssues"] = ki if ki in ai.ISSUE_ANSWERS else ""
    inputs["issuesText"] = (d.get("issuesText") or "").strip()[:4000] if inputs["knownIssues"] == "yes" else ""
    text = (d.get("text") or "").strip()[:40000]
    try:
        images = ai.decode_images(d.get("images") or ([d["image"]] if d.get("image") else []))
    except ai.AIError as e:
        return err(str(e))
    if not text and not images:
        return err("Add a process first: upload a file, paste the steps, or try the example.")
    con = db()
    # The browser sends a one-time key with each "Review this process" click, so a double-click
    # or a network retry can never create two reviews or use two credits.
    rkey = str(d.get("requestId") or "")[:64]
    if rkey:
        try:
            con.execute("INSERT INTO create_requests(company_id, key, review_id, created_at) VALUES(?,?,NULL,?)",
                        (u["company_id"], rkey, time.time()))
            con.commit()
        except sqlite3.IntegrityError:
            row = con.execute("SELECT review_id FROM create_requests WHERE company_id=? AND key=?", (u["company_id"], rkey)).fetchone()
            if row and row["review_id"]:
                return jsonify({"id": row["review_id"], "duplicate": True})
            return err("This review is already being created. Please wait a moment.", 409)

    def forget_key():
        if rkey:
            con.execute("DELETE FROM create_requests WHERE company_id=? AND key=? AND review_id IS NULL", (u["company_id"], rkey))
            con.commit()

    source = billing.reserve_review(con, u["company_id"], u["id"])
    if not source and allowances.free_review_status(con, u["id"])["eligible"] and not con.execute(
            "SELECT 1 FROM reviews WHERE created_by=? AND paid_with='free_review'", (u["id"],)).fetchone():
        allowances.ledger(con, "free_review", -1, "free review started", u["company_id"], u["id"])
        con.commit()
        source = "free_review"
    if not source:
        forget_key()
        return jsonify({"error": "You've used your free review and have no review credits left. Buy more on the Billing page.", "needsPayment": True}), 402
    try:
        a = ai.run(ai.steps_prompt(text, inputs, bool(images)), images)
    except Exception as e:  # noqa: BLE001  give the credit back if the analysis fails
        billing.release_review(db(), u["company_id"], source, u["id"])
        forget_key()
        if isinstance(e, ai.AIError):
            return err(str(e), 502)
        app.logger.exception("Analysis failed")
        return err("The analysis failed unexpectedly. Your credit has been returned.", 500)
    a.pop("changeSummary", None)
    a["steps"] = a.get("steps", [])[:12]
    for s in a["steps"]:
        s["failureModes"] = []  # risks come later, once the team has confirmed the steps
        for k in ("suppliers", "inputs", "outputs", "customers"):
            s[k] = []  # the SIPOC is built once the steps are confirmed
    a["sipoc"] = sipocmod.clean({})
    a["openPoints"] = [str(x)[:300] for x in (a.get("openPoints") or []) if str(x).strip()][:6]
    normalize(a)
    flow.ensure_step_ids(a)
    for s in a["steps"]:
        s["flow"] = {}
    a["meta"] = {"currency": inputs["cur"]}
    m = meta_from(a)
    now = time.time()
    inputs["text"] = text
    con = db()
    cur = con.execute(
        """INSERT INTO reviews(company_id,title,headline,score,high,fm_count,actions_total,actions_done,created_by,created_at,updated_by,updated_at,analysis_json,inputs_json,paid_with,lang,workflow)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (u["company_id"], m["title"], m["headline"], m["score"], m["high"], m["fm_count"], m["actions_total"], m["actions_done"],
         u["id"], now, u["id"], now, json.dumps(a), json.dumps(inputs), source, inputs["lang"],
         json.dumps({"stage": "steps", "confirmed": {}, "reviewed": {}})))
    log(cur.lastrowid, "created", "Created the review and set out the process steps from the description (stage 2 of 7: waiting for the team to check and confirm them).", u["id"])
    if rkey:
        con.execute("UPDATE create_requests SET review_id=? WHERE company_id=? AND key=?", (cur.lastrowid, u["company_id"], rkey))
    con.commit()
    return jsonify({"id": cur.lastrowid})


def full_review(r, u):
    con = db()
    a = json.loads(r["analysis_json"])
    wf0 = get_wf(r)
    si = STAGES.index(wf0["stage"])
    based = insights.ensure_baselines(a, wf0.get("legacy") or si > STAGES.index("risk"), wf0.get("legacy") or si > STAGES.index("flow"), time.time())
    if flow.ensure_step_ids(a) or based:  # reviews created before steps had permanent ids, or a starting point to record
        con.execute("UPDATE reviews SET analysis_json=? WHERE id=?", (json.dumps(a), r["id"]))
        con.commit()
        r = con.execute("SELECT * FROM reviews WHERE id=?", (r["id"],)).fetchone()
    comments = con.execute("SELECT id, fm_id, text, user_id, created_at FROM comments WHERE review_id=? ORDER BY created_at", (r["id"],)).fetchall()
    hist = con.execute("SELECT id, kind, summary, user_id, created_at FROM history WHERE review_id=? ORDER BY created_at DESC LIMIT 200", (r["id"],)).fetchall()
    meta = review_meta(r)
    meta["freeReview"] = r["paid_with"] == "free_review"
    try:
        ins = insights.compute(a, json.loads(r["inputs_json"]))
    except Exception:  # noqa: BLE001  older reviews may lack some fields; never block opening a review
        ins = None
    return {"meta": meta, "analysis": a, "inputs": json.loads(r["inputs_json"]), "flowCalc": flow.calc(a), "insights": ins,
            "workflow": get_wf(r), "raciChecks": raci.checks(a.get("raci"), a.get("steps", [])),

            "comments": [{"id": c["id"], "fmId": c["fm_id"], "text": c["text"], "by": c["user_id"], "at": ms(c["created_at"])} for c in comments],
            "history": [{"id": h["id"], "kind": h["kind"], "summary": h["summary"], "by": h["user_id"], "at": ms(h["created_at"])} for h in hist],
            "names": names_for(u["company_id"])}


@app.get("/api/reviews/<int:rid>")
@login_required()
def get_one(rid):
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    return jsonify(full_review(r, u))


@app.get("/api/reviews/<int:rid>/stamp")
@login_required()
def stamp(rid):
    u = current_user()
    r = db().execute("SELECT rev, updated_at, (SELECT COUNT(*) FROM comments WHERE review_id=reviews.id) AS nc FROM reviews WHERE id=? AND company_id=?",
                     (rid, u["company_id"])).fetchone()
    if not r:
        return err("Review not found.", 404)
    return jsonify({"rev": r["rev"], "updatedAt": ms(r["updated_at"]), "comments": r["nc"]})


@app.put("/api/reviews/<int:rid>/analysis")
@login_required("member")
def save_analysis(rid):
    """Team edits (ratings, owners, due dates, statuses). Optimistic locking via 'rev'."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    if int(d.get("rev", -1)) != r["rev"]:
        return jsonify({"error": "conflict", "review": full_review(r, u)}), 409
    a = d.get("analysis")
    if not isinstance(a, dict) or not isinstance(a.get("steps"), list):
        return err("Invalid analysis.")
    # Only allow team-editable fields to change; everything else comes from the stored version.
    old = json.loads(r["analysis_json"])
    old_by_id = {f["id"]: f for f in all_fms(old)}
    for f in all_fms(a):
        o = old_by_id.get(f.get("id"))
        if not o:
            continue
        for k in ("severity", "occurrence", "detection"):
            o[k] = clamp(f.get(k, o[k]))
        if f.get("edited"):
            o["edited"] = True
            o["ap"] = ap_for(o)
        if f.get("ownerSet"):
            o["owner"] = str(f.get("owner") or "")[:120]
            o["ownerSet"] = True
        o["due"] = str(f.get("due") or "")[:10]
        if f.get("status") in STATUSES:
            o["status"] = f["status"]
    m = meta_from(old)
    now = time.time()
    db().execute(
        """UPDATE reviews SET analysis_json=?, title=?, headline=?, score=?, high=?, fm_count=?, actions_total=?, actions_done=?,
           updated_by=?, updated_at=?, rev=rev+1, changed_since_signoff=CASE WHEN status='validated' THEN 1 ELSE changed_since_signoff END
           WHERE id=?""",
        (json.dumps(old), m["title"], m["headline"], m["score"], m["high"], m["fm_count"], m["actions_total"], m["actions_done"], u["id"], now, rid))
    changes = [str(x)[:200] for x in (d.get("log") or [])][:40]
    if changes:
        log(rid, "edit", "; ".join(changes[:10]) + (f"; and {len(changes) - 10} more changes" if len(changes) > 10 else ""), u["id"])
    db().commit()
    return jsonify({"rev": r["rev"] + 1})


@app.put("/api/reviews/<int:rid>/content")
@login_required("member")
def save_content(rid):
    """The team's text edits: any wording, plus adding, removing or reordering steps, risks and moves."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    if int(d.get("rev", -1)) != r["rev"]:
        return jsonify({"error": "conflict", "review": full_review(r, u)}), 409
    if not isinstance(d.get("analysis"), dict):
        return err("Invalid review.")
    try:
        a = sanitize_content(d["analysis"], json.loads(r["analysis_json"]))
    except ValueError as e:
        return err(str(e))
    m = meta_from(a)
    now = time.time()
    snapshot(r, "before text edit", u["id"])
    db().execute(
        """UPDATE reviews SET analysis_json=?, title=?, headline=?, score=?, high=?, fm_count=?, actions_total=?, actions_done=?,
           updated_by=?, updated_at=?, rev=rev+1, version=version+1,
           changed_since_signoff=CASE WHEN status='validated' THEN 1 ELSE changed_since_signoff END WHERE id=?""",
        (json.dumps(a), m["title"], m["headline"], m["score"], m["high"], m["fm_count"], m["actions_total"], m["actions_done"], u["id"], now, rid))
    changes = [str(x)[:200] for x in (d.get("log") or [])][:20]
    log(rid, "text", (f"Edited the review text (version {r['version'] + 1}). " + "; ".join(changes)).strip(), u["id"])
    db().commit()
    return jsonify(full_review(get_review(rid, u), u))


@app.get("/api/reviews/<int:rid>/versions")
@login_required()
def list_versions(rid):
    u = current_user()
    if not get_review(rid, u):
        return err("Review not found.", 404)
    rows = db().execute("SELECT version, reason, user_id, created_at FROM review_versions WHERE review_id=? ORDER BY version DESC, id DESC", (rid,)).fetchall()
    return jsonify({"versions": [{"version": x["version"], "reason": x["reason"], "by": x["user_id"], "at": ms(x["created_at"])} for x in rows]})


@app.get("/api/reviews/<int:rid>/versions/<int:ver>")
@login_required()
def get_version(rid, ver):
    u = current_user()
    if not get_review(rid, u):
        return err("Review not found.", 404)
    x = db().execute("SELECT * FROM review_versions WHERE review_id=? AND version=? ORDER BY id DESC LIMIT 1", (rid, ver)).fetchone()
    if not x:
        return err("That version isn't stored.", 404)
    return jsonify({"version": ver, "analysis": json.loads(x["analysis_json"]), "at": ms(x["created_at"]), "by": x["user_id"]})


@app.post("/api/reviews/<int:rid>/comments")
@login_required("member")
def add_comment(rid):
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    text = (d.get("text") or "").strip()[:2000]
    if not text:
        return err("Write a note first.")
    now = time.time()
    db().execute("INSERT INTO comments(review_id,fm_id,text,user_id,created_at) VALUES(?,?,?,?,?)",
                 (rid, str(d.get("fmId") or "general")[:40], text, u["id"], now))
    db().execute("UPDATE reviews SET updated_by=?, updated_at=? WHERE id=?", (u["id"], now, rid))
    db().commit()
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/rerun")
@login_required("member")
def rerun(rid):
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    if get_wf(r)["stage"] != "complete":
        return err("Re-analysis is available once every stage of the journey has been confirmed.")
    old = json.loads(r["analysis_json"])
    inputs = json.loads(r["inputs_json"])
    comments = [{"fmId": c["fm_id"], "text": c["text"]} for c in
                db().execute("SELECT fm_id, text FROM comments WHERE review_id=?", (rid,)).fetchall()]
    start_rev = r["rev"]
    try:
        new = ai.run(ai.rerun_prompt(old, comments, (d.get("notes") or "")[:4000], inputs))
    except ai.AIError as e:
        return err(str(e), 502)
    changes = [str(c)[:240] for c in (new.pop("changeSummary", None) or [])][:8]
    # Reload: the team may have edited while the AI was working.
    r = get_review(rid, u)
    cur_a = json.loads(r["analysis_json"])
    old_by_id = {f["id"]: f for f in all_fms(cur_a)}
    for s in new.get("steps", []):
        for f in s.get("failureModes", []):
            f.pop("teamEditedRatings", None)
            f.pop("actionStatus", None)
            f.pop("teamEditedText", None)
    normalize(new)
    # Flow data: the team's timings always win; the AI may only fill gaps it can quote.
    src_text = "\n".join([inputs.get("text", ""), (d.get("notes") or ""), *[c["text"] for c in comments]])
    old_steps = {s.get("id"): s for s in cur_a.get("steps", []) if s.get("id")}
    for s in new.get("steps", []):
        ai_flow = flow.from_ai(s.get("flow"), src_text)
        o = old_steps.get(s.get("id"))
        s["flow"] = flow.merge_rerun(o.get("flow"), ai_flow) if o else ai_flow
        if o:
            for k in ("suppliers", "customers"):
                s[k] = o.get(k) or []
        if o and o.get("textEdited"):
            for k in ("name", "actor", "type", "function", "inputs", "outputs"):
                if o.get(k):
                    s[k] = o[k]
            s["textEdited"] = True
    flow.ensure_step_ids(new)
    gaps = flow.clean_gaps(new.get("dataGaps"), new.get("steps", []))
    new["dataGaps"] = gaps or cur_a.get("dataGaps") or []
    for f in all_fms(new):
        o = old_by_id.get(f["id"])
        if not o:
            continue
        f["status"] = o.get("status", "open")
        if o.get("due"):
            f["due"] = o["due"]
        if isinstance(o.get("baseline"), dict):
            f["baseline"] = o["baseline"]
        if o.get("ownerSet"):
            f["owner"], f["ownerSet"] = o.get("owner", ""), True
        if o.get("edited"):
            for k in ("severity", "occurrence", "detection", "ap"):
                f[k] = o[k]
            f["edited"] = True
        if o.get("textEdited"):
            for k in ("mode", "effects", "causes", "preventionControls", "detectionControls", "action"):
                if o.get(k):
                    f[k] = o[k]
            f["textEdited"] = True
    new["meta"] = cur_a.get("meta") or {"currency": inputs.get("cur", "GBP")}
    new["sipoc"] = cur_a.get("sipoc") or {}
    new["openPoints"] = cur_a.get("openPoints") or []
    if not new.get("executive"):
        new["executive"] = cur_a.get("executive")
    if not new.get("issueCheck"):
        new["issueCheck"] = cur_a.get("issueCheck")
    if isinstance(cur_a.get("flowBaseline"), dict):
        new["flowBaseline"] = cur_a["flowBaseline"]
    clean_links(new)
    if cur_a.get("raci"):
        new["raci"] = raci.clean(cur_a["raci"], new.get("steps", []), cur_a["raci"])
    m = meta_from(new)
    now = time.time()
    snapshot(r, "before AI re-analysis", u["id"])
    db().execute(
        """UPDATE reviews SET analysis_json=?, title=?, headline=?, score=?, high=?, fm_count=?, actions_total=?, actions_done=?,
           updated_by=?, updated_at=?, rev=rev+1, version=version+1, reruns=reruns+1,
           changed_since_signoff=CASE WHEN status='validated' THEN 1 ELSE changed_since_signoff END WHERE id=?""",
        (json.dumps(new), m["title"], m["headline"], m["score"], m["high"], m["fm_count"], m["actions_total"], m["actions_done"], u["id"], now, rid))
    log(rid, "ai", f"Re-analysed with {len(comments)} team note{'s' if len(comments) != 1 else ''} (version {r['version'] + 1}). "
        + (" | ".join(changes) if changes else "No change summary returned."), u["id"])
    db().commit()
    out = full_review(get_review(rid, u), u)
    out["changes"] = changes
    out["editedDuringRun"] = r["rev"] != start_rev
    return jsonify(out)


_UI_STRINGS = None
_ui_locks = {}


def ui_strings():
    """The website's interface text (static/ui_strings.js, generated from app.js)."""
    global _UI_STRINGS
    if _UI_STRINGS is None:
        with open(os.path.join(app.static_folder, "ui_strings.js"), encoding="utf-8") as fh:
            t = fh.read()
        _UI_STRINGS = json.loads(t[t.index("["):t.rindex("]") + 1])
    return _UI_STRINGS


def translate_cached(cache_key, lang, src):
    """Translate a {key: English} dictionary once per language, in batches, and keep the result."""
    row = db().execute("SELECT json FROM labels WHERE key=?", (cache_key,)).fetchone()
    if row:
        return json.loads(row["json"])
    import threading
    lock = _ui_locks.setdefault(cache_key, threading.Lock())
    with lock:  # one translation per language at a time, even if many people ask at once
        row = db().execute("SELECT json FROM labels WHERE key=?", (cache_key,)).fetchone()
        if row:
            return json.loads(row["json"])
        items, out = list(src.items()), {}
        for i in range(0, len(items), 80):
            chunk = dict(items[i:i + 80])
            for _ in range(2):  # a second pass for anything that came back wrong
                todo = {k: v for k, v in chunk.items() if k not in out}
                if not todo:
                    break
                out.update(ai.run_labels(lang, todo))
        db().execute("INSERT OR REPLACE INTO labels(key, json, created_at) VALUES(?,?,?)", (cache_key, json.dumps(out), time.time()))
        db().commit()
        return out


@app.get("/api/ui-strings/<lang>")
def ui_translation(lang):
    """The interface in another language. Public (the sign-in page needs it too), but it only ever translates
    the website's own fixed text, once per language, so it can't be used to run arbitrary AI requests."""
    if lang not in ai.LANGS:
        return err("Unknown language.", 404)
    if lang == "en":
        return jsonify({"strings": {}})
    strings = ui_strings()
    src = {f"s{i}": s for i, s in enumerate(strings)}
    key = "ui:" + lang + ":" + hashlib.sha1(json.dumps(strings).encode()).hexdigest()[:12]
    try:
        tr = translate_cached(key, lang, src)
    except ai.AIError as e:
        return err(str(e), 502)
    return jsonify({"strings": {strings[int(k[1:])]: v for k, v in tr.items() if k[1:].isdigit() and int(k[1:]) < len(strings)}})


@app.post("/api/labels")
@login_required()
def labels():
    """Fixed report wording in another language: translated once per language, then reused."""
    d = request.get_json(silent=True) or {}
    lang, src = d.get("lang"), d.get("labels")
    if lang not in ai.LANGS or not isinstance(src, dict) or len(src) > 400:
        return err("Unknown language.")
    if lang == "en":
        return jsonify({"labels": {}})
    src = {str(k)[:40]: str(v)[:600] for k, v in src.items()}
    key = lang + ":" + hashlib.sha1(json.dumps(src, sort_keys=True).encode()).hexdigest()[:12]
    try:
        out = translate_cached(key, lang, src)
    except ai.AIError as e:
        return err(str(e), 502)
    return jsonify({"labels": out})


def _clean_fm_list(lst):
    return [f for f in (lst or []) if isinstance(f, dict) and f.get("mode")][:6]


def _save_stage(r, a, wf, u, reason, summary, new_version=True):
    con = db()
    m = meta_from(a)
    now = time.time()
    if new_version:
        snapshot(r, reason, u["id"])
    con.execute(
        f"""UPDATE reviews SET analysis_json=?, workflow=?, title=?, headline=?, score=?, high=?, fm_count=?, actions_total=?, actions_done=?,
           updated_by=?, updated_at=?, rev=rev+1{", version=version+1" if new_version else ""} WHERE id=?""",
        (json.dumps(a), json.dumps(wf), m["title"], m["headline"], m["score"], m["high"], m["fm_count"], m["actions_total"], m["actions_done"], u["id"], now, r["id"]))
    log(r["id"], "stage", summary, u["id"])
    con.commit()


@app.post("/api/reviews/<int:rid>/stage")
@login_required("member")
def confirm_stage(rid):
    """Confirm the current stage of the journey and prepare the next one. Never uses a credit."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    wf = get_wf(r)
    stage = d.get("stage")
    if stage != wf["stage"] or stage == "complete":
        return jsonify({"error": "This stage has already been confirmed. The latest version is loaded.", "review": full_review(r, u)}), 409
    if d.get("rev") is not None and int(d["rev"]) != r["rev"]:
        return jsonify({"error": "conflict", "review": full_review(r, u)}), 409
    a = json.loads(r["analysis_json"])
    flow.ensure_step_ids(a)
    inputs = json.loads(r["inputs_json"])
    comments = [{"fmId": c["fm_id"], "text": c["text"]} for c in db().execute("SELECT fm_id, text FROM comments WHERE review_id=?", (rid,)).fetchall()]
    src_text = "\n".join([inputs.get("text", ""), *[c["text"] for c in comments]])
    steps = a.get("steps", [])
    if not steps:
        return err("Add at least one process step first.")
    idx = STAGES.index(stage)
    nxt = STAGES[idx + 1]
    note = ""
    try:
        if stage == "steps":
            sp_now = sipocmod.clean(a.get("sipoc"))
            had_sipoc = bool(sp_now["inputs"] or sp_now["outputs"])
            new_steps = [s for s in steps if not any(s.get(k) for k in ("suppliers", "inputs", "outputs", "customers"))]
            if not had_sipoc or new_steps:  # coming back: keep the team's SIPOC, only fill in new steps
                res = ai.run_json(ai.sipoc_prompt(a, inputs.get("text", ""), inputs, comments))
                found = {s.get("id"): s for s in (res.get("steps") or []) if isinstance(s, dict)}
                for s in new_steps:
                    f = found.get(s["id"]) or {}
                    for k in ("suppliers", "inputs", "outputs", "customers"):
                        s[k] = [str(x)[:200] for x in (f.get(k) or []) if str(x).strip()][:15]
                if not had_sipoc:
                    a["sipoc"] = sipocmod.clean(res.get("sipoc"))
                    if not (a["sipoc"]["inputs"] or a["sipoc"]["outputs"]):
                        raise ai.AIError("The SIPOC came back empty. Try again.")
                    for x in (res.get("assumptions") or [])[:5]:
                        x = str(x)[:500]
                        if x.strip() and x not in a.setdefault("assumptions", []):
                            a["assumptions"].append(x)
                elif new_steps:
                    note = f" The SIPOC of {len(new_steps)} new step(s) was added; the rest of the SIPOC is unchanged."
        elif stage == "sipoc":
            todo = [s for s in steps if not s.get("failureModes")]
            if todo:  # first time: every step; coming back: only new steps
                res = ai.run_json(ai.risk_prompt(a, inputs.get("text", ""), inputs, comments))
                found = {s.get("id"): s.get("failureModes") for s in (res.get("steps") or []) if isinstance(s, dict)}
                for s in todo:
                    s["failureModes"] = _clean_fm_list(found.get(s["id"]))
            normalize(a)
            missing = [s["name"] for s in steps if not s["failureModes"]]
            note = f" {len(missing)} step(s) came back without risks; add them by hand or ask for a re-analysis later." if missing else ""
            # a step stays "reviewed" only if it still exists, already had its risks, and hasn't been changed since
            sigs = {s["id"]: step_sig(s) for s in steps if s not in todo}
            wf["reviewed"] = {k: v for k, v in wf["reviewed"].items() if k in sigs and v.get("sig", sigs[k]) == sigs[k]}
        elif stage == "risk":
            unreviewed = [s["name"] for s in steps if s["id"] not in wf["reviewed"]]
            if unreviewed:
                return err(f"Review every step first: {len(steps) - len(unreviewed)} of {len(steps)} reviewed. Still to do: {', '.join(unreviewed[:3])}{'…' if len(unreviewed) > 3 else ''}.")
            try:  # look for timings the customer already gave; never invented, never overwrites the team
                if all(s.get("flow") for s in steps):
                    raise StopIteration  # every step already has timing data: nothing to look for
                res = ai.run_json(ai.flow_prompt(a, src_text, comments, inputs))
                found = {s.get("id"): s.get("flow") for s in (res.get("steps") or []) if isinstance(s, dict)}
                for s in steps:
                    s["flow"] = flow.merge_rerun(s.get("flow"), flow.from_ai(found.get(s["id"]), src_text))
                gaps = flow.clean_gaps(res.get("dataGaps"), steps)
                if gaps:
                    a["dataGaps"] = gaps
            except ai.AIError:
                note = " Timings couldn't be read from the description this time; enter them by hand."
            except StopIteration:
                pass
        elif stage == "flow":
            res = ai.run_json(ai.summary_prompt(a, flow.calc(a), inputs.get("text", ""), inputs, comments))
            a["swot"] = ai.clean_swot(res.get("swot"))
            for k in ("headline", "keyFindings", "overallScore", "impact", "moves", "dimensions", "executive", "issueCheck"):
                if res.get(k) is not None:
                    a[k] = res[k]
            if not a.get("headline"):
                raise ai.AIError("The summary came back incomplete. Try again.")
            a = sanitize_content(a, a)  # same limits as a team edit
        elif stage == "swot" and a.get("raci"):
            a["raci"] = raci.clean(a["raci"], steps, a["raci"])  # coming back: keep the team's RACI; new steps get empty rows
            note = " The RACI matrix was kept; fill in any new steps (they're flagged below the matrix)."
        elif stage == "swot":
            res = ai.run_json(ai.raci_prompt(a, inputs, comments))
            a["raci"] = raci.clean(res, steps)
            if not a["raci"]:
                raise ai.AIError("The RACI matrix came back empty. Try again.")
    except ai.AIError as e:
        return err(str(e), 502)
    wf["confirmed"][stage] = {"by": u["id"], "at": time.time()}
    wf["stage"] = nxt
    wf["reached"] = max(wf.get("reached", 0), STAGES.index(nxt))
    r = get_review(rid, u)
    if get_wf(r)["stage"] != stage:  # someone else confirmed it while the AI was working
        return jsonify({"error": "Someone else confirmed this stage at the same time. The latest version is loaded.", "review": full_review(r, u)}), 409
    if r["rev"] != (int(d["rev"]) if d.get("rev") is not None else r["rev"]):
        return jsonify({"error": "conflict", "review": full_review(r, u)}), 409
    label = STAGE_NAMES[stage]
    msg = (f"Confirmed the {label} (stage {idx + 2} of 7)." +
           (" The journey is complete." if nxt == "complete" else f" Prepared the {STAGE_NAMES[nxt]}.") + note)
    _save_stage(r, a, wf, u, f"before confirming the {label}", msg)
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/stage/back")
@login_required("member")
def reopen_stage(rid):
    """Go back to an earlier stage. Nothing is deleted: later stages keep their content and are confirmed again,
    and only what's new or changed is sent to the AI again. Free."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    wf = get_wf(r)
    if wf.get("legacy"):
        return err("This review was created before the step-by-step journey, so it has no stages to go back to.")
    to, cur = d.get("to"), wf["stage"]
    if to not in STAGES[:-1] or STAGES.index(to) >= STAGES.index(cur):
        return err("You can only go back to a stage that has already been confirmed.")
    if d.get("rev") is not None and int(d["rev"]) != r["rev"]:
        return jsonify({"error": "conflict", "review": full_review(r, u)}), 409
    for st in STAGES[STAGES.index(to):]:
        wf["confirmed"].pop(st, None)
    wf["stage"] = to
    now = time.time()
    db().execute("""UPDATE reviews SET workflow=?, rev=rev+1, updated_by=?, updated_at=?,
                    changed_since_signoff=CASE WHEN status='validated' THEN 1 ELSE changed_since_signoff END WHERE id=?""",
                 (json.dumps(wf), u["id"], now, rid))
    log(rid, "stage", f"Went back to the {STAGE_NAMES[to]} (stage {STAGES.index(to) + 2} of 7). Later stages keep their content and will be confirmed again.", u["id"])
    db().commit()
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/review-step")
@login_required("member")
def review_step(rid):
    """Mark a step's risk analysis as reviewed (or not) by the team."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    d = request.get_json(silent=True) or {}
    a = json.loads(r["analysis_json"])
    step = next((s for s in a.get("steps", []) if s.get("id") == d.get("stepId")), None)
    if not step:
        return err("Step not found.", 404)
    wf = get_wf(r)
    if d.get("reviewed", True):
        wf["reviewed"][step["id"]] = {"by": u["id"], "at": time.time(), "sig": step_sig(step)}
        msg = f"Reviewed the risks of step \u201c{step['name']}\u201d."
    else:
        wf["reviewed"].pop(step["id"], None)
        msg = f"Re-opened the risks of step \u201c{step['name']}\u201d."
    _save_stage(r, a, wf, u, "", msg, new_version=False)
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/raci")
@login_required("member")
def make_raci(rid):
    """Create a RACI matrix for a review that doesn't have one (e.g. made before RACI existed). Free."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    a = json.loads(r["analysis_json"])
    flow.ensure_step_ids(a)
    if a.get("raci") and not (request.get_json(silent=True) or {}).get("replace"):
        return err("This review already has a RACI matrix. Edit it, or ask to replace it.")
    inputs = json.loads(r["inputs_json"])
    comments = [{"text": c["text"]} for c in db().execute("SELECT text FROM comments WHERE review_id=?", (rid,)).fetchall()]
    try:
        m = raci.clean(ai.run_json(ai.raci_prompt(a, inputs, comments)), a.get("steps", []))
    except ai.AIError as e:
        return err(str(e), 502)
    if not m:
        return err("The RACI matrix came back empty. Try again.", 502)
    r = get_review(rid, u)
    a = json.loads(r["analysis_json"])
    flow.ensure_step_ids(a)
    a["raci"] = raci.clean(m, a.get("steps", []))
    _save_stage(r, a, get_wf(r), u, "before creating the RACI matrix", "Created a RACI matrix (an AI suggestion until the team confirms it).")
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/flow")
@login_required("member")
def find_flow(rid):
    """Look for timings in the customer's description and team notes. Never overwrites the team's data; free of charge."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    con = db()
    a = json.loads(r["analysis_json"])
    flow.ensure_step_ids(a)
    inputs = json.loads(r["inputs_json"])
    comments = [{"text": c["text"]} for c in con.execute("SELECT text FROM comments WHERE review_id=?", (rid,)).fetchall()]
    src_text = "\n".join([inputs.get("text", ""), *[c["text"] for c in comments]])
    try:
        res = ai.run_json(ai.flow_prompt(a, src_text, comments, inputs))
    except ai.AIError as e:
        return err(str(e), 502)
    found = {s.get("id"): s.get("flow") for s in (res.get("steps") or []) if isinstance(s, dict)}
    r = get_review(rid, u)  # re-read: the team may have edited meanwhile
    a = json.loads(r["analysis_json"])
    flow.ensure_step_ids(a)
    added = 0
    for s in a.get("steps", []):
        new_f = flow.from_ai(found.get(s["id"]), src_text)
        merged = flow.merge_rerun(s.get("flow"), new_f)
        added += len(merged) - len(s.get("flow") or {})
        s["flow"] = merged
    gaps = flow.clean_gaps(res.get("dataGaps"), a.get("steps", []))
    if gaps:
        a["dataGaps"] = gaps
    con.execute("UPDATE reviews SET analysis_json=?, rev=rev+1, updated_by=?, updated_at=? WHERE id=?", (json.dumps(a), u["id"], time.time(), rid))
    log(rid, "ai", f"Looked for timings in the description and notes: {added} value{'s' if added != 1 else ''} added. Nothing the team entered was changed.", u["id"])
    con.commit()
    out = full_review(get_review(rid, u), u)
    out["flowAdded"] = added
    return jsonify(out)


@app.post("/api/reviews/<int:rid>/swot")
@login_required("member")
def make_swot(rid):
    """Add (or refresh) the SWOT analysis of a review, e.g. one created before SWOT existed."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    con = db()
    comments = [{"text": c["text"]} for c in con.execute("SELECT text FROM comments WHERE review_id=?", (rid,)).fetchall()]
    try:
        swot = ai.run_swot(ai.swot_prompt(json.loads(r["analysis_json"]), comments, json.loads(r["inputs_json"])))
    except ai.AIError as e:
        return err(str(e), 502)
    r = get_review(rid, u)  # re-read: the team may have edited while the AI worked
    a = json.loads(r["analysis_json"])
    a["swot"] = swot
    now = time.time()
    con.execute("UPDATE reviews SET analysis_json=?, rev=rev+1, updated_by=?, updated_at=? WHERE id=?", (json.dumps(a), u["id"], now, rid))
    log(rid, "ai", "Added a SWOT analysis of the process.", u["id"])
    con.commit()
    return jsonify(full_review(get_review(rid, u), u))


@app.post("/api/reviews/<int:rid>/signoff")
@login_required("member")
def signoff(rid):
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    already_validated = r["status"] == "validated"          # re-signing off after changes doesn't re-email
    note = ((request.get_json(silent=True) or {}).get("note") or "").strip()[:500]
    now = time.time()
    db().execute("UPDATE reviews SET status='validated', changed_since_signoff=0, signoff_by=?, signoff_at=?, signoff_note=?, updated_by=?, updated_at=? WHERE id=?",
                 (u["id"], now, note, u["id"], now, rid))
    log(rid, "signoff", "Signed off the review as validated by the team." + (f" Note: {note}" if note else ""), u["id"])
    db().commit()
    if not already_validated:
        _maybe_send_share_card(r, u)
    return jsonify(full_review(get_review(rid, u), u))

@app.delete("/api/reviews/<int:rid>")
@login_required("admin")
def delete_review(rid):
    u = current_user()
    if not get_review(rid, u):
        return err("Review not found.", 404)
    db().execute("DELETE FROM reviews WHERE id=?", (rid,))
    storage.delete_review_files(db(), u["company_id"], rid)  # the original files and saved reports go too
    db().commit()
    return jsonify({"ok": True})


def file_row(f, names=None):
    meta = json.loads(f["meta_json"]) if f["meta_json"] else None
    return {"id": f["id"], "kind": f["kind"], "name": f["name"], "size": f["size"], "mime": f["mime"], "meta": meta,
            "by": f["created_by"], "at": ms(f["created_at"]), "url": f"/api/files/{f['id']}"}


@app.post("/api/reviews/<int:rid>/files")
@login_required("member")
def upload_original(rid):
    """Keep the original file a review was created from, exactly as uploaded."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    f = request.files.get("file")
    if not f:
        return err("No file was sent.")
    try:
        fid = storage.save_upload(db(), u["company_id"], rid, u["id"], f.filename, f.read(storage.MAX_UPLOAD + 1))
    except ValueError as e:
        return err(str(e))
    db().commit()
    log(rid, "file", f"Kept the original file \u201c{storage.safe_name(f.filename)}\u201d.", u["id"])
    db().commit()
    return jsonify({"id": fid})


@app.post("/api/reviews/<int:rid>/reports")
@login_required()
def keep_report(rid):
    """Keep a copy of a report as it was downloaded (one per version, language, audience and format)."""
    u = current_user()
    r = get_review(rid, u)
    if not r:
        return err("Review not found.", 404)
    f = request.files.get("file")
    if not f:
        return err("No file was sent.")
    try:
        version = int(request.form.get("version") or r["version"])
    except ValueError:
        return err("Invalid version.")
    if version != r["version"]:
        return err("The review has changed since this report was made, so the copy wasn't kept. Download it again to keep the latest version.", 409)
    try:
        fid, new = storage.save_report(db(), u["company_id"], rid, u["id"], request.form.get("format"), f.read(storage.MAX_REPORT + 1),
                                       version, request.form.get("lang"), request.form.get("audience"), r["title"])
    except ValueError as e:
        return err(str(e))
    if new:
        log(rid, "file", f"Downloaded and kept the {str(request.form.get('format')).upper()} report (version {version}).", u["id"])
    db().commit()
    if (request.form.get("format") or "").lower() in ("pdf", "docx"):
        _maybe_send_share_card(r, u)  # first report download emails the share card (if it hasn't gone out already)
    return jsonify({"id": fid, "new": new})


@app.get("/api/reviews/<int:rid>/files")
@login_required()
def list_files(rid):
    u = current_user()
    if not get_review(rid, u):
        return err("Review not found.", 404)
    rows = db().execute("SELECT * FROM files WHERE review_id=? ORDER BY created_at DESC", (rid,)).fetchall()
    return jsonify({"files": [file_row(x) for x in rows]})


@app.get("/api/files/<int:fid>")
@login_required()
def download_file(fid):
    u = current_user()
    f = db().execute("SELECT * FROM files WHERE id=? AND company_id=?", (fid, u["company_id"])).fetchone()
    p = storage.full_path(f) if f else None
    if not p:
        return err("File not found.", 404)
    resp = send_from_directory(os.path.dirname(p), os.path.basename(p), mimetype=f["mime"], as_attachment=True, download_name=f["name"])
    resp.headers["Cache-Control"] = "private, no-store"
    return resp


billing.init(app, db, current_user, login_required, err)


if __name__ == "__main__":
    print(f"UAIM running with AI_PROVIDER={os.environ.get('AI_PROVIDER', 'demo')} at http://localhost:5000")
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=os.environ.get("FLASK_DEBUG") == "1")