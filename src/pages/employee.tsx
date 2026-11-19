import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { backend } from '@backend';
import { useApp } from '../App';
import type { Day, LeaveType } from '../lib/types';
import { addDays, countWorkingDays, fmtDate, fmtDuration, getPosition, hhmmInTz, minutesBetween, monthRange, pct, timeInTz } from '../lib/time';
import { Busy, C, Donut, Empty, Icon, Modal, Pill, Seg, StatusPill, useLoad, useToast } from '../ui';

export function Top({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return <header className="top"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>{children && <div className="row">{children}</div>}</header>;
}

/** Ticking clock aligned to the server (so the dial never trusts a wrong phone clock). */
function useServerNow() {
  const [offset, setOffset] = useState(0); const [now, setNow] = useState(Date.now());
  useEffect(() => { const t0 = Date.now(); backend.serverTime().then(s => setOffset(new Date(s).getTime() - (t0 + Date.now()) / 2)).catch(() => {}); }, []);
  useEffect(() => { const h = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(h); }, []);
  return new Date(now + offset);
}

function greeting(h: number) { return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; }

// ═════════════ Today ═════════════
export function TodayPage() {
  const { me, settings, today } = useApp(); const tz = settings.timezone; const toast = useToast();
  const now = useServerNow();
  const weekStart = addDays(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const [from, to] = monthRange(today.slice(0, 7));
  const week = useLoad(() => backend.days(me.id, weekStart, addDays(weekStart, 6)), [me.id, weekStart]);
  const month = useLoad(() => backend.summary(me.id, from, to), [me.id, from]);
  const bal = useLoad(() => backend.balance(), [me.id]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);

  const d: Day | undefined = week.data?.find(x => x.day === today);
  const working = !!d?.check_in && !d?.check_out;
  const done = !!d?.check_out;
  const worked = d?.check_in ? (d.check_out ? minutesBetween(d.check_in, d.check_out) : minutesBetween(d.check_in, now.toISOString())) : 0;
  const target = d?.kind === 'half_day_leave' ? settings.half_day_minutes : settings.required_minutes;
  const progress = Math.min(1, worked / target);
  const leftMin = Math.max(0, target - worked);

  async function punch() {
    setBusy(true); setErr(null);
    try {
      let fix = null;
      if (settings.geofence_enabled) fix = await getPosition();
      const r = await backend.punch(working ? 'out' : 'in', fix);
      if (!r.ok) setErr(r.error ?? 'Punch refused');
      else { toast(working ? 'Checked out. See you tomorrow.' : 'Checked in. Have a good day.'); week.reload(); month.reload(); }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }

  const R = 46, CIRC = 2 * Math.PI * R;
  const offDay = d && ['weekend', 'holiday', 'leave'].includes(d.kind) && !d.check_in;
  const s = month.data;
  return <>
    <Top title={`${greeting(Number(hhmmInTz(now.toISOString(), tz).slice(0, 2)))}, ${me.nickname}`}
      sub={new Date(today + 'T12:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })} />
    <div className="page">
      <div className="grid g-today">
        <section className="card dial-card" aria-label="Today's punch">
          <div className="clock">Office time <b className="num">{timeInTz(now.toISOString(), tz)}</b></div>
          <div className="dial">
            <svg viewBox="0 0 100 100" aria-hidden>
              <circle cx="50" cy="50" r={R} fill="none" stroke={C.canvas} strokeWidth="7" />
              <circle className="ring-fill" cx="50" cy="50" r={R} fill="none" stroke={progress >= 1 ? C.good : C.orange} strokeWidth="7" strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - progress)} />
            </svg>
            <div className="center">
              {done
                ? <div className="punch done" role="img" aria-label={`Worked ${fmtDuration(worked)}`}><span className="big num">{fmtDuration(worked)}</span><span className="sm">{progress >= 1 ? 'Target met' : `${fmtDuration(leftMin)} short`}</span></div>
                : <button className={`punch ${working ? 'out' : ''}`} onClick={punch} disabled={busy || !week.data}>
                    <span className="big">{busy ? (settings.geofence_enabled ? 'Locating…' : '…') : working ? 'Check out' : 'Check in'}</span>
                    <span className="sm num">{working ? `${fmtDuration(worked)} so far` : offDay ? (d!.holiday ?? (d!.kind === 'leave' ? 'On leave' : 'Day off')) : 'Tap to start'}</span>
                  </button>}
            </div>
          </div>
          <div className="dial-meta num">
            <div><b>{timeInTz(d?.check_in, tz)}</b>In</div>
            <div><b>{timeInTz(d?.check_out, tz)}</b>Out</div>
            <div><b>{Math.round(progress * 100)}%</b>of {settings.required_minutes / 60}h</div>
          </div>
          {err && <div className="note bad" style={{ marginTop: 14, position: 'relative' }} role="alert"><Icon n="alert" />{err}</div>}
          {settings.geofence_enabled && !err && <div className="geo-note"><Icon n="pin" />Checks your location against the office</div>}
          {working && leftMin > 0 && <p className="small muted" style={{ marginTop: 6, position: 'relative' }}>Target reached at about {timeInTz(new Date(now.getTime() + leftMin * 60000).toISOString(), tz)}</p>}
        </section>

        <div className="grid" style={{ alignContent: 'start' }}>
          <section className="card">
            <h2>This week <small>{fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}</small></h2>
            <div className="week">
              {(week.data ?? []).concat(Array.from({ length: 7 - (week.data?.length ?? 0) }, (_, i) => ({ day: addDays(weekStart, (week.data?.length ?? 0) + i) } as Day))).map(w => {
                const mins = w.worked_minutes ?? (w.day === today && w.check_in ? worked : 0);
                return <div key={w.day} className={`wd ${w.day === today ? 'today' : ''} ${['weekend', 'holiday'].includes(w.kind) ? 'off' : ''}`} title={w.kind}>
                  <div className="n">{new Date(w.day + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)}</div>
                  <div className="d">{Number(w.day.slice(8))}</div>
                  <div className="bar"><i style={{ width: `${Math.min(100, (mins / settings.required_minutes) * 100)}%`, background: w.kind === 'full' ? C.good : undefined }} /></div>
                  <div className="h num">{mins ? (mins / 60).toFixed(1) : w.kind === 'leave' ? 'L' : w.kind === 'holiday' ? 'H' : '–'}</div>
                </div>;
              })}
            </div>
          </section>
          <section className="card">
            <h2>{new Date(today + 'T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })} so far <Link to="/history" className="small" style={{ color: 'var(--orange-ink)' }}>Details</Link></h2>
            <div className="donut-wrap">
              <Donut size={150} parts={[{ label: 'Met target', value: s?.fulfilled_days ?? 0, color: C.orange }, { label: 'Below target', value: s?.unfulfilled_days ?? 0, color: C.orangeSoft }]}
                center={<div><div className="display num" style={{ fontSize: 28, fontWeight: 800 }}>{pct(s?.fulfilled_days ?? 0, (s?.fulfilled_days ?? 0) + (s?.unfulfilled_days ?? 0))}%</div><div className="small muted">days on target</div></div>} />
              <div className="legend num">
                <div><i style={{ background: C.orange }} />Met {settings.required_minutes / 60}h<b>{s?.fulfilled_days ?? '–'}</b></div>
                <div><i style={{ background: C.orangeSoft }} />Below target<b>{s?.unfulfilled_days ?? '–'}</b></div>
                <div><i style={{ background: C.line }} />Late arrivals<b>{s?.late_days ?? '–'}</b></div>
                <div><i style={{ background: C.line }} />Leave left<b>{bal.data?.remaining ?? '–'}</b></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </>;
}

// ═════════════ History ═════════════
export function DayRow({ d, tz, onFix }: { d: Day; tz: string; onFix?: () => void }) {
  return (
    <div className="item">
      <div className="datechip"><b>{Number(d.day.slice(8))}</b><small>{new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</small></div>
      <div className="grow">
        <div className="ttl num">{d.check_in ? `${timeInTz(d.check_in, tz)} → ${timeInTz(d.check_out, tz)}` : d.holiday ?? (d.kind === 'weekend' ? 'Weekend' : '—')}</div>
        <div className="sub num">{d.worked_minutes != null ? fmtDuration(d.worked_minutes) : ''}{d.late && <> · <span className="tag">Late</span></>}</div>
      </div>
      <div className="right row" style={{ gap: 8 }}>
        <Pill kind={d.kind} />
        {onFix && ['missing_checkout', 'short', 'half_day', 'absent'].includes(d.kind) && <button className="btn ghost sm" onClick={onFix}>Fix</button>}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const { me, settings, today } = useApp(); const nav = useNavigate();
  const [ym, setYm] = useState(today.slice(0, 7));
  const [from, to] = monthRange(ym);
  const days = useLoad(() => backend.days(me.id, from, to), [me.id, ym]);
  const sum = useLoad(() => backend.summary(me.id, from, to), [me.id, ym]);
  const [showOff, setShowOff] = useState(false);
  const s = sum.data;
  const list = (days.data ?? []).slice().reverse().filter(d => showOff || !['weekend', 'holiday'].includes(d.kind) || d.check_in);
  return <>
    <Top title="History" sub="Your check-ins, hours and day status"><input className="input" type="month" value={ym} max={today.slice(0, 7)} onChange={e => e.target.value && setYm(e.target.value)} style={{ width: 170 }} aria-label="Month" /></Top>
    <div className="page">
      <div className="stats num">
        <div className="stat hot"><div className="v">{s ? fmtDuration(s.total_minutes).replace(/ \d+m$/, '') : '–'}<small>h</small></div><div className="l">Hours worked</div></div>
        <div className="stat"><div className="v">{s?.fulfilled_days ?? '–'}<small>/{s?.present_days ?? '–'}</small></div><div className="l">Days on target</div></div>
        <div className="stat"><div className="v">{s?.late_days ?? '–'}</div><div className="l">Late arrivals</div></div>
        <div className="stat"><div className="v">{s?.leave_days ?? '–'}</div><div className="l">Leave days</div></div>
        <div className="stat"><div className="v">{s?.absent_days ?? '–'}</div><div className="l">Absent</div></div>
      </div>
      <section className="card">
        <h2>Days <label className="check small" style={{ margin: 0 }}><input type="checkbox" checked={showOff} onChange={e => setShowOff(e.target.checked)} />Show weekends & holidays</label></h2>
        {days.error && <div className="note bad">{days.error}</div>}
        {list.length ? <div className="list">{list.map(d => <DayRow key={d.day} d={d} tz={settings.timezone} onFix={() => nav(`/fixes?date=${d.day}`)} />)}</div>
          : !days.loading && <Empty title="Nothing here yet">No working days recorded for this month.</Empty>}
      </section>
    </div>
  </>;
}

// ═════════════ Leave ═════════════
const LEAVE_LABEL: Record<LeaveType, string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', unpaid: 'Unpaid' };

export function LeavePage() {
  const { me, today } = useApp(); const toast = useToast();
  const leaves = useLoad(() => backend.leaves(me.id), [me.id]);
  const bal = useLoad(() => backend.balance(), [me.id]);
  const [f, setF] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [open, setOpen] = useState(false);
  const b = bal.data;
  const shown = (leaves.data ?? []).filter(l => f === 'all' || l.status === f);
  return <>
    <Top title="Leave" sub={`${new Date().getFullYear()} balance and requests`}><button className="btn primary" onClick={() => setOpen(true)}><Icon n="plus" />Apply for leave</button></Top>
    <div className="page">
      <div className="stats num">
        <div className="stat hot"><div className="v">{b?.remaining ?? '–'}</div><div className="l">Days remaining</div></div>
        <div className="stat"><div className="v">{b?.used ?? '–'}</div><div className="l">Used (approved)</div></div>
        <div className="stat"><div className="v">{b?.pending ?? '–'}</div><div className="l">Waiting for approval</div></div>
        <div className="stat"><div className="v">{b?.annual ?? '–'}</div><div className="l">Yearly allowance</div></div>
      </div>
      {b && <div className="progress" aria-label="Leave used"><i style={{ width: `${pct(b.used, b.annual)}%` }} /></div>}
      <section className="card">
        <h2>Requests <Seg value={f} onChange={setF} options={[['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']]} /></h2>
        {shown.length ? <div className="list">{shown.map(l => (
          <div className="item" key={l.id}>
            <div className="grow">
              <div className="ttl">{fmtDate(l.start_date)}{l.end_date !== l.start_date && ` – ${fmtDate(l.end_date)}`} · {l.half_day ? 'Half day' : `${l.days} day${l.days === 1 ? '' : 's'}`}</div>
              <div className="sub">{LEAVE_LABEL[l.leave_type]} · {l.reason}{l.admin_note && <> · <b>Admin:</b> {l.admin_note}</>}</div>
            </div>
            <div className="right row" style={{ gap: 8 }}>
              <StatusPill s={l.status} />
              {l.status === 'pending' && <Busy className="btn ghost sm" run={async () => { await backend.cancelLeave(l.id); toast('Request withdrawn'); leaves.reload(); bal.reload(); }}>Withdraw</Busy>}
            </div>
          </div>))}</div> : !leaves.loading && <Empty title="No requests">Tap “Apply for leave” to send one to your admin.</Empty>}
      </section>
    </div>
    {open && <LeaveForm today={today} onClose={() => setOpen(false)} onDone={() => { setOpen(false); leaves.reload(); bal.reload(); toast('Leave request sent to your admin'); }} />}
  </>;
}

function LeaveForm({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => void }) {
  const [start, setStart] = useState(addDays(today, 1)); const [end, setEnd] = useState(addDays(today, 1));
  const [type, setType] = useState<LeaveType>('casual'); const [half, setHalf] = useState(false); const [reason, setReason] = useState('');
  const { settings } = useApp();
  const hol = useLoad(() => backend.holidays(), []);
  const n = hol.data && end >= start ? countWorkingDays(start, half ? start : end, settings.weekend_mode, new Set(hol.data.map(h => h.holiday_date))) * (half ? 0.5 : 1) : null;
  return (
    <Modal title="Apply for leave" lede="Weekends and office holidays inside your dates are not counted." onClose={onClose}>
      <div className="two">
        <label className="field"><span>From</span><input className="input" type="date" min={addDays(today, -30)} value={start} onChange={e => { setStart(e.target.value); if (end < e.target.value || half) setEnd(e.target.value); }} /></label>
        <label className="field"><span>To</span><input className="input" type="date" min={start} value={half ? start : end} disabled={half} onChange={e => setEnd(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={half} onChange={e => { setHalf(e.target.checked); setEnd(start); }} />Half day only</label>
      <label className="field"><span>Type</span>
        <select className="input" value={type} onChange={e => setType(e.target.value as LeaveType)}>
          {Object.entries(LEAVE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}{v === 'unpaid' ? ' (not deducted from balance)' : ''}</option>)}
        </select></label>
      <label className="field"><span>Reason</span><textarea className="input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="A short note for your admin" /></label>
      {n !== null && <div className="note info" style={{ marginBottom: 14 }}>{n === 0 ? 'These dates are all weekends or holidays — nothing to apply for.' : `${n} working day${n === 1 ? '' : 's'} will be counted${type === 'unpaid' ? ' as unpaid' : ' from your balance'}.`}</div>}
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Busy run={async () => { await backend.requestLeave(start, half ? start : end, type, half, reason); onDone(); }} disabled={reason.trim().length < 3}>Send request</Busy>
      </div>
    </Modal>
  );
}

// ═════════════ Fixes (correction requests) ═════════════
export function FixesPage() {
  const { me, today } = useApp(); const toast = useToast(); const loc = useLocation();
  const pre = new URLSearchParams(loc.search).get('date');
  const list = useLoad(() => backend.corrections(me.id), [me.id]);
  const [open, setOpen] = useState(!!pre);
  return <>
    <Top title="Fixes" sub="Ask your admin to correct a check-in or check-out"><button className="btn primary" onClick={() => setOpen(true)}><Icon n="plus" />Request a fix</button></Top>
    <div className="page">
      <section className="card">
        <h2>Your requests</h2>
        {list.data?.length ? <div className="list">{list.data.map(c => (
          <div className="item" key={c.id}>
            <div className="datechip"><b>{Number(c.work_date.slice(8))}</b><small>{fmtDate(c.work_date, { month: 'short' })}</small></div>
            <div className="grow">
              <div className="ttl num">{c.requested_check_in && `In ${c.requested_check_in.slice(0, 5)}`}{c.requested_check_in && c.requested_check_out && ' · '}{c.requested_check_out && `Out ${c.requested_check_out.slice(0, 5)}`}</div>
              <div className="sub">{c.reason}{c.admin_note && <> · <b>Admin:</b> {c.admin_note}</>}</div>
            </div>
            <StatusPill s={c.status} />
          </div>))}</div> : !list.loading && <Empty title="No fix requests">Forgot to check out? Request a fix and your admin will review it.</Empty>}
      </section>
    </div>
    {open && <FixForm today={today} date={pre ?? today} onClose={() => setOpen(false)} onDone={() => { setOpen(false); list.reload(); toast('Fix request sent'); }} />}
  </>;
}

function FixForm({ today, date: d0, onClose, onDone }: { today: string; date: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(d0); const [tin, setIn] = useState(''); const [tout, setOut] = useState(''); const [reason, setReason] = useState('');
  return (
    <Modal title="Request a fix" lede="Fill only the time that is wrong or missing. Times are office local time." onClose={onClose}>
      <label className="field"><span>Date</span><input className="input" type="date" max={today} min={addDays(today, -60)} value={date} onChange={e => setDate(e.target.value)} /></label>
      <div className="two">
        <label className="field"><span>Correct check-in</span><input className="input" type="time" value={tin} onChange={e => setIn(e.target.value)} /></label>
        <label className="field"><span>Correct check-out</span><input className="input" type="time" value={tout} onChange={e => setOut(e.target.value)} /></label>
      </div>
      <label className="field"><span>What happened</span><textarea className="input" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Phone battery died before I could check out" /></label>
      <div className="row end">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <Busy run={async () => { await backend.requestCorrection(date, tin || null, tout || null, reason); onDone(); }} disabled={(!tin && !tout) || reason.trim().length < 3}>Send request</Busy>
      </div>
    </Modal>
  );
}

// ═════════════ Me ═════════════
export function MePage() {
  const { me, settings } = useApp();
  const ios = useMemo(() => /iphone|ipad|ipod/i.test(navigator.userAgent), []);
  const standalone = typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches;
  return <>
    <Top title="Me" />
    <div className="page" style={{ maxWidth: 720 }}>
      <section className="card">
        <div className="row">
          <div className="avatar" style={{ width: 52, height: 52, fontSize: 22 }}>{me.nickname[0]?.toUpperCase()}</div>
          <div className="grow"><h2 style={{ margin: 0 }}>{me.nickname}</h2><div className="muted small">{me.email} · {me.role === 'admin' ? 'Admin' : 'Employee'}</div></div>
        </div>
      </section>
      <section className="card">
        <h2>Office rules</h2>
        <div className="list small">
          <div className="item"><div className="grow">Daily target</div><b>{fmtDuration(settings.required_minutes)}</b></div>
          <div className="item"><div className="grow">Shift starts</div><b>{settings.shift_start.slice(0, 5)} <span className="muted">(+{settings.late_grace_minutes} min grace)</span></b></div>
          <div className="item"><div className="grow">Weekly off</div><b>{{ sat_sun: 'Saturday & Sunday', sun: 'Sunday', none: 'None' }[settings.weekend_mode]}</b></div>
          <div className="item"><div className="grow">Location check</div><b>{settings.geofence_enabled ? `On (within ${settings.geofence_radius_m} m)` : 'Off'}</b></div>
        </div>
      </section>
      {!standalone && <section className="card">
        <h2>Install on your phone</h2>
        <p className="small muted">{ios ? 'In Safari, tap the Share button, then “Add to Home Screen”.' : 'In Chrome, open the ⋮ menu and tap “Install app” or “Add to Home screen”.'} PunchIn then opens full-screen like a normal app.</p>
      </section>}
      <section className="card"><button className="btn ghost" onClick={() => backend.signOut()}><Icon n="out" />Sign out</button></section>
      <section className="card">
        <details className="about"><summary>About PunchIn <span className="muted small">v1.0</span></summary>
          <p className="small muted" style={{ marginTop: 10 }}>Attendance, leave and hours for {settings.company_name}. Check-in times are recorded by the server and every change is kept in a tamper-evident audit log.</p>
          <p className="credit" style={{ marginTop: 8 }}>Developed by Hitesh Dubey</p>
        </details>
      </section>
    </div>
  </>;
}
