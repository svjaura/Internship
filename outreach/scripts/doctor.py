#!/usr/bin/env python3
"""Preflight: is this Mac ready to draft and send? Prints what's missing and how to fix it.

  python3 scripts/doctor.py            # local checks only
  python3 scripts/doctor.py --online   # also asks Gmail which account the token belongs to
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, SECRETS, load_config, now_ct, tz  # noqa: E402

results: list[tuple[str, bool, str, bool]] = []  # (check, ok, fix, blocks_sending)


def check(name: str, ok: bool, fix: str = "", blocking: bool = True) -> bool:
    results.append((name, ok, fix, blocking))
    return ok


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--online", action="store_true")
    a = ap.parse_args(argv)

    check("Python 3.9 or newer", sys.version_info >= (3, 9), "Install Python 3.11+ (python.org or Homebrew).")
    try:
        import googleapiclient  # noqa: F401
        import google_auth_oauthlib  # noqa: F401
        libs = True
    except ImportError:
        libs = False
    check("Google libraries installed", libs, "source .venv/bin/activate && python3 -m pip install -r requirements.txt")

    home = Path.home()
    protected = [home / d for d in ("Desktop", "Documents", "Downloads")]
    check("Folder is somewhere launchd can read", not any(p in ROOT.parents for p in protected),
          f"{ROOT} is inside Desktop/Documents/Downloads. Move it to ~/Internship/outreach.", blocking=sys.platform == "darwin")

    sender_path = ROOT / "sender.local.json"
    sender = json.loads(sender_path.read_text()) if sender_path.exists() else {}
    check("sender.local.json present", bool(sender), "Unzip the private bundle into this folder.")
    for key in ("name", "first_name", "email", "phone", "linkedin", "intro_line", "proof_line", "proof_claim"):
        if sender and not sender.get(key):
            check(f"sender.local.json has {key}", False, f"Fill in \"{key}\".")
    check("Postal address set (CAN-SPAM)", bool(sender.get("postal_address")),
          'Add your mailing address (a P.O. box is fine) to sender.local.json -> "postal_address".')
    if sender.get("proof_line") and sender.get("proof_claim"):
        check("proof_line contains the exact proof_claim", sender["proof_claim"] in sender["proof_line"],
              "proof_line must contain proof_claim word for word.")
    check("profile.local.md present", (ROOT / "profile.local.md").exists(), "Unzip the private bundle into this folder.", blocking=False)

    resume = ROOT / load_config()["resume_path"]
    is_pdf = resume.exists() and resume.read_bytes()[:4] == b"%PDF"
    check("resume.pdf present", is_pdf, f"Put your resume at {resume}.")
    if is_pdf:
        check("resume under 5 MB", resume.stat().st_size < 5_000_000, "Shrink the PDF; big attachments hurt deliverability.", blocking=False)

    db_path = ROOT / "data" / "outreach.db"
    if check("database present", db_path.exists(), "Unzip the private bundle, or rebuild it (see scripts/db.py --help)."):
        import db
        conn = db.connect()
        paused = db.get_setting(conn, "paused")
        check("sending not paused", not paused, f"Paused: {paused}. Check it, then: python3 scripts/scheduler.py resume")
        stuck = conn.execute("SELECT COUNT(*) FROM emails WHERE status = 'sending'").fetchone()[0]
        check("no emails stuck mid-send", not stuck, "Look in Gmail Sent for them before doing anything else.")
        n = conn.execute("SELECT COUNT(*) FROM companies").fetchone()[0]
        check(f"database readable ({n} companies)", n > 0, "Database is empty. Import the history first.")

    has_creds = (SECRETS / "credentials.json").exists()
    has_token = (SECRETS / "token.json").exists()
    check("Google OAuth client (secrets/credentials.json)", has_creds, "SETUP.md step 3.")
    check("Gmail login (secrets/token.json)", has_token, "python3 scripts/gmail.py auth")
    if a.online and has_token and libs:
        try:
            import gmail
            who = gmail.RealBackend(interactive=False).profile_email()
            same = who.lower().replace(".", "") == sender.get("email", "").lower().replace(".", "")
            check(f"Gmail token is for {who}", same, f"sender.local.json says {sender.get('email')}. Re-run gmail.py auth with that account.")
        except Exception as e:  # report, don't crash the checklist
            check("Gmail login works", False, f"{e}. Run: python3 scripts/gmail.py auth")

    local_offset = dt.datetime.now().astimezone().utcoffset()
    central_offset = now_ct().utcoffset()
    check("Mac clock is on Central time", local_offset == central_offset,
          "launchd fires on the Mac's clock. Set System Settings > General > Date & Time to Central.", blocking=sys.platform == "darwin")

    if sys.platform == "darwin":
        job = subprocess.run(["launchctl", "list", "com.outreach.send"], capture_output=True, text=True)
        check("launchd send job installed", job.returncode == 0, "python3 scripts/scheduler.py install-launchd")
        sched = subprocess.run(["pmset", "-g", "sched"], capture_output=True, text=True).stdout
        check("Mac wakes itself before 7:45", "wake" in sched.lower(), "sudo pmset repeat wakeorpoweron MTWRF 07:40:00", blocking=False)
    else:
        check("launchd (macOS only)", False, "Skipped: not a Mac. Sending runs from the Mac.", blocking=False)

    width = max(len(r[0]) for r in results) + 2
    for name, ok, fix, blocking in results:
        mark = "ok  " if ok else ("FIX " if blocking else "note")
        print(f"{mark} {name.ljust(width)}{'' if ok else fix}")
    blockers = [r for r in results if not r[1] and r[3]]
    print()
    print("Ready to draft and send." if not blockers else f"{len(blockers)} thing(s) to fix before drafting/sending.")
    return 1 if blockers else 0


if __name__ == "__main__":
    sys.exit(main())
