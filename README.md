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

## Why it is hard to cheat

| Threat | Protection |
|---|---|
| Changing the phone clock | Every time is stamped by the database server, never the phone |
| Editing data in the browser / calling the API by hand | Users have **no write access** to any table. Every change goes through server functions that check who is calling and what is allowed |
| Seeing other people's data | Row-level security: an employee can only ever read their own rows |
| Strangers signing up | Sign-up is refused unless the admin added that email first |
| Punching from home | Server-side geofence; distance and GPS accuracy checked; every refused attempt is logged for the admin |
| Quietly changing history | Every insert / update / delete on every table goes into an append-only audit log. Each entry is SHA-256 chained to the previous one, so any later edit — even directly in the database — is detected by **Security → Verify** |
| Blocked staff still using the app | Blocked / removed accounts are refused by every function |

Honest limits: a web app cannot detect "fake GPS" apps on rooted phones. Distances and refused attempts are recorded so unusual patterns stand out. Selfie-at-punch or a native app with mock-location detection can be added later if needed.

## Testing and back-testing

Every push to GitHub runs all of this automatically before the app is published (see the Actions tab):

- **Security tests** (32) against a real PostgreSQL: forged writes, privilege escalation, reading other people's data, anonymous access, geofence edge cases, blocking, leave rules, audit tampering.
- **Back-test**: replays **six months** of office life (Jan–Jun 2026) for 10 + 8 employees in two configurations (5-day / 9 h and 6-day / 8 h) — ~4,500 punches, leave requests, approvals, rejections, half days, forgotten check-outs, fix requests, admin edits, weekend work and holidays — through the real database functions. An independent model computes what every monthly report and leave balance *should* be; all 108 monthly reports must match exactly and the audit chain must verify.
- **Logic tests**: the app's own leave-day preview and distance math are checked against the database on 300 random date ranges.
- **Screen tests**: every screen opened on a phone size and a laptop size; fails on any error or sideways scrolling; screenshots saved as a build artifact.

Run locally: `npm test` (needs PostgreSQL), `npm run build:mock && npm run test:ui`.

## One-time setup (≈10 minutes, no coding)

1. **Create the database** — go to [supabase.com](https://supabase.com), sign up (free), click **New project**. Name it `punchin`, pick region **Mumbai (ap-south-1)**, set a database password and save it somewhere safe.
2. **Install the tables** — in the project open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql), press **Run**. It should say *Success*.
3. **Let invited staff sign up instantly** — **Authentication → Sign In / Providers → Email**: turn **off** "Confirm email", save. (Only emails you add in the app can sign up.)
4. **Connect the app** — **Project Settings → API**: copy the **Project URL** and the **anon / publishable key**. Put them in [`public/config.json`](public/config.json) (or send them to whoever maintains the repo). Both are designed to be public; never share the *service_role* / secret key.
5. **Publish** — in this GitHub repo: **Settings → Pages → Source: GitHub Actions**. The next push publishes the app at `https://hiteshdubey007.github.io/attendance-tracker/`.
6. **Become admin** — open the app, tap **First time? Set up your account**, and sign up with *your* email **first**. The first account becomes the admin. Then go to **People → Add person** for each employee.
7. **Install on phones** — Android (Chrome): ⋮ → *Install app*. iPhone (Safari): Share → *Add to Home Screen*.

## Tech

React + TypeScript (Vite) PWA · Supabase (PostgreSQL, Auth, row-level security) · Chart.js · Vitest · Playwright · GitHub Actions + Pages.

```
supabase/schema.sql      all tables, rules, server functions, audit chain
src/lib/backend.*.ts     data layer (live + sample data for screen tests)
src/pages/               employee and admin screens
tests/db/                security tests and the six-month back-test
tests/ui/screens.mjs     screen tests
```
