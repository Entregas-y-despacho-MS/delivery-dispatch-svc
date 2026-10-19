import { todayInOperatingTimeZone } from '../../../modules/dispatch/dispatches/utils/operating-date.util.js';

export enum DriverMetricsPeriod {
    TODAY = 'today',
    WEEK = 'week',
    MONTH = 'month',
}

/** Whole Bolivia days, both ends included (YYYY-MM-DD). */
export interface MetricsDateRange {
    from: string;
    to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The days a period covers, counted in the operating time zone (a driver's "today" is the Bolivia day, not the
 * server's). `week` runs from Monday to today and `month` from the 1st to today, so both are the time elapsed
 * so far, never future days.
 */
export function resolveMetricsRange(period: DriverMetricsPeriod, now: Date = new Date()): MetricsDateRange {
    const today = todayInOperatingTimeZone(now);
    switch (period) {
        case DriverMetricsPeriod.TODAY:
            return { from: today, to: today };
        case DriverMetricsPeriod.WEEK: {
            const day = new Date(`${today}T00:00:00Z`);
            const sinceMonday = (day.getUTCDay() + 6) % 7; // Sunday (0) is the last day of the week
            return { from: new Date(day.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10), to: today };
        }
        case DriverMetricsPeriod.MONTH:
            return { from: `${today.slice(0, 8)}01`, to: today };
    }
}
