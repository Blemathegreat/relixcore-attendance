import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_REASON, boot, Client, inside, outside, rid } from './helpers.js';

const opts = { skip: SKIP_REASON };
let ctx;

test('boot', opts, async () => { ctx = await boot(); });
test.after(async () => { if (ctx) await ctx.close(); });

// --- 1 & 2: HR creates an employee; employee logs in and must change the initial password ---
test('HR creates an employee; the employee must change the initial password', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  const created = await hrClient.post('/api/hr/employees', { employeeId: 'cv-100', fullName: 'Ada Obi', department: 'Ops' });
  assert.equal(created.status, 201);
  assert.equal(created.json.employee.employeeId, 'CV-100');
  const temp = created.json.temporaryPassword;
  assert.ok(temp && temp.length >= 10);

  const [[row]] = await ctx.db.pool.query("SELECT password_hash FROM users WHERE employee_id = 'CV-100'");
  assert.notEqual(row.password_hash, temp, 'password must be stored hashed');
  assert.match(row.password_hash, /^\$2[aby]\$/);

  const dup = await hrClient.post('/api/hr/employees', { employeeId: 'CV-100', fullName: 'Someone Else' });
  assert.equal(dup.status, 409);

  const emp = new Client(ctx.base);
  const login = await emp.login('CV-100', temp);
  assert.equal(login.status, 200);
  assert.equal(login.json.user.mustChangePassword, true);

  const blocked = await emp.get('/api/me/attendance/today');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'PASSWORD_CHANGE_REQUIRED');

  const weak = await emp.post('/api/auth/change-password', { currentPassword: temp, newPassword: 'short' });
  assert.equal(weak.status, 400);
  const changed = await emp.post('/api/auth/change-password', { currentPassword: temp, newPassword: 'My-new-pass-42' });
  assert.equal(changed.status, 200);
  assert.equal((await emp.get('/api/me/attendance/today')).status, 200);

  const fresh = new Client(ctx.base);
  assert.equal((await fresh.login('CV-100', temp)).status, 401, 'old password no longer works');
  assert.equal((await fresh.login('CV-100', 'My-new-pass-42')).status, 200);
});

test('login: wrong password gives a generic error, logout ends the session', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-101' });
  const c = new Client(ctx.base);
  const bad = await c.login('CV-101', 'nope');
  assert.equal(bad.status, 401);
  assert.equal((await c.login('NO-SUCH-ID', 'nope')).json.error.message, bad.json.error.message);
  assert.equal((await c.login(u.employeeId, u.password)).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

// --- 3-9: geofence and sequence rules ---
test('sign-in/out geofence and sequence rules', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-200' });
  const c = await ctx.loggedIn(u);
  const si = (b) => c.post('/api/me/attendance/sign-in', b);
  const so = (b) => c.post('/api/me/attendance/sign-out', b);

  // 8: sign-out before any sign-in
  const early = await so({ ...inside(), requestId: rid() });
  assert.equal(early.status, 409);
  assert.equal(early.json.error.code, 'NO_ACTIVE_SESSION');

  // 4: outside the geofence
  const far = await si({ ...outside(), requestId: rid() });
  assert.equal(far.status, 403);
  assert.equal(far.json.error.code, 'OUTSIDE_GEOFENCE');

  // 5: location denied/unavailable -> no coordinates
  const none = await si({ requestId: rid() });
  assert.equal(none.status, 400);
  assert.equal(none.json.error.code, 'LOCATION_UNAVAILABLE');
  const poor = await si({ ...inside({ accuracy: 300 }), requestId: rid() });
  assert.equal(poor.status, 422);
  assert.equal(poor.json.error.code, 'POOR_ACCURACY');

  // Nothing may have been recorded by any failed attempt
  const [[cnt0]] = await ctx.db.pool.query('SELECT COUNT(*) AS n FROM attendance WHERE user_id = ?', [u.id]);
  assert.equal(cnt0.n, 0);

  // A client claiming it is inside the boundary changes nothing
  const lie = await si({ ...outside(), insideGeofence: true, requestId: rid() });
  assert.equal(lie.status, 403);

  // 3: inside the geofence works
  const reqId = rid();
  const ok = await si({ ...inside(), requestId: reqId });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.replayed, false);

  // retry of the SAME request is safe (idempotent), a NEW request is a duplicate (6)
  const replay = await si({ ...inside(), requestId: reqId });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  const dup = await si({ ...inside(), requestId: rid() });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'DUPLICATE_SIGN_IN');

  // sign-out must also be inside the geofence
  assert.equal((await so({ ...outside(), requestId: rid() })).status, 403);

  // 7: valid sign-out
  const outId = rid();
  const out = await so({ ...inside(), requestId: outId });
  assert.equal(out.status, 200);
  assert.ok(out.json.record.signOutAt);

  // 9: duplicate sign-out
  const dupOut = await so({ ...inside(), requestId: rid() });
  assert.equal(dupOut.status, 409);
  assert.equal(dupOut.json.error.code, 'DUPLICATE_SIGN_OUT');
  assert.equal((await so({ ...inside(), requestId: outId })).json.replayed, true);

  const [[cnt]] = await ctx.db.pool.query('SELECT COUNT(*) AS n FROM attendance WHERE user_id = ?', [u.id]);
  assert.equal(cnt.n, 1);
});

test('a configured grace period decides on-time vs late (service level, fixed clock)', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  await hrClient.put('/api/hr/settings', {
    officeLatitude: 6.5244, officeLongitude: 3.3792, geofenceRadiusM: 50, maxAccuracyM: 50,
    resumeTime: '08:00', closeTime: '17:00', graceMinutes: 10, workingDays: [0, 1, 2, 3, 4, 5, 6], timezone: 'Africa/Lagos',
  });
  const a = await ctx.createUser({ employeeId: 'CV-300' });
  const b = await ctx.createUser({ employeeId: 'CV-301' });
  const at = (t) => new Date(`2026-10-29T${t}+01:00`);
  const r1 = await ctx.services.attendance.signIn({ id: a.id }, { ...inside(), requestId: rid() }, at('08:10:00'));
  assert.equal(r1.record.punctuality, 'on_time');
  const r2 = await ctx.services.attendance.signIn({ id: b.id }, { ...inside(), requestId: rid() }, at('08:10:01'));
  assert.equal(r2.record.punctuality, 'late');
  assert.equal(r2.record.lateMinutes, 10);
});

// --- 11-13: absence timing, missing sign-out, non-working days (fixed clock) ---
test('absence is calculated only after closing time; missing sign-out is flagged; non-working days excluded', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  await hrClient.put('/api/hr/settings', {
    officeLatitude: 6.5244, officeLongitude: 3.3792, geofenceRadiusM: 50, maxAccuracyM: 50,
    resumeTime: '08:00', closeTime: '17:00', graceMinutes: 10, workingDays: [1, 2, 3, 4, 5], timezone: 'Africa/Lagos',
  });
  await hrClient.post('/api/hr/holidays', { date: '2026-10-30', description: 'Company retreat' });
  const absentee = await ctx.createUser({ employeeId: 'CV-400' });
  const forgetful = await ctx.createUser({ employeeId: 'CV-401' });
  const at = (d, t) => new Date(`${d}T${t}+01:00`);

  await ctx.services.attendance.signIn({ id: forgetful.id }, { ...inside(), requestId: rid() }, at('2026-10-28', '08:00:00'));

  const rep = (now) => ctx.services.report.buildReport({ from: '2026-10-28', to: '2026-11-01', now });
  const find = (r, id) => r.employees.find((e) => e.employeeId === id);

  const midday = await rep(at('2026-10-29', '12:00:00'));
  const t29 = find(midday, 'CV-400').days.find((d) => d.workDate === '2026-10-29');
  assert.equal(t29.dayStatus, 'pending');
  assert.equal(find(midday, 'CV-400').days.find((d) => d.workDate === '2026-10-28').dayStatus, 'absent');

  const evening = await rep(at('2026-10-29', '17:30:00'));
  assert.equal(find(evening, 'CV-400').days.find((d) => d.workDate === '2026-10-29').dayStatus, 'absent');

  const missing = find(evening, 'CV-401').days.find((d) => d.workDate === '2026-10-28');
  assert.equal(missing.missingSignOut, true);
  assert.equal(missing.signOutAt, null, 'no sign-out time may be invented');

  const later = await rep(at('2026-11-02', '12:00:00'));
  const days = find(later, 'CV-400').days;
  assert.equal(days.find((d) => d.workDate === '2026-10-30').nonWorkingReason, 'holiday');
  assert.equal(days.find((d) => d.workDate === '2026-10-31').nonWorkingReason, 'weekend');
  assert.equal(days.find((d) => d.workDate === '2026-11-01').dayStatus, 'non_working');
  assert.equal(find(later, 'CV-400').totals.absentDays, 2); // 28th and 29th only
  void absentee;
});

// --- 14: employees cannot reach other people's data or HR functions ---
test('permissions: employees cannot see others or use HR endpoints; anonymous is rejected', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  const a = await ctx.createUser({ employeeId: 'CV-500' });
  const b = await ctx.createUser({ employeeId: 'CV-501' });
  const ca = await ctx.loggedIn(a);
  const cb = await ctx.loggedIn(b);
  assert.equal((await cb.post('/api/me/attendance/sign-in', { ...inside(), requestId: rid() })).status, 200);

  const anon = new Client(ctx.base);
  assert.equal((await anon.get('/api/me/attendance/today')).status, 401);
  assert.equal((await anon.get('/api/hr/employees')).status, 401);

  for (const [method, path, body] of [
    ['get', '/api/hr/employees'],
    ['post', '/api/hr/employees', { employeeId: 'X-1', fullName: 'X' }],
    ['get', '/api/hr/attendance'],
    ['get', '/api/hr/settings'],
    ['put', '/api/hr/settings', {}],
    ['post', '/api/hr/attendance/corrections', { userId: b.id, workDate: '2026-10-01', signInTime: '08:00', reason: 'forged' }],
    ['get', '/api/hr/audit-logs'],
    ['get', '/api/hr/reports/monthly?month=2026-10'],
  ]) {
    const r = await ca[method](path, body);
    assert.equal(r.status, 403, `${method} ${path} should be forbidden for employees`);
  }

  // A userId in the query string is ignored: A only ever sees A's own history.
  const mine = await ca.get(`/api/me/attendance?userId=${b.id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.totals.presentDays, 0);

  // HR accounts do not use the employee attendance endpoints.
  assert.equal((await hrClient.get('/api/me/attendance/today')).status, 403);
});

// --- 15 & 16: corrections require a reason and are audited; reports reflect them ---
test('HR corrections need a reason, are audited, and appear in reports', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-600' });

  const noReason = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2026-10-01', signInTime: '08:05', signOutTime: '17:00' });
  assert.equal(noReason.status, 400);
  const shortReason = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2026-10-01', signInTime: '08:05', reason: 'x' });
  assert.equal(shortReason.status, 400);
  const badOrder = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2026-10-01', signInTime: '17:00', signOutTime: '08:00', reason: 'wrong way round' });
  assert.equal(badOrder.status, 400);
  const future = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2999-01-01', signInTime: '08:00', reason: 'future date' });
  assert.equal(future.status, 400);

  const ok = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2026-10-01', signInTime: '08:05', signOutTime: '17:00', reason: 'Phone battery died; confirmed by supervisor' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.record.signInTime, '08:05');
  assert.equal(ok.json.record.source, 'correction');

  const amend = await hrClient.post('/api/hr/attendance/corrections', { userId: u.id, workDate: '2026-10-01', signOutTime: '17:30', reason: 'Left later than first recorded' });
  assert.equal(amend.status, 200);
  assert.equal(amend.json.record.signOutTime, '17:30');

  const audit = await hrClient.get('/api/hr/audit-logs');
  assert.equal(audit.status, 200);
  const corrections = audit.json.logs.filter((l) => l.action.startsWith('attendance.'));
  assert.equal(corrections.length, 2);
  const amendLog = corrections.find((l) => l.action === 'attendance.correct');
  assert.equal(amendLog.reason, 'Left later than first recorded');
  assert.equal(amendLog.oldValues.signOutTime, '17:00');
  assert.equal(amendLog.newValues.signOutTime, '17:30');

  const report = await hrClient.get('/api/hr/reports/monthly?month=2026-10');
  assert.equal(report.status, 200);
  const day = report.json.employees.find((e) => e.employeeId === 'CV-600').days.find((d) => d.workDate === '2026-10-01');
  assert.equal(day.signInTime, '08:05');
  assert.equal(day.signOutTime, '17:30');
  // setupCompany() uses resume 00:00 with no grace, so 08:05 is recorded as late (policy snapshot).
  assert.equal(day.punctuality, 'late');
  assert.equal(day.lateMinutes, 485);
  const csv = await hrClient.get('/api/hr/reports/monthly.csv?month=2026-10');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes('CV-600'));
});

// --- 17: concurrency ---
test('concurrent sign-ins create exactly one session; concurrent sign-outs close it once', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-700' });
  const c = await ctx.loggedIn(u);

  const ins = await Promise.all(
    Array.from({ length: 10 }, () => c.post('/api/me/attendance/sign-in', { ...inside(), requestId: rid() })),
  );
  assert.equal(ins.filter((r) => r.status === 200).length, 1, ins.map((r) => r.status).join(','));
  assert.equal(ins.filter((r) => r.status === 409).length, 9);
  const [[n1]] = await ctx.db.pool.query('SELECT COUNT(*) AS n FROM attendance WHERE user_id = ?', [u.id]);
  assert.equal(n1.n, 1);

  const outs = await Promise.all(
    Array.from({ length: 5 }, () => c.post('/api/me/attendance/sign-out', { ...inside(), requestId: rid() })),
  );
  assert.equal(outs.filter((r) => r.status === 200).length, 1, outs.map((r) => r.status).join(','));
  assert.equal(outs.filter((r) => r.status === 409).length, 4);
});

test('the database itself refuses a second open session for one employee', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-701' });
  const ins = (d) => ctx.db.pool.execute(
    "INSERT INTO attendance (user_id, work_date, sign_in_at, punctuality, source) VALUES (?, ?, UTC_TIMESTAMP(3), 'on_time', 'self')",
    [u.id, d],
  );
  await ins('2026-10-01');
  await assert.rejects(() => ins('2026-10-02'), (e) => e.code === 'ER_DUP_ENTRY'); // open_guard
  await assert.rejects(() => ins('2026-10-01'), (e) => e.code === 'ER_DUP_ENTRY'); // user + date
});

test('a forgotten sign-out yesterday does not block today and stays flagged', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-702' });
  await ctx.db.pool.execute(
    "INSERT INTO attendance (user_id, work_date, sign_in_at, punctuality, source) VALUES (?, '2020-01-02', '2020-01-02 07:00:00.000', 'on_time', 'self')",
    [u.id],
  );
  const c = await ctx.loggedIn(u);
  const r = await c.post('/api/me/attendance/sign-in', { ...inside(), requestId: rid() });
  assert.equal(r.status, 200);
  const [[old]] = await ctx.db.pool.query("SELECT sign_out_at, is_stale FROM attendance WHERE user_id = ? AND work_date = '2020-01-02'", [u.id]);
  assert.equal(old.sign_out_at, null);
  assert.equal(old.is_stale, 1);
});

test('deactivated accounts cannot log in and existing sessions end', opts, async () => {
  const { hrClient } = await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-800' });
  const c = await ctx.loggedIn(u);
  assert.equal((await c.get('/api/auth/me')).status, 200);
  const off = await hrClient.patch(`/api/hr/employees/${u.id}`, { isActive: false });
  assert.equal(off.status, 200);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  assert.equal((await new Client(ctx.base).login('CV-800', u.password)).status, 403);
});

test('repeated failed logins lock the account temporarily', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-900' });
  const c = new Client(ctx.base);
  for (let i = 0; i < 5; i += 1) assert.equal((await c.login('CV-900', 'wrong-pass-1')).status, 401);
  const locked = await c.login('CV-900', u.password);
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, 'ACCOUNT_LOCKED');
});

test('cross-site and non-JSON state changes are rejected; errors never leak internals', opts, async () => {
  await ctx.setupCompany();
  const u = await ctx.createUser({ employeeId: 'CV-950' });
  const c = await ctx.loggedIn(u);
  const evil = await fetch(`${ctx.base}/api/me/attendance/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: c.cookie },
    body: JSON.stringify({ ...inside(), requestId: rid() }),
  });
  assert.equal(evil.status, 403);
  const form = await fetch(`${ctx.base}/api/me/attendance/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c.cookie },
    body: 'latitude=6.5&longitude=3.3',
  });
  assert.equal(form.status, 415);
  const bad = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes('at '), 'no stack trace in responses');
});
