import { Router } from 'express';
import { asyncHandler } from '../lib/errors.js';
import { reqMonth } from '../lib/validate.js';
import { monthBounds, localDateString } from '../lib/time.js';
import { requireRole } from '../middleware/auth.js';
import { attendanceLimiter } from '../middleware/security.js';
import { getTodayState, signIn, signOut } from '../services/attendanceService.js';
import { buildReport } from '../services/reportService.js';
import { loadSettings } from '../services/settingsService.js';

// Attendance belongs to employees. Identity ALWAYS comes from the session, never the request.
const router = Router();
router.use(requireRole('employee'));

router.get('/attendance/today', asyncHandler(async (req, res) => {
  res.json(await getTodayState(req.user));
}));

router.post('/attendance/sign-in', attendanceLimiter, asyncHandler(async (req, res) => {
  res.json(await signIn(req.user, req.body));
}));

router.post('/attendance/sign-out', attendanceLimiter, asyncHandler(async (req, res) => {
  res.json(await signOut(req.user, req.body));
}));

// Own history only: there is deliberately no userId parameter.
router.get('/attendance', asyncHandler(async (req, res) => {
  const settings = await loadSettings();
  const month = req.query.month
    ? reqMonth(req.query.month)
    : localDateString(new Date(), settings.timezone).slice(0, 7);
  const { from, to } = monthBounds(month);
  const report = await buildReport({ from, to, userId: req.user.id });
  const mine = report.employees[0];
  res.json({
    month,
    meta: report.meta,
    days: mine ? mine.days : [],
    totals: mine ? mine.totals : null,
  });
}));

export default router;
