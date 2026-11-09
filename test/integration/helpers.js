// Integration test helpers. These run against a REAL MySQL database.
//
//   TEST_DB_NAME=coreview_attendance_test DB_USER=... DB_PASSWORD=... npm run test:integration
//
// The database must already have the schema (run `npm run migrate` with DB_NAME pointed at it).
// ALL TABLE DATA IN THAT DATABASE IS ERASED between tests, so its name must contain "test".
export const SKIP_REASON = !process.env.TEST_DB_NAME
  ? 'Set TEST_DB_NAME (plus DB_USER / DB_PASSWORD) to run integration tests.'
  : !/test/i.test(process.env.TEST_DB_NAME)
    ? 'TEST_DB_NAME must contain "test" so production data can never be erased.'
    : false;

export const OFFICE = { latitude: 6.5244, longitude: 3.3792 };
export const metresNorth = (m) => OFFICE.latitude + m / 111195;
export const inside = (extra = {}) => ({ latitude: metresNorth(10), longitude: OFFICE.longitude, accuracy: 8, ...extra });
export const outside = (extra = {}) => ({ latitude: metresNorth(400), longitude: OFFICE.longitude, accuracy: 8, ...extra });
let counter = 0;
export const rid = () => `req-${Date.now()}-${++counter}-${Math.random().toString(16).slice(2, 8)}`;

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
  }

  async req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0];
      if (pair.startsWith('cv_session=')) this.cookie = pair.endsWith('=') ? null : pair;
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  get = (p) => this.req('GET', p);
  post = (p, b = {}) => this.req('POST', p, b);
  put = (p, b = {}) => this.req('PUT', p, b);
  patch = (p, b = {}) => this.req('PATCH', p, b);

  login(employeeId, password) {
    return this.post('/api/auth/login', { employeeId, password });
  }
}

export async function boot() {
  process.env.NODE_ENV = 'test';
  process.env.DB_NAME = process.env.TEST_DB_NAME;
  process.env.BCRYPT_COST = '4'; // fast hashing for tests only
  process.env.SERVE_CLIENT = 'false';
  const { createApp } = await import('../../src/app.js');
  const db = await import('../../src/db.js');
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function reset() {
    const conn = await db.pool.getConnection();
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of ['audit_logs', 'attendance', 'sessions', 'holidays', 'users', 'settings']) {
        await conn.query(`TRUNCATE TABLE ${t}`);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      await conn.query('INSERT INTO settings (id) VALUES (1)');
    } finally {
      conn.release();
    }
  }

  async function createUser({ employeeId, role = 'employee', password = 'Passw0rd-test', mustChange = 0, startDate = '2020-01-01' }) {
    const { default: bcrypt } = await import('bcryptjs');
    const hash = await bcrypt.hash(password, 4);
    const [r] = await db.pool.execute(
      `INSERT INTO users (employee_id, full_name, role, password_hash, must_change_password, start_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employeeId, `Test ${employeeId}`, role, hash, mustChange, startDate],
    );
    return { id: r.insertId, employeeId, password };
  }

  async function loggedIn(user) {
    const c = new Client(base);
    const r = await c.login(user.employeeId, user.password);
    if (r.status !== 200) throw new Error(`login failed for ${user.employeeId}: ${r.text}`);
    return c;
  }

  /** HR account + office configured at OFFICE, radius 50 m, every day a working day. */
  async function setupCompany() {
    await reset();
    const hr = await createUser({ employeeId: 'HR-TEST', role: 'hr' });
    const hrClient = await loggedIn(hr);
    const r = await hrClient.put('/api/hr/settings', {
      officeLatitude: OFFICE.latitude,
      officeLongitude: OFFICE.longitude,
      geofenceRadiusM: 50,
      maxAccuracyM: 50,
      resumeTime: '00:00',
      closeTime: '23:59',
      graceMinutes: 0,
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      timezone: 'Africa/Lagos',
    });
    if (r.status !== 200) throw new Error(`settings failed: ${r.text}`);
    return { hr, hrClient };
  }

  return {
    base, db, reset, createUser, loggedIn, setupCompany,
    services: {
      attendance: await import('../../src/services/attendanceService.js'),
      report: await import('../../src/services/reportService.js'),
    },
    async close() {
      await new Promise((r) => server.close(r));
      await db.pool.end();
    },
  };
}
