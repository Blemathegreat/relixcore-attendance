import { Router } from 'express';
import { query, withTransaction, isDuplicateKey } from '../db.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireBody, reqString, optString, reqDate, reqBool, queryInt } from '../lib/validate.js';
import { hashPassword } from '../lib/password.js';
import { generateTempPassword } from '../lib/passwordRules.js';
import { addDays, localDateString } from '../lib/time.js';
import { sensitiveLimiter } from '../middleware/security.js';
import { loadSettings } from '../services/settingsService.js';
import { writeAudit } from '../services/auditService.js';
import { destroyUserSessions } from '../services/sessionService.js';

const router = Router();
const EMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

const present = (r) => ({
  id: r.id,
  employeeId: r.employee_id,
  fullName: r.full_name,
  email: r.email,
  phone: r.phone,
  department: r.department,
  jobTitle: r.job_title,
  isActive: Boolean(r.is_active),
  startDate: r.start_date,
  endDate: r.end_date,
  mustChangePassword: Boolean(r.must_change_password),
  lastLoginAt: r.last_login_at ? new Date(`${r.last_login_at.replace(' ', 'T')}Z`).toISOString() : null,
});

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function duplicateMessage(err) {
  return String(err.sqlMessage || '').includes('uq_users_email')
    ? 'That email address is already used by another account.'
    : 'That employee ID is already in use.';
}

router.get('/', asyncHandler(async (req, res) => {
  const status = ['active', 'inactive', 'all'].includes(req.query.status) ? req.query.status : 'all';
  const where = ["role = 'employee'"];
  const params = [];
  if (status === 'active') where.push('is_active = 1');
  if (status === 'inactive') where.push('is_active = 0');
  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    const like = `%${escapeLike(req.query.search.trim().slice(0, 60))}%`;
    where.push('(employee_id LIKE ? OR full_name LIKE ? OR email LIKE ?)');
    params.push(like, like, like);
  }
  const rows = await query(
    `SELECT * FROM users WHERE ${where.join(' AND ')} ORDER BY employee_id LIMIT 500`,
    params,
  );
  res.json({ employees: rows.map(present) });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = queryInt(req.params.id, 'id');
  const rows = await query("SELECT * FROM users WHERE id = ? AND role = 'employee'", [id]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');
  res.json({ employee: present(rows[0]) });
}));

router.post('/', sensitiveLimiter, asyncHandler(async (req, res) => {
  const b = requireBody(req.body);
  const employeeId = reqString(b.employeeId, 'employeeId', { max: 32 }).toUpperCase();
  if (!EMP_ID_RE.test(employeeId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'employeeId: use 2-32 letters, numbers, dots, dashes or underscores.', { field: 'employeeId' });
  }
  const fullName = reqString(b.fullName, 'fullName', { max: 120 });
  const email = optString(b.email, 'email', { max: 190 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'email: must be a valid email address.', { field: 'email' });
  }
  const phone = optString(b.phone, 'phone', { max: 32 });
  const department = optString(b.department, 'department', { max: 100 });
  const jobTitle = optString(b.jobTitle, 'jobTitle', { max: 100 });
  const settings = await loadSettings();
  const startDate = b.startDate ? reqDate(b.startDate, 'startDate') : localDateString(new Date(), settings.timezone);

  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    const created = await withTransaction(async (conn) => {
      const [r] = await conn.execute(
        `INSERT INTO users (employee_id, full_name, email, phone, department, job_title,
                            role, password_hash, must_change_password, start_date)
         VALUES (?, ?, ?, ?, ?, ?, 'employee', ?, 1, ?)`,
        [employeeId, fullName, email, phone, department, jobTitle, passwordHash, startDate],
      );
      const [rows] = await conn.execute('SELECT * FROM users WHERE id = ?', [r.insertId]);
      await writeAudit(conn, {
        actorId: req.user.id, action: 'employee.create', entityType: 'user', entityId: r.insertId,
        targetUserId: r.insertId, newValues: { employeeId, fullName, email, department, jobTitle, startDate }, ip: req.ip,
      });
      return rows[0];
    });
    // The temporary password is shown ONCE here and is never stored in readable form.
    res.status(201).json({ employee: present(created), temporaryPassword });
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError(409, 'DUPLICATE', duplicateMessage(err));
    throw err;
  }
}));

router.patch('/:id', sensitiveLimiter, asyncHandler(async (req, res) => {
  const id = queryInt(req.params.id, 'id');
  const b = requireBody(req.body);
  const changes = {};
  if ('fullName' in b) changes.full_name = reqString(b.fullName, 'fullName', { max: 120 });
  if ('email' in b) {
    const email = optString(b.email, 'email', { max: 190 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'email: must be a valid email address.', { field: 'email' });
    }
    changes.email = email;
  }
  if ('phone' in b) changes.phone = optString(b.phone, 'phone', { max: 32 });
  if ('department' in b) changes.department = optString(b.department, 'department', { max: 100 });
  if ('jobTitle' in b) changes.job_title = optString(b.jobTitle, 'jobTitle', { max: 100 });
  if ('startDate' in b) changes.start_date = reqDate(b.startDate, 'startDate');
  let activeChange = null;
  if ('isActive' in b) activeChange = reqBool(b.isActive, 'isActive');
  if (Object.keys(changes).length === 0 && activeChange === null) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Nothing to update.');
  }
  const settings = await loadSettings();

  try {
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.execute("SELECT * FROM users WHERE id = ? AND role = 'employee' FOR UPDATE", [id]);
      const before = rows[0];
      if (!before) throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');

      if (activeChange !== null && activeChange !== Boolean(before.is_active)) {
        changes.is_active = activeChange ? 1 : 0;
        // Days after deactivation are not counted as absences. Reactivation clears the end date.
        changes.end_date = activeChange ? null : addDays(localDateString(new Date(), settings.timezone), -1);
      }
      const keys = Object.keys(changes);
      if (keys.length === 0) return before;

      const oldValues = {};
      for (const k of keys) oldValues[k] = before[k];
      await conn.execute(
        `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map((k) => changes[k]), id],
      );
      const [after] = await conn.execute('SELECT * FROM users WHERE id = ?', [id]);
      await writeAudit(conn, {
        actorId: req.user.id,
        action: 'is_active' in changes ? (activeChange ? 'employee.activate' : 'employee.deactivate') : 'employee.update',
        entityType: 'user', entityId: id, targetUserId: id, oldValues, newValues: changes, ip: req.ip,
      });
      return after[0];
    });
    if (activeChange === false) await destroyUserSessions(id);
    res.json({ employee: present(result) });
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError(409, 'DUPLICATE', duplicateMessage(err));
    throw err;
  }
}));

router.post('/:id/reset-password', sensitiveLimiter, asyncHandler(async (req, res) => {
  const id = queryInt(req.params.id, 'id');
  const temporaryPassword = generateTempPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute("SELECT id FROM users WHERE id = ? AND role = 'employee' FOR UPDATE", [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');
    await conn.execute(
      'UPDATE users SET password_hash = ?, must_change_password = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?',
      [passwordHash, id],
    );
    await writeAudit(conn, {
      actorId: req.user.id, action: 'employee.reset_password', entityType: 'user', entityId: id, targetUserId: id, ip: req.ip,
    });
  });
  await destroyUserSessions(id);
  res.json({ temporaryPassword });
}));

export default router;
