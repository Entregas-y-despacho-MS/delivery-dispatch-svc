const BUSINESS_TIME_ZONE = 'America/La_Paz';

export interface ServiceTerm {
    earliestDate: string;
    latestDate: string;
    minimumOperatingDays: number;
    maximumOperatingDays: number;
}

function localDate(instant: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: BUSINESS_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(instant);
    const value = (name: string): string => parts.find((part) => part.type === name)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
}

/** D0 is the local date of commercial confirmation. D1 starts on the next operating day. */
export function calculateServiceTerm(
    confirmedAt: string,
    minimumOperatingDays: number,
    maximumOperatingDays: number,
    workingDays: ReadonlySet<number>,
    nonWorkingDates: ReadonlySet<string>,
): ServiceTerm {
    const confirmed = new Date(confirmedAt);
    if (Number.isNaN(confirmed.getTime())) throw new Error('Invalid commercial confirmation date.');
    if (!Number.isInteger(minimumOperatingDays) || !Number.isInteger(maximumOperatingDays)
        || minimumOperatingDays < 1 || maximumOperatingDays < minimumOperatingDays
        || workingDays.size === 0) throw new Error('Invalid service term settings.');

    const date = new Date(`${localDate(confirmed)}T00:00:00.000Z`);
    let elapsed = 0;
    let earliestDate = '';
    let latestDate = '';
    // More than a year without an operating day is a configuration error, not an endless loop.
    for (let day = 0; day < 366 && elapsed < maximumOperatingDays; day++) {
        date.setUTCDate(date.getUTCDate() + 1);
        const candidate = date.toISOString().slice(0, 10);
        const weekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
        if (!workingDays.has(weekday) || nonWorkingDates.has(candidate)) continue;
        elapsed++;
        if (elapsed === minimumOperatingDays) earliestDate = candidate;
        if (elapsed === maximumOperatingDays) latestDate = candidate;
    }
    if (!latestDate) throw new Error('No operating date available for the service term.');
    return { earliestDate, latestDate, minimumOperatingDays, maximumOperatingDays };
}
