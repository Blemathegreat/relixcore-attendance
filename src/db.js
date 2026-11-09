import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  // Keep every timestamp as a plain UTC string; the app does all conversion.
  timezone: 'Z',
  dateStrings: true,
  charset: 'utf8mb4',
  ...(config.db.ssl ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } } : {})

});

// Every connection works in UTC so CURRENT_TIMESTAMP / UTC_TIMESTAMP never surprise us.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

/** Parameterized query (server-side prepared statement). */
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** Run `fn(conn)` in a transaction; rolls back on any error. */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* connection already gone */
    }
    throw err;
  } finally {
    conn.release();
  }
}

export const isDuplicateKey = (err) => err && err.code === 'ER_DUP_ENTRY';
