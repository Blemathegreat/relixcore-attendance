import { randomInt } from 'node:crypto';

// No look-alike characters (0/O, 1/l/I) so credentials are easy to read out or print.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function generateTempPassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  // Guarantee at least one letter and one digit so it passes our own rules.
  if (!/\d/.test(out)) out = `${out.slice(0, -1)}${randomInt(2, 10)}`;
  if (!/[A-Za-z]/.test(out)) out = `${out.slice(0, -1)}k`;
  return out;
}

/** Returns an error message, or null when the password is acceptable. */
export function checkNewPassword(password, { employeeId } = {}) {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 64) return 'Password must be at most 64 characters.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must contain at least one letter and one number.';
  }
  if (employeeId && password.toLowerCase().includes(String(employeeId).toLowerCase())) {
    return 'Password must not contain your employee ID.';
  }
  return null;
}
