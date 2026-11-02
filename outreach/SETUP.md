# One-time setup on the Mac

About 20 minutes. You do the clicking; nothing here prints or commits a token.

## 1. Put the folder somewhere launchd can read

Clone into your home folder, **not** Desktop, Documents or Downloads (macOS blocks background jobs from those):

```bash
cd ~ && git clone https://github.com/svjaura/Internship.git && cd ~/Internship/outreach
```

Unzip the private bundle (`outreach-private.zip`: profile, sender settings, resume, history CSV, database) into
this `outreach/` folder so `profile.local.md`, `sender.local.json`, `resume.pdf` and `data/outreach.db` sit here.

## 2. Python

```bash
python3 -m venv .venv && source .venv/bin/activate && python3 -m pip install -r requirements.txt
```

Use this same terminal (venv active) for steps 4 and 6, so launchd runs the venv's Python.

## 3. Gmail + Calendar OAuth (Google Cloud Console)

1. Go to https://console.cloud.google.com and sign in with the Gmail you send from.
2. Project picker (top bar) → **New project** → name it `Outreach` → Create → select it.
3. **APIs & Services → Library**: search and **Enable** "Gmail API". Do the same for "Google Calendar API".
4. **Google Auth Platform** (older UI: "OAuth consent screen") → Get started:
   app name `Outreach`, support email = your Gmail, audience **External**, contact email = your Gmail → Create.
5. **Audience** → under Test users, **Add users** → your Gmail. Then click **Publish app** → confirm
   "In production". (In "Testing" mode Google expires the login every 7 days and the 7:45 sends would stop.
   Production is fine for an app only you use; you'll see a "Google hasn't verified this app" screen once.)
6. **Clients** (older UI: Credentials → Create credentials) → **Create client** → type **Desktop app** →
   name `Outreach Mac` → Create → **Download JSON**.
7. Move that file to `outreach/secrets/credentials.json`:
   ```bash
   mv ~/Downloads/client_secret_*.json secrets/credentials.json && chmod 600 secrets/credentials.json
   ```

## 4. Log in once

```bash
python3 scripts/gmail.py auth
```

A browser opens. Pick your Gmail → **Advanced** → **Go to Outreach (unsafe)** (it's your own app) → tick all
three boxes (read mail, compose/send drafts, read calendar) → Continue. The terminal should say
`Authorized as <your Gmail>`. The token is saved to `secrets/token.json` (git ignores it).

Scopes are the narrowest that work: read Gmail, compose/send drafts, read Calendar. There's no delete or
label permission.

## 5. Postal address

CAN-SPAM needs a physical postal address in every cold email (a P.O. box is fine). Put it in
`sender.local.json` → `"postal_address"`. Until it's there, every cold draft is blocked.

## 6. Test without sending anything

```bash
python3 -m unittest discover -s scripts/tests -v
```

These run the whole draft → approve → schedule → send → bounce → follow-up loop against a fake mailbox.

## 7. Scheduler (launchd) and wake time

```bash
python3 scripts/scheduler.py install-launchd && launchctl list | grep com.outreach.send
```

That runs `scheduler.py run` at 7:45 AM Monday to Friday (Mac clock, so keep the Mac on Central time).
If the Mac is asleep at 7:45, launchd runs it on wake; after 9:30 it sends nothing and the queue rolls to the next day.

Make the Mac wake itself and stay online on send days:

```bash
sudo pmset repeat wakeorpoweron MTWRF 07:40:00
```

Leave it plugged in with the lid open (a closed lid on battery means sleep, no network). In
System Settings → Battery → Options, turn on "Prevent automatic sleeping on power adapter when the display is off".

## 8. Check everything

```bash
python3 scripts/doctor.py --online
```

Every line should say `ok` (a `note` is advice, not a blocker).

## 9. Go

```bash
claude
```

Then `/status`, and `/campaign` to run Part 2. Logs: `reports/send.log`, `reports/alerts.log`, daily reports in `reports/YYYY-MM-DD.md`.

Optional: you can also add a permissions block to `.claude/settings.json` that stops Claude from reading `secrets/`
(`"deny": ["Read(./secrets/**)"]`). The scripts never print tokens either way.
