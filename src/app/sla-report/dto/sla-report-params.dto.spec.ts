import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SlaReportParamsDto } from './sla-report-params.dto.js';

async function messagesOf(query: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(SlaReportParamsDto, query));
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('SlaReportParamsDto', () => {
    const valid = { from: '2026-10-01', to: '2026-10-31', groupBy: 'zone' };

    it('accepts each grouping', async () => {
        for (const groupBy of ['zone', 'service_level', 'driver']) expect(await messagesOf({ ...valid, groupBy })).toEqual([]);
    });

    it('requires `from`, `to` and `groupBy`', async () => {
        for (const missing of ['from', 'to', 'groupBy']) {
            const query: Record<string, unknown> = { ...valid };
            delete query[missing];
            expect(await messagesOf(query), missing).not.toEqual([]);
        }
    });

    it('rejects a date that is not YYYY-MM-DD or does not exist', async () => {
        expect(await messagesOf({ ...valid, from: '01/10/2026' })).toContain("The 'from' parameter must be a valid date in YYYY-MM-DD format.");
        expect(await messagesOf({ ...valid, to: '2026-10-31T10:00:00Z' })).toContain("The 'to' parameter must be a valid date in YYYY-MM-DD format.");
        expect(await messagesOf({ ...valid, to: '2026-02-30' })).not.toEqual([]);
    });

    it('rejects a grouping outside the list', async () => {
        expect(await messagesOf({ ...valid, groupBy: 'vehicle' })).toContain("The 'groupBy' parameter must be one of: zone, service_level, driver.");
        expect(await messagesOf({ ...valid, groupBy: 'ZONE' })).not.toEqual([]);
    });
});
