// Time helpers. Rule of the house: instants are stored in UTC; calendar dates
// ("work dates") are always calculated in the company timezone.
const pad = (n, w = 2) => String(n).padStart(w, '0');
const formatters = new Map();

function dtf(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  return formatters.get(tz);
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

export function localParts(date, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of `tz` from UTC at the given instant, in milliseconds. */
export function tzOffsetMs(date, tz) {
  const p = localParts(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSecondInstant = date.getTime() - date.getUTCMilliseconds();
  return asIfUtc - wholeSecondInstant;
}

export function localDateString(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTimeString(date, tz, withSeconds = false) {
  const p = localParts(date, tz);
  const base = `${pad(p.hour)}:${pad(p.minute)}`;
  return withSeconds ? `${base}:${pad(p.second)}` : base;
}

/** Convert a wall-clock date + time in `tz` to the matching UTC instant. */
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss = '0'] = timeStr.split(':');
  const guess = Date.UTC(y, m - 1, d, Number(hh), Number(mm), Number(ss));
  const first = guess - tzOffsetMs(new Date(guess), tz);
  const second = guess - tzOffsetMs(new Date(first), tz);
  return new Date(second);
}

export function normalizeTime(t) {
  const [hh, mm, ss = '00'] = t.split(':');
  return `${pad(Number(hh))}:${pad(Number(mm))}:${pad(Number(ss))}`;
}

export function isRealDate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Day of week of a calendar date (0 = Sunday). Independent of any timezone. */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function daysBetween(fromStr, toStr) {
  const [y1, m1, d1] = fromStr.split('-').map(Number);
  const [y2, m2, d2] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function eachDate(fromStr, toStr) {
  const out = [];
  for (let d = fromStr; d <= toStr; d = addDays(d, 1)) out.push(d);
  return out;
}

export function monthBounds(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

/** MySQL DATETIME(3) strings (UTC) <-> Date. */
export function formatMysqlUtc(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export function parseMysqlUtc(str) {
  if (!str) return null;
  if (str instanceof Date) return str;
  return new Date(`${str.replace(' ', 'T')}Z`);
}
