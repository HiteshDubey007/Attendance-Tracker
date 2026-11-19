import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestDb } from './harness';

const OFFICE = { lat: 19.1136, lng: 72.8697 };          // Andheri, Mumbai
let db: TestDb, adminU: string, aliceU: string, bobU: string, aliceId: string, bobId: string;

beforeAll(async () => {
  db = await new TestDb().setup();
  await db.setClock('2026-11-16 09:00');                  // Monday
  adminU = await db.signUp('Owner@Company.com');          // first signup becomes admin
  await db.rpc(adminU, 'admin_add_member', { p_email: 'alice@company.com', p_nickname: 'Alice' });
  await db.rpc(adminU, 'admin_add_member', { p_email: 'bob@company.com', p_nickname: 'Bob' });
  aliceU = await db.signUp('alice@company.com');
  bobU = await db.signUp('bob@company.com');
  const ms = (await db.admin.query('select id, email from members')).rows;
  aliceId = ms.find(m => m.email === 'alice@company.com').id;
  bobId = ms.find(m => m.email === 'bob@company.com').id;
});
afterAll(() => db.teardown());

describe('sign-up gate', () => {
  it('first account became admin with lower-cased email', async () => {
    const r = (await db.admin.query(`select role, email from members where email like 'owner%'`)).rows[0];
    expect(r).toEqual({ role: 'admin', email: 'owner@company.com' });
  });
  it('refuses strangers who were not invited', async () => {
    await expect(db.signUp('hacker@evil.com')).rejects.toThrow(/NOT_INVITED/);
  });
});

describe('direct table writes are impossible for users', () => {
  it('employee cannot insert attendance directly', async () => {
    await expect(db.as(aliceU, `insert into attendance(member_id, work_date, check_in) values ($1, '2026-11-16', now())`, [aliceId]))
      .rejects.toThrow(/permission denied/);
  });
  it('employee cannot update their own check-in time', async () => {
    await db.rpc(aliceU, 'punch_in');
    await expect(db.as(aliceU, `update attendance set check_in = check_in - interval '2 hours'`)).rejects.toThrow(/permission denied/);
  });
  it('employee cannot promote themselves to admin', async () => {
    await expect(db.as(aliceU, `update members set role = 'admin' where id = $1`, [aliceId])).rejects.toThrow(/permission denied/);
  });
  it('employee cannot approve leave by writing the table', async () => {
    await expect(db.as(aliceU, `update leave_requests set status = 'approved'`)).rejects.toThrow(/permission denied/);
  });
  it('employee cannot change office settings', async () => {
    await expect(db.as(aliceU, `update org_settings set required_minutes = 60`)).resolves.toBeDefined();
    const r = (await db.admin.query('select required_minutes from org_settings')).rows[0];
    expect(r.required_minutes).toBe(540);                 // RLS silently matched 0 rows
  });
  it('anonymous visitors see nothing and can call nothing', async () => {
    await expect(db.as(null, 'select * from attendance')).rejects.toThrow(/permission denied/);
    await expect(db.as(null, 'select punch_in()')).rejects.toThrow(/permission denied/);
  });
  it('employee cannot reach internal helpers', async () => {
    await expect(db.as(aliceU, `select _local_ts('2026-01-01','09:00')`)).rejects.toThrow(/permission denied/);
  });
});

describe('privacy (row-level security)', () => {
  it('employee only sees their own attendance and member row', async () => {
    await db.rpc(bobU, 'punch_in');
    const att = await db.as(aliceU, 'select member_id from attendance');
    expect(att.every(r => r.member_id === aliceId)).toBe(true);
    const mem = await db.as(aliceU, 'select email from members');
    expect(mem.map(m => m.email)).toEqual(['alice@company.com']);
  });
  it("employee cannot read another person's reports", async () => {
    await expect(db.rpc(aliceU, 'member_summary', { p_member: bobId, p_from: '2026-11-01', p_to: '2026-11-16' }))
      .rejects.toThrow(/admin only/);
    await expect(db.rpc(aliceU, 'team_day')).rejects.toThrow(/admin only/);
    await expect(db.rpc(aliceU, 'verify_audit_chain')).rejects.toThrow(/admin only/);
  });
  it('admin sees everyone', async () => {
    const rows = await db.rpc(adminU, 'team_day');
    expect(rows.map(r => r.nickname).sort()).toEqual(['Alice', 'Bob', 'owner']);
  });
});

describe('time comes from the server', () => {
  it('check-in is stamped with server time, regardless of the phone', async () => {
    const r = (await db.as(aliceU, `select check_in at time zone 'Asia/Kolkata' as t from attendance`))[0];
    expect(String(r.t)).toContain('09:00');
  });
  it('cannot check in twice the same day', async () => {
    await expect(db.rpc(aliceU, 'punch_in')).rejects.toThrow(/ALREADY_PUNCHED_IN/);
  });
  it('check-out records worked minutes', async () => {
    await db.setClock('2026-11-16 18:15');
    const [{ punch_out }] = await db.rpc(aliceU, 'punch_out');
    expect(punch_out.ok).toBe(true);
    const [s] = await db.rpc(aliceU, 'member_summary', { p_member: aliceId, p_from: '2026-11-16', p_to: '2026-11-16' });
    expect(Number(s.total_minutes)).toBe(555);
    expect(s.fulfilled_days).toBe(1);
  });
});

describe('geofence', () => {
  beforeAll(async () => {
    await db.as(adminU, `update org_settings set geofence_enabled = true, office_lat = $1, office_lng = $2, geofence_radius_m = 150`, [OFFICE.lat, OFFICE.lng]);
    await db.setClock('2026-11-17 09:05');
  });
  it('refuses a punch 2 km away and logs the attempt for the admin', async () => {
    const [{ punch_in }] = await db.rpc(bobU, 'punch_in', { p_lat: 19.1316, p_lng: 72.8697, p_accuracy: 15 });
    expect(punch_in.ok).toBe(false);
    expect(punch_in.error).toMatch(/OUTSIDE_OFFICE/);
    const attempts = await db.as(adminU, 'select reason from punch_attempts');
    expect(attempts).toHaveLength(1);
  });
  it('refuses when the phone hides its location', async () => {
    const [{ punch_in }] = await db.rpc(bobU, 'punch_in');
    expect(punch_in.error).toMatch(/LOCATION_REQUIRED/);
  });
  it('refuses a vague GPS fix', async () => {
    const [{ punch_in }] = await db.rpc(bobU, 'punch_in', { p_lat: OFFICE.lat, p_lng: OFFICE.lng, p_accuracy: 900 });
    expect(punch_in.error).toMatch(/LOCATION_INACCURATE/);
  });
  it('accepts a punch 60 m from the office', async () => {
    const [{ punch_in }] = await db.rpc(bobU, 'punch_in', { p_lat: OFFICE.lat + 0.00054, p_lng: OFFICE.lng, p_accuracy: 20 });
    expect(punch_in.ok).toBe(true);
    expect(Math.round(punch_in.attendance.in_distance_m)).toBeGreaterThan(50);
  });
});

describe('blocking and deleting', () => {
  it('blocked employee cannot punch or read', async () => {
    await db.rpc(adminU, 'admin_update_member', { p_id: bobId, p_nickname: 'Bob', p_role: 'employee', p_status: 'blocked' });
    await expect(db.rpc(bobU, 'punch_out')).rejects.toThrow(/not active/);
    expect(await db.as(bobU, 'select * from attendance')).toHaveLength(0);
  });
  it('admin cannot block or demote themselves', async () => {
    const me = (await db.admin.query(`select id from members where role='admin'`)).rows[0].id;
    await expect(db.rpc(adminU, 'admin_update_member', { p_id: me, p_nickname: 'x', p_role: 'employee', p_status: 'active' }))
      .rejects.toThrow(/yourself/);
  });
  it('re-adding a deleted email reactivates the same person', async () => {
    await db.rpc(adminU, 'admin_update_member', { p_id: bobId, p_nickname: 'Bob', p_role: 'employee', p_status: 'deleted' });
    const [m] = await db.rpc(adminU, 'admin_add_member', { p_email: 'BOB@company.com', p_nickname: 'Bobby' });
    expect(m.id).toBe(bobId);
    expect(m.status).toBe('active');
  });
});

describe('leave rules', () => {
  it('holidays and weekends are not deducted', async () => {
    await db.as(adminU, `insert into holidays(holiday_date, name) values ('2026-11-20', 'Test Holiday')`);
    // Thu 19 → Tue 24: Thu, (Fri holiday), (Sat), (Sun), Mon, Tue = 3 days
    const [r] = await db.rpc(aliceU, 'request_leave', { p_start: '2026-11-19', p_end: '2026-11-24', p_type: 'casual', p_half_day: false, p_reason: 'Family trip' });
    expect(Number(r.days)).toBe(3);
  });
  it('overlapping requests are refused', async () => {
    await expect(db.rpc(aliceU, 'request_leave', { p_start: '2026-11-24', p_end: '2026-11-24', p_type: 'sick', p_half_day: true, p_reason: 'Doctor' }))
      .rejects.toThrow(/OVERLAP/);
  });
  it('cannot ask for more than the balance', async () => {
    await expect(db.rpc(aliceU, 'request_leave', { p_start: '2026-12-01', p_end: '2026-12-31', p_type: 'earned', p_half_day: false, p_reason: 'Long holiday' }))
      .rejects.toThrow(/INSUFFICIENT_BALANCE/);
  });
  it('employee cannot approve their own leave via the function', async () => {
    const [l] = await db.as(aliceU, `select id from leave_requests`);
    await expect(db.rpc(aliceU, 'admin_decide_leave', { p_id: l.id, p_approve: true })).rejects.toThrow(/admin only/);
  });
  it('approval updates the balance', async () => {
    const [l] = await db.as(aliceU, `select id from leave_requests`);
    await db.rpc(adminU, 'admin_decide_leave', { p_id: l.id, p_approve: true, p_note: 'Enjoy' });
    const [b] = await db.rpc(aliceU, 'leave_balance');
    expect(Number(b.used)).toBe(3);
    expect(Number(b.remaining)).toBe(21);
  });
});

describe('corrections and admin edits', () => {
  it('approved correction rewrites the record with an audited reason', async () => {
    const [c] = await db.rpc(aliceU, 'request_correction', { p_date: '2026-11-16', p_in: '08:45', p_out: null, p_reason: 'App was slow to open' });
    await db.rpc(adminU, 'admin_decide_correction', { p_id: c.id, p_approve: true });
    const [a] = await db.as(aliceU, `select to_char(check_in at time zone 'Asia/Kolkata','HH24:MI') t, source from attendance where work_date='2026-11-16'`);
    expect(a).toEqual({ t: '08:45', source: 'correction' });
  });
  it('admin edits need a reason', async () => {
    await expect(db.rpc(adminU, 'admin_set_attendance', { p_member: aliceId, p_date: '2026-11-16', p_in: '08:00', p_out: null, p_reason: '' }))
      .rejects.toThrow(/REASON_REQUIRED/);
  });
});

describe('audit trail', () => {
  it('chain is intact after all of the above', async () => {
    const [v] = await db.rpc(adminU, 'verify_audit_chain');
    expect(Number(v.entries)).toBeGreaterThan(10);
    expect(v.broken_at).toBeNull();
  });
  it('audit log cannot be edited or deleted, even by the database owner through normal SQL', async () => {
    await expect(db.admin.query(`update audit_log set new_data = '{}' where id = 3`)).rejects.toThrow(/append-only/);
    await expect(db.admin.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
  it('a sneaky edit with triggers disabled is detected', async () => {
    await db.admin.query(`alter table audit_log disable trigger audit_log_no_update`);
    await db.admin.query(`update audit_log set new_data = jsonb_set(new_data, '{check_in}', '"2026-11-16T02:00:00+00:00"') where id = (select min(id) from audit_log where table_name='attendance')`);
    await db.admin.query(`alter table audit_log enable trigger audit_log_no_update`);
    const [v] = await db.rpc(adminU, 'verify_audit_chain');
    expect(v.broken_at).not.toBeNull();
  });
});
