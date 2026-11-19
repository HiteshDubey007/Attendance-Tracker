// Pure helpers (unit-tested in tests/logic.test.ts). All "local" values use the office time zone.

export function dateInTz(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function timeInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)).toUpperCase();
}
export function hhmmInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}
export function fmtDuration(mins: number | null | undefined): string {
  if (mins == null || !isFinite(mins)) return '—';
  const m = Math.max(0, Math.round(mins));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
export function fmtDate(d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', ...opts });
}
export function addDays(d: string, n: number): string {
  const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10);
}
export function monthRange(ym: string): [string, string] {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${ym}-01`, `${ym}-${String(last).padStart(2, '0')}`];
}
/** Working days in [start, end] — mirrors the database's working_days_between(). */
export function countWorkingDays(start: string, end: string, weekend: 'sat_sun' | 'sun' | 'none', holidays: Set<string>): number {
  let n = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const w = new Date(d + 'T12:00:00Z').getUTCDay();
    const off = weekend === 'sat_sun' ? w === 0 || w === 6 : weekend === 'sun' ? w === 0 : false;
    if (!off && !holidays.has(d)) n++;
  }
  return n;
}
export function minutesBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}
/** Great-circle distance in metres — same formula as the database's distance_m(). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}
/** CSV with quoting so names with commas or quotes stay intact in Excel. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map(r => r.map(v => {
    const s = v == null ? '' : String(v);
    const formula = typeof v === 'string' && /^[=+\-@]/.test(s);
    return /[",\n]/.test(s) || formula ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
export function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const KIND_LABEL: Record<string, string> = {
  full: 'Full day', short: 'Short day', half_day: 'Half day', working: 'Working', missing_checkout: 'No check-out',
  leave: 'Leave', half_day_leave: 'Half-day leave', holiday: 'Holiday', weekend: 'Weekend', absent: 'Absent', not_yet: 'Not in yet',
};
export const KIND_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'mute'> = {
  full: 'good', short: 'warn', half_day: 'warn', working: 'info', missing_checkout: 'bad', leave: 'info',
  half_day_leave: 'info', holiday: 'mute', weekend: 'mute', absent: 'bad', not_yet: 'mute',
};

export function getPosition(timeoutMs = 15000): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This device has no location service.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      e => reject(new Error(e.code === 1 ? 'Location permission is off. Allow location for this app in your phone settings.' : 'Could not get your location. Move near a window and try again.')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 });
  });
}
