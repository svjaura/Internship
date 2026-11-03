#!/usr/bin/env python3
"""SQLite store for the outreach system, plus a CLI for everything that touches it.

Nothing in this file deletes rows. Use `archive` or a status change instead.

  python3 scripts/db.py init
  python3 scripts/db.py import-history data/import/prospects_history.csv
  python3 scripts/db.py load-deals data/import/active_deals.json
  python3 scripts/db.py reconcile-sent data/import/sent_sweep.csv
  python3 scripts/db.py add-prospects new.json --wave nov-campaign
  python3 scripts/db.py refresh-apply verdicts.json
  python3 scripts/db.py check someone@company.com --website company.com
  python3 scripts/db.py suppress someone@company.com --reason "asked to be removed"
  python3 scripts/db.py set oak-street-roofing status=meeting_booked meeting_at=2026-11-03T16:00
  python3 scripts/db.py note oak-street-roofing "She sent sample inspection notes"
  python3 scripts/db.py show oak-street-roofing
  python3 scripts/db.py list --status verified --bucket field
  python3 scripts/db.py mix
  python3 scripts/db.py archive some-company --reason "closed"
  python3 scripts/db.py backup
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    ALL_STATUSES, CONTACTED, DATA, DB_PATH, FREE_MAIL, ROOT, bucket_for, company_domain_from_email,
    iso_now, load_config, normalize_domain, slugify, split_emails, today_ct,
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    short_name TEXT,
    greeting_name TEXT,
    website TEXT,
    domain TEXT,
    email_domain TEXT,
    city TEXT,
    sector TEXT,
    kind TEXT,
    bucket TEXT,
    size_signal TEXT,
    contact_name TEXT,
    contact_role TEXT,
    email TEXT,
    alt_emails TEXT,
    email_source_url TEXT,
    phone TEXT,
    workflow TEXT,
    workflow_short TEXT,
    why_pay TEXT,
    evidence TEXT,
    source_urls TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    fit TEXT,
    source TEXT,
    wave TEXT,
    priority INTEGER,
    verified_at TEXT,
    drafted_at TEXT,
    approved_at TEXT,
    sent_at TEXT,
    followed_up_at TEXT,
    replied_at TEXT,
    meeting_at TEXT,
    gmail_thread_id TEXT,
    legacy_thread_id TEXT,
    legacy_draft_id TEXT,
    reply_class TEXT,
    reply_summary TEXT,
    next_step TEXT,
    next_step_due TEXT,
    notes TEXT,
    legacy_subject TEXT,
    legacy_body TEXT,
    created_at TEXT,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_companies_email ON companies(email);

CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL REFERENCES companies(id),
    name TEXT,
    role TEXT,
    email TEXT,
    source_url TEXT,
    is_primary INTEGER DEFAULT 0,
    created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_unique ON contacts(company_id, IFNULL(email, ''), IFNULL(name, ''));

-- Every email this system creates. gmail_draft_id is the ownership record:
-- scripts/gmail.py refuses to act on any draft or thread that isn't in here.
CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id TEXT NOT NULL REFERENCES companies(id),
    kind TEXT NOT NULL CHECK (kind IN ('first_touch', 'follow_up', 'reply')),
    to_addr TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    gmail_draft_id TEXT UNIQUE,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'drafted'
        CHECK (status IN ('drafted', 'approved', 'queued', 'sending', 'sent', 'failed', 'cut', 'bounced', 'superseded')),
    scheduled_for TEXT,
    voice_warnings TEXT,
    attachments TEXT,
    created_at TEXT,
    approved_at TEXT,
    sent_at TEXT,
    error TEXT
);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
CREATE INDEX IF NOT EXISTS idx_emails_thread ON emails(gmail_thread_id);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    company_id TEXT,
    type TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_company ON events(company_id);

CREATE TABLE IF NOT EXISTS suppression (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    domain TEXT,
    reason TEXT NOT NULL,
    company_id TEXT,
    source TEXT,
    added_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppression_unique ON suppression(IFNULL(email, ''), IFNULL(domain, ''));

-- Every inbound message seen in a tracked thread (replies, bounces, auto-replies).
CREATE TABLE IF NOT EXISTS inbound (
    message_id TEXT PRIMARY KEY,
    company_id TEXT,
    thread_id TEXT,
    received_at TEXT,
    from_addr TEXT,
    subject TEXT,
    snippet TEXT,
    rule_class TEXT,
    final_class TEXT,
    summary TEXT,
    seen_at TEXT,
    handled_at TEXT
);

-- Every Gmail thread tied to a company (outreach threads, conversation threads, threads they started).
CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    source TEXT,
    added_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
);
"""

COMPANY_FIELDS = [
    "company", "short_name", "greeting_name", "website", "domain", "email_domain", "city", "sector", "kind", "bucket",
    "size_signal", "contact_name", "contact_role", "email", "alt_emails", "email_source_url", "phone",
    "workflow", "workflow_short", "why_pay", "evidence", "source_urls", "status", "fit", "source", "wave", "priority",
    "verified_at", "drafted_at", "approved_at", "sent_at", "followed_up_at", "replied_at", "meeting_at",
    "gmail_thread_id", "legacy_thread_id", "legacy_draft_id", "reply_class", "reply_summary",
    "next_step", "next_step_due", "notes", "legacy_subject", "legacy_body",
]


# ---------------------------------------------------------------- connection

def connect(path: Path | str | None = None) -> sqlite3.Connection:
    p = Path(path or DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    # Forward-compatible: add any company column a newer version of this file expects.
    have = {r["name"] for r in conn.execute("PRAGMA table_info(companies)")}
    for col in COMPANY_FIELDS:
        if col not in have:
            conn.execute(f"ALTER TABLE companies ADD COLUMN {col} TEXT")
    if "attachments" not in {r["name"] for r in conn.execute("PRAGMA table_info(emails)")}:
        conn.execute("ALTER TABLE emails ADD COLUMN attachments TEXT")
    return conn


def log_event(conn, company_id: str | None, type_: str, detail: str = "") -> None:
    conn.execute("INSERT INTO events (ts, company_id, type, detail) VALUES (?, ?, ?, ?)",
                 (iso_now(), company_id, type_, detail))


def get_setting(conn, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(conn, key: str, value: str | None) -> None:
    conn.execute("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
                 "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                 (key, value, iso_now()))


def get_company(conn, company_id: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM companies WHERE id = ?", (company_id,)).fetchone()


def update_company(conn, company_id: str, **fields) -> None:
    bad = set(fields) - set(COMPANY_FIELDS)
    if bad:
        raise ValueError(f"unknown company fields: {sorted(bad)}")
    if "status" in fields and fields["status"] not in ALL_STATUSES:
        raise ValueError(f"unknown status {fields['status']!r}. Allowed: {sorted(ALL_STATUSES)}")
    if not fields:
        return
    old = get_company(conn, company_id)
    if old is None:
        raise KeyError(f"no company with id {company_id!r}")
    fields["updated_at"] = iso_now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE companies SET {cols} WHERE id = ?", (*fields.values(), company_id))
    if "status" in fields and fields["status"] != old["status"]:
        log_event(conn, company_id, "status", f"{old['status']} -> {fields['status']}")


def append_note(conn, company_id: str, note: str) -> None:
    row = get_company(conn, company_id)
    stamp = today_ct().isoformat()
    notes = (row["notes"] + "\n" if row["notes"] else "") + f"[{stamp}] {note}"
    update_company(conn, company_id, notes=notes)
    log_event(conn, company_id, "note", note)


def track_thread(conn, thread_id: str, company_id: str, source: str) -> None:
    conn.execute("INSERT OR IGNORE INTO threads (thread_id, company_id, source, added_at) VALUES (?, ?, ?, ?)",
                 (thread_id, company_id, source, iso_now()))


def unique_id(conn, base: str) -> str:
    cid, n = base, 2
    while get_company(conn, cid):
        cid, n = f"{base}-{n}", n + 1
    return cid


def add_contact(conn, company_id, name, role, email, source_url=None, primary=False) -> None:
    if not (name or email):
        return
    conn.execute(
        "INSERT OR IGNORE INTO contacts (company_id, name, role, email, source_url, is_primary, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (company_id, name or None, role or None, (email or "").lower() or None, source_url, int(primary), iso_now()))


# ---------------------------------------------------------------- suppression & dedupe

def suppress(conn, email: str | None = None, domain: str | None = None, reason: str = "",
             company_id: str | None = None, source: str = "manual") -> bool:
    email = (email or "").strip().lower() or None
    domain = normalize_domain(domain) or None
    if domain in FREE_MAIL:
        domain = None  # never block every gmail.com address because of one company
    if not (email or domain):
        return False
    cur = conn.execute(
        "INSERT OR IGNORE INTO suppression (email, domain, reason, company_id, source, added_at) VALUES (?, ?, ?, ?, ?, ?)",
        (email, domain, reason, company_id, source, iso_now()))
    if not cur.rowcount and NEVER_AGAIN.search(reason):
        # A decline, removal or bounce outranks "already contacted": upgrade the reason in place (history is in events).
        cur = conn.execute(
            "UPDATE suppression SET reason = ?, source = ?, company_id = COALESCE(company_id, ?), added_at = ? "
            "WHERE IFNULL(email, '') = ? AND IFNULL(domain, '') = ? AND reason NOT LIKE ?",
            (reason, source, company_id, iso_now(), email or "", domain or "", reason))
    if cur.rowcount:
        log_event(conn, company_id, "suppressed", f"{email or ''} {domain or ''}: {reason}".strip())
    return bool(cur.rowcount)


def suppress_company(conn, company_id: str, reason: str, source: str) -> None:
    c = get_company(conn, company_id)
    emails = split_emails(c["email"]) + split_emails(c["alt_emails"])
    for e in emails:
        suppress(conn, email=e, reason=reason, company_id=company_id, source=source)
    for d in {c["domain"], c["email_domain"], *(company_domain_from_email(e) for e in emails)}:
        if d:
            suppress(conn, domain=d, reason=reason, company_id=company_id, source=source)


def dedupe_hits(conn, email: str | None, website: str | None, exclude_id: str | None = None) -> list[str]:
    """Every reason this email/website collides with something already known. Empty list = clean."""
    hits = []
    emails = split_emails(email)
    domains = {normalize_domain(website)} | {company_domain_from_email(e) for e in emails}
    domains.discard("")
    for e in emails:
        for r in conn.execute("SELECT email, reason FROM suppression WHERE email = ?", (e,)):
            hits.append(f"suppressed email {r['email']} ({r['reason']})")
    for d in domains:
        for r in conn.execute("SELECT domain, reason FROM suppression WHERE domain = ?", (d,)):
            hits.append(f"suppressed domain {r['domain']} ({r['reason']})")
    for c in conn.execute("SELECT id, status, email, alt_emails, domain, email_domain FROM companies"):
        if c["id"] == exclude_id:
            continue
        known = set(split_emails(c["email"]) + split_emails(c["alt_emails"]))
        for e in emails:
            if e in known:
                hits.append(f"email {e} already in database as {c['id']} ({c['status']})")
        for d in domains:
            if d in {c["domain"], c["email_domain"]}:
                hits.append(f"domain {d} already in database as {c['id']} ({c['status']})")
    return sorted(set(hits))


# Suppression reasons that only mean "don't cold-email again". A company's own soft rows don't block
# its follow-up, and they never block a reply Sai approved.
SOFT_REASONS = {"already contacted", "in conversation", "passed", "emailed before (not in history CSV)"}
# Reasons that block every future email, replies included.
NEVER_AGAIN = re.compile(r"declin|remov|unsubscrib|bounc|no thanks", re.I)
PRE_SEND = {"verified", "drafted", "approved", "queued"}


def send_blockers(conn, company_id: str, to_addr: str, kind: str = "first_touch") -> list[str]:
    """Reasons this email must NOT go out. Checked at draft time and again right before each send."""
    c = get_company(conn, company_id)
    if c is None:
        return [f"unknown company {company_id}"]
    to = to_addr.strip().lower()
    domains = {c["domain"], company_domain_from_email(to)} - {"", None}
    rows = list(conn.execute("SELECT * FROM suppression WHERE email = ?", (to,)))
    for d in domains:
        rows += list(conn.execute("SELECT * FROM suppression WHERE domain = ?", (d,)))
    reasons = []
    if kind == "first_touch":
        if c["status"] not in PRE_SEND:
            reasons.append(f"{company_id} is {c['status']}, first-touch only goes to verified/approved companies")
        reasons += [f"suppressed {r['email'] or r['domain']}: {r['reason']}" for r in rows]
    elif kind == "follow_up":
        if c["status"] != "emailed":
            reasons.append(f"{company_id} is {c['status']}, the follow-up only goes to 'emailed' with no reply")
        reasons += [f"suppressed {r['email'] or r['domain']}: {r['reason']}" for r in rows
                    if not (r["company_id"] == company_id and r["reason"] in SOFT_REASONS)]
    else:  # reply: they're already talking to Sai, but never after a no / removal / bounce
        reasons += [f"suppressed {r['email']}: {r['reason']}" for r in rows
                    if r["email"] == to and NEVER_AGAIN.search(r["reason"])]
    return sorted(set(reasons))


# ---------------------------------------------------------------- import

def _legacy_status_reason(status: str, notes: str) -> str:
    if re.search(r"bounc", notes or "", re.I):
        return "bounced"
    return {
        "replied_no": "declined",
        "pass": "passed",
        "emailed": "already contacted",
        "followed_up": "already contacted",
    }.get(status, "in conversation")


def import_history(conn, csv_path: str, force: bool = False) -> dict:
    stats = {"inserted": 0, "skipped_existing": 0, "suppressed_companies": 0}
    with open(csv_path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        cid = r["id"].strip()
        if get_company(conn, cid) and not force:
            stats["skipped_existing"] += 1
            continue
        emails = split_emails(r["email"])
        kind = (r["kind"] or "").strip()
        size = ""
        if re.fullmatch(r"[\d\s\-–+~]+", kind):  # the CSV put staff counts in 'kind' for some rows
            size, kind = kind, ""
        contact = (r["contact_name"] or "").strip()
        if contact.lower() in {"not found", "n/a", "unknown"}:
            contact = ""
        notes = r["notes"] or ""
        legacy_draft = re.search(r"Draft (r-?\d+)", notes)
        wave = re.search(r"Wave (\d+)", notes)
        fields = dict(
            company=r["company"].strip(), website=r["website"].strip(), domain=normalize_domain(r["website"]),
            email_domain=company_domain_from_email(emails[0]) if emails else "",
            city=r["city"].strip(), sector=r["sector"].strip(), kind=kind,
            bucket=bucket_for(r["sector"], r["kind"]), size_signal=size,
            contact_name=contact, contact_role=(r["contact_role"] or "").strip(),
            email=emails[0] if emails else "", alt_emails="; ".join(emails[1:]),
            phone=r["phone"].strip(), workflow=r["ai_workflow"].strip(),
            status=r["status"].strip(), fit=r["fit"].strip(), source="legacy_csv",
            wave=f"wave-{wave.group(1)}" if wave else "legacy",
            sent_at=r["emailed_at"] or None, followed_up_at=r["followed_up_at"] or None,
            replied_at=r["replied_at"] or None, reply_summary=r["reply_note"] or None,
            next_step=r["next"] or None, notes=notes or None,
            legacy_draft_id=legacy_draft.group(1) if legacy_draft else None,
            legacy_subject=r["email_subject"] or None, legacy_body=r["email_body"] or None,
        )
        if r["status"] == "todo" and legacy_draft:
            fields["notes"] = (notes + "\n" if notes else "") + (
                "Legacy Wave 3 draft was never sent (checked Gmail Sent on 2026-10-28). "
                "That old Gmail draft was not created by this system, so it is never touched.")
        now = iso_now()
        conn.execute(
            f"INSERT OR REPLACE INTO companies (id, {', '.join(fields)}, created_at, updated_at) "
            f"VALUES (?, {', '.join('?' * len(fields))}, ?, ?)", (cid, *fields.values(), now, now))
        add_contact(conn, cid, contact, fields["contact_role"], fields["email"], None, primary=True)
        for e in emails[1:]:
            add_contact(conn, cid, None, None, e)
        log_event(conn, cid, "imported", f"from {Path(csv_path).name} with status {r['status']}")
        if r["status"].strip() != "todo":
            suppress_company(conn, cid, _legacy_status_reason(r["status"], notes + " " + (r["next"] or "")), "history_csv")
            stats["suppressed_companies"] += 1
        stats["inserted"] += 1
    conn.commit()
    return stats


def load_deals(conn, json_path: str) -> list[str]:
    """Active deals from Sai: never cold-email, always show on /status with their next step."""
    with open(json_path) as f:
        deals = json.load(f)
    done = []
    for d in deals:
        cid = d.get("id") or slugify(d["company"])
        existing = get_company(conn, cid)
        primary = (d.get("email") or "").lower()
        alts = set(split_emails(d.get("alt_emails", "")))
        if existing:
            alts |= set(split_emails(existing["email"])) | set(split_emails(existing["alt_emails"]))
        alts.discard(primary)
        fields = {k: v for k, v in dict(
            company=d.get("company"), contact_name=d.get("contact_name"), contact_role=d.get("contact_role"),
            email=primary or None, alt_emails="; ".join(sorted(alts)) or None, status=d["status"],
            workflow=d.get("workflow"), next_step=d.get("next_step"), next_step_due=d.get("next_step_due"),
            website=d.get("website"),
        ).items() if v}
        if existing:
            update_company(conn, cid, **fields)
            if d.get("note"):
                append_note(conn, cid, d["note"])
        else:
            now = iso_now()
            fields.update(domain=normalize_domain(d.get("website") or ""), source="active_deal", fit="High",
                          bucket=d.get("bucket", "other"), notes=d.get("note"),
                          email_domain=company_domain_from_email(primary))
            conn.execute(
                f"INSERT INTO companies (id, {', '.join(fields)}, created_at, updated_at) "
                f"VALUES (?, {', '.join('?' * len(fields))}, ?, ?)", (cid, *fields.values(), now, now))
            log_event(conn, cid, "created", "active deal")
        for c in d.get("contacts", []):
            add_contact(conn, cid, c.get("name"), c.get("role"), c.get("email"), primary=c.get("primary", False))
        for dom in d.get("extra_domains", []):
            suppress(conn, domain=dom, reason="in conversation", company_id=cid, source="active_deals")
        for c in d.get("contacts", []):
            if c.get("email"):
                suppress(conn, email=c["email"], reason="in conversation", company_id=cid, source="active_deals")
        suppress_company(conn, cid, "in conversation", "active_deals")
        log_event(conn, cid, "active_deal", d.get("next_step") or "")
        done.append(cid)
    conn.commit()
    return done


def reconcile_sent(conn, csv_path: str, own_addresses: set[str]) -> dict:
    """Match a Gmail Sent sweep against the DB so nobody who was already emailed looks 'fresh'."""
    stats = {"threads": 0, "todo_now_emailed": [], "followups_found": [], "unmatched_suppressed": [],
             "possible_unrecorded_replies": [], "threads_linked": 0}
    by_email, by_domain = {}, {}
    for c in conn.execute("SELECT id, email, alt_emails, domain, email_domain FROM companies"):
        for e in split_emails(c["email"]) + split_emails(c["alt_emails"]):
            by_email[e] = c["id"]
        for d in (c["domain"], c["email_domain"]):
            if d:
                by_domain.setdefault(d, c["id"])
    for r in conn.execute("SELECT company_id, email FROM contacts WHERE email IS NOT NULL"):
        by_email.setdefault(r["email"].lower(), r["company_id"])
    for r in conn.execute("SELECT company_id, domain FROM suppression WHERE domain IS NOT NULL AND company_id IS NOT NULL"):
        by_domain.setdefault(r["domain"], r["company_id"])
    with open(csv_path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            stats["threads"] += 1
            addrs = [a for a in split_emails(r["to_addresses"]) if a not in own_addresses]
            if not addrs:
                continue
            cid = next((by_email[a] for a in addrs if a in by_email), None) or next(
                (by_domain[company_domain_from_email(a)] for a in addrs if company_domain_from_email(a) in by_domain), None)
            if cid is None:
                for a in addrs:
                    if suppress(conn, email=a, reason="emailed before (not in history CSV)", source="sent_sweep"):
                        stats["unmatched_suppressed"].append(a)
                continue
            c = get_company(conn, cid)
            track_thread(conn, r["thread_id"], cid, "sent_sweep")
            if not c["legacy_thread_id"]:
                update_company(conn, cid, legacy_thread_id=r["thread_id"])
                stats["threads_linked"] += 1
            if c["status"] in {"todo", "verified"}:
                update_company(conn, cid, status="emailed", sent_at=r["first_sent_date"])
                append_note(conn, cid, f"Found in Gmail Sent ({r['first_sent_date']}) even though the CSV said todo.")
                suppress_company(conn, cid, "already contacted", "sent_sweep")
                stats["todo_now_emailed"].append(cid)
                c = get_company(conn, cid)
            if c["status"] == "emailed" and int(r.get("user_message_count") or 1) >= 2 and not c["followed_up_at"]:
                update_company(conn, cid, status="followed_up", followed_up_at=r["last_sent_date"])
                stats["followups_found"].append(cid)
                c = get_company(conn, cid)
            inbound = (r.get("has_inbound_reply") or "").lower() == "yes"
            sender = (r.get("first_inbound_sender") or "").lower()
            if inbound and c["status"] in {"emailed", "followed_up"}:
                if re.search(r"mailer-daemon|postmaster", sender):
                    if c["status"] != "bounced":
                        append_note(conn, cid, f"Gmail shows a bounce in thread {r['thread_id']}.")
                        suppress_company(conn, cid, "bounced", "sent_sweep")
                elif c["reply_class"] != "unreviewed" and not re.search(r"out.of.office|auto-?reply|repl(y|ied)", c["notes"] or "", re.I):
                    # Could be a real reply or an auto-reply. Status stays as the CSV had it; /replies reads it.
                    update_company(conn, cid, reply_class="unreviewed")
                    append_note(conn, cid, f"Gmail shows a message from {sender} on {r.get('first_inbound_date')} "
                                           f"in thread {r['thread_id']} that the CSV doesn't record. /replies will read it.")
                    stats["possible_unrecorded_replies"].append(cid)
    conn.commit()
    return stats


REQUIRED_PROSPECT = ["company", "website", "city", "email", "email_source_url", "workflow", "why_pay", "evidence", "fit"]


def add_prospects(conn, items: list[dict], wave: str) -> dict:
    out = {"added": [], "rejected": []}
    metro = {c.lower() for c in load_config()["metro_cities"]}
    for p in items:
        missing = [k for k in REQUIRED_PROSPECT if not str(p.get(k) or "").strip()]
        name = p.get("company", "?")
        if missing:
            out["rejected"].append((name, f"missing {missing}"))
            continue
        if p["fit"] not in ("High", "Medium"):
            out["rejected"].append((name, f"fit {p['fit']} (only High and Medium are kept)"))
            continue
        if not any(m in p["city"].lower() for m in metro):
            out["rejected"].append((name, f"city {p['city']!r} is outside the metro list in config.json"))
            continue
        hits = dedupe_hits(conn, p["email"], p["website"])
        if hits:
            out["rejected"].append((name, "; ".join(hits)))
            continue
        cid = unique_id(conn, slugify(p.get("id") or name))
        email = split_emails(p["email"])[0]
        src = p.get("source_urls")
        fields = dict(
            company=name, short_name=p.get("short_name"), website=p["website"],
            domain=normalize_domain(p["website"]), email_domain=company_domain_from_email(email),
            city=p["city"], sector=p.get("sector"), kind=p.get("kind"),
            bucket=p.get("bucket") or bucket_for(p.get("sector"), p.get("kind")),
            size_signal=p.get("size_signal"), contact_name=p.get("contact_name"), contact_role=p.get("contact_role"),
            email=email, email_source_url=p["email_source_url"], phone=p.get("phone"),
            workflow=p["workflow"], why_pay=p["why_pay"], evidence=p["evidence"],
            source_urls="\n".join(src) if isinstance(src, list) else src,
            status="verified", fit=p["fit"], source="prospect", wave=wave, verified_at=iso_now(), notes=p.get("notes"),
        )
        now = iso_now()
        conn.execute(
            f"INSERT INTO companies (id, {', '.join(fields)}, created_at, updated_at) "
            f"VALUES (?, {', '.join('?' * len(fields))}, ?, ?)", (cid, *fields.values(), now, now))
        add_contact(conn, cid, p.get("contact_name"), p.get("contact_role"), email, p["email_source_url"], primary=True)
        log_event(conn, cid, "prospected", f"{wave}: {p['workflow']}")
        out["added"].append(cid)
    conn.commit()
    return out


def refresh_apply(conn, items: list[dict], wave: str) -> dict:
    """Verdicts from re-verifying the old `todo` pool: keep (-> verified, with updated fields) or drop."""
    out = {"verified": [], "dropped": [], "rejected": []}
    editable = {"short_name", "website", "city", "sector", "kind", "size_signal", "contact_name", "contact_role",
                "email", "email_source_url", "phone", "workflow", "why_pay", "evidence", "source_urls", "fit", "bucket"}
    for v in items:
        cid = v["id"]
        c = get_company(conn, cid)
        if c is None:
            out["rejected"].append((cid, "not in database"))
            continue
        if c["status"] != "todo":
            out["rejected"].append((cid, f"status is {c['status']}, only todo rows get refreshed"))
            continue
        if v["verdict"] == "drop":
            update_company(conn, cid, status="dropped")
            append_note(conn, cid, f"Dropped in refresh: {v.get('reason', 'no reason given')}")
            out["dropped"].append(cid)
            continue
        fields = {k: v[k] for k in editable if v.get(k) not in (None, "")}
        if isinstance(fields.get("source_urls"), list):
            fields["source_urls"] = "\n".join(fields["source_urls"])
        merged = {**dict(c), **fields}
        missing = [k for k in ("email", "email_source_url", "workflow", "why_pay", "evidence") if not merged.get(k)]
        if missing:
            out["rejected"].append((cid, f"missing {missing}"))
            continue
        if merged["fit"] not in ("High", "Medium"):
            update_company(conn, cid, status="dropped", fit=merged["fit"])
            append_note(conn, cid, f"Dropped in refresh: fit {merged['fit']}")
            out["dropped"].append(cid)
            continue
        hits = dedupe_hits(conn, merged["email"], merged["website"], exclude_id=cid)
        if hits:
            out["rejected"].append((cid, "; ".join(hits)))
            continue
        email = split_emails(merged["email"])[0]
        fields.update(email=email, email_domain=company_domain_from_email(email), domain=normalize_domain(merged["website"]),
                      status="verified", verified_at=iso_now(), wave=wave)
        if "bucket" not in fields:
            fields["bucket"] = bucket_for(merged["sector"], merged["kind"])
        update_company(conn, cid, **fields)
        add_contact(conn, cid, merged.get("contact_name"), merged.get("contact_role"), email, merged.get("email_source_url"), primary=True)
        out["verified"].append(cid)
    conn.commit()
    return out


# ---------------------------------------------------------------- CLI

def own_addresses(email: str) -> set[str]:
    """Gmail ignores dots, so vs.name@gmail.com and vsname@gmail.com are the same inbox."""
    email = email.strip().lower()
    if not email:
        return set()
    local, _, dom = email.partition("@")
    out = {email}
    if dom in ("gmail.com", "googlemail.com"):
        out.add(local.replace(".", "") + "@" + dom)
    return out


def backup(conn=None) -> Path:
    dest = DATA / "backups"
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"outreach-{iso_now().replace(':', '').replace('-', '')[:15]}.db"
    src = connect()
    dst = sqlite3.connect(out)
    src.backup(dst)
    dst.close()
    return out


def _print_rows(rows, cols):
    rows = list(rows)
    if not rows:
        print("(none)")
        return
    widths = {c: min(40, max(len(c), *(len(str(r[c] or "")) for r in rows))) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r[c] or "")[:widths[c]].ljust(widths[c]) for c in cols))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init")
    p = sub.add_parser("import-history"); p.add_argument("csv"); p.add_argument("--force", action="store_true")
    p = sub.add_parser("load-deals"); p.add_argument("json")
    p = sub.add_parser("reconcile-sent"); p.add_argument("csv")
    p = sub.add_parser("add-prospects"); p.add_argument("json"); p.add_argument("--wave", required=True)
    p = sub.add_parser("refresh-apply"); p.add_argument("json"); p.add_argument("--wave", required=True)
    p = sub.add_parser("check"); p.add_argument("email"); p.add_argument("--website", default="")
    p = sub.add_parser("suppress"); p.add_argument("email", nargs="?"); p.add_argument("--domain"); p.add_argument("--reason", required=True); p.add_argument("--company")
    p = sub.add_parser("set"); p.add_argument("id"); p.add_argument("pairs", nargs="+")
    p = sub.add_parser("note"); p.add_argument("id"); p.add_argument("text")
    p = sub.add_parser("show"); p.add_argument("id")
    p = sub.add_parser("list"); p.add_argument("--status"); p.add_argument("--bucket"); p.add_argument("--fit"); p.add_argument("--limit", type=int, default=50)
    sub.add_parser("mix")
    p = sub.add_parser("archive"); p.add_argument("id"); p.add_argument("--reason", required=True)
    sub.add_parser("backup")
    p = sub.add_parser("export"); p.add_argument("csv"); p.add_argument("--status")
    a = ap.parse_args(argv)

    conn = connect()
    if a.cmd == "init":
        print(f"Database ready at {DB_PATH}")
    elif a.cmd == "import-history":
        print(import_history(conn, a.csv, a.force))
    elif a.cmd == "load-deals":
        print("Loaded active deals:", ", ".join(load_deals(conn, a.json)))
    elif a.cmd == "reconcile-sent":
        sender = json.loads((ROOT / "sender.local.json").read_text()) if (ROOT / "sender.local.json").exists() else {}
        stats = reconcile_sent(conn, a.csv, own_addresses(sender.get("email", "")))
        print(json.dumps(stats, indent=2))
    elif a.cmd == "add-prospects":
        out = add_prospects(conn, json.loads(Path(a.json).read_text()), a.wave)
        print(f"Added {len(out['added'])}: {', '.join(out['added'])}")
        for name, why in out["rejected"]:
            print(f"Rejected {name}: {why}")
    elif a.cmd == "refresh-apply":
        backup()
        out = refresh_apply(conn, json.loads(Path(a.json).read_text()), a.wave)
        print(f"Verified {len(out['verified'])}, dropped {len(out['dropped'])}, rejected {len(out['rejected'])}")
        for cid, why in out["rejected"]:
            print(f"  rejected {cid}: {why}")
    elif a.cmd == "check":
        hits = dedupe_hits(conn, a.email, a.website)
        print("\n".join(hits) if hits else "clean: not in database, not suppressed")
    elif a.cmd == "suppress":
        ok = suppress(conn, email=a.email, domain=a.domain, reason=a.reason, company_id=a.company, source="manual")
        conn.commit()
        print("added to suppression" if ok else "already suppressed")
    elif a.cmd == "set":
        fields = dict(pair.split("=", 1) for pair in a.pairs)
        update_company(conn, a.id, **{k: (v or None) for k, v in fields.items()})
        conn.commit()
        print(f"updated {a.id}: {fields}")
    elif a.cmd == "note":
        append_note(conn, a.id, a.text)
        conn.commit()
        print("noted")
    elif a.cmd == "show":
        c = get_company(conn, a.id)
        if not c:
            raise SystemExit(f"no company {a.id}")
        for k in c.keys():
            if c[k] not in (None, ""):
                print(f"{k:18} {c[k]}")
        print("\ncontacts:")
        _print_rows(conn.execute("SELECT name, role, email, source_url FROM contacts WHERE company_id = ?", (a.id,)),
                    ["name", "role", "email", "source_url"])
        print("\nemails:")
        _print_rows(conn.execute("SELECT id, kind, status, subject, scheduled_for, sent_at FROM emails WHERE company_id = ?", (a.id,)),
                    ["id", "kind", "status", "subject", "scheduled_for", "sent_at"])
        print("\nlast events:")
        _print_rows(conn.execute("SELECT ts, type, detail FROM events WHERE company_id = ? ORDER BY id DESC LIMIT 10", (a.id,)),
                    ["ts", "type", "detail"])
    elif a.cmd == "list":
        q, args = "SELECT id, company, status, fit, bucket, city, email FROM companies WHERE 1=1", []
        for col in ("status", "bucket", "fit"):
            if getattr(a, col):
                q += f" AND {col} = ?"
                args.append(getattr(a, col))
        _print_rows(conn.execute(q + " ORDER BY company LIMIT ?", (*args, a.limit)), ["id", "company", "status", "fit", "bucket", "city", "email"])
    elif a.cmd == "mix":
        cfg = load_config()
        target = cfg["campaign_target"]
        print(f"Campaign pool by bucket (target {target})")
        for b, share in cfg["mix_targets"].items():
            counts = {s: conn.execute("SELECT COUNT(*) FROM companies WHERE bucket = ? AND status = ?", (b, s)).fetchone()[0]
                      for s in ("todo", "verified", "drafted", "approved", "queued")}
            print(f"  {b:13} want {round(target * share):3}  verified {counts['verified']:3}  drafted {counts['drafted']:3}  "
                  f"approved {counts['approved'] + counts['queued']:3}  old todo {counts['todo']:3}")
    elif a.cmd == "archive":
        update_company(conn, a.id, status="archived")
        append_note(conn, a.id, f"Archived: {a.reason}")
        conn.commit()
        print(f"archived {a.id} (nothing deleted)")
    elif a.cmd == "backup":
        print(f"backup written to {backup()}")
    elif a.cmd == "export":
        q = "SELECT * FROM companies" + (" WHERE status = ?" if a.status else "")
        rows = conn.execute(q, (a.status,) if a.status else ()).fetchall()
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(rows[0].keys() if rows else [])
            w.writerows([tuple(r) for r in rows])
        print(f"wrote {len(rows)} rows to {a.csv}")
    conn.commit()


if __name__ == "__main__":
    main()
