import crypto from 'node:crypto';
import { query } from '../db.js';
import { config } from '../config.js';
import { formatMysqlUtc } from '../lib/time.js';

export const COOKIE_NAME = 'cv_session';
export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3600 * 1000,
  };
}

export async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const idleExpiry = new Date(now + config.sessionIdleMinutes * 60000);
  const absoluteExpiry = new Date(now + config.sessionAbsoluteHours * 3600000);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, absolute_expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      hashToken(token),
      formatMysqlUtc(idleExpiry < absoluteExpiry ? idleExpiry : absoluteExpiry),
      formatMysqlUtc(absoluteExpiry),
      (req.ip || '').slice(0, 45) || null,
      String(req.headers['user-agent'] || '').slice(0, 255) || null,
    ],
  );
  return token;
}

export async function destroySession(sessionId) {
  await query('DELETE FROM sessions WHERE id = ?', [sessionId]);
}

export async function destroyUserSessions(userId, exceptSessionId = null) {
  if (exceptSessionId) {
    await query('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [userId, exceptSessionId]);
  } else {
    await query('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

export async function purgeExpiredSessions() {
  await query(
    'DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP(3) OR absolute_expires_at < UTC_TIMESTAMP(3)',
  );
}
