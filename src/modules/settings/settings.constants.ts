export const SETTINGS_VERSION_KEY = 'settings_version';
export const SETTINGS_CACHE_KEY = 'settings:snapshot';
export const SETTINGS_VERSION_HEADER = 'X-Settings-Version';

export const ALERT_THRESHOLD_KEYS = {
    slaAlertMinOnTimePct:       'sla_alert_min_on_time_pct',
    gpsStaleAlertMinutes:       'gps_stale_alert_minutes',
    driverIncidentAlertPerDay:  'driver_incident_alert_per_day',
} as const;

/** Allowed ranges of the alert thresholds; the DTO and the per-key validator share them. */
export const ALERT_THRESHOLD_LIMITS = {
    slaAlertMinOnTimePct:      { min: 0, max: 100 },
    gpsStaleAlertMinutes:      { min: 1, max: 1440 },
    driverIncidentAlertPerDay: { min: 1, max: 100 },
} as const;
