-- ════════════════════════════════════════════════════════════════════
--  PunchIn — secure attendance database (Supabase / PostgreSQL)
--  Paste this whole file into Supabase → SQL Editor → Run. Safe to run once
--  on a fresh project.
--
--  Security model
--   • Every time stamp comes from the database clock, never from the phone.
--   • Employees cannot write to any table directly. All changes go through
--     the functions below, which check who is calling and what is allowed.
--   • Row-level security: an employee can only read their own records.
--   • Every change to every table is written to an append-only audit log
--     whose rows are SHA-256 hash-chained, so any later edit is detectable.
--
--  Author metadata: PunchIn was developed by Hitesh Dubey.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ───────────── Clock (single source of truth for "now") ─────────────
create or replace function public.app_now() returns timestamptz
language sql stable as $$ select now() $$;

-- ───────────── Tables ─────────────
create table public.org_settings (
  id                   int primary key default 1 check (id = 1),
  company_name         text not null default 'My Company' check (length(company_name) between 1 and 80),
  timezone             text not null default 'Asia/Kolkata',
  required_minutes     int  not null default 540 check (required_minutes between 60 and 960),
  half_day_minutes     int  not null default 270 check (half_day_minutes between 30 and 960),
  weekend_mode         text not null default 'sat_sun' check (weekend_mode in ('sat_sun','sun','none')),
  annual_leave_days    numeric(5,1) not null default 24 check (annual_leave_days between 0 and 365),
  shift_start          time not null default '09:30',
  late_grace_minutes   int  not null default 15 check (late_grace_minutes between 0 and 240),
  geofence_enabled     boolean not null default false,
  office_lat           double precision check (office_lat between -90 and 90),
  office_lng           double precision check (office_lng between -180 and 180),
  geofence_radius_m    int  not null default 150 check (geofence_radius_m between 20 and 5000),
  max_gps_accuracy_m   int  not null default 100 check (max_gps_accuracy_m between 5 and 1000),
  updated_at           timestamptz not null default now(),
  check (not geofence_enabled or (office_lat is not null and office_lng is not null)),
  check (half_day_minutes <= required_minutes)
);
insert into public.org_settings default values;

create table public.members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid unique references auth.users(id) on delete set null,
  email       text not null unique check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  nickname    text not null check (length(btrim(nickname)) between 1 and 40),
  role        text not null default 'employee' check (role in ('admin','employee')),
  status      text not null default 'active' check (status in ('active','blocked','deleted')),
  created_at  timestamptz not null default now()
);

create table public.holidays (
  id            uuid primary key default gen_random_uuid(),
  holiday_date  date not null unique,
  name          text not null check (length(btrim(name)) between 1 and 60)
);

create table public.attendance (
  id               uuid primary key default gen_random_uuid(),
  member_id        uuid not null references public.members(id),
  work_date        date not null,
  check_in         timestamptz not null,
  check_out        timestamptz,
  in_lat double precision,  in_lng double precision,  in_accuracy_m  real, in_distance_m  real,
  out_lat double precision, out_lng double precision, out_accuracy_m real, out_distance_m real,
  source           text not null default 'app' check (source in ('app','admin','correction')),
  edit_reason      text,
  unique (member_id, work_date),
  check (check_out is null or check_out > check_in)
);

create table public.leave_requests (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.members(id),
  start_date  date not null,
  end_date    date not null,
  leave_type  text not null check (leave_type in ('casual','sick','earned','unpaid')),
  half_day    boolean not null default false,
  days        numeric(5,1) not null check (days > 0),
  reason      text not null check (length(btrim(reason)) between 3 and 500),
  status      text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  admin_note  text,
  decided_by  uuid references public.members(id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  check (end_date >= start_date),
  check (not half_day or start_date = end_date)
);

create table public.correction_requests (
  id                   uuid primary key default gen_random_uuid(),
  member_id            uuid not null references public.members(id),
  work_date            date not null,
  requested_check_in   time,
  requested_check_out  time,
  reason               text not null check (length(btrim(reason)) between 3 and 500),
  status               text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note           text,
  decided_by           uuid references public.members(id),
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  check (requested_check_in is not null or requested_check_out is not null)
);

-- Every refused punch is kept so the admin can spot attempts from outside the office.
create table public.punch_attempts (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.members(id),
  attempted_at timestamptz not null default now(),
  kind         text not null check (kind in ('in','out')),
  lat double precision, lng double precision, accuracy_m real, distance_m real,
  reason       text not null
);

create table public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default clock_timestamp(),
  actor       uuid,
  action      text not null,
  table_name  text not null,
  row_id      text,
  old_data    jsonb,
  new_data    jsonb,
  prev_hash   text not null,
  hash        text not null
);

create index on public.attendance (work_date);
create index on public.leave_requests (member_id, status);
create index on public.correction_requests (status);
create index on public.punch_attempts (attempted_at desc);

-- ───────────── Audit log: append-only, hash-chained ─────────────
create or replace function public._audit_hash(p_prev text, p_at timestamptz, p_actor uuid, p_action text,
  p_table text, p_row text, p_old jsonb, p_new jsonb) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(
    coalesce(p_prev,'') || '|' || to_char(p_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    coalesce(p_actor::text,'') || '|' || p_action || '|' || p_table || '|' || coalesce(p_row,'') || '|' ||
    coalesce(p_old::text,'') || '|' || coalesce(p_new::text,''), 'sha256'), 'hex')
$$;

create or replace function public._audit_row() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_prev text; v_at timestamptz := clock_timestamp(); v_old jsonb; v_new jsonb; v_row text; v_actor uuid;
begin
  perform pg_advisory_xact_lock(7340001);                       -- serialise the chain
  select hash into v_prev from public.audit_log order by id desc limit 1;
  v_prev := coalesce(v_prev, 'GENESIS');
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new->>'id', v_old->>'id');
  select id into v_actor from public.members where user_id = auth.uid();
  insert into public.audit_log(at, actor, action, table_name, row_id, old_data, new_data, prev_hash, hash)
  values (v_at, v_actor, lower(tg_op), tg_table_name, v_row, v_old, v_new, v_prev,
          public._audit_hash(v_prev, v_at, v_actor, lower(tg_op), tg_table_name, v_row, v_old, v_new));
  return coalesce(new, old);
end $$;

create or replace function public._audit_immutable() returns trigger
language plpgsql as $$ begin raise exception 'audit_log is append-only'; end $$;

create trigger audit_log_no_update before update or delete or truncate on public.audit_log
  for each statement execute function public._audit_immutable();

do $$ declare t text; begin
  foreach t in array array['org_settings','members','holidays','attendance','leave_requests','correction_requests'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public._audit_row()', 'audit_'||t, t);
  end loop;
end $$;

create or replace function public._settings_validate() returns trigger
language plpgsql as $$
begin
  perform now() at time zone new.timezone;          -- raises on an unknown time zone
  new.updated_at := now();
  new.id := 1;
  return new;
end $$;
create trigger settings_validate before update on public.org_settings for each row execute function public._settings_validate();

-- ───────────── Helpers ─────────────
create or replace function public.current_member() returns public.members
language sql stable security definer set search_path = public as $$
  select * from public.members where user_id = auth.uid() and status = 'active'
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'active' and role = 'admin')
$$;

create or replace function public._require_member() returns public.members
language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  m := public.current_member();
  if m.id is null then raise exception 'NOT_ALLOWED: your account is not active' using errcode = '42501'; end if;
  return m;
end $$;

create or replace function public._require_admin() returns public.members
language plpgsql stable security definer set search_path = public as $$
declare m public.members;
begin
  m := public._require_member();
  if m.role <> 'admin' then raise exception 'NOT_ALLOWED: admin only' using errcode = '42501'; end if;
  return m;
end $$;

create or replace function public.org_today() returns date
language sql stable security definer set search_path = public as $$
  select (public.app_now() at time zone (select timezone from public.org_settings where id = 1))::date
$$;

-- Local (office time-zone) date + time  →  absolute timestamp
create or replace function public._local_ts(d date, t time) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (d + t) at time zone (select timezone from public.org_settings where id = 1)
$$;

create or replace function public.is_weekend(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select case (select weekend_mode from public.org_settings where id = 1)
    when 'sat_sun' then extract(isodow from d) in (6,7)
    when 'sun'     then extract(isodow from d) = 7
    else false end
$$;

create or replace function public.is_working_day(d date) returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_weekend(d) and not exists (select 1 from public.holidays where holiday_date = d)
$$;

create or replace function public.working_days_between(a date, b date) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from generate_series(a, b, interval '1 day') g where public.is_working_day(g::date)
$$;

create or replace function public.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- Geofence check. Returns NULL when allowed, otherwise the refusal reason (and logs the attempt).
create or replace function public._check_location(m public.members, p_kind text, p_lat float8, p_lng float8, p_acc float8, out distance float8, out refusal text)
language plpgsql security definer set search_path = public as $$
declare s public.org_settings;
begin
  select * into s from public.org_settings where id = 1;
  if p_lat is not null and p_lng is not null and s.office_lat is not null
     and p_lat between -90 and 90 and p_lng between -180 and 180 then
    distance := public.distance_m(s.office_lat, s.office_lng, p_lat, p_lng);
  end if;
  if not s.geofence_enabled then return; end if;
  if p_lat is null or p_lng is null or p_acc is null or distance is null then
    refusal := 'LOCATION_REQUIRED: turn on location to punch';
  elsif p_acc <= 0 or p_acc > s.max_gps_accuracy_m then
    refusal := format('LOCATION_INACCURATE: GPS accuracy is %s m, needs %s m or better. Step near a window and retry.', round(p_acc::numeric), s.max_gps_accuracy_m);
  elsif distance > s.geofence_radius_m then
    refusal := format('OUTSIDE_OFFICE: you are %s m from the office (limit %s m)', round(distance::numeric), s.geofence_radius_m);
  end if;
  if refusal is not null then
    insert into public.punch_attempts(member_id, attempted_at, kind, lat, lng, accuracy_m, distance_m, reason)
    values (m.id, public.app_now(), p_kind, p_lat, p_lng, p_acc, distance, refusal);
  end if;
end $$;

-- ───────────── Signup gate (invite-only) ─────────────
create or replace function public._on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(btrim(new.email));
begin
  if not exists (select 1 from public.members) then
    -- very first account becomes the administrator
    insert into public.members(user_id, email, nickname, role) values (new.id, v_email, split_part(v_email,'@',1), 'admin');
    return new;
  end if;
  update public.members set user_id = new.id
   where email = v_email and user_id is null and status <> 'deleted';
  if not found then
    raise exception 'NOT_INVITED: ask your admin to add % first', v_email;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public._on_auth_user_created();

-- ════════════════ Employee functions ════════════════
-- Punch functions return {ok, attendance} or {ok:false, error}. A refused punch is not an
-- exception so that the refused attempt stays recorded for the admin.
create or replace function public.punch_in(p_lat float8 default null, p_lng float8 default null, p_accuracy float8 default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members := public._require_member(); loc record; r public.attendance; today date := public.org_today();
begin
  if exists (select 1 from public.attendance where member_id = m.id and work_date = today) then
    raise exception 'ALREADY_PUNCHED_IN: you already checked in today';
  end if;
  if exists (select 1 from public.leave_requests where member_id = m.id and status = 'approved'
             and not half_day and today between start_date and end_date) and public.is_working_day(today) then
    raise exception 'ON_LEAVE: you are on approved leave today';
  end if;
  select * into loc from public._check_location(m, 'in', p_lat, p_lng, p_accuracy);
  if loc.refusal is not null then return jsonb_build_object('ok', false, 'error', loc.refusal); end if;
  insert into public.attendance(member_id, work_date, check_in, in_lat, in_lng, in_accuracy_m, in_distance_m)
  values (m.id, today, public.app_now(), p_lat, p_lng, p_accuracy, loc.distance) returning * into r;
  return jsonb_build_object('ok', true, 'attendance', to_jsonb(r));
end $$;

create or replace function public.punch_out(p_lat float8 default null, p_lng float8 default null, p_accuracy float8 default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.members := public._require_member(); loc record; r public.attendance;
begin
  select * into r from public.attendance
   where member_id = m.id and check_out is null and check_in > public.app_now() - interval '20 hours'
   order by check_in desc limit 1 for update;
  if r.id is null then raise exception 'NOT_PUNCHED_IN: check in first'; end if;
  select * into loc from public._check_location(m, 'out', p_lat, p_lng, p_accuracy);
  if loc.refusal is not null then return jsonb_build_object('ok', false, 'error', loc.refusal); end if;
  update public.attendance set check_out = public.app_now(), out_lat = p_lat, out_lng = p_lng,
         out_accuracy_m = p_accuracy, out_distance_m = loc.distance
   where id = r.id returning * into r;
  return jsonb_build_object('ok', true, 'attendance', to_jsonb(r));
end $$;

create or replace function public.request_leave(p_start date, p_end date, p_type text, p_half_day boolean, p_reason text)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare m public.members := public._require_member(); v_days numeric; r public.leave_requests; b record;
begin
  if p_end < p_start then raise exception 'BAD_DATES: end date is before start date'; end if;
  if extract(year from p_start) <> extract(year from p_end) then raise exception 'BAD_DATES: split leave that crosses a new year into two requests'; end if;
  if p_start < public.org_today() - 30 then raise exception 'BAD_DATES: leave can be backdated by at most 30 days'; end if;
  if p_half_day and p_start <> p_end then raise exception 'BAD_DATES: a half day must be a single date'; end if;
  v_days := public.working_days_between(p_start, p_end) * case when p_half_day then 0.5 else 1 end;
  if v_days = 0 then raise exception 'NO_WORKING_DAYS: the selected dates are all weekends or holidays'; end if;
  if exists (select 1 from public.leave_requests where member_id = m.id and status in ('pending','approved')
             and daterange(start_date, end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'OVERLAP: you already have leave on some of these dates';
  end if;
  if p_type <> 'unpaid' then
    select * into b from public.leave_balance(m.id, extract(year from p_start)::int);
    if v_days > b.remaining - b.pending then
      raise exception 'INSUFFICIENT_BALANCE: you have % day(s) available', b.remaining - b.pending;
    end if;
  end if;
  insert into public.leave_requests(member_id, start_date, end_date, leave_type, half_day, days, reason)
  values (m.id, p_start, p_end, p_type, p_half_day, v_days, btrim(p_reason)) returning * into r;
  return r;
end $$;

create or replace function public.cancel_leave(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.members := public._require_member();
begin
  update public.leave_requests set status = 'cancelled' where id = p_id and member_id = m.id and status = 'pending';
  if not found then raise exception 'NOT_FOUND: only your own pending requests can be cancelled'; end if;
end $$;

create or replace function public.request_correction(p_date date, p_in time, p_out time, p_reason text)
returns public.correction_requests language plpgsql security definer set search_path = public as $$
declare m public.members := public._require_member(); r public.correction_requests;
begin
  if p_date > public.org_today() then raise exception 'BAD_DATES: cannot correct a future date'; end if;
  if p_date < public.org_today() - 60 then raise exception 'BAD_DATES: corrections are allowed for the last 60 days'; end if;
  if p_in is not null and p_out is not null and p_out <= p_in then raise exception 'BAD_TIMES: check-out must be after check-in'; end if;
  if exists (select 1 from public.correction_requests where member_id = m.id and work_date = p_date and status = 'pending') then
    raise exception 'DUPLICATE: you already have a pending request for this date';
  end if;
  insert into public.correction_requests(member_id, work_date, requested_check_in, requested_check_out, reason)
  values (m.id, p_date, p_in, p_out, btrim(p_reason)) returning * into r;
  return r;
end $$;

-- ════════════════ Reports ════════════════
create or replace function public.leave_balance(p_member uuid default null, p_year int default null)
returns table(annual numeric, used numeric, pending numeric, remaining numeric)
language plpgsql stable security definer set search_path = public as $$
declare m public.members := public._require_member(); v_member uuid := coalesce(p_member, m.id);
        v_year int := coalesce(p_year, extract(year from public.org_today())::int);
begin
  if v_member <> m.id and m.role <> 'admin' then raise exception 'NOT_ALLOWED: admin only' using errcode = '42501'; end if;
  return query
  select s.annual_leave_days,
         coalesce(sum(l.days) filter (where l.status = 'approved'), 0),
         coalesce(sum(l.days) filter (where l.status = 'pending'), 0),
         s.annual_leave_days - coalesce(sum(l.days) filter (where l.status = 'approved'), 0)
    from public.org_settings s
    left join public.leave_requests l on l.member_id = v_member and l.leave_type <> 'unpaid'
         and extract(year from l.start_date) = v_year
   where s.id = 1
   group by s.annual_leave_days;
end $$;

-- One row per day in the range for one member: what happened that day.
create or replace function public.member_days(p_member uuid, p_from date, p_to date)
returns table(day date, kind text, check_in timestamptz, check_out timestamptz, worked_minutes int,
              late boolean, fulfilled boolean, leave_days numeric, holiday text)
language plpgsql stable security definer set search_path = public as $$
declare m public.members := public._require_member(); s public.org_settings;
begin
  if p_member <> m.id and m.role <> 'admin' then raise exception 'NOT_ALLOWED: admin only' using errcode = '42501'; end if;
  if p_to - p_from > 400 then raise exception 'RANGE_TOO_LARGE'; end if;
  select * into s from public.org_settings where id = 1;
  return query
  with days as (select g::date d from generate_series(p_from, least(p_to, public.org_today()), interval '1 day') g),
  x as (
    select d.d, a.check_in ci, a.check_out co,
           case when a.check_out is not null then (extract(epoch from a.check_out - a.check_in)/60)::int end mins,
           h.name hname, public.is_weekend(d.d) wk,
           (select case when l.half_day then 0.5 else 1 end from public.leave_requests l
             where l.member_id = p_member and l.status = 'approved' and d.d between l.start_date and l.end_date
                and public.is_working_day(d.d) limit 1) lv
      from days d
      left join public.attendance a on a.member_id = p_member and a.work_date = d.d
      left join public.holidays h on h.holiday_date = d.d
  )
  select x.d,
    case
      when x.ci is not null and x.co is null and x.d < public.org_today() then 'missing_checkout'
      when x.ci is not null and x.co is null then 'working'
      when x.ci is not null and x.lv = 0.5 then 'half_day_leave'
      when x.ci is not null and x.mins >= s.required_minutes then 'full'
      when x.ci is not null and x.mins >= s.half_day_minutes then 'short'
      when x.ci is not null then 'half_day'
      when x.lv = 1 then 'leave'
      when x.hname is not null then 'holiday'
      when x.wk then 'weekend'
      when x.lv = 0.5 then 'half_day_leave'
      when x.d = public.org_today() then 'not_yet'
      else 'absent' end,
    x.ci, x.co, x.mins,
    x.ci is not null and (x.ci at time zone s.timezone)::time > s.shift_start + make_interval(mins => s.late_grace_minutes),
    x.mins is not null and x.mins >= case when x.lv = 0.5 then s.half_day_minutes else s.required_minutes end,
    coalesce(x.lv, 0), x.hname
  from x order by x.d;
end $$;

-- Totals for a member over a range (used by dashboards and the back-test).
create or replace function public.member_summary(p_member uuid, p_from date, p_to date)
returns table(working_days int, present_days int, fulfilled_days int, unfulfilled_days int, missing_checkout_days int,
              late_days int, leave_days numeric, absent_days int, total_minutes bigint)
language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where public.is_working_day(day))::int,
    count(*) filter (where check_in is not null)::int,
    count(*) filter (where fulfilled)::int,
    count(*) filter (where check_in is not null and not fulfilled and kind <> 'working')::int,
    count(*) filter (where kind = 'missing_checkout')::int,
    count(*) filter (where late)::int,
    coalesce(sum(leave_days),0),
    count(*) filter (where kind = 'absent')::int,
    coalesce(sum(worked_minutes),0)::bigint
  from public.member_days(p_member, p_from, p_to)
$$;

-- Admin: team snapshot for one day
create or replace function public.team_day(p_day date default null)
returns table(member_id uuid, nickname text, email text, kind text, check_in timestamptz, check_out timestamptz, worked_minutes int, late boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_day date;
begin
  perform public._require_admin();
  v_day := coalesce(p_day, public.org_today());
  return query
  select mb.id, mb.nickname, mb.email, d.kind, d.check_in, d.check_out, d.worked_minutes, d.late
    from public.members mb
    cross join lateral public.member_days(mb.id, v_day, v_day) d
   where mb.status = 'active'
   order by mb.nickname;
end $$;

-- Admin: per-day counts for the trend chart
create or replace function public.team_trend(p_from date, p_to date)
returns table(day date, present int, full_days int, on_leave int, absent int, expected int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin();
  return query
  select d.day,
         count(*) filter (where d.check_in is not null)::int,
         count(*) filter (where d.fulfilled)::int,
         count(*) filter (where d.kind = 'leave')::int,
         count(*) filter (where d.kind = 'absent')::int,
         count(*) filter (where public.is_working_day(d.day))::int
    from public.members mb
    cross join lateral public.member_days(mb.id, p_from, p_to) d
   where mb.status = 'active'
   group by d.day order by d.day;
end $$;

-- ════════════════ Admin functions ════════════════
create or replace function public.admin_add_member(p_email text, p_nickname text, p_role text default 'employee')
returns public.members language plpgsql security definer set search_path = public as $$
declare r public.members; v_email text := lower(btrim(p_email));
begin
  perform public._require_admin();
  select * into r from public.members where email = v_email;
  if r.id is not null and r.status <> 'deleted' then raise exception 'EXISTS: % is already a member', v_email; end if;
  if r.id is not null then
    update public.members set status = 'active', nickname = btrim(p_nickname), role = p_role where id = r.id returning * into r;
  else
    insert into public.members(email, nickname, role) values (v_email, btrim(p_nickname), p_role) returning * into r;
    update public.members mm set user_id = u.id from auth.users u where mm.id = r.id and lower(u.email) = v_email returning mm.* into r;
    if r.id is null then select * into r from public.members where email = v_email; end if;
  end if;
  return r;
end $$;

create or replace function public.admin_update_member(p_id uuid, p_nickname text, p_role text, p_status text)
returns public.members language plpgsql security definer set search_path = public as $$
declare me public.members := public._require_admin(); r public.members;
begin
  if p_id = me.id and (p_status <> 'active' or p_role <> 'admin') then
    raise exception 'NOT_ALLOWED: you cannot block, delete or demote yourself';
  end if;
  update public.members set nickname = btrim(p_nickname), role = p_role, status = p_status
   where id = p_id returning * into r;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  if not exists (select 1 from public.members where role = 'admin' and status = 'active') then
    raise exception 'NOT_ALLOWED: at least one active admin is required';
  end if;
  return r;
end $$;

-- Admin sets or fixes a day's times (office local time). Reason is mandatory and audited.
create or replace function public.admin_set_attendance(p_member uuid, p_date date, p_in time, p_out time, p_reason text, p_source text default 'admin')
returns public.attendance language plpgsql security definer set search_path = public as $$
declare r public.attendance; v_in timestamptz; v_out timestamptz;
begin
  perform public._require_admin();
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'REASON_REQUIRED: say why you are changing this record'; end if;
  if p_date > public.org_today() then raise exception 'BAD_DATES: cannot set a future date'; end if;
  select * into r from public.attendance where member_id = p_member and work_date = p_date for update;
  v_in  := case when p_in  is not null then public._local_ts(p_date, p_in)  else r.check_in end;
  v_out := case when p_out is not null then public._local_ts(p_date, p_out) else r.check_out end;
  if v_in is null then raise exception 'BAD_TIMES: a check-in time is required'; end if;
  if v_out is not null and v_out <= v_in then raise exception 'BAD_TIMES: check-out must be after check-in'; end if;
  if v_out is not null and v_out > public.app_now() then raise exception 'BAD_TIMES: check-out cannot be in the future'; end if;
  if r.id is null then
    insert into public.attendance(member_id, work_date, check_in, check_out, source, edit_reason)
    values (p_member, p_date, v_in, v_out, p_source, btrim(p_reason)) returning * into r;
  else
    update public.attendance set check_in = v_in, check_out = v_out, source = p_source, edit_reason = btrim(p_reason)
     where id = r.id returning * into r;
  end if;
  return r;
end $$;

create or replace function public.admin_delete_attendance(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._require_admin();
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  update public.attendance set edit_reason = 'DELETED: ' || btrim(p_reason) where id = p_id;  -- reason lands in audit trail
  delete from public.attendance where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
end $$;

create or replace function public.admin_decide_leave(p_id uuid, p_approve boolean, p_note text default null)
returns public.leave_requests language plpgsql security definer set search_path = public as $$
declare me public.members := public._require_admin(); r public.leave_requests; b record;
begin
  select * into r from public.leave_requests where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  if p_approve then
    if r.status not in ('pending') then raise exception 'NOT_PENDING: this request was already %', r.status; end if;
    if r.leave_type <> 'unpaid' then
      select * into b from public.leave_balance(r.member_id, extract(year from r.start_date)::int);
      if r.days > b.remaining then raise exception 'INSUFFICIENT_BALANCE: only % day(s) left', b.remaining; end if;
    end if;
  else
    if r.status not in ('pending','approved') then raise exception 'NOT_PENDING: this request was already %', r.status; end if;
  end if;
  update public.leave_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = nullif(btrim(coalesce(p_note,'')),''), decided_by = me.id, decided_at = public.app_now()
   where id = p_id returning * into r;
  return r;
end $$;

create or replace function public.admin_decide_correction(p_id uuid, p_approve boolean, p_note text default null)
returns public.correction_requests language plpgsql security definer set search_path = public as $$
declare me public.members := public._require_admin(); r public.correction_requests;
begin
  select * into r from public.correction_requests where id = p_id for update;
  if r.id is null then raise exception 'NOT_FOUND'; end if;
  if r.status <> 'pending' then raise exception 'NOT_PENDING: this request was already %', r.status; end if;
  if p_approve then
    perform public.admin_set_attendance(r.member_id, r.work_date, r.requested_check_in, r.requested_check_out,
      'Correction request: ' || r.reason, 'correction');
  end if;
  update public.correction_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = nullif(btrim(coalesce(p_note,'')),''), decided_by = me.id, decided_at = public.app_now()
   where id = p_id returning * into r;
  return r;
end $$;

-- Checks every link of the audit chain. Returns broken_at = null when intact.
create or replace function public.verify_audit_chain()
returns table(entries bigint, broken_at bigint, last_hash text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare a record; prev text := 'GENESIS'; n bigint := 0;
begin
  perform public._require_admin();
  for a in select * from public.audit_log order by id loop
    n := n + 1;
    if a.prev_hash <> prev or a.hash <> public._audit_hash(a.prev_hash, a.at, a.actor, a.action, a.table_name, a.row_id, a.old_data, a.new_data) then
      return query select n, a.id, a.hash; return;
    end if;
    prev := a.hash;
  end loop;
  return query select n, null::bigint, prev;
end $$;

create or replace function public.server_time() returns timestamptz
language sql stable as $$ select public.app_now() $$;

-- ───────────── Row-level security ─────────────
alter table public.org_settings        enable row level security;
alter table public.members             enable row level security;
alter table public.holidays            enable row level security;
alter table public.attendance          enable row level security;
alter table public.leave_requests      enable row level security;
alter table public.correction_requests enable row level security;
alter table public.punch_attempts      enable row level security;
alter table public.audit_log           enable row level security;

create policy settings_read  on public.org_settings for select to authenticated using ((public.current_member()).id is not null);
create policy settings_write on public.org_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy members_read   on public.members for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy holidays_read  on public.holidays for select to authenticated using ((public.current_member()).id is not null);
create policy holidays_ins   on public.holidays for insert to authenticated with check (public.is_admin());
create policy holidays_del   on public.holidays for delete to authenticated using (public.is_admin());
create policy att_read       on public.attendance for select to authenticated using (member_id = (public.current_member()).id or public.is_admin());
create policy leave_read     on public.leave_requests for select to authenticated using (member_id = (public.current_member()).id or public.is_admin());
create policy corr_read      on public.correction_requests for select to authenticated using (member_id = (public.current_member()).id or public.is_admin());
create policy attempts_read  on public.punch_attempts for select to authenticated using (member_id = (public.current_member()).id or public.is_admin());
create policy audit_read     on public.audit_log for select to authenticated using (public.is_admin());

-- ───────────── Privileges: read via RLS, write only through functions ─────────────
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant select on all tables in schema public to authenticated;
grant update (company_name, timezone, required_minutes, half_day_minutes, weekend_mode, annual_leave_days, shift_start,
              late_grace_minutes, geofence_enabled, office_lat, office_lng, geofence_radius_m, max_gps_accuracy_m, updated_at)
  on public.org_settings to authenticated;
grant insert (holiday_date, name), delete on public.holidays to authenticated;

grant execute on function
  public.app_now(), public.server_time(), public.org_today(), public.is_admin(), public.current_member(),
  public.is_weekend(date), public.is_working_day(date), public.working_days_between(date,date), public.distance_m(float8,float8,float8,float8),
  public.punch_in(float8,float8,float8), public.punch_out(float8,float8,float8),
  public.request_leave(date,date,text,boolean,text), public.cancel_leave(uuid), public.request_correction(date,time,time,text),
  public.leave_balance(uuid,int), public.member_days(uuid,date,date), public.member_summary(uuid,date,date),
  public.team_day(date), public.team_trend(date,date),
  public.admin_add_member(text,text,text), public.admin_update_member(uuid,text,text,text),
  public.admin_set_attendance(uuid,date,time,time,text,text), public.admin_delete_attendance(uuid,text),
  public.admin_decide_leave(uuid,boolean,text), public.admin_decide_correction(uuid,boolean,text),
  public.verify_audit_chain()
to authenticated;
-- Internal helpers stay callable from inside the functions above (they run as owner), not from the app.
