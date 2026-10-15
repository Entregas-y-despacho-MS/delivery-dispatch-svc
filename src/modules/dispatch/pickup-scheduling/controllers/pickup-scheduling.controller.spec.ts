// ST-75.1 — PickupSchedulingController: the actor comes from the token and the window is validated before the service runs.
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PickupSchedulingController } from './pickup-scheduling.controller.js';

function build() {
    const service = {
        schedule: vi.fn().mockResolvedValue({ id: 7, status: 'scheduled' }),
        reschedule: vi.fn().mockResolvedValue({ id: 7, status: 'scheduled' }),
    };
    return { controller: new PickupSchedulingController(service as never), service };
}

describe('PickupSchedulingController.schedule', () => {
    it('delegates with the dispatch, the vehicle and the user of the token', async () => {
        const { controller, service } = build();

        const result = await controller.schedule(7, { vehicleId: 3 }, 9);

        expect(service.schedule).toHaveBeenCalledWith(7, { vehicleId: 3, window: undefined }, 9);
        expect(result).toEqual({ id: 7, status: 'scheduled' });
    });

    it('passes the requested slot as dates', async () => {
        const { controller, service } = build();

        await controller.schedule(
            7,
            { vehicleId: 3, windowStart: '2026-10-20T14:00:00Z', windowEnd: '2026-10-20T16:00:00Z' },
            9,
        );

        expect(service.schedule).toHaveBeenCalledWith(
            7,
            {
                vehicleId: 3,
                window: { startsAt: new Date('2026-10-20T14:00:00Z'), endsAt: new Date('2026-10-20T16:00:00Z') },
            },
            9,
        );
    });

    it('answers 400 when only one end of the slot is sent', async () => {
        const { controller, service } = build();

        await expect(
            controller.schedule(7, { vehicleId: 3, windowStart: '2026-10-20T14:00:00Z' }, 9),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(service.schedule).not.toHaveBeenCalled();
    });

    it('answers 400 when the slot ends before it starts', async () => {
        const { controller, service } = build();

        await expect(
            controller.schedule(
                7,
                { vehicleId: 3, windowStart: '2026-10-20T16:00:00Z', windowEnd: '2026-10-20T14:00:00Z' },
                9,
            ),
        ).rejects.toMatchObject({ response: { error: 'INVALID_PICKUP_WINDOW' } });
        expect(service.schedule).not.toHaveBeenCalled();
    });
});

describe('PickupSchedulingController.reschedule', () => {
    const dto = {
        incidentReasonId: 4,
        rescheduleReasonId: 6,
        windowStart: '2026-10-21T14:00:00Z',
        windowEnd: '2026-10-21T16:00:00Z',
        description: 'Supplier had no load ready',
    };

    it('delegates with the reasons, the new slot and the user of the token', async () => {
        const { controller, service } = build();

        await controller.reschedule(7, dto, 9);

        expect(service.reschedule).toHaveBeenCalledWith(
            7,
            {
                incidentReasonId: 4,
                rescheduleReasonId: 6,
                window: { startsAt: new Date('2026-10-21T14:00:00Z'), endsAt: new Date('2026-10-21T16:00:00Z') },
                description: 'Supplier had no load ready',
            },
            9,
        );
    });

    it('answers 400 when the new slot ends before it starts', async () => {
        const { controller, service } = build();

        await expect(
            controller.reschedule(7, { ...dto, windowEnd: '2026-10-21T13:00:00Z' }, 9),
        ).rejects.toMatchObject({ response: { error: 'INVALID_PICKUP_WINDOW' } });
        expect(service.reschedule).not.toHaveBeenCalled();
    });
});
