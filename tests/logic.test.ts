// Unit tests for the app's own calculations, plus cross-checks that the phone-side
// preview math agrees exactly with the database functions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { addDays, countWorkingDays, distanceM, fmtDuration, monthRange, pct, toCsv, dateInTz, hhmmInTz } from '../src/lib/time';
import { TestDb } from './db/harness';

describe('formatting', () => {
  it('durations', () => {
    expect(fmtDuration(0)).toBe('0h 00m'); expect(fmtDuration(545)).toBe('9h 05m'); expect(fmtDuration(null)).toBe('—'); expect(fmtDuration(-4)).toBe('0h 00m');
  });
  it('month ranges incl. leap year', () => {
    expect(monthRange('2028-02')).toEqual(['2028-02-01', '2028-02-29']); expect(monthRange('2026-12')).toEqual(['2026-12-01', '2026-12-31']);
  });
  it('dates cross month/year and DST-free', () => { expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); });
  it('office time zone, not the phone', () => {
    const t = new Date('2026-11-18T19:00:00Z');            // 00:30 next day in India
    expect(dateInTz(t, 'Asia/Kolkata')).toBe('2026-11-19'); expect(hhmmInTz(t.toISOString(), 'Asia/Kolkata')).toBe('00:30');
  });
  it('percent never divides by zero', () => { expect(pct(3, 0)).toBe(0); expect(pct(1, 3)).toBe(33); });
});

describe('CSV export', () => {
  it('quotes commas/quotes and neutralises spreadsheet formulas', () => {
    const csv = toCsv([['Name', 'Note'], ['Rao, A', 'said "hi"'], ['=HYPERLINK("x")', -5]]);
    expect(csv).toBe('Name,Note\r\n"Rao, A","said ""hi"""\r\n"\'=HYPERLINK(""x"")",-5');
  });
});

describe('app math matches the database exactly', () => {
  let db: TestDb, u: string;
  beforeAll(async () => { db = await new TestDb().setup(); u = await db.signUp('a@b.co');
    await db.admin.query(`insert into holidays(holiday_date,name) values ('2026-01-26','R'),('2026-03-04','H'),('2026-08-15','I')`); });
  afterAll(() => db.teardown());

  it('working-day counts for 300 random ranges × 3 weekly-off modes', async () => {
    const hol = new Set(['2026-01-26', '2026-03-04', '2026-08-15']);
    let seed = 42; const r = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (const mode of ['sat_sun', 'sun', 'none'] as const) {
      await db.admin.query('update org_settings set weekend_mode=$1', [mode]);
      for (let i = 0; i < 100; i++) {
        const s = addDays('2026-01-01', Math.floor(r() * 330)); const e = addDays(s, Math.floor(r() * 25));
        const [{ n }] = (await db.admin.query('select working_days_between($1,$2) n', [s, e])).rows;
        expect(countWorkingDays(s, e, mode, hol), `${mode} ${s}..${e}`).toBe(n);
      }
    }
  });
  it('geofence distance agrees within 1 cm', async () => {
    const pts = [[19.1136, 72.8697, 19.1141, 72.8697], [19.1136, 72.8697, 19.076, 72.8777], [28.6139, 77.209, 19.076, 72.8777]];
    for (const [a, b, c, d] of pts) {
      const [{ m }] = (await db.admin.query('select distance_m($1,$2,$3,$4) m', [a, b, c, d])).rows;
      expect(Math.abs(distanceM(a, b, c, d) - m)).toBeLessThan(0.01);
    }
    expect(Math.round(distanceM(19.1136, 72.8697, 19.1141, 72.8697))).toBe(56);
  });
  void u;
});
