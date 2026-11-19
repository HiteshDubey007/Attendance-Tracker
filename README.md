# PunchIn — office attendance

Check-in / check-out, leave, holidays and reports for a small office. Installs on Android, iPhone and laptops as an app (PWA) — no app store needed.

<sub>Developed by Hitesh Dubey.</sub>

---

## What it does

**Employees**
- One-tap check-in / check-out on a progress dial that fills up through the day (green when the daily target is met)
- Office location check (geofence) — punch only works inside the office radius
- This week at a glance, this month's "days on target" pie chart, late arrivals, leave left
- History by month with day status (full day, short, half day, no check-out, leave, holiday, absent)
- Apply for leave (casual, sick, earned, unpaid, half day) with a live count of working days; weekends and office holidays are never deducted
- See pending / approved / rejected leave, withdraw pending requests
- Request a fix for a wrong or missing check-in / check-out

**Admin**
- Team today: who is in, checked out, not in yet, on leave, late
- 30-day attendance graph and a pie chart of "% of days the daily target was met" — whole team or per person, by month / 30 days / year
- Per-person table: target met %, present, late, leave, absent, hours
- Add people by office email with a nickname; block, unblock, remove, make admin
- Approve or reject leave (with a note), revoke approved leave
- Apply or reject fix requests; edit any day directly (a reason is required and kept forever)
- Holidays (Holi, Diwali …), weekly off (Sat+Sun / Sunday / none), daily target hours, half-day minimum, shift start + late grace, yearly leave, office location
- Export any month for everyone to CSV (opens in Excel / Google Sheets)
- Security page: refused punches (outside office, location off, poor GPS) and a one-click integrity check of the full history

## Where the data lives

Two free options; the app picks whichever is filled in `public/config.json`.

- **Google Sheets + Apps Script (default, free, nothing to sign up for beyond a Google account)** — code in [`gas/Code.js`](gas/Code.js). The sheet is never shared; only the script, running as the owner, touches it.
- **Supabase (PostgreSQL)** — code in [`supabase/schema.sql`](supabase/schema.sql), for when the team grows.

## Why it is hard to cheat

| Threat | Protection |
|---|---|
| Changing the phone clock | Every time is stamped by Google's / the database's server, never the phone |
| Editing data or calling the server by hand | Staff never get access to the sheet. Every request goes through server code that checks the signed-in person and what they are allowed to do; times or ids sent by the phone are ignored |
| Seeing other people's data | The server only ever returns the caller's own records (admins see all) |
| Strangers signing up / taking over an invited email | Sign-up needs a one-time 8-letter code the admin gets when adding the person (expires in 14 days, works once) |
| Password guessing | Salted, 2000× hashed passwords; 6 wrong tries locks that email for 15 minutes |
| Punching from home | Server-side geofence with GPS accuracy check; every refused attempt is logged for the admin |
| Quietly changing history | Every change goes into an append-only Audit tab, SHA-256 chained. **Security → Verify** also replays the log against the live tabs, so even the owner editing a cell in the sheet by hand is detected and the row is named |
| Blocked staff | Blocking ends all their sessions immediately |

Honest limits: a web app cannot detect "fake GPS" apps on rooted phones. Distances and refused attempts are recorded so unusual patterns stand out.

## Testing and back-testing

Every push runs all of this before the app is published (GitHub → Actions):

- **Security tests** — 32 against PostgreSQL and 31 against the Google Sheets code: forged requests, fake tokens, privilege escalation, reading other people's data, invite-code reuse, password guessing, geofence edge cases, blocking, leave rules, and tampering with the sheet.
- **Back-test** — replays **six months** of office life (Jan–Jun 2026) for 10 + 8 employees in two set-ups (5-day / 9 h and 6-day / 8 h): ~4,500 check-ins, leave requests, approvals, rejections, half days, forgotten check-outs, fixes, admin edits, weekend work and holidays — through **both** backends. An independent model computes what every monthly report and leave balance should be; all 108 monthly reports must match exactly and the audit must verify.
- **Logic tests** — the leave-day preview and distance maths checked against the database on 300 random ranges.
- **Screen tests** — all 14 screens on phone and laptop sizes.
- **End-to-end** — the real built app in Chrome talking to the real Sheets code over HTTP: admin set-up, adding a person, wrong code refused, employee sign-up and check-in, employee blocked from admin screens, admin sees the check-in.

## One-time setup with Google Sheets (≈10 minutes, free)

1. Open [sheets.new](https://sheets.new) with your Google account. Name it **PunchIn data**.
2. **Extensions → Apps Script**. Delete what is there, paste all of [`gas/Code.js`](gas/Code.js), press **Save**.
3. Choose the **setup** function at the top and press **Run**. Allow the permissions it asks for (it only touches this sheet). Copy the **set-up code** it shows.
4. **Deploy → New deployment →** type **Web app** · Execute as **Me** · Who has access **Anyone** → **Deploy**. Copy the **Web app URL** (ends in `/exec`).
5. Put that URL in [`public/config.json`](public/config.json) as `"appsScriptUrl"`.
6. In this GitHub repo: **Settings → Pages → Source: GitHub Actions**. The app goes live at `https://hiteshdubey007.github.io/attendance-tracker/`.
7. Open the app → **First time or forgot password?** → your email + the set-up code + a password. You are now the admin. Add people in **People**; each gets a code to share on WhatsApp.
8. Install on phones — Android (Chrome): ⋮ → *Install app*. iPhone (Safari): Share → *Add to Home Screen*.

Updating the server code later: paste the new `Code.js`, then **Deploy → Manage deployments → ✎ → Version: New version → Deploy** (the URL stays the same).

Free Google limits are far above what a small office needs: up to 30 people can use it at the same moment, and a sheet holds 10 million cells — over 100 years of records for a 20-person office.

## Tech

React + TypeScript (Vite) PWA · Supabase (PostgreSQL, Auth, row-level security) · Chart.js · Vitest · Playwright · GitHub Actions + Pages.

```
supabase/schema.sql      all tables, rules, server functions, audit chain
src/lib/backend.*.ts     data layer (live + sample data for screen tests)
src/pages/               employee and admin screens
tests/db/                security tests and the six-month back-test
tests/ui/screens.mjs     screen tests
```
