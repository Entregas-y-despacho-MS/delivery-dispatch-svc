// ST-81.2 — validation of the query of GET /pickup-orders. No DB or network: class-validator directly.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindPickupOrdersParamsDto } from './find-pickup-orders-params.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function invalidProperties(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(FindPickupOrdersParamsDto, plain), OPTIONS)).map((e) => e.property);
}

describe('FindPickupOrdersParamsDto', () => {
    it('accepts no filters and every filter, with the pagination defaults', async () => {
        expect(await invalidProperties({})).toEqual([]);
        expect(await invalidProperties({ status: 'pickup_scheduled', from: '2026-11-01', to: '2026-11-30', origin: 'manual', page: '2', limit: '20' })).toEqual([]);
        const dto = plainToInstance(FindPickupOrdersParamsDto, {});
        expect([dto.page, dto.limit]).toEqual([1, 10]);
    });

    it('treats empty filters (an empty select of the page) as not given', async () => {
        const dto = plainToInstance(FindPickupOrdersParamsDto, { status: '', origin: '', from: '', to: '' });

        expect(await validate(dto, OPTIONS)).toEqual([]);
        expect([dto.status, dto.origin, dto.from, dto.to]).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('reads the origin case-insensitively', async () => {
        const dto = plainToInstance(FindPickupOrdersParamsDto, { origin: ' RMA ' });

        expect(await validate(dto, OPTIONS)).toEqual([]);
        expect(dto.origin).toBe('rma');
    });

    it.each(['other', 'manual,rma'])('rejects origin %j', async (origin) => {
        expect(await invalidProperties({ origin })).toEqual(['origin']);
    });

    it('rejects a status that does not exist', async () => {
        expect(await invalidProperties({ status: 'flying' })).toEqual(['status']);
    });

    it.each(['2026-13-01', '2026-02-30', '01/11/2026', '2026-11-01T00:00:00Z'])('rejects the date %j', async (value) => {
        expect(await invalidProperties({ from: value })).toEqual(['from']);
        expect(await invalidProperties({ to: value })).toEqual(['to']);
    });

    it.each([{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: 'x' }])('rejects the pagination %j', async (params) => {
        expect(await invalidProperties(params)).toEqual([Object.keys(params)[0]]);
    });
});
