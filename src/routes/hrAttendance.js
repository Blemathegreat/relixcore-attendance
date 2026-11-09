import { Router } from 'express';
import { query } from '../db.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireBody, reqString, reqInt, reqDate, reqTime, reqMonth, queryInt, optString } from '../lib/validate.js';
import { toCsv } from '../lib/csv.js';
import { monthBounds, localDateString } from '../lib/time.js';
import { sensitiveLimiter } from '../middleware/security.js';
import { buildReport } from '../services/reportService.js';
import { applyCorrection } from '../services/correctionService.js';
import { loadSettings } from '../services/settingsService.js';

const router = Router();

const optUserId = (v) => (v === undefined || v === '' ? null : queryInt(v, 'userId'));

// Today at a glance.
router.get('/dashboard/today', asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  const now = new Date();
  const today = localDateString(now, settings.timezone);
  const report = await buildReport({ from: today, to: today, now });
  const rows = report.employees
    .filter((e) => e.isActive)
    .map((e) => ({ userId: e.userId, employeeId: e.employeeId, fullName: e.fullName, department: e.department, ...e.days[0] }));

  const summary = { totalActive: rows.length, signedIn: 0, onTime: 0, late: 0, signedOut: 0, stillIn: 0, missingSignOut: 0, notYetIn: 0, absent: 0 };
  for (const r of rows) {
    if (r.dayStatus === 'pending') summary.notYetIn += 1;
    if (r.dayStatus === 'absent') summary.absent += 1;
    if (r.recorded) {
      summary.signedIn += 1;
      if (r.punctuality === 'late') summary.late += 1; else summary.onTime += 1;
      if (r.signOutAt) summary.signedOut += 1;
      if (r.inProgress) summary.stillIn += 1;
      if (r.missingSignOut) summary.missingSignOut += 1;
    }
  }
  const info = rows[0] || null;
  res.json({
    date: today, timezone: settings.timezone, closeTime: settings.closeTime.slice(0, 5),
    isWorkingDay: info ? info.dayStatus !== 'non_working' : null,
    nonWorkingReason: info ? info.nonWorkingReason : null,
    holidayName: info ? info.holidayName : null,
    summary, employees: rows,
  });
}));

// Flat, filterable records (includes calculated absences and missing sign-outs).
router.get('/attendance', asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  const today = localDateString(new Date(), settings.timezone);
  const from = req.query.from ? reqDate(req.query.from, 'from') : `${today.slice(0, 8)}01`;
  const to = req.query.to ? reqDate(req.query.to, 'to') : today;
  const report = await buildReport({ from, to, userId: optUserId(req.query.userId) });

  const records = [];
  for (const e of report.employees) {
    for (const d of e.days) {
      if (d.dayStatus === 'future' || d.dayStatus === 'not_employed') continue;
      if (d.dayStatus === 'non_working' && !d.recorded) continue;
      records.push({ userId: e.userId, employeeId: e.employeeId, fullName: e.fullName, ...d });
    }
  }
  records.sort((a, b) => (a.workDate === b.workDate ? a.employeeId.localeCompare(b.employeeId) : a.workDate < b.workDate ? 1 : -1));
  res.json({ meta: report.meta, records });
}));

router.get('/reports/monthly', asyncHandler(async (req, res) => {
  const month = reqMonth(req.query.month);
  const { from, to } = monthBounds(month);
  const report = await buildReport({ from, to, userId: optUserId(req.query.userId) });
  res.json({ month, ...report });
}));

const STATUS_TEXT = { present: 'Present', absent: 'Potential absence', pending: 'Pending', non_working: 'Non-working day' };
router.get('/reports/monthly.csv', asyncHandler(async (req, res) => {
  const month = reqMonth(req.query.month);
  const { from, to } = monthBounds(month);
  const report = await buildReport({ from, to, userId: optUserId(req.query.userId) });
  const rows = [];
  for (const e of report.employees) {
    for (const d of e.days) {
      if (d.dayStatus === 'future' || d.dayStatus === 'not_employed') continue;
      rows.push({ e, d });
    }
  }
  const csv = toCsv(
    [
      { label: 'Employee ID', value: (r) => r.e.employeeId },
      { label: 'Name', value: (r) => r.e.fullName },
      { label: 'Department', value: (r) => r.e.department },
      { label: 'Date', value: (r) => r.d.workDate },
      { label: 'Day status', value: (r) => (r.d.dayStatus === 'non_working' ? (r.d.nonWorkingReason === 'holiday' ? `Holiday: ${r.d.holidayName}` : 'Weekend / non-working') : STATUS_TEXT[r.d.dayStatus]) },
      { label: 'Sign in', value: (r) => r.d.signInTime },
      { label: 'Sign out', value: (r) => r.d.signOutTime },
      { label: 'Punctuality', value: (r) => (r.d.punctuality === 'late' ? 'Late' : r.d.punctuality === 'on_time' ? 'On time' : '') },
      { label: 'Minutes late', value: (r) => (r.d.punctuality === 'late' ? r.d.lateMinutes : '') },
      { label: 'Missing sign-out', value: (r) => (r.d.missingSignOut ? 'Yes' : '') },
      { label: 'Worked minutes', value: (r) => r.d.workedMinutes },
      { label: 'Record source', value: (r) => r.d.source },
    ],
    rows,
  );
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  res.send(csv);
}));

router.post('/attendance/corrections', sensitiveLimiter, asyncHandler(async (req, res) => {
  const b = requireBody(req.body);
  const userId = reqInt(b.userId, 'userId', { min: 1 });
  const workDate = reqDate(b.workDate, 'workDate');
  const signInTime = b.signInTime ? reqTime(b.signInTime, 'signInTime') : null;
  const signOutTime = b.signOutTime ? reqTime(b.signOutTime, 'signOutTime') : null;
  const reason = reqString(b.reason, 'reason', { min: 5, max: 500 });
  const record = await applyCorrection({ actor: req.user, userId, workDate, signInTime, signOutTime, reason, ip: req.ip });
  res.json({ record });
}));

// Audit trail (read-only).
router.get('/audit-logs', asyncHandler(async (req, res) => {
  const limit = req.query.limit ? queryInt(req.query.limit, 'limit', { min: 1, max: 200 }) : 50;
  const offset = req.query.offset ? queryInt(req.query.offset, 'offset', { min: 0, max: 100000 }) : 0;
  const where = [];
  const params = [];
  if (req.query.userId) { where.push('a.target_user_id = ?'); params.push(queryInt(req.query.userId, 'userId')); }
  if (typeof req.query.action === 'string' && req.query.action) {
    where.push('a.action = ?'); params.push(optString(req.query.action, 'action', { max: 60 }));
  }
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.reason, a.old_values, a.new_values, a.created_at,
            actor.full_name AS actor_name, actor.employee_id AS actor_employee_id,
            target.full_name AS target_name, target.employee_id AS target_employee_id
       FROM audit_logs a
       JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users target ON target.id = a.target_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  res.json({
    logs: rows.map((r) => ({
      id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, reason: r.reason,
      oldValues: r.old_values, newValues: r.new_values,
      createdAt: new Date(`${r.created_at.replace(' ', 'T')}Z`).toISOString(),
      actor: { name: r.actor_name, employeeId: r.actor_employee_id },
      target: r.target_name ? { name: r.target_name, employeeId: r.target_employee_id } : null,
    })),
  });
}));

export default router;
