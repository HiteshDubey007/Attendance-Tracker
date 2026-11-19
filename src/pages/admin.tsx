import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useSearchParams } from 'react-router-dom';
import { Bar } from 'react-chartjs-2';
import { backend } from '@backend';
import { useApp } from '../App';
import type { Day, HolidayCandidate, Member, MemberStatus, Role, Settings, WeekendMode } from '../lib/types';
import { addDays, download, fmtDate, fmtDuration, getPosition, hhmmInTz, KIND_LABEL, monthRange, pct, timeInTz, toCsv } from '../lib/time';
import { Busy, C, Donut, Empty, Icon, Modal, Pill, Seg, StatusPill, useLoad, useToast } from '../ui';
import { Top } from './employee';
import { OfficeMap, Tip } from '../extras';

const nameOf = (ms: Member[] | undefined, id: string | null) => ms?.find(m => m.id === id)?.nickname ?? '—';

// ═════════════ Overview ═════════════
type Period = 'month' | '30' | 'year';
function periodRange(p: Period, today: string): [string, string] {
  if (p === 'month') return [monthRange(today.slice(0, 7))[0], today];
  if (p === '30') return [addDays(today, -29), today];
  return [`${today.slice(0, 4)}-01-01`, today];
}

export function OverviewPage() {
  const { settings, today, pending } = useApp(); const tz = settings.timezone;
  const team = useLoad(() => backend.teamDay(), []);
  const members = useLoad(() => backend.members(), []);
  const trend = useLoad(() => backend.teamTrend(addDays(today, -29), today), [today]);
  const [period, setPeriod] = useState<Period>('month');
  const [who, setWho] = useState('all');
  const [from, to] = periodRange(period, today);
  const active = (members.data ?? []).filter(m => m.status === 'active');
  const sums = useLoad(async () => Promise.all(active.map(async m => ({ m, s: await backend.summary(m.id, from, to) }))), [members.data, from, to]);

  const t = team.data ?? [];
  const count = (f: (r: typeof t[0]) => boolean) => t.filter(f).length;
  const chosen = (sums.data ?? []).filter(x => who === 'all' || x.m.id === who);
  const met = chosen.reduce((s, x) => s + x.s.fulfilled_days, 0);
  const missed = chosen.reduce((s, x) => s + x.s.unfulfilled_days, 0);
  const days = (trend.data ?? []).filter(r => r.expected > 0 || r.present > 0);

  return <>
    <Top title="Team today" sub={new Date(today + 'T12:00:00Z').toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })}>
      {(pending ?? 0) > 0 && <Link className="btn primary" to="/admin/approvals"><Icon n="approvals" />{pending} waiting for you</Link>}
    </Top>
    <div className="page">
      <SetupChecklist />
      <div className="stats num">
        <div className="stat hot"><div className="v">{count(r => r.kind === 'working')}</div><div className="l">In the office now</div></div>
        <div className="stat"><div className="v">{count(r => !!r.check_out)}</div><div className="l">Checked out</div></div>
        <div className="stat"><div className="v">{count(r => r.kind === 'not_yet')}</div><div className="l">Not in yet</div></div>
        <div className="stat"><div className="v">{count(r => r.kind === 'leave' || r.kind === 'half_day_leave')}</div><div className="l">On leave</div></div>
        <div className="stat"><div className="v">{count(r => r.late)}</div><div className="l">Late today</div></div>
      </div>

      <div className="grid g2">
        <section className="card">
          <h2>Attendance, last 30 days <small>people present per day</small></h2>
          <div className="chart">
            <Bar data={{
              labels: days.map(r => fmtDate(r.day)),
              datasets: [
                { label: 'Met target', data: days.map(r => r.full_days), backgroundColor: C.orange, borderRadius: 4, stack: 'a' },
                { label: 'Present, below target', data: days.map(r => r.present - r.full_days), backgroundColor: C.orangeSoft, borderRadius: 4, stack: 'a' },
                { label: 'On leave', data: days.map(r => r.on_leave), backgroundColor: '#C9D9EC', borderRadius: 4, stack: 'a' },
                { label: 'Absent', data: days.map(r => r.absent), backgroundColor: C.line, borderRadius: 4, stack: 'a' },
              ],
            }} options={{ maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } } },
              scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f2eee9' } } } }} />
          </div>
        </section>

        <section className="card">
          <h2>Daily target met <small>{settings.required_minutes / 60}h a day</small></h2>
          <div className="row" style={{ marginBottom: 14 }}>
            <select className="input" style={{ flex: 1, minWidth: 140 }} value={who} onChange={e => setWho(e.target.value)} aria-label="Person">
              <option value="all">Whole team</option>{active.map(m => <option key={m.id} value={m.id}>{m.nickname}</option>)}
            </select>
            <Seg value={period} onChange={setPeriod} options={[['month', 'Month'], ['30', '30 days'], ['year', 'Year']]} />
          </div>
          <div className="donut-wrap">
            <Donut parts={[{ label: 'Met target', value: met, color: C.orange }, { label: 'Below target', value: missed, color: C.orangeSoft }]}
              center={<div><div className="display num" style={{ fontSize: 32, fontWeight: 800 }}>{pct(met, met + missed)}%</div><div className="small muted">on target</div></div>} />
            <div className="legend num">
              <div><i style={{ background: C.orange }} />Met target<b>{pct(met, met + missed)}%</b></div>
              <div><i style={{ background: C.orangeSoft }} />Below target<b>{pct(missed, met + missed)}%</b></div>
              <div className="small muted" style={{ fontWeight: 500 }}>{met} of {met + missed} worked days · {fmtDate(from)} – {fmtDate(to)}</div>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>Right now <small>{t.length} people</small></h2>
        <div className="tablewrap"><table className="num">
          <thead><tr><th>Name</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th></tr></thead>
          <tbody>{t.map(r => <tr key={r.member_id}>
            <td><b>{r.nickname}</b> {r.late && <span className="tag">Late</span>}</td><td><Pill kind={r.kind} /></td>
            <td>{timeInTz(r.check_in, tz)}</td><td>{timeInTz(r.check_out, tz)}</td><td>{r.worked_minutes != null ? fmtDuration(r.worked_minutes) : '—'}</td>
          </tr>)}</tbody>
        </table></div>
        {!t.length && !team.loading && <Empty title="No one on the team yet"><Link to="/admin/people">Add your first employee</Link></Empty>}
      </section>

      <section className="card">
        <h2>By person <small>{fmtDate(from)} – {fmtDate(to)}</small></h2>
        <div className="tablewrap"><table className="num">
          <thead><tr><th>Name</th><th>Target met</th><th style={{ minWidth: 120 }}></th><th>Present</th><th>Late</th><th>Leave</th><th>Absent</th><th>Hours</th></tr></thead>
          <tbody>{(sums.data ?? []).map(({ m, s }) => {
            const p = pct(s.fulfilled_days, s.fulfilled_days + s.unfulfilled_days);
            return <tr key={m.id}>
              <td><Link to={`/admin/records?m=${m.id}`} style={{ color: 'inherit', fontWeight: 700 }}>{m.nickname}</Link></td>
              <td><b>{p}%</b></td><td><div className="progress"><i style={{ width: `${p}%` }} /></div></td>
              <td>{s.present_days}/{s.working_days}</td><td>{s.late_days}</td><td>{s.leave_days}</td><td>{s.absent_days}</td><td>{Math.round(s.total_minutes / 60)}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
    </div>
  </>;
}

// ═════════════ People ═════════════
export function PeoplePage() {
  const members = useLoad(() => backend.members(), []);
  const { me, reload } = useApp(); const toast = useToast();
  const [adding, setAdding] = useState(false); const [editing, setEditing] = useState<Member | null>(null);
  const [code, setCode] = useState<{ who: string; email: string; code: string } | null>(null);
  const [q, setQ] = useState('');
  const list = (members.data ?? []).filter(m => (m.nickname + m.email).toLowerCase().includes(q.toLowerCase()));
  return <>
    <Top title="People" sub="Add, rename, block or remove team members"><button className="btn primary" onClick={() => setAdding(true)}><Icon n="plus" />Add person</button></Top>
    <div className="page">
      <section className="card">
        <input className="input" placeholder="Search name or email" value={q} onChange={e => setQ(e.target.value)} style={{ marginBottom: 8 }} aria-label="Search" />
        <div className="list">{list.map(m => (
          <div className="item" key={m.id}>
            <div className="avatar" style={m.status !== 'active' ? { background: 'var(--canvas)', color: 'var(--muted)' } : undefined}>{m.nickname[0]?.toUpperCase()}</div>
            <div className="grow">
              <div className="ttl">{m.nickname} {m.role === 'admin' && <span className="tag">Admin</span>}</div>
              <div className="sub">{m.email}{(m.shift_start || m.required_minutes || m.weekend_mode) && <> · <span className="tag">Own shift</span></>}</div>
            </div>
            <div className="right row" style={{ gap: 8 }}>
              {m.status !== 'active' && <StatusPill s={m.status} />}
              <Link className="btn ghost sm" to={`/admin/records?m=${m.id}`}>Records</Link>
              {m.id !== me.id && <button className="btn ghost sm" onClick={() => setEditing(m)}><Icon n="edit" />Edit</button>}
            </div>
          </div>))}</div>
        {!list.length && !members.loading && <Empty title="Nobody here">Add people by their office email.</Empty>}
      </section>
      <div className="note info"><Icon n="alert" />When you add someone you get a WhatsApp invite with a one-time code. They tap the link, choose a password and install the app. Codes work once and expire in 14 days. Forgot password? Edit the person → New sign-in code.</div>
    </div>
    {adding && <AddPerson onClose={() => setAdding(false)} onDone={(who, email, c) => { setAdding(false); members.reload(); reload(); if (c) setCode({ who, email, code: c }); else toast('Person added'); }} />}
    {editing && <EditPerson m={editing} onClose={() => setEditing(null)} onCode={c => { setEditing(null); setCode({ who: editing.nickname, email: editing.email, code: c }); }} onDone={msg => { setEditing(null); members.reload(); toast(msg); }} />}
    {code && <CodeCard who={code.who} email={code.email} code={code.code} onClose={() => setCode(null)} />}
  </>;
}

function CodeCard({ who, email, code, onClose }: { who: string; email: string; code: string; onClose: () => void }) {
  const toast = useToast();
  const link = `${location.href.split('#')[0]}#/join?e=${encodeURIComponent(email)}&c=${code}`;
  const text = `Hi ${who}! 👋 You’re invited to PunchIn, our office attendance app.\n\n1️⃣ Tap: ${link}\n2️⃣ Choose a password\n3️⃣ Add the app to your home screen\n\nYour one-time code is ${code} (valid 14 days).`;
  return (
    <Modal title={`Code for ${who}`} lede="Share it privately (WhatsApp, in person). It works once and expires in 14 days." onClose={onClose}>
      <div className="display num" style={{ fontSize: 40, fontWeight: 800, letterSpacing: '.18em', textAlign: 'center', padding: '18px 0', background: 'var(--orange-wash)', borderRadius: 16, color: 'var(--orange-ink)', marginBottom: 16 }}>{code}</div>
      <div className="row end">
        <button className="btn ghost" onClick={() => { navigator.clipboard?.writeText(text).then(() => toast('Message copied')); }}>Copy message</button>
        <a className="btn primary" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
      </div>
      <p className="small muted" style={{ marginTop: 14 }}>The message has a link that fills in their email and code. The code is not shown again — if it’s lost, open the person and tap “New sign-in code”.</p>
    </Modal>
  );
}

function AddPerson({ onClose, onDone }: { onClose: () => void; onDone: (who: string, email: string, code: string | null) => void }) {
  const [email, setEmail] = useState(''); const [nick, setNick] = useState(''); const [role, setRole] = useState<Role>('employee');
  return (
    <Modal title="Add a person" lede="They’ll be able to create their account with this email." onClose={onClose}>
      <label className="field"><span>Office email</span><input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" /></label>
      <label className="field"><span>Nickname</span><input className="input" maxLength={40} value={nick} onChange={e => setNick(e.target.value)} placeholder="Shown across the app" /></label>
      <label className="field"><span>Role</span><select className="input" value={role} onChange={e => setRole(e.target.value as Role)}><option value="employee">Employee</option><option value="admin">Admin (sees everyone, approves requests)</option></select></label>
      <div className="row end"><button className="btn ghost" onClick={onClose}>Cancel</button>
        <Busy run={async () => { const c = await backend.addMember(email, nick, role); onDone(nick, email.trim().toLowerCase(), c); }} disabled={!/\S+@\S+\.\S+/.test(email) || !nick.trim()}>Add person</Busy></div>
    </Modal>
  );
}

function EditPerson({ m, onClose, onDone, onCode }: { m: Member; onClose: () => void; onDone: (msg: string) => void; onCode: (code: string) => void }) {
  const { settings } = useApp();
  const [nick, setNick] = useState(m.nickname); const [role, setRole] = useState<Role>(m.role); const [confirmDel, setConfirmDel] = useState(false);
  const [own, setOwn] = useState(!!(m.shift_start || m.required_minutes || m.weekend_mode));
  const [start, setStart] = useState((m.shift_start ?? settings.shift_start).slice(0, 5));
  const [mins, setMins] = useState(m.required_minutes ?? settings.required_minutes);
  const [wk, setWk] = useState<WeekendMode>(m.weekend_mode ?? settings.weekend_mode);
  const shift = own ? { shift_start: start, required_minutes: mins, weekend_mode: wk } : { shift_start: null, required_minutes: null, weekend_mode: null };
  const save = (status: MemberStatus, msg: string) => async () => { await backend.updateMember(m.id, { nickname: nick, role, status, ...shift }); onDone(msg); };
  return (
    <Modal title={`Edit ${m.nickname}`} lede={m.email} onClose={onClose}>
      <label className="field"><span>Nickname</span><input className="input" maxLength={40} value={nick} onChange={e => setNick(e.target.value)} /></label>
      <label className="field"><span>Role <Tip>Admins see everyone, approve requests and change settings. Make your manager an admin; you can stay an employee.</Tip></span><select className="input" value={role} onChange={e => setRole(e.target.value as Role)}><option value="employee">Employee</option><option value="admin">Admin</option></select></label>
      <label className="check"><input type="checkbox" checked={own} onChange={e => setOwn(e.target.checked)} />Different hours for this person <Tip>For part-timers, night shift or a 6-day week. Leave unticked to use the office timings.</Tip></label>
      {own && <div className="two">
        <label className="field"><span>Shift starts</span><input className="input" type="time" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="field"><span>Hours a day</span><select className="input" value={mins} onChange={e => setMins(Number(e.target.value))}>{[240, 300, 360, 420, 450, 480, 510, 540, 570, 600].map(x => <option key={x} value={x}>{fmtDuration(x)}</option>)}</select></label>
        <label className="field"><span>Weekly off</span><select className="input" value={wk} onChange={e => setWk(e.target.value as WeekendMode)}><option value="sat_sun">Saturday & Sunday</option><option value="sun">Sunday only</option><option value="none">None</option></select></label>
      </div>}
      <div className="row between" style={{ marginBottom: 18 }}>
        <Busy className="btn ghost" run={async () => onCode(await backend.resetCode(m.id))}>New sign-in code</Busy>
        <Busy run={save(m.status, 'Saved')}>Save changes</Busy></div>
      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }} className="row between">
        {m.status === 'blocked'
          ? <Busy className="btn good" run={save('active', `${m.nickname} unblocked`)}>Unblock</Busy>
          : <Busy className="btn ghost" run={save('blocked', `${m.nickname} blocked`)}>Block access</Busy>}
        {confirmDel
          ? <Busy className="btn bad" run={save('deleted', `${m.nickname} removed`)}>Yes, remove {m.nickname}</Busy>
          : <button className="btn bad" onClick={() => setConfirmDel(true)}>Remove</button>}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>Blocking stops sign-in and punching but keeps everything. Removing hides them from the team; their past records stay in the audit trail, and adding the same email later restores them.</p>
    </Modal>
  );
}

// ═════════════ Set-up checklist (admin home) ═════════════
function SetupChecklist() {
  const { setup, settings } = useApp();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('punchin.setup.hidden') === '1'; } catch { return false; } });
  if (!setup || hidden) return null;
  const steps = [
    { done: settings.company_name !== 'My Company', to: '/admin/settings', title: 'Set company name and office hours', sub: 'Shift start, daily hours, weekly off' },
    { done: setup.location, to: '/admin/settings#location', title: 'Mark the office on the map', sub: 'Draw the circle people must be inside to check in' },
    { done: setup.holidays > 0, to: '/admin/holidays', title: 'Add this year’s holidays', sub: 'Upload your PDF/photo, or tick public holidays' },
    { done: setup.people > 1, to: '/admin/people', title: 'Invite your team', sub: 'Each person gets a WhatsApp invite link' },
    { done: setup.whatsapp, to: '/admin/settings#whatsapp', title: 'Link the office WhatsApp group', sub: 'For one-tap holiday announcements' },
  ];
  const left = steps.filter(x => !x.done).length;
  if (!left) return null;
  return (
    <section className="card" data-tour="setup">
      <h2>Get PunchIn ready <small>{steps.length - left} of {steps.length} done</small></h2>
      <div className="progress" style={{ marginBottom: 6 }}><i style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} /></div>
      {steps.map(x => <Link key={x.title} to={x.to} className={`setup-step ${x.done ? 'done' : ''}`}>
        <span className="tick">{x.done && <Icon n="check" />}</span>
        <div className="grow"><div className="ttl" style={{ fontWeight: 700 }}>{x.title}</div><div className="sub small muted">{x.sub}</div></div>
        {!x.done && <Icon n="more" width={18} height={18} />}
      </Link>)}
      <button className="linkbtn" style={{ marginTop: 10 }} onClick={() => { try { localStorage.setItem('punchin.setup.hidden', '1'); } catch { /* ignore */ } setHidden(true); }}>Hide this list</button>
    </section>
  );
}

// ═════════════ Records ═════════════
export function RecordsPage() {
  const { settings, today } = useApp(); const tz = settings.timezone; const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const members = useLoad(() => backend.members(), []);
  const mid = sp.get('m') ?? members.data?.[0]?.id ?? '';
  const [ym, setYm] = useState(today.slice(0, 7)); const [from, to] = monthRange(ym);
  const days = useLoad(async () => mid ? backend.days(mid, from, to) : [], [mid, ym]);
  const att = useLoad(async () => mid ? backend.attendance(mid, from, to) : [], [mid, ym]);
  const sum = useLoad(async () => mid ? backend.summary(mid, from, to) : null, [mid, ym]);
  const [edit, setEdit] = useState<Day | null>(null);
  const reload = () => { days.reload(); att.reload(); sum.reload(); };

  async function exportCsv() {
    const ms = (members.data ?? []).filter(m => m.status !== 'deleted');
    const rows: (string | number | null)[][] = [['Name', 'Email', 'Date', 'Status', 'Check in', 'Check out', 'Minutes', 'Hours', 'Late', 'Target met', 'Holiday']];
    for (const m of ms) for (const d of await backend.days(m.id, from, to))
      rows.push([m.nickname, m.email, d.day, KIND_LABEL[d.kind], hhmmInTz(d.check_in, tz), hhmmInTz(d.check_out, tz), d.worked_minutes, d.worked_minutes != null ? (d.worked_minutes / 60).toFixed(2) : '', d.late ? 'Yes' : '', d.fulfilled ? 'Yes' : '', d.holiday]);
    download(`attendance-${ym}.csv`, toCsv(rows)); toast('CSV downloaded');
  }
  const s = sum.data;
  const byDate = new Map((att.data ?? []).map(a => [a.work_date, a]));
  return <>
    <Top title="Records" sub="Check every day and correct mistakes">
      <Busy className="btn ghost" run={exportCsv}><Icon n="download" />Export month (all)</Busy>
    </Top>
    <div className="page">
      <div className="row">
        <select className="input" style={{ maxWidth: 260 }} value={mid} onChange={e => setSp({ m: e.target.value })} aria-label="Person">
          {(members.data ?? []).map(m => <option key={m.id} value={m.id}>{m.nickname}{m.status !== 'active' ? ` (${m.status})` : ''}</option>)}
        </select>
        <input className="input" type="month" style={{ maxWidth: 180 }} value={ym} max={today.slice(0, 7)} onChange={e => e.target.value && setYm(e.target.value)} aria-label="Month" />
      </div>
      {s && <div className="stats num">
        <div className="stat hot"><div className="v">{pct(s.fulfilled_days, s.fulfilled_days + s.unfulfilled_days)}%</div><div className="l">Days on target</div></div>
        <div className="stat"><div className="v">{Math.round(s.total_minutes / 60)}<small>h</small></div><div className="l">Hours</div></div>
        <div className="stat"><div className="v">{s.present_days}<small>/{s.working_days}</small></div><div className="l">Present</div></div>
        <div className="stat"><div className="v">{s.late_days}</div><div className="l">Late</div></div>
        <div className="stat"><div className="v">{s.missing_checkout_days}</div><div className="l">No check-out</div></div>
      </div>}
      <section className="card">
        <div className="tablewrap"><table className="num">
          <thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>Note</th><th></th></tr></thead>
          <tbody>{(days.data ?? []).slice().reverse().map(d => {
            const a = byDate.get(d.day);
            return <tr key={d.day}>
              <td><b>{fmtDate(d.day, { weekday: 'short', day: 'numeric', month: 'short' })}</b></td>
              <td><Pill kind={d.kind} /> {d.late && <span className="tag">Late</span>}</td>
              <td>{timeInTz(d.check_in, tz)}</td><td>{timeInTz(d.check_out, tz)}</td>
              <td>{d.worked_minutes != null ? fmtDuration(d.worked_minutes) : '—'}</td>
              <td className="small muted" style={{ whiteSpace: 'normal', minWidth: 140 }}>
                {a?.source !== 'app' && a?.edit_reason && <><span className="tag">{a.source === 'correction' ? 'Fixed' : 'Edited'}</span> {a.edit_reason}</>}
                {a?.in_distance_m != null && a.source === 'app' && `${Math.round(a.in_distance_m)} m from office`}
              </td>
              <td><button className="btn ghost sm" onClick={() => setEdit(d)}><Icon n="edit" />{d.check_in ? 'Edit' : 'Add'}</button></td>
            </tr>;
          })}</tbody>
        </table></div>
      </section>
    </div>
    {edit && <EditDay d={edit} tz={tz} rec={byDate.get(edit.day)} member={nameOf(members.data, mid)} onClose={() => setEdit(null)}
      onSave={async (i, o, why) => { await backend.setAttendance(mid, edit.day, i, o, why); setEdit(null); reload(); toast('Record saved and logged'); }}
      onDelete={async why => { await backend.deleteAttendance(byDate.get(edit.day)!.id, why); setEdit(null); reload(); toast('Record removed and logged'); }} />}
  </>;
}

function EditDay({ d, tz, rec, member, onClose, onSave, onDelete }: { d: Day; tz: string; rec?: { id: string }; member: string; onClose: () => void;
  onSave: (i: string | null, o: string | null, why: string) => Promise<void>; onDelete: (why: string) => Promise<void> }) {
  const [tin, setIn] = useState(hhmmInTz(d.check_in, tz)); const [tout, setOut] = useState(hhmmInTz(d.check_out, tz)); const [why, setWhy] = useState('');
  return (
    <Modal title={`${member} · ${fmtDate(d.day, { weekday: 'long', day: 'numeric', month: 'long' })}`} lede="Office local time. Your reason is stored permanently in the audit log." onClose={onClose}>
      <div className="two">
        <label className="field"><span>Check-in</span><input className="input" type="time" value={tin} onChange={e => setIn(e.target.value)} /></label>
        <label className="field"><span>Check-out</span><input className="input" type="time" value={tout} onChange={e => setOut(e.target.value)} /></label>
      </div>
      <label className="field"><span>Reason for change</span><input className="input" value={why} onChange={e => setWhy(e.target.value)} placeholder="e.g. Verified with CCTV entry log" /></label>
      <div className="row between">
        {rec ? <Busy className="btn bad" run={() => onDelete(why)} disabled={why.trim().length < 3}>Delete day</Busy> : <span />}
        <div className="row"><button className="btn ghost" onClick={onClose}>Cancel</button>
          <Busy run={() => onSave(tin || null, tout || null, why)} disabled={!tin || why.trim().length < 3}>Save</Busy></div>
      </div>
    </Modal>
  );
}

// ═════════════ Approvals ═════════════
export function ApprovalsPage() {
  const { settings, reload } = useApp(); const toast = useToast();
  const members = useLoad(() => backend.members(), []);
  const leaves = useLoad(() => backend.leaves(), []);
  const fixes = useLoad(() => backend.corrections(), []);
  const [tab, setTab] = useState<'leave' | 'fix'>('leave'); const [hist, setHist] = useState(false);
  const [note, setNote] = useState<Record<string, string>>({});
  const pl = (leaves.data ?? []).filter(l => hist ? l.status !== 'pending' : l.status === 'pending');
  const pf = (fixes.data ?? []).filter(c => hist ? c.status !== 'pending' : c.status === 'pending');
  const done = (msg: string) => { leaves.reload(); fixes.reload(); reload(); toast(msg); };
  const npl = (leaves.data ?? []).filter(l => l.status === 'pending').length, npf = (fixes.data ?? []).filter(c => c.status === 'pending').length;
  return <>
    <Top title="Approvals" sub="Leave requests and attendance fixes"><Seg value={tab} onChange={setTab} options={[['leave', `Leave${npl ? ` (${npl})` : ''}`], ['fix', `Fixes${npf ? ` (${npf})` : ''}`]]} /></Top>
    <div className="page">
      <div className="row"><Seg value={hist ? 'h' : 'p'} onChange={v => setHist(v === 'h')} options={[['p', 'Waiting'], ['h', 'Decided']]} /></div>
      {tab === 'leave' && <section className="card">
        {pl.length ? <div className="list">{pl.map(l => (
          <div className="item" key={l.id} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="avatar">{nameOf(members.data, l.member_id)[0]}</div>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="ttl">{nameOf(members.data, l.member_id)} · {l.half_day ? 'Half day' : `${l.days} day${l.days === 1 ? '' : 's'}`} <span className="tag">{l.leave_type}</span></div>
              <div className="sub">{fmtDate(l.start_date, { weekday: 'short', day: 'numeric', month: 'short' })}{l.end_date !== l.start_date && ` – ${fmtDate(l.end_date, { weekday: 'short', day: 'numeric', month: 'short' })}`}</div>
              <div className="small" style={{ marginTop: 6 }}>“{l.reason}”</div>
              {l.admin_note && <div className="small muted">Note: {l.admin_note}</div>}
              {!hist && <input className="input" style={{ marginTop: 10, padding: '8px 11px', fontSize: 14 }} placeholder="Note to employee (optional)" value={note[l.id] ?? ''} onChange={e => setNote({ ...note, [l.id]: e.target.value })} />}
            </div>
            <div className="row" style={{ gap: 8 }}>
              {hist ? <>
                <StatusPill s={l.status} />
                {l.status === 'approved' && <Busy className="btn ghost sm" run={async () => { await backend.decideLeave(l.id, false, 'Revoked'); done('Leave revoked'); }}>Revoke</Busy>}
              </> : <>
                <Busy className="btn bad sm" run={async () => { await backend.decideLeave(l.id, false, note[l.id] ?? ''); done('Leave rejected'); }}><Icon n="x" />Reject</Busy>
                <Busy className="btn good sm" run={async () => { await backend.decideLeave(l.id, true, note[l.id] ?? ''); done('Leave approved'); }}><Icon n="check" />Approve</Busy>
              </>}
            </div>
          </div>))}</div> : <Empty title={hist ? 'Nothing decided yet' : 'All caught up'}>{hist ? '' : 'No leave requests waiting.'}</Empty>}
      </section>}
      {tab === 'fix' && <section className="card">
        {pf.length ? <div className="list">{pf.map(c => (
          <div className="item" key={c.id} style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div className="avatar">{nameOf(members.data, c.member_id)[0]}</div>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="ttl">{nameOf(members.data, c.member_id)} · {fmtDate(c.work_date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
              <div className="sub num">Asks to set {c.requested_check_in && <b>check-in {c.requested_check_in.slice(0, 5)}</b>}{c.requested_check_in && c.requested_check_out && ' and '}{c.requested_check_out && <b>check-out {c.requested_check_out.slice(0, 5)}</b>} ({settings.timezone})</div>
              <div className="small" style={{ marginTop: 6 }}>“{c.reason}”</div>
              <Link className="small" style={{ color: 'var(--orange-ink)' }} to={`/admin/records?m=${c.member_id}`}>See their records</Link>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {hist ? <StatusPill s={c.status} /> : <>
                <Busy className="btn bad sm" run={async () => { await backend.decideCorrection(c.id, false, ''); done('Fix rejected'); }}><Icon n="x" />Reject</Busy>
                <Busy className="btn good sm" run={async () => { await backend.decideCorrection(c.id, true, ''); done('Fix applied'); }}><Icon n="check" />Apply</Busy>
              </>}
            </div>
          </div>))}</div> : <Empty title={hist ? 'Nothing decided yet' : 'All caught up'}>{hist ? '' : 'No fix requests waiting.'}</Empty>}
      </section>}
    </div>
  </>;
}

// ═════════════ Holidays ═════════════
export function HolidaysPage() {
  const { today, reload } = useApp(); const toast = useToast();
  const hol = useLoad(() => backend.holidays(), []);
  const [year, setYear] = useState(today.slice(0, 4));
  const [review, setReview] = useState<{ title: string; items: (HolidayCandidate & { on: boolean })[] } | null>(null);
  const [date, setDate] = useState(''); const [name, setName] = useState('');
  const [over, setOver] = useState(false); const [reading, setReading] = useState(false);
  const years = useMemo(() => Array.from(new Set([today.slice(0, 4), String(Number(today.slice(0, 4)) + 1), ...(hol.data ?? []).map(h => h.holiday_date.slice(0, 4))])).sort(), [hol.data, today]);
  const list = (hol.data ?? []).filter(h => h.holiday_date.startsWith(year));
  const existing = new Set((hol.data ?? []).map(h => h.holiday_date));

  async function readFile(f: File | undefined) {
    if (!f) return;
    setReading(true);
    try {
      const items = await backend.readHolidayFile(f, Number(year));
      if (!items.length) toast('No dates found in that file. Try a clearer photo or add them below.', true);
      else setReview({ title: `Found ${items.length} holidays in “${f.name}”`, items: items.map(x => ({ ...x, on: !existing.has(x.date) })) });
    } catch (e: any) { toast(e.message, true); }
    setReading(false);
  }
  const done = () => { hol.reload(); reload(); };
  return <>
    <Top title="Holidays" sub="Office holidays never count against anyone’s leave" />
    <div className="page" style={{ maxWidth: 860 }}>
      <div className="grid g2">
        <section className="card">
          <h2>Upload your holiday list <Tip>Take a photo of the printed list or upload the PDF HR sent. PunchIn reads the dates; you tick which to keep. Nothing is saved until you confirm.</Tip></h2>
          <label className={`dropzone ${over ? 'over' : ''}`} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files[0]); }}>
            <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
            <b>{reading ? 'Reading your list…' : 'PDF or photo'}</b>
            <span className="small muted">{reading ? 'This takes about 10 seconds' : 'Tap to choose, or drop the file here'}</span>
          </label>
        </section>
        <section className="card">
          <h2>India public holidays <Tip>From Google’s public holiday calendar. Gazetted holidays are pre-ticked; festivals and observances are listed unticked.</Tip></h2>
          <p className="small muted" style={{ marginBottom: 14 }}>Pick from the official list for {year} — no typing.</p>
          <Busy className="btn primary" run={async () => {
            const items = await backend.publicHolidays(Number(year));
            setReview({ title: `Public holidays ${year}`, items: items.map(x => ({ ...x, on: !!x.gazetted && !existing.has(x.date) })) });
          }}>Show {year} list</Busy>
        </section>
      </div>
      <section className="card">
        <h2>{list.length} holiday{list.length === 1 ? '' : 's'} <Seg value={year} onChange={setYear} options={years.map(y => [y, y] as [string, string])} /></h2>
        {list.length ? <div className="list">{list.map(h => (
          <div className="item" key={h.id}>
            <div className="datechip"><b>{Number(h.holiday_date.slice(8))}</b><small>{fmtDate(h.holiday_date, { month: 'short' })}</small></div>
            <div className="grow"><div className="ttl">{h.name}</div><div className="sub">{fmtDate(h.holiday_date, { weekday: 'long' })}{h.holiday_date >= today && h.holiday_date <= addDays(today, 7) && <> · <Link to={`/announce?date=${h.holiday_date}`}>Announce</Link></>}</div></div>
            <Busy className="btn ghost sm" run={async () => { await backend.deleteHoliday(h.id); done(); toast('Holiday removed'); }}>Remove</Busy>
          </div>))}</div> : <Empty title={`No holidays for ${year}`}>Upload the list or pick public holidays above.</Empty>}
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
          <div className="two">
            <label className="field"><span>Date</span><input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
            <label className="field"><span>Name</span><input className="input" maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Company foundation day" /></label>
          </div>
          <div className="row end"><Busy className="btn ghost" run={async () => { await backend.addHoliday(date, name.trim()); setDate(''); setName(''); done(); toast('Holiday added'); }} disabled={!date || !name.trim()}><Icon n="plus" />Add one</Busy></div>
        </div>
      </section>
    </div>
    {review && <Modal title={review.title} lede="Untick anything your office doesn’t take off. You can fix names and dates." onClose={() => setReview(null)}>
      <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: 16 }}>
        {review.items.map((it, i) => (
          <div className="cand" key={i}>
            <input type="checkbox" checked={it.on} aria-label={`Include ${it.name}`} onChange={e => setReview({ ...review, items: review.items.map((x, j) => j === i ? { ...x, on: e.target.checked } : x) })} />
            <input className="input" type="date" value={it.date} onChange={e => setReview({ ...review, items: review.items.map((x, j) => j === i ? { ...x, date: e.target.value } : x) })} />
            <input className="input nm" value={it.name} maxLength={60} onChange={e => setReview({ ...review, items: review.items.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })} />
            {existing.has(it.date) && <span className="small muted" style={{ gridColumn: '2 / -1' }}>Already in your list</span>}
          </div>))}
      </div>
      <div className="row end">
        <button className="btn ghost" onClick={() => setReview(null)}>Cancel</button>
        <Busy run={async () => {
          const r = await backend.addHolidays(review.items.filter(x => x.on).map(({ date, name }) => ({ date, name })));
          setReview(null); done(); toast(`Added ${r.added} holiday${r.added === 1 ? '' : 's'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}`);
        }} disabled={!review.items.some(x => x.on)}>Add {review.items.filter(x => x.on).length} holidays</Busy>
      </div>
    </Modal>}
  </>;
}

// ═════════════ Settings ═════════════
export function SettingsPage() {
  const { settings, reload } = useApp(); const toast = useToast();
  const [s, setS] = useState<Settings>(settings);
  const up = <K extends keyof Settings>(k: K, v: Settings[K]) => setS(x => ({ ...x, [k]: v }));
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  useEffect(() => { const id = location.hash.split('#')[2]; if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 300); }, []);
  const save = async () => {
    if (s.geofence_enabled && (s.office_lat == null || s.office_lng == null)) throw new Error('Mark the office on the map before turning the check on.');
    const { company_name, timezone, required_minutes, half_day_minutes, weekend_mode, annual_leave_days, shift_start, late_grace_minutes, geofence_enabled, office_lat, office_lng,
      geofence_radius_m, max_gps_accuracy_m, office_end, earliest_checkin, late_marks_per_half_day, reminder_hour, notify_admin_email, whatsapp_group_link, admin_whatsapp_phone, callmebot_apikey } = s;
    await backend.saveSettings({ company_name, timezone, required_minutes, half_day_minutes, weekend_mode, annual_leave_days, shift_start, late_grace_minutes, geofence_enabled, office_lat, office_lng,
      geofence_radius_m, max_gps_accuracy_m, office_end, earliest_checkin, late_marks_per_half_day, reminder_hour, notify_admin_email, whatsapp_group_link, admin_whatsapp_phone, callmebot_apikey });
    reload(); toast('Settings saved');
  };
  return <>
    <Top title="Settings" sub="Rules every report is calculated from" />
    <div className="page" style={{ maxWidth: 860 }}>
      <section className="card">
        <h2>Office timings</h2>
        <label className="field"><span>Company name</span><input className="input" value={s.company_name} maxLength={80} onChange={e => up('company_name', e.target.value)} /></label>
        <div className="two">
          <label className="field"><span>Office opens (shift start)</span><input className="input" type="time" value={s.shift_start.slice(0, 5)} onChange={e => up('shift_start', e.target.value)} /></label>
          <label className="field"><span>Office closes</span><input className="input" type="time" value={s.office_end.slice(0, 5)} onChange={e => up('office_end', e.target.value)} /></label>
          <label className="field"><span>Full-day target <Tip>Hours someone must work for the day to count as “target met” in reports and pie charts.</Tip></span>
            <select className="input" value={s.required_minutes} onChange={e => { const v = Number(e.target.value); setS(x => ({ ...x, required_minutes: v, half_day_minutes: Math.min(x.half_day_minutes, v) })); }}>
              {[360, 420, 450, 480, 510, 540, 570, 600].map(m => <option key={m} value={m}>{fmtDuration(m)}</option>)}</select></label>
          <label className="field"><span>Half-day minimum <Tip>Less than this counts as a half day. Also the target on half-day leave days.</Tip></span>
            <select className="input" value={s.half_day_minutes} onChange={e => up('half_day_minutes', Number(e.target.value))}>
              {[180, 210, 240, 270, 300].filter(m => m <= s.required_minutes).map(m => <option key={m} value={m}>{fmtDuration(m)}</option>)}</select></label>
          <label className="field"><span>Late after (grace minutes)</span><input className="input" type="number" min={0} max={240} value={s.late_grace_minutes} onChange={e => up('late_grace_minutes', Number(e.target.value))} /></label>
          <label className="field"><span>Weekly off</span>
            <select className="input" value={s.weekend_mode} onChange={e => up('weekend_mode', e.target.value as WeekendMode)}>
              <option value="sat_sun">Saturday and Sunday</option><option value="sun">Sunday only</option><option value="none">No weekly off</option></select></label>
          <label className="field"><span>Paid leave per year</span><input className="input" type="number" min={0} max={365} step={0.5} value={s.annual_leave_days} onChange={e => up('annual_leave_days', Number(e.target.value))} /></label>
          <label className="field"><span>Time zone</span>
            <select className="input" value={s.timezone} onChange={e => up('timezone', e.target.value)}>
              {['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'].map(z => <option key={z}>{z}</option>)}</select></label>
        </div>
        <p className="small muted">Need different hours for one person (part-time, night shift, 6-day week)? Open them in People → Edit.</p>
      </section>

      <section className="card">
        <h2>Optional rules <small>off unless you turn them on</small></h2>
        <label className="check"><input type="checkbox" checked={!!s.earliest_checkin} onChange={e => up('earliest_checkin', e.target.checked ? '08:00:00' : null)} />Don’t allow check-in before a set time <Tip>Stops people checking in very early to pad hours.</Tip></label>
        {s.earliest_checkin && <label className="field" style={{ maxWidth: 240 }}><span>Check-in opens at</span><input className="input" type="time" value={s.earliest_checkin.slice(0, 5)} onChange={e => up('earliest_checkin', e.target.value)} /></label>}
        <label className="check"><input type="checkbox" checked={s.late_marks_per_half_day > 0} onChange={e => up('late_marks_per_half_day', e.target.checked ? 3 : 0)} />Count late arrivals as half days <Tip>Common in India: e.g. every 3 late marks = ½ day. Shown in reports only; it never changes leave balances automatically.</Tip></label>
        {s.late_marks_per_half_day > 0 && <label className="field" style={{ maxWidth: 240 }}><span>Late marks per half day</span><input className="input" type="number" min={1} max={31} value={s.late_marks_per_half_day} onChange={e => up('late_marks_per_half_day', Number(e.target.value))} /></label>}
      </section>

      <section className="card" id="location">
        <h2>Office location check <Tip>People can only check in and out inside the circle. Their exact location is never stored — only the distance.</Tip></h2>
        <label className="check"><input type="checkbox" checked={s.geofence_enabled} onChange={e => up('geofence_enabled', e.target.checked)} />Only allow check-in and check-out at the office</label>
        <Busy className="btn ghost" run={async () => { const p = await getPosition(); setS(x => ({ ...x, office_lat: +p.lat.toFixed(6), office_lng: +p.lng.toFixed(6) })); setGeoMsg(`Got it — accurate to about ${Math.round(p.accuracy)} m. Drag the pin to fine-tune, then Save.`); }}><Icon n="pin" />Use my current location</Busy>
        {geoMsg && <p className="small muted" style={{ marginTop: 8 }}>{geoMsg}</p>}
        <div style={{ margin: '14px 0' }}>
          <OfficeMap lat={s.office_lat ?? 19.076} lng={s.office_lng ?? 72.8777} radius={s.geofence_radius_m} editable height={300}
            onPick={(lat, lng) => setS(x => ({ ...x, office_lat: lat, office_lng: lng }))} />
          <p className="small muted" style={{ marginTop: 6 }}>{s.office_lat == null ? 'Tap the map or “Use my current location” to place the office.' : 'Tap the map or drag the pin to move the office.'}</p>
        </div>
        <label className="field"><span>Circle size: <b className="num">{s.geofence_radius_m} m</b> <Tip>100–200 m suits most buildings. Too small and phones indoors may fail; too big and nearby cafés count.</Tip></span>
          <input className="range" type="range" min={30} max={1000} step={10} value={s.geofence_radius_m} onChange={e => up('geofence_radius_m', Number(e.target.value))} /></label>
        <label className="field" style={{ maxWidth: 280 }}><span>Worst GPS accuracy accepted (m)</span><input className="input" type="number" min={5} max={1000} value={s.max_gps_accuracy_m} onChange={e => up('max_gps_accuracy_m', Number(e.target.value))} /></label>
      </section>

      <section className="card" id="whatsapp">
        <h2>Holiday reminders & WhatsApp</h2>
        <p className="small muted" style={{ marginBottom: 14 }}>The evening before every holiday you get a reminder with a one-tap button to announce it on the office group. On the day, everyone sees it in PunchIn.</p>
        <label className="field"><span>Office WhatsApp group invite link <Tip>In WhatsApp: open the group → tap its name → Invite via link → Copy link. Paste it here.</Tip></span>
          <input className="input" placeholder="https://chat.whatsapp.com/…" value={s.whatsapp_group_link} onChange={e => up('whatsapp_group_link', e.target.value)} /></label>
        <div className="two">
          <label className="field"><span>Remind me at</span><select className="input" value={s.reminder_hour} onChange={e => up('reminder_hour', Number(e.target.value))}>{[15, 16, 17, 18, 19, 20, 21].map(h => <option key={h} value={h}>{h > 12 ? h - 12 : h}:00 PM the day before</option>)}</select></label>
          <label className="check" style={{ alignSelf: 'end', marginBottom: 22 }}><input type="checkbox" checked={s.notify_admin_email} onChange={e => up('notify_admin_email', e.target.checked)} />Also email admins</label>
        </div>
        <details style={{ marginBottom: 12 }}><summary className="small" style={{ cursor: 'pointer', fontWeight: 700 }}>Optional: get the reminder on your own WhatsApp too (free)</summary>
          <ol className="small" style={{ margin: '10px 0 12px 18px', lineHeight: 1.6 }}>
            <li>Save <b>+34 644 51 95 23</b> in your phone (CallMeBot, a free reminder service).</li>
            <li>Send it this WhatsApp message: <code>I allow callmebot to send me messages</code></li>
            <li>It replies with an API key — paste it below with your number.</li>
          </ol>
          <div className="two">
            <label className="field"><span>Your WhatsApp number</span><input className="input" placeholder="+91 98765 43210" value={s.admin_whatsapp_phone} onChange={e => up('admin_whatsapp_phone', e.target.value)} /></label>
            <label className="field"><span>CallMeBot API key</span><input className="input" value={s.callmebot_apikey} onChange={e => up('callmebot_apikey', e.target.value)} /></label>
          </div>
          <p className="small muted">This only messages <b>you</b>. Group posting still needs your one tap — WhatsApp doesn’t allow bots in groups.</p>
        </details>
        <Busy className="btn ghost" run={async () => { await save(); const r = await backend.sendTestAlert(); toast(`Test sent: ${r.email} email${r.email === 1 ? '' : 's'}${r.whatsapp ? ' + WhatsApp' : ''}`); }}>Save & send me a test reminder</Busy>
      </section>
      <div className="row end"><Busy run={save}>Save settings</Busy></div>
    </div>
  </>;
}

// ═════════════ Security ═════════════
const TABLE_LABEL: Record<string, string> = { attendance: 'Attendance', leave_requests: 'Leave', correction_requests: 'Fix request', members: 'Person', holidays: 'Holiday', org_settings: 'Settings' };
export function SecurityPage() {
  const { settings } = useApp(); const tz = settings.timezone;
  const members = useLoad(() => backend.members(), []);
  const attempts = useLoad(() => backend.punchAttempts(50), []);
  const log = useLoad(() => backend.auditLog(60), []);
  const [check, setCheck] = useState<Awaited<ReturnType<typeof backend.verifyAudit>> | null>(null);
  return <>
    <Top title="Security" sub="Refused punches and the tamper-evident change log" />
    <div className="page">
      <section className="card">
        <h2>Audit chain</h2>
        <p className="small muted" style={{ marginBottom: 14 }}>Every change in the database is chained to the one before it with a SHA-256 fingerprint. If anyone edits or deletes history behind the app’s back, the check below fails and shows where.</p>
        <Busy run={async () => setCheck(await backend.verifyAudit())}><Icon n="shield" />Verify all records now</Busy>
        {check && (check.broken_at == null
          ? <div className="note good" style={{ marginTop: 14 }}><Icon n="check" /><div>All {check.entries.toLocaleString()} entries intact.<div className="mono" style={{ marginTop: 4, fontWeight: 500 }}>Latest fingerprint {check.last_hash}</div></div></div>
          : <div className="note bad" style={{ marginTop: 14 }}><Icon n="alert" />Tampering detected at entry #{check.broken_at}. Records from that point may have been altered outside the app.</div>)}
      </section>
      <div className="grid g2">
        <section className="card">
          <h2>Refused punches <small>outside office, no location</small></h2>
          {attempts.data?.length ? <div className="list">{attempts.data.map(a => (
            <div className="item" key={a.id}>
              <div className="grow"><div className="ttl">{nameOf(members.data, a.member_id)} · check-{a.kind}</div>
                <div className="sub">{a.reason.replace(/^[A-Z_]+:\s*/, '')}</div></div>
              <div className="right small muted num">{fmtDate(a.attempted_at.slice(0, 10))}<br />{timeInTz(a.attempted_at, tz)}</div>
            </div>))}</div> : <Empty title="None">No refused punches.</Empty>}
        </section>
        <section className="card">
          <h2>Recent changes</h2>
          <div className="list">{(log.data ?? []).map(e => (
            <div className="item" key={e.id}>
              <div className="grow"><div className="ttl">{TABLE_LABEL[e.table_name] ?? e.table_name} {e.action === 'insert' ? 'added' : e.action === 'update' ? 'changed' : 'deleted'}</div>
                <div className="sub">by {e.actor ? nameOf(members.data, e.actor) : 'system'}{e.new_data?.edit_reason ? ` · “${e.new_data.edit_reason}”` : ''}</div></div>
              <div className="right small muted num">#{e.id}<br />{fmtDate(e.at.slice(0, 10))} {timeInTz(e.at, tz)}</div>
            </div>))}</div>
        </section>
      </div>
    </div>
  </>;
}

// ═════════════ More (mobile menu for admins) ═════════════
export function MorePage() {
  const links = [['/admin/records', 'records', 'Records', 'Every day for every person, edits, CSV export'], ['/admin/holidays', 'holidays', 'Holidays', 'Office holidays'],
    ['/admin/settings', 'settings', 'Settings', 'Hours, weekly off, leave, office location'], ['/admin/security', 'shield', 'Security', 'Audit check and refused punches'],
    ['/history', 'history', 'My history', ''], ['/leave', 'leave', 'My leave', ''], ['/fixes', 'fix', 'My fixes', ''], ['/me', 'me', 'Me', 'Profile, install, sign out']];
  return <><Top title="More" /><div className="page"><section className="card"><div className="list">
    {links.map(([to, i, l, d]) => <NavLink key={to} to={to} className="item" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="avatar"><Icon n={i} width={18} height={18} /></div><div className="grow"><div className="ttl">{l}</div>{d && <div className="sub">{d}</div>}</div></NavLink>)}
  </div></section></div></>;
}
