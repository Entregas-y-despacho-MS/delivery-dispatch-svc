// Bolivia has no daylight saving time, so "today" is a fixed UTC-4 calendar day.
export const BUSINESS_TIME_ZONE = 'America/La_Paz';

/**
 * SQL predicate (aliases: d = dispatches, s = dispatch_statuses) for the orders a coordinator can plan
 * today: every `pending` order, every `in_planning` order proposed by the generator, plus the
 * `rescheduled` ones whose agreed date is today. Any other status is out. Shared by the inbox listing
 * and the soft reservation so both agree on what is plannable.
 */
export const INBOX_ELIGIBILITY_SQL = `(
    s.name IN ('pending', 'in_planning')
    OR (s.name = 'rescheduled'
        AND (d.scheduled_window_start AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date = (NOW() AT TIME ZONE '${BUSINESS_TIME_ZONE}')::date)
)`;

/**
 * What the inbox lists: everything plannable plus the `address_review` orders, shown read-only so the
 * coordinator sees them and can fix the point on the map (D-19). They are deliberately NOT part of
 * INBOX_ELIGIBILITY_SQL: they cannot be reserved and never enter a batch.
 */
export const INBOX_LISTING_SQL = `(${INBOX_ELIGIBILITY_SQL} OR s.name = 'address_review')`;
