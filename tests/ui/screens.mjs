// UI smoke test: serves the sample-data build, opens every screen on a phone-sized and a
// laptop-sized window, fails on any page error, and saves screenshots for review.
import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { mkdirSync } from 'node:fs';

const OUT = process.env.SHOTS ?? 'tests/ui/shots';
mkdirSync(OUT, { recursive: true });
const server = await preview({ mode: 'mock', build: { outDir: 'dist-mock' }, preview: { port: 4179, strictPort: true } });
const base = 'http://localhost:4179/';
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/google-chrome' });
const screens = [
  ['login', '?signedout=1#/'],
  ['emp-today', '?as=employee#/'], ['emp-history', '?as=employee#/history'], ['emp-leave', '?as=employee#/leave'],
  ['emp-fixes', '?as=employee#/fixes'], ['emp-me', '?as=employee#/me'],
  ['admin-overview', '?as=admin#/admin'], ['admin-people', '?as=admin#/admin/people'], ['admin-records', '?as=admin#/admin/records'],
  ['admin-approvals', '?as=admin#/admin/approvals'], ['admin-holidays', '?as=admin#/admin/holidays'],
  ['admin-settings', '?as=admin#/admin/settings'], ['admin-security', '?as=admin#/admin/security'], ['admin-more', '?as=admin#/more'],
];
const sizes = { phone: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, laptop: { width: 1366, height: 860 } };
let failures = 0;
for (const [sizeName, vp] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor ?? 1, timezoneId: 'Asia/Kolkata' });
  for (const [name, path] of screens) {
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text()) && errors.push(m.text()));
    await page.goto(base + path, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 2) errors.push(`page scrolls sideways by ${overflow}px`);
    const blank = await page.evaluate(() => (document.querySelector('#root')?.textContent ?? '').trim().length < 20);
    if (blank) errors.push('screen rendered empty');
    await page.screenshot({ path: `${OUT}/${sizeName}-${name}.png`, fullPage: true });
    console.log(errors.length ? '✗' : '✓', sizeName, name, errors.join(' | '));
    failures += errors.length ? 1 : 0;
    await page.close();
  }
  await ctx.close();
}
// Interaction: open the apply-leave sheet on a phone and check the working-day preview
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base + '?as=employee#/leave', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Apply for leave' }).click();
  await page.locator('input[type=date]').first().fill('2026-11-20');
  await page.locator('input[type=date]').nth(1).fill('2026-11-24');
  await page.waitForTimeout(300);
  const txt = await page.locator('.note.info').textContent();
  const ok = /3 working days/.test(txt ?? '');
  console.log(ok ? '✓' : '✗', 'leave preview counts Fri+Mon+Tue = 3 days:', txt);
  if (!ok) failures++;
  await page.screenshot({ path: `${OUT}/phone-emp-leave-form.png` });
  await page.goto(base + '?as=employee#/', { waitUntil: 'networkidle' });
  await page.locator('.punch').click(); await page.waitForTimeout(400);
  const refused = await page.locator('[role=alert]').textContent().catch(() => null);
  console.log(refused ? '✓' : '✗', 'refused punch shows reason:', refused);
  if (!refused) failures++;
  await page.screenshot({ path: `${OUT}/phone-emp-refused.png` });
  await ctx.close();
}
await browser.close(); server.httpServer.close();
console.log(failures ? `\n${failures} screen(s) failed` : '\nAll screens passed');
process.exit(failures ? 1 : 0);
