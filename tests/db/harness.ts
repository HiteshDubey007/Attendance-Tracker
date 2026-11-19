// Spins up a fresh database per test file on a local PostgreSQL, loads the real schema,
// and lets tests act as a specific signed-in user exactly like Supabase does
// (role "authenticated" + JWT subject), with a controllable server clock.
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const conn = {
  host: process.env.PGHOST ?? '/tmp',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD,
};

export class TestDb {
  admin!: Client;
  name = 't_' + randomUUID().replace(/-/g, '').slice(0, 12);

  async setup() {
    const root = new Client({ ...conn, database: 'postgres' });
    await root.connect();
    await root.query(`create database ${this.name}`);
    await root.end();
    this.admin = new Client({ ...conn, database: this.name });
    await this.admin.connect();
    await this.admin.query(readFileSync('supabase/test-shim.sql', 'utf8'));
    await this.admin.query(readFileSync('supabase/schema.sql', 'utf8'));
    // Test-only clock: lets the back-test replay months of days. Production uses now().
    await this.admin.query(`
      create table public._test_clock (t timestamptz);
      insert into public._test_clock values (null);
      create or replace function public.app_now() returns timestamptz language sql stable
        as $$ select coalesce((select t from public._test_clock), now()) $$;`);
    return this;
  }

  async teardown() {
    await this.admin.end();
    const root = new Client({ ...conn, database: 'postgres' });
    await root.connect();
    await root.query(`drop database if exists ${this.name} with (force)`);
    await root.end();
  }

  /** Set the server clock to an office-local wall time, e.g. '2026-03-02 09:41'. */
  async setClock(local: string | null) {
    if (local === null) return this.admin.query('update public._test_clock set t = null');
    await this.admin.query(
      `update public._test_clock set t = ($1::timestamp at time zone (select timezone from public.org_settings))`, [local]);
  }

  /** Create a Supabase auth user (signup). Throws if the signup gate refuses it. */
  async signUp(email: string): Promise<string> {
    const r = await this.admin.query('insert into auth.users(email) values ($1) returning id', [email]);
    return r.rows[0].id;
  }

  /** Run SQL as a signed-in user, with RLS and privileges enforced. */
  async as<T = any>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = this.admin;
    await c.query('begin');
    try {
      await c.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
      await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      const r = await c.query(sql, params);
      await c.query('commit');
      return r.rows as T[];
    } catch (e) {
      await c.query('rollback');
      throw e;
    }
  }

  rpc<T = any>(userId: string, fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
    const keys = Object.keys(args);
    const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    return this.as<T>(userId, sql, keys.map(k => args[k]));
  }
}
