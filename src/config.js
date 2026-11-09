import 'dotenv/config';

const env = process.env;
const flag = (v, fallback) =>
  v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const isProd = env.NODE_ENV === 'production';

function trustProxy(v) {
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  return Number.isNaN(Number(v)) ? v : Number(v);
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  port: Number(env.PORT) || 4000,
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
     ssl: flag(env.DB_SSL, false),
  },
  trustProxy: trustProxy(env.TRUST_PROXY),
  allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  cookieSecure: flag(env.COOKIE_SECURE, isProd),
  sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES) || 120,
  sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS) || 12,
  bcryptCost: Number(env.BCRYPT_COST) || 12,
  serveClient: flag(env.SERVE_CLIENT, true),
};

if (!config.db.user || !config.db.database) {
  throw new Error('DB_USER and DB_NAME must be set. Copy .env.example to .env and fill it in.');
}
if (isProd && !config.cookieSecure) {
  console.warn('[warn] COOKIE_SECURE is off in production. Serve the app over HTTPS and enable it.');
}
