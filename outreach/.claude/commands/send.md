---
description: Schedule approved drafts into the 25-a-weekday send plan (7:45 to 9:30 AM CT)
---
1. Preflight: `python3 scripts/doctor.py --online`. Stop and tell Sai about any FIX line.
2. Run `python3 scripts/scheduler.py plan`. It gives each approved draft a send day: 25 a weekday including
   follow-ups that come due, buckets interleaved so every day is a mix.
3. Show Sai the plan (days and counts) and remind him: the Mac needs to be awake and online 7:45 to 9:30 AM CT
   on send days (SETUP.md has the `pmset` wake schedule). If more than 5 meetings are pending, new first-touch
   sends pause automatically and he gets a notification.
