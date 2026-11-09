import { haversineMeters, isValidCoordinate } from './geo.js';

/**
 * Authoritative server-side location check.
 * `reading`  = what the browser reported ({ latitude, longitude, accuracy }).
 * `settings` = trusted office settings loaded from the database.
 * Never trusts any "inside the boundary" claim from the client.
 */
export function evaluateLocation(reading, settings) {
  const { latitude, longitude, accuracy } = reading;

  if (!isValidCoordinate(latitude, longitude)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_COORDINATES',
      message: 'The location sent with this request is not valid. Turn on location and try again.',
    };
  }
  if (settings.officeLatitude == null || settings.officeLongitude == null) {
    return {
      ok: false,
      status: 409,
      code: 'OFFICE_NOT_CONFIGURED',
      message: 'The office location has not been set up yet. Please contact HR.',
    };
  }
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0) {
    return {
      ok: false,
      status: 400,
      code: 'LOCATION_UNAVAILABLE',
      message: 'Your phone did not report how accurate its location is. Turn on precise location and try again.',
    };
  }
  if (accuracy > settings.maxAccuracyM) {
    return {
      ok: false,
      status: 422,
      code: 'POOR_ACCURACY',
      message: `Your GPS signal is too weak (accurate to about ${Math.round(accuracy)} m; ${settings.maxAccuracyM} m is needed). Move near a window or outdoors, wait a few seconds, and try again.`,
      accuracyM: accuracy,
    };
  }

  const distanceM = haversineMeters(
    latitude,
    longitude,
    settings.officeLatitude,
    settings.officeLongitude,
  );
  if (distanceM > settings.geofenceRadiusM) {
    return {
      ok: false,
      status: 403,
      code: 'OUTSIDE_GEOFENCE',
      message: `You are about ${Math.round(distanceM)} m from the office. You must be within ${settings.geofenceRadiusM} m to mark attendance.`,
      distanceM,
      radiusM: settings.geofenceRadiusM,
    };
  }
  return { ok: true, distanceM, accuracyM: accuracy };
}
