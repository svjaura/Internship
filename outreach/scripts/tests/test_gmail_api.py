"""The real Gmail/Calendar backend against Google's own client library, with mocked HTTP responses.

Skipped when google-api-python-client isn't installed.
"""
from __future__ import annotations

import base64
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _testenv  # noqa: E402,F401  (sandbox first)

try:
    from googleapiclient.discovery import build
    from googleapiclient.http import HttpMockSequence
except ImportError:  # pragma: no cover
    build = None

import gmail  # noqa: E402


class Recorder(HttpMockSequence if build else object):
    """HttpMockSequence that also remembers what was sent."""

    def __init__(self, responses):
        super().__init__(responses)
        self.sent = []

    def request(self, uri, method="GET", body=None, headers=None, redirections=1, connection_type=None):
        self.sent.append((method, uri, body))
        return super().request(uri, method, body, headers, redirections, connection_type)


def backend_with(responses):
    http = Recorder(responses)
    b = gmail.RealBackend.__new__(gmail.RealBackend)
    b.gmail = build("gmail", "v1", http=http, static_discovery=True)
    b.calendar = build("calendar", "v3", http=http, static_discovery=True)
    return b, http


def ok(payload):
    return ({"status": "200"}, json.dumps(payload).encode())


@unittest.skipIf(build is None, "google-api-python-client not installed")
class RealBackendTest(unittest.TestCase):
    def test_create_send_and_thread(self):
        b, http = backend_with([
            ok({"id": "r1", "message": {"id": "m1", "threadId": "t1"}}),
            ok({"id": "m1", "threadId": "t1", "labelIds": ["SENT"]}),
        ])
        raw = base64.urlsafe_b64encode(b"To: a@b.com\r\nSubject: hi\r\n\r\nbody").decode()
        self.assertEqual(b.create_draft(raw), ("r1", "m1", "t1"))
        method, uri, body = http.sent[0]
        self.assertEqual(method, "POST")
        self.assertIn("/gmail/v1/users/me/drafts", uri)
        self.assertEqual(json.loads(body)["message"]["raw"], raw)
        self.assertEqual(b.send_draft("r1"), ("m1", "t1", ["SENT"]))
        method, uri, body = http.sent[1]
        self.assertIn("/drafts/send", uri)
        self.assertEqual(json.loads(body), {"id": "r1"})

    def test_reply_draft_keeps_thread(self):
        b, http = backend_with([ok({"id": "r2", "message": {"id": "m2", "threadId": "t9"}})])
        b.create_draft("cmF3", thread_id="t9")
        self.assertEqual(json.loads(http.sent[0][2])["message"]["threadId"], "t9")

    def test_rate_limit_and_errors(self):
        err = {"error": {"code": 403, "message": "User-rate limit exceeded",
                         "errors": [{"reason": "userRateLimitExceeded", "message": "User-rate limit exceeded"}]}}
        b, _ = backend_with([({"status": "403"}, json.dumps(err).encode())])
        with self.assertRaises(gmail.RateLimitError):
            b.send_draft("r1")
        b, _ = backend_with([({"status": "429"}, b'{"error": {"code": 429, "message": "Too many requests"}}')])
        with self.assertRaises(gmail.RateLimitError):
            b.send_draft("r1")
        b, _ = backend_with([({"status": "400"}, b'{"error": {"code": 400, "message": "Invalid To header"}}')])
        with self.assertRaises(gmail.GmailError) as ctx:
            b.send_draft("r1")
        self.assertNotIsInstance(ctx.exception, gmail.RateLimitError)

    def test_parse_message_and_paging(self):
        text = base64.urlsafe_b64encode("Sounds good, Thursday works.\n\nOn Mon, Sai wrote:\n> hi".encode()).decode()
        msg = {"id": "m5", "threadId": "t5", "labelIds": ["INBOX"], "internalDate": "1793151600000", "snippet": "Sounds good",
               "payload": {"mimeType": "multipart/alternative", "headers": [
                   {"name": "From", "value": "Dana <dana@oak.example>"}, {"name": "Subject", "value": "Re: Quote drafts"},
                   {"name": "Message-ID", "value": "<abc@mail>"}, {"name": "X-Failed-Recipients", "value": ""}],
                   "parts": [{"mimeType": "text/html", "body": {"data": ""}},
                             {"mimeType": "text/plain", "body": {"data": text}}]}}
        b, _ = backend_with([
            ok({"messages": [{"id": "m5", "threadId": "t5"}], "nextPageToken": "p2"}),
            ok({"messages": [{"id": "m6", "threadId": "t6"}]}),
            ok(msg),
        ])
        self.assertEqual(b.list_message_ids("after:1"), [("m5", "t5"), ("m6", "t6")])
        m = b.get_message("m5")
        self.assertEqual((m["from"], m["thread_id"], m["message_id_header"]), ("Dana <dana@oak.example>", "t5", "<abc@mail>"))
        self.assertTrue(m["body"].startswith("Sounds good, Thursday works."))
        self.assertTrue(m["date"].startswith("2026-10-27"))

    def test_freebusy(self):
        import datetime as dt
        b, http = backend_with([ok({"calendars": {"primary": {"busy": [{"start": "2026-11-02T20:00:00Z", "end": "2026-11-02T21:00:00Z"}]}}})])
        start = dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc)
        self.assertEqual(b.freebusy(start, start + dt.timedelta(days=1)), [("2026-11-02T20:00:00Z", "2026-11-02T21:00:00Z")])
        self.assertIn("/freeBusy", http.sent[0][1])


if __name__ == "__main__":
    unittest.main()
