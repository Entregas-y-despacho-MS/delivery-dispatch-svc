// Bolivia has no daylight saving time, so "today" is a fixed UTC-4 calendar day.
export const BUSINESS_TIME_ZONE = 'America/La_Paz';

/**
 * SQL predicate (aliases: d = dispatches, s = dispatch_statuses) for the orders a coordinator can plan
 * today: every `pending` order, plus the `rescheduled` ones whose agreed date is today. Any other
 * status is out. Shared by the inbox listing and the soft reservation so both agree on what is plannable.
 */
export const INBOX_ELIGIBILITY_SQL = `(
    s.name = 'pending'
    OR (s.name = 'rescheduled'
        AND (d.scheduled_window_start AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date = (NOW() AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date)
)`;
