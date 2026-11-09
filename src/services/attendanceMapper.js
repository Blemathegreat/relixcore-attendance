import { parseMysqlUtc, localTimeString } from '../lib/time.js';

/** DB row -> internal record (Dates for instants). */
export function mapAttendance(row) {
  return {
    id: row.id,
    userId: row.user_id,
    workDate: row.work_date,
    signInAt: parseMysqlUtc(row.sign_in_at),
    signOutAt: parseMysqlUtc(row.sign_out_at),
    punctuality: row.punctuality,
    lateMinutes: Number(row.late_minutes),
    source: row.source,
    isStale: Boolean(row.is_stale),
    signInRequestId: row.sign_in_request_id,
    signOutRequestId: row.sign_out_request_id,
  };
}

/** Internal record -> API shape. Times are pre-formatted in the company timezone. */
export function presentRecord(rec, tz) {
  if (!rec) return null;
  return {
    id: rec.id,
    workDate: rec.workDate,
    signInAt: rec.signInAt ? rec.signInAt.toISOString() : null,
    signInTime: rec.signInAt ? localTimeString(rec.signInAt, tz) : null,
    signOutAt: rec.signOutAt ? rec.signOutAt.toISOString() : null,
    signOutTime: rec.signOutAt ? localTimeString(rec.signOutAt, tz) : null,
    punctuality: rec.punctuality,
    lateMinutes: rec.lateMinutes,
    source: rec.source,
  };
}
