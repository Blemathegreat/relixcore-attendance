// Applies db/migrations/*.sql in order, once each. Usage: npm run migrate
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');

const conn = await mysql.createConnection({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  multipleStatements: true, // migration files only; the app itself never enables this
    ...(config.db.ssl ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {}),
});

try {
  await conn.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name VARCHAR(190) NOT NULL PRIMARY KEY,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     ) ENGINE=InnoDB`,
  );
  const [done] = await conn.query('SELECT name FROM schema_migrations');
  const applied = new Set(done.map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    console.log(`Applying ${file} ...`);
    await conn.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    count += 1;
  }
  console.log(count ? `Done. ${count} migration(s) applied.` : 'Database is already up to date.');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
