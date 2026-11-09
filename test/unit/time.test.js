import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtc, localDateString, localTimeString, weekdayOf, addDays, monthBounds,
  eachDate, isRealDate, formatMysqlUtc, parseMysqlUtc, isValidTimezone, daysBetween,
} from '../../src/lib/time.js';

const TZ = 'Africa/Lagos';

test('Lagos wall-clock time converts to the right UTC instant', () => {
  assert.equal(zonedToUtc('2026-10-29', '08:00', TZ).toISOString(), '2026-10-29T07:00:00.000Z');
  assert.equal(zonedToUtc('2026-10-29', '00:30:15', TZ).toISOString(), '2026-10-28T23:30:15.000Z');
});

test('the work date is the Lagos calendar date, not the UTC date', () => {
  assert.equal(localDateString(new Date('2026-10-28T23:30:00Z'), TZ), '2026-10-29');
  assert.equal(localDateString(new Date('2026-10-29T22:59:59Z'), TZ), '2026-10-29');
  assert.equal(localDateString(new Date('2026-10-29T23:00:00Z'), TZ), '2026-10-30');
  assert.equal(localTimeString(new Date('2026-10-29T07:05:09Z'), TZ), '08:05');
  assert.equal(localTimeString(new Date('2026-10-29T07:05:09Z'), TZ, true), '08:05:09');
});

test('zonedToUtc also works for zones with daylight saving time', () => {
  assert.equal(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-01-15', '09:00', 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
});

test('calendar helpers', () => {
  assert.equal(weekdayOf('2026-10-29'), 4); // Thursday
  assert.equal(weekdayOf('2026-11-01'), 0); // Sunday
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthBounds('2026-10'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(eachDate('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(daysBetween('2026-10-01', '2026-10-31'), 30);
});

test('date and timezone validation', () => {
  assert.equal(isRealDate('2026-02-29'), false);
  assert.equal(isRealDate('2028-02-29'), true);
  assert.equal(isRealDate('2026-13-01'), false);
  assert.equal(isRealDate('29/10/2026'), false);
  assert.equal(isValidTimezone('Africa/Lagos'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
});

test('MySQL UTC string round trip keeps milliseconds and never shifts the instant', () => {
  const d = new Date('2026-10-29T07:05:09.123Z');
  const s = formatMysqlUtc(d);
  assert.equal(s, '2026-10-29 07:05:09.123');
  assert.equal(parseMysqlUtc(s).toISOString(), d.toISOString());
  assert.equal(parseMysqlUtc(null), null);
});
