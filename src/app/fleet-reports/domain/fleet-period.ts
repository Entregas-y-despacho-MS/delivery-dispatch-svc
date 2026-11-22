import { assertSlaRange } from '../../sla-report/domain/sla-date-range.js';

/**
 * The period of maintenance and productivity (ST-303.1): `from` and `to` default to the cut-off day, so a request with
 * no dates asks about one day. Same limits as ST-65.1 (`from` not after `to`, at most 366 days). Pure.
 */
export function resolvePeriod(from: string | undefined, to: string | undefined, cutoffDay: string): { from: string; to: string } {
    const period = { from: from ?? cutoffDay, to: to ?? cutoffDay };
    assertSlaRange(period.from, period.to);
    return period;
}
