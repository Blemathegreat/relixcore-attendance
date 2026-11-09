import { withTransaction, isDuplicateKey } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { classifyPunctuality } from '../lib/policy.js';
import { formatMysqlUtc, localDateString, localTimeString, zonedToUtc } from '../lib/time.js';
import { loadSettings } from './settingsService.js';
import { writeAudit } from './auditService.js';
import { mapAttendance, presentRecord } from './attendanceMapper.js';

const snapshot = (rec, tz) =>
  rec
    ? {
        workDate: rec.workDate,
        signInAt: rec.signInAt ? rec.signInAt.toISOString() : null,
        signInTime: rec.signInAt ? localTimeString(rec.signInAt, tz) : null,
        signOutAt: rec.signOutAt ? rec.signOutAt.toISOString() : null,
        signOutTime: rec.signOutAt ? localTimeString(rec.signOutAt, tz) : null,
        punctuality: rec.punctuality,
        lateMinutes: rec.lateMinutes,
        source: rec.source,
      }
    : null;

/**
 * HR correction: create or amend one employee's record for one date.
 * Always requires a reason and always writes an audit log in the SAME transaction.
 * Times are wall-clock times in the company timezone (HH:MM[:SS]).
 */
export async function applyCorrection({ actor, userId, workDate, signInTime, signOutTime, reason, ip, now = new Date() }) {
  const settings = await loadSettings();
  const tz = settings.timezone;
  const today = localDateString(now, tz);

  if (workDate > today) throw new ApiError(400, 'VALIDATION_ERROR', 'workDate: cannot correct a date in the future.');
  if (!signInTime && !signOutTime) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Provide a sign-in time, a sign-out time, or both.');
  }
  const inAt = signInTime ? zonedToUtc(workDate, signInTime, tz) : null;
  const outAt = signOutTime ? zonedToUtc(workDate, signOutTime, tz) : null;
  const limit = now.getTime() + 60000;
  if ((inAt && inAt.getTime() > limit) || (outAt && outAt.getTime() > limit)) {
    throw new ApiError(400, 'INVALID_TIMES', 'Times cannot be in the future.');
  }

  try {
    return await withTransaction(async (conn) => {
      const [uRows] = await conn.execute(
        "SELECT id, role FROM users WHERE id = ? FOR UPDATE",
        [userId],
      );
      if (!uRows[0] || uRows[0].role !== 'employee') {
        throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');
      }

      const [rows] = await conn.execute(
        'SELECT * FROM attendance WHERE user_id = ? AND work_date = ? FOR UPDATE',
        [userId, workDate],
      );
      const existing = rows[0] ? mapAttendance(rows[0]) : null;

      const newIn = inAt || existing?.signInAt || null;
      const newOut = outAt || existing?.signOutAt || null;
      if (!newIn) {
        throw new ApiError(400, 'INVALID_TIMES', 'A sign-in time is required to create a record for a day with no attendance.');
      }
      if (newOut && newOut.getTime() <= newIn.getTime()) {
        throw new ApiError(400, 'INVALID_TIMES', 'The sign-out time must be after the sign-in time.');
      }

      const { status, lateMinutes } = classifyPunctuality(newIn, workDate, settings);
      const stale = !newOut && workDate < today ? 1 : 0;

      // Keep the "one open session per employee" rule intact.
      await conn.execute(
        'UPDATE attendance SET is_stale = 1 WHERE user_id = ? AND sign_out_at IS NULL AND is_stale = 0 AND work_date < ? AND id <> ?',
        [userId, today, existing ? existing.id : 0],
      );

      let id;
      if (existing) {
        id = existing.id;
        await conn.execute(
          `UPDATE attendance
              SET sign_in_at = ?, sign_out_at = ?, punctuality = ?, late_minutes = ?,
                  source = 'correction', is_stale = ?
            WHERE id = ?`,
          [formatMysqlUtc(newIn), newOut ? formatMysqlUtc(newOut) : null, status, lateMinutes, stale, id],
        );
      } else {
        const [res] = await conn.execute(
          `INSERT INTO attendance
             (user_id, work_date, sign_in_at, sign_out_at, punctuality, late_minutes, source, is_stale)
           VALUES (?, ?, ?, ?, ?, ?, 'correction', ?)`,
          [userId, workDate, formatMysqlUtc(newIn), newOut ? formatMysqlUtc(newOut) : null, status, lateMinutes, stale],
        );
        id = res.insertId;
      }

      const [after] = await conn.execute('SELECT * FROM attendance WHERE id = ?', [id]);
      const updated = mapAttendance(after[0]);

      await writeAudit(conn, {
        actorId: actor.id,
        action: existing ? 'attendance.correct' : 'attendance.create_manual',
        entityType: 'attendance',
        entityId: id,
        targetUserId: userId,
        reason,
        oldValues: snapshot(existing, tz),
        newValues: snapshot(updated, tz),
        ip,
      });

      return presentRecord(updated, tz);
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new ApiError(409, 'CONFLICT', 'This record was changed by someone else. Please reload and try again.');
    }
    throw err;
  }
}
