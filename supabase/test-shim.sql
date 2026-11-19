-- Minimal stand-in for the parts of Supabase the schema relies on. Used ONLY by the
-- automated tests against a local PostgreSQL; never run this on Supabase.
create schema if not exists auth;
create schema if not exists extensions;
-- roles are shared by every test database, and test files run in parallel
do $$ begin create role anon nologin; exception when duplicate_object or unique_violation then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object or unique_violation then null; end $$;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique not null);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, extensions, public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
