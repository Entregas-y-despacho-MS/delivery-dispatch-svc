// The operation runs in Bolivia: "today" for a driver's shift is the local calendar day, not the
// server's (a container in UTC would already be on the next day from 20:00 local time).
export const OPERATING_TIME_ZONE = 'America/La_Paz';

/** The calendar day (YYYY-MM-DD) of `now` in the operating time zone. */
export function todayInOperatingTimeZone(now: Date = new Date()): string {
    // The 'en-CA' locale formats dates as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone: OPERATING_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
