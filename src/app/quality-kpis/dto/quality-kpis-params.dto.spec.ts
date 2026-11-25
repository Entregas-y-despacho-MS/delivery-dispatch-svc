import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { QualityKpisParamsDto } from './quality-kpis-params.dto.js';

async function check(query: Record<string, unknown>) {
    const dto = plainToInstance(QualityKpisParamsDto, query);
    const errors = await validate(dto);
    return { dto, messages: errors.flatMap((error) => Object.values(error.constraints ?? {})) };
}

describe('QualityKpisParamsDto', () => {
    const valid = { from: '2026-11-01', to: '2026-11-30' };

    it('accepts only the dates, with the default page, and every filter combined', async () => {
        const minimal = await check(valid);
        expect(minimal.messages).toEqual([]);
        expect([minimal.dto.page, minimal.dto.limit]).toEqual([1, 10]);
        const all = await check({ ...valid, timeZone: 'America/La_Paz', zoneId: '3', incidentReasonId: '4', reasonCode: ' DAMAGED ', status: 'DELIVERED', rescheduled: 'true', order: 'ASC', page: '2', limit: '50' });
        expect(all.messages).toEqual([]);
        expect(all.dto).toMatchObject({ zoneId: 3, incidentReasonId: 4, reasonCode: 'DAMAGED', status: 'delivered', rescheduled: true, order: 'asc', page: 2, limit: 50 });
    });

    it('requires `from` and `to` in YYYY-MM-DD', async () => {
        expect((await check({ to: valid.to })).messages).not.toEqual([]);
        expect((await check({ ...valid, from: '01/11/2026' })).messages).toContain("The 'from' parameter must be a valid date in YYYY-MM-DD format.");
    });

    it('accepts only America/La_Paz as time zone', async () => {
        expect((await check({ ...valid, timeZone: 'UTC' })).messages).toContain("The 'timeZone' parameter must be America/La_Paz.");
    });

    it('rejects ids, status, order and page size outside the allowed values', async () => {
        expect((await check({ ...valid, zoneId: '0' })).messages).toContain("The 'zoneId' parameter must be >= 1.");
        expect((await check({ ...valid, incidentReasonId: '2147483648' })).messages).not.toEqual([]);
        expect((await check({ ...valid, status: 'lost' })).messages).not.toEqual([]);
        expect((await check({ ...valid, order: 'sideways' })).messages).toContain("The 'order' parameter must be one of: asc, desc.");
        expect((await check({ ...valid, limit: '101' })).messages).toContain("The 'limit' parameter must be <= 100.");
        expect((await check({ ...valid, reasonCode: 'X'.repeat(41) })).messages).toContain("The 'reasonCode' parameter must not exceed 40 characters.");
    });

    it('a rescheduled that is not true or false is a 400', async () => {
        await expect(async () => plainToInstance(QualityKpisParamsDto, { ...valid, rescheduled: 'maybe' })).rejects.toThrow();
    });
});
