import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { DeliveryBacklogParamsDto, OtdReportParamsDto } from './delivery-promise-params.dto.js';

async function messagesOf<T extends object>(cls: new () => T, query: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(cls, query));
    return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('OtdReportParamsDto', () => {
    const valid = { from: '2026-11-01', to: '2026-11-30' };

    it('accepts only the dates, and every optional filter', async () => {
        expect(await messagesOf(OtdReportParamsDto, valid)).toEqual([]);
        expect(await messagesOf(OtdReportParamsDto, { ...valid, zoneId: '3', serviceLevelId: '2', status: 'ASSIGNED', basis: 'deliveredAt' })).toEqual([]);
    });

    it('requires `from` and `to`', async () => {
        expect(await messagesOf(OtdReportParamsDto, { to: valid.to })).not.toEqual([]);
        expect(await messagesOf(OtdReportParamsDto, { from: valid.from })).not.toEqual([]);
    });

    it('rejects a date that is not YYYY-MM-DD', async () => {
        expect(await messagesOf(OtdReportParamsDto, { ...valid, from: '01/11/2026' })).toContain("The 'from' parameter must be a valid date in YYYY-MM-DD format.");
    });

    it('rejects a basis, a status or an id outside the allowed values', async () => {
        expect(await messagesOf(OtdReportParamsDto, { ...valid, basis: 'closed' })).toContain("The 'basis' parameter must be one of: promise, deliveredAt.");
        expect(await messagesOf(OtdReportParamsDto, { ...valid, status: 'lost' })).not.toEqual([]);
        expect(await messagesOf(OtdReportParamsDto, { ...valid, zoneId: '0' })).toContain("The 'zoneId' parameter must be >= 1.");
        expect(await messagesOf(OtdReportParamsDto, { ...valid, serviceLevelId: '2147483648' })).not.toEqual([]);
    });
});

describe('DeliveryBacklogParamsDto', () => {
    const valid = { from: '2026-11-01', to: '2026-11-30' };

    it('limits the size of the list', async () => {
        expect(await messagesOf(DeliveryBacklogParamsDto, { ...valid, overdueLimit: '100' })).toEqual([]);
        expect(await messagesOf(DeliveryBacklogParamsDto, { ...valid, overdueLimit: '101' })).toContain("The 'overdueLimit' parameter must be <= 100.");
        expect(await messagesOf(DeliveryBacklogParamsDto, { ...valid, overdueLimit: '0' })).toContain("The 'overdueLimit' parameter must be >= 1.");
    });
});
