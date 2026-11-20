import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { backend } from '@backend';
import type { Boot } from './lib/types';
import { Icon, ToastProvider } from './ui';
import { Bell, InstallSteps, Tour, markSeen, seen, tourKey, type TourStep } from './extras';
import { TodayPage, HistoryPage, LeavePage, MePage, PrivacyPage, AnnouncePage } from './pages/employee';
import { OverviewPage, PeoplePage, RecordsPage, ApprovalsPage, HolidaysPage, SettingsPage, SecurityPage, MorePage } from './pages/admin';

interface AppCtx extends Boot { reload: () => void; startTour: () => void }
const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => backend.onAuth(setSignedIn), []);
  if (window.top !== window.self) return <div className="framed"><p>PunchIn can’t be opened inside another website. <a href={location.href} target="_top">Open PunchIn</a></p></div>;
  if (!backend.configured) return <SetupNeeded />;
  if (signedIn === null) return <Splash />;
  return (
    <ToastProvider>
      <HashRouter>
        <Routes>
          <Route path="/privacy" element={<div className="page" style={{ maxWidth: 760, margin: '0 auto' }}><PrivacyPage standalone /></div>} />
          <Route path="/join" element={<JoinPage signedIn={signedIn} />} />
          <Route path="*" element={signedIn ? <Session /> : <AuthScreen />} />
        </Routes>
      </HashRouter>
    </ToastProvider>
  );
}

function OrgName() {
  const [n, setN] = useState<string | null>(null);
  useEffect(() => { backend.orgName().then(setN).catch(() => {}); }, []);
  return n ? <div className="org-chip"><Icon n="people" />{n}</div> : null;
}

function Splash() { return <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>; }
function SetupNeeded() {
  return <div className="center-screen"><div className="card" style={{ maxWidth: 460 }}>
    <h2>PunchIn is almost ready</h2><p className="muted">This copy is not connected to its server yet. See the set-up steps in the project README.</p>
  </div></div>;
}

function AuthArt() {
  return (
    <div className="auth-art">
      <div className="brand" style={{ padding: 0 }}><img src="./icon.svg" alt="" /><b style={{ color: '#fff' }}>PunchIn</b></div>
      <div><h2>Your day, on the clock.</h2><p className="hide-m">Check in from the office, see your hours fill up, and handle leave without chasing anyone on chat.</p></div>
      <span className="hide-m small" style={{ opacity: .85 }}>Times are stamped by the server, not your phone. <a href="#/privacy" style={{ color: '#fff' }}>Privacy</a></span>
      <svg className="rings" viewBox="0 0 100 100" fill="none" stroke="#fff" strokeWidth="6"><circle cx="50" cy="50" r="44" /><circle cx="50" cy="50" r="28" /></svg>
    </div>
  );
}

function AuthScreen({ initial }: { initial?: { email: string; code: string } }) {
  const [mode, setMode] = useState<'in' | 'up'>(initial ? 'up' : 'in');
  const [email, setEmail] = useState(initial?.email ?? ''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [code, setCode] = useState(initial?.code ?? '');
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    if (mode === 'up' && pw !== pw2) return setMsg('Passwords do not match.');
    if (pw.length < 8) return setMsg('Password needs at least 8 characters.');
    setBusy(true);
    try { mode === 'in' ? await backend.signIn(email, pw) : await backend.signUp(email, pw, code); }
    catch (err: any) { setMsg(err.message); }
    setBusy(false);
  }
  return (
    <div className="auth">
      <AuthArt />
      <div className="auth-form">
        <form onSubmit={submit}>
          <OrgName />
          <h1>{mode === 'in' ? 'Sign in' : 'Set your password'}</h1>
          <p className="muted" style={{ marginBottom: 22 }}>{mode === 'up' ? 'Use your office email and the 8-letter code your admin sent you. Works for first sign-in and for a forgotten password.' : 'Use your office email.'}</p>
          <label className="field"><span>Office email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" /></label>
          {mode === 'up' && <label className="field"><span>Code from your admin</span><input className="input" required autoComplete="one-time-code" autoCapitalize="characters" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="e.g. K7QM4XPA" style={{ letterSpacing: '.12em', fontWeight: 700 }} /></label>}
          <label className="field"><span>{mode === 'up' ? 'New password' : 'Password'}</span><input className="input" type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required value={pw} onChange={e => setPw(e.target.value)} /></label>
          {mode === 'up' && <label className="field"><span>Repeat password</span><input className="input" type="password" autoComplete="new-password" required value={pw2} onChange={e => setPw2(e.target.value)} /></label>}
          {msg && <div className="note bad" role="alert" style={{ marginBottom: 14 }}>{msg}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Save password & sign in'}</button>
          <div className="row between" style={{ marginTop: 16 }}>
            {mode === 'in' ? <button type="button" className="linkbtn" onClick={() => setMode('up')}>First time or forgot password?</button>
              : <button type="button" className="linkbtn" onClick={() => setMode('in')}>Back to sign in</button>}
            <a className="linkbtn" href="#/privacy">Privacy</a>
          </div>
        </form>
      </div>
    </div>
  );
}

// Invite link from WhatsApp: #/join?e=<email>&c=<code> → set password → install the app.
function JoinPage({ signedIn }: { signedIn: boolean }) {
  const q = new URLSearchParams(useLocation().search);
  const email = (q.get('e') ?? '').slice(0, 120), code = (q.get('c') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!signedIn) return <AuthScreen key={email + code} initial={{ email, code }} />;
  return (
    <div className="auth">
      <AuthArt />
      <div className="auth-form"><div style={{ width: '100%', maxWidth: 380 }}>
        <div className="note good" style={{ marginBottom: 18 }}><Icon n="check" />Password saved — you’re in.</div>
        <h1 style={{ fontSize: 26 }}>Now add PunchIn to your phone</h1>
        <p className="muted" style={{ margin: '6px 0 18px' }}>It opens like any other app, full screen, with one tap from your home screen.</p>
        <InstallSteps />
        <a className="btn ghost block" style={{ marginTop: 14 }} href="#/">Continue in the browser</a>
      </div></div>
    </div>
  );
}

const EMP_TOUR: TourStep[] = [
  { target: 'punch', title: 'Check in and out here', body: 'Tap once when you arrive and once when you leave. The ring fills up as your hours add up — it turns green when you hit your daily target.' },
  { target: 'map', title: 'Your office area', body: 'Check-in only works near the office. Tap “Am I inside?” any time to see where you are on the map.' },
  { target: 'week', title: 'Your week at a glance', body: 'Each bar shows the hours you worked that day.' },
  { target: 'month', title: 'This month', body: 'How many days you met your daily target, and how many times you were late.' },
  { target: 'nav-leave', title: 'Apply for leave', body: 'Pick dates — weekends and office holidays are never counted against you.' },
  { target: 'nav-history', title: 'Forgot to check out?', body: 'Open History and tap “Fix” on that day — your admin approves it.' },
  { target: 'bell', title: 'Notifications', body: 'Holiday notices and reminders show up here.' },
];
const ADMIN_TOUR: TourStep[] = [
  { target: 'setup', title: 'Your set-up checklist', body: 'Five quick steps. Each one opens the right screen. The list disappears once everything is done.' },
  { target: 'nav-approvals', title: 'Approvals', body: 'Leave requests and check-in fixes wait here. The number shows how many need you.' },
  { target: 'nav-people', title: 'People', body: 'Add staff by email. You get a code to send on WhatsApp — the app does the rest.' },
  { target: 'nav-holidays', title: 'Holidays', body: 'Upload your holiday PDF or photo, or tick India’s public holidays — no typing.' },
  { target: 'nav-settings', title: 'Settings', body: 'Office hours, weekly off, the office map circle and WhatsApp reminders.' },
  { target: 'bell', title: 'Reminders', body: 'The evening before a holiday you’ll get a reminder here and by email to announce it on WhatsApp.' },
];

function Session() {
  const [boot, setBoot] = useState<Boot | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [touring, setTouring] = useState(false);
  const load = useCallback(() => { backend.bootstrap().then(b => { setBoot(b); setErr(null); }).catch(e => setErr(e.message)); }, []);
  useEffect(load, [load]);
  // refresh when the app comes back to the foreground
  useEffect(() => { const f = () => document.visibilityState === 'visible' && load(); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, [load]);
  useEffect(() => {
    if (!boot) return;
    const k = tourKey(boot.me.id, boot.me.role);
    if (!seen(k)) { const t = setTimeout(() => setTouring(true), 900); return () => clearTimeout(t); }
  }, [boot]);

  if (boot === undefined) return err ? <div className="center-screen"><div className="card" style={{ maxWidth: 420 }}><h2>Can’t reach PunchIn</h2><p className="muted" style={{ marginBottom: 14 }}>{err}</p><button className="btn primary" onClick={load}>Try again</button></div></div> : <Splash />;
  if (!boot) return <NotMember />;
  const admin = boot.me.role === 'admin';
  const ctx: AppCtx = { ...boot, reload: load, startTour: () => setTouring(true) };
  const endTour = () => { setTouring(false); markSeen(tourKey(boot.me.id, boot.me.role)); if (admin && !seen(tourKey(boot.me.id, 'employee'))) markSeen(tourKey(boot.me.id, 'employee')); };
  return (
    <Ctx.Provider value={ctx}>
      <div className="shell">
        <Side admin={admin} />
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to={admin ? '/admin' : '/today'} replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/leave" element={<LeavePage />} />
            <Route path="/fixes" element={<HistoryPage />} />
            <Route path="/me" element={<MePage />} />
            {admin && <>
              <Route path="/admin" element={<OverviewPage />} />
              <Route path="/admin/people" element={<PeoplePage />} />
              <Route path="/admin/records" element={<RecordsPage />} />
              <Route path="/admin/approvals" element={<ApprovalsPage />} />
              <Route path="/admin/holidays" element={<HolidaysPage />} />
              <Route path="/admin/settings" element={<SettingsPage />} />
              <Route path="/admin/security" element={<SecurityPage />} />
              <Route path="/announce" element={<AnnouncePage />} />
              <Route path="/more" element={<MorePage />} />
            </>}
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        <BottomNav admin={admin} />
      </div>
      {touring && <Tour steps={admin ? ADMIN_TOUR : EMP_TOUR} onDone={endTour} />}
    </Ctx.Provider>
  );
}

export function TopActions() {
  const { notifications } = useApp(); const nav = useNavigate();
  return <div className="top-actions"><Bell items={notifications} onOpen={n => n.link && nav(n.link.replace(/^#/, ''))} /></div>;
}

function NotMember() {
  return <div className="center-screen"><div className="card" style={{ maxWidth: 420 }}>
    <h2>No access</h2><p className="muted" style={{ marginBottom: 16 }}>Your account is blocked or has been removed. Contact your admin.</p>
    <button className="btn ghost" onClick={() => backend.signOut()}>Sign out</button>
  </div></div>;
}

const EMP_NAV = [['/today', 'today', 'Today'], ['/history', 'history', 'History'], ['/leave', 'leave', 'Leave'], ['/me', 'me', 'Me']] as const;
const ADMIN_NAV = [['/admin', 'overview', 'Overview'], ['/admin/approvals', 'approvals', 'Approvals'], ['/admin/people', 'people', 'People'], ['/admin/records', 'records', 'Records'],
  ['/admin/holidays', 'holidays', 'Holidays'], ['/admin/settings', 'settings', 'Settings'], ['/admin/security', 'shield', 'Security']] as const;
const tourId = (to: string) => 'nav-' + (to.split('/').pop() || 'today');

function Side({ admin }: { admin: boolean }) {
  const { me, settings, pending } = useApp();
  return (
    <nav className="side" aria-label="Main">
      <div className="brand"><img src="./icon.svg" alt="" /><div><b>Punch<span>In</span></b><small>{settings.company_name}</small></div></div>
      {admin && <div className="navsec">My day</div>}
      {EMP_NAV.slice(0, 3).map(([to, i, l]) => <NavLink key={to} to={to} end className="navlink" data-tour={tourId(to)}><Icon n={i} />{l}</NavLink>)}
      {admin && <><div className="navsec">Team</div>
        {ADMIN_NAV.map(([to, i, l]) => <NavLink key={to} to={to} end className="navlink" data-tour={tourId(to)}><Icon n={i} />{l}{to === '/admin/approvals' && (pending ?? 0) > 0 && <span className="count">{pending}</span>}</NavLink>)}</>}
      <div className="grow" />
      <NavLink to="/me" className="whoami" style={{ textDecoration: 'none', color: 'inherit', borderRadius: 12 }}>
        <div className="avatar">{me.nickname[0]?.toUpperCase()}</div>
        <div className="t"><b>{me.nickname}</b><small>{admin ? 'Admin' : 'Employee'}</small></div>
      </NavLink>
    </nav>
  );
}

function BottomNav({ admin }: { admin: boolean }) {
  const { pending } = useApp();
  const items = admin
    ? [['/today', 'today', 'Today'], ['/admin', 'overview', 'Team'], ['/admin/approvals', 'approvals', 'Approve'], ['/admin/people', 'people', 'People'], ['/more', 'more', 'More']]
    : EMP_NAV;
  return <nav className="bottomnav" aria-label="Main">{items.map(([to, i, l]) =>
    <NavLink key={to} to={to} end data-tour={tourId(to)}><Icon n={i} />{l}{to === '/admin/approvals' && (pending ?? 0) > 0 && <span className="dot" />}</NavLink>)}</nav>;
}
