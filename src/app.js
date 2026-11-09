import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db.js';
import { ApiError, asyncHandler } from './lib/errors.js';
import { attachUser, requireAuth, requirePasswordChanged, requireRole } from './middleware/auth.js';
import { apiLimiter, noStore, originCheck, requireJson } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import hrRoutes from './routes/hr.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Only force https in production, so plain-http LAN testing still works.
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
    }),
  );
  // Geolocation is the core feature: allow it for this origin only, block other powerful features.
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    next();
  });

  app.use('/api', noStore, apiLimiter, express.json({ limit: '20kb' }), originCheck, requireJson, attachUser);

  app.get('/api/health', asyncHandler(async (req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/me', requireAuth, requirePasswordChanged, meRoutes);
  app.use('/api/hr', requireAuth, requirePasswordChanged, requireRole('hr'), hrRoutes);

  app.use('/api', (req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'That endpoint does not exist.')));

  if (config.serveClient && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '7d' }));
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
    }
    // Log server-side only; never send stack traces or SQL errors to the browser.
    console.error(`[error] ${req.method} ${req.path}:`, err.stack || err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } });
  });

  return app;
}
