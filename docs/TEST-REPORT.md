# PunchIn v2 — Test report

All tests run automatically on every change (GitHub → Actions). Nothing is published unless every one passes.

| Suite | What it does | Tests |
|---|---|---|
| Server security (Google Sheets) | Attacks the real server code directly | 31 |
| Server v2 features | Shifts, optional rules, privacy, holiday import, reminders | 30 |
| Back-test (Sheets + PostgreSQL) | 6 months × 18 people replayed; 108 monthly reports must match an independent calculation exactly | 20 |
| Database security (PostgreSQL, alternative backend) | Row-level security, forged writes, audit tampering | 32 |
| Logic | Date maths, CSV safety, app ↔ server agreement on 300 random date ranges | 7 |
| End-to-end in Chrome | The real app + real server code; tester-style flows below | 27 |
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
