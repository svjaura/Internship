#!/usr/bin/env python3
"""The review page: every pending draft with its evidence. Sai approves, edits or cuts each one.

  python3 scripts/review.py build            # writes review.html
  python3 scripts/review.py serve            # http://127.0.0.1:8765 , clicks save straight to the database
  python3 scripts/review.py apply decisions.json   # if review.html was opened as a file and decisions were downloaded

Nothing gets queued without an approval recorded here.
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT, now_ct  # noqa: E402
import db  # noqa: E402
import drafts  # noqa: E402

OUT = ROOT / "review.html"

CSS = """
:root { --ink: #1d1d1b; --muted: #6b6b66; --line: #d9d6cf; --bg: #fbfaf7; --card: #ffffff; --ok: #2f6b3a; --cut: #8a2d22; --warn: #7a5a00; }
@media (prefers-color-scheme: dark) { :root { --ink: #e9e7e1; --muted: #a29f97; --line: #3a3934; --bg: #1b1a18; --card: #23221f; --ok: #8cc49a; --cut: #e39a8f; --warn: #e2c26b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 "Iowan Old Style", Georgia, serif; }
header, main { max-width: 860px; margin: 0 auto; padding: 16px; }
header { border-bottom: 1px solid var(--line); }
h1 { font-size: 22px; margin: 8px 0; }
.meta, .muted { color: var(--muted); font-size: 14px; }
article { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 16px; margin: 16px 0; }
article.approved { border-left: 4px solid var(--ok); }
article.cut { border-left: 4px solid var(--cut); opacity: .6; }
h2 { font-size: 19px; margin: 0 0 4px; }
dl { display: grid; grid-template-columns: 9em 1fr; gap: 2px 12px; margin: 12px 0; font-size: 15px; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; font: 15px/1.5 ui-monospace, Menlo, monospace; background: var(--bg); border: 1px solid var(--line); padding: 12px; border-radius: 4px; }
.warn { color: var(--warn); font-size: 14px; }
.err { color: var(--cut); font-size: 14px; }
button { font: inherit; font-size: 15px; padding: 6px 14px; margin-right: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); border-radius: 4px; cursor: pointer; }
button.approve { border-color: var(--ok); color: var(--ok); }
button.cut { border-color: var(--cut); color: var(--cut); }
textarea, input[type=text] { width: 100%; font: 15px/1.5 ui-monospace, Menlo, monospace; padding: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 4px; }
textarea { min-height: 220px; }
.status { font-size: 14px; font-weight: bold; }
.hidden { display: none; }
a { color: inherit; }
@media (max-width: 600px) { dl { grid-template-columns: 1fr; } dt { margin-top: 6px; } }
"""

JS = """
const offline = location.protocol === 'file:';
const saved = JSON.parse(localStorage.getItem('decisions') || '[]');
function record(d) { saved.push(d); localStorage.setItem('decisions', JSON.stringify(saved)); document.getElementById('dl').classList.remove('hidden'); }
async function act(id, action, extra) {
  const card = document.getElementById('e' + id);
  const msg = card.querySelector('.msg');
  if (offline) { record(Object.assign({id, action}, extra || {})); mark(card, action); msg.textContent = 'Saved in this browser. Download decisions when done.'; return; }
  const r = await fetch('/api/' + action, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(Object.assign({id}, extra || {}))});
  const j = await r.json();
  if (!j.ok) { msg.innerHTML = '<span class="err">' + j.errors.join('<br>') + '</span>'; return; }
  msg.innerHTML = j.warnings && j.warnings.length ? '<span class="warn">' + j.warnings.join('<br>') + '</span>' : '';
  if (j.full) { card.querySelector('pre').textContent = j.full; card.querySelector('.subj').textContent = j.subject; }
  mark(card, action);
}
function mark(card, action) {
  const s = card.querySelector('.status');
  if (action === 'approve') { card.className = 'approved'; s.textContent = 'Approved'; }
  if (action === 'cut') { card.className = 'cut'; s.textContent = 'Cut'; }
  if (action === 'edit') { s.textContent = 'Edited, not approved yet'; card.querySelector('.editor').classList.add('hidden'); }
  tally();
}
function tally() {
  document.getElementById('nA').textContent = document.querySelectorAll('article.approved').length;
  document.getElementById('nC').textContent = document.querySelectorAll('article.cut').length;
}
function toggleEdit(id) { document.querySelector('#e' + id + ' .editor').classList.toggle('hidden'); }
function saveEdit(id) {
  const card = document.getElementById('e' + id);
  act(id, 'edit', {subject: card.querySelector('input').value, body: card.querySelector('textarea').value});
}
function cutIt(id) { const reason = prompt('Why cut this one? (one line)'); if (reason !== null) act(id, 'cut', {reason: reason || 'cut in review'}); }
function download() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 1)], {type: 'application/json'}));
  a.download = 'review_decisions.json'; a.click();
}
if (saved.length && offline) document.getElementById('dl').classList.remove('hidden');
"""


def _links(text: str | None) -> str:
    if not text:
        return ""
    parts = []
    for line in str(text).replace(" | ", "\n").splitlines():
        line = line.strip()
        if line.startswith("http"):
            parts.append(f'<a href="{html.escape(line)}" target="_blank" rel="noopener">{html.escape(line)}</a>')
        elif line:
            parts.append(html.escape(line))
    return "<br>".join(parts)


def build(conn) -> Path:
    rows = conn.execute(
        "SELECT e.*, c.company, c.website, c.city, c.bucket, c.fit, c.contact_name, c.contact_role, c.email_source_url, "
        "c.workflow, c.why_pay, c.evidence, c.source_urls, c.legacy_body FROM emails e JOIN companies c ON c.id = e.company_id "
        "WHERE e.kind = 'first_touch' AND e.status = 'drafted' ORDER BY c.bucket, c.fit, c.company").fetchall()
    cards = []
    for r in rows:
        e = html.escape
        warn = "".join(f'<div class="warn">{e(w)}</div>' for w in (r["voice_warnings"] or "").splitlines() if w)
        site = r["website"] or ""
        site_link = f'<a href="{e(site if site.startswith("http") else "https://" + site)}" target="_blank" rel="noopener">{e(site)}</a>' if site else ""
        cards.append(f"""
<article id="e{r['id']}">
  <h2>{e(r['company'])}</h2>
  <div class="meta">{e(r['city'] or '')} · {e(r['bucket'] or '')} · fit {e(r['fit'] or '')} · {site_link} · <span class="status"></span></div>
  <dl>
    <dt>Contact</dt><dd>{e(r['contact_name'] or 'no named contact')}{', ' + e(r['contact_role']) if r['contact_role'] else ''}</dd>
    <dt>To</dt><dd>{e(r['to_addr'])}</dd>
    <dt>Email source</dt><dd>{_links(r['email_source_url']) or '<span class="err">missing</span>'}</dd>
    <dt>Workflow</dt><dd>{e(r['workflow'] or '')}</dd>
    <dt>Why they'd pay</dt><dd>{e(r['why_pay'] or '')}</dd>
    <dt>Evidence</dt><dd>{e(r['evidence'] or '')}<br>{_links(r['source_urls'])}</dd>
    <dt>Subject</dt><dd class="subj">{e(r['subject'] or '')}</dd>
  </dl>
  <pre>{e(r['body'] or '')}</pre>
  <div class="msg">{warn}</div>
  <p>
    <button class="approve" onclick="act({r['id']}, 'approve')">Approve</button>
    <button onclick="toggleEdit({r['id']})">Edit</button>
    <button class="cut" onclick="cutIt({r['id']})">Cut</button>
  </p>
  <div class="editor hidden">
    <p class="muted">Edit the subject and the body above the sign-off. The signature, address and opt-out are added for you.</p>
    <input type="text" value="{e(r['subject'] or '')}">
    <p></p>
    <textarea>{e(drafts.core_body(r['body'] or ''))}</textarea>
    <p><button onclick="saveEdit({r['id']})">Save edit</button></p>
  </div>
</article>""")
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft review</title><style>{CSS}</style></head>
<body>
<header>
  <h1>Draft review</h1>
  <div class="meta">{len(rows)} drafts pending · built {now_ct():%a %b %-d, %-I:%M %p} CT · approved this session <span id="nA">0</span> · cut <span id="nC">0</span></div>
  <p class="muted">Approve, edit or cut each one. Edits are re-checked against the voice rules before they save. Nothing is queued until it's approved.</p>
  <p id="dl" class="hidden"><button onclick="download()">Download decisions</button> <span class="muted">then run: python3 scripts/review.py apply ~/Downloads/review_decisions.json</span></p>
</header>
<main>{''.join(cards) or '<p>No drafts waiting.</p>'}</main>
<script>{JS}</script>
</body></html>"""
    OUT.write_text(page)
    return OUT


def apply_decision(conn, d: dict) -> dict:
    eid = int(d["id"])
    try:
        if d["action"] == "approve":
            drafts.approve(conn, eid)
        elif d["action"] == "cut":
            drafts.cut(conn, eid, d.get("reason") or "cut in review")
        elif d["action"] == "edit":
            errors, warnings = drafts.edit(conn, eid, d.get("subject"), d.get("body"))
            if errors:
                return {"ok": False, "errors": errors}
            row = conn.execute("SELECT subject, body FROM emails WHERE id = ?", (eid,)).fetchone()
            return {"ok": True, "warnings": warnings, "full": row["body"], "subject": row["subject"]}
        else:
            return {"ok": False, "errors": [f"unknown action {d['action']}"]}
    except SystemExit as e:
        return {"ok": False, "errors": [str(e)]}
    except Exception as e:  # surfaced on the page, never swallowed
        return {"ok": False, "errors": [f"{type(e).__name__}: {e}"]}
    return {"ok": True, "warnings": []}


def serve(port: int) -> None:
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype):
            data = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            build(db.connect())
            self._send(200, OUT.read_bytes(), "text/html; charset=utf-8")

        def do_POST(self):
            action = self.path.rsplit("/", 1)[-1]
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            payload["action"] = action
            result = apply_decision(db.connect(), payload)
            self._send(200, json.dumps(result), "application/json")

        def log_message(self, *args):
            pass

    print(f"Review page: http://127.0.0.1:{port}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    p = sub.add_parser("serve"); p.add_argument("--port", type=int, default=8765)
    p = sub.add_parser("apply"); p.add_argument("json")
    a = ap.parse_args(argv)
    conn = db.connect()
    if a.cmd == "build":
        print(f"wrote {build(conn)}")
    elif a.cmd == "serve":
        serve(a.port)
    elif a.cmd == "apply":
        for d in json.loads(Path(a.json).read_text()):
            r = apply_decision(conn, d)
            print(f"{d['action']:8} {d['id']}: {'ok' if r['ok'] else 'ERROR ' + '; '.join(r['errors'])}")


if __name__ == "__main__":
    main()
