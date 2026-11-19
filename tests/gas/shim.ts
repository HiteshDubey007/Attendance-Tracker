// A faithful-enough in-memory stand-in for the Google Apps Script services PunchIn uses,
// so the exact gas/Code.js file can be tested and back-tested on any computer.
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import vm from 'node:vm';

class Range {
  constructor(private sh: FakeSheet, private r: number, private c: number, private nr: number, private nc: number) {}
  setNumberFormat() { return this; }
  getValues() {
    const out: string[][] = [];
    for (let i = 0; i < this.nr; i++) { const row = this.sh.data[this.r - 1 + i] ?? []; out.push(Array.from({ length: this.nc }, (_, j) => row[this.c - 1 + j] ?? '')); }
    return out;
  }
  setValues(v: unknown[][]) {
    v.forEach((row, i) => { const target = (this.sh.data[this.r - 1 + i] ??= []); row.forEach((x, j) => { target[this.c - 1 + j] = String(x ?? ''); }); });
    return this;
  }
}
export class FakeSheet {
  data: string[][] = [];
  constructor(public name: string) {}
  getName() { return this.name; }
  getRange(a: number | string, c?: number, nr?: number, nc?: number) { return typeof a === 'string' ? new Range(this, 1, 1, 0, 0) : new Range(this, a, c!, nr ?? 1, nc ?? 1); }
  getLastRow() { return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  appendRow(row: unknown[]) { this.data.push(row.map(x => String(x ?? ''))); }
  deleteRow(n: number) { this.data.splice(n - 1, 1); }
  setFrozenRows() {}
}
export class FakeSpreadsheet {
  sheets: FakeSheet[] = [new FakeSheet('Sheet1')];
  getId() { return 'fake-sheet'; }
  getSheetByName(n: string) { return this.sheets.find(s => s.name === n) ?? null; }
  insertSheet(n: string) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s: FakeSheet) { this.sheets = this.sheets.filter(x => x !== s); }
}

function fmt(d: Date, tz: string, f: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'long' })
    .formatToParts(d).map(x => [x.type, x.value]));
  const monthName = new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'long' }).format(d);
  // Java-style patterns used by Code.js
  return f.replace(/yyyy|MMMM|MM|dd|EEEE|HH|H|mm|ss|d/g, t => ({ yyyy: p.year, MMMM: monthName, MM: p.month, dd: p.day, EEEE: p.weekday, HH: p.hour,
    H: String(Number(p.hour)), mm: p.minute, ss: p.second, d: String(Number(p.day)) } as Record<string, string>)[t]);
}
function parse(s: string, tz: string) {           // 'yyyy-MM-dd HH:mm' in tz → Date
  const [d, t] = s.split(' '); const [y, mo, da] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, da, h, mi);
  for (let i = 0; i < 2; i++) {
    const shown = fmt(new Date(guess), tz, 'yyyy-MM-dd HH:mm');
    const [sd, st] = shown.split(' '); const [sy, smo, sda] = sd.split('-').map(Number); const [sh, smi] = st.split(':').map(Number);
    guess += Date.UTC(y, mo - 1, da, h, mi) - Date.UTC(sy, smo - 1, sda, sh, smi);
  }
  return new Date(guess);
}

export function loadGas() {
  const ss = new FakeSpreadsheet();
  const props = new Map<string, string>(); const cache = new Map<string, string>();
  const sent = { mail: [] as any[], fetch: [] as string[], triggers: [] as string[], driveFiles: new Map<string, string>(), removed: [] as string[] };
  const ocr = { text: '' };
  const calendar = { items: [] as any[] };
  const ctx: any = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, flush() {}, getUi: () => { throw new Error('no ui'); } },
    Utilities: {
      getUuid: () => randomUUID(),
      newBlob: (bytes: Uint8Array, mime: string, name: string) => ({ bytes, mime, name }),
      base64Decode: (b64: string) => Buffer.from(b64, 'base64'),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_a: string, s: string) => Array.from(createHash('sha256').update(s, 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      formatDate: (d: Date, tz: string, f: string) => { new Intl.DateTimeFormat('en', { timeZone: tz }); return fmt(d, tz, f); },
      parseDate: (s: string, tz: string) => parse(s, tz),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => props.set(k, v), deleteProperty: (k: string) => props.delete(k), getKeys: () => [...props.keys()] }) },
    ScriptApp: { getProjectTriggers: () => sent.triggers.map(h => ({ getHandlerFunction: () => h })),
      newTrigger: (h: string) => ({ timeBased: () => ({ everyHours: () => ({ create: () => { sent.triggers.push(h); } }) }) }) },
    MailApp: { sendEmail: (o: any) => { sent.mail.push(o); } },
    UrlFetchApp: { fetch: (u: string) => { sent.fetch.push(u); return { getResponseCode: () => 200 }; } },
    Drive: { Files: {
      create: (_meta: any, blob: any) => { const id = randomUUID(); sent.driveFiles.set(id, blob.mime); return { id }; },
      remove: (id: string) => { sent.removed.push(id); sent.driveFiles.delete(id); } } },
    DocumentApp: { openById: () => ({ getBody: () => ({ getText: () => ocr.text }) }) },
    Calendar: { Events: { list: (_cal: string, o: any) => ({ items: calendar.items.filter(e => e.start.date >= o.timeMin.slice(0, 10) && e.start.date < o.timeMax.slice(0, 10)) }) } },
    CacheService: { getScriptCache: () => ({ get: (k: string) => cache.get(k) ?? null, put: (k: string, v: string) => cache.set(k, v), remove: (k: string) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t: string) => ({ text: t, setMimeType() { return this; } }) },
    Logger: { log() {} },
    __TEST_NOW__: null as Date | null,
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync('gas/Code.js', 'utf8'), ctx, { filename: 'Code.js' });
  return {
    ctx, ss, props, cache, sent, ocr, calendar,
    call(fn: string, args: Record<string, unknown> = {}, token?: string) {
      // Round-trip through JSON exactly like the real web request does.
      const res = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ fn, args, token }) } }).text);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    setNowLocal(local: string | null, tz = 'Asia/Kolkata') { ctx.__TEST_NOW__ = local ? parse(local, tz) : null; },
    tab(name: string) { return ss.getSheetByName(name)!; },
  };
}
