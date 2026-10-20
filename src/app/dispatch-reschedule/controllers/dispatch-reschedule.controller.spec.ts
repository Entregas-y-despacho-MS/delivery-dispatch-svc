import { describe, expect, it, vi } from 'vitest';
import { DispatchRescheduleController } from './dispatch-reschedule.controller.js';

function build() {
    const rescheduling = { reschedule: vi.fn() };
    const returns = { returnToWarehouse: vi.fn() };
    const cancellations = { cancel: vi.fn() };
    return { controller: new DispatchRescheduleController(rescheduling as never, returns as never, cancellations as never), rescheduling, returns, cancellations };
}

describe('DispatchRescheduleController', () => {
    it('delegates the rescheduling with the id, the body and the user of the token', async () => {
        const { controller, rescheduling } = build();
        const result = { dispatchId: 5, status: 'rescheduled' };
        rescheduling.reschedule.mockResolvedValue(result);
        const dto = { reasonCode: 'RES-OPS', windowStart: '2026-10-21T13:00:00Z', windowEnd: '2026-10-21T15:00:00Z' };

        expect(await controller.reschedule(5, dto, 9)).toBe(result);
        expect(rescheduling.reschedule).toHaveBeenCalledWith(5, dto, 9);
    });

    it('delegates the return to the warehouse with the id, the body and the user of the token', async () => {
        const { controller, returns } = build();
        const result = { dispatchId: 5, status: 'returned' };
        returns.returnToWarehouse.mockResolvedValue(result);

        expect(await controller.returnToWarehouse(5, { notes: 'No answer' }, 9)).toBe(result);
        expect(returns.returnToWarehouse).toHaveBeenCalledWith(5, { notes: 'No answer' }, 9);
    });

    it("delegates the cancellation with the id, the body and the user of the token", async () => {
        const { controller, cancellations } = build();
        const result = { dispatchId: 5, status: "cancelled" };
        cancellations.cancel.mockResolvedValue(result);

        expect(await controller.cancel(5, { reason: "Lost at the cotejo" }, 9)).toBe(result);
        expect(cancellations.cancel).toHaveBeenCalledWith(5, { reason: "Lost at the cotejo" }, 9);
    });
});
