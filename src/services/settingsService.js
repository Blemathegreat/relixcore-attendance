import { query } from '../db.js';
import { ApiError } from '../lib/errors.js';

export function mapSettings(r) {
  return {
    companyName: r.company_name,
    officeLatitude: r.office_latitude == null ? null : Number(r.office_latitude),
    officeLongitude: r.office_longitude == null ? null : Number(r.office_longitude),
    geofenceRadiusM: Number(r.geofence_radius_m),
    maxAccuracyM: Number(r.max_accuracy_m),
    resumeTime: r.resume_time,
    closeTime: r.close_time,
    graceMinutes: Number(r.grace_minutes),
    workingDays: String(r.working_days).split(',').filter(Boolean).map(Number),
    timezone: r.timezone,
    updatedAt: r.updated_at,
  };
}

export async function loadSettings(executor = { execute: (s, p) => query(s, p).then((rows) => [rows]) }) {
  const [rows] = await executor.execute('SELECT * FROM settings WHERE id = 1', []);
  if (!rows[0]) {
    throw new ApiError(500, 'SETTINGS_MISSING', 'System settings are missing. Run the database migration.');
  }
  return mapSettings(rows[0]);
}

/** Map<'YYYY-MM-DD', description> for the inclusive range. */
export async function loadHolidays(from, to) {
  const rows = await query(
    'SELECT holiday_date, description FROM holidays WHERE holiday_date BETWEEN ? AND ?',
    [from, to],
  );
  return new Map(rows.map((r) => [r.holiday_date, r.description]));
}
