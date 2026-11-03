"""Shared paths, config, time and text helpers for the outreach scripts."""
from __future__ import annotations

import datetime as dt
import json
import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(os.environ.get("OUTREACH_ROOT", Path(__file__).resolve().parent.parent))
DATA = ROOT / "data"
DB_PATH = Path(os.environ.get("OUTREACH_DB", DATA / "outreach.db"))
SECRETS = ROOT / "secrets"
REPORTS = ROOT / "reports"
STATE = ROOT / ".state"

FREE_MAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "aol.com", "outlook.com", "hotmail.com",
    "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "bellsouth.net", "att.net",
    "comcast.net", "charter.net", "protonmail.com", "proton.me", "ymail.com",
}

# Statuses that mean "never send a first-touch email to this company".
CONTACTED = {
    "emailed", "followed_up", "replied", "replied_no", "replied_question", "replied_interested",
    "not_now", "unsubscribed", "bounced", "pass", "meeting_pending", "meeting_booked",
    "call", "proposal", "won", "lost",
}
# Statuses that count as "they wrote back" for reply-rate math.
REPLIED = {
    "replied", "replied_no", "replied_question", "replied_interested", "not_now", "unsubscribed",
    "pass", "meeting_pending", "meeting_booked", "call", "proposal", "won", "lost",
}
POSITIVE = {"replied_interested", "meeting_pending", "meeting_booked", "call", "proposal", "won"}
# Pre-send pipeline.
PIPELINE = ["todo", "verified", "drafted", "approved", "queued"]
CLOSED = {"dropped", "cut", "archived"}
ALL_STATUSES = set(PIPELINE) | CONTACTED | CLOSED


def load_config() -> dict:
    with open(ROOT / "config.json") as f:
        return json.load(f)


def load_sender() -> dict:
    path = ROOT / "sender.local.json"
    if not path.exists():
        raise SystemExit("sender.local.json is missing. Copy sender.example.json to sender.local.json and fill it in.")
    with open(path) as f:
        return json.load(f)


def tz() -> ZoneInfo:
    return ZoneInfo(load_config()["timezone"])


def now_ct() -> dt.datetime:
    override = os.environ.get("OUTREACH_NOW")  # tests only: "2026-11-02T07:45"
    if override:
        return dt.datetime.fromisoformat(override).replace(tzinfo=tz())
    return dt.datetime.now(tz())


def today_ct() -> dt.date:
    return now_ct().date()


def iso_now() -> str:
    return now_ct().isoformat(timespec="seconds")


def parse_hhmm(s: str) -> dt.time:
    h, m = s.split(":")
    return dt.time(int(h), int(m))


def holidays() -> set[dt.date]:
    return {dt.date.fromisoformat(d) for d in load_config().get("holidays", [])}


def is_business_day(d: dt.date) -> bool:
    return d.weekday() < 5 and d not in holidays()


def add_business_days(d: dt.date, n: int) -> dt.date:
    hol = holidays()
    while n > 0:
        d += dt.timedelta(days=1)
        if d.weekday() < 5 and d not in hol:
            n -= 1
    return d


def business_days_between(start: dt.date, end: dt.date) -> int:
    """Business days after `start` up to and including `end`."""
    if end <= start:
        return 0
    hol = holidays()
    n, d = 0, start
    while d < end:
        d += dt.timedelta(days=1)
        if d.weekday() < 5 and d not in hol:
            n += 1
    return n


def next_send_day(d: dt.date) -> dt.date:
    while not is_business_day(d):
        d += dt.timedelta(days=1)
    return d


def normalize_domain(value: str | None) -> str:
    """'https://www.Foo.com/contact' -> 'foo.com'."""
    if not value:
        return ""
    v = value.strip().lower()
    v = re.sub(r"^[a-z]+://", "", v)
    v = v.split("/")[0].split("?")[0].split("#")[0].split(":")[0]
    if v.startswith("www."):
        v = v[4:]
    return v.strip(".")


def email_domain(email: str | None) -> str:
    if not email or "@" not in email:
        return ""
    return email.strip().lower().rsplit("@", 1)[1]


def company_domain_from_email(email: str | None) -> str:
    """Email domain, unless it's a free-mail provider (gmail.com must never block a company)."""
    d = email_domain(email)
    return "" if d in FREE_MAIL else d


def split_emails(value: str | None) -> list[str]:
    if not value:
        return []
    return [e.strip().lower() for e in re.split(r"[;,\s]+", value) if "@" in e]


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60] or "company"


_PRO = re.compile(r"mortgage|insurance|\bcpas?\b|accounting|accountant|bookkeep|\btax\b|\blaw\b|law firm|attorney|legal|\btitle\b|real estate|realt|financial|wealth|lender|lending|escrow|apprais|payroll", re.I)
_FIELD = re.compile(r"hvac|plumb|electric|roof|pest|termite|lawn|landscap|\btree\b|arborist|cleaning|pressure wash|garage door|contractor|remodel|\bpools?\b|moving|movers|junk|dumpster|wrecker|\btow(ing)?\b|\bpainting\b|\bpainters?\b|gutter|fenc|handyman|restoration|septic|irrigation|locksmith|appliance repair|flooring|glazing|field service|\btrades?\b", re.I)
_NONPROFIT = re.compile(r"nonprofit|non-profit|church|ministr|school|montessori|preschool|foundation|charit|chamber of commerce|trade association|council|museum|ymca|land trust|riverkeeper|waterkeeper", re.I)


def bucket_for(sector: str | None, kind: str | None) -> str:
    """Map a company to one of the campaign mix buckets: professional, field, nonprofit, other."""
    s, k = (sector or "").lower(), (kind or "").lower()
    if "nonprofit" in s or "school" in s or "church" in s or s in {"preschool", "kids program (theatre classes and camps, nonprofit)"} or s.startswith("trade association"):
        return "nonprofit"
    if s == "field service":
        return "field"
    text = f"{s} {k}"
    if _NONPROFIT.search(text):
        return "nonprofit"
    if _PRO.search(text):
        return "professional"
    if _FIELD.search(text) or ("construction" in s and "construct" in k):
        return "field"
    if s == "professional services":
        return "professional"
    return "other"
