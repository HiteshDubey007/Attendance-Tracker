// BACK-TEST: replays six months of office life for a team, day by day, through the real
// database functions (check-ins, forgotten check-outs, late arrivals, weekend work, leave
// requests, approvals, rejections, half days, corrections, admin edits, holidays).
// An independent reference model written here in plain TypeScript tracks what *should*
// happen. At the end every monthly report and every leave balance from the database must
// match the reference exactly, and the audit chain must verify.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestDb } from './harness';

type Rec = { in: number; out: number | null };            // minutes since local midnight
type Leave = { start: string; end: string; half: boolean; days: number; type: string; status: 'approved' | 'rejected' };

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dow = (s: string) => new Date(s + 'T00:00:00Z').getUTCDay();   // 0 Sun … 6 Sat
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const HOLIDAYS: Record<string, string> = {
  '2026-01-26': 'Republic Day', '2026-03-04': 'Holi', '2026-03-21': 'Eid al-Fitr (Sat)',
  '2026-04-03': 'Good Friday', '2026-05-01': 'Maharashtra Day',
};

interface Scenario { name: string; seed: number; weekend: 'sat_sun' | 'sun'; requiredMin: number; halfMin: number; annual: number; employees: number }
const SCENARIOS: Scenario[] = [
  { name: '5-day week, 9 h days', seed: 20260101, weekend: 'sat_sun', requiredMin: 540, halfMin: 270, annual: 24, employees: 10 },
  { name: '6-day week (Sunday off), 8 h days', seed: 777, weekend: 'sun', requiredMin: 480, halfMin: 240, annual: 12, employees: 8 },
];

for (const sc of SCENARIOS) describe(`back-test: ${sc.name}, Jan–Jun 2026`, () => {
  const db = new TestDb();
  const rand = rng(sc.seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const START = '2026-01-01', END = '2026-06-30';
  let adminU = '';
  const people: { id: string; user: string; punctual: number; diligence: number }[] = [];
  const recs = new Map<string, Map<string, Rec>>();          // member → date → record
  const leaves = new Map<string, Leave[]>();
  const stats = { punches: 0, refusedLeaves: 0, approvedLeaves: 0, rejectedLeaves: 0, corrections: 0, forgot: 0, adminEdits: 0, weekendWork: 0 };

  const isWeekend = (d: string) => sc.weekend === 'sat_sun' ? [0, 6].includes(dow(d)) : dow(d) === 0;
  const isWorking = (d: string) => !isWeekend(d) && !HOLIDAYS[d];
  const leaveOn = (m: string, d: string) => isWorking(d)
    ? leaves.get(m)!.find(l => l.status === 'approved' && d >= l.start && d <= l.end) : undefined;
  const usedDays = (m: string) => leaves.get(m)!.filter(l => l.status === 'approved' && l.type !== 'unpaid').reduce((s, l) => s + l.days, 0);

  beforeAll(async () => {
    await db.setup();
    await db.setClock('2025-12-31 10:00');
    adminU = await db.signUp('hr@office.in');
    await db.as(adminU, `update org_settings set weekend_mode=$1, required_minutes=$2, half_day_minutes=$3, annual_leave_days=$4, shift_start='09:30', late_grace_minutes=15`,
      [sc.weekend, sc.requiredMin, sc.halfMin, sc.annual]);
    for (const [d, n] of Object.entries(HOLIDAYS)) await db.as(adminU, 'insert into holidays(holiday_date,name) values ($1,$2)', [d, n]);
    for (let i = 0; i < sc.employees; i++) {
      const email = `emp${i}@office.in`;
      const [m] = await db.rpc(adminU, 'admin_add_member', { p_email: email, p_nickname: `Emp ${i}` });
      const user = await db.signUp(email);
      people.push({ id: m.id, user, punctual: 0.4 + rand() * 0.6, diligence: 0.4 + rand() * 0.6 });
      recs.set(m.id, new Map()); leaves.set(m.id, []);
    }

    for (let day = START; day <= END; day = addDays(day, 1)) {
      // 1) some people ask for future leave in the morning; admin decides immediately
      await db.setClock(`${day} 08:00`);
      for (const p of people) {
        if (rand() > 0.025) continue;
        const start = addDays(day, 1 + Math.floor(rand() * 20));
        const half = rand() < 0.25;
        const end = half ? start : addDays(start, Math.floor(rand() * 4));
        const type = pick(['casual', 'sick', 'earned', 'casual', 'unpaid']);
        const sameYear = start.slice(0, 4) === end.slice(0, 4);
        let wd = 0; for (let d = start; d <= end; d = addDays(d, 1)) if (isWorking(d)) wd++;
        const days = wd * (half ? 0.5 : 1);
        const overlap = leaves.get(p.id)!.some(l => l.status === 'approved' && !(end < l.start || start > l.end));
        const pendingOk = type === 'unpaid' || days <= sc.annual - usedDays(p.id);
        const shouldAccept = sameYear && days > 0 && !overlap && pendingOk;
        let id: string | undefined;
        try {
          const [r] = await db.rpc(p.user, 'request_leave', { p_start: start, p_end: end, p_type: type, p_half_day: half, p_reason: 'Back-test leave' });
          id = r.id; expect(Number(r.days)).toBe(days);
        } catch (e: any) {
          expect(shouldAccept, `leave ${start}..${end} refused: ${e.message}`).toBe(false);
          stats.refusedLeaves++; continue;
        }
        expect(shouldAccept, `leave ${start}..${end} accepted but reference refuses`).toBe(true);
        const approve = rand() < 0.8;
        await db.rpc(adminU, 'admin_decide_leave', { p_id: id, p_approve: approve });
        leaves.get(p.id)!.push({ start, end, half, days, type, status: approve ? 'approved' : 'rejected' });
        approve ? stats.approvedLeaves++ : stats.rejectedLeaves++;
      }

      // 2) yesterday's forgotten check-outs: some file a correction, admin approves
      const yesterday = addDays(day, -1);
      for (const p of people) {
        const r = recs.get(p.id)!.get(yesterday);
        if (!r || r.out !== null || rand() > 0.6) continue;
        const out = r.in + 480 + Math.floor(rand() * 90);
        const [c] = await db.rpc(p.user, 'request_correction', { p_date: yesterday, p_in: null, p_out: hhmm(out), p_reason: 'Forgot to check out' });
        await db.rpc(adminU, 'admin_decide_correction', { p_id: c.id, p_approve: true });
        r.out = out; stats.corrections++;
      }

      // 3) the working day itself, in time order
      const events: { t: number; p: typeof people[0]; kind: 'in' | 'out' }[] = [];
      for (const p of people) {
        const lv = leaveOn(p.id, day);
        if (lv && !lv.half) continue;
        if (!isWorking(day)) { if (rand() < 0.03) { stats.weekendWork++; } else continue; }
        else if (rand() > 0.93 + p.diligence * 0.06) continue;                       // unplanned absence
        const tin = 9 * 60 + Math.floor((rand() - p.punctual * 0.6) * 75) + 10;        // ~08:25 → 10:25
        const len = lv?.half ? 240 + Math.floor(rand() * 90)
          : Math.floor(sc.requiredMin * (0.82 + p.diligence * 0.22 + (rand() - 0.5) * 0.2));
        events.push({ t: tin, p, kind: 'in' });
        if (rand() < 0.03) { stats.forgot++; continue; }
        events.push({ t: Math.min(tin + len, 23 * 60 + 50), p, kind: 'out' });
      }
      events.sort((a, b) => a.t - b.t);
      for (const ev of events) {
        await db.setClock(`${day} ${hhmm(ev.t)}`);
        const [res] = await db.rpc(ev.p.user, ev.kind === 'in' ? 'punch_in' : 'punch_out');
        const out = res[`punch_${ev.kind}`];
        expect(out.ok).toBe(true);
        stats.punches++;
        if (ev.kind === 'in') recs.get(ev.p.id)!.set(day, { in: ev.t, out: null });
        else recs.get(ev.p.id)!.get(day)!.out = ev.t;
      }

      // 4) occasionally the admin fixes a check-in that was keyed late (with a reason)
      if (rand() < 0.05) {
        const p = pick(people); const r = recs.get(p.id)!.get(day);
        if (r && r.out !== null) {
          await db.setClock(`${day} 23:55`);
          r.in = Math.max(0, r.in - 15);
          await db.rpc(adminU, 'admin_set_attendance', { p_member: p.id, p_date: day, p_in: hhmm(r.in), p_out: null, p_reason: 'Biometric showed earlier entry' });
          stats.adminEdits++;
        }
      }
    }
    await db.setClock('2026-07-01 10:00');
  }, 600_000);
  afterAll(() => db.teardown());

  it('simulation exercised every path', () => {
    console.log(`[${sc.name}]`, stats);
    for (const k of ['punches', 'approvedLeaves', 'rejectedLeaves', 'corrections', 'forgot', 'adminEdits', 'weekendWork'] as const)
      expect(stats[k], k).toBeGreaterThan(0);
  });

  it('every monthly report matches the reference model', async () => {
    let compared = 0;
    for (const p of people) for (let mo = 1; mo <= 6; mo++) {
      const from = `2026-0${mo}-01`; const to = addDays(mo === 6 ? '2026-07-01' : `2026-0${mo + 1}-01`, -1);
      const exp = { working_days: 0, present_days: 0, fulfilled_days: 0, unfulfilled_days: 0, missing_checkout_days: 0, late_days: 0, leave_days: 0, absent_days: 0, total_minutes: 0 };
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const r = recs.get(p.id)!.get(d); const lv = leaveOn(p.id, d);
        if (isWorking(d)) exp.working_days++;
        if (lv) exp.leave_days += lv.half ? 0.5 : 1;
        if (!r) { if (isWorking(d) && !lv) exp.absent_days++; continue; }
        exp.present_days++;
        if (r.in > 9 * 60 + 45) exp.late_days++;
        if (r.out === null) { exp.missing_checkout_days++; exp.unfulfilled_days++; continue; }
        const mins = r.out - r.in; exp.total_minutes += mins;
        if (mins >= (lv?.half ? sc.halfMin : sc.requiredMin)) exp.fulfilled_days++; else exp.unfulfilled_days++;
      }
      const [got] = await db.rpc(adminU, 'member_summary', { p_member: p.id, p_from: from, p_to: to });
      const norm = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, Number(v)]));
      expect(norm, `${p.id} month ${mo}`).toEqual(exp);
      compared++;
    }
    expect(compared).toBe(people.length * 6);
  });

  it('every leave balance matches', async () => {
    for (const p of people) {
      const [b] = await db.rpc(adminU, 'leave_balance', { p_member: p.id, p_year: 2026 });
      expect(Number(b.used)).toBe(usedDays(p.id));
      expect(Number(b.remaining)).toBe(sc.annual - usedDays(p.id));
      expect(Number(b.remaining)).toBeGreaterThanOrEqual(0);
    }
  });

  it('team trend adds up to the individual reports', async () => {
    const trend = await db.rpc(adminU, 'team_trend', { p_from: '2026-03-01', p_to: '2026-03-31' });
    const present = trend.reduce((s, r) => s + r.present, 0);
    let exp = 0;
    for (const p of people) for (let d = '2026-03-01'; d <= '2026-03-31'; d = addDays(d, 1)) if (recs.get(p.id)!.get(d)) exp++;
    // the admin account is also an active member but never punches in this simulation
    expect(present).toBe(exp);
  });

  it('audit chain over the whole half-year verifies', async () => {
    const [v] = await db.rpc(adminU, 'verify_audit_chain');
    expect(v.broken_at).toBeNull();
    expect(Number(v.entries)).toBeGreaterThan(stats.punches);
  });
});
