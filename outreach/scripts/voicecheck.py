#!/usr/bin/env python3
"""Builds the full email text (sign-off, signature, CAN-SPAM footer) and lints it against Sai's rules.

`check()` returns (errors, warnings). Errors block a draft. Warnings show up on the review page.

  python3 scripts/voicecheck.py --company oak-street-roofing --subject "Quote drafts for Oak Street Roofing" --body-file body.txt
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, load_config, load_sender  # noqa: E402

OPT_OUT = "If this isn't useful, reply 'no thanks' and I won't email again."
# The one proof claim (sender.local.json: proof_claim / proof_keywords) must appear word for word, never bigger.

BANNED = [
    # Sai's list
    "hope this finds you well", "hope you're doing well", "hope you are doing well", "leverage", "streamline",
    "game-changer", "game changer", "revolutionize", "revolutionise",
    # sai-voice skill: AI cadence
    "it's not just", "it is not just", "that said", "that being said", "here's the thing", "at the end of the day",
    "i'd be happy to", "i would be happy to", "feel free to", "delve", "robust", "seamless", "landscape",
    "testament to", "i wanted to reach out", "i'm reaching out", "i am reaching out", "let me know if you have any questions",
    "excited to", "cutting-edge", "cutting edge", "unlock", "empower", "supercharge", "synergy", "elevate",
    "transform your", "take it to the next level", "touch base", "circle back", "quick question",
]
OFF_OFFER = re.compile(r"\bmeta ads?\b|facebook ads?|instagram|tiktok|social media|content creation|\bseo\b|paid ads|ad campaigns?|ad spend", re.I)
DASHES = re.compile(r"[‒–—―]|\s--\s")
EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿️]")
PHONE = re.compile(r"\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]\d{4}\b")


def signature_block(sender: dict) -> str:
    lines = [sender["name"], sender["phone"], sender["linkedin"]]
    if sender.get("postal_address"):
        lines.append(sender["postal_address"])
    return "\n".join(lines)


def compose_full(body: str, kind: str, sender: dict | None = None) -> str:
    """body = greeting through the ask. Adds the sign-off, signature and (for cold email) the opt-out."""
    sender = sender or load_sender()
    signoff = re.compile(r"\n\s*(thanks|thank you|best|regards|sincerely)\s*,?\s*\n\s*" + re.escape(sender["first_name"]) + r"\s*$", re.I)
    text = signoff.sub("", body.strip()).rstrip()
    full = f"{text}\n\nThanks,\n{sender['first_name']}\n\n{signature_block(sender)}"
    if kind in ("first_touch", "follow_up"):
        full += f"\n\n{OPT_OUT}"
    return full + "\n"


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9$][\w'’,.$%/-]*", text))


def short_name(company: dict) -> str:
    if company.get("short_name"):
        return company["short_name"]
    name = re.sub(r"\(.*?\)", "", company.get("company") or "")
    name = re.sub(r",?\s+(LLC|L\.L\.C\.|Inc\.?|Co\.?|Corp\.?|PC|P\.C\.|PLLC|LLP)\b\.?", "", name, flags=re.I)
    return name.strip(" ,")


def check(kind: str, subject: str, body: str, company: dict | None = None, sender: dict | None = None) -> tuple[list[str], list[str]]:
    sender = sender or load_sender()
    company = company or {}
    cfg = load_config()
    errors, warnings = [], []
    text = f"{subject}\n{body}"
    low = text.lower()
    # A company literally named "Elevate Dental" or "Smith Landscape" shouldn't trip the banned-word list.
    for name in {company.get("company") or "", short_name(company)}:
        if name.strip():
            low = low.replace(name.lower(), " ")

    if DASHES.search(text):
        errors.append("has an em/en dash. Use a period or comma.")
    if "!" in text:
        errors.append("has an exclamation point")
    if EMOJI.search(text):
        errors.append("has an emoji")
    for phrase in BANNED:
        if re.search(r"\b" + re.escape(phrase) + r"\b", low):
            errors.append(f"banned phrase: {phrase!r}")
    m = OFF_OFFER.search(text)
    if m:
        errors.append(f"off-offer topic {m.group(0)!r}: the offer is AI automation only")
    for ph in PHONE.findall(body):
        if re.sub(r"\D", "", ph) != re.sub(r"\D", "", sender["phone"]):
            errors.append(f"phone number {ph} isn't Sai's. Never use any other number.")
    claim = sender.get("proof_claim", "")
    keywords = "|".join(re.escape(k) for k in sender.get("proof_keywords", [])) or "(?!)"
    claim_numbers = set(re.findall(r"\d[\d,]*", claim)) | {n.replace(",", "") for n in re.findall(r"\d[\d,]*", claim)}
    if re.search(keywords, body, re.I) and claim not in body:
        errors.append(f"the proof line is mentioned without the exact claim: {claim!r}")
    for sentence in re.split(r"(?<=[.?])\s+", body):
        if re.search(keywords, sentence, re.I) and re.search(
                r"sav(ing|es)\b|so far|over \$|more than \$|\$\d+k|thousands|per year|a year|annual", sentence, re.I):
            errors.append("the proof claim looks reworded or inflated. Use the exact sentence.")

    if kind == "first_touch":
        if not subject.strip():
            errors.append("subject is empty")
        if re.match(r"\s*(re|fwd?):", subject, re.I):
            errors.append("first-touch subject can't start with Re:/Fwd: (CAN-SPAM: honest subject)")
        sn = short_name(company)
        if sn and sn.lower() not in subject.lower():
            errors.append(f"subject should name the company ({sn!r})")
        if len(subject) > 60:
            warnings.append(f"subject is {len(subject)} characters, aim for under 60")
        n = word_count(body)
        if n > cfg["first_touch_max_words"]:
            errors.append(f"{n} words, max {cfg['first_touch_max_words']} (signature and opt-out don't count)")
        if claim and claim not in body:
            errors.append("first-touch must include the proof line with the exact claim (see sender.local.json proof_line)")
        if not sender.get("postal_address"):
            errors.append("no postal address in sender.local.json (CAN-SPAM needs one in every cold email)")
        if body.count("?") == 0:
            warnings.append("no question mark: is there one clear ask?")
        if body.count("?") > 2:
            warnings.append("more than two questions: keep it to one ask")
        if not re.match(r"\s*(hi|hello|pastor|dr\.|father|ms\.|mr\.|mrs\.)\b", body, re.I):
            warnings.append("doesn't open with a greeting")

    if kind == "follow_up" and not sender.get("postal_address"):
        errors.append("no postal address in sender.local.json (CAN-SPAM)")

    # Numbers that aren't backed by the company's own evidence are a red flag for invented facts.
    sourced = " ".join(str(company.get(k) or "") for k in ("evidence", "workflow", "why_pay", "notes", "company", "kind", "size_signal"))
    for num in set(re.findall(r"\$?\d[\d,]*(?:\.\d+)?%?", body)) if kind == "first_touch" else ():
        bare = num.strip("$%")
        if bare in claim_numbers or re.sub(r"\D", "", num) == re.sub(r"\D", "", sender["phone"]):
            continue
        if bare not in sourced and num not in sourced:
            warnings.append(f"number {num} isn't in the saved evidence. Make sure it's from a real source.")
    for sentence in re.split(r"(?<=[.?])\s+", body):
        if word_count(sentence) > 28:
            warnings.append(f"long sentence ({word_count(sentence)} words): {sentence[:60]}...")
    return errors, sorted(set(warnings))


def main():
    import db
    ap = argparse.ArgumentParser()
    ap.add_argument("--company", required=True)
    ap.add_argument("--kind", default="first_touch")
    ap.add_argument("--subject", default="")
    ap.add_argument("--body-file", required=True)
    a = ap.parse_args()
    conn = db.connect()
    c = db.get_company(conn, a.company)
    body = Path(a.body_file).read_text()
    errors, warnings = check(a.kind, a.subject, body, dict(c) if c else {})
    for e in errors:
        print("ERROR  ", e)
    for w in warnings:
        print("warn   ", w)
    print(f"{word_count(body)} words")
    if not errors:
        print("\n" + compose_full(body, a.kind))
    raise SystemExit(1 if errors else 0)


if __name__ == "__main__":
    main()
