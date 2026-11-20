// Sample data used only by `npm run build:mock` for automated screenshot tests of every screen.
// It is never shipped in the real app (see vite.config.ts alias).
import type { Backend, Boot, Day, DayKind, Member, Settings, LeaveRequest, Correction, Holiday } from './types';
import { addDays } from './time';

const role = (new URLSearchParams(location.search).get('as') ?? 'admin') as 'admin' | 'employee';
const TODAY = '2026-11-19';
const settings: Settings = {
  company_name: 'Dot Studio', timezone: 'Asia/Kolkata', required_minutes: 540, half_day_minutes: 270, weekend_mode: 'sat_sun',
  annual_leave_days: 24, shift_start: '09:30:00', late_grace_minutes: 15, geofence_enabled: true,
  office_lat: 19.1136, office_lng: 72.8697, geofence_radius_m: 150, max_gps_accuracy_m: 100,
  office_end: '18:30:00', earliest_checkin: null, late_marks_per_half_day: 0, allow_wfh: true, reminder_hour: 18, notify_admin_email: true,
  whatsapp_group_link: '', admin_whatsapp_phone: '', callmebot_apikey: '',
};
const names = ['Hitesh', 'Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Sana', 'Vikram'];
const members: Member[] = names.map((n, i) => ({
  id: 'm' + i, user_id: 'u' + i, email: n.toLowerCase() + '@dotstudio.in', nickname: n,
  role: i === 0 ? 'admin' : 'employee', status: i === 6 ? 'blocked' : 'active', created_at: '2026-01-05T04:00:00Z',
  shift_start: i === 3 ? '11:00:00' : null, required_minutes: i === 3 ? 480 : null, weekend_mode: null,
}));
const me = role === 'admin' ? members[0] : members[1];
const holidays: Holiday[] = [
  { id: 'h1', holiday_date: '2026-11-08', name: 'Diwali' }, { id: 'h2', holiday_date: '2026-12-25', name: 'Christmas' },
  { id: 'h3', holiday_date: '2026-03-04', name: 'Holi' },
];
const ist = (d: string, m: number) => new Date(Date.parse(d + 'T00:00:00+05:30') + m * 60000).toISOString();
let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function makeDays(mid: string, from: string, to: string): Day[] {
  const out: Day[] = []; seed = 7 + mid.charCodeAt(1);
  for (let d = from; d <= to && d <= TODAY; d = addDays(d, 1)) {
    const dow = new Date(d + 'T12:00:00Z').getUTCDay(); const h = holidays.find(x => x.holiday_date === d);
    let kind: DayKind = dow === 0 || dow === 6 ? 'weekend' : h ? 'holiday' : 'full';
    let ci: string | null = null, co: string | null = null, mins: number | null = null, late = false;
    if (kind === 'full') {
      const x = r();
      if (d === TODAY) { ci = ist(d, 552); kind = 'working'; }
      else if (x < 0.06) kind = 'absent'; else if (x < 0.1) kind = 'leave';
      else {
        const inM = 520 + Math.floor(r() * 70); mins = 470 + Math.floor(r() * 110); late = inM > 585;
        ci = ist(d, inM); co = x < 0.13 ? null : ist(d, inM + mins);
        kind = !co ? 'missing_checkout' : mins >= 540 ? 'full' : 'short'; if (!co) mins = null;
      }
    }
    out.push({ day: d, kind, check_in: ci, check_out: co, worked_minutes: mins, late, fulfilled: kind === 'full', leave_days: kind === 'leave' ? 1 : 0, holiday: h?.name ?? null });
  }
  return out;
}
const leaves: LeaveRequest[] = [
  { id: 'l1', member_id: 'm1', start_date: '2026-11-24', end_date: '2026-11-26', leave_type: 'casual', half_day: false, days: 3, reason: 'Cousin’s wedding in Pune', status: 'pending', admin_note: null, decided_at: null, created_at: '2026-11-17T06:00:00Z' },
  { id: 'l2', member_id: 'm3', start_date: '2026-11-21', end_date: '2026-11-21', leave_type: 'sick', half_day: true, days: 0.5, reason: 'Dentist appointment', status: 'pending', admin_note: null, decided_at: null, created_at: '2026-11-18T06:00:00Z' },
  { id: 'l3', member_id: 'm1', start_date: '2026-10-13', end_date: '2026-10-14', leave_type: 'sick', half_day: false, days: 2, reason: 'Fever', status: 'approved', admin_note: 'Get well soon', decided_at: '2026-10-12T06:00:00Z', created_at: '2026-10-12T05:00:00Z' },
  { id: 'l4', member_id: 'm1', start_date: '2026-09-02', end_date: '2026-09-02', leave_type: 'casual', half_day: false, days: 1, reason: 'Personal work', status: 'rejected', admin_note: 'Release week', decided_at: '2026-09-01T06:00:00Z', created_at: '2026-08-30T05:00:00Z' },
];
const corrections: Correction[] = [
  { id: 'c1', member_id: 'm4', work_date: '2026-11-17', requested_check_in: null, requested_check_out: '18:40:00', reason: 'Forgot to check out after the review call', status: 'pending', admin_note: null, created_at: '2026-11-18T04:00:00Z' },
];
const notices = role === 'admin'
  ? [{ id: 'n1', audience: 'admins', kind: 'holiday_tomorrow', title: 'Tomorrow is a holiday: Guru Nanak Jayanti', body: 'Tap to post the announcement on the office WhatsApp group.', link: '#/announce?date=2026-11-24', created_at: ist(TODAY, 540) }]
  : [{ id: 'n2', audience: 'm1', kind: 'missing_checkout', title: 'You didn’t check out yesterday', body: 'Request a fix so your hours count.', link: '#/fixes?date=2026-11-18', created_at: ist(TODAY, 495) }];
const wait = <T,>(v: T) => new Promise<T>(res => setTimeout(() => res(v), 60));
const mine = <T extends { member_id: string }>(xs: T[], m?: string) => xs.filter(x => role === 'admin' ? (!m || x.member_id === m) : x.member_id === me.id);

export async function initBackend() { return true; }
export const backend: Backend = {
  configured: true,
  onAuth(cb) { const signedIn = !location.search.includes('signedout'); setTimeout(() => cb(signedIn)); return () => {}; },
  signIn: async () => {}, signUp: async () => {}, signOut: async () => {},
  serverTime: () => wait(ist(TODAY, 600)),
  notifications: () => wait(notices),
  async bootstrap() {
    const week = makeDays(me.id, '2026-11-16', TODAY);
    const b: Boot = { me, settings, schedule: { shift_start: '09:30:00', required: 540, half: 270, weekend_mode: 'sat_sun', custom: false }, server_time: ist(TODAY, 600), today: TODAY,
      week, month: await backend.summary(me.id, '2026-11-01', TODAY), balance: { annual: 24, used: 9, pending: 3, remaining: 15 }, notifications: notices,
      upcoming_holidays: [{ id: 'h9', holiday_date: '2026-11-24', name: 'Guru Nanak Jayanti' }] };
    if (role === 'admin') { b.pending = 3; b.setup = { people: 7, holidays: 1, location: true, whatsapp: false }; }
    return wait(b);
  },
  orgName: async () => 'Dot Studio',
  inviteLink: (e, c) => `${location.href.split('#')[0]}#/join?e=${encodeURIComponent(e)}&c=${c}`,
  punch: async () => ({ ok: false, wfh_allowed: true, error: 'You are 1840 m from the office (limit 150 m)' }),
  days: (m, f, t) => wait(makeDays(m, f, t)),
  async summary(m, f, t) {
    const ds = makeDays(m, f, t);
    const c = (k: string) => ds.filter(d => d.kind === k).length;
    return { working_days: ds.filter(d => !['weekend', 'holiday'].includes(d.kind)).length, present_days: ds.filter(d => d.check_in).length,
      fulfilled_days: c('full'), unfulfilled_days: c('short') + c('missing_checkout'), missing_checkout_days: c('missing_checkout'),
      late_days: ds.filter(d => d.late).length, leave_days: c('leave'), absent_days: c('absent'), total_minutes: ds.reduce((s, d) => s + (d.worked_minutes ?? 0), 0) };
  },
  balance: () => wait({ annual: 24, used: 9, pending: 3, remaining: 15 }),
  leaves: (m) => wait(mine(leaves, m)), requestLeave: async () => {}, cancelLeave: async () => {},
  corrections: (m) => wait(mine(corrections, m)), requestCorrection: async () => {},
  holidays: () => wait(holidays),
  members: () => wait(members), addMember: async () => 'K7QM4XPA', resetCode: async () => 'R2TW9HNE',
  addHolidays: async (items) => ({ added: items.length, skipped: [] }),
  publicHolidays: async () => wait([{ date: '2027-01-26', name: 'Republic Day', gazetted: true }, { date: '2027-02-14', name: "Valentine's Day", gazetted: false },
    { date: '2027-03-22', name: 'Holi', gazetted: true }, { date: '2027-08-15', name: 'Independence Day', gazetted: true }]),
  readHolidayFile: async () => wait([{ date: '2027-01-26', name: 'Republic Day' }, { date: '2027-03-22', name: 'Holi' }, { date: '2027-10-29', name: 'Diwali' }]),
  sendTestAlert: async () => ({ email: 1, whatsapp: false }), updateMember: async () => {},
  teamDay: () => wait(members.filter(m => m.status === 'active').map((m, i) => {
    const d = makeDays(m.id, TODAY, TODAY)[0];
    const kind = (['working', 'working', 'not_yet', 'working', 'leave', 'working', 'working'] as DayKind[])[i] ?? 'working';
    return { member_id: m.id, nickname: m.nickname, email: m.email, kind, check_in: kind === 'working' ? ist(TODAY, 520 + i * 9) : null, check_out: null, worked_minutes: null, late: i === 5, ...(d ? {} : {}) };
  })),
  teamTrend: (f, t) => {
    const rows = []; seed = 3;
    for (let d = f; d <= t && d <= TODAY; d = addDays(d, 1)) {
      const dow = new Date(d + 'T12:00:00Z').getUTCDay(); const off = dow === 0 || dow === 6 || holidays.some(h => h.holiday_date === d);
      const p = off ? 0 : 5 + Math.floor(r() * 3);
      rows.push({ day: d, present: p, full_days: off ? 0 : Math.max(0, p - Math.floor(r() * 3)), on_leave: off ? 0 : Math.floor(r() * 2), absent: off ? 0 : 7 - p, expected: off ? 0 : 7 });
    }
    return wait(rows);
  },
  attendance: (m, f, t) => wait(makeDays(m, f, t).filter(d => d.check_in).reverse().map((d, i) => ({
    id: 'a' + i, member_id: m, work_date: d.day, check_in: d.check_in!, check_out: d.check_out, in_distance_m: 42, out_distance_m: 38,
    source: i === 3 ? 'correction' : i === 6 ? 'admin' : 'app', edit_reason: i === 3 ? 'Forgot to check out' : i === 6 ? 'Biometric showed earlier entry' : null }))),
  setAttendance: async () => {}, deleteAttendance: async () => {}, decideLeave: async () => {}, decideCorrection: async () => {},
  addHoliday: async () => {}, deleteHoliday: async () => {}, saveSettings: async () => {},
  verifyAudit: () => wait({ entries: 4182, broken_at: null, last_hash: '9f2c4be1a07d5c3e88b1f6a2d94e0c7b3a51f8e26d0b9c4a7e1f3d5b8c2a6e90' }),
  auditLog: () => wait([
    { id: 4182, at: ist(TODAY, 552), actor: 'm1', action: 'insert', table_name: 'attendance', row_id: 'x', old_data: null, new_data: {}, hash: '9f2c4b…' },
    { id: 4181, at: ist('2026-11-18', 1100), actor: 'm0', action: 'update', table_name: 'leave_requests', row_id: 'y', old_data: { status: 'pending' }, new_data: { status: 'approved' }, hash: '1ab07e…' },
  ]),
  punchAttempts: () => wait([
    { id: 'p1', member_id: 'm5', attempted_at: ist('2026-11-18', 548), kind: 'in', distance_m: 1840, accuracy_m: 14, reason: 'OUTSIDE_OFFICE: you are 1840 m from the office (limit 150 m)' },
    { id: 'p2', member_id: 'm3', attempted_at: ist('2026-11-14', 1101), kind: 'out', distance_m: null, accuracy_m: null, reason: 'LOCATION_REQUIRED: turn on location to punch' },
  ]),
};
