# PunchIn v2.1 — Test report

All tests run automatically on every change (GitHub → Actions). Nothing is published unless every one passes.

| Suite | What it does | Tests |
|---|---|---|
| Server security (Google Sheets) | Attacks the real server code directly | 31 |
| Server v2 features | Shifts, optional rules, privacy, holiday import, reminders | 30 |
| Several organisations (v2.1) | 3 offices side by side + 8-week night-shift back-test with breaks and WFH | 19 |
| Back-test (Sheets + PostgreSQL) | 6 months × 18 people replayed; 108 monthly reports must match an independent calculation exactly | 20 |
| Database security (PostgreSQL, alternative backend) | Row-level security, forged writes, audit tampering | 32 |
| Logic | Date maths, CSV safety, app ↔ server agreement on 300 random date ranges | 7 |
| End-to-end in Chrome | The real app + real server code; tester-style flows below | 34 |
| Screens | Every screen on phone and laptop; no errors, no sideways scroll; tour; leave preview | 38 |

## 1. Basic flows
- Manager becomes admin with the one-time set-up code; the code cannot be reused.
- Admin is shown a guided tour and a set-up checklist automatically.
- Admin adds a person → gets a WhatsApp invite with a link that pre-fills email and code.
- Employee opens the link → sets password → is shown how to install the app.
- Employee tour starts on first open and never repeats after “Skip”.
- Check-in/out, history, leave (weekends/holidays not counted), fixes, approvals, holidays, CSV export.

## 2. Advanced
- Per-person shifts: 8 h / 6-day week person vs office default 9 h / 5-day — reports, late marks and leave days differ correctly.
- Optional rules: earliest check-in enforced by the server; late marks → half-day shown in reports.
- Holiday import: PDF/photo text recognition (8 real-world layouts incl. split table rows, “22nd March 2027 (Monday)”, “Good Friday” kept, 31/02 rejected); temporary file deleted; nothing saved until the admin confirms.
- Public holidays: gazetted pre-ticked, observances unticked; duplicates skipped.
- Reminders: evening before a holiday → admin in-app + email + optional WhatsApp, once only; holiday morning → everyone notified; missed check-out → only that person reminded.

## 2b. Different kinds of organisation (v2.1)
| Office | Set-up | Checked |
|---|---|---|
| Studio, Mumbai | Mon–Fri, 9 h, location check, no WFH | Break after lunch not counted; resume still needs the office; WFH refused |
| Support centre | Night shift 22:00, 8 h, Sunday off, WFH allowed | Shift past midnight stays open (no double check-in, not “missing check-out”); late judged against 22:00; overnight fixes; >20 h refused |
| Shop, Dubai | Dubai time zone, 6-day week, check-in from 09:00, 3 lates = ½ day | Opening time and late marks use Dubai time; Saturday counts |
| All three | Separate sheets | Names shown before sign-in; a token from one office is refused by another; same email = separate accounts; audit logs verify |
| Same app, two offices | `?org=` link | The first office's sign-in is never sent to the second office's server |

Back-test: 8 weeks of random night shifts (20:40–21:30 starts, breaks across midnight, 20 % WFH) — every day's hours, WFH flag, late mark and status match an independent count.

## 3. Hacking tests
- Employee types admin URLs (`#/admin`, `/people`, `/settings`, `/security`, `/announce`, `/more`) → sent back to their own screen.
- Employee token calling admin functions directly → `admin only`.
- Forged / stale token → signed out, no data shown.
- No token, unknown functions, `constructor`/prototype names, malformed JSON → refused.
- Reading another person's records, balance, audit log → refused.
- Invite code reuse to hijack an account → refused. Password guessing → locked after 6 tries.
- Script injected via the invite link and via a nickname → shown as text, never executed.
- Spreadsheet formulas (`=IMPORTXML(...)`) typed into names → stored as plain text.
- App inside another site's frame (click-jacking) → refuses to run.
- Employee trying to change the link used in admin emails (phishing) → ignored.
- Editing a check-in time, deleting a row, or altering the audit log directly in the Google Sheet → **detected** by Security → Verify, naming the row.

## Fixed in v2.1
- New joiners were shown as “Absent” for every day before they joined.
- Night shifts: after midnight the app offered a second check-in, and the shift showed as “missing check-out”.
- Admin and fix requests could not record a check-out after midnight.
- Leave preview used the office weekly off instead of the person's own (6-day-week staff saw the wrong count).
- Checking out by mistake could not be undone — now “Check in again” (time away is not counted).

## 4. Location tests (150 m circle)
| Position | Result |
|---|---|
| 60 m | Check-in accepted, distance 60 m stored |
| 149 m | Inside |
| 152 m | Outside — “152 m away” |
| 2 km | Outside; server refuses check-out; attempt logged for admin |
| GPS accuracy ±400 m | “GPS too vague — move near a window” |
| Permission denied | Clear message; no punch |
| Coordinates sent as text / negative accuracy / missing | Server refuses |
| Opening the app | Location is **not** read until a button is tapped |

## 5. Privacy
- No camera, microphone, contacts, photos, Bluetooth or background location — ever (checked in the browser and the app manifest).
- Exact GPS coordinates are never stored; only distance and accuracy (verified across every sheet tab).
- The app only talks to: itself, Google (server), Google Fonts, OpenStreetMap tiles.
- Strict Content-Security-Policy; Google cookies never sent with requests.
- Admin's WhatsApp number and API key are never sent to employees' phones.
- Plain-language privacy page available before sign-in (aligned with India's DPDP Act notice requirements: what is collected, why, who sees it, how to correct it).

## Known limits (honest)
- A web app cannot detect “fake GPS” apps on rooted phones; distances and refused attempts are logged so patterns stand out.
- WhatsApp does not allow apps to post into groups; the admin taps Send on a pre-written message.
- iPhone install needs 2 taps (Share → Add to Home Screen); Android is 1 tap.
- Google Apps Script answers in ~1–2 s per request; the app loads everything it needs in one request.
