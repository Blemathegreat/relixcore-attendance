import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPunctuality, classifyDay, workingDayInfo } from '../../src/lib/policy.js';
import { settings, lagos } from './fixtures.js';

const D = '2026-10-29'; // Thursday
const holidays = new Map([['2026-10-30', 'Company retreat']]); // Friday

// ---- Scenario 10: lateness respects the configured grace period ----
test('arrival before or at resumption is on time', () => {
  assert.equal(classifyPunctuality(lagos(D, '07:30:00'), D, settings).status, 'on_time');
  assert.equal(classifyPunctuality(lagos(D, '08:00:00'), D, settings).status, 'on_time');
});

test('arrival inside the grace period is on time, including exactly 08:10:00', () => {
  assert.equal(classifyPunctuality(lagos(D, '08:09:59'), D, settings).status, 'on_time');
  const r = classifyPunctuality(lagos(D, '08:10:00'), D, settings);
  assert.equal(r.status, 'on_time');
  assert.equal(r.lateMinutes, 0);
});

test('arrival after the grace period is late', () => {
  const r1 = classifyPunctuality(lagos(D, '08:10:01'), D, settings);
  assert.equal(r1.status, 'late');
  assert.equal(r1.lateMinutes, 10);
  const r2 = classifyPunctuality(lagos(D, '08:25:30'), D, settings);
  assert.equal(r2.status, 'late');
  assert.equal(r2.lateMinutes, 25);
});

test('times and grace are read from settings (nothing hardcoded)', () => {
  const s = { ...settings, resumeTime: '09:30:00', graceMinutes: 0 };
  assert.equal(classifyPunctuality(lagos(D, '09:30:00'), D, s).status, 'on_time');
  assert.equal(classifyPunctuality(lagos(D, '09:30:01'), D, s).status, 'late');
  const s2 = { ...settings, resumeTime: '07:00:00', graceMinutes: 30 };
  assert.equal(classifyPunctuality(lagos(D, '07:30:00'), D, s2).status, 'on_time');
  assert.equal(classifyPunctuality(lagos(D, '07:31:00'), D, s2).status, 'late');
});

// ---- Scenario 11: no absence before the workday ends ----
test('no sign-in at 10:00 on a working day is pending, NOT absent', () => {
  const r = classifyDay({ workDate: D, record: null, now: lagos(D, '10:00:00'), settings, holidays });
  assert.equal(r.dayStatus, 'pending');
});

test('no sign-in at 16:59 is still pending; at 17:00 it becomes a potential absence', () => {
  assert.equal(classifyDay({ workDate: D, record: null, now: lagos(D, '16:59:59'), settings, holidays }).dayStatus, 'pending');
  assert.equal(classifyDay({ workDate: D, record: null, now: lagos(D, '17:00:00'), settings, holidays }).dayStatus, 'absent');
});

test('a past working day with no sign-in is a potential absence', () => {
  const r = classifyDay({ workDate: '2026-10-28', record: null, now: lagos(D, '08:00:00'), settings, holidays });
  assert.equal(r.dayStatus, 'absent');
});

test('closing time is read from settings', () => {
  const s = { ...settings, closeTime: '15:00:00' };
  assert.equal(classifyDay({ workDate: D, record: null, now: lagos(D, '15:30:00'), settings: s, holidays }).dayStatus, 'absent');
});

// ---- Scenario 12: missing sign-out without invented times ----
const open = (signIn) => ({ punctuality: 'on_time', lateMinutes: 0, signInAt: signIn, signOutAt: null });

test('sign-in without sign-out after the workday is flagged and no time is invented', () => {
  const r = classifyDay({ workDate: '2026-10-28', record: open(lagos('2026-10-28', '07:55:00')), now: lagos(D, '09:00:00'), settings, holidays });
  assert.equal(r.dayStatus, 'present');
  assert.equal(r.missingSignOut, true);
  assert.equal(r.workedMinutes, null);
  assert.equal(r.inProgress, false);
});

test('sign-in without sign-out during the workday is in progress, not missing', () => {
  const r = classifyDay({ workDate: D, record: open(lagos(D, '07:55:00')), now: lagos(D, '12:00:00'), settings, holidays });
  assert.equal(r.missingSignOut, false);
  assert.equal(r.inProgress, true);
});

test('same-day open record becomes a missing sign-out once closing time passes', () => {
  const r = classifyDay({ workDate: D, record: open(lagos(D, '07:55:00')), now: lagos(D, '17:00:00'), settings, holidays });
  assert.equal(r.missingSignOut, true);
});

test('completed day reports worked minutes and punctuality snapshot', () => {
  const rec = { punctuality: 'late', lateMinutes: 25, signInAt: lagos(D, '08:25:00'), signOutAt: lagos(D, '17:05:00') };
  const r = classifyDay({ workDate: D, record: rec, now: lagos(D, '18:00:00'), settings, holidays });
  assert.equal(r.dayStatus, 'present');
  assert.equal(r.punctuality, 'late');
  assert.equal(r.lateMinutes, 25);
  assert.equal(r.workedMinutes, 520);
  assert.equal(r.missingSignOut, false);
});

// ---- Scenario 13: non-working days ----
test('weekends are not ordinary working days and never count as absences', () => {
  const sat = classifyDay({ workDate: '2026-10-24', record: null, now: lagos(D, '18:00:00'), settings, holidays });
  const sun = classifyDay({ workDate: '2026-10-25', record: null, now: lagos(D, '18:00:00'), settings, holidays });
  assert.equal(sat.dayStatus, 'non_working');
  assert.equal(sat.nonWorkingReason, 'weekend');
  assert.equal(sun.dayStatus, 'non_working');
});

test('configured holidays are excluded from absence calculations', () => {
  const r = classifyDay({ workDate: '2026-10-30', record: null, now: lagos('2026-11-02', '12:00:00'), settings, holidays });
  assert.equal(r.dayStatus, 'non_working');
  assert.equal(r.nonWorkingReason, 'holiday');
  assert.equal(r.holidayName, 'Company retreat');
});

test('working days are configurable (e.g. Saturday working)', () => {
  const s = { ...settings, workingDays: [1, 2, 3, 4, 5, 6] };
  assert.equal(classifyDay({ workDate: '2026-10-24', record: null, now: lagos(D, '18:00:00'), settings: s, holidays }).dayStatus, 'absent');
  assert.equal(workingDayInfo('2026-10-25', s, holidays).working, false);
});

test('future days, days before the start date and days after deactivation are not counted', () => {
  assert.equal(classifyDay({ workDate: '2026-10-31', record: null, now: lagos(D, '12:00:00'), settings, holidays }).dayStatus, 'future');
  assert.equal(classifyDay({ workDate: '2026-10-20', record: null, now: lagos(D, '12:00:00'), settings, holidays, startDate: '2026-10-27' }).dayStatus, 'not_employed');
  assert.equal(classifyDay({ workDate: '2026-10-28', record: null, now: lagos(D, '12:00:00'), settings, holidays, endDate: '2026-10-26' }).dayStatus, 'not_employed');
});

test('the Lagos day boundary is respected (23:30Z on the 28th is already the 29th)', () => {
  const now = new Date('2026-10-28T23:30:00Z'); // 00:30 on the 29th in Lagos
  const r = classifyDay({ workDate: D, record: null, now, settings, holidays });
  assert.equal(r.dayStatus, 'pending');
});

test('a recorded event outside the employment window is still shown, never hidden', () => {
  const rec = { punctuality: 'on_time', lateMinutes: 0, signInAt: lagos('2026-10-28', '08:00:00'), signOutAt: lagos('2026-10-28', '17:00:00') };
  const r = classifyDay({ workDate: '2026-10-28', record: rec, now: lagos(D, '12:00:00'), settings, holidays, endDate: '2026-10-26' });
  assert.equal(r.dayStatus, 'present');
});
