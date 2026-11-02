"""Shared test sandbox. Import this before any outreach module so nothing touches the real database."""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

SRC = Path(__file__).resolve().parents[2]
TMP = Path(tempfile.mkdtemp(prefix="outreach-test-"))
for name in ("config.json",):
    shutil.copy(SRC / name, TMP / name)
shutil.copytree(SRC / "templates", TMP / "templates")
(TMP / "resume.pdf").write_bytes(b"%PDF-1.4 fake resume")
SENDER = {
    "name": "Sam Tester", "first_name": "Sam", "email": "sam.tester@gmail.com", "phone": "(205) 555-0100",
    "linkedin": "linkedin.com/in/sam-tester", "postal_address": "P.O. Box 1, Hoover, AL 35244",
    "resume_attachment_name": "Sam Tester Resume.pdf", "intro_line": "I'm Sam, a senior at Test High in Hoover.",
    "proof_line": "This summer at Acme, a teammate and I built Widget. It emails a daily report. Acme has recorded $1,000 to $2,000 a month in savings from it.",
    "proof_claim": "Acme has recorded $1,000 to $2,000 a month in savings",
    "proof_keywords": ["Widget", "Acme"],
    "availability": {"weekday": [["08:00", "09:00"], ["14:30", "17:30"]], "weekend": []},
}
(TMP / "sender.local.json").write_text(json.dumps(SENDER))
os.environ.update(OUTREACH_ROOT=str(TMP), OUTREACH_FAKE_GMAIL="1", OUTREACH_DB=str(TMP / "data" / "outreach.db"),
                  OUTREACH_FAKE_GMAIL_PATH=str(TMP / "data" / "fake_gmail.json"), OUTREACH_NOW="2026-11-02T07:00")
sys.path.insert(0, str(SRC / "scripts"))
