// Attack tests against the Google Sheets backend (gas/Code.js).
import { describe, it, expect, beforeAll } from 'vitest';
import { loadGas } from './shim';

const OFFICE = { lat: 19.1136, lng: 72.8697 };
let g: ReturnType<typeof loadGas>, admin: string, alice: string, bob: string, aliceId: string, bobId: string, bobCode: string;

beforeAll(() => {
  g = loadGas(); g.setNowLocal('2026-11-16 09:00'); g.ctx.setup();
  admin = g.call('sign_up', { email: 'Owner@Company.com', code: g.props.get('SETUP_CODE'), password: 'owner-password' }).token;
  const a = g.call('admin_add_member', { p_email: 'alice@company.com', p_nickname: 'Alice' }, admin);
  const b = g.call('admin_add_member', { p_email: 'bob@company.com', p_nickname: 'Bob' }, admin);
  aliceId = a.id; bobId = b.id; bobCode = b.invite_code;
  alice = g.call('sign_up', { email: 'alice@company.com', code: a.invite_code, password: 'alice-password' }).token;
  bob = g.call('sign_up', { email: 'bob@company.com', code: bobCode, password: 'bob-password' }).token;
});

describe('setup and sign-up', () => {
  it('all tabs exist and the default sheet is gone', () => {
    expect(g.ss.getSheets().map(s => s.name).sort()).toEqual(['Attendance', 'Audit', 'Fixes', 'Holidays', 'Leave', 'Notifications', 'People', 'Refused punches', 'Sessions', 'Settings'].sort());
  });
  it('set-up code works once only', () => {
    expect(g.props.get('SETUP_CODE')).toBeUndefined();
    expect(() => g.call('sign_up', { email: 'x@y.co', code: 'ANYTHING', password: 'longpassword' })).toThrow(/BAD_CODE/);
  });
  it('first account is admin', () => { expect(g.call('me', {}, admin).role).toBe('admin'); });
  it('strangers cannot sign up', () => {
    expect(() => g.call('sign_up', { email: 'hacker@evil.com', code: 'ABCDEFGH', password: 'longpassword' })).toThrow(/BAD_CODE/);
  });
  it('an invite code cannot be reused to hijack an account', () => {
    expect(() => g.call('sign_up', { email: 'bob@company.com', code: bobCode, password: 'stolen-pass' })).toThrow(/BAD_CODE/);
  });
  it('wrong password refused, and guessing gets locked out', () => {
    for (let i = 0; i < 6; i++) expect(() => g.call('sign_in', { email: 'alice@company.com', password: 'guess' + i })).toThrow(/BAD_LOGIN/);
    expect(() => g.call('sign_in', { email: 'alice@company.com', password: 'alice-password' })).toThrow(/TOO_MANY_TRIES/);
    g.cache.clear();
    expect(g.call('sign_in', { email: 'ALICE@company.com', password: 'alice-password' }).token).toBeTruthy();
  });
  it('passwords and codes are never stored in plain text', () => {
    const dump = JSON.stringify(g.tab('People').data) + JSON.stringify(g.tab('Sessions').data) + JSON.stringify(g.tab('Audit').data);
    for (const secret of ['alice-password', 'owner-password', bobCode, alice]) expect(dump).not.toContain(secret);
  });
});

describe('every request is checked on the server', () => {
  it('no token / fake token → refused', () => {
    expect(() => g.call('punch_in', {})).toThrow(/SIGNED_OUT/);
    expect(() => g.call('punch_in', {}, 'forged-token-123')).toThrow(/SIGNED_OUT/);
  });
  it('employee cannot use any admin function', () => {
    for (const fn of ['admin_add_member', 'admin_update_member', 'admin_set_attendance', 'admin_delete_attendance', 'admin_decide_leave',
      'admin_decide_correction', 'add_holiday', 'delete_holiday', 'save_settings', 'team_day', 'team_trend', 'verify_audit_chain', 'admin_reset_code'])
      expect(() => g.call(fn, { p_member: aliceId, p_id: aliceId, p_from: '2026-11-01', p_to: '2026-11-02' }, alice), fn).toThrow(/admin only/);
  });
  it("employee cannot read someone else's data", () => {
    expect(() => g.call('member_days', { p_member: bobId, p_from: '2026-11-01', p_to: '2026-11-16' }, alice)).toThrow(/admin only/);
    expect(() => g.call('leave_balance', { p_member: bobId }, alice)).toThrow(/admin only/);
    expect(() => g.call('list', { table: 'audit_log' }, alice)).toThrow(/admin only/);
    expect(g.call('list', { table: 'members' }, alice).map((m: any) => m.email)).toEqual(['alice@company.com']);
  });
  it('unknown functions and malformed requests are rejected', () => {
    expect(() => g.call('setup', {}, admin)).toThrow(/unknown request/);
    expect(() => g.call('constructor', {}, admin)).toThrow(/unknown request/);
    expect(JSON.parse(g.ctx.doPost({ postData: { contents: 'not json' } }).text).ok).toBe(false);
  });
  it('member lists never leak password data', () => {
    const rows = g.call('list', { table: 'members' }, admin);
    expect(Object.keys(rows[0])).not.toContain('pw_hash');
  });
});

describe('time comes from the server', () => {
  it('check-in stamped with server time; cannot check in twice', () => {
    const r = g.call('punch_in', {}, alice);
    expect(r.ok).toBe(true);
    expect(r.attendance.check_in).toBe('2026-11-16T03:30:00.000Z');
    expect(() => g.call('punch_in', {}, alice)).toThrow(/ALREADY_PUNCHED_IN/);
  });
  it('a check-in time sent by the phone is ignored', () => {
    g.call('punch_in', { check_in: '2026-11-16T00:00:00Z' }, bob);
    expect(g.call('member_days', { p_member: bobId, p_from: '2026-11-16', p_to: '2026-11-16' }, admin)[0].check_in).toBe('2026-11-16T03:30:00.000Z');
  });
  it('check-out records hours', () => {
    g.setNowLocal('2026-11-16 18:15');
    expect(g.call('punch_out', {}, alice).ok).toBe(true);
    const [s] = g.call('member_summary', { p_member: aliceId, p_from: '2026-11-16', p_to: '2026-11-16' }, alice);
    expect(s.total_minutes).toBe(555); expect(s.fulfilled_days).toBe(1);
  });
});

describe('geofence', () => {
  beforeAll(() => { g.call('save_settings', { settings: { geofence_enabled: true, office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_radius_m: 150 } }, admin); g.setNowLocal('2026-11-17 09:05'); });
  it('refuses 2 km away, logs the attempt', () => {
    const r = g.call('punch_in', { p_lat: 19.1316, p_lng: 72.8697, p_accuracy: 15 }, bob);
    expect(r.ok).toBe(false); expect(r.error).toMatch(/OUTSIDE_OFFICE/);
    expect(g.call('list', { table: 'punch_attempts' }, admin)).toHaveLength(1);
  });
  it('refuses missing location, vague GPS, and junk values', () => {
    expect(g.call('punch_in', {}, bob).error).toMatch(/LOCATION_REQUIRED/);
    expect(g.call('punch_in', { p_lat: OFFICE.lat, p_lng: OFFICE.lng, p_accuracy: 900 }, bob).error).toMatch(/LOCATION_INACCURATE/);
    expect(g.call('punch_in', { p_lat: '19.1136', p_lng: OFFICE.lng, p_accuracy: 5 }, bob).error).toMatch(/LOCATION_REQUIRED/);
    expect(g.call('punch_in', { p_lat: OFFICE.lat, p_lng: OFFICE.lng, p_accuracy: -1 }, bob).error).toMatch(/LOCATION_INACCURATE/);
  });
  it('accepts 60 m away', () => {
    const r = g.call('punch_in', { p_lat: OFFICE.lat + 0.00054, p_lng: OFFICE.lng, p_accuracy: 20 }, bob);
    expect(r.ok).toBe(true); expect(Math.round(r.attendance.in_distance_m)).toBe(60);
  });
  it('cannot turn geofence on without a location', () => {
    expect(() => g.call('save_settings', { settings: { office_lat: null } }, admin)).toThrow(/office location/);
  });
});

describe('blocking, removal, password reset', () => {
  it('blocking signs the person out everywhere', () => {
    g.call('admin_update_member', { p_id: bobId, p_nickname: 'Bob', p_role: 'employee', p_status: 'blocked' }, admin);
    expect(() => g.call('punch_out', {}, bob)).toThrow(/SIGNED_OUT/);
    expect(() => g.call('sign_in', { email: 'bob@company.com', password: 'bob-password' })).toThrow(/blocked/);
  });
  it('admin cannot lock themselves out', () => {
    const me = g.call('me', {}, admin);
    expect(() => g.call('admin_update_member', { p_id: me.id, p_nickname: 'x', p_role: 'employee', p_status: 'active' }, admin)).toThrow(/yourself/);
  });
  it('reset code lets an unblocked person set a new password; old sessions die', () => {
    g.call('admin_update_member', { p_id: bobId, p_nickname: 'Bob', p_role: 'employee', p_status: 'active' }, admin);
    const { invite_code } = g.call('admin_reset_code', { p_id: bobId }, admin);
    bob = g.call('sign_up', { email: 'bob@company.com', code: invite_code, password: 'bob-new-password' }).token;
    expect(() => g.call('sign_in', { email: 'bob@company.com', password: 'bob-password' })).toThrow(/BAD_LOGIN/);
    expect(g.call('me', {}, bob).nickname).toBe('Bob');
  });
  it('removed then re-added keeps the same person', () => {
    g.call('admin_update_member', { p_id: bobId, p_nickname: 'Bob', p_role: 'employee', p_status: 'deleted' }, admin);
    const m = g.call('admin_add_member', { p_email: 'BOB@company.com', p_nickname: 'Bobby' }, admin);
    expect(m.id).toBe(bobId); expect(m.status).toBe('active');
  });
});

describe('leave and fixes', () => {
  it('holidays and weekends are not deducted', () => {
    g.call('add_holiday', { date: '2026-11-20', name: 'Test Holiday' }, admin);
    const r = g.call('request_leave', { p_start: '2026-11-19', p_end: '2026-11-24', p_type: 'casual', p_half_day: false, p_reason: 'Family trip' }, alice);
    expect(r.days).toBe(3);
  });
  it('overlap, balance, bad input refused', () => {
    expect(() => g.call('request_leave', { p_start: '2026-11-24', p_end: '2026-11-24', p_type: 'sick', p_half_day: true, p_reason: 'Doctor' }, alice)).toThrow(/OVERLAP/);
    expect(() => g.call('request_leave', { p_start: '2026-12-01', p_end: '2026-12-31', p_type: 'earned', p_half_day: false, p_reason: 'Long holiday' }, alice)).toThrow(/INSUFFICIENT_BALANCE/);
    expect(() => g.call('request_leave', { p_start: 'tomorrow', p_end: '2026-12-31', p_type: 'earned', p_half_day: false, p_reason: 'x x x' }, alice)).toThrow(/BAD_DATES/);
    expect(() => g.call('request_leave', { p_start: '2026-12-01', p_end: '2026-12-01', p_type: 'paid-forever', p_half_day: false, p_reason: 'x x x' }, alice)).toThrow(/BAD_TYPE/);
  });
  it('approval updates balance', () => {
    const [l] = g.call('list', { table: 'leave_requests' }, alice);
    g.call('admin_decide_leave', { p_id: l.id, p_approve: true, p_note: 'Enjoy' }, admin);
    const [b] = g.call('leave_balance', {}, alice);
    expect(b).toEqual({ annual: 24, used: 3, pending: 0, remaining: 21 });
  });
  it('approved fix rewrites the day with an audited reason', () => {
    const c = g.call('request_correction', { p_date: '2026-11-16', p_in: '08:45', p_out: null, p_reason: 'App was slow' }, alice);
    g.call('admin_decide_correction', { p_id: c.id, p_approve: true }, admin);
    const d = g.call('member_days', { p_member: aliceId, p_from: '2026-11-16', p_to: '2026-11-16' }, alice)[0];
    expect(d.check_in).toBe('2026-11-16T03:15:00.000Z');
  });
});

describe('tamper detection', () => {
  it('intact after all of the above', () => {
    const [v] = g.call('verify_audit_chain', {}, admin);
    expect(v.broken_at).toBeNull(); expect(v.entries).toBeGreaterThan(10);
  });
  it('detects someone editing a check-in time straight in the sheet', () => {
    const tab = g.tab('Attendance'); const saved = tab.data[1][3];
    tab.data[1][3] = '2026-11-16T02:00:00.000Z';
    const [v] = g.call('verify_audit_chain', {}, admin);
    expect(v.problem).toMatch(/Attendance tab row 2 was edited/);
    tab.data[1][3] = saved;
  });
  it('detects a deleted row', () => {
    const tab = g.tab('Holidays'); const saved = tab.data.splice(1, 1);
    expect(g.call('verify_audit_chain', {}, admin)[0].problem).toMatch(/deleted directly/);
    tab.data.splice(1, 0, ...saved);
  });
  it('detects an edited audit entry', () => {
    const tab = g.tab('Audit'); const i = tab.data.findIndex(r => r[7].includes('"Alice"')); const saved = tab.data[i][7];
    tab.data[i][7] = saved.replace('"Alice"', '"Mallory"');
    expect(g.call('verify_audit_chain', {}, admin)[0].broken_at).toBe(Number(tab.data[i][0]));
    tab.data[i][7] = saved;
    expect(g.call('verify_audit_chain', {}, admin)[0].broken_at).toBeNull();
  });
});
