"""
Billing for UAIM, using Stripe.

How it works
- Review packs (single, 5, 10) are one-off payments that add review credits to the company.
- Subscriptions (Team, Business) allow a number of new reviews per billing month.
- Payments happen on Stripe's own checkout page; card details never touch this server.
- Stripe tells this server about payments through a webhook (/stripe/webhook), which is
  what actually adds credits or activates a subscription.

Set BILLING_ENABLED=0 in .env to switch billing off (unlimited reviews, e.g. for testing).
"""
import json
import os
import time

from flask import Blueprint, jsonify, request

bp = Blueprint("billing", __name__)

# What each plan gives. Prices are shown on the site; the real charge comes from the Stripe Price,
# so keep "price" here in line with what you set up in the Stripe Dashboard.
PLANS = {
    "single":   {"label": "1 review credit",        "kind": "pack", "credits": 1,  "price": 99.99,  "env": "STRIPE_PRICE_SINGLE"},
    "pack5":    {"label": "5 review credits",       "kind": "pack", "credits": 5,  "price": 449.99,  "env": "STRIPE_PRICE_PACK5"},
    "pack10":   {"label": "10 review credits",      "kind": "pack", "credits": 10, "price": 899.99,  "env": "STRIPE_PRICE_PACK10"},
    # No longer sold. Kept so customers who already bought them keep what they paid for.
    "lens":     {"label": "Extra audience version", "kind": "pack", "credits": 0,  "lens_credits": 1, "price": 49, "env": "STRIPE_PRICE_LENS", "legacy": True},
    "team":     {"label": "Team subscription",      "kind": "sub",  "monthly": 10, "price": 399, "env": "STRIPE_PRICE_TEAM", "legacy": True},
    "business": {"label": "Business subscription",  "kind": "sub",  "monthly": 30, "price": 899, "env": "STRIPE_PRICE_BUSINESS", "legacy": True},
}
ACTIVE = ("active", "trialing")


def enabled():
    return os.environ.get("BILLING_ENABLED", "1") == "1"


def currency_symbol():
    return {"GBP": "£", "EUR": "€", "USD": "$"}.get(os.environ.get("BILLING_CURRENCY", "GBP").upper(), "")


def free_reviews():
    """Review credits a new company gets. 0 by default: the free review comes from the sign-up check (allowances.py)."""
    return int(os.environ.get("FREE_REVIEWS", "0"))


def _stripe():
    import stripe  # imported lazily so the site runs without Stripe when billing is off
    key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
    if not key:
        raise RuntimeError("STRIPE_SECRET_KEY is not set on the server.")
    stripe.api_key = key
    return stripe


def plan_for_price(price_id):
    for k, p in PLANS.items():
        if price_id and os.environ.get(p["env"]) == price_id:
            return k
    return None


# ------------------------------------------------------------------ database
MIGRATIONS = {
    "companies": [("credits", "INTEGER NOT NULL DEFAULT 0"), ("stripe_customer_id", "TEXT"), ("sub_id", "TEXT"),
                  ("sub_plan", "TEXT"), ("sub_status", "TEXT"), ("sub_period_start", "REAL"), ("sub_period_end", "REAL"),
                  ("sub_cancel_at_end", "INTEGER NOT NULL DEFAULT 0"), ("lens_credits", "INTEGER NOT NULL DEFAULT 0")],
    "users": [("position", "TEXT"), ("session_version", "INTEGER NOT NULL DEFAULT 0")],
    "reviews": [("reruns", "INTEGER NOT NULL DEFAULT 0"), ("paid_with", "TEXT"), ("lang", "TEXT"), ("workflow", "TEXT")],
}
PAYMENTS_SQL = """CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL, stripe_ref TEXT UNIQUE NOT NULL, plan TEXT,
  description TEXT, amount INTEGER, currency TEXT, credits INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL)"""


def migrate(conn):
    for table, cols in MIGRATIONS.items():
        have = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                if table == "companies" and name == "credits":  # upgrading an existing site: give current teams their free reviews
                    conn.execute("UPDATE companies SET credits=?", (free_reviews(),))
    conn.execute(PAYMENTS_SQL)
    conn.commit()


# ------------------------------------------------------------------ allowance
def sub_active(c):
    return c["sub_status"] in ACTIVE and (c["sub_period_end"] or 0) > time.time() - 3 * 86400


def used_this_period(con, c):
    start = c["sub_period_start"] or 0
    return con.execute("SELECT COUNT(*) FROM reviews WHERE company_id=? AND paid_with='subscription' AND created_at>=?",
                       (c["id"], start)).fetchone()[0]


def reserve_review(con, company_id, user_id=None):
    """Take one review from the company's allowance. Returns 'subscription', 'credit', 'free' or None."""
    if not enabled():
        return "free"
    c = con.execute("SELECT * FROM companies WHERE id=?", (company_id,)).fetchone()
    if sub_active(c) and c["sub_plan"] in PLANS:
        if used_this_period(con, c) < PLANS[c["sub_plan"]].get("monthly", 0):
            return "subscription"
    cur = con.execute("UPDATE companies SET credits=credits-1 WHERE id=? AND credits>0", (company_id,))
    if cur.rowcount:
        import allowances
        allowances.ledger(con, "review_credit", -1, "review started", company_id, user_id)
    con.commit()
    return "credit" if cur.rowcount else None


def release_review(con, company_id, source, user_id=None):
    """Give the allowance back if the analysis failed."""
    if source == "credit":
        con.execute("UPDATE companies SET credits=credits+1 WHERE id=?", (company_id,))
        import allowances
        allowances.ledger(con, "review_credit", 1, "refund: analysis failed", company_id, user_id)
        con.commit()


def summary(con, company_id, user_id=None):
    if not enabled():
        return {"enabled": False}
    import allowances
    c = con.execute("SELECT * FROM companies WHERE id=?", (company_id,)).fetchone()
    out = {"enabled": True, "credits": c["credits"], "symbol": currency_symbol(), "subscription": None}
    if user_id:
        out["freeReview"] = allowances.free_review_status(con, user_id)
        out["freeReviewUsed"] = bool(con.execute("SELECT 1 FROM reviews WHERE created_by=? AND paid_with='free_review'", (user_id,)).fetchone())
    if c["sub_plan"] and c["sub_status"]:
        p = PLANS.get(c["sub_plan"], {})
        out["subscription"] = {"plan": c["sub_plan"], "label": p.get("label", c["sub_plan"]), "status": c["sub_status"],
                               "active": sub_active(c), "monthly": p.get("monthly", 0), "used": used_this_period(con, c),
                               "periodEnd": int((c["sub_period_end"] or 0) * 1000), "cancelAtEnd": bool(c["sub_cancel_at_end"])}
    s = out["subscription"]
    out["available"] = c["credits"] + (max(0, s["monthly"] - s["used"]) if s and s["active"] else 0)
    return out


# ------------------------------------------------------------------ routes
def init(app, db, current_user, login_required, err):
    """Register billing routes. Called from app.py with its helpers."""

    @bp.get("/api/billing")
    @login_required()
    def billing_status():
        u = current_user()
        con = db()
        out = summary(con, u["company_id"], u["id"])
        if not out["enabled"]:
            return jsonify(out)
        out["isAdmin"] = u["role"] == "admin"
        out["plans"] = [{"id": k, "label": p["label"], "kind": p["kind"], "price": p["price"], "credits": p.get("credits"),
                         "available": bool(os.environ.get(p["env"]))} for k, p in PLANS.items() if not p.get("legacy")]
        rows = con.execute("SELECT description, amount, currency, credits, created_at FROM payments WHERE company_id=? ORDER BY created_at DESC LIMIT 30",
                           (u["company_id"],)).fetchall()
        out["payments"] = [{"description": r["description"], "amount": r["amount"], "currency": r["currency"], "credits": r["credits"],
                            "at": int(r["created_at"] * 1000)} for r in rows]
        c = con.execute("SELECT stripe_customer_id FROM companies WHERE id=?", (u["company_id"],)).fetchone()
        out["hasPortal"] = bool(c["stripe_customer_id"])
        return jsonify(out)

    @bp.post("/api/billing/checkout")
    @login_required("admin")
    def checkout():
        if not enabled():
            return err("Billing is switched off on this site.")
        u = current_user()
        plan = (request.get_json(silent=True) or {}).get("plan")
        p = PLANS.get(plan)
        price_id = os.environ.get(p["env"], "") if p else ""
        if not p or p.get("legacy"):
            return err("That option is no longer available. Review credits are sold as one-off packs.")
        if not price_id:
            return err("That option isn't available yet.")
        con = db()
        c = con.execute("SELECT * FROM companies WHERE id=?", (u["company_id"],)).fetchone()
        if p["kind"] == "sub" and sub_active(c):
            return err("You already have a subscription. Use Manage subscription to change or cancel it.")
        try:
            stripe = _stripe()
            cust = c["stripe_customer_id"]
            if not cust:
                cust = stripe.Customer.create(email=u["email"], name=c["name"], metadata={"company_id": str(c["id"])}).id
                con.execute("UPDATE companies SET stripe_customer_id=? WHERE id=?", (cust, c["id"]))
                con.commit()
            base = os.environ.get("BASE_URL", request.host_url).rstrip("/")
            params = dict(
                mode="subscription" if p["kind"] == "sub" else "payment",
                customer=cust,
                line_items=[{"price": price_id, "quantity": 1}],
                success_url=f"{base}/app?billing=success",
                cancel_url=f"{base}/app?billing=cancelled",
                client_reference_id=str(c["id"]),
                metadata={"company_id": str(c["id"]), "plan": plan},
                allow_promotion_codes=True,
            )
            if p["kind"] == "sub":
                params["subscription_data"] = {"metadata": {"company_id": str(c["id"]), "plan": plan}}
            else:
                params["invoice_creation"] = {"enabled": True}
            if os.environ.get("STRIPE_AUTOMATIC_TAX") == "1":
                params["automatic_tax"] = {"enabled": True}
                params["customer_update"] = {"address": "auto", "name": "auto"}
                params["tax_id_collection"] = {"enabled": True}
            session = stripe.checkout.Session.create(**params)
            return jsonify({"url": session.url})
        except Exception as e:  # noqa: BLE001
            app.logger.exception("Stripe checkout failed")
            return err(f"Couldn't start the payment: {getattr(e, 'user_message', None) or e}", 502)

    @bp.post("/api/billing/portal")
    @login_required("admin")
    def portal():
        u = current_user()
        c = db().execute("SELECT stripe_customer_id FROM companies WHERE id=?", (u["company_id"],)).fetchone()
        if not c["stripe_customer_id"]:
            return err("There's no billing account yet. Buy a pack or plan first.")
        try:
            stripe = _stripe()
            base = os.environ.get("BASE_URL", request.host_url).rstrip("/")
            s = stripe.billing_portal.Session.create(customer=c["stripe_customer_id"], return_url=f"{base}/app?view=billing")
            return jsonify({"url": s.url})
        except Exception as e:  # noqa: BLE001
            app.logger.exception("Stripe portal failed")
            return err(f"Couldn't open the billing portal: {getattr(e, 'user_message', None) or e}", 502)

    @bp.post("/stripe/webhook")
    def webhook():
        secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
        payload = request.get_data()
        try:
            import stripe
            stripe.Webhook.construct_event(payload, request.headers.get("Stripe-Signature"), secret)
        except Exception:  # noqa: BLE001  bad signature or missing secret
            return "invalid signature", 400
        event = json.loads(payload)
        handle_event(db(), event, app.logger)
        return "ok", 200

    app.register_blueprint(bp)


def _company_for(con, obj):
    meta = obj.get("metadata") or {}
    cid = meta.get("company_id") or obj.get("client_reference_id")
    if cid:
        row = con.execute("SELECT * FROM companies WHERE id=?", (int(cid),)).fetchone()
        if row:
            return row
    cust = obj.get("customer")
    if cust:
        return con.execute("SELECT * FROM companies WHERE stripe_customer_id=?", (cust,)).fetchone()
    return None


def _apply_subscription(con, sub):
    c = _company_for(con, sub)
    if not c:
        return
    items = (sub.get("items") or {}).get("data") or [{}]
    item = items[0]
    price_id = (item.get("price") or {}).get("id")
    plan = plan_for_price(price_id) or (sub.get("metadata") or {}).get("plan")
    start = sub.get("current_period_start") or item.get("current_period_start") or time.time()
    end = sub.get("current_period_end") or item.get("current_period_end") or time.time()
    con.execute("UPDATE companies SET sub_id=?, sub_plan=?, sub_status=?, sub_period_start=?, sub_period_end=?, sub_cancel_at_end=?, stripe_customer_id=COALESCE(stripe_customer_id, ?) WHERE id=?",
                (sub.get("id"), plan, sub.get("status"), start, end, 1 if sub.get("cancel_at_period_end") else 0, sub.get("customer"), c["id"]))
    con.commit()


def handle_event(con, event, logger=None):
    etype = event.get("type", "")
    obj = (event.get("data") or {}).get("object") or {}
    if etype in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        if obj.get("mode") != "payment" or obj.get("payment_status") != "paid":
            return
        c = _company_for(con, obj)
        plan = PLANS.get((obj.get("metadata") or {}).get("plan"))
        if not c or not plan:
            if logger:
                logger.error("Paid checkout %s could not be matched to a company/plan", obj.get("id"))
            return
        try:
            con.execute("INSERT INTO payments(company_id, stripe_ref, plan, description, amount, currency, credits, created_at) VALUES(?,?,?,?,?,?,?,?)",
                        (c["id"], obj["id"], (obj.get("metadata") or {}).get("plan"), plan["label"], obj.get("amount_total"),
                         (obj.get("currency") or "").upper(), plan["credits"], time.time()))
        except Exception:  # noqa: BLE001  already processed (Stripe retries webhooks)
            return
        con.execute("UPDATE companies SET credits=credits+?, lens_credits=lens_credits+? WHERE id=?",
                    (plan["credits"], plan.get("lens_credits", 0), c["id"]))
        con.commit()
    elif etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        _apply_subscription(con, obj)
    elif etype == "invoice.paid" and (obj.get("subscription") or ((obj.get("parent") or {}).get("subscription_details") or {}).get("subscription")):
        c = _company_for(con, obj)
        if not c:
            return
        plan_key = c["sub_plan"]
        try:
            con.execute("INSERT INTO payments(company_id, stripe_ref, plan, description, amount, currency, credits, created_at) VALUES(?,?,?,?,?,?,?,?)",
                        (c["id"], obj["id"], plan_key, (PLANS.get(plan_key) or {}).get("label", "Subscription") + " (monthly)",
                         obj.get("amount_paid"), (obj.get("currency") or "").upper(), 0, time.time()))
            con.commit()
        except Exception:  # noqa: BLE001
            pass