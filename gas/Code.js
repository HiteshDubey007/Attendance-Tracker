/* ════════════════════════════════════════════════════════════════════
 *  PunchIn — secure attendance backend on Google Sheets + Apps Script
 *  Developed by Hitesh Dubey.
 *
 *  Paste this whole file into Extensions → Apps Script of a new Google Sheet,
 *  run `setup` once, then Deploy → New deployment → Web app
 *  (Execute as: Me · Who has access: Anyone).
 *
 *  Security model
 *   • The sheet is never shared. Only this script (running as the owner) reads/writes it.
 *   • Every time stamp comes from Google's server clock, never from the phone.
 *   • Sign-in with email + password; first-time sign-up needs a one-time invite code
 *     issued by the admin, so nobody can claim someone else's email.
 *   • Passwords are salted and hashed; sessions are random tokens stored only as hashes.
 *   • Admin-only actions are checked on the server for every call.
 *   • Every change is appended to the Audit tab, SHA-256 hash-chained. "Verify" also
 *     replays the log and compares it with the live tabs, so direct edits to the
 *     sheet by anyone (even the owner) are detected.
 * ════════════════════════════════════════════════════════════════════ */

var VERSION = '1.0.0';

var TABLES = {
  members: ['id', 'email', 'nickname', 'role', 'status', 'created_at', 'pw_hash', 'pw_salt', 'invite_hash', 'invite_expires'],
  holidays: ['id', 'holiday_date', 'name'],
  attendance: ['id', 'member_id', 'work_date', 'check_in', 'check_out', 'in_lat', 'in_lng', 'in_accuracy_m', 'in_distance_m',
    'out_lat', 'out_lng', 'out_accuracy_m', 'out_distance_m', 'source', 'edit_reason'],
  leave_requests: ['id', 'member_id', 'start_date', 'end_date', 'leave_type', 'half_day', 'days', 'reason', 'status', 'admin_note', 'decided_by', 'decided_at', 'created_at'],
  correction_requests: ['id', 'member_id', 'work_date', 'requested_check_in', 'requested_check_out', 'reason', 'status', 'admin_note', 'decided_by', 'decided_at', 'created_at'],
  punch_attempts: ['id', 'member_id', 'attempted_at', 'kind', 'lat', 'lng', 'accuracy_m', 'distance_m', 'reason'],
  sessions: ['id', 'member_id', 'expires', 'created_at'],
  org_settings: ['key', 'value'],
  audit_log: ['id', 'at', 'actor', 'action', 'table_name', 'row_id', 'old_data', 'new_data', 'prev_hash', 'hash'],
};
var NUMERIC = { days: 1, in_lat: 1, in_lng: 1, in_accuracy_m: 1, in_distance_m: 1, out_lat: 1, out_lng: 1, out_accuracy_m: 1, out_distance_m: 1,
  lat: 1, lng: 1, accuracy_m: 1, distance_m: 1, id_num: 1 };
var BOOL = { half_day: 1 };
var AUDITED = { members: 1, holidays: 1, attendance: 1, leave_requests: 1, correction_requests: 1, org_settings: 1 };
var SECRET = ['pw_hash', 'pw_salt', 'invite_hash', 'invite_expires'];
var TAB_TITLES = { members: 'People', holidays: 'Holidays', attendance: 'Attendance', leave_requests: 'Leave', correction_requests: 'Fixes',
  punch_attempts: 'Refused punches', sessions: 'Sessions', org_settings: 'Settings', audit_log: 'Audit' };

var DEFAULT_SETTINGS = {
  company_name: 'My Company', timezone: 'Asia/Kolkata', required_minutes: 540, half_day_minutes: 270, weekend_mode: 'sat_sun',
  annual_leave_days: 24, shift_start: '09:30:00', late_grace_minutes: 15, geofence_enabled: false, office_lat: null, office_lng: null,
  geofence_radius_m: 150, max_gps_accuracy_m: 100,
};

// ───────────── Errors & small helpers ─────────────
function fail(code, msg) { throw new Error(code + ': ' + msg); }
function now() { return typeof __TEST_NOW__ !== 'undefined' && __TEST_NOW__ ? new Date(__TEST_NOW__.getTime()) : new Date(); }
function iso(d) { return d.toISOString(); }
function uuid() { return Utilities.getUuid(); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
function sha256(s) { return hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function trim(s) { return s == null ? '' : String(s).replace(/^\s+|\s+$/g, ''); }
function addDays(d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function isoDow(d) { var w = new Date(d + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; }
function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }
function isTime(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(s); }
function needDate(s, what) { if (!isDate(s)) fail('BAD_DATES', (what || 'date') + ' is not a valid date'); return s; }
function hm(t) { return t ? String(t).slice(0, 5) : null; }
function minsBetween(a, b) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000); }
function distanceM(lat1, lng1, lat2, lng2) {
  var r = function (x) { return x * Math.PI / 180; };
  var a = Math.pow(Math.sin(r(lat2 - lat1) / 2), 2) + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.pow(Math.sin(r(lng2 - lng1) / 2), 2);
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// ───────────── Storage (one tab per table, everything stored as text) ─────────────
function Db(ss) { this.ss = ss; this.cache = {}; this.sheets = {}; this.actor = null; }
Db.prototype.sheet = function (t) {
  if (this.sheets[t]) return this.sheets[t];
  var title = TAB_TITLES[t], sh = this.ss.getSheetByName(title);
  if (!sh) {
    sh = this.ss.insertSheet(title);
    sh.getRange('A:Z').setNumberFormat('@');
    sh.getRange(1, 1, 1, TABLES[t].length).setValues([TABLES[t]]);
    sh.setFrozenRows(1);
  }
  return (this.sheets[t] = sh);
};
Db.prototype.all = function (t) {
  if (this.cache[t]) return this.cache[t];
  var sh = this.sheet(t), cols = TABLES[t], last = sh.getLastRow(), rows = [];
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, cols.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      for (var j = 0; j < cols.length; j++) o[cols[j]] = this.parse(cols[j], vals[i][j]);
      rows.push(o);
    }
  }
  return (this.cache[t] = rows);
};
Db.prototype.parse = function (c, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (v instanceof Date) return c.indexOf('date') >= 0 || c === 'holiday_date' ? Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd') : v.toISOString();
  if (NUMERIC[c]) return Number(v);
  if (BOOL[c]) return String(v).toLowerCase() === 'true';
  return String(v);
};
Db.prototype.cell = function (v) { return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); };
Db.prototype.clean = function (o) { var c = {}; for (var k in o) if (k !== '_row') c[k] = o[k]; return c; };
// Canonical form of a row (exactly what the sheet will give back), minus secrets. Used for audit and verify.
Db.prototype.publicRow = function (t, o) {
  var self = this, c = {};
  TABLES[t].forEach(function (k) { if (SECRET.indexOf(k) < 0) c[k] = self.parse(k, self.cell(o[k])); });
  return c;
};
Db.prototype.find = function (t, id) { var key = t === 'org_settings' ? 'key' : 'id'; var r = this.all(t); for (var i = 0; i < r.length; i++) if (r[i][key] === id) return r[i]; return null; };
Db.prototype.insert = function (t, o) {
  var self = this, cols = TABLES[t];
  this.sheet(t).appendRow(cols.map(function (c) { return self.cell(o[c]); }));
  delete this.cache[t];
  if (AUDITED[t]) this.audit('insert', t, o.id || o.key, null, this.publicRow(t, o));
  return o;
};
Db.prototype.update = function (t, row, patch) {
  var self = this, cols = TABLES[t], old = this.clean(row), next = this.clean(row);
  for (var k in patch) next[k] = patch[k];
  this.sheet(t).getRange(row._row, 1, 1, cols.length).setValues([cols.map(function (c) { return self.cell(next[c]); })]);
  delete this.cache[t];
  if (AUDITED[t]) {
    var a = this.publicRow(t, old), b = this.publicRow(t, next);
    if (JSON.stringify(a) !== JSON.stringify(b)) this.audit('update', t, next.id || next.key, a, b);
  }
  return next;
};
Db.prototype.remove = function (t, row) {
  this.sheet(t).deleteRow(row._row);
  delete this.cache[t];
  if (AUDITED[t]) this.audit('delete', t, row.id || row.key, this.publicRow(t, row), null);
};
Db.prototype.auditHash = function (prev, at, actor, action, table, rowId, oldD, newD) {
  return sha256([prev, at, actor || '', action, table, rowId || '', oldD ? JSON.stringify(oldD) : '', newD ? JSON.stringify(newD) : ''].join('|'));
};
Db.prototype.audit = function (action, table, rowId, oldD, newD) {
  var log = this.all('audit_log'), last = log[log.length - 1];
  var prev = last ? last.hash : 'GENESIS', id = last ? Number(last.id) + 1 : 1, at = iso(new Date());
  var h = this.auditHash(prev, at, this.actor, action, table, rowId, oldD, newD);
  var self = this;
  this.sheet('audit_log').appendRow([id, at, this.actor || '', action, table, rowId || '', oldD ? JSON.stringify(oldD) : '', newD ? JSON.stringify(newD) : '', prev, h]
    .map(function (v) { return self.cell(v); }));
  delete this.cache.audit_log;
};

// ───────────── Settings ─────────────
Db.prototype.settings = function () {
  if (this._settings) return this._settings;
  var s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), rows = this.all('org_settings');
  rows.forEach(function (r) { if (r.key in s) s[r.key] = r.value === null ? null : JSON.parse(r.value); });
  return (this._settings = s);
};
function localDate(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function localHM(isoStr, tz) { return Utilities.formatDate(new Date(isoStr), tz, 'HH:mm'); }
function localTs(date, time, tz) { return iso(Utilities.parseDate(date + ' ' + hm(time), tz, 'yyyy-MM-dd HH:mm')); }
Db.prototype.today = function () { return localDate(now(), this.settings().timezone); };
Db.prototype.isWeekend = function (d) {
  var m = this.settings().weekend_mode, w = isoDow(d);
  return m === 'sat_sun' ? (w === 6 || w === 7) : m === 'sun' ? w === 7 : false;
};
Db.prototype.holidayOn = function (d) {
  if (!this._hol) { var h = {}; this.all('holidays').forEach(function (x) { h[x.holiday_date] = x.name; }); this._hol = h; }
  return this._hol[d] || null;
};
Db.prototype.isWorkingDay = function (d) { return !this.isWeekend(d) && !this.holidayOn(d); };
Db.prototype.workingDaysBetween = function (a, b) { var n = 0; for (var d = a; d <= b; d = addDays(d, 1)) if (this.isWorkingDay(d)) n++; return n; };

// ───────────── Auth ─────────────
function hashPw(pw, salt) { var h = salt + '|' + pw; for (var i = 0; i < 2000; i++) h = sha256(salt + h); return h; }
function newCode() { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '', u = uuid().replace(/-/g, ''); for (var i = 0; i < 8; i++) s += a[parseInt(u.substr(i * 2, 2), 16) % a.length]; return s; }
function cleanEmail(e) {
  var x = trim(e).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x) || x.length > 120) fail('BAD_EMAIL', 'enter a valid email address');
  return x;
}
function checkPw(pw) { if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) fail('WEAK_PASSWORD', 'password needs at least 8 characters'); }

Db.prototype.newSession = function (m) {
  var token = uuid() + uuid();
  var expires = new Date(now().getTime() + 30 * 864e5);
  this.insert('sessions', { id: sha256(token), member_id: m.id, expires: iso(expires), created_at: iso(now()) });
  return token;
};
Db.prototype.memberByToken = function (token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  var s = this.find('sessions', sha256(token));
  if (!s || new Date(s.expires) < now()) return null;
  // sliding expiry: stay signed in while you keep using the app
  if (new Date(s.expires).getTime() - now().getTime() < 15 * 864e5) this.update('sessions', s, { expires: iso(new Date(now().getTime() + 30 * 864e5)) });
  return this.find('members', s.member_id);
};
function throttle(key) {
  var c = CacheService.getScriptCache(), n = Number(c.get(key) || 0);
  if (n >= 6) fail('TOO_MANY_TRIES', 'too many attempts, wait 15 minutes');
  c.put(key, String(n + 1), 900);
}

// ───────────── Requests ─────────────
// Everything is reached through one entry point. `token` identifies the caller.
var PUBLIC = { sign_in: 1, sign_up: 1, ping: 1 };
var WRITES = { sign_in: 1, sign_up: 1, sign_out: 1, punch_in: 1, punch_out: 1, request_leave: 1, cancel_leave: 1, request_correction: 1,
  admin_add_member: 1, admin_update_member: 1, admin_reset_code: 1, admin_set_attendance: 1, admin_delete_attendance: 1,
  admin_decide_leave: 1, admin_decide_correction: 1, add_holiday: 1, delete_holiday: 1, save_settings: 1 };

function api(req) {
  var lock = null;
  try {
    if (!req || typeof req.fn !== 'string' || !Object.prototype.hasOwnProperty.call(H, req.fn)) fail('UNKNOWN', 'unknown request');
    if (WRITES[req.fn]) { lock = LockService.getScriptLock(); lock.waitLock(25000); }
    var db = new Db(spreadsheet());
    var me = null;
    if (!PUBLIC[req.fn]) {
      me = db.memberByToken(req.token);
      if (!me) fail('SIGNED_OUT', 'please sign in again');
      if (me.status !== 'active' && req.fn !== 'me') fail('NOT_ALLOWED', 'your account is not active');
      db.actor = me.id;
    }
    var args = req.args && typeof req.args === 'object' ? req.args : {};
    if (req.fn === 'sign_out') args = { token: req.token };
    var data = H[req.fn](db, me, args);
    if (lock) SpreadsheetApp.flush();
    return { ok: true, data: data === undefined ? null : data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function spreadsheet() {
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function doPost(e) {
  var req; try { req = JSON.parse(e.postData.contents); } catch (x) { req = null; }
  return ContentService.createTextOutput(JSON.stringify(api(req))).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'PunchIn', version: VERSION })).setMimeType(ContentService.MimeType.JSON);
}

function requireAdmin(me) { if (me.role !== 'admin') fail('NOT_ALLOWED', 'admin only'); }
function selfOrAdmin(me, id) { if (id && id !== me.id && me.role !== 'admin') fail('NOT_ALLOWED', 'admin only'); return id || me.id; }
function strip(rows) { return rows.map(function (r) { var c = {}; for (var k in r) if (k !== '_row' && SECRET.indexOf(k) < 0) c[k] = r[k]; return c; }); }

var H = {};
H.ping = function () { return { version: VERSION, time: iso(now()) }; };

H.sign_in = function (db, _, a) {
  var email = cleanEmail(a.email); throttle('login:' + email);
  var m = db.all('members').filter(function (x) { return x.email === email && x.status !== 'deleted'; })[0];
  if (!m || !m.pw_hash || hashPw(String(a.password || ''), m.pw_salt) !== m.pw_hash) fail('BAD_LOGIN', 'wrong email or password');
  if (m.status !== 'active') fail('NOT_ALLOWED', 'your account is blocked. Contact your admin.');
  CacheService.getScriptCache().remove('login:' + email);
  db.actor = m.id;
  return { token: db.newSession(m) };
};

// First-time set-up (and password reset): email + one-time code from the admin + new password.
H.sign_up = function (db, _, a) {
  var email = cleanEmail(a.email), code = trim(a.code).toUpperCase(); checkPw(a.password);
  throttle('signup:' + email);
  var members = db.all('members'), m;
  if (!members.length) {
    var setup = PropertiesService.getScriptProperties().getProperty('SETUP_CODE');
    if (!setup || code !== setup) fail('BAD_CODE', 'that set-up code is not right');
    m = db.insert('members', { id: uuid(), email: email, nickname: email.split('@')[0].slice(0, 40), role: 'admin', status: 'active', created_at: iso(now()) });
    PropertiesService.getScriptProperties().deleteProperty('SETUP_CODE');
    m = db.find('members', m.id);
  } else {
    m = members.filter(function (x) { return x.email === email && x.status !== 'deleted'; })[0];
    if (!m || !m.invite_hash || sha256(code) !== m.invite_hash || new Date(m.invite_expires) < now()) fail('BAD_CODE', 'that email and code do not match. Ask your admin for a new code.');
    if (m.status !== 'active') fail('NOT_ALLOWED', 'your account is blocked');
  }
  var salt = uuid();
  db.actor = m.id;
  m = db.update('members', m, { pw_salt: salt, pw_hash: hashPw(a.password, salt), invite_hash: null, invite_expires: null });
  // a reset signs out every other device
  db.all('sessions').filter(function (s) { return s.member_id === m.id; }).reverse().forEach(function (s) { db.remove('sessions', s); });
  CacheService.getScriptCache().remove('signup:' + email);
  return { token: db.newSession(m) };
};
H.sign_out = function (db, me, a) {
  var s = db.find('sessions', sha256(String(a.token || ''))); if (s && s.member_id === me.id) db.remove('sessions', s);
};
H.me = function (db, me) { return me.status === 'active' ? strip([me])[0] : null; };
H.settings = function (db) { return db.settings(); };
H.server_time = function () { return iso(now()); };

// ───────────── Punching ─────────────
function checkLocation(db, me, kind, lat, lng, acc) {
  var s = db.settings(), d = null, why = null;
  var okNum = function (x) { return typeof x === 'number' && isFinite(x); };
  if (okNum(lat) && okNum(lng) && s.office_lat !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) d = distanceM(s.office_lat, s.office_lng, lat, lng);
  if (!s.geofence_enabled) return { distance: d };
  if (!okNum(lat) || !okNum(lng) || !okNum(acc) || d === null) why = 'LOCATION_REQUIRED: turn on location to punch';
  else if (acc <= 0 || acc > s.max_gps_accuracy_m) why = 'LOCATION_INACCURATE: GPS accuracy is ' + Math.round(acc) + ' m, needs ' + s.max_gps_accuracy_m + ' m or better. Step near a window and retry.';
  else if (d > s.geofence_radius_m) why = 'OUTSIDE_OFFICE: you are ' + Math.round(d) + ' m from the office (limit ' + s.geofence_radius_m + ' m)';
  if (why) db.insert('punch_attempts', { id: uuid(), member_id: me.id, attempted_at: iso(now()), kind: kind, lat: okNum(lat) ? lat : null, lng: okNum(lng) ? lng : null, accuracy_m: okNum(acc) ? acc : null, distance_m: d, reason: why });
  return { distance: d, refusal: why };
}
H.punch_in = function (db, me, a) {
  var today = db.today();
  if (db.all('attendance').some(function (r) { return r.member_id === me.id && r.work_date === today; })) fail('ALREADY_PUNCHED_IN', 'you already checked in today');
  if (db.isWorkingDay(today) && db.all('leave_requests').some(function (l) { return l.member_id === me.id && l.status === 'approved' && !l.half_day && today >= l.start_date && today <= l.end_date; }))
    fail('ON_LEAVE', 'you are on approved leave today');
  var loc = checkLocation(db, me, 'in', a.p_lat, a.p_lng, a.p_accuracy);
  if (loc.refusal) return { ok: false, error: loc.refusal };
  var r = db.insert('attendance', { id: uuid(), member_id: me.id, work_date: today, check_in: iso(now()), check_out: null, in_lat: a.p_lat, in_lng: a.p_lng, in_accuracy_m: a.p_accuracy, in_distance_m: loc.distance, source: 'app' });
  return { ok: true, attendance: r };
};
H.punch_out = function (db, me, a) {
  var t = now().getTime();
  var open = db.all('attendance').filter(function (r) { return r.member_id === me.id && !r.check_out && new Date(r.check_in).getTime() > t - 20 * 3600e3; })
    .sort(function (x, y) { return x.check_in < y.check_in ? 1 : -1; })[0];
  if (!open) fail('NOT_PUNCHED_IN', 'check in first');
  var loc = checkLocation(db, me, 'out', a.p_lat, a.p_lng, a.p_accuracy);
  if (loc.refusal) return { ok: false, error: loc.refusal };
  var r = db.update('attendance', open, { check_out: iso(now()), out_lat: a.p_lat, out_lng: a.p_lng, out_accuracy_m: a.p_accuracy, out_distance_m: loc.distance });
  return { ok: true, attendance: r };
};

// ───────────── Leave & fixes ─────────────
function leaveBalance(db, memberId, year) {
  var s = db.settings(), used = 0, pending = 0;
  db.all('leave_requests').forEach(function (l) {
    if (l.member_id !== memberId || l.leave_type === 'unpaid' || Number(l.start_date.slice(0, 4)) !== year) return;
    if (l.status === 'approved') used += l.days; else if (l.status === 'pending') pending += l.days;
  });
  return { annual: s.annual_leave_days, used: used, pending: pending, remaining: s.annual_leave_days - used };
}
H.leave_balance = function (db, me, a) {
  var id = selfOrAdmin(me, a.p_member);
  return [leaveBalance(db, id, a.p_year ? Number(a.p_year) : Number(db.today().slice(0, 4)))];
};
H.request_leave = function (db, me, a) {
  var start = needDate(a.p_start, 'start'), end = needDate(a.p_end, 'end'), half = !!a.p_half_day, type = a.p_type, reason = trim(a.p_reason);
  if (['casual', 'sick', 'earned', 'unpaid'].indexOf(type) < 0) fail('BAD_TYPE', 'unknown leave type');
  if (reason.length < 3 || reason.length > 500) fail('BAD_REASON', 'give a short reason (3–500 characters)');
  if (end < start) fail('BAD_DATES', 'end date is before start date');
  if (start.slice(0, 4) !== end.slice(0, 4)) fail('BAD_DATES', 'split leave that crosses a new year into two requests');
  if (start < addDays(db.today(), -30)) fail('BAD_DATES', 'leave can be backdated by at most 30 days');
  if (half && start !== end) fail('BAD_DATES', 'a half day must be a single date');
  var days = db.workingDaysBetween(start, end) * (half ? 0.5 : 1);
  if (days === 0) fail('NO_WORKING_DAYS', 'the selected dates are all weekends or holidays');
  if (db.all('leave_requests').some(function (l) { return l.member_id === me.id && (l.status === 'pending' || l.status === 'approved') && !(end < l.start_date || start > l.end_date); }))
    fail('OVERLAP', 'you already have leave on some of these dates');
  if (type !== 'unpaid') {
    var b = leaveBalance(db, me.id, Number(start.slice(0, 4)));
    if (days > b.remaining - b.pending) fail('INSUFFICIENT_BALANCE', 'you have ' + (b.remaining - b.pending) + ' day(s) available');
  }
  return db.insert('leave_requests', { id: uuid(), member_id: me.id, start_date: start, end_date: end, leave_type: type, half_day: half, days: days, reason: reason, status: 'pending', created_at: iso(now()) });
};
H.cancel_leave = function (db, me, a) {
  var l = db.find('leave_requests', a.p_id);
  if (!l || l.member_id !== me.id || l.status !== 'pending') fail('NOT_FOUND', 'only your own pending requests can be cancelled');
  db.update('leave_requests', l, { status: 'cancelled' });
};
H.request_correction = function (db, me, a) {
  var d = needDate(a.p_date), i = a.p_in ? String(a.p_in) : null, o = a.p_out ? String(a.p_out) : null, reason = trim(a.p_reason), today = db.today();
  if ((i && !isTime(i)) || (o && !isTime(o))) fail('BAD_TIMES', 'times must look like 09:30');
  if (!i && !o) fail('BAD_TIMES', 'give a check-in or check-out time');
  if (reason.length < 3 || reason.length > 500) fail('BAD_REASON', 'give a short reason');
  if (d > today) fail('BAD_DATES', 'cannot correct a future date');
  if (d < addDays(today, -60)) fail('BAD_DATES', 'corrections are allowed for the last 60 days');
  if (i && o && hm(o) <= hm(i)) fail('BAD_TIMES', 'check-out must be after check-in');
  if (db.all('correction_requests').some(function (c) { return c.member_id === me.id && c.work_date === d && c.status === 'pending'; })) fail('DUPLICATE', 'you already have a pending request for this date');
  return db.insert('correction_requests', { id: uuid(), member_id: me.id, work_date: d, requested_check_in: i ? hm(i) + ':00' : null, requested_check_out: o ? hm(o) + ':00' : null, reason: reason, status: 'pending', created_at: iso(now()) });
};
H.list = function (db, me, a) {
  var t = a.table; if (['leave_requests', 'correction_requests', 'holidays', 'members', 'punch_attempts', 'attendance', 'audit_log'].indexOf(t) < 0) fail('UNKNOWN', 'unknown list');
  if (['punch_attempts', 'audit_log'].indexOf(t) >= 0) requireAdmin(me);
  var rows = db.all(t);
  if (t === 'members') rows = me.role === 'admin' ? rows.filter(function (m) { return m.status !== 'deleted'; }) : rows.filter(function (m) { return m.id === me.id; });
  else if (t !== 'holidays' && t !== 'audit_log') rows = rows.filter(function (r) { return me.role === 'admin' ? (!a.member || r.member_id === a.member) : r.member_id === me.id; });
  if (t === 'attendance') rows = rows.filter(function (r) { return (!a.from || r.work_date >= a.from) && (!a.to || r.work_date <= a.to); });
  rows = strip(rows);
  var key = { leave_requests: 'created_at', correction_requests: 'created_at', punch_attempts: 'attempted_at', attendance: 'work_date', holidays: 'holiday_date', members: 'nickname', audit_log: 'id' }[t];
  var desc = t !== 'holidays' && t !== 'members';
  rows.sort(function (x, y) { var p = t === 'audit_log' ? Number(x[key]) - Number(y[key]) : String(x[key]).localeCompare(String(y[key])); return desc ? -p : p; });
  if (t === 'audit_log') rows.forEach(function (r) { r.old_data = r.old_data ? JSON.parse(r.old_data) : null; r.new_data = r.new_data ? JSON.parse(r.new_data) : null; r.id = Number(r.id); });
  return a.limit ? rows.slice(0, a.limit) : rows;
};

// ───────────── Reports ─────────────
function memberDays(db, memberId, from, to) {
  var s = db.settings(), today = db.today(), tz = s.timezone, out = [];
  var att = {}, lv = [];
  db.all('attendance').forEach(function (r) { if (r.member_id === memberId) att[r.work_date] = r; });
  db.all('leave_requests').forEach(function (l) { if (l.member_id === memberId && l.status === 'approved') lv.push(l); });
  var shiftLimit = hm(s.shift_start).split(':'), lateAfter = Number(shiftLimit[0]) * 60 + Number(shiftLimit[1]) + s.late_grace_minutes;
  var end = to < today ? to : today;
  for (var d = from; d <= end; d = addDays(d, 1)) {
    var a = att[d] || null, ci = a ? a.check_in : null, co = a ? a.check_out : null;
    var mins = ci && co ? minsBetween(ci, co) : null, hol = db.holidayOn(d), wk = db.isWeekend(d), l = null;
    if (db.isWorkingDay(d)) for (var i = 0; i < lv.length; i++) if (d >= lv[i].start_date && d <= lv[i].end_date) { l = lv[i].half_day ? 0.5 : 1; break; }
    var kind = ci && !co && d < today ? 'missing_checkout' : ci && !co ? 'working' : ci && l === 0.5 ? 'half_day_leave'
      : ci && mins >= s.required_minutes ? 'full' : ci && mins >= s.half_day_minutes ? 'short' : ci ? 'half_day'
      : l === 1 ? 'leave' : hol ? 'holiday' : wk ? 'weekend' : l === 0.5 ? 'half_day_leave' : d === today ? 'not_yet' : 'absent';
    var late = false;
    if (ci) { var t = localHM(ci, tz).split(':'); late = Number(t[0]) * 60 + Number(t[1]) > lateAfter; }
    out.push({ day: d, kind: kind, check_in: ci, check_out: co, worked_minutes: mins, late: late,
      fulfilled: mins !== null && mins >= (l === 0.5 ? s.half_day_minutes : s.required_minutes), leave_days: l || 0, holiday: hol });
  }
  return out;
}
function range(a) {
  var from = needDate(a.p_from, 'from'), to = needDate(a.p_to, 'to');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) fail('RANGE_TOO_LARGE', 'pick a shorter range');
  return [from, to];
}
function summarize(db, days) {
  var s = { working_days: 0, present_days: 0, fulfilled_days: 0, unfulfilled_days: 0, missing_checkout_days: 0, late_days: 0, leave_days: 0, absent_days: 0, total_minutes: 0 };
  days.forEach(function (d) {
    if (db.isWorkingDay(d.day)) s.working_days++;
    if (d.check_in) s.present_days++;
    if (d.fulfilled) s.fulfilled_days++;
    if (d.check_in && !d.fulfilled && d.kind !== 'working') s.unfulfilled_days++;
    if (d.kind === 'missing_checkout') s.missing_checkout_days++;
    if (d.late) s.late_days++;
    if (d.kind === 'absent') s.absent_days++;
    s.leave_days += d.leave_days; s.total_minutes += d.worked_minutes || 0;
  });
  return s;
}
H.member_days = function (db, me, a) { var r = range(a); return memberDays(db, selfOrAdmin(me, a.p_member), r[0], r[1]); };
H.member_summary = function (db, me, a) { var r = range(a); return [summarize(db, memberDays(db, selfOrAdmin(me, a.p_member), r[0], r[1]))]; };
H.team_day = function (db, me, a) {
  requireAdmin(me); var d = a.p_day ? needDate(a.p_day) : db.today();
  return db.all('members').filter(function (m) { return m.status === 'active'; }).sort(function (x, y) { return x.nickname.localeCompare(y.nickname); })
    .map(function (m) { var x = memberDays(db, m.id, d, d)[0] || {}; return { member_id: m.id, nickname: m.nickname, email: m.email, kind: x.kind, check_in: x.check_in || null, check_out: x.check_out || null, worked_minutes: x.worked_minutes === undefined ? null : x.worked_minutes, late: !!x.late }; });
};
H.team_trend = function (db, me, a) {
  requireAdmin(me); var r = range(a), by = {};
  db.all('members').filter(function (m) { return m.status === 'active'; }).forEach(function (m) {
    memberDays(db, m.id, r[0], r[1]).forEach(function (d) {
      var x = by[d.day] || (by[d.day] = { day: d.day, present: 0, full_days: 0, on_leave: 0, absent: 0, expected: 0 });
      if (d.check_in) x.present++; if (d.fulfilled) x.full_days++; if (d.kind === 'leave') x.on_leave++; if (d.kind === 'absent') x.absent++;
      if (db.isWorkingDay(d.day)) x.expected++;
    });
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
};

// ───────────── Admin ─────────────
H.admin_add_member = function (db, me, a) {
  requireAdmin(me);
  var email = cleanEmail(a.p_email), nick = trim(a.p_nickname), role = a.p_role || 'employee';
  if (nick.length < 1 || nick.length > 40) fail('BAD_NAME', 'nickname must be 1–40 characters');
  if (role !== 'admin' && role !== 'employee') fail('BAD_ROLE', 'unknown role');
  var ex = db.all('members').filter(function (m) { return m.email === email; })[0];
  if (ex && ex.status !== 'deleted') fail('EXISTS', email + ' is already a member');
  var code = newCode(), invite = { invite_hash: sha256(code), invite_expires: iso(new Date(now().getTime() + 14 * 864e5)) };
  var m = ex ? db.update('members', ex, Object.assign({ status: 'active', nickname: nick, role: role }, invite))
    : db.insert('members', Object.assign({ id: uuid(), email: email, nickname: nick, role: role, status: 'active', created_at: iso(now()) }, invite));
  return Object.assign(strip([m])[0], { invite_code: code });
};
H.admin_reset_code = function (db, me, a) {
  requireAdmin(me);
  var m = db.find('members', a.p_id); if (!m || m.status === 'deleted') fail('NOT_FOUND', 'person not found');
  var code = newCode();
  db.update('members', m, { invite_hash: sha256(code), invite_expires: iso(new Date(now().getTime() + 14 * 864e5)) });
  return { invite_code: code };
};
H.admin_update_member = function (db, me, a) {
  requireAdmin(me);
  var nick = trim(a.p_nickname), role = a.p_role, status = a.p_status;
  if (['admin', 'employee'].indexOf(role) < 0 || ['active', 'blocked', 'deleted'].indexOf(status) < 0) fail('BAD_INPUT', 'invalid role or status');
  if (nick.length < 1 || nick.length > 40) fail('BAD_NAME', 'nickname must be 1–40 characters');
  if (a.p_id === me.id && (status !== 'active' || role !== 'admin')) fail('NOT_ALLOWED', 'you cannot block, delete or demote yourself');
  var m = db.find('members', a.p_id); if (!m) fail('NOT_FOUND', 'person not found');
  var after = db.all('members').filter(function (x) { return x.id === m.id ? role === 'admin' && status === 'active' : x.role === 'admin' && x.status === 'active'; });
  if (!after.length) fail('NOT_ALLOWED', 'at least one active admin is required');
  var r = db.update('members', m, { nickname: nick, role: role, status: status });
  if (status !== 'active') db.all('sessions').filter(function (s) { return s.member_id === m.id; }).reverse().forEach(function (s) { db.remove('sessions', s); });
  return strip([r])[0];
};
function setAttendance(db, memberId, date, i, o, reason, source) {
  reason = trim(reason); var tz = db.settings().timezone;
  if (reason.length < 3) fail('REASON_REQUIRED', 'say why you are changing this record');
  needDate(date);
  if (date > db.today()) fail('BAD_DATES', 'cannot set a future date');
  if ((i && !isTime(i)) || (o && !isTime(o))) fail('BAD_TIMES', 'times must look like 09:30');
  if (!db.find('members', memberId)) fail('NOT_FOUND', 'person not found');
  var r = db.all('attendance').filter(function (x) { return x.member_id === memberId && x.work_date === date; })[0];
  var ci = i ? localTs(date, i, tz) : r ? r.check_in : null, co = o ? localTs(date, o, tz) : r ? r.check_out : null;
  if (!ci) fail('BAD_TIMES', 'a check-in time is required');
  if (co && co <= ci) fail('BAD_TIMES', 'check-out must be after check-in');
  if (co && new Date(co) > now()) fail('BAD_TIMES', 'check-out cannot be in the future');
  if (r) return db.update('attendance', r, { check_in: ci, check_out: co, source: source, edit_reason: reason });
  return db.insert('attendance', { id: uuid(), member_id: memberId, work_date: date, check_in: ci, check_out: co, source: source, edit_reason: reason });
}
H.admin_set_attendance = function (db, me, a) { requireAdmin(me); return setAttendance(db, a.p_member, a.p_date, a.p_in, a.p_out, a.p_reason, 'admin'); };
H.admin_delete_attendance = function (db, me, a) {
  requireAdmin(me); var reason = trim(a.p_reason); if (reason.length < 3) fail('REASON_REQUIRED', 'say why you are deleting this record');
  var r = db.find('attendance', a.p_id); if (!r) fail('NOT_FOUND', 'record not found');
  r = db.update('attendance', r, { edit_reason: 'DELETED: ' + reason }); r = db.find('attendance', a.p_id);
  db.remove('attendance', r);
};
H.admin_decide_leave = function (db, me, a) {
  requireAdmin(me);
  var l = db.find('leave_requests', a.p_id); if (!l) fail('NOT_FOUND', 'request not found');
  if (a.p_approve) {
    if (l.status !== 'pending') fail('NOT_PENDING', 'this request was already ' + l.status);
    if (l.leave_type !== 'unpaid') { var b = leaveBalance(db, l.member_id, Number(l.start_date.slice(0, 4))); if (l.days > b.remaining) fail('INSUFFICIENT_BALANCE', 'only ' + b.remaining + ' day(s) left'); }
  } else if (l.status !== 'pending' && l.status !== 'approved') fail('NOT_PENDING', 'this request was already ' + l.status);
  return db.update('leave_requests', l, { status: a.p_approve ? 'approved' : 'rejected', admin_note: trim(a.p_note) || null, decided_by: me.id, decided_at: iso(now()) });
};
H.admin_decide_correction = function (db, me, a) {
  requireAdmin(me);
  var c = db.find('correction_requests', a.p_id); if (!c) fail('NOT_FOUND', 'request not found');
  if (c.status !== 'pending') fail('NOT_PENDING', 'this request was already ' + c.status);
  if (a.p_approve) setAttendance(db, c.member_id, c.work_date, hm(c.requested_check_in), hm(c.requested_check_out), 'Correction request: ' + c.reason, 'correction');
  c = db.find('correction_requests', a.p_id);
  return db.update('correction_requests', c, { status: a.p_approve ? 'approved' : 'rejected', admin_note: trim(a.p_note) || null, decided_by: me.id, decided_at: iso(now()) });
};
H.add_holiday = function (db, me, a) {
  requireAdmin(me); var d = needDate(a.date), name = trim(a.name);
  if (name.length < 1 || name.length > 60) fail('BAD_NAME', 'holiday name must be 1–60 characters');
  if (db.holidayOn(d)) fail('EXISTS', 'there is already a holiday on that date');
  return db.insert('holidays', { id: uuid(), holiday_date: d, name: name });
};
H.delete_holiday = function (db, me, a) { requireAdmin(me); var h = db.find('holidays', a.id); if (!h) fail('NOT_FOUND', 'holiday not found'); db.remove('holidays', h); };
H.save_settings = function (db, me, a) {
  requireAdmin(me);
  var cur = db.settings(), next = JSON.parse(JSON.stringify(cur)), p = a.settings || {};
  var int = function (k, lo, hi) { if (k in p) { var v = Number(p[k]); if (!isFinite(v) || v < lo || v > hi) fail('BAD_SETTING', k + ' must be between ' + lo + ' and ' + hi); next[k] = v; } };
  if ('company_name' in p) { var n = trim(p.company_name); if (n.length < 1 || n.length > 80) fail('BAD_SETTING', 'company name must be 1–80 characters'); next.company_name = n; }
  if ('timezone' in p) { try { Utilities.formatDate(new Date(), p.timezone, 'HH'); } catch (e) { fail('BAD_SETTING', 'unknown time zone'); } next.timezone = String(p.timezone); }
  int('required_minutes', 60, 960); int('half_day_minutes', 30, 960); int('annual_leave_days', 0, 365); int('late_grace_minutes', 0, 240);
  int('geofence_radius_m', 20, 5000); int('max_gps_accuracy_m', 5, 1000);
  if ('weekend_mode' in p) { if (['sat_sun', 'sun', 'none'].indexOf(p.weekend_mode) < 0) fail('BAD_SETTING', 'unknown weekly off'); next.weekend_mode = p.weekend_mode; }
  if ('shift_start' in p) { if (!isTime(p.shift_start)) fail('BAD_SETTING', 'shift start must look like 09:30'); next.shift_start = hm(p.shift_start) + ':00'; }
  ['office_lat', 'office_lng'].forEach(function (k) { if (k in p) next[k] = p[k] === null || p[k] === '' ? null : Number(p[k]); });
  if (next.office_lat !== null && (!(Math.abs(next.office_lat) <= 90) || !(Math.abs(next.office_lng) <= 180))) fail('BAD_SETTING', 'office location is not valid');
  if ('geofence_enabled' in p) next.geofence_enabled = !!p.geofence_enabled;
  if (next.geofence_enabled && (next.office_lat === null || next.office_lng === null)) fail('BAD_SETTING', 'set the office location before turning the check on');
  if (next.half_day_minutes > next.required_minutes) fail('BAD_SETTING', 'half day cannot be longer than a full day');
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (JSON.stringify(next[k]) === JSON.stringify(cur[k])) return;
    var row = db.find('org_settings', k);
    if (row) db.update('org_settings', row, { value: JSON.stringify(next[k]) }); else db.insert('org_settings', { key: k, value: JSON.stringify(next[k]) });
  });
  db._settings = null; db._hol = null;
  return db.settings();
};

// Checks the hash chain AND replays the log against the live tabs, so direct edits to any tab are caught.
H.verify_audit_chain = function (db, me) {
  requireAdmin(me);
  var log = db.all('audit_log'), prev = 'GENESIS', state = {};
  for (var i = 0; i < log.length; i++) {
    var e = log[i], o = e.old_data ? JSON.parse(e.old_data) : null, n = e.new_data ? JSON.parse(e.new_data) : null;
    if (e.prev_hash !== prev || e.hash !== db.auditHash(e.prev_hash, e.at, e.actor, e.action, e.table_name, e.row_id, o, n))
      return [{ entries: log.length, broken_at: Number(e.id), last_hash: e.hash, problem: 'Audit entry #' + e.id + ' was altered or removed' }];
    var tbl = state[e.table_name] || (state[e.table_name] = {});
    if (n) tbl[e.row_id] = JSON.stringify(n); else delete tbl[e.row_id];
    prev = e.hash;
  }
  for (var t in AUDITED) {
    var expect = state[t] || {}, seen = {};
    var rows = db.all(t);
    for (var j = 0; j < rows.length; j++) {
      var k = rows[j].id || rows[j].key, cur = JSON.stringify(db.publicRow(t, rows[j]));
      seen[k] = 1;
      if (expect[k] !== cur) return [{ entries: log.length, broken_at: -1, last_hash: prev, problem: TAB_TITLES[t] + ' tab row ' + rows[j]._row + ' was edited directly in the sheet' }];
    }
    for (var k2 in expect) if (!seen[k2]) return [{ entries: log.length, broken_at: -1, last_hash: prev, problem: 'A row was deleted directly from the ' + TAB_TITLES[t] + ' tab' }];
  }
  return [{ entries: log.length, broken_at: null, last_hash: prev, problem: null }];
};

// ───────────── One-time setup (run from the Apps Script editor) ─────────────
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SHEET_ID', ss.getId());
  var db = new Db(ss);
  Object.keys(TABLES).forEach(function (t) { db.sheet(t); });
  var first = ss.getSheetByName('Sheet1'); if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  var code = props.getProperty('SETUP_CODE');
  if (!db.all('members').length && !code) { code = newCode(); props.setProperty('SETUP_CODE', code); }
  var msg = db.all('members').length ? 'PunchIn is already set up.' : 'PunchIn is ready. Admin set-up code: ' + code +
    '\n\nOpen the PunchIn app → "First time? Set up your account" → use your email, this code and a new password.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* not in sheet UI */ }
  return msg;
}
