import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters, isValidCoordinate } from '../../src/lib/geo.js';

test('haversine: identical points are 0 m apart', () => {
  assert.equal(haversineMeters(6.5244, 3.3792, 6.5244, 3.3792), 0);
});

test('haversine: one degree of longitude on the equator is about 111.195 km', () => {
  const d = haversineMeters(0, 0, 0, 1);
  assert.ok(Math.abs(d - 111195) < 5, `got ${d}`);
});

test('haversine: is symmetric', () => {
  const a = haversineMeters(6.5244, 3.3792, 9.0765, 7.3986);
  const b = haversineMeters(9.0765, 7.3986, 6.5244, 3.3792);
  assert.ok(Math.abs(a - b) < 1e-6);
});

test('haversine: Lagos to Abuja is roughly 520 km', () => {
  const d = haversineMeters(6.5244, 3.3792, 9.0765, 7.3986) / 1000;
  assert.ok(d > 500 && d < 545, `got ${d} km`);
});

test('haversine: a point 50 m due north is measured as about 50 m', () => {
  const dLat = 50 / 111195;
  const d = haversineMeters(6.5244, 3.3792, 6.5244 + dLat, 3.3792);
  assert.ok(Math.abs(d - 50) < 0.5, `got ${d}`);
});

test('isValidCoordinate rejects junk, out-of-range values and (0,0)', () => {
  assert.equal(isValidCoordinate(6.5, 3.3), true);
  assert.equal(isValidCoordinate(NaN, 3.3), false);
  assert.equal(isValidCoordinate('6.5', 3.3), false);
  assert.equal(isValidCoordinate(null, null), false);
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(0, 181), false);
  assert.equal(isValidCoordinate(0, 0), false);
});
