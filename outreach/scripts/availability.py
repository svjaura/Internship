#!/usr/bin/env python3
"""Meeting times Sai can actually make: his free windows minus Google Calendar busy blocks.

  python3 scripts/availability.py --count 3 --minutes 20
  python3 scripts/availability.py --busy-json busy.json   # busy blocks fetched with the Calendar connector instead

busy.json is a list of [start_iso, end_iso] pairs.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import holidays, load_sender, now_ct, parse_hhmm, tz  # noqa: E402


def candidate_slots(start: dt.date, days: int, minutes: int, busy: list[tuple[dt.datetime, dt.datetime]],
                    include_weekends: bool = False) -> list[dt.datetime]:
    avail = load_sender()["availability"]
    hol = holidays()
    out = []
    for i in range(days):
        d = start + dt.timedelta(days=i)
        weekend = d.weekday() >= 5
        if (weekend and not include_weekends) or d in hol:
            continue
        for a, b in avail["weekend" if weekend else "weekday"]:
            t = dt.datetime.combine(d, parse_hhmm(a), tz())
            end = dt.datetime.combine(d, parse_hhmm(b), tz())
            while t + dt.timedelta(minutes=minutes) <= end:
                slot_end = t + dt.timedelta(minutes=minutes)
                if not any(bs < slot_end and t < be for bs, be in busy):
                    out.append(t)
                t += dt.timedelta(minutes=30)
    return out


def pick(slots: list[dt.datetime], count: int) -> list[dt.datetime]:
    """Spread picks across different days, afternoons first (business owners rarely take 8 AM calls)."""
    by_day: dict[dt.date, list[dt.datetime]] = {}
    for s in slots:
        by_day.setdefault(s.date(), []).append(s)
    chosen = []
    for day in sorted(by_day):
        options = sorted(by_day[day], key=lambda s: (s.hour < 12, abs(s.hour * 60 + s.minute - 15 * 60 - 30)))
        chosen.append(options[0])
        if len(chosen) == count:
            break
    return chosen


def fmt(s: dt.datetime) -> str:
    return f"{s:%A, %b %-d} at {s:%-I:%M %p}".replace(":00 ", " ")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=3)
    ap.add_argument("--minutes", type=int, default=20)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--busy-json")
    ap.add_argument("--weekends", action="store_true")
    a = ap.parse_args(argv)
    start = now_ct().date() + dt.timedelta(days=1)  # never propose today
    window_end = dt.datetime.combine(start + dt.timedelta(days=a.days), dt.time(0), tz())
    if a.busy_json:
        raw = json.loads(Path(a.busy_json).read_text())
    else:
        import gmail
        raw = gmail.freebusy(dt.datetime.combine(start, dt.time(0), tz()), window_end)
    busy = [(dt.datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(tz()),
             dt.datetime.fromisoformat(e.replace("Z", "+00:00")).astimezone(tz())) for s, e in raw]
    picks = pick(candidate_slots(start, a.days, a.minutes, busy, a.weekends), a.count)
    for p in picks:
        print(fmt(p))
    if len(picks) < a.count:
        print(f"(only {len(picks)} open slot(s) in the next {a.days} days)")


if __name__ == "__main__":
    main()
