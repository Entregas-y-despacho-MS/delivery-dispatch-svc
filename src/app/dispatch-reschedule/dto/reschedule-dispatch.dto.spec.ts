import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { RescheduleDispatchDto } from './reschedule-dispatch.dto.js';

const valid = { reasonCode: 'RES-OPS', windowStart: '2026-10-21T13:00:00Z', windowEnd: '2026-10-21T15:00:00Z' };

async function failing(body: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(RescheduleDispatchDto, body));
    return errors.map((error) => error.property).sort();
}

describe('RescheduleDispatchDto', () => {
    it('accepts the three required fields, with or without instructions', async () => {
        expect(await failing(valid)).toEqual([]);
        expect(await failing({ ...valid, instructions: 'Call first' })).toEqual([]);
        expect(await failing({ ...valid, instructions: null })).toEqual([]);
    });

    it('requires the reason code and both ends of the slot', async () => {
        expect(await failing({})).toEqual(['reasonCode', 'windowEnd', 'windowStart']);
    });

    it.each(['', 'x'.repeat(31), 12])('rejects the reason code %s', async (reasonCode) => {
        expect(await failing({ ...valid, reasonCode })).toEqual(['reasonCode']);
    });

    it.each(['2026-10-21', '2026-10-21T13:00:00', '21/10/2026 13:00', 'tomorrow'])('rejects a slot start without date, time and offset: %s', async (windowStart) => {
        expect(await failing({ ...valid, windowStart })).toEqual(['windowStart']);
    });

    it('accepts an explicit offset instead of Z', async () => {
        expect(await failing({ ...valid, windowStart: '2026-10-21T09:00:00-04:00', windowEnd: '2026-10-21T11:00:00-04:00' })).toEqual([]);
    });

    it('rejects instructions longer than 500 characters', async () => {
        expect(await failing({ ...valid, instructions: 'x'.repeat(501) })).toEqual(['instructions']);
    });
});
