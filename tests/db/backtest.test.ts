import { TestDb } from './harness';
import { defineBacktests } from '../backtest-core';

defineBacktests('PostgreSQL', () => {
  const db = new TestDb();
  return {
    setup: async () => { await db.setup(); }, teardown: () => db.teardown(),
    setClock: async l => { await db.setClock(l); },
    bootstrapAdmin: email => db.signUp(email),
    configure: async (a, s) => { await db.as(a, `update org_settings set weekend_mode=$1, required_minutes=$2, half_day_minutes=$3, annual_leave_days=$4, shift_start='09:30', late_grace_minutes=15`, [s.weekend, s.requiredMin, s.halfMin, s.annual]); },
    addHoliday: async (a, d, n) => { await db.as(a, 'insert into holidays(holiday_date,name) values ($1,$2)', [d, n]); },
    addEmployee: async (a, email, nick) => { const [m] = await db.rpc(a, 'admin_add_member', { p_email: email, p_nickname: nick }); return { id: m.id, user: await db.signUp(email) }; },
    rpc: (u, fn, args) => db.rpc(u, fn, args),
  };
});
