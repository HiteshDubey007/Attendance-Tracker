// Google Sheets + Apps Script backend. Every call is a POST to the Apps Script web app;
// the script checks the session token and applies all rules on Google's server.
import type { Backend, Settings } from './types';

let url = '';
const KEY = 'punchin.token';
const listeners = new Set<(b: boolean) => void>();
const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  listeners.forEach(cb => cb(!!t));
};

export function initGas(scriptUrl: string) { url = scriptUrl; gasBackend.configured = true; }

function human(raw: string): Error {
  const m = raw.match(/^([A-Z_]+):\s*(.*)$/s);
  const msg = m ? m[2] : raw;
  return new Error(msg.charAt(0).toUpperCase() + msg.slice(1));
}

async function call<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    // text/plain keeps this a "simple" request, so the browser needs no CORS pre-check.
    res = await fetch(url, { method: 'POST', redirect: 'follow', body: JSON.stringify({ fn, args, token: getToken() }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
  } catch { throw new Error('No internet connection. Try again.'); }
  let body: any;
  try { body = await res.json(); } catch { throw new Error('The server did not answer properly. Try again in a minute.'); }
  if (!body.ok) {
    if (/^SIGNED_OUT/.test(body.error) && fn !== 'sign_in') setToken(null);
    throw human(body.error);
  }
  return body.data as T;
}
const one = <T,>(x: T[] | T): T => (Array.isArray(x) ? x[0] : x);

export const gasBackend: Backend = {
  configured: false,
  usesCodes: true,
  onAuth(cb) {
    listeners.add(cb);
    const t = getToken();
    if (!t) setTimeout(() => cb(false));
    else call('me').then(() => cb(true)).catch(e => cb(/sign in/i.test(e.message) ? false : true));
    return () => { listeners.delete(cb); };
  },
  async signIn(email, password) { setToken((await call<{ token: string }>('sign_in', { email, password })).token); },
  async signUp(email, password, code) { setToken((await call<{ token: string }>('sign_up', { email, password, code })).token); },
  async resetPassword() { throw new Error('Ask your admin for a new sign-in code, then use “First time / new code”.'); },
  async signOut() { try { await call('sign_out'); } catch { /* already gone */ } setToken(null); },
  me: () => call('me'),
  settings: () => call<Settings>('settings'),
  serverTime: () => call<string>('server_time'),

  punch: (kind, fix) => call(kind === 'in' ? 'punch_in' : 'punch_out', { p_lat: fix?.lat ?? null, p_lng: fix?.lng ?? null, p_accuracy: fix?.accuracy ?? null }),
  days: (member, from, to) => call('member_days', { p_member: member, p_from: from, p_to: to }),
  summary: async (member, from, to) => one(await call('member_summary', { p_member: member, p_from: from, p_to: to })),
  balance: async (member, year) => one(await call('leave_balance', { p_member: member ?? null, p_year: year ?? null })),
  leaves: (member) => call('list', { table: 'leave_requests', member }),
  async requestLeave(start, end, type, half, reason) { await call('request_leave', { p_start: start, p_end: end, p_type: type, p_half_day: half, p_reason: reason }); },
  async cancelLeave(id) { await call('cancel_leave', { p_id: id }); },
  corrections: (member) => call('list', { table: 'correction_requests', member }),
  async requestCorrection(date, i, o, reason) { await call('request_correction', { p_date: date, p_in: i, p_out: o, p_reason: reason }); },
  holidays: () => call('list', { table: 'holidays' }),

  members: () => call('list', { table: 'members' }),
  async addMember(email, nickname, role) { return (await call('admin_add_member', { p_email: email, p_nickname: nickname, p_role: role })).invite_code; },
  async resetCode(id) { return (await call('admin_reset_code', { p_id: id })).invite_code; },
  async updateMember(id, nickname, role, status) { await call('admin_update_member', { p_id: id, p_nickname: nickname, p_role: role, p_status: status }); },
  teamDay: (day) => call('team_day', { p_day: day ?? null }),
  teamTrend: (from, to) => call('team_trend', { p_from: from, p_to: to }),
  attendance: (member, from, to) => call('list', { table: 'attendance', member, from, to }),
  async setAttendance(member, date, i, o, reason) { await call('admin_set_attendance', { p_member: member, p_date: date, p_in: i, p_out: o, p_reason: reason }); },
  async deleteAttendance(id, reason) { await call('admin_delete_attendance', { p_id: id, p_reason: reason }); },
  async decideLeave(id, approve, note) { await call('admin_decide_leave', { p_id: id, p_approve: approve, p_note: note }); },
  async decideCorrection(id, approve, note) { await call('admin_decide_correction', { p_id: id, p_approve: approve, p_note: note }); },
  async addHoliday(date, name) { await call('add_holiday', { date, name }); },
  async deleteHoliday(id) { await call('delete_holiday', { id }); },
  async saveSettings(s) { await call('save_settings', { settings: s }); },
  verifyAudit: async () => one(await call('verify_audit_chain')),
  auditLog: (limit) => call('list', { table: 'audit_log', limit }),
  punchAttempts: (limit) => call('list', { table: 'punch_attempts', limit }),
};
