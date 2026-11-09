import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../../src/lib/csv.js';
import { generateTempPassword, checkNewPassword } from '../../src/lib/passwordRules.js';
import { reqString, reqDate, reqTime, reqMonth, reqNumber, reqInt, optString } from '../../src/lib/validate.js';
import { ApiError } from '../../src/lib/errors.js';

test('csv escapes quotes/commas and neutralises spreadsheet formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell(null), '');
  const out = toCsv([{ label: 'Name', value: (r) => r.n }], [{ n: '@evil' }]);
  assert.ok(out.includes("'@evil"));
});

test('temporary passwords are random, readable and satisfy the password rules', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const p = generateTempPassword();
    assert.equal(p.length, 12);
    assert.equal(checkNewPassword(p), null);
    assert.ok(!/[0OIl1]/.test(p), `ambiguous char in ${p}`);
    seen.add(p);
  }
  assert.equal(seen.size, 200);
});

test('password rules', () => {
  assert.match(checkNewPassword('short1'), /8 characters/);
  assert.match(checkNewPassword('onlyletters'), /letter and one number/);
  assert.match(checkNewPassword('12345678'), /letter and one number/);
  assert.match(checkNewPassword('x'.repeat(65) + '1'), /at most 64/);
  assert.match(checkNewPassword('cv-001-abc1', { employeeId: 'CV-001' }), /employee ID/);
  assert.equal(checkNewPassword('Better-pass9', { employeeId: 'CV-001' }), null);
});

test('validators accept good input and throw 400 ApiErrors on bad input', () => {
  assert.equal(reqString('  Ada  ', 'name'), 'Ada');
  assert.equal(reqDate('2026-10-29', 'date'), '2026-10-29');
  assert.equal(reqTime('08:00', 'time'), '08:00:00');
  assert.equal(reqMonth('2026-10'), '2026-10');
  assert.equal(optString('  ', 'x'), null);
  assert.equal(reqInt(5, 'n', { min: 1, max: 10 }), 5);
  const bad = [
    () => reqString(undefined, 'name'),
    () => reqString('x'.repeat(300), 'name'),
    () => reqDate('2026-02-30', 'date'),
    () => reqTime('25:00', 'time'),
    () => reqMonth('2026-13'),
    () => reqNumber('5', 'n'),
    () => reqInt(1.5, 'n'),
    () => reqInt(50, 'n', { max: 10 }),
  ];
  for (const fn of bad) {
    assert.throws(fn, (e) => e instanceof ApiError && e.status === 400 && e.code === 'VALIDATION_ERROR');
  }
});
