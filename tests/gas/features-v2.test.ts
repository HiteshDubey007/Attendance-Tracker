// v2 features: per-person shifts, optional rules, privacy, holiday import, reminders, start-up call.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadGas } from './shim';

const OFFICE = { lat: 19.1136, lng: 72.8697 };
let g: ReturnType<typeof loadGas>, admin: string, emp: string, empId: string, part: string, partId: string;

beforeAll(() => {
  g = loadGas(); g.setNowLocal('2026-11-16 08:30'); g.ctx.setup();          // Monday
  admin = g.call('sign_up', { email: 'manager@office.in', code: g.props.get('SETUP_CODE'), password: 'manager-pass' }).token;
  const a = g.call('admin_add_member', { p_email: 'hitesh@office.in', p_nickname: 'Hitesh' }, admin);
  emp = g.call('sign_up', { email: 'hitesh@office.in', code: a.invite_code, password: 'hitesh-pass' }).token; empId = a.id;
  const b = g.call('admin_add_member', { p_email: 'part@office.in', p_nickname: 'Part' }, admin);
  part = g.call('sign_up', { email: 'part@office.in', code: b.invite_code, password: 'part-pass1' }).token; partId = b.id;
});

describe('setup installs the hourly reminder job once', () => {
  it('one trigger, even if setup runs twice', () => { g.ctx.setup(); expect(g.sent.triggers).toEqual(['tick']); });
});

describe('per-person shifts', () => {
  it('admin gives Part a 6-day week, 8 h, starting 10:00', () => {
    const m = g.call('admin_update_member', { p_id: partId, p_nickname: 'Part', p_role: 'employee', p_status: 'active', p_shift_start: '10:00', p_required_minutes: 480, p_weekend_mode: 'sun' }, admin);
    expect(m).toMatchObject({ shift_start: '10:00:00', required_minutes: 480, weekend_mode: 'sun' });
  });
  it('8 h counts as a full day for Part but short for others', () => {
    g.setNowLocal('2026-11-16 10:05'); g.call('punch_in', {}, part); g.call('punch_in', {}, emp);
    g.setNowLocal('2026-11-16 18:05'); g.call('punch_out', {}, part); g.call('punch_out', {}, emp);
    const p = g.call('member_days', { p_member: partId, p_from: '2026-11-16', p_to: '2026-11-16' }, admin)[0];
    const e = g.call('member_days', { p_member: empId, p_from: '2026-11-16', p_to: '2026-11-16' }, admin)[0];
    expect([p.kind, p.late]).toEqual(['full', false]);              // 10:05 is within Part's 10:00 + 15 min grace
    expect([e.kind, e.late]).toEqual(['short', true]);              // office default 09:30 shift, 9 h
  });
  it('Saturday is a working day for Part (leave counts it)', () => {
    g.setNowLocal('2026-11-17 09:00');
    expect(g.call('request_leave', { p_start: '2026-11-20', p_end: '2026-11-23', p_type: 'casual', p_half_day: false, p_reason: 'Trip home' }, part).days).toBe(3);
    expect(g.call('request_leave', { p_start: '2026-11-20', p_end: '2026-11-23', p_type: 'casual', p_half_day: false, p_reason: 'Trip home' }, emp).days).toBe(2);
  });
  it('clearing the shift returns to office defaults', () => {
    const m = g.call('admin_update_member', { p_id: partId, p_nickname: 'Part', p_role: 'employee', p_status: 'active', p_shift_start: '', p_required_minutes: '', p_weekend_mode: '' }, admin);
    expect([m.shift_start, m.required_minutes, m.weekend_mode]).toEqual([null, null, null]);
  });
  it('rejects nonsense shift values', () => {
    expect(() => g.call('admin_update_member', { p_id: partId, p_nickname: 'Part', p_role: 'employee', p_status: 'active', p_required_minutes: 5000 }, admin)).toThrow(/BAD_HOURS/);
    expect(() => g.call('admin_update_member', { p_id: partId, p_nickname: 'Part', p_role: 'employee', p_status: 'active', p_shift_start: '25:00' }, admin)).toThrow(/BAD_TIME/);
  });
});

describe('optional office rules', () => {
  it('earliest check-in time is enforced by the server', () => {
    g.call('save_settings', { settings: { earliest_checkin: '08:00' } }, admin);
    g.setNowLocal('2026-11-18 07:40');
    expect(() => g.call('punch_in', {}, emp)).toThrow(/TOO_EARLY/);
    g.setNowLocal('2026-11-18 08:01');
    expect(g.call('punch_in', {}, emp).ok).toBe(true);
    g.call('save_settings', { settings: { earliest_checkin: '' } }, admin);
  });
  it('late-mark rule converts every N lates into half a day (report only)', () => {
    g.call('save_settings', { settings: { late_marks_per_half_day: 1 } }, admin);
    const [s] = g.call('member_summary', { p_member: empId, p_from: '2026-11-16', p_to: '2026-11-16' }, admin);
    expect(s.late_penalty_days).toBe(0.5);
    g.call('save_settings', { settings: { late_marks_per_half_day: 0 } }, admin);
  });
  it('WhatsApp group link and phone are validated', () => {
    expect(() => g.call('save_settings', { settings: { whatsapp_group_link: 'https://evil.com/x' } }, admin)).toThrow(/chat.whatsapp.com/);
    expect(() => g.call('save_settings', { settings: { admin_whatsapp_phone: 'call me' } }, admin)).toThrow(/digits/);
    const s = g.call('save_settings', { settings: { whatsapp_group_link: 'https://chat.whatsapp.com/AbCdEfGhIj12345', admin_whatsapp_phone: '98 7654 3210', callmebot_apikey: '123456' } }, admin);
    expect(s.admin_whatsapp_phone).toBe('+9876543210');
  });
});

describe('privacy', () => {
  it('raw GPS coordinates are never stored, only distance', () => {
    g.call('save_settings', { settings: { geofence_enabled: true, office_lat: OFFICE.lat, office_lng: OFFICE.lng } }, admin);
    g.setNowLocal('2026-11-19 09:10');
    g.call('punch_in', { p_lat: 19.2, p_lng: 72.9, p_accuracy: 12.4 }, part);                     // refused, far away
    g.call('punch_in', { p_lat: OFFICE.lat + 0.0003, p_lng: OFFICE.lng, p_accuracy: 8.7 }, part);   // accepted
    const dump = JSON.stringify(g.tab('Attendance').data) + JSON.stringify(g.tab('Refused punches').data) + JSON.stringify(g.tab('Audit').data);
    expect(dump).not.toMatch(/19\.2|72\.9|19\.1139/);
    const att = g.call('list', { table: 'attendance', member: partId }, admin).find((r: any) => r.work_date === '2026-11-19');
    expect([att.in_lat, att.in_lng, att.in_distance_m, att.in_accuracy_m]).toEqual([null, null, 33, 9]);
  });
  it("employees never receive the admin's phone number or WhatsApp key", () => {
    const s = g.call('settings', {}, emp);
    expect([s.admin_whatsapp_phone, s.callmebot_apikey]).toEqual(['••••', '••••']);
    const b = g.call('bootstrap', {}, emp);
    expect(JSON.stringify(b)).not.toMatch(/9876543210|123456|manager@office|part@office/);
    expect(g.call('settings', {}, admin).admin_whatsapp_phone).toBe('+9876543210');
  });
  it('saving the masked value does not overwrite the real secret', () => {
    g.call('save_settings', { settings: { admin_whatsapp_phone: '••••', callmebot_apikey: '••••' } }, admin);
    expect(g.call('settings', {}, admin).callmebot_apikey).toBe('123456');
  });
});

describe('start-up call', () => {
  it('employee gets their own week, month, balance and notifications in one request', () => {
    const b = g.call('bootstrap', {}, part);
    expect(b.me.email).toBe('part@office.in');
    expect(b.week[0].day).toBe('2026-11-16');               // week starts Monday, runs up to today
    expect(b.month.present_days).toBeGreaterThan(0);
    expect(b.balance.annual).toBe(24);
    expect(b.pending).toBeUndefined(); expect(b.setup).toBeUndefined();
  });
  it('admin also gets pending count and set-up checklist; app link is remembered', () => {
    const b = g.call('bootstrap', { app_url: 'https://hiteshdubey007.github.io/Attendance-Tracker/' }, admin);
    expect(b.pending).toBe(2);
    expect(b.setup).toMatchObject({ people: 3, location: true, whatsapp: true });
    expect(g.props.get('APP_URL')).toBe('https://hiteshdubey007.github.io/Attendance-Tracker/');
  });
  it('an employee cannot change the app link used in emails', () => {
    g.call('bootstrap', { app_url: 'https://phishing.example/' }, emp);
    expect(g.props.get('APP_URL')).toBe('https://hiteshdubey007.github.io/Attendance-Tracker/');
  });
});

describe('holiday import', () => {
  it('reads common Indian holiday-list layouts', () => {
    const text = [
      'DOT9 GAMES — HOLIDAY LIST 2027', 'S.No | Holiday | Date | Day',
      '1 | Republic Day | 26/01/2027 | Tuesday',
      '2. Holi – 22nd March 2027 (Monday)',
      'Good Friday 26-Mar-2027',
      'Maharashtra Day: May 1, 2027',
      'Independence Day', '15.08.2027', 'Sunday',
      'Gandhi Jayanti    2 Oct',
      'Diwali (Lakshmi Pujan) 29 October 2027 Friday',
      'Christmas 2027-12-25',
      'Random line 31/02/2027 not a real date',
    ].join('\n');
    expect(g.ctx.parseHolidayText(text, 2027)).toEqual([
      { date: '2027-01-26', name: 'Republic Day' }, { date: '2027-03-22', name: 'Holi' }, { date: '2027-03-26', name: 'Good Friday' },
      { date: '2027-05-01', name: 'Maharashtra Day' }, { date: '2027-08-15', name: 'Independence Day' }, { date: '2027-10-02', name: 'Gandhi Jayanti' },
      { date: '2027-10-29', name: 'Diwali (Lakshmi Pujan)' }, { date: '2027-12-25', name: 'Christmas' },
    ]);
  });
  it('file import runs text recognition and deletes the temporary copy', () => {
    g.ocr.text = 'Holi 22 March\nDiwali 29 October';
    const r = g.call('parse_holiday_file', { mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64'), year: 2027 }, admin);
    expect(r.items.map((x: any) => x.date)).toEqual(['2027-03-22', '2027-10-29']);
    expect(g.sent.driveFiles.size).toBe(0); expect(g.sent.removed).toHaveLength(1);
    expect(g.call('list', { table: 'holidays' }, admin).some((h: any) => h.name === 'Holi')).toBe(false);   // nothing saved until confirmed
  });
  it('rejects other file types, oversize files and non-admins', () => {
    expect(() => g.call('parse_holiday_file', { mime: 'text/html', data: 'PGh0bWw+', year: 2027 }, admin)).toThrow(/PDF, JPG or PNG/);
    expect(() => g.call('parse_holiday_file', { mime: 'image/png', data: 'A'.repeat(11 * 1024 * 1024), year: 2027 }, admin)).toThrow(/under 7 MB/);
    expect(() => g.call('parse_holiday_file', { mime: 'image/png', data: 'AAAA', year: 2027 }, emp)).toThrow(/admin only/);
  });
  it('public holiday calendar marks gazetted holidays', () => {
    g.calendar.items = [
      { start: { date: '2027-01-26' }, summary: 'Republic Day', description: 'Public holiday' },
      { start: { date: '2027-02-14' }, summary: "Valentine's Day", description: 'Observance' },
    ];
    expect(g.call('public_holidays', { year: 2027 }, admin)).toEqual([
      { date: '2027-01-26', name: 'Republic Day', gazetted: true }, { date: '2027-02-14', name: "Valentine's Day", gazetted: false }]);
  });
  it('bulk add skips duplicates and junk', () => {
    const r = g.call('add_holidays_bulk', { items: [{ date: '2027-01-26', name: 'Republic Day' }, { date: '2027-01-26', name: 'Again' }, { date: 'nope', name: 'x' }, { date: '2027-03-22', name: '' }] }, admin);
    expect(r).toEqual({ added: 1, skipped: ['2027-01-26', 'nope', '2027-03-22'] });
  });
});

describe('reminders (hourly job)', () => {
  beforeAll(() => { g.call('add_holiday', { date: '2026-11-25', name: 'Guru Nanak Jayanti' }, admin); });
  it('evening before a holiday: admin gets in-app alert, email and WhatsApp — once', () => {
    g.setNowLocal('2026-11-24 18:05'); g.ctx.tick(); g.ctx.tick();
    const n = g.call('notifications', {}, admin).filter((x: any) => x.kind === 'holiday_tomorrow');
    expect(n).toHaveLength(1); expect(n[0].link).toBe('#/announce?date=2026-11-25');
    expect(g.sent.mail.map(m => m.to)).toEqual(['manager@office.in']);
    expect(g.sent.mail[0].htmlBody).toContain('https://hiteshdubey007.github.io/Attendance-Tracker/#/announce?date=2026-11-25');
    expect(g.sent.fetch).toHaveLength(1); expect(g.sent.fetch[0]).toContain('api.callmebot.com');
  });
  it('employees do not see admin alerts', () => {
    expect(g.call('notifications', {}, emp).some((x: any) => x.kind === 'holiday_tomorrow')).toBe(false);
  });
  it('holiday morning: everyone is told the office is closed', () => {
    g.setNowLocal('2026-11-25 08:10'); g.ctx.tick();
    expect(g.call('notifications', {}, emp).map((x: any) => x.title)).toContain('Office closed today: Guru Nanak Jayanti');
  });
  it('missed check-out: only that person is reminded the next morning', () => {
    g.setNowLocal('2026-11-26 09:00'); g.call('punch_in', { p_lat: OFFICE.lat, p_lng: OFFICE.lng, p_accuracy: 5 }, emp);
    g.setNowLocal('2026-11-27 08:15'); g.ctx.tick();
    expect(g.call('notifications', {}, emp).find((x: any) => x.kind === 'missing_checkout')?.link).toBe('#/fixes?date=2026-11-26');
    expect(g.call('notifications', {}, part).some((x: any) => x.kind === 'missing_checkout')).toBe(false);
  });
  it('no reminder before the configured hour', () => {
    const before = g.sent.mail.length;
    g.call('add_holiday', { date: '2026-11-28', name: 'Test Day' }, admin);
    g.setNowLocal('2026-11-27 17:30'); g.ctx.tick();
    expect(g.sent.mail.length).toBe(before);
  });
  it('test alert button works and is admin-only', () => {
    expect(g.call('send_test_alert', {}, admin)).toMatchObject({ email: 1, whatsapp: true });
    expect(() => g.call('send_test_alert', {}, emp)).toThrow(/admin only/);
  });
});

describe('audit stays intact through the v2 changes', () => {
  it('verify passes', () => {
    const [v] = g.call('verify_audit_chain', {}, admin);
    expect(v.problem).toBeNull();
  });
});
