import { query, withTransaction, isDuplicateKey } from '../db.js';
import { ApiError } from '../lib/errors.js';
import { evaluateLocation } from '../lib/geofence.js';
import { classifyPunctuality, classifyDay, workingDayInfo } from '../lib/policy.js';
import { formatMysqlUtc, localDateString, localTimeString } from '../lib/time.js';
import { loadSettings, loadHolidays } from './settingsService.js';
import { mapAttendance, presentRecord } from './attendanceMapper.js';

const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const MAX_POSITION_AGE_MS = 120000;

/** Validate the shape of a sign-in/out request. Never trusts identity, time or "inside" flags. */
export function parseAttendancePayload(body, now) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A JSON request body is required.');
  }
  const { latitude, longitude, accuracy, requestId, positionTimestamp } = body;
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'requestId: a unique request ID (8-64 letters, digits or dashes) is required.');
  }
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new ApiError(400, 'LOCATION_UNAVAILABLE', 'Your location was not sent. Allow location access and try again.');
  }
  if (positionTimestamp !== undefined && positionTimestamp !== null) {
    if (typeof positionTimestamp !== 'number' || !Number.isFinite(positionTimestamp)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'positionTimestamp: must be a number.');
    }
    const age = now.getTime() - positionTimestamp;
    if (age > MAX_POSITION_AGE_MS || age < -MAX_POSITION_AGE_MS) {
      throw new ApiError(422, 'STALE_LOCATION', 'That location reading is out of date. Please try again to get a fresh reading.');
    }
  }
  return { latitude, longitude, accuracy, requestId };
}

async function lockActiveUser(conn, userId) {
  const [rows] = await conn.execute('SELECT id, is_active FROM users WHERE id = ? FOR UPDATE', [userId]);
  if (!rows[0] || !rows[0].is_active) {
    throw new ApiError(403, 'ACCOUNT_DISABLED', 'Your account is deactivated. Please contact HR.');
  }
}

function geofenceOrThrow(reading, settings) {
  const loc = evaluateLocation(reading, settings);
  if (!loc.ok) {
    throw new ApiError(loc.status, loc.code, loc.message, {
      distanceM: loc.distanceM === undefined ? undefined : Math.round(loc.distanceM),
      radiusM: loc.radiusM,
      accuracyM: loc.accuracyM === undefined ? undefined : Math.round(loc.accuracyM),
    });
  }
  return loc;
}

export async function signIn(user, body, now = new Date()) {
  const p = parseAttendancePayload(body, now);
  const settings = await loadSettings();
  const tz = settings.timezone;
  const workDate = localDateString(now, tz);

  const holidays = await loadHolidays(workDate, workDate);
  const day = workingDayInfo(workDate, settings, holidays);
  if (!day.working) {
    throw new ApiError(
      409,
      'NOT_A_WORKING_DAY',
      day.reason === 'holiday'
        ? `Today is a non-working day (${day.holidayName}). Attendance is not recorded today.`
        : 'Today is not a working day. Attendance is not recorded today.',
    );
  }

  // 1) Location is validated first, with trusted server-side settings. Nothing is written on failure.
  const loc = geofenceOrThrow(p, settings);

  // 2) State check + insert, serialised per employee.
  return withTransaction(async (conn) => {
    await lockActiveUser(conn, user.id);

    const [existingRows] = await conn.execute(
      'SELECT * FROM attendance WHERE user_id = ? AND work_date = ? FOR UPDATE',
      [user.id, workDate],
    );
    const existing = existingRows[0] ? mapAttendance(existingRows[0]) : null;
    if (existing) {
      if (existing.signInRequestId === p.requestId) {
        return { replayed: true, message: `You are already signed in (${localTimeString(existing.signInAt, tz)}).`, record: presentRecord(existing, tz), distanceM: Math.round(loc.distanceM) };
      }
      const inT = localTimeString(existing.signInAt, tz);
      throw new ApiError(
        409,
        'DUPLICATE_SIGN_IN',
        existing.signOutAt
          ? `You have already completed today's attendance (in at ${inT}, out at ${localTimeString(existing.signOutAt, tz)}).`
          : `You already signed in today at ${inT}. Use Sign Out when you leave.`,
      );
    }

    // A previous day's open session (forgotten sign-out) must not block today.
    // It is flagged stale and stays visible as a missing sign-out. No time is invented.
    await conn.execute(
      'UPDATE attendance SET is_stale = 1 WHERE user_id = ? AND sign_out_at IS NULL AND is_stale = 0 AND work_date < ?',
      [user.id, workDate],
    );

    const { status, lateMinutes } = classifyPunctuality(now, workDate, settings);
    let insertId;
    try {
      const [res] = await conn.execute(
        `INSERT INTO attendance
           (user_id, work_date, sign_in_at, punctuality, late_minutes,
            sign_in_lat, sign_in_lng, sign_in_distance_m, sign_in_accuracy_m,
            sign_in_request_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'self')`,
        [
          user.id, workDate, formatMysqlUtc(now), status, lateMinutes,
          p.latitude, p.longitude, Number(loc.distanceM.toFixed(2)), Number(p.accuracy.toFixed(2)),
          p.requestId,
        ],
      );
      insertId = res.insertId;
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ApiError(409, 'DUPLICATE_SIGN_IN', 'You are already signed in for today.');
      }
      throw err;
    }

    const [rows] = await conn.execute('SELECT * FROM attendance WHERE id = ?', [insertId]);
    const rec = mapAttendance(rows[0]);
    const t = localTimeString(rec.signInAt, tz);
    return {
      replayed: false,
      message:
        status === 'late'
          ? `Signed in at ${t}. You are marked late (${lateMinutes} min after ${settings.resumeTime.slice(0, 5)}).`
          : `Signed in at ${t}. You are on time.`,
      record: presentRecord(rec, tz),
      distanceM: Math.round(loc.distanceM),
    };
  });
}

export async function signOut(user, body, now = new Date()) {
  const p = parseAttendancePayload(body, now);
  const settings = await loadSettings();
  const tz = settings.timezone;
  const workDate = localDateString(now, tz);

  const loc = geofenceOrThrow(p, settings);

  return withTransaction(async (conn) => {
    await lockActiveUser(conn, user.id);

    const [rows] = await conn.execute(
      'SELECT * FROM attendance WHERE user_id = ? AND work_date = ? FOR UPDATE',
      [user.id, workDate],
    );
    const existing = rows[0] ? mapAttendance(rows[0]) : null;

    if (!existing) {
      const [stale] = await conn.execute(
        'SELECT work_date FROM attendance WHERE user_id = ? AND sign_out_at IS NULL AND work_date < ? ORDER BY work_date DESC LIMIT 1',
        [user.id, workDate],
      );
      throw new ApiError(
        409,
        'NO_ACTIVE_SESSION',
        stale[0]
          ? `You have not signed in today. Your sign-in on ${stale[0].work_date} has no sign-out; please ask HR to correct it.`
          : 'You have not signed in today, so there is nothing to sign out of.',
      );
    }
    if (existing.signOutAt) {
      if (existing.signOutRequestId === p.requestId) {
        return { replayed: true, message: `You are already signed out (${localTimeString(existing.signOutAt, tz)}).`, record: presentRecord(existing, tz), distanceM: Math.round(loc.distanceM) };
      }
      throw new ApiError(409, 'DUPLICATE_SIGN_OUT', `You already signed out today at ${localTimeString(existing.signOutAt, tz)}.`);
    }

    const [res] = await conn.execute(
      `UPDATE attendance
          SET sign_out_at = ?, sign_out_lat = ?, sign_out_lng = ?,
              sign_out_distance_m = ?, sign_out_accuracy_m = ?, sign_out_request_id = ?
        WHERE id = ? AND sign_out_at IS NULL`,
      [
        formatMysqlUtc(now), p.latitude, p.longitude,
        Number(loc.distanceM.toFixed(2)), Number(p.accuracy.toFixed(2)), p.requestId,
        existing.id,
      ],
    );
    if (res.affectedRows !== 1) {
      throw new ApiError(409, 'DUPLICATE_SIGN_OUT', 'You have already signed out today.');
    }

    const [after] = await conn.execute('SELECT * FROM attendance WHERE id = ?', [existing.id]);
    const rec = mapAttendance(after[0]);
    return {
      replayed: false,
      message: `Signed out at ${localTimeString(rec.signOutAt, tz)}. Have a good evening.`,
      record: presentRecord(rec, tz),
      distanceM: Math.round(loc.distanceM),
    };
  });
}

/** Current state for the employee dashboard. */
export async function getTodayState(user, now = new Date()) {
  const settings = await loadSettings();
  const tz = settings.timezone;
  const workDate = localDateString(now, tz);
  const holidays = await loadHolidays(workDate, workDate);
  const info = workingDayInfo(workDate, settings, holidays);
  const rows = await query('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?', [user.id, workDate]);
  const rec = rows[0] ? mapAttendance(rows[0]) : null;

  const staleRows = await query(
    'SELECT work_date FROM attendance WHERE user_id = ? AND sign_out_at IS NULL AND work_date < ? ORDER BY work_date DESC LIMIT 1',
    [user.id, workDate],
  );

  let state = 'not_signed_in';
  if (rec && !rec.signOutAt) state = 'signed_in';
  if (rec && rec.signOutAt) state = 'completed';

  const day = classifyDay({ workDate, record: rec, now, settings, holidays });
  return {
    workDate,
    timezone: tz,
    serverTime: now.toISOString(),
    isWorkingDay: info.working,
    nonWorkingReason: info.reason,
    holidayName: info.holidayName,
    state,
    canSignIn: info.working && state === 'not_signed_in',
    canSignOut: state === 'signed_in',
    record: presentRecord(rec, tz),
    today: { dayStatus: day.dayStatus, punctuality: day.punctuality, lateMinutes: day.lateMinutes },
    previousOpenSession: staleRows[0] ? staleRows[0].work_date : null,
    policy: {
      resumeTime: settings.resumeTime.slice(0, 5),
      closeTime: settings.closeTime.slice(0, 5),
      graceMinutes: settings.graceMinutes,
      geofenceRadiusM: settings.geofenceRadiusM,
      maxAccuracyM: settings.maxAccuracyM,
      officeConfigured: settings.officeLatitude != null && settings.officeLongitude != null,
    },
  };
}
