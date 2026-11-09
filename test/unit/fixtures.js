export const settings = {
  companyName: 'Coreview',
  officeLatitude: 6.5244,
  officeLongitude: 3.3792,
  geofenceRadiusM: 50,
  maxAccuracyM: 50,
  resumeTime: '08:00:00',
  closeTime: '17:00:00',
  graceMinutes: 10,
  workingDays: [1, 2, 3, 4, 5],
  timezone: 'Africa/Lagos',
};

// Lagos is UTC+1 all year, so 08:00 Lagos = 07:00Z.
export const lagos = (date, time) => new Date(`${date}T${time}+01:00`);
