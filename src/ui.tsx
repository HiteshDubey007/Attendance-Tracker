import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Doughnut } from 'react-chartjs-2';
import { Chart as ChartJS, ArcElement, Tooltip, BarElement, CategoryScale, LinearScale, Legend, LineElement, PointElement, Filler } from 'chart.js';
import { KIND_LABEL, KIND_TONE } from './lib/time';

ChartJS.register(ArcElement, Tooltip, BarElement, CategoryScale, LinearScale, Legend, LineElement, PointElement, Filler);
ChartJS.defaults.font.family = 'Manrope, system-ui, sans-serif';
ChartJS.defaults.color = '#7a6f65';

export const C = { orange: '#F26B1D', orangeSoft: '#FBC9A8', ink: '#1C1712', line: '#ECE6E0', good: '#1E8456', bad: '#C2362B', canvas: '#F3F0EC' };

// ── Icons (simple strokes, 24px grid) ──
const P: Record<string, string> = {
  today: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  history: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  leave: 'M17 8c0 5-5 13-5 13S7 13 7 8a5 5 0 0 1 10 0ZM12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  fix: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5Z',
  me: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  overview: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  records: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 13h6M9 17h4',
  approvals: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  holidays: 'M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 14.3 7.2 16.9l.9-5.4-3.9-3.8 5.4-.8L12 2Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10ZM9 12l2 2 4-4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  pin: 'M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12ZM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  plus: 'M12 5v14M5 12h14', download: 'M12 3v12M7 10l5 5 5-5M5 21h14', alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'M20 6 9 17l-5-5', x: 'M18 6 6 18M6 6l12 12', out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
};
export const Icon = ({ n, ...rest }: { n: string } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}><path d={P[n]} /></svg>
);

export const Pill = ({ kind, children }: { kind?: string; children?: ReactNode }) =>
  <span className={`pill ${KIND_TONE[kind ?? ''] ?? kind ?? 'mute'}`}>{children ?? KIND_LABEL[kind ?? ''] ?? kind}</span>;

export const StatusPill = ({ s }: { s: string }) =>
  <span className={`pill ${s === 'approved' || s === 'active' ? 'good' : s === 'rejected' || s === 'blocked' ? 'bad' : s === 'pending' ? 'orange' : 'mute'}`}>{s[0].toUpperCase() + s.slice(1)}</span>;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export function Modal({ title, lede, onClose, children }: { title: string; lede?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal aria-label={title}>
        <h3>{title}</h3>{lede && <p className="lede">{lede}</p>}{children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad?: boolean; id: number } | null>(null);
  const show = useCallback((msg: string, bad?: boolean) => setT({ msg, bad, id: Date.now() }), []);
  useEffect(() => { if (!t) return; const h = setTimeout(() => setT(null), 3800); return () => clearTimeout(h); }, [t]);
  return <ToastCtx.Provider value={show}>{children}{t && <div key={t.id} className={`toast ${t.bad ? 'bad' : ''}`} role="status">{t.msg}</div>}</ToastCtx.Provider>;
}

/** Loads async data; re-runs when deps change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T>(); const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true; setLoading(true);
    fn().then(d => { if (live) { setData(d); setError(null); } }).catch(e => live && setError(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN(x => x + 1), loading };
}

export function Busy({ run, children, className = 'btn primary', disabled, ...rest }: { run: () => Promise<unknown>; children: ReactNode; className?: string; disabled?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const [b, setB] = useState(false); const toast = useToast();
  return <button {...rest} className={className} disabled={b || disabled} onClick={async () => {
    setB(true); try { await run(); } catch (e: any) { toast(e.message, true); } finally { setB(false); }
  }}>{b ? '…' : children}</button>;
}

export function Donut({ parts, center, size = 170 }: { parts: { label: string; value: number; color: string }[]; center?: ReactNode; size?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <Doughnut data={{ labels: parts.map(p => p.label), datasets: [{ data: total ? parts.map(p => p.value) : [1], backgroundColor: total ? parts.map(p => p.color) : [C.canvas], borderWidth: 0, borderRadius: 4, spacing: total ? 2 : 0 }] }}
        options={{ cutout: '72%', plugins: { legend: { display: false }, tooltip: { enabled: total > 0 } }, maintainAspectRatio: false, animation: { duration: 600 } }} />
      {center && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', pointerEvents: 'none' }}>{center}</div>}
    </div>
  );
}

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return <div className="seg" role="tablist">{options.map(([v, l]) => <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>;
}
