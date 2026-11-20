// v2.1 — several organisations, each with its own Google Sheet, run side by side.
// Each office has a different shape (day shift, night shift, another time zone) and the
// new features (breaks, work from home, overnight fixes) are tested and back-tested in each.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadGas } from './shim';

type G = ReturnType<typeof loadGas>;
interface Org { g: G; admin: string; emp: string; empId: string; tz: string }
const OFFICE = { lat: 19.1136, lng: 72.8697 };
const near = { p_lat: 19.1137, p_lng: 72.8698, p_accuracy: 20 };
const far = { p_lat: 19.2, p_lng: 72.95, p_accuracy: 20 };

function makeOrg(name: string, tz: string, start: string, settings: Record<string, unknown>): Org {
  const g = loadGas(); g.setNowLocal(start, tz); g.ctx.setup();
  const admin = g.call('sign_up', { email: 'boss@' + name.toLowerCase().replace(/\W/g, '') + '.com', code: g.props.get('SETUP_CODE'), password: 'boss-pass-123' }).token;
  g.call('save_settings', { settings: { company_name: name, timezone: tz, ...settings } }, admin);
  const m = g.call('admin_add_member', { p_email: 'staff@x.com', p_nickname: 'Staff' }, admin);
  const emp = g.call('sign_up', { email: 'staff@x.com', code: m.invite_code, password: 'staff-pass-1' }).token;
  return { g, admin, emp, empId: m.id, tz };
}
const day = (o: Org, d: string) => o.g.call('member_days', { p_member: o.empId, p_from: d, p_to: d }, o.admin)[0];

let A: Org, B: Org, C: Org;
beforeAll(() => {
  // A: Mumbai studio — Mon–Fri, 9 h, location check on, no work from home
  A = makeOrg('Dot Studio', 'Asia/Kolkata', '2026-11-16 08:00', { office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_enabled: true });
  // B: support centre — night shift from 22:00, 8 h, Sunday off, work from home allowed
  B = makeOrg('Night Ops', 'Asia/Kolkata', '2026-11-16 08:00', { shift_start: '22:00', required_minutes: 480, half_day_minutes: 240, weekend_mode: 'sun',
    office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_enabled: true, allow_wfh: true });
  // C: shop in Dubai — 6-day week, 8 h, check-in opens 09:00, 3 late marks = ½ day
  C = makeOrg('Gulf Retail', 'Asia/Dubai', '2026-11-16 08:00', { shift_start: '09:30', required_minutes: 480, half_day_minutes: 240, weekend_mode: 'sun',
    earliest_checkin: '09:00', late_marks_per_half_day: 3 });
});

describe('organisations are fully separate', () => {
  it('each server shows its own name before sign-in', () => {
    expect([A.g.call('ping').org, B.g.call('ping').org, C.g.call('ping').org]).toEqual(['Dot Studio', 'Night Ops', 'Gulf Retail']);
    expect(A.g.call('ping').version).toBe('2.1.0');
  });
  it('a token from one office is useless at another', () => {
    expect(() => B.g.call('bootstrap', {}, A.admin)).toThrow(/SIGNED_OUT/);
    expect(() => C.g.call('team_day', {}, B.admin)).toThrow(/SIGNED_OUT/);
  });
  it('same email in two offices = two independent accounts', () => {
    expect(() => A.g.call('sign_in', { email: 'staff@x.com', password: 'wrong-pass-1' })).toThrow();
    expect(A.g.call('sign_in', { email: 'staff@x.com', password: 'staff-pass-1' }).token).not.toBe(A.emp);
  });
  it('settings never leak between offices', () => {
    expect(A.g.call('settings', {}, A.emp)).toMatchObject({ company_name: 'Dot Studio', allow_wfh: false, shift_start: '09:30:00' });
    expect(B.g.call('settings', {}, B.emp)).toMatchObject({ company_name: 'Night Ops', allow_wfh: true, shift_start: '22:00:00' });
    expect(C.g.call('settings', {}, C.emp)).toMatchObject({ timezone: 'Asia/Dubai', earliest_checkin: '09:00:00' });
  });
});

describe('breaks: check out by mistake or step out, then check in again', () => {
  it('second check-in without asking to resume is refused', () => {
    A.g.setNowLocal('2026-11-16 09:30'); A.g.call('punch_in', near, A.emp);
    A.g.setNowLocal('2026-11-16 13:00'); A.g.call('punch_out', near, A.emp);
    expect(() => A.g.call('punch_in', near, A.emp)).toThrow(/ALREADY_PUNCHED_IN/);
  });
  it('resume after lunch: the hour away is not counted', () => {
    A.g.setNowLocal('2026-11-16 14:00'); expect(A.g.call('punch_in', { ...near, p_resume: true }, A.emp).ok).toBe(true);
    A.g.setNowLocal('2026-11-16 19:00'); A.g.call('punch_out', near, A.emp);
    const d = day(A, '2026-11-16');
    expect([d.worked_minutes, d.break_minutes, d.kind]).toEqual([510, 60, 'short']);   // 9h30 on site − 1 h break = 8h30 < 9 h
  });
  it('resume still needs the office location', () => {
    A.g.setNowLocal('2026-11-17 09:30'); A.g.call('punch_in', near, A.emp);
    A.g.setNowLocal('2026-11-17 12:00'); A.g.call('punch_out', near, A.emp);
    A.g.setNowLocal('2026-11-17 12:30');
    expect(A.g.call('punch_in', { ...far, p_resume: true }, A.emp)).toMatchObject({ ok: false, wfh_allowed: false });
    expect(day(A, '2026-11-17').check_out).not.toBeNull();
  });
  it('the admin overwriting both times clears the break', () => {
    A.g.call('admin_set_attendance', { p_member: A.empId, p_date: '2026-11-16', p_in: '09:30', p_out: '18:30', p_reason: 'Confirmed with team lead' }, A.admin);
    expect(day(A, '2026-11-16')).toMatchObject({ worked_minutes: 540, break_minutes: 0, kind: 'full' });
  });
});

describe('work from home', () => {
  it('refused where the office has not allowed it', () => {
    A.g.setNowLocal('2026-11-18 09:30');
    expect(() => A.g.call('punch_in', { p_wfh: true }, A.emp)).toThrow(/not turned on/);
  });
  it('outside the circle, the app is told WFH is an option; WFH check-in needs no location', () => {
    B.g.setNowLocal('2026-11-16 21:55');
    expect(B.g.call('punch_in', far, B.emp)).toMatchObject({ ok: false, wfh_allowed: true });
    expect(B.g.call('punch_in', { p_wfh: true }, B.emp).ok).toBe(true);
  });
});

describe('night shift crosses midnight', () => {
  it('after midnight the shift is still open: no second check-in, the app sees it', () => {
    B.g.setNowLocal('2026-11-17 00:30');
    expect(() => B.g.call('punch_in', near, B.emp)).toThrow(/already checked in since 21:55/);
    const boot = B.g.call('bootstrap', {}, B.emp);
    expect(boot.open.work_date).toBe('2026-11-16');
    expect(day(B, '2026-11-16').kind).toBe('working');            // not “missing check-out” while still on shift
  });
  it('WFH check-out needs no location; hours land on the start date', () => {
    B.g.setNowLocal('2026-11-17 06:00'); B.g.call('punch_out', {}, B.emp);
    expect(day(B, '2026-11-16')).toMatchObject({ worked_minutes: 485, kind: 'full', wfh: true, late: false });
  });
  it('a fix with check-out earlier than check-in means the next morning', () => {
    B.g.setNowLocal('2026-11-18 10:00');
    const c = B.g.call('request_correction', { p_date: '2026-11-17', p_in: '22:00', p_out: '06:00', p_reason: 'Phone died at work' }, B.emp);
    B.g.call('admin_decide_correction', { p_id: c.id, p_approve: true, p_note: 'ok' }, B.admin);
    expect(day(B, '2026-11-17')).toMatchObject({ worked_minutes: 480, kind: 'full' });
  });
  it('late is judged against the 22:00 shift', () => {
    B.g.setNowLocal('2026-11-18 22:20'); B.g.call('punch_in', near, B.emp);
    B.g.setNowLocal('2026-11-19 06:30'); B.g.call('punch_out', near, B.emp);
    expect(day(B, '2026-11-18')).toMatchObject({ late: true, kind: 'full' });
  });
  it('shifts longer than 20 h are rejected', () => {
    expect(() => B.g.call('admin_set_attendance', { p_member: B.empId, p_date: '2026-11-16', p_in: '08:00', p_out: '07:00', p_reason: 'test' }, B.admin)).toThrow(/20 hours/);
  });
});

describe('office in another time zone (Dubai)', () => {
  it('check-in opens at 09:00 Dubai time, not India time', () => {
    C.g.setNowLocal('2026-11-16 08:50', 'Asia/Dubai');
    expect(() => C.g.call('punch_in', {}, C.emp)).toThrow(/TOO_EARLY/);
    C.g.setNowLocal('2026-11-16 09:50', 'Asia/Dubai');            // = 11:20 in India
    expect(C.g.call('punch_in', {}, C.emp).attendance.work_date).toBe('2026-11-16');
    C.g.setNowLocal('2026-11-16 17:50', 'Asia/Dubai'); C.g.call('punch_out', {}, C.emp);
    expect(day(C, '2026-11-16')).toMatchObject({ late: true, worked_minutes: 480, kind: 'full' });
  });
  it('3 late marks = ½ day in the monthly summary; Saturday is a working day', () => {
    for (const d of ['2026-11-17', '2026-11-21']) {
      C.g.setNowLocal(d + ' 09:50', 'Asia/Dubai'); C.g.call('punch_in', {}, C.emp);
      C.g.setNowLocal(d + ' 18:00', 'Asia/Dubai'); C.g.call('punch_out', {}, C.emp);
    }
    C.g.setNowLocal('2026-11-22 12:00', 'Asia/Dubai');
    const s = C.g.call('member_summary', { p_member: C.empId, p_from: '2026-11-16', p_to: '2026-11-22' }, C.admin)[0];
    expect(s).toMatchObject({ late_days: 3, late_penalty_days: 0.5, working_days: 6, present_days: 3 });
  });
});

describe('back-test: 8 weeks of night shifts with breaks and WFH, checked against an independent count', () => {
  it('every day matches', () => {
    const o = makeOrg('Back Test', 'Asia/Kolkata', '2026-01-04 08:00', { shift_start: '21:00', required_minutes: 480, half_day_minutes: 240, weekend_mode: 'sun', allow_wfh: true,
      office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_enabled: true });
    let seed = 42; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pad = (n: number) => String(n).padStart(2, '0');
    const hhmm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
    const expect_: Record<string, { mins: number; wfh: boolean; late: boolean }> = {};
    for (let i = 0; i < 56; i++) {
      const d = new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
      if (new Date(d + 'T12:00:00Z').getUTCDay() === 0 || rnd() < 0.1) continue;      // Sunday off, ~10% absent
      const wfh = rnd() < 0.2, start = 20 * 60 + 40 + Math.floor(rnd() * 50);         // 20:40–21:30
      const firstLeg = 120 + Math.floor(rnd() * 180), brk = rnd() < 0.5 ? 15 + Math.floor(rnd() * 45) : 0, secondLeg = 180 + Math.floor(rnd() * 200);
      const at = (m: number) => { const dd = new Date(Date.UTC(2026, 0, 5 + i + Math.floor(m / 1440))).toISOString().slice(0, 10); o.g.setNowLocal(`${dd} ${hhmm(m % 1440)}`); };
      const loc = wfh ? { p_wfh: true } : near;
      at(start); o.g.call('punch_in', loc, o.emp);
      if (brk) {
        at(start + firstLeg); o.g.call('punch_out', wfh ? {} : near, o.emp);
        at(start + firstLeg + brk); o.g.call('punch_in', { ...loc, p_resume: true }, o.emp);
      }
      at(start + firstLeg + brk + secondLeg); o.g.call('punch_out', wfh ? {} : near, o.emp);
      expect_[d] = { mins: firstLeg + secondLeg, wfh, late: start > 21 * 60 + 15 };
    }
    o.g.setNowLocal('2026-03-05 12:00');
    o.admin = o.g.call('sign_in', { email: 'boss@backtest.com', password: 'boss-pass-123' }).token;   // admin was idle > 30 days, so signed out
    const days = o.g.call('member_days', { p_member: o.empId, p_from: '2026-01-05', p_to: '2026-03-01' }, o.admin);
    let checked = 0;
    for (const d of days) {
      const e = expect_[d.day];
      if (!e) { expect(['weekend', 'absent']).toContain(d.kind); continue; }
      expect([d.day, d.worked_minutes, d.wfh, d.late, d.kind]).toEqual([d.day, e.mins, e.wfh, e.late, e.mins >= 480 ? 'full' : e.mins >= 240 ? 'short' : 'half_day']);
      checked++;
    }
    expect(checked).toBeGreaterThan(35);
    const sum = o.g.call('member_summary', { p_member: o.empId, p_from: '2026-01-05', p_to: '2026-03-01' }, o.admin)[0];
    expect(sum.total_minutes).toBe(Object.values(expect_).reduce((a, x) => a + x.mins, 0));
    expect(o.g.call('verify_audit_chain', {}, o.admin)[0].problem).toBeNull();
  });
});

describe('every office’s audit log still verifies after all of the above', () => {
  it('A, B, C', () => { for (const o of [A, B, C]) expect(o.g.call('verify_audit_chain', {}, o.admin)[0].problem).toBeNull(); });
});
