"""
Free first review eligibility, the credit ledger and checks against repeated free sign-ups.

Free first review
  Each new account is checked once, at sign-up, for eligibility for one free review. The
  decision is recorded in signup_checks and never revisited: a review started as someone's
  free review is marked paid_with='free_review'.

Ledger
  Every grant, deduction and refund of review credits is written to credit_ledger,
  so a balance can always be explained.

Repeated free sign-ups (checked once, at sign-up; the account is always created)
  - one free review per normalised email address (lower case; for Gmail, dots and +tags removed),
  - disposable email domains get no free review,
  - at most FREE_PER_NETWORK free reviews in 30 days from the same network. The network is
    stored only as a keyed hash of the address (never the address itself) and is cleared after
    NETWORK_KEY_DAYS days,
  - people who join a colleague's company with an invite code share that company's work and
    don't get their own free review (FREE_REVIEW_FOR_INVITED=1 changes this).
  Accounts that don't get the free review are marked with the reason, for review by the operator.
"""
import hashlib
import hmac
import ipaddress
import os
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS credit_ledger(
  id INTEGER PRIMARY KEY, company_id INTEGER, user_id INTEGER, review_id INTEGER,
  pool TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ledger_company ON credit_ledger(company_id, created_at);
CREATE TABLE IF NOT EXISTS signup_checks(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email_key TEXT NOT NULL, network_key TEXT,
  granted INTEGER NOT NULL, reason TEXT, created_at REAL NOT NULL);
CREATE INDEX IF NOT EXISTS ix_signup_email ON signup_checks(email_key);
CREATE INDEX IF NOT EXISTS ix_signup_network ON signup_checks(network_key, created_at);
"""

DISPOSABLE = {"mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com",
              "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "throwawaymail.com",
              "fakeinbox.com", "mintemail.com", "mohmal.com", "emailondeck.com", "tempail.com", "burnermail.io"}


def free_first_review():
    return os.environ.get("FREE_FIRST_REVIEW", "1") == "1"


def per_network():
    return int(os.environ.get("FREE_PER_NETWORK", "3"))


def network_days():
    return int(os.environ.get("NETWORK_KEY_DAYS", "30"))


def ledger(con, pool, delta, reason, company_id=None, user_id=None, review_id=None):
    con.execute("INSERT INTO credit_ledger(company_id, user_id, review_id, pool, delta, reason, created_at) VALUES(?,?,?,?,?,?,?)",
                (company_id, user_id, review_id, pool, delta, reason, time.time()))


def email_key(email):
    email = (email or "").strip().lower()
    local, _, domain = email.partition("@")
    local = local.split("+", 1)[0]
    if domain in ("gmail.com", "googlemail.com"):
        local, domain = local.replace(".", ""), "gmail.com"
    return hashlib.sha256(f"{local}@{domain}".encode()).hexdigest()


def network_key(ip, secret):
    """A keyed hash of the network (IPv4 /24, IPv6 /48), so the address itself is never stored."""
    try:
        a = ipaddress.ip_address((ip or "").strip())
        net = ipaddress.ip_network(f"{a}/{24 if a.version == 4 else 48}", strict=False)
    except ValueError:
        return None
    return hmac.new(secret if isinstance(secret, bytes) else str(secret).encode(), str(net).encode(), hashlib.sha256).hexdigest()


def grant_on_signup(con, user_id, company_id, email, ip, secret, invited):
    """Decide once whether this new account gets the free review, and record why."""
    now = time.time()
    con.execute("UPDATE signup_checks SET network_key=NULL WHERE created_at<?", (now - network_days() * 86400,))
    ek, nk = email_key(email), network_key(ip, secret)
    reason = None
    if not free_first_review():
        reason = "free review switched off"
    elif invited and os.environ.get("FREE_REVIEW_FOR_INVITED", "0") != "1":
        reason = "joined a company with an invite code"
    elif email.rsplit("@", 1)[-1].lower() in DISPOSABLE:
        reason = "disposable email address"
    elif con.execute("SELECT 1 FROM signup_checks WHERE email_key=? AND granted=1", (ek,)).fetchone():
        reason = "this email address has already had a free review"
    elif nk and con.execute("SELECT COUNT(*) FROM signup_checks WHERE network_key=? AND granted=1 AND created_at>?",
                            (nk, now - 30 * 86400)).fetchone()[0] >= per_network():
        reason = "too many free reviews from the same network recently"
    granted = reason is None
    con.execute("INSERT INTO signup_checks(user_id, email_key, network_key, granted, reason, created_at) VALUES(?,?,?,?,?,?)",
                (user_id, ek, nk, 1 if granted else 0, reason, now))
    if granted:
        ledger(con, "free_review", 1, "free review eligibility granted at sign-up", company_id, user_id)
    return granted, reason


def free_review_status(con, user_id):
    chk = con.execute("SELECT granted, reason FROM signup_checks WHERE user_id=? ORDER BY id DESC LIMIT 1", (user_id,)).fetchone()
    if not chk:
        return {"eligible": False, "reason": None}
    return {"eligible": bool(chk[0]), "reason": chk[1]}
