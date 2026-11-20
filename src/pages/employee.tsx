import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import { backend } from '@backend';
import { useApp, TopActions } from '../App';
import type { Day, GeoFix, LeaveType } from '../lib/types';
import { addDays, countWorkingDays, distanceM, fmtDate, fmtDuration, getPosition, hhmmInTz, minutesBetween, monthRange, pct, timeInTz } from '../lib/time';
import { InstallSteps, LocationPrimer, OfficeMap, forget, locationExplained, useInstall } from '../extras';
import { Busy, C, Donut, Empty, Icon, Modal, Pill, StatusPill, useLoad, useToast } from '../ui';

export function Top({ title, sub, children }: { title: string; sub?: string; children?: React.ReactNode }) {
  return <header className="top"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row">{children}<TopActions /></div></header>;
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
  const { me, settings, today, week, month: s, schedule, upcoming_holidays, reload, open } = useApp(); const tz = settings.timezone; const toast = useToast();
  const now = useServerNow();
  const weekStart = addDays(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [primer, setPrimer] = useState(false);
  const [fix, setFix] = useState<GeoFix | null>(null); const [locating, setLocating] = useState(false);
  const install = useInstall();

  // A night shift that started yesterday is still "today's" shift until check-out.
  const rec: Day | undefined = open && open.work_date !== today ? week.find(x => x.day === open.work_date) ?? ({ day: open.work_date, check_in: open.check_in, check_out: open.check_out, break_minutes: open.break_minutes ?? 0, wfh: open.wfh } as Day) : week.find(x => x.day === today);
  const d = rec;
  const working = !!d?.check_in && !d?.check_out;
  const done = !!d?.check_out;
  const brk = d?.break_minutes ?? 0;
  const worked = d?.check_in ? Math.max(0, (d.check_out ? minutesBetween(d.check_in, d.check_out) : minutesBetween(d.check_in, now.toISOString())) - brk) : 0;
  const [showMap, setShowMap] = useState(false); const [wfhOffer, setWfhOffer] = useState(false);
  const target = d?.kind === 'half_day_leave' ? schedule.half : schedule.required;
  const progress = Math.min(1, worked / target);
  const leftMin = Math.max(0, target - worked);
  const geo = settings.geofence_enabled && settings.office_lat !== null && settings.office_lng !== null;
  const dist = fix && geo ? Math.round(distanceM(settings.office_lat!, settings.office_lng!, fix.lat, fix.lng)) : null;
  const inside = dist !== null && dist <= settings.geofence_radius_m && fix!.accuracy <= settings.max_gps_accuracy_m;

  async function locate() {
    setLocating(true); setErr(null);
    try { const f = await getPosition(); setFix(f); return f; } catch (e: any) { setErr(e.message); return null; } finally { setLocating(false); }
  }
  async function punch(opts: { wfh?: boolean; resume?: boolean } = {}) {
    const needGeo = geo && !opts.wfh && !(working && d?.wfh);
    if (needGeo && !locationExplained()) { setPrimer(true); return; }
    setBusy(true); setErr(null); setWfhOffer(false);
    try {
      let f: GeoFix | null = null;
      if (needGeo) { f = await locate(); if (!f) { setBusy(false); setWfhOffer(!working && settings.allow_wfh); return; } }
      const r = await backend.punch(working ? 'out' : 'in', f, { ...opts, resume: opts.resume || done });
      if (!r.ok) { setErr(r.error ?? 'Punch refused'); setShowMap(true); setWfhOffer(!working && !!r.wfh_allowed); }
      else { toast(working ? 'Checked out. See you tomorrow.' : opts.wfh ? 'Checked in — working from home.' : done ? 'Welcome back — break time not counted.' : 'Checked in. Have a good day.'); reload(); }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  }

  const R = 46, CIRC = 2 * Math.PI * R;
  const offDay = d && ['weekend', 'holiday', 'leave'].includes(d.kind) && !d.check_in;
  const days = week.concat(Array.from({ length: Math.max(0, 7 - week.length) }, (_, i) => ({ day: addDays(weekStart, week.length + i) } as Day)));
  const nextHol = upcoming_holidays[0];
  return <>
    <Top title={`${greeting(Number(hhmmInTz(now.toISOString(), tz).slice(0, 2)))}, ${me.nickname}`}
      sub={new Date(today + 'T12:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })} />
    <div className="page">
      {!install.installed && (install.canPrompt || /iphone|ipad|android/i.test(navigator.userAgent)) && <div className="banner">
        <img src="./icon-192.png" alt="" width={40} height={40} style={{ borderRadius: 10 }} />
        <div className="grow"><b>Get the PunchIn app</b><span>One tap from your home screen, full screen, no browser.</span></div>
        {install.canPrompt ? <button className="btn primary sm" onClick={() => install.prompt()}>Install</button> : <Link className="btn ghost sm" to="/me">How</Link>}
      </div>}
      <div className="grid g-today">
        <section className="card dial-card" aria-label="Today's punch">
          <div className="clock">Office time <b className="num">{timeInTz(now.toISOString(), tz)}</b></div>
          <div className="dial" data-tour="punch">
            <svg viewBox="0 0 100 100" aria-hidden>
              <circle cx="50" cy="50" r={R} fill="none" stroke={C.canvas} strokeWidth="7" />
              <circle className="ring-fill" cx="50" cy="50" r={R} fill="none" stroke={progress >= 1 ? C.good : C.orange} strokeWidth="7" strokeLinecap="round"
                strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - progress)} />
            </svg>
            <div className="center">
              {done
                ? <div className="punch done" role="img" aria-label={`Worked ${fmtDuration(worked)}`}><span className="big num">{fmtDuration(worked)}</span><span className="sm">{progress >= 1 ? 'Target met' : `${fmtDuration(leftMin)} short`}</span></div>
                : <button className={`punch ${working ? 'out' : ''}`} onClick={() => punch()} disabled={busy}>
                    <span className="big">{busy ? (geo ? 'Locating…' : '…') : working ? 'Check out' : 'Check in'}</span>
                    <span className="sm num">{working ? `${fmtDuration(worked)} so far` : offDay ? (d!.holiday ?? (d!.kind === 'leave' ? 'On leave' : 'Day off')) : 'Tap to start'}</span>
                  </button>}
            </div>
          </div>
          <div className="dial-meta num">
            <div><b>{timeInTz(d?.check_in, tz)}</b>In</div>
            <div><b>{timeInTz(d?.check_out, tz)}</b>Out</div>
            <div><b>{Math.round(progress * 100)}%</b>of {+(target / 60).toFixed(1)}h</div>
          </div>
          {err && <div className="note bad" style={{ marginTop: 14, position: 'relative' }} role="alert"><Icon n="alert" />{err}</div>}
          {wfhOffer && <button className="btn ghost block" style={{ marginTop: 10, position: 'relative' }} onClick={() => punch({ wfh: true })} disabled={busy}>Check in as working from home</button>}
          {done && <button className="linkbtn" style={{ marginTop: 10, position: 'relative' }} onClick={() => punch({ resume: true })} disabled={busy}>Back after a break? Check in again</button>}
          {(d?.wfh || brk > 0) && <p className="small muted" style={{ marginTop: 6, position: 'relative' }}>{d?.wfh ? 'Working from home today' : ''}{d?.wfh && brk > 0 ? ' · ' : ''}{brk > 0 ? `${fmtDuration(brk)} break not counted` : ''}</p>}
          {working && leftMin > 0 && <p className="small muted" style={{ marginTop: 8, position: 'relative' }}>Target reached at about {timeInTz(new Date(now.getTime() + leftMin * 60000).toISOString(), tz)}</p>}
          {schedule.custom && <p className="small muted" style={{ marginTop: 6, position: 'relative' }}>Your shift: from {schedule.shift_start.slice(0, 5)}, {fmtDuration(schedule.required)} a day</p>}
        </section>

        <div className="grid" style={{ alignContent: 'start' }}>
          {geo && <section className="card" data-tour="map">
            <h2>Office area <button className="linkbtn small" onClick={() => setShowMap(v => !v)}>{showMap || fix ? 'Hide map' : 'Show map'}</button></h2>
            {(showMap || fix) && <OfficeMap lat={settings.office_lat!} lng={settings.office_lng!} radius={settings.geofence_radius_m} me={fix} />}
            <div className="geo-status">
              {fix ? <><span className="dot" style={{ background: inside ? 'var(--good)' : 'var(--bad)' }} />
                {inside ? `You’re inside — ${dist} m from the office` : fix.accuracy > settings.max_gps_accuracy_m ? `GPS is too vague (±${Math.round(fix.accuracy)} m). Move near a window.` : `You’re ${dist} m away — need to be within ${settings.geofence_radius_m} m`}</>
                : <span className="muted">Check-in works within {settings.geofence_radius_m} m of the office.</span>}
              <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => (locationExplained() ? locate().then(() => setShowMap(true)) : setPrimer(true))} disabled={locating}><Icon n="pin" />{locating ? 'Finding you…' : 'Am I inside?'}</button>
            </div>
          </section>}
          <section className="card" data-tour="week">
            <h2>This week <small>{fmtDate(weekStart)} – {fmtDate(addDays(weekStart, 6))}</small></h2>
            <div className="week">
              {days.map(w => {
                const mins = w.worked_minutes ?? (w.day === today && w.check_in ? worked : 0);
                return <div key={w.day} className={`wd ${w.day === today ? 'today' : ''} ${['weekend', 'holiday'].includes(w.kind) ? 'off' : ''}`} title={w.kind}>
                  <div className="n">{new Date(w.day + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)}</div>
                  <div className="d">{Number(w.day.slice(8))}</div>
                  <div className="bar"><i style={{ width: `${Math.min(100, (mins / schedule.required) * 100)}%`, background: w.kind === 'full' ? C.good : undefined }} /></div>
                  <div className="h num">{mins ? (mins / 60).toFixed(1) : w.kind === 'leave' ? 'L' : w.kind === 'holiday' ? 'H' : '–'}</div>
                </div>;
              })}
            </div>
            {nextHol && <p className="small" style={{ marginTop: 12 }}>🎉 Next holiday: <b>{nextHol.name}</b>, {fmtDate(nextHol.holiday_date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>}
          </section>
          <section className="card" data-tour="month">
            <h2>{new Date(today + 'T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', timeZone: 'UTC' })} so far <Link to="/history" className="small" style={{ color: 'var(--orange-ink)' }}>Details</Link></h2>
            <div className="donut-wrap">
              <Donut size={150} parts={[{ label: 'Met target', value: s.fulfilled_days, color: C.orange }, { label: 'Below target', value: s.unfulfilled_days, color: C.orangeSoft }]}
                center={<div><div className="display num" style={{ fontSize: 28, fontWeight: 800 }}>{pct(s.fulfilled_days, s.fulfilled_days + s.unfulfilled_days)}%</div><div className="small muted">days on target</div></div>} />
              <div className="legend num">
                <div><i style={{ background: C.orange }} />Met target<b>{s.fulfilled_days}</b></div>
                <div><i style={{ background: C.orangeSoft }} />Below target<b>{s.unfulfilled_days}</b></div>
                <div className="plain">Late arrivals<b>{s.late_days}</b></div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
    {primer && <LocationPrimer onCancel={() => setPrimer(false)} onOk={() => { setPrimer(false); punch({ resume: done }); }} />}
  </>;
}

// ═════════════ History ═════════════
export function DayRow({ d, tz, onFix }: { d: Day; tz: string; onFix?: () => void }) {
  return (
    <div className="item">
      <div className="datechip"><b>{Number(d.day.slice(8))}</b><small>{new Date(d.day + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' })}</small></div>
      <div className="grow">
        <div className="ttl num">{d.check_in ? `${timeInTz(d.check_in, tz)} → ${timeInTz(d.check_out, tz)}` : d.holiday ?? (d.kind === 'weekend' ? 'Weekend' : '—')}</div>
        <div className="sub num">{d.worked_minutes != null ? fmtDuration(d.worked_minutes) : ''}{d.late && <> · <span className="tag">Late</span></>}{d.wfh && <> · <span className="tag">WFH</span></>}</div>
      </div>
      <div className="right row" style={{ gap: 8 }}>
        <Pill kind={d.kind} />
        {onFix && ['missing_checkout', 'short', 'half_day', 'absent'].includes(d.kind) && <button className="btn ghost sm" onClick={onFix}>Fix</button>}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const { me, settings, today } = useApp(); const toast = useToast(); const loc = useLocation(); const nav = useNavigate();
  const pre = new URLSearchParams(loc.search).get('date');
  const [fixDate, setFixDate] = useState<string | null>(pre);
  useEffect(() => { if (pre) setFixDate(pre); }, [pre]);
  const fixes = useLoad(() => backend.corrections(me.id), [me.id]);
  const [ym, setYm] = useState(today.slice(0, 7));
  const [from, to] = monthRange(ym);
  const days = useLoad(() => backend.days(me.id, from, to), [me.id, ym]);
  const sum = useLoad(() => backend.summary(me.id, from, to), [me.id, ym]);
  const [showOff, setShowOff] = useState(false);
  const s = sum.data;
  const list = (days.data ?? []).slice().reverse().filter(d => showOff || !['weekend', 'holiday'].includes(d.kind) || d.check_in);
  return <>
    <Top title="History" sub="Your days, hours and fix requests"><input className="input" type="month" value={ym} max={today.slice(0, 7)} onChange={e => e.target.value && setYm(e.target.value)} style={{ width: 170 }} aria-label="Month" /></Top>
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
        {list.length ? <div className="list">{list.map(d => <DayRow key={d.day} d={d} tz={settings.timezone} onFix={() => setFixDate(d.day)} />)}</div>
          : !days.loading && <Empty title="Nothing here yet">No working days recorded for this month.</Empty>}
        <button className="linkbtn small" style={{ marginTop: 12 }} onClick={() => setFixDate(today)}>Wrong time on another day? Ask for a fix</button>
      </section>
      {!!fixes.data?.length && <FixList list={fixes.data} />}
    </div>
    {fixDate && <FixForm today={today} date={fixDate} onClose={() => { setFixDate(null); if (pre) nav('/history', { replace: true }); }} onDone={() => { setFixDate(null); fixes.reload(); toast('Fix request sent to your admin'); }} />}
  </>;
}

// ═════════════ Leave ═════════════
const LEAVE_LABEL: Record<LeaveType, string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', unpaid: 'Unpaid' };

export function LeavePage() {
  const { me, today } = useApp(); const toast = useToast();
  const leaves = useLoad(() => backend.leaves(me.id), [me.id]);
  const bal = useLoad(() => backend.balance(), [me.id]);
  const [open, setOpen] = useState(false);
  const b = bal.data;
  const shown = (leaves.data ?? []).filter(l => l.status !== 'cancelled');
  return <>
    <Top title="Leave" sub={`${today.slice(0, 4)} balance and requests`} />
    <div className="page">
      <section className="card leave-sum num">
        <div className="row between"><div><div className="big">{b?.remaining ?? '–'}<small> of {b?.annual ?? '–'} days left</small></div>
          <div className="small muted">{b ? `${b.used} used${b.pending ? ` · ${b.pending} waiting for approval` : ''}` : ' '}</div></div>
          <button className="btn primary" onClick={() => setOpen(true)}><Icon n="plus" />Apply</button></div>
        {b && <div className="progress" aria-label="Leave used"><i style={{ width: `${pct(b.used, b.annual)}%` }} /></div>}
      </section>
      <section className="card">
        <h2>Requests</h2>
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
  const { schedule } = useApp();
  const hol = useLoad(() => backend.holidays(), []);
  const n = hol.data && end >= start ? countWorkingDays(start, half ? start : end, schedule.weekend_mode, new Set(hol.data.map(h => h.holiday_date))) * (half ? 0.5 : 1) : null;
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
function FixList({ list }: { list: import('../lib/types').Correction[] }) {
  return <section className="card">
    <h2>Fix requests</h2>
    <div className="list">{list.map(c => (
      <div className="item" key={c.id}>
        <div className="datechip"><b>{Number(c.work_date.slice(8))}</b><small>{fmtDate(c.work_date, { month: 'short' })}</small></div>
        <div className="grow">
          <div className="ttl num">{c.requested_check_in && `In ${c.requested_check_in.slice(0, 5)}`}{c.requested_check_in && c.requested_check_out && ' · '}{c.requested_check_out && `Out ${c.requested_check_out.slice(0, 5)}`}</div>
          <div className="sub">{c.reason}{c.admin_note && <> · <b>Admin:</b> {c.admin_note}</>}</div>
        </div>
        <StatusPill s={c.status} />
      </div>))}</div>
  </section>;
}

function FixForm({ today, date: d0, onClose, onDone }: { today: string; date: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(d0); const [tin, setIn] = useState(''); const [tout, setOut] = useState(''); const [reason, setReason] = useState('');
  return (
    <Modal title="Ask for a fix" lede="Fill only the time that is wrong or missing. Night shift? A check-out earlier than check-in counts as the next morning." onClose={onClose}>
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
  const { me, settings, schedule, startTour } = useApp(); const nav = useNavigate();
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
        <h2>Install the app</h2>
        <InstallSteps />
      </section>
      <section className="card">
        <h2>My working rules</h2>
        <div className="list small">
          <div className="item"><div className="grow">Daily target</div><b>{fmtDuration(schedule.required)}</b></div>
          <div className="item"><div className="grow">Shift starts</div><b>{schedule.shift_start.slice(0, 5)} <span className="muted">(+{settings.late_grace_minutes} min grace)</span></b></div>
          <div className="item"><div className="grow">Weekly off</div><b>{{ sat_sun: 'Saturday & Sunday', sun: 'Sunday', none: 'None' }[schedule.weekend_mode]}</b></div>
          {settings.earliest_checkin && <div className="item"><div className="grow">Check-in opens</div><b>{settings.earliest_checkin.slice(0, 5)}</b></div>}
          <div className="item"><div className="grow">Location check</div><b>{settings.geofence_enabled ? `On (within ${settings.geofence_radius_m} m)` : 'Off'}</b></div>
          {settings.allow_wfh && <div className="item"><div className="grow">Work from home</div><b>Allowed</b></div>}
        </div>
      </section>
      <section className="card">
        <h2>Help</h2>
        <div className="row">
          <button className="btn ghost" onClick={() => { forget('punchin.tour.'); nav(me.role === 'admin' ? '/admin' : '/today'); setTimeout(startTour, 400); }}>Show me around again</button>
          <Link className="btn ghost" to="/privacy">Privacy & permissions</Link>
          <button className="btn ghost" onClick={() => backend.signOut()}><Icon n="out" />Sign out</button>
        </div>
      </section>
      <section className="card">
        <details className="about"><summary>About PunchIn <span className="muted small">v2.1</span></summary>
          <p className="small muted" style={{ marginTop: 10 }}>Attendance, leave and hours for {settings.company_name}. Check-in times are recorded by the server and every change is kept in a tamper-evident audit log.</p>
          <p className="credit" style={{ marginTop: 8 }}>Developed by Hitesh Dubey</p>
        </details>
      </section>
    </div>
  </>;
}

// ═════════════ Privacy (also reachable before sign-in) ═════════════
export function PrivacyPage({ standalone }: { standalone?: boolean }) {
  const body = <div className="card" style={{ lineHeight: 1.6 }}>
    <h2>What PunchIn collects</h2>
    <ul className="checklist" style={{ marginBottom: 16 }}>
      <li><Icon n="check" />Your office email, the nickname your admin gave you, and your password (stored only as a salted hash — nobody can read it).</li>
      <li><Icon n="check" />Check-in and check-out times, stamped by the server.</li>
      <li><Icon n="check" />Leave requests, fix requests and the reasons you type.</li>
      <li><Icon n="check" />If your office turned on the location check: your distance from the office (e.g. “42 m”) and GPS accuracy at the moment you tap. <b>Your exact coordinates are never stored.</b></li>
    </ul>
    <h2>What PunchIn never does</h2>
    <ul className="checklist" style={{ marginBottom: 16 }}>
      <li><Icon n="x" />No camera, microphone, contacts, photos, files, Bluetooth or background location.</li>
      <li><Icon n="x" />No tracking, ads, analytics or third-party cookies.</li>
      <li><Icon n="x" />Your location is only read when you tap Check in, Check out or “Am I inside?”.</li>
    </ul>
    <h2>Who can see your data</h2>
    <p className="small" style={{ marginBottom: 12 }}>You see only your own records. Your office admins can see everyone’s attendance and leave. Data is stored in your organisation’s private Google Sheet, which is not shared with staff. Every change is logged in a tamper-evident audit trail.</p>
    <h2>Your rights</h2>
    <p className="small">You can see all your records in History and Leave. To correct something, tap Fix on that day in History. To have your account removed, ask your admin. Records are kept as long as your organisation needs them for attendance and payroll.</p>
    <p className="small muted" style={{ marginTop: 12 }}>Map tiles © OpenStreetMap contributors — loaded only when a map is shown.</p>
  </div>;
  if (standalone) return <><header className="top" style={{ padding: '24px 0 8px' }}><div><h1>Privacy</h1><p>Plain-language summary</p></div><a className="btn ghost" href="#/">Back</a></header>{body}</>;
  return <><Top title="Privacy" sub="Plain-language summary" /><div className="page" style={{ maxWidth: 760 }}>{body}</div></>;
}

// ═════════════ Announce a holiday on WhatsApp (admin) ═════════════
export function AnnouncePage() {
  const { settings, today } = useApp(); const toast = useToast();
  const q = new URLSearchParams(useLocation().search);
  const hol = useLoad(() => backend.holidays(), []);
  const date = q.get('date') ?? addDays(today, 1);
  const h = hol.data?.find(x => x.holiday_date === date);
  const text = h ? `📢 *${settings.company_name}*: the office is closed on ${fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} for *${h.name}*. Enjoy the holiday! 🎉` : '';
  const copyOpen = async () => {
    try { await navigator.clipboard.writeText(text); toast('Message copied — paste it in the group'); } catch { toast('Copy the message above, then paste it in the group'); }
    if (settings.whatsapp_group_link) window.open(settings.whatsapp_group_link, '_blank', 'noopener');
  };
  return <>
    <Top title="Announce holiday" sub="Tell the team on WhatsApp in one tap" />
    <div className="page" style={{ maxWidth: 640 }}>
      {hol.loading ? <div className="spinner" /> : !h ? <Empty title="No holiday on that date">Pick one from Holidays.</Empty> : <section className="card">
        <h2>{h.name} <small>{fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</small></h2>
        <div className="msg-preview" style={{ marginBottom: 16 }}>{text.replace(/\*/g, '')}</div>
        <div className="grid" style={{ gap: 10 }}>
          {settings.whatsapp_group_link
            ? <button className="btn primary block" onClick={copyOpen}>Copy message & open office group</button>
            : <Link className="btn ghost block" to="/admin/settings#whatsapp">Link your office WhatsApp group first</Link>}
          <a className="btn ghost block" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp (pick the group)</a>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>WhatsApp doesn’t let apps post into groups by themselves, so you press Send. Everyone also sees the holiday in PunchIn on the day.</p>
      </section>}
    </div>
  </>;
}
