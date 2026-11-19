import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Backend, Settings } from './types';

let sb: SupabaseClient | null = null;

/** Connects with the Supabase URL + public anon key. Safe to be public: all data is protected by row-level security. */
export function initSupabase(url: string, key: string) {
  sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } });
  supabaseBackend.configured = true;
}

const c = () => { if (!sb) throw new Error('App is not connected to a database yet'); return sb; };

/** Turns 'CODE: human message' from the database into the human message. */
function clean(e: any): Error {
  const raw: string = e?.message ?? String(e);
  if (/Database error saving new user/i.test(raw)) return new Error('This email has not been invited. Ask your admin to add you first.');
  if (/Invalid login credentials/i.test(raw)) return new Error('Wrong email or password.');
  if (/Failed to fetch|NetworkError/i.test(raw)) return new Error('No internet connection. Try again.');
  const m = raw.match(/^[A-Z_]+:\s*(.*)$/s);
  return new Error(m ? m[1] : raw);
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await c().rpc(fn, args);
  if (error) throw clean(error);
  return data as T;
}
async function q<T>(p: PromiseLike<{ data: any; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw clean(error);
  return data as T;
}
const one = <T,>(rows: T[] | T): T => (Array.isArray(rows) ? rows[0] : rows);
const num = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v])) as T;

export const supabaseBackend: Backend = {
  configured: false,
  usesCodes: false,
  onAuth(cb) {
    if (!sb) return () => {};
    sb.auth.getSession().then(({ data }) => cb(!!data.session));
    const { data } = sb.auth.onAuthStateChange((_e, s) => cb(!!s));
    return () => data.subscription.unsubscribe();
  },
  async signIn(email, password) { const { error } = await c().auth.signInWithPassword({ email: email.trim().toLowerCase(), password }); if (error) throw clean(error); },
  async signUp(email, password) {
    const { data, error } = await c().auth.signUp({ email: email.trim().toLowerCase(), password, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (error) throw clean(error);
    if (!data.session) throw new Error('Account created. Open the confirmation email, then sign in.');
  },
  async resetPassword(email) { const { error } = await c().auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: location.href.split('#')[0] }); if (error) throw clean(error); },
  async signOut() { await c().auth.signOut(); },
  async me() {
    const { data: u } = await c().auth.getUser();
    if (!u.user) return null;
    const rows = await q<any[]>(c().from('members').select('*').eq('user_id', u.user.id));
    return rows[0] ?? null;
  },
  async settings() { return num(one(await q<Settings[]>(c().from('org_settings').select('*')))); },
  serverTime: () => rpc<string>('server_time'),

  async punch(kind, fix) {
    return rpc(kind === 'in' ? 'punch_in' : 'punch_out', { p_lat: fix?.lat ?? null, p_lng: fix?.lng ?? null, p_accuracy: fix?.accuracy ?? null });
  },
  async days(member, from, to) { return (await rpc<any[]>('member_days', { p_member: member, p_from: from, p_to: to })).map(num); },
  async summary(member, from, to) { return num(one(await rpc<any>('member_summary', { p_member: member, p_from: from, p_to: to }))); },
  async balance(member, year) { return num(one(await rpc<any>('leave_balance', { p_member: member ?? null, p_year: year ?? null }))); },
  async leaves(member) {
    let x = c().from('leave_requests').select('*').order('created_at', { ascending: false });
    if (member) x = x.eq('member_id', member);
    return (await q<any[]>(x)).map(num);
  },
  async requestLeave(start, end, type, half, reason) { await rpc('request_leave', { p_start: start, p_end: end, p_type: type, p_half_day: half, p_reason: reason }); },
  async cancelLeave(id) { await rpc('cancel_leave', { p_id: id }); },
  async corrections(member) {
    let x = c().from('correction_requests').select('*').order('created_at', { ascending: false });
    if (member) x = x.eq('member_id', member);
    return q(x);
  },
  async requestCorrection(date, i, o, reason) { await rpc('request_correction', { p_date: date, p_in: i, p_out: o, p_reason: reason }); },
  holidays: () => q(c().from('holidays').select('*').order('holiday_date')),

  members: () => q(c().from('members').select('*').neq('status', 'deleted').order('nickname')),
  async addMember(email, nickname, role) { await rpc('admin_add_member', { p_email: email, p_nickname: nickname, p_role: role }); return null; },
  async resetCode() { throw new Error('Ask the person to use “Forgot password” on the sign-in screen.'); },
  async updateMember(id, nickname, role, status) { await rpc('admin_update_member', { p_id: id, p_nickname: nickname, p_role: role, p_status: status }); },
  teamDay: (day) => rpc('team_day', { p_day: day ?? null }),
  teamTrend: (from, to) => rpc('team_trend', { p_from: from, p_to: to }),
  attendance: (member, from, to) => q(c().from('attendance').select('*').eq('member_id', member).gte('work_date', from).lte('work_date', to).order('work_date', { ascending: false })),
  async setAttendance(member, date, i, o, reason) { await rpc('admin_set_attendance', { p_member: member, p_date: date, p_in: i, p_out: o, p_reason: reason, p_source: 'admin' }); },
  async deleteAttendance(id, reason) { await rpc('admin_delete_attendance', { p_id: id, p_reason: reason }); },
  async decideLeave(id, approve, note) { await rpc('admin_decide_leave', { p_id: id, p_approve: approve, p_note: note }); },
  async decideCorrection(id, approve, note) { await rpc('admin_decide_correction', { p_id: id, p_approve: approve, p_note: note }); },
  async addHoliday(date, name) { await q(c().from('holidays').insert({ holiday_date: date, name })); },
  async deleteHoliday(id) { await q(c().from('holidays').delete().eq('id', id)); },
  async saveSettings(s) { await q(c().from('org_settings').update(s).eq('id', 1)); },
  async verifyAudit() { return num(one(await rpc<any>('verify_audit_chain'))); },
  auditLog: (limit) => q(c().from('audit_log').select('id,at,actor,action,table_name,row_id,old_data,new_data,hash').order('id', { ascending: false }).limit(limit)),
  punchAttempts: (limit) => q(c().from('punch_attempts').select('*').order('attempted_at', { ascending: false }).limit(limit)),
};
