// Runs the identical six-month back-test against the real gas/Code.js (Google Sheets backend).
import { loadGas } from './shim';
import { defineBacktests } from '../backtest-core';

const ROWS = new Set(['punch_in', 'punch_out']);
const SETS = new Set(['member_days', 'member_summary', 'leave_balance', 'team_trend', 'team_day', 'verify_audit_chain']);

defineBacktests('Google Sheets', () => {
  let g: ReturnType<typeof loadGas>;
  return {
    setup: async () => { g = loadGas(); g.setNowLocal('2025-12-31 10:00'); g.ctx.setup(); },
    teardown: async () => {},
    setClock: async l => g.setNowLocal(l),
    bootstrapAdmin: async email => g.call('sign_up', { email, code: g.props.get('SETUP_CODE'), password: 'admin-pass-123' }).token,
    configure: async (a, s) => { g.call('save_settings', { settings: { weekend_mode: s.weekend, required_minutes: s.requiredMin, half_day_minutes: s.halfMin, annual_leave_days: s.annual, shift_start: '09:30', late_grace_minutes: 15 } }, a); },
    addHoliday: async (a, date, name) => { g.call('add_holiday', { date, name }, a); },
    addEmployee: async (a, email, nick) => {
      const m = g.call('admin_add_member', { p_email: email, p_nickname: nick }, a);
      const { token } = g.call('sign_up', { email, code: m.invite_code, password: 'employee-pass-1' });
      return { id: m.id, user: token };
    },
    rpc: async (u, fn, args = {}) => {
      const r = g.call(fn, args, u);
      if (ROWS.has(fn)) return [{ [fn]: r }];
      if (SETS.has(fn)) return r;
      return r == null ? [] : [r];
    },
  };
});
