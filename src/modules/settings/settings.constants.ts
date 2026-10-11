export const SETTINGS_VERSION_KEY = 'settings_version';
export const SETTINGS_CACHE_KEY = 'settings:snapshot';
export const SETTINGS_VERSION_HEADER = 'X-Settings-Version';

export const OPERATIONAL_SETTING_SEEDS = [
    { key: 'plan_generation_times', value: '08:30,13:30', description: 'Local times when the automatic delivery plan is generated (America/La_Paz).' },
    { key: 'plan_horizon_days', value: '4', description: 'Number of days included in an automatic delivery plan.' },
    { key: 'plan_working_days', value: '1,2,3,4,5', description: 'Working weekdays included in a delivery plan; 1 is Monday and 7 is Sunday.' },
    { key: 'plan_non_working_dates', value: '', description: 'ISO dates excluded from planning. Empty means no non-working dates have been configured.' },
    { key: 'route_cutoff_time', value: '15:00', description: 'Proposed local cutoff time for route planning; confirm with Operations.' },
    { key: 'final_review_end_time', value: '16:00', description: 'Proposed local end time for final route review; confirm with Operations.' },
    { key: 'route_reminder_time', value: '16:30', description: 'Proposed local time for the route reminder; confirm with Operations.' },
    { key: 'promise_response_window_minutes', value: '720', description: 'Minutes allowed for a customer to respond to a delivery promise.' },
    { key: 'service_min_operating_days', value: '2', description: 'Minimum operating days offered for a delivery service.' },
    { key: 'service_max_operating_days', value: '3', description: 'Maximum operating days offered for a delivery service.' },
    { key: 'slot_duration_minutes', value: '120', description: 'Duration of a delivery time slot in minutes.' },
    { key: 'morning_window_start', value: '09:00', description: 'Start of the morning delivery window.' },
    { key: 'morning_window_end', value: '13:00', description: 'End of the morning delivery window.' },
    { key: 'afternoon_window_start', value: '14:00', description: 'Start of the afternoon delivery window.' },
    { key: 'afternoon_window_end', value: '18:00', description: 'End of the afternoon delivery window.' },
    { key: 'stop_service_minutes', value: '', description: 'Not configured. Operations must measure the average service time before setting a value.' },
    { key: 'planning_margin_pct', value: '', description: 'Not configured. Operations must calibrate the planning margin before setting a value.' },
    { key: 'max_reschedule_attempts', value: '2', description: 'Maximum number of rescheduling attempts for an order.' },
    { key: 'max_delivery_attempts', value: '3', description: 'Maximum delivery attempts for an order.' },
    { key: 'reschedule_window_days', value: '2', description: 'Number of days available to reschedule a delivery.' },
    { key: 'tracking_token_retention_days', value: '30', description: 'Proposed tracking token retention in days; this is not a legal retention policy.' },
    { key: 'incomplete_order_alert_minutes', value: '60', description: 'Minutes before alerting that an order is incomplete; preserve the ST-31.5 behavior.' },
    { key: 'final_review_escalation_time', value: '07:00', description: 'Proposed local escalation time for final review; confirm with Operations.' },
    { key: 'warehouse_prep_end_time', value: '08:15', description: 'Example local end time for warehouse preparation; confirm against the warehouse shift.' },
    { key: 'warehouse_prep_lead_minutes', value: '', description: 'Not configured. Set after the warehouse preparation lead time is defined.' },
    { key: 'reschedule_code_expiry_minutes', value: '', description: 'Not configured. Set after the rescheduling code policy is defined.' },
] as const;
