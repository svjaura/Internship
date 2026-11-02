"""End-to-end tests against a fake mailbox and a throwaway database. Made-up companies only.

  python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import csv
import datetime as dt
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _testenv import SENDER, SRC, TMP  # noqa: E402  (sets up the sandbox first)


import common  # noqa: E402
import db  # noqa: E402
import drafts  # noqa: E402
import gmail  # noqa: E402
import replies  # noqa: E402
import scheduler  # noqa: E402
import voicecheck  # noqa: E402


class Clock:
    """Fake wall clock: sleeping advances OUTREACH_NOW."""

    def __init__(self, start: str):
        self.t = dt.datetime.fromisoformat(start)
        self._set()

    def _set(self):
        os.environ["OUTREACH_NOW"] = self.t.isoformat(timespec="seconds")

    def now(self):
        return common.now_ct()

    def sleep(self, seconds):
        self.t += dt.timedelta(seconds=seconds)
        self._set()

    def at(self, iso):
        self.t = dt.datetime.fromisoformat(iso)
        self._set()


def body_for(short: str, words: int = 0) -> str:
    filler = (" Extra words here." * words) if words else ""
    return (f"Hi Dana,\n\nYour quote page says estimates go out by hand within 48 hours.{filler}\n\n"
            f"{SENDER['intro_line']} I'd set up AI to draft each quote from your notes.\n\n{SENDER['proof_line']}\n\n"
            f"My resume is attached. Could I build {short} a quick demo of quote drafts and show you after school or over Zoom?")


def prospect(i: int, **kw) -> dict:
    p = {"company": f"Oak {i} Roofing LLC", "short_name": f"Oak {i} Roofing", "website": f"https://www.oak{i}roofing.com/",
         "city": "Hoover", "sector": "Field service", "kind": "Roofing", "contact_name": "Dana Smith", "contact_role": "Owner",
         "email": f"dana@oak{i}roofing.com", "email_source_url": f"https://oak{i}roofing.com/contact",
         "workflow": "Quotes typed by hand after each inspection", "why_pay": "Faster quotes win jobs",
         "evidence": "Quote page says estimates go out within 48 hours", "source_urls": [f"https://oak{i}roofing.com/quote"], "fit": "High"}
    p.update(kw)
    return p


def fresh_db():
    assert str(db.DB_PATH).startswith(str(TMP)), f"refusing to touch {db.DB_PATH}"
    for f in ("data/outreach.db", "data/fake_gmail.json"):
        (TMP / f).unlink(missing_ok=True)
    gmail._backend = None
    return db.connect()


def draft_and_approve(conn, n: int, start: int = 0) -> list[int]:
    added = db.add_prospects(conn, [prospect(i) for i in range(start, start + n)], "test")["added"]
    ids = []
    for cid in added:
        c = db.get_company(conn, cid)
        eid, errors, _ = drafts.create_first_touch(conn, {"id": cid, "greeting_name": "Dana", "workflow_short": "quote drafts",
                                                          "subject": f"Quote drafts for {c['short_name']}", "body": body_for(c["short_name"])})
        assert not errors, errors
        drafts.approve(conn, eid)
        ids.append(eid)
    return ids


class ImportAndDedupe(unittest.TestCase):
    def tearDown(self):
        self.conn.close()

    def setUp(self):
        self.conn = fresh_db()
        rows = [
            dict(id="a-co", company="A Co", website="aco.com", city="Hoover", sector="Professional services", kind="CPA firm",
                 contact_name="Not found", contact_role="", email="info@aco.com", phone="", status="todo", fit="High"),
            dict(id="b-co", company="B Co", website="bco.com", city="Pelham", sector="Field service", kind="5-15",
                 contact_name="Bo", contact_role="Owner", email="bo@gmail.com", phone="", status="emailed", fit="High", emailed_at="2026-10-05"),
            dict(id="c-co", company="C Co", website="cco.org", city="Birmingham", sector="Nonprofits and schools", kind="Church",
                 contact_name="Cy", contact_role="", email="cy@cco.org; office@cco.org", phone="", status="replied_no", fit="High",
                 notes="Draft r123 Wave 3"),
        ]
        path = TMP / "hist.csv"
        cols = ["id", "company", "website", "city", "sector", "kind", "contact_name", "contact_role", "email", "phone", "status", "fit",
                "emailed_at", "followed_up_at", "replied_at", "reply_note", "next", "notes", "ai_workflow", "email_subject", "email_body"]
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, cols)
            w.writeheader()
            for r in rows:
                w.writerow({c: r.get(c, "") for c in cols})
        self.stats = db.import_history(self.conn, str(path))

    def test_import(self):
        self.assertEqual(self.stats["inserted"], 3)
        a = db.get_company(self.conn, "a-co")
        self.assertEqual(a["contact_name"], "")
        self.assertEqual(a["bucket"], "professional")
        b = db.get_company(self.conn, "b-co")
        self.assertEqual((b["size_signal"], b["kind"]), ("5-15", ""))
        self.assertEqual(b["domain"], "bco.com")
        c = db.get_company(self.conn, "c-co")
        self.assertEqual(c["alt_emails"], "office@cco.org")
        self.assertEqual(c["legacy_draft_id"], "r123")
        self.assertEqual(c["bucket"], "nonprofit")

    def test_suppression_never_blocks_gmail_com(self):
        doms = {r[0] for r in self.conn.execute("SELECT domain FROM suppression WHERE domain IS NOT NULL")}
        self.assertNotIn("gmail.com", doms)
        self.assertIn("bco.com", doms)
        self.assertIn("cco.org", doms)
        self.assertNotIn("aco.com", doms)  # todo rows are not suppressed

    def test_dedupe_by_domain_and_email(self):
        out = db.add_prospects(self.conn, [
            prospect(1, website="https://www.bco.com", email="new@bco.com"),        # contacted domain
            prospect(2, email="office@cco.org", website="cco-new.org"),              # known alt email
            prospect(3, website="aco.com", email="sales@aco.com"),                   # domain already in DB as todo
            prospect(4, fit="Low"),
            prospect(5, city="Atlanta"),
            prospect(6, email="someone@gmail.com"),                                  # free mail is fine
        ], "test")
        self.assertEqual(len(out["added"]), 1)
        self.assertEqual(len(out["rejected"]), 5)


class Voice(unittest.TestCase):
    company = {"company": "Oak 1 Roofing LLC", "short_name": "Oak 1 Roofing", "evidence": "48 hours"}

    def errors(self, body, subject="Quote drafts for Oak 1 Roofing", kind="first_touch"):
        return voicecheck.check(kind, subject, body, self.company)[0]

    def test_clean_email_passes(self):
        self.assertEqual(self.errors(body_for("Oak 1 Roofing")), [])

    def test_blocks(self):
        good = body_for("Oak 1 Roofing")
        self.assertTrue(self.errors(good.replace("by hand", "by hand — slowly")))
        self.assertTrue(self.errors(good + " Thanks!"))
        self.assertTrue(self.errors(good.replace("I'd set up AI", "I'd leverage AI")))
        self.assertTrue(self.errors(good.replace("Hi Dana,", "Hi Dana, I hope this finds you well.")))
        self.assertTrue(self.errors(good.replace(SENDER["proof_claim"], "Acme saves thousands")))
        self.assertTrue(self.errors(body_for("Oak 1 Roofing", words=20)))
        self.assertTrue(self.errors(good + " Call me at 205-555-9999."))
        self.assertTrue(self.errors(good.replace("draft each quote", "run your Meta ads")))
        self.assertTrue(self.errors(good, subject="Re: quick thing"))
        self.assertTrue(self.errors(good, subject="Quote drafts for you"))

    def test_company_name_with_banned_word_is_fine(self):
        c = {"company": "Elevate Landscape", "short_name": "Elevate Landscape"}
        errs = voicecheck.check("first_touch", "Quote drafts for Elevate Landscape", body_for("Elevate Landscape"), c)[0]
        self.assertEqual(errs, [])

    def test_footer(self):
        full = voicecheck.compose_full(body_for("X") + "\n\nThanks,\nSam", "first_touch", SENDER)
        self.assertTrue(full.rstrip().endswith(voicecheck.OPT_OUT))
        self.assertIn(SENDER["postal_address"], full)
        self.assertEqual(full.count("Thanks,"), 1)
        self.assertNotIn(voicecheck.OPT_OUT, voicecheck.compose_full("Hi,\n\nSure.", "reply", SENDER))


class SendLoop(unittest.TestCase):
    def tearDown(self):
        self.conn.close()

    def setUp(self):
        self.conn = fresh_db()
        self.clock = Clock("2026-11-02T07:00")  # a Monday

    def run_window(self, at="2026-11-02T07:45"):
        self.clock.at(at)
        return scheduler.run(self.conn, sleep=self.clock.sleep, now_fn=self.clock.now)

    def test_draft_has_resume_and_ownership(self):
        [eid] = draft_and_approve(self.conn, 1)
        row = self.conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        fake = gmail.backend()
        msg = fake.state["messages"][fake.state["drafts"][row["gmail_draft_id"]]]
        self.assertEqual(msg["attachments"], ["Sam Tester Resume.pdf"])
        with self.assertRaises(gmail.NotOwnedError):
            gmail.send_draft(self.conn, 9999)
        with self.assertRaises(gmail.NotOwnedError):
            gmail.reply_in_thread(self.conn, "x", "not-a-tracked-thread", "hi")

    def test_unapproved_never_sends(self):
        added = db.add_prospects(self.conn, [prospect(1)], "test")["added"]
        eid, errors, _ = drafts.create_first_touch(self.conn, {"id": added[0], "subject": "Quote drafts for Oak 1 Roofing",
                                                               "body": body_for("Oak 1 Roofing"), "workflow_short": "quote drafts"})
        with self.assertRaises(gmail.GmailError):
            gmail.send_draft(self.conn, eid)

    def test_cap_window_and_spacing(self):
        draft_and_approve(self.conn, 30)
        plan = scheduler.plan(self.conn)
        self.assertEqual(plan, {"2026-11-02": 25, "2026-11-03": 5})
        result = self.run_window()
        self.assertEqual(result["sent_first"], 25)
        sent = [r["sent_at"] for r in self.conn.execute("SELECT sent_at FROM emails WHERE status = 'sent' ORDER BY sent_at")]
        times = [dt.datetime.fromisoformat(s) for s in sent]
        gaps = [(b - a).total_seconds() / 60 for a, b in zip(times, times[1:])]
        self.assertTrue(all(2 <= g <= 5.01 for g in gaps), gaps)
        self.assertLessEqual(times[-1].time(), dt.time(9, 30))
        self.assertGreaterEqual(times[0].time(), dt.time(7, 45))
        # same day again: cap reached, nothing more goes out
        self.assertEqual(self.run_window("2026-11-02T08:30")["sent_first"], 0)
        # after the window: nothing
        self.assertEqual(self.run_window("2026-11-03T09:31")["sent_first"], 0)
        # weekend: nothing
        self.assertEqual(self.run_window("2026-11-07T07:45")["sent_first"], 0)

    def test_suppressed_at_send_time_is_skipped(self):
        draft_and_approve(self.conn, 2)
        scheduler.plan(self.conn)
        db.suppress(self.conn, email="dana@oak0roofing.com", reason="asked to be removed")
        self.conn.commit()
        result = self.run_window()
        self.assertEqual(result["sent_first"], 1)

    def test_followup_after_8_business_days_in_same_thread(self):
        draft_and_approve(self.conn, 2)
        scheduler.plan(self.conn)
        self.run_window()
        # day 7 after: nothing due yet (Nov 11 is 7 business days after Nov 2)
        self.assertEqual(scheduler.due_followups(self.conn, dt.date(2026, 11, 11)), [])
        # one of them replies
        c1 = db.get_company(self.conn, "oak-1-roofing-llc")
        gmail.backend().add_inbound(c1["gmail_thread_id"], "Dana <dana@oak1roofing.com>", "Sounds interesting, what would it cost?")
        result = self.run_window("2026-11-12T07:45")
        self.assertEqual(result["sent_followup"], 1)
        fu = self.conn.execute("SELECT * FROM emails WHERE kind = 'follow_up'").fetchall()
        self.assertEqual(len(fu), 1)
        c0 = db.get_company(self.conn, "oak-0-roofing-llc")
        self.assertEqual(fu[0]["gmail_thread_id"], c0["gmail_thread_id"])
        self.assertTrue(fu[0]["subject"].startswith("Re: "))
        self.assertIn("Bumping this in case it got buried. I'd still like to build Oak 0 Roofing a quick demo of quote drafts.", fu[0]["body"])
        self.assertTrue(fu[0]["body"].rstrip().endswith(voicecheck.OPT_OUT))
        self.assertEqual(db.get_company(self.conn, "oak-1-roofing-llc")["status"], "replied")
        # exactly one follow-up, ever
        self.assertEqual(self.run_window("2026-11-13T07:45")["sent_followup"], 0)

    def test_bounce_pauses(self):
        draft_and_approve(self.conn, 10)
        scheduler.plan(self.conn)
        fake = gmail.backend()
        original = fake.send_draft
        sends = {"n": 0}

        def send_and_bounce(draft_id):
            out = original(draft_id)
            sends["n"] += 1
            if sends["n"] == 2:
                fake.add_inbound(None, "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
                                 "Address not found. Your message wasn't delivered to dana@oak1roofing.com",
                                 subject="Delivery Status Notification (Failure)", failed_recipient="dana@oak1roofing.com")
            return out
        fake.send_draft = send_and_bounce
        result = self.run_window()
        self.assertIn("bounce", result["stopped"])
        self.assertTrue(db.get_setting(self.conn, "paused"))
        self.assertEqual(db.get_company(self.conn, "oak-1-roofing-llc")["status"], "bounced")
        self.assertLess(result["sent_first"], 10)
        # paused stays paused until Sai resumes
        self.assertEqual(self.run_window("2026-11-03T07:45")["sent_first"], 0)

    def test_rate_limit_pauses(self):
        draft_and_approve(self.conn, 3)
        scheduler.plan(self.conn)
        fake = gmail.backend()
        fake.state["fail_next_send"] = "User-rate limit exceeded"
        result = self.run_window()
        self.assertEqual(result["stopped"], "rate limit")
        self.assertIn("rate limit", db.get_setting(self.conn, "paused"))

    def test_meeting_pause_blocks_first_touch_only(self):
        draft_and_approve(self.conn, 3)
        scheduler.plan(self.conn)
        for i in range(6):
            cid = db.add_prospects(self.conn, [prospect(100 + i)], "m")["added"][0]
            db.update_company(self.conn, cid, status="meeting_booked")
        result = self.run_window()
        self.assertEqual(result["sent_first"], 0)
        self.assertTrue(any("meetings pending" in s for s in result["skipped"]))

    def test_remove_me_suppresses(self):
        draft_and_approve(self.conn, 1)
        scheduler.plan(self.conn)
        self.run_window()
        c = db.get_company(self.conn, "oak-0-roofing-llc")
        gmail.backend().add_inbound(c["gmail_thread_id"], "Dana <dana@oak0roofing.com>", "Please remove me from your list.\n\nOn Mon, Sam wrote:\n> hi")
        replies.scan(self.conn, dt.datetime(2026, 11, 1, tzinfo=common.tz()))
        self.assertEqual(db.get_company(self.conn, c["id"])["status"], "unsubscribed")
        self.assertTrue(db.send_blockers(self.conn, c["id"], "dana@oak0roofing.com", "reply"))
        self.assertEqual(db.add_prospects(self.conn, [prospect(0, company="Oak Zero", website="oakzero.com")], "t")["added"], [])

    def test_reply_needs_explicit_approval(self):
        draft_and_approve(self.conn, 1)
        scheduler.plan(self.conn)
        self.run_window()
        c = db.get_company(self.conn, "oak-0-roofing-llc")
        gmail.backend().add_inbound(c["gmail_thread_id"], "Dana <dana@oak0roofing.com>", "Yes, show me. Thursday works.")
        replies.scan(self.conn, dt.datetime(2026, 11, 1, tzinfo=common.tz()))
        eid = gmail.reply_in_thread(self.conn, c["id"], c["gmail_thread_id"], voicecheck.compose_full("Hi Dana,\n\nGreat. Thursday at 3:30 PM CT?", "reply"))
        with self.assertRaises(gmail.GmailError):
            gmail.send_draft(self.conn, eid)
        row = self.conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        self.assertEqual(row["to_addr"], "dana@oak0roofing.com")
        self.assertEqual(row["status"], "drafted")

    def test_new_thread_from_active_contact_is_seen(self):
        cid = db.add_prospects(self.conn, [prospect(7)], "t")["added"][0]
        db.update_company(self.conn, cid, status="call")
        self.conn.commit()
        gmail.backend().add_inbound(None, "Dana <dana@oak7roofing.com>", "Here are my tables.", subject="tables")
        gmail.backend().add_inbound(None, "Stranger <x@other.com>", "Unrelated mail", subject="hello")
        seen = replies.scan(self.conn, dt.datetime(2026, 11, 1, tzinfo=common.tz()))
        self.assertEqual([m["company_id"] for m in seen], [cid])

    def test_reply_with_attachments(self):
        draft_and_approve(self.conn, 1)
        scheduler.plan(self.conn)
        self.run_window()
        c = db.get_company(self.conn, "oak-0-roofing-llc")
        gmail.backend().add_inbound(c["gmail_thread_id"], "Dana <dana@oak0roofing.com>", "Here are my files.")
        att = TMP / "Sample deal sheets.pdf"
        att.write_bytes(b"%PDF-1.4 sample")
        eid = gmail.reply_in_thread(self.conn, c["id"], c["gmail_thread_id"], "Hi Dana,\n\nAttached.", attachments=[str(att)])
        row = self.conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        fake = gmail.backend()
        self.assertEqual(fake.state["messages"][fake.state["drafts"][row["gmail_draft_id"]]]["attachments"], ["Sample deal sheets.pdf"])
        gmail.update_draft(self.conn, eid, row["subject"], "Hi Dana,\n\nAttached, edited.")
        row = self.conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        self.assertEqual(fake.state["messages"][fake.state["drafts"][row["gmail_draft_id"]]]["attachments"], ["Sample deal sheets.pdf"])
        with self.assertRaises(gmail.GmailError):
            gmail.reply_in_thread(self.conn, c["id"], c["gmail_thread_id"], "x", attachments=[str(TMP / "missing.pdf")])

    def test_cut_keeps_draft_and_renames(self):
        [eid] = draft_and_approve(self.conn, 1)
        self.conn.execute("UPDATE emails SET status = 'drafted' WHERE id = ?", (eid,))
        drafts.cut(self.conn, eid, "weak")
        row = self.conn.execute("SELECT * FROM emails WHERE id = ?", (eid,)).fetchone()
        self.assertEqual(row["status"], "cut")
        self.assertTrue(row["subject"].startswith("[CUT"))
        self.assertIn(row["gmail_draft_id"], gmail.backend().state["drafts"])


class Rules(unittest.TestCase):
    def test_no_delete_anywhere(self):
        for f in (SRC / "scripts").glob("*.py"):
            text = f.read_text()
            self.assertNotRegex(text, r"(?i)\bDELETE\s+FROM\b", f.name)
            self.assertNotRegex(text, r"\.(trash|untrash|batchDelete)\(|drafts\(\)\.delete|messages\(\)\.delete|threads\(\)\.delete", f.name)

    def test_business_days(self):
        self.assertEqual(common.add_business_days(dt.date(2026, 11, 2), 8), dt.date(2026, 11, 12))
        # Thanksgiving week: Nov 26 and 27 are holidays
        self.assertEqual(common.add_business_days(dt.date(2026, 11, 20), 8), dt.date(2026, 12, 4))

    def test_buckets(self):
        self.assertEqual(common.bucket_for("Field service", "lawn care"), "field")
        self.assertEqual(common.bucket_for("Professional services", "Independent mortgage broker"), "professional")
        self.assertEqual(common.bucket_for("Health and wellness", "Chiropractic"), "other")
        self.assertEqual(common.bucket_for("church", "7"), "nonprofit")
        self.assertEqual(common.bucket_for("Industrial and construction", "Commercial glazing contractor"), "field")

    def test_doctor_flags_missing_login(self):
        import doctor
        doctor.results.clear()
        rc = doctor.main([])
        names = {r[0]: r[1] for r in doctor.results}
        self.assertEqual(rc, 1)
        self.assertTrue(names["Postal address set (CAN-SPAM)"])
        self.assertFalse(names["Gmail login (secrets/token.json)"])

    def test_availability_skips_busy(self):
        import availability
        start = dt.date(2026, 11, 3)
        busy = [(dt.datetime(2026, 11, 3, 14, 0, tzinfo=common.tz()), dt.datetime(2026, 11, 3, 18, 0, tzinfo=common.tz()))]
        slots = availability.candidate_slots(start, 3, 20, busy)
        self.assertFalse(any(s.date() == start and s.hour >= 14 for s in slots))
        picks = availability.pick(slots, 3)
        self.assertEqual(len({p.date() for p in picks}), len(picks))


if __name__ == "__main__":
    unittest.main()
