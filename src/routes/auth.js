import { Router } from 'express';
import { query } from '../db.js';
import { ApiError, asyncHandler } from '../lib/errors.js';
import { requireBody, reqString } from '../lib/validate.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { checkNewPassword } from '../lib/passwordRules.js';
import { parseMysqlUtc } from '../lib/time.js';
import { requireAuth } from '../middleware/auth.js';
import { loginLimiter, passwordLimiter } from '../middleware/security.js';
import {
  COOKIE_NAME, cookieOptions, createSession, destroySession, destroyUserSessions, purgeExpiredSessions,
} from '../services/sessionService.js';
import { loadSettings } from '../services/settingsService.js';

const router = Router();
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Compared against when the employee ID is unknown, so response time doesn't reveal valid IDs.
const dummyHash = hashPassword('not-a-real-password-for-timing-only');

const profile = (u) => ({
  id: u.id,
  employeeId: u.employee_id ?? u.employeeId,
  fullName: u.full_name ?? u.fullName,
  role: u.role,
  mustChangePassword: Boolean(u.must_change_password ?? u.mustChangePassword),
});

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = requireBody(req.body);
    const employeeId = reqString(body.employeeId, 'employeeId', { max: 32 }).toUpperCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const invalid = new ApiError(401, 'INVALID_CREDENTIALS', 'Employee ID or password is incorrect.');
    if (!password || password.length > 200) throw invalid;

    const rows = await query('SELECT * FROM users WHERE employee_id = ?', [employeeId]);
    const user = rows[0];

    if (user?.locked_until && parseMysqlUtc(user.locked_until).getTime() > Date.now()) {
      const mins = Math.ceil((parseMysqlUtc(user.locked_until).getTime() - Date.now()) / 60000);
      throw new ApiError(429, 'ACCOUNT_LOCKED', `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }

    const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash);
    if (!user || !ok) {
      if (user) {
        await query('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ?', [user.id]);
        const [{ failed_login_count: failed }] = await query('SELECT failed_login_count FROM users WHERE id = ?', [user.id]);
        if (failed >= MAX_FAILED) {
          await query(
            'UPDATE users SET failed_login_count = 0, locked_until = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? MINUTE) WHERE id = ?',
            [LOCK_MINUTES, user.id],
          );
        }
      }
      throw invalid;
    }
    if (!user.is_active) {
      throw new ApiError(403, 'ACCOUNT_DISABLED', 'This account is deactivated. Please contact HR.');
    }

    await query(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP(3) WHERE id = ?',
      [user.id],
    );
    purgeExpiredSessions().catch(() => {});
    const token = await createSession(user.id, req); // always a fresh token (no session fixation)
    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ user: profile(user) });
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (req.sessionId) await destroySession(req.sessionId);
    res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  }),
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const settings = await loadSettings();
    res.json({ user: profile(req.user), company: { name: settings.companyName, timezone: settings.timezone } });
  }),
);

router.post(
  '/change-password',
  requireAuth,
  passwordLimiter,
  asyncHandler(async (req, res) => {
    const body = requireBody(req.body);
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';

    const [user] = await query('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!(await verifyPassword(current, user.password_hash))) {
      throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.');
    }
    const problem = checkNewPassword(next, { employeeId: user.employee_id });
    if (problem) throw new ApiError(400, 'WEAK_PASSWORD', problem);
    if (next === current) {
      throw new ApiError(400, 'WEAK_PASSWORD', 'Your new password must be different from the current one.');
    }

    await query(
      `UPDATE users
          SET password_hash = ?, must_change_password = 0, password_changed_at = UTC_TIMESTAMP(3)
        WHERE id = ?`,
      [await hashPassword(next), user.id],
    );
    await destroyUserSessions(user.id, req.sessionId); // sign out every other device
    res.json({ user: { ...profile(user), mustChangePassword: false } });
  }),
);

export default router;
