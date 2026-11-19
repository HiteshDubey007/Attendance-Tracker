import { createContext, useContext, useEffect, useState, type FormEvent } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { backend } from '@backend';
import type { Member, Settings } from './lib/types';
import { dateInTz } from './lib/time';
import { Icon, ToastProvider, useLoad } from './ui';
import { TodayPage, HistoryPage, LeavePage, FixesPage, MePage } from './pages/employee';
import { OverviewPage, PeoplePage, RecordsPage, ApprovalsPage, HolidaysPage, SettingsPage, SecurityPage, MorePage } from './pages/admin';

interface AppCtx { me: Member; settings: Settings; today: string; reloadSettings: () => void; pending: number; reloadPending: () => void }
const Ctx = createContext<AppCtx>(null!);
export const useApp = () => useContext(Ctx);

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => backend.onAuth(setSignedIn), []);
  if (!backend.configured) return <SetupNeeded />;
  if (signedIn === null) return <Splash />;
  return <ToastProvider>{signedIn ? <Session /> : <AuthScreen />}</ToastProvider>;
}

function Splash() { return <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>; }

function SetupNeeded() {
  return <div className="center-screen"><div className="card" style={{ maxWidth: 460 }}>
    <h2>PunchIn is almost ready</h2>
    <p className="muted">This copy is not connected to its database yet. The administrator needs to finish the setup steps in the project’s README (add the Supabase address and public key to <code>config.json</code>).</p>
  </div></div>;
}

function AuthScreen() {
  const [mode, setMode] = useState<'in' | 'up' | 'reset'>('in');
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [pw2, setPw2] = useState('');
  const [msg, setMsg] = useState<{ t: string; ok?: boolean } | null>(null); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    if (mode === 'up' && pw !== pw2) return setMsg({ t: 'Passwords do not match.' });
    if (mode !== 'reset' && pw.length < 8) return setMsg({ t: 'Password needs at least 8 characters.' });
    setBusy(true);
    try {
      if (mode === 'in') await backend.signIn(email, pw);
      else if (mode === 'up') await backend.signUp(email, pw);
      else { await backend.resetPassword(email); setMsg({ t: 'Reset link sent. Check your inbox.', ok: true }); }
    } catch (err: any) { setMsg({ t: err.message, ok: /Account created/.test(err.message) }); }
    setBusy(false);
  }
  return (
    <div className="auth">
      <div className="auth-art">
        <div className="brand" style={{ padding: 0 }}><img src="./icon.svg" alt="" /><b style={{ color: '#fff' }}>PunchIn</b></div>
        <div><h2>Your day, on the clock.</h2><p className="hide-m">Check in from the office, see your hours fill up, and handle leave without chasing anyone on chat.</p></div>
        <span className="hide-m small" style={{ opacity: .8 }}>Times are stamped by the server, not your phone.</span>
        <svg className="rings" viewBox="0 0 100 100" fill="none" stroke="#fff" strokeWidth="6"><circle cx="50" cy="50" r="44" /><circle cx="50" cy="50" r="28" /></svg>
      </div>
      <div className="auth-form">
        <form onSubmit={submit}>
          <h1>{mode === 'in' ? 'Sign in' : mode === 'up' ? 'First time here' : 'Reset password'}</h1>
          <p className="muted" style={{ marginBottom: 22 }}>{mode === 'up' ? 'Use the office email your admin added, and choose a password.' : mode === 'reset' ? 'We’ll email you a link to set a new password.' : 'Use your office email.'}</p>
          <label className="field"><span>Office email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" /></label>
          {mode !== 'reset' && <label className="field"><span>Password</span><input className="input" type="password" autoComplete={mode === 'up' ? 'new-password' : 'current-password'} required value={pw} onChange={e => setPw(e.target.value)} /></label>}
          {mode === 'up' && <label className="field"><span>Repeat password</span><input className="input" type="password" autoComplete="new-password" required value={pw2} onChange={e => setPw2(e.target.value)} /></label>}
          {msg && <div className={`note ${msg.ok ? 'good' : 'bad'}`} style={{ marginBottom: 14 }}>{msg.t}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : mode === 'up' ? 'Create my account' : 'Send reset link'}</button>
          <div className="row between" style={{ marginTop: 16 }}>
            {mode === 'in' ? <button type="button" className="linkbtn" onClick={() => setMode('up')}>First time? Set up your account</button>
              : <button type="button" className="linkbtn" onClick={() => setMode('in')}>Back to sign in</button>}
            {mode === 'in' && <button type="button" className="linkbtn" onClick={() => setMode('reset')}>Forgot password</button>}
          </div>
        </form>
      </div>
    </div>
  );
}

function Session() {
  const me = useLoad(() => backend.me(), []);
  const [sv, setSv] = useState(0);
  const settings = useLoad(() => backend.settings(), [sv]);
  const clock = useLoad(() => backend.serverTime(), []);
  const [pv, setPv] = useState(0);
  const pending = useLoad(async () => {
    if (me.data?.role !== 'admin') return 0;
    const [l, c] = await Promise.all([backend.leaves(), backend.corrections()]);
    return l.filter(x => x.status === 'pending').length + c.filter(x => x.status === 'pending').length;
  }, [me.data?.role, pv]);

  if (me.loading || settings.loading && !settings.data) return <Splash />;
  if (!me.data) return <NotMember />;
  if (!settings.data) return <div className="center-screen"><p>{settings.error ?? 'Could not load settings.'}</p></div>;
  const tz = settings.data.timezone;
  const today = dateInTz(clock.data ? new Date(clock.data) : new Date(), tz);
  const ctx: AppCtx = { me: me.data, settings: settings.data, today, reloadSettings: () => setSv(x => x + 1), pending: pending.data ?? 0, reloadPending: () => setPv(x => x + 1) };
  const admin = me.data.role === 'admin';
  return (
    <Ctx.Provider value={ctx}>
      <HashRouter>
        <div className="shell">
          <Side admin={admin} />
          <main className="main">
            <Routes>
              <Route path="/" element={<TodayPage />} />
              <Route path="/history" element={<HistoryPage />} />
              <Route path="/leave" element={<LeavePage />} />
              <Route path="/fixes" element={<FixesPage />} />
              <Route path="/me" element={<MePage />} />
              {admin && <>
                <Route path="/admin" element={<OverviewPage />} />
                <Route path="/admin/people" element={<PeoplePage />} />
                <Route path="/admin/records" element={<RecordsPage />} />
                <Route path="/admin/approvals" element={<ApprovalsPage />} />
                <Route path="/admin/holidays" element={<HolidaysPage />} />
                <Route path="/admin/settings" element={<SettingsPage />} />
                <Route path="/admin/security" element={<SecurityPage />} />
                <Route path="/more" element={<MorePage />} />
              </>}
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
          <BottomNav admin={admin} />
        </div>
      </HashRouter>
    </Ctx.Provider>
  );
}

function NotMember() {
  return <div className="center-screen"><div className="card" style={{ maxWidth: 420 }}>
    <h2>No access</h2><p className="muted" style={{ marginBottom: 16 }}>Your account is blocked or has been removed. Contact your admin.</p>
    <button className="btn ghost" onClick={() => backend.signOut()}>Sign out</button>
  </div></div>;
}

const EMP_NAV = [['/', 'today', 'Today'], ['/history', 'history', 'History'], ['/leave', 'leave', 'Leave'], ['/fixes', 'fix', 'Fixes'], ['/me', 'me', 'Me']] as const;
const ADMIN_NAV = [['/admin', 'overview', 'Overview'], ['/admin/approvals', 'approvals', 'Approvals'], ['/admin/people', 'people', 'People'], ['/admin/records', 'records', 'Records'],
  ['/admin/holidays', 'holidays', 'Holidays'], ['/admin/settings', 'settings', 'Settings'], ['/admin/security', 'shield', 'Security']] as const;

function Side({ admin }: { admin: boolean }) {
  const { me, settings, pending } = useApp();
  return (
    <nav className="side" aria-label="Main">
      <div className="brand"><img src="./icon.svg" alt="" /><div><b>Punch<span>In</span></b><small>{settings.company_name}</small></div></div>
      {admin && <div className="navsec">My day</div>}
      {EMP_NAV.slice(0, 4).map(([to, i, l]) => <NavLink key={to} to={to} end className="navlink"><Icon n={i} />{l}</NavLink>)}
      {admin && <><div className="navsec">Team</div>
        {ADMIN_NAV.map(([to, i, l]) => <NavLink key={to} to={to} end className="navlink"><Icon n={i} />{l}{to === '/admin/approvals' && pending > 0 && <span className="count">{pending}</span>}</NavLink>)}</>}
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
    ? [['/', 'today', 'Today'], ['/admin', 'overview', 'Team'], ['/admin/approvals', 'approvals', 'Approve'], ['/admin/people', 'people', 'People'], ['/more', 'more', 'More']]
    : EMP_NAV;
  return <nav className="bottomnav" aria-label="Main">{items.map(([to, i, l]) =>
    <NavLink key={to} to={to} end><Icon n={i} />{l}{to === '/admin/approvals' && pending > 0 && <span className="dot" />}</NavLink>)}</nav>;
}
