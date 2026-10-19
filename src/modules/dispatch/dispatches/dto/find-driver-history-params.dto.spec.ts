import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { FindDriverHistoryParamsDto } from './find-driver-history-params.dto.js';

describe('FindDriverHistoryParamsDto', () => {
    it('provides default page and limit values', async () => {
        const dto = new FindDriverHistoryParamsDto();

        expect(dto.page).toBe(1);
        expect(dto.limit).toBe(20);
        expect(await validate(dto)).toEqual([]);
    });

    it.each([1, 1_000_000])('accepts page %i', async (page) => {
        const dto = Object.assign(new FindDriverHistoryParamsDto(), { page });
        expect(await validate(dto)).toEqual([]);
    });

    it.each([0, 1_000_001, 1.5])('rejects invalid page %s', async (page) => {
        const dto = Object.assign(new FindDriverHistoryParamsDto(), { page });
        expect((await validate(dto)).some((error) => error.property === 'page')).toBe(true);
    });

    it.each([1, 50])('accepts limit %i', async (limit) => {
        const dto = Object.assign(new FindDriverHistoryParamsDto(), { limit });
        expect(await validate(dto)).toEqual([]);
    });

    it.each([0, 51, 1.5])('rejects invalid limit %s', async (limit) => {
        const dto = Object.assign(new FindDriverHistoryParamsDto(), { limit });
        expect((await validate(dto)).some((error) => error.property === 'limit')).toBe(true);
    });

    it('accepts strict calendar dates and rejects malformed or impossible dates', async () => {
        const valid = Object.assign(new FindDriverHistoryParamsDto(), { from: '2026-10-01', to: '2026-10-31' });
        const invalid = Object.assign(new FindDriverHistoryParamsDto(), { from: '2026-2-01', to: '2026-02-30' });

        expect(await validate(valid)).toEqual([]);
        expect((await validate(invalid)).map((error) => error.property).sort()).toEqual(['from', 'to']);
    });

    it('accepts only supported final statuses', async () => {
        const valid = Object.assign(new FindDriverHistoryParamsDto(), { status: 'returned' });
        const invalid = Object.assign(new FindDriverHistoryParamsDto(), { status: 'cancelled' });

        expect(await validate(valid)).toEqual([]);
        expect((await validate(invalid)).some((error) => error.property === 'status')).toBe(true);
    });

    it('limits tracking-code search to 100 characters', async () => {
        const valid = Object.assign(new FindDriverHistoryParamsDto(), { search: 'x'.repeat(100) });
        const invalid = Object.assign(new FindDriverHistoryParamsDto(), { search: 'x'.repeat(101) });

        expect(await validate(valid)).toEqual([]);
        expect((await validate(invalid)).some((error) => error.property === 'search')).toBe(true);
    });
});
