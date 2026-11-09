import { localDateString, weekdayOf, zonedToUtc } from './time.js';

/**
 * Punctuality at sign-in.
 *  - arrival at or before (resumption + grace)  -> on time
 *  - arrival after (resumption + grace)         -> late
 * lateMinutes = whole minutes after the official resumption time.
 */
export function classifyPunctuality(signInAt, workDate, settings) {
  const resumption = zonedToUtc(workDate, settings.resumeTime, settings.timezone);
  const deadline = resumption.getTime() + settings.graceMinutes * 60000;
  if (signInAt.getTime() <= deadline) return { status: 'on_time', lateMinutes: 0 };
  const lateMinutes = Math.floor((signInAt.getTime() - resumption.getTime()) / 60000);
  return { status: 'late', lateMinutes };
}

/** holidays: Map<'YYYY-MM-DD', description> */
export function workingDayInfo(dateStr, settings, holidays) {
  if (holidays && holidays.has(dateStr)) {
    return { working: false, reason: 'holiday', holidayName: holidays.get(dateStr) };
  }
  if (!settings.workingDays.includes(weekdayOf(dateStr))) {
    return { working: false, reason: 'weekend', holidayName: null };
  }
  return { working: true, reason: null, holidayName: null };
}

export function hasWorkdayEnded(dateStr, now, settings) {
  const today = localDateString(now, settings.timezone);
  if (dateStr < today) return true;
  if (dateStr > today) return false;
  return now.getTime() >= zonedToUtc(dateStr, settings.closeTime, settings.timezone).getTime();
}

/**
 * Calculated status for one employee on one date. `record` is the stored
 * attendance row (already mapped: signInAt/signOutAt as Dates) or null.
 * Nothing here ever invents a timestamp.
 *
 * dayStatus: present | absent | pending | non_working | future | not_employed
 *  - absent  = "potential absence": working day, workday has ended, no sign-in
 *  - pending = working day still in progress, no sign-in yet (NOT absent)
 */
export function classifyDay({ workDate, record, now, settings, holidays, startDate, endDate }) {
  const result = {
    workDate,
    dayStatus: 'pending',
    nonWorkingReason: null,
    holidayName: null,
    recorded: Boolean(record),
    punctuality: null,
    lateMinutes: 0,
    missingSignOut: false,
    inProgress: false,
    workedMinutes: null,
  };
  const today = localDateString(now, settings.timezone);

  // Outside the employment window nothing is expected of the employee, but a
  // recorded event is never hidden.
  if (!record && ((startDate && workDate < startDate) || (endDate && workDate > endDate))) {
    return { ...result, dayStatus: 'not_employed' };
  }
  if (workDate > today) return { ...result, dayStatus: 'future' };

  const info = workingDayInfo(workDate, settings, holidays);
  const ended = hasWorkdayEnded(workDate, now, settings);

  if (record) {
    result.punctuality = record.punctuality;
    result.lateMinutes = record.lateMinutes;
    if (record.signOutAt) {
      result.workedMinutes = Math.floor(
        (record.signOutAt.getTime() - record.signInAt.getTime()) / 60000,
      );
    } else if (ended) {
      result.missingSignOut = true;
    } else {
      result.inProgress = true;
    }
  }

  if (!info.working) {
    return { ...result, dayStatus: 'non_working', nonWorkingReason: info.reason, holidayName: info.holidayName };
  }
  if (record) return { ...result, dayStatus: 'present' };
  return { ...result, dayStatus: ended ? 'absent' : 'pending' };
}
