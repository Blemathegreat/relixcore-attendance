// Creates the first HR account (or resets an existing HR account's password).
//   npm run create-hr
// A random one-time password is printed once. The account MUST change it at first login.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pool, query } from '../src/db.js';
import { hashPassword } from '../src/lib/password.js';
import { generateTempPassword } from '../src/lib/passwordRules.js';
import { loadSettings } from '../src/services/settingsService.js';
import { localDateString } from '../src/lib/time.js';

const rl = readline.createInterface({ input, output });
try {
  const employeeId = (await rl.question('HR employee ID (e.g. HR-001): ')).trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(employeeId)) throw new Error('Use 2-32 letters, numbers, dots, dashes or underscores.');

  const existing = (await query('SELECT id, role FROM users WHERE employee_id = ?', [employeeId]))[0];
  const temp = generateTempPassword(14);
  const hash = await hashPassword(temp);

  if (existing) {
    if (existing.role !== 'hr') throw new Error(`${employeeId} exists but is not an HR account.`);
    const ok = (await rl.question(`${employeeId} already exists. Reset its password? (yes/no): `)).trim().toLowerCase();
    if (ok !== 'yes') throw new Error('Cancelled.');
    await query(
      'UPDATE users SET password_hash = ?, must_change_password = 1, is_active = 1, failed_login_count = 0, locked_until = NULL WHERE id = ?',
      [hash, existing.id],
    );
    await query('DELETE FROM sessions WHERE user_id = ?', [existing.id]);
  } else {
    const fullName = (await rl.question('Full name: ')).trim();
    if (!fullName) throw new Error('Full name is required.');
    const settings = await loadSettings();
    await query(
      `INSERT INTO users (employee_id, full_name, role, password_hash, must_change_password, start_date)
       VALUES (?, ?, 'hr', ?, 1, ?)`,
      [employeeId, fullName, hash, localDateString(new Date(), settings.timezone)],
    );
  }
  console.log('\n----------------------------------------------');
  console.log(`  Employee ID:        ${employeeId}`);
  console.log(`  One-time password:  ${temp}`);
  console.log('----------------------------------------------');
  console.log('Shown once and not stored in readable form. You must change it at first login.\n');
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
