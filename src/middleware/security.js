import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { ApiError } from '../lib/errors.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reject cross-site browser requests that change state (defence in depth on top of SameSite=Strict). */
export function originCheck(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser clients (curl, tests) send no Origin
  try {
    const host = new URL(origin).host;
    if (host === req.headers.host || config.allowedOrigins.includes(origin)) return next();
  } catch {
    /* fall through */
  }
  return next(new ApiError(403, 'BAD_ORIGIN', 'This request came from an unexpected origin.'));
}

/** State-changing requests must be JSON, which also blocks plain HTML-form CSRF posts. */
export function requireJson(req, res, next) {
  if (!UNSAFE.has(req.method)) return next();
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !req.is('application/json')) {
    return next(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be sent as JSON.'));
  }
  return next();
}

export function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

const handler = (req, res) =>
  res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
  });

const base = { standardHeaders: 'draft-7', legacyHeaders: false, handler };
const byUser = (req) => `u:${req.user ? req.user.id : 'anon'}`;

export const apiLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 600 });
export const loginLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true });
export const attendanceLimiter = rateLimit({ ...base, windowMs: 60 * 1000, limit: 20, keyGenerator: byUser });
export const sensitiveLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 120, keyGenerator: byUser });
export const passwordLimiter = rateLimit({ ...base, windowMs: 15 * 60 * 1000, limit: 10, keyGenerator: byUser });
