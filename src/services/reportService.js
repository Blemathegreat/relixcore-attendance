import { query } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { classifyDay } from '../lib/policy.js';
import { eachDate, daysBetween, localDateString, localTimeString, weekdayOf } from '../lib/time.js';
import { loadSettings, loadHolidays } from './settingsService.js';
import { mapAttendance } from './attendanceMapper.js';

export const MAX_RANGE_DAYS = 93;

function presentDay(day, rec, tz, attendanceId) {
  return {
    workDate: day.workDate,
    weekday: weekdayOf(day.workDate),
    dayStatus: day.dayStatus,
    nonWorkingReason: day.nonWorkingReason,
    holidayName: day.holidayName,
    recorded: day.recorded,
    attendanceId: attendanceId ?? null,
    signInAt: rec?.signInAt ? rec.signInAt.toISOString() : null,
    signInTime: rec?.signInAt ? localTimeString(rec.signInAt, tz) : null,
    signOutAt: rec?.signOutAt ? rec.signOutAt.toISOString() : null,
    signOutTime: rec?.signOutAt ? localTimeString(rec.signOutAt, tz) : null,
    punctuality: day.punctuality,
    lateMinutes: day.lateMinutes,
    missingSignOut: day.missingSignOut,
    inProgress: day.inProgress,
    workedMinutes: day.workedMinutes,
    source: rec?.source ?? null,
  };
}

function totalsFor(days) {
  const t = {
    workingDays: 0, presentDays: 0, onTimeDays: 0, lateDays: 0,
    absentDays: 0, missingSignOutDays: 0, totalLateMinutes: 0, pendingDays: 0,
  };
  for (const d of days) {
    if (d.dayStatus === 'present') {
      t.workingDays += 1;
      t.presentDays += 1;
      if (d.punctuality === 'late') {
        t.lateDays += 1;
        t.totalLateMinutes += d.lateMinutes;
      } else if (d.punctuality === 'on_time') {
        t.onTimeDays += 1;
      }
      if (d.missingSignOut) t.missingSignOutDays += 1;
    } else if (d.dayStatus === 'absent') {
      t.workingDays += 1;
      t.absentDays += 1;
    } else if (d.dayStatus === 'pending') {
      t.pendingDays += 1;
    }
  }
  return t;
}

/**
 * Per-employee, per-day calculated attendance for an inclusive date range.
 * `userId` limits the report to a single employee.
 */
export async function buildReport({ from, to, userId = null, now = new Date() }) {
  const span = daysBetween(from, to);
  if (span < 0) throw new ApiError(400, 'VALIDATION_ERROR', 'from: must not be after the end date.');
  if (span + 1 > MAX_RANGE_DAYS) {
    throw new ApiError(400, 'RANGE_TOO_LARGE', `Please choose a range of ${MAX_RANGE_DAYS} days or fewer.`);
  }

  const settings = await loadSettings();
  const tz = settings.timezone;
  const holidays = await loadHolidays(from, to);

  const userSql =
    `SELECT id, employee_id, full_name, department, job_title, is_active, start_date, end_date
       FROM users
      WHERE role = 'employee'
        ${userId ? 'AND id = ?' : ''}
        AND (is_active = 1
             OR end_date >= ?
             OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = users.id AND a.work_date BETWEEN ? AND ?))
      ORDER BY employee_id`;
  const userParams = userId ? [userId, from, from, to] : [from, from, to];
  const users = await query(userSql, userParams);
  if (userId && users.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Employee not found.');

  const attRows = users.length
    ? await query(
        `SELECT * FROM attendance WHERE work_date BETWEEN ? AND ? ${userId ? 'AND user_id = ?' : ''}`,
        userId ? [from, to, userId] : [from, to],
      )
    : [];
  const byKey = new Map();
  for (const row of attRows) byKey.set(`${row.user_id}|${row.work_date}`, mapAttendance(row));

  const dates = eachDate(from, to);
  const employees = users.map((u) => {
    const days = dates.map((workDate) => {
      const rec = byKey.get(`${u.id}|${workDate}`) || null;
      const calc = classifyDay({
        workDate, record: rec, now, settings, holidays,
        startDate: u.start_date, endDate: u.end_date,
      });
      return presentDay(calc, rec, tz, rec?.id);
    });
    return {
      userId: u.id,
      employeeId: u.employee_id,
      fullName: u.full_name,
      department: u.department,
      jobTitle: u.job_title,
      isActive: Boolean(u.is_active),
      days,
      totals: totalsFor(days),
    };
  });

  return {
    meta: {
      from, to,
      timezone: tz,
      companyName: settings.companyName,
      generatedAt: now.toISOString(),
      today: localDateString(now, tz),
      policy: {
        resumeTime: settings.resumeTime.slice(0, 5),
        closeTime: settings.closeTime.slice(0, 5),
        graceMinutes: settings.graceMinutes,
      },
    },
    employees,
  };
}
