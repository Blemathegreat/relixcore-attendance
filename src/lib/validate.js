import { ApiError } from './errors.js';
import { isRealDate } from './time.js';

const fail = (field, message) => {
  throw new ApiError(400, 'VALIDATION_ERROR', `${field}: ${message}`, { field });
};

export function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A JSON request body is required.');
  }
  return body;
}

export function reqString(value, field, { min = 1, max = 255 } = {}) {
  if (typeof value !== 'string') fail(field, 'is required.');
  const v = value.trim();
  if (v.length < min) fail(field, min === 1 ? 'is required.' : `must be at least ${min} characters.`);
  if (v.length > max) fail(field, `must be at most ${max} characters.`);
  return v;
}

export function optString(value, field, { max = 255 } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(field, 'must be text.');
  const v = value.trim();
  if (v === '') return null;
  if (v.length > max) fail(field, `must be at most ${max} characters.`);
  return v;
}

export function reqNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(field, 'must be a number.');
  if (value < min || value > max) fail(field, `must be between ${min} and ${max}.`);
  return value;
}

export function reqInt(value, field, opts = {}) {
  const n = reqNumber(value, field, opts);
  if (!Number.isInteger(n)) fail(field, 'must be a whole number.');
  return n;
}

export function reqDate(value, field) {
  if (!isRealDate(value)) fail(field, 'must be a valid date (YYYY-MM-DD).');
  return value;
}

export function reqTime(value, field) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)) {
    fail(field, 'must be a valid time (HH:MM).');
  }
  return value.length === 5 ? `${value}:00` : value;
}

export function reqMonth(value, field = 'month') {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    fail(field, 'must be a month in the form YYYY-MM.');
  }
  return value;
}

export function reqBool(value, field) {
  if (typeof value !== 'boolean') fail(field, 'must be true or false.');
  return value;
}

export function queryInt(value, field, { min = 1, max = 1000000 } = {}) {
  if (!/^\d+$/.test(String(value ?? ''))) fail(field, 'must be a whole number.');
  const n = Number(value);
  if (n < min || n > max) fail(field, `must be between ${min} and ${max}.`);
  return n;
}
