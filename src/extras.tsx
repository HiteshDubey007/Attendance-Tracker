import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from './ui';
import type { Notice } from './lib/types';

// ═════════ Office map: the allowed check-in circle, optionally "you are here" ═════════
export function OfficeMap({ lat, lng, radius, me, editable, onPick, height = 220 }: {
  lat: number; lng: number; radius: number; me?: { lat: number; lng: number; accuracy: number } | null;
  editable?: boolean; onPick?: (lat: number, lng: number) => void; height?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const pick = useRef(onPick); pick.current = onPick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([lat, lng], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    if (editable) m.on('click', (e: L.LeafletMouseEvent) => pick.current?.(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)));
    map.current = m;
    return () => { m.stop(); m.off(); m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current; if (!m || !g) return;
    g.clearLayers();
    const circle = L.circle([lat, lng], { radius, color: '#F26B1D', weight: 2, fillColor: '#F26B1D', fillOpacity: 0.14 }).addTo(g);
    const office = L.circleMarker([lat, lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#F26B1D', fillOpacity: 1 }).addTo(g).bindTooltip('Office');
    if (editable) {
      const icon = L.divIcon({ className: 'pin-icon', html: '<span></span>', iconSize: [30, 30], iconAnchor: [15, 30] });
      const pin = L.marker([lat, lng], { draggable: true, keyboard: true, title: 'Office — drag to move', icon }).addTo(g);
      pin.on('dragend', () => { const p = pin.getLatLng(); pick.current?.(+p.lat.toFixed(6), +p.lng.toFixed(6)); });
      office.remove();
    }
    let bounds = circle.getBounds();
    if (me) {
      const inside = L.latLng(lat, lng).distanceTo([me.lat, me.lng]) <= radius;
      const c = inside ? '#1E8456' : '#C2362B';
      L.circle([me.lat, me.lng], { radius: Math.min(me.accuracy, 300), color: c, weight: 1, fillColor: c, fillOpacity: 0.08, dashArray: '4 4' }).addTo(g);
      L.circleMarker([me.lat, me.lng], { radius: 7, color: '#fff', weight: 3, fillColor: c, fillOpacity: 1 }).addTo(g).bindTooltip('You');
      bounds = bounds.extend([me.lat, me.lng]);
    }
    m.fitBounds(bounds, { padding: [24, 24], maxZoom: 18, animate: false });
  }, [lat, lng, radius, me, editable]);

  return <div ref={el} className="map" style={{ height }} role="img" aria-label={`Map: office check-in area, ${radius} metre radius`} />;
}

// ═════════ Tips ("i" buttons) ═════════
export function Tip({ children, label = 'What is this?' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="tip">
      <button type="button" className="tip-btn" aria-label={label} aria-expanded={open} onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}>i</button>
      {open && <span className="tip-pop" role="tooltip" onClick={() => setOpen(false)}>{children}</span>}
    </span>
  );
}

// ═════════ Guided tour: spotlights elements marked data-tour="…" ═════════
export interface TourStep { target: string; title: string; body: string }
export function Tour({ steps, onDone }: { steps: TourStep[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const find = (t: string) => [...document.querySelectorAll<HTMLElement>(`[data-tour="${t}"]`)].find(e => e.getClientRects().length > 0) ?? null;
  const visible = steps.filter(s => find(s.target));
  const step = visible[i];
  useLayoutEffect(() => {
    if (!step) return;
    const el = find(step.target);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const t = setTimeout(() => setBox(el.getBoundingClientRect()), 350);
    const onResize = () => setBox(el.getBoundingClientRect());
    addEventListener('resize', onResize);
    return () => { clearTimeout(t); removeEventListener('resize', onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => { if (!visible.length) onDone(); }, [visible.length, onDone]);
  if (!step) return null;
  const pad = 8, vw = innerWidth, vh = innerHeight;
  const below = box ? box.bottom + 190 < vh : true;
  const top = box ? (below ? box.bottom + pad + 10 : Math.max(12, box.top - pad - 10 - 170)) : vh / 2 - 80;
  const left = Math.min(Math.max(12, (box ? box.left + box.width / 2 : vw / 2) - 160), vw - 332);
  const last = i === visible.length - 1;
  return (
    <div className="tour" role="dialog" aria-modal aria-label={`Tour step ${i + 1} of ${visible.length}: ${step.title}`}>
      {box && <div className="tour-hole" style={{ top: box.top - pad, left: box.left - pad, width: box.width + pad * 2, height: box.height + pad * 2 }} />}
      <div className="tour-card" style={{ top, left }}>
        <div className="tour-count">{i + 1} / {visible.length}</div>
        <h4>{step.title}</h4>
        <p>{step.body}</p>
        <div className="row between" style={{ marginTop: 12 }}>
          <button className="linkbtn" onClick={onDone}>Skip tour</button>
          <div className="row" style={{ gap: 8 }}>
            {i > 0 && <button className="btn ghost sm" onClick={() => setI(i - 1)}>Back</button>}
            <button className="btn primary sm" autoFocus onClick={() => (last ? onDone() : setI(i + 1))}>{last ? 'Got it' : 'Next'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
export const tourKey = (userId: string, name: string) => `punchin.tour.${name}.${userId}`;
export const seen = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return true; } };
export const markSeen = (k: string) => { try { localStorage.setItem(k, '1'); } catch { /* ignore */ } };
export const forget = (prefix: string) => { try { Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ } };

// ═════════ Notifications bell ═════════
const SEEN_KEY = 'punchin.notices.seen';
export function Bell({ items, onOpen }: { items: Notice[]; onOpen: (n: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(() => { try { return localStorage.getItem(SEEN_KEY) ?? ''; } catch { return ''; } });
  const unread = items.filter(n => n.created_at > last).length;
  const toggle = () => {
    setOpen(o => !o);
    if (!open && items[0]) { try { localStorage.setItem(SEEN_KEY, items[0].created_at); } catch { /* ignore */ } setTimeout(() => setLast(items[0].created_at), 1500); }
  };
  return (
    <div className="bell" data-tour="bell">
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} new` : ''}`} aria-expanded={open} onClick={toggle}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {unread > 0 && <span className="badge num">{unread}</span>}
      </button>
      {open && <>
        <div className="bell-back" onClick={() => setOpen(false)} />
        <div className="bell-pop" role="menu">
          <div className="bell-head">Notifications</div>
          {items.length ? items.map(n => (
            <button key={n.id} role="menuitem" className={`bell-item ${n.created_at > last ? 'new' : ''}`} onClick={() => { setOpen(false); onOpen(n); }}>
              <b>{n.title}</b><span>{n.body}</span>
              <small>{new Date(n.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small>
            </button>
          )) : <div className="empty" style={{ padding: 20 }}>Nothing yet.</div>}
        </div>
      </>}
    </div>
  );
}

// ═════════ App install ═════════
type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferred: BIP | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e as BIP; installListeners.forEach(f => f()); });
  addEventListener('appinstalled', () => { deferred = null; installListeners.forEach(f => f()); });
}
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const platform = (): 'ios' | 'android' | 'desktop' => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /android/i.test(navigator.userAgent) ? 'android' : 'desktop';
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force(x => x + 1); installListeners.add(f); return () => { installListeners.delete(f); }; }, []);
  return {
    installed: isStandalone(),
    canPrompt: !!deferred,
    async prompt() { if (!deferred) return false; await deferred.prompt(); const r = await deferred.userChoice; deferred = null; force(x => x + 1); return r.outcome === 'accepted'; },
  };
}
export function InstallSteps() {
  const p = platform(), ins = useInstall();
  if (ins.installed) return <div className="note good"><Icon n="check" />PunchIn is installed on this device.</div>;
  if (ins.canPrompt) return <button className="btn primary block" onClick={() => ins.prompt()}><Icon n="download" />Install PunchIn app</button>;
  if (p === 'ios') return (
    <ol className="steps">
      <li><span className="stepnum">1</span>Tap the <b>Share</b> button <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: '-3px' }}><path d="M12 3v12M7 8l5-5 5 5M5 13v7h14v-7" /></svg> at the bottom of Safari.</li>
      <li><span className="stepnum">2</span>Scroll and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li><span className="stepnum">3</span>Open <b>PunchIn</b> from your home screen and sign in.</li>
    </ol>
  );
  if (p === 'android') return (
    <ol className="steps">
      <li><span className="stepnum">1</span>Open this page in <b>Chrome</b>.</li>
      <li><span className="stepnum">2</span>Tap <b>⋮</b> (top right) → <b>Install app</b>.</li>
      <li><span className="stepnum">3</span>Open <b>PunchIn</b> from your home screen.</li>
    </ol>
  );
  return <p className="small muted">On a computer, click the install icon <b>⊕</b> at the right end of Chrome’s address bar — or just keep this page bookmarked.</p>;
}

// ═════════ Location: explain before the phone asks ═════════
const PRIMED = 'punchin.location.explained';
export const locationExplained = () => { try { return localStorage.getItem(PRIMED) === '1'; } catch { return true; } };
export function LocationPrimer({ onOk, onCancel }: { onOk: () => void; onCancel: () => void }) {
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal aria-label="Location permission">
        <div className="primer-icon"><Icon n="pin" /></div>
        <h3>Your office uses a location check</h3>
        <p className="lede">Your phone will ask to share your location. PunchIn only checks it at the moment you tap Check in or Check out.</p>
        <ul className="checklist">
          <li><Icon n="check" />Used once per tap — never tracked in the background</li>
          <li><Icon n="check" />Your exact position is thrown away; only “42 m from office” is kept</li>
          <li><Icon n="check" />No camera, microphone, contacts or photos — ever</li>
        </ul>
        <div className="row end" style={{ marginTop: 18 }}>
          <button className="btn ghost" onClick={onCancel}>Not now</button>
          <button className="btn primary" onClick={() => { try { localStorage.setItem(PRIMED, '1'); } catch { /* ignore */ } onOk(); }}>Continue</button>
        </div>
      </div>
    </div>
  );
}
