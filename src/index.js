import { config } from './config.js';
import { pool } from './db.js';
import { createApp } from './app.js';
import { purgeExpiredSessions } from './services/sessionService.js';

async function main() {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('Cannot connect to MySQL. Check the DB_* values in .env:', err.message);
    process.exit(1);
  }
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Coreview Attendance API listening on port ${config.port} (${config.env})`);
  });

  const timer = setInterval(() => purgeExpiredSessions().catch(() => {}), 60 * 60 * 1000);
  timer.unref();

  const shutdown = () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
