// ST-75.1 — validation of the request bodies. No DB or network: class-validator directly, with the
// same options as the global ValidationPipe.
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReschedulePickupDto } from './reschedule-pickup.dto.js';
import { SchedulePickupDto } from './schedule-pickup.dto.js';

const OPTIONS = { whitelist: true, forbidNonWhitelisted: true };

async function schedule(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(SchedulePickupDto, plain), OPTIONS)).map((e) => e.property);
}

async function reschedule(plain: object): Promise<string[]> {
    return (await validate(plainToInstance(ReschedulePickupDto, plain), OPTIONS)).map((e) => e.property);
}

describe('SchedulePickupDto', () => {
    it('accepts only the vehicle, or the vehicle with a slot', async () => {
        expect(await schedule({ vehicleId: 3 })).toEqual([]);
        expect(
            await schedule({ vehicleId: 3, windowStart: '2026-10-20T14:00:00Z', windowEnd: '2026-10-20T10:00:00-04:00' }),
        ).toEqual([]);
    });

    it.each([undefined, 0, -1, 1.5, '3', 2147483648])('rejects vehicleId %j', async (vehicleId) => {
        expect(await schedule({ vehicleId })).toEqual(['vehicleId']);
    });

    it.each(['2026-10-20', '2026-10-20T14:00:00', '20/10/2026 14:00', 'mañana', '2026-13-01T14:00:00Z'])(
        'rejects the date-time %j',
        async (windowStart) => {
            expect(await schedule({ vehicleId: 3, windowStart })).toEqual(['windowStart']);
        },
    );

    it('rejects unknown fields', async () => {
        expect(await schedule({ vehicleId: 3, driverId: 5 })).toEqual(['driverId']);
    });
});

describe('ReschedulePickupDto', () => {
    const valid = {
        incidentReasonId: 4,
        rescheduleReasonId: 6,
        windowStart: '2026-10-21T14:00:00Z',
        windowEnd: '2026-10-21T16:00:00Z',
    };

    it('accepts the required fields with or without a description', async () => {
        expect(await reschedule(valid)).toEqual([]);
        expect(await reschedule({ ...valid, description: 'Supplier had no load ready' })).toEqual([]);
    });

    it('requires both reasons and both ends of the slot', async () => {
        const errors = await reschedule({});
        expect(errors.sort()).toEqual(['incidentReasonId', 'rescheduleReasonId', 'windowEnd', 'windowStart']);
    });

    it('rejects a description longer than 500 characters', async () => {
        expect(await reschedule({ ...valid, description: 'x'.repeat(501) })).toEqual(['description']);
    });
});
