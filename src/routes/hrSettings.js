import { Router } from 'express';
import { query, withTransaction, isDuplicateKey } from '../db.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireBody, reqString, reqNumber, reqInt, reqTime, reqDate, queryInt } from '../lib/validate.js';
import { isValidTimezone, normalizeTime } from '../lib/time.js';
import { sensitiveLimiter } from '../middleware/security.js';
import { loadSettings } from '../services/settingsService.js';
import { writeAudit } from '../services/auditService.js';

const router = Router();

router.get('/settings', asyncHandler(async (req, res) => {
  res.json({ settings: await loadSettings() });
}));

router.put('/settings', sensitiveLimiter, asyncHandler(async (req, res) => {
  const b = requireBody(req.body);
  const next = {
    officeLatitude: reqNumber(b.officeLatitude, 'officeLatitude', { min: -90, max: 90 }),
    officeLongitude: reqNumber(b.officeLongitude, 'officeLongitude', { min: -180, max: 180 }),
    geofenceRadiusM: reqInt(b.geofenceRadiusM, 'geofenceRadiusM', { min: 10, max: 5000 }),
    maxAccuracyM: reqInt(b.maxAccuracyM, 'maxAccuracyM', { min: 5, max: 500 }),
    resumeTime: reqTime(b.resumeTime, 'resumeTime'),
    closeTime: reqTime(b.closeTime, 'closeTime'),
    graceMinutes: reqInt(b.graceMinutes, 'graceMinutes', { min: 0, max: 120 }),
    timezone: reqString(b.timezone, 'timezone', { max: 64 }),
  };
  if (next.officeLatitude === 0 && next.officeLongitude === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'officeLatitude: (0, 0) is not a real office location.');
  }
  next.resumeTime = normalizeTime(next.resumeTime);
  next.closeTime = normalizeTime(next.closeTime);
  if (next.closeTime <= next.resumeTime) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'closeTime: must be later than the resumption time.');
  }
  if (!isValidTimezone(next.timezone)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'timezone: must be a valid timezone such as Africa/Lagos.');
  }
  if (!Array.isArray(b.workingDays) || b.workingDays.length === 0 ||
      !b.workingDays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'workingDays: choose at least one day (0 = Sunday ... 6 = Saturday).');
  }
  next.workingDays = [...new Set(b.workingDays)].sort((a, c) => a - c);

  const saved = await withTransaction(async (conn) => {
    const old = await loadSettings(conn);
    await conn.execute(
      `UPDATE settings
          SET office_latitude = ?, office_longitude = ?, geofence_radius_m = ?, max_accuracy_m = ?,
              resume_time = ?, close_time = ?, grace_minutes = ?, working_days = ?, timezone = ?, updated_by = ?
        WHERE id = 1`,
      [
        next.officeLatitude, next.officeLongitude, next.geofenceRadiusM, next.maxAccuracyM,
        next.resumeTime, next.closeTime, next.graceMinutes, next.workingDays.join(','), next.timezone, req.user.id,
      ],
    );
    const updated = await loadSettings(conn);
    const oldValues = {};
    const newValues = {};
    for (const k of Object.keys(next)) {
      if (JSON.stringify(old[k]) !== JSON.stringify(updated[k])) {
        oldValues[k] = old[k];
        newValues[k] = updated[k];
      }
    }
    if (Object.keys(newValues).length) {
      await writeAudit(conn, {
        actorId: req.user.id, action: 'settings.update', entityType: 'settings', entityId: 1, oldValues, newValues, ip: req.ip,
      });
    }
    return updated;
  });
  res.json({ settings: saved });
}));

router.get('/holidays', asyncHandler(async (req, res) => {
  const year = req.query.year ? queryInt(req.query.year, 'year', { min: 2000, max: 2100 }) : null;
  const rows = year
    ? await query('SELECT id, holiday_date, description FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date', [`${year}-01-01`, `${year}-12-31`])
    : await query('SELECT id, holiday_date, description FROM holidays ORDER BY holiday_date DESC LIMIT 400');
  res.json({ holidays: rows.map((r) => ({ id: r.id, date: r.holiday_date, description: r.description })) });
}));

router.post('/holidays', sensitiveLimiter, asyncHandler(async (req, res) => {
  const b = requireBody(req.body);
  const date = reqDate(b.date, 'date');
  const description = reqString(b.description, 'description', { max: 160 });
  try {
    const created = await withTransaction(async (conn) => {
      const [r] = await conn.execute('INSERT INTO holidays (holiday_date, description, created_by) VALUES (?, ?, ?)', [date, description, req.user.id]);
      await writeAudit(conn, {
        actorId: req.user.id, action: 'holiday.create', entityType: 'holiday', entityId: r.insertId, newValues: { date, description }, ip: req.ip,
      });
      return r.insertId;
    });
    res.status(201).json({ holiday: { id: created, date, description } });
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError(409, 'DUPLICATE', 'A holiday is already set for that date.');
    throw err;
  }
}));

router.delete('/holidays/:id', sensitiveLimiter, asyncHandler(async (req, res) => {
  const id = queryInt(req.params.id, 'id');
  await withTransaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM holidays WHERE id = ? FOR UPDATE', [id]);
    if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Holiday not found.');
    await conn.execute('DELETE FROM holidays WHERE id = ?', [id]);
    await writeAudit(conn, {
      actorId: req.user.id, action: 'holiday.delete', entityType: 'holiday', entityId: id,
      oldValues: { date: rows[0].holiday_date, description: rows[0].description }, ip: req.ip,
    });
  });
  res.json({ ok: true });
}));

export default router;
