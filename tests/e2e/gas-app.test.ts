// END-TO-END: the real built app in a real browser, talking to the real gas/Code.js over HTTP,
// exactly as it will with Google. Walks the full first-day story on a phone-sized screen.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { loadGas } from '../gas/shim';

const g = loadGas();
let web: Server, browser: Browser, page: Page;
const API = 'http://127.0.0.1:4191/exec', APP = 'http://127.0.0.1:4190/';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

beforeAll(async () => {
  if (!existsSync('dist/index.html')) throw new Error('run npm run build first');
  g.setNowLocal('2026-11-19 09:12'); g.ctx.setup();
  web = createServer((req, res) => {
    if (req.url?.startsWith('/exec')) {           // stand-in for script.google.com
      let body = ''; req.on('data', c => (body += c)); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(g.ctx.doPost({ postData: { contents: body } }).text);
      });
      return;
    }
    const path = req.url === '/config.json' ? null : join('dist', (req.url ?? '/').split('?')[0].replace(/\/$/, '/index.html'));
    if (!path) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ appsScriptUrl: API })); }
    if (!existsSync(path)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' }); res.end(readFileSync(path));
  });
  await new Promise<void>(r => web.listen(4190, '127.0.0.1', () => r()));
  const api = createServer((req, res) => web.emit('request', req, res)); await new Promise<void>(r => api.listen(4191, '127.0.0.1', () => r()));
  browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
}, 60_000);
afterAll(async () => { await browser?.close(); web?.close(); });

async function signUp(email: string, code: string, pw: string) {
  await page.goto(APP); await page.getByRole('button', { name: /First time or forgot/ }).click();
  await page.getByLabel('Office email').fill(email); await page.getByLabel('Code from your admin').fill(code);
  await page.getByLabel('New password').fill(pw); await page.getByLabel('Repeat password').fill(pw);
  await page.getByRole('button', { name: 'Create my account' }).click();
}

describe('first day with the Google Sheets backend', () => {
  let code = '';
  it('admin sets up with the one-time set-up code', async () => {
    await signUp('hitesh@office.in', g.props.get('SETUP_CODE')!, 'admin-pass-123');
    await page.getByText(/Good morning, hitesh/).waitFor({ timeout: 10000 });
  });
  it('admin adds an employee and gets a code', async () => {
    await page.goto(APP + '#/admin/people');
    await page.getByRole('button', { name: 'Add person' }).click();
    await page.getByLabel('Office email').fill('aarav@office.in'); await page.getByLabel('Nickname').fill('Aarav');
    await page.getByRole('dialog').getByRole('button', { name: 'Add person' }).click();
    const c = await page.locator('.modal .display').textContent({ timeout: 10000 });
    code = (c ?? '').trim(); expect(code).toMatch(/^[A-Z2-9]{8}$/);
  });
  it('a wrong code is refused with a clear message', async () => {
    await page.evaluate(() => localStorage.clear());
    await signUp('aarav@office.in', 'WRONGCDE', 'aarav-pass-1');
    expect(await page.locator('.note.bad').textContent({ timeout: 10000 })).toMatch(/code do not match/);
  });
  it('employee signs up and checks in; time comes from the server', async () => {
    await signUp('aarav@office.in', code, 'aarav-pass-1');
    await page.getByText(/Good morning, Aarav/).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /Check in/ }).click();
    await page.getByRole('button', { name: /Check out/ }).waitFor({ timeout: 10000 });
    expect(await page.locator('.dial-meta').textContent()).toContain('9:12 AM');
  });
  it('employee cannot open admin screens', async () => {
    await page.goto(APP + '#/admin/people'); await page.waitForTimeout(800);
    expect(page.url()).not.toContain('admin');
  });
  it('admin sees the employee in the office', async () => {
    await page.goto(APP + '#/me'); await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Office email').fill('hitesh@office.in'); await page.getByLabel('Password').fill('admin-pass-123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.goto(APP + '#/admin');
    await page.getByRole('cell', { name: 'Aarav' }).waitFor({ timeout: 10000 });
    expect(await page.locator('table').first().textContent()).toContain('9:12 AM');
    await page.screenshot({ path: 'tests/ui/shots/e2e-admin-overview.png', fullPage: true });
  });
});
