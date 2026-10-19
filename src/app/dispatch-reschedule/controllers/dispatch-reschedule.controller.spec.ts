import { describe, expect, it, vi } from 'vitest';
import { DispatchRescheduleController } from './dispatch-reschedule.controller.js';

describe('DispatchRescheduleController', () => {
    it('delegates the rescheduling with the id, the body and the user of the token', async () => {
        const result = { dispatchId: 5, status: 'rescheduled' };
        const rescheduling = { reschedule: vi.fn().mockResolvedValue(result) };
        const controller = new DispatchRescheduleController(rescheduling as never);
        const dto = { reasonCode: 'RES-OPS', windowStart: '2026-10-21T13:00:00Z', windowEnd: '2026-10-21T15:00:00Z' };

        expect(await controller.reschedule(5, dto, 9)).toBe(result);
        expect(rescheduling.reschedule).toHaveBeenCalledWith(5, dto, 9);
    });
});
