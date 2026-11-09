import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLocation } from '../../src/lib/geofence.js';
import { settings } from './fixtures.js';

const metresNorth = (m) => 6.5244 + m / 111195;
const at = (m, accuracy = 10) => ({ latitude: metresNorth(m), longitude: 3.3792, accuracy });

test('inside the radius is allowed and reports the distance', () => {
  const r = evaluateLocation(at(20), settings);
  assert.equal(r.ok, true);
  assert.ok(r.distanceM > 19 && r.distanceM < 21);
});

test('outside the radius is rejected with a clear explanation', () => {
  const r = evaluateLocation(at(80), settings);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OUTSIDE_GEOFENCE');
  assert.equal(r.status, 403);
  assert.match(r.message, /80 m/);
  assert.match(r.message, /50 m/);
});

test('the radius comes from settings, not from a hardcoded value', () => {
  assert.equal(evaluateLocation(at(80), { ...settings, geofenceRadiusM: 100 }).ok, true);
  assert.equal(evaluateLocation(at(20), { ...settings, geofenceRadiusM: 10 }).ok, false);
});

test('poor GPS accuracy is rejected, never silently accepted', () => {
  const r = evaluateLocation(at(5, 120), settings);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'POOR_ACCURACY');
  assert.equal(r.status, 422);
});

test('missing or invalid coordinates are rejected', () => {
  for (const bad of [
    { latitude: undefined, longitude: undefined, accuracy: 5 },
    { latitude: NaN, longitude: 3.3, accuracy: 5 },
    { latitude: 0, longitude: 0, accuracy: 5 },
    { latitude: '6.5244', longitude: '3.3792', accuracy: 5 },
  ]) {
    const r = evaluateLocation(bad, settings);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_COORDINATES');
  }
});

test('missing accuracy is rejected', () => {
  const r = evaluateLocation({ latitude: metresNorth(5), longitude: 3.3792 }, settings);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'LOCATION_UNAVAILABLE');
});

test('attendance is blocked until HR has configured the office location', () => {
  const r = evaluateLocation(at(5), { ...settings, officeLatitude: null, officeLongitude: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OFFICE_NOT_CONFIGURED');
});

test('a client claiming to be inside the boundary changes nothing', () => {
  const r = evaluateLocation({ ...at(500), insideGeofence: true, distanceM: 1 }, settings);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OUTSIDE_GEOFENCE');
});
