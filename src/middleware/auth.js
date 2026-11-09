import { query } from '../db.js';
import { config } from '../config.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { formatMysqlUtc, parseMysqlUtc } from '../lib/time.js';
import { COOKIE_NAME, hashToken } from '../services/sessionService.js';

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Loads req.user from the session cookie (if valid). Never throws for anonymous requests. */
export const attachUser = asyncHandler(async (req, res, next) => {
  const token = readCookie(req, COOKIE_NAME);
  if (!token || token.length > 200) return next();

  const rows = await query(
    `SELECT s.id AS session_id, s.last_seen_at, s.absolute_expires_at,
            u.id, u.employee_id, u.full_name, u.role, u.is_active, u.must_change_password
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > UTC_TIMESTAMP(3)
        AND s.absolute_expires_at > UTC_TIMESTAMP(3)`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r || !r.is_active) return next();

  req.user = {
    id: r.id,
    employeeId: r.employee_id,
    fullName: r.full_name,
    role: r.role,
    mustChangePassword: Boolean(r.must_change_password),
  };
  req.sessionId = r.session_id;

  // Slide the idle expiry (at most once a minute) but never past the absolute limit.
  if (Date.now() - parseMysqlUtc(r.last_seen_at).getTime() > 60000) {
    const absolute = parseMysqlUtc(r.absolute_expires_at).getTime();
    const next_ = Math.min(Date.now() + config.sessionIdleMinutes * 60000, absolute);
    await query('UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(3), expires_at = ? WHERE id = ?', [
      formatMysqlUtc(new Date(next_)),
      r.session_id,
    ]);
  }
  return next();
});

export function requireAuth(req, res, next) {
  if (!req.user) return next(new ApiError(401, 'AUTH_REQUIRED', 'Please log in to continue.'));
  return next();
}

/** Blocks everything except the change-password flow until the initial password is changed. */
export function requirePasswordChanged(req, res, next) {
  if (req.user.mustChangePassword) {
    return next(new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your initial password before continuing.'));
  }
  return next();
}

export const requireRole = (role) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'AUTH_REQUIRED', 'Please log in to continue.'));
  if (req.user.role !== role) {
    return next(new ApiError(403, 'FORBIDDEN', 'You do not have permission to do that.'));
  }
  return next();
};
