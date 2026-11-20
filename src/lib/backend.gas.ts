// Google Sheets + Apps Script backend. Every call is a POST to the Apps Script web app;
// the script checks the session token and applies all rules on Google's server.
import type { Backend, Boot } from './types';

let url = '', org = '';
// Each organisation has its own Google Sheet server. The default one comes from config.json; another office's
// app link carries ?org=<deployment id>. Sign-in tokens are kept per organisation so one office's token is
// never sent to another office's server.
const keyFor = () => (org ? 'punchin.token.' + org : 'punchin.token');
const listeners = new Set<(b: boolean) => void>();
export const getToken = () => { try { return localStorage.getItem(keyFor()); } catch { return null; } };
const setToken = (t: string | null) => {
  try { t ? localStorage.setItem(keyFor(), t) : localStorage.removeItem(keyFor()); } catch { /* private mode */ }
  listeners.forEach(cb => cb(!!t));
};

export const ORG_ID = /^AKfyc[\w-]{20,140}$/;
export function initGas(scriptUrl: string, orgId = '') { url = scriptUrl; org = orgId; gasBackend.configured = true; }
const appBase = () => location.href.split('#')[0].split('?')[0] + (org ? '?org=' + org : '');

function human(raw: string): Error {
  const m = raw.match(/^([A-Z_]+):\s*(.*)$/s);
  const msg = m ? m[2] : raw;
  return new Error(msg.charAt(0).toUpperCase() + msg.slice(1));
}

async function call<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    // text/plain keeps this a "simple" request, so the browser needs no CORS pre-check.
    // credentials: 'omit' — no Google cookies are ever sent; identity is the PunchIn session token only.
    res = await fetch(url, { method: 'POST', redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer',
      body: JSON.stringify({ fn, args, token: getToken() }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
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
const toBase64 = (f: File) => new Promise<string>((ok, bad) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(f);
});

export const gasBackend: Backend = {
  configured: false,
  onAuth(cb) {
    listeners.add(cb);
    setTimeout(() => cb(!!getToken()));
    return () => { listeners.delete(cb); };
  },
  async signIn(email, password) { setToken((await call<{ token: string }>('sign_in', { email, password })).token); },
  async signUp(email, password, code) { setToken((await call<{ token: string }>('sign_up', { email, password, code })).token); },
  async signOut() { try { await call('sign_out'); } catch { /* already gone */ } setToken(null); },
  bootstrap: () => call<Boot | null>('bootstrap', { app_url: appBase() }),
  orgName: async () => (await call<{ org: string | null }>('ping')).org ?? null,
  inviteLink: (e, c) => `${appBase()}#/join?e=${encodeURIComponent(e)}&c=${c}`,
  serverTime: () => call<string>('server_time'),
  notifications: () => call('notifications'),

  punch: (kind, fix, o) => call(kind === 'in' ? 'punch_in' : 'punch_out', { p_lat: fix?.lat ?? null, p_lng: fix?.lng ?? null, p_accuracy: fix?.accuracy ?? null, p_wfh: !!o?.wfh, p_resume: !!o?.resume }),
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
  async updateMember(id, p) {
    const args: Record<string, unknown> = { p_id: id, p_nickname: p.nickname, p_role: p.role, p_status: p.status };
    if ('shift_start' in p) args.p_shift_start = p.shift_start ?? '';
    if ('required_minutes' in p) args.p_required_minutes = p.required_minutes ?? '';
    if ('weekend_mode' in p) args.p_weekend_mode = p.weekend_mode ?? '';
    await call('admin_update_member', args);
  },
  teamDay: (day) => call('team_day', { p_day: day ?? null }),
  teamTrend: (from, to) => call('team_trend', { p_from: from, p_to: to }),
  attendance: (member, from, to) => call('list', { table: 'attendance', member, from, to }),
  async setAttendance(member, date, i, o, reason) { await call('admin_set_attendance', { p_member: member, p_date: date, p_in: i, p_out: o, p_reason: reason }); },
  async deleteAttendance(id, reason) { await call('admin_delete_attendance', { p_id: id, p_reason: reason }); },
  async decideLeave(id, approve, note) { await call('admin_decide_leave', { p_id: id, p_approve: approve, p_note: note }); },
  async decideCorrection(id, approve, note) { await call('admin_decide_correction', { p_id: id, p_approve: approve, p_note: note }); },
  async addHoliday(date, name) { await call('add_holiday', { date, name }); },
  addHolidays: (items) => call('add_holidays_bulk', { items }),
  publicHolidays: (year) => call('public_holidays', { year }),
  async readHolidayFile(file, year) {
    if (file.size > 7 * 1024 * 1024) throw new Error('That file is over 7 MB. Try a smaller PDF or a photo.');
    return (await call('parse_holiday_file', { mime: file.type, data: await toBase64(file), year })).items;
  },
  sendTestAlert: () => call('send_test_alert'),
  async deleteHoliday(id) { await call('delete_holiday', { id }); },
  async saveSettings(s) { await call('save_settings', { settings: s }); },
  verifyAudit: async () => one(await call('verify_audit_chain')),
  auditLog: (limit) => call('list', { table: 'audit_log', limit }),
  punchAttempts: (limit) => call('list', { table: 'punch_attempts', limit }),
};
