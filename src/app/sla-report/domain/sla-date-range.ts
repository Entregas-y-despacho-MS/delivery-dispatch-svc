import { InvalidHistoryDateRangeException } from '../../../modules/dispatch/dispatch-history/exceptions/index.js';
import { SlaRangeTooLargeException } from '../exceptions/index.js';

/** The longest range one report may cover (both ends included): a year, leap year included. */
export const SLA_REPORT_MAX_DAYS = 366;

const MS_PER_DAY = 86_400_000;

/**
 * `from` and `to` are Bolivia days in `YYYY-MM-DD` (the DTO validates the format, so comparing them as text is
 * comparing them as dates). `from` after `to` is `INVALID_DATE_RANGE`, the same answer as the history; a range
 * longer than `SLA_REPORT_MAX_DAYS` is `DATE_RANGE_TOO_LARGE`, so one request cannot scan the whole table.
 */
export function assertSlaRange(from: string, to: string): void {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY + 1;
    // Not a date: through the HTTP route the DTO already stopped it, but `aggregate` and `compute` are also called by other
    // modules (ST-61.1, ST-65.1), and `NaN > 366` is false: without this check a value that is not a date would pass.
    if (Number.isNaN(days)) throw new RangeError(`The SLA report range is not made of dates: ${from} to ${to}.`);
    if (from > to) throw new InvalidHistoryDateRangeException();
    if (days > SLA_REPORT_MAX_DAYS) throw new SlaRangeTooLargeException(SLA_REPORT_MAX_DAYS);
}
