// ST-81.2 — PickupOrdersController: the cancellation reuses DispatchCancelService restricted to the pickup type.
import { describe, expect, it, vi } from 'vitest';
import { PICKUP_ORDER_DISPATCH_TYPE, PickupOrdersController } from './pickup-orders.controller.js';

function build() {
    const pickupOrders = { create: vi.fn().mockResolvedValue({ id: 55 }), findAll: vi.fn().mockResolvedValue({ data: [], meta: { page: 1, limit: 10, total: 0, pages: 0 } }) };
    const cancellations = { cancel: vi.fn().mockResolvedValue({ dispatchId: 55, status: 'cancelled' }) };
    return { controller: new PickupOrdersController(pickupOrders as never, cancellations as never), pickupOrders, cancellations };
}

describe('PickupOrdersController', () => {
    it('create: delegates with the body and the user of the token', async () => {
        const { controller, pickupOrders } = build();
        const dto = { warehouseCode: 'WH-LPZ-01' } as never;

        await expect(controller.create(dto, 7)).resolves.toEqual({ id: 55 });

        expect(pickupOrders.create).toHaveBeenCalledWith(dto, 7);
    });

    it('findAll: delegates the filters as they come', async () => {
        const { controller, pickupOrders } = build();
        const params = { page: 1, limit: 10, origin: 'rma' } as never;

        await expect(controller.findAll(params)).resolves.toMatchObject({ meta: { total: 0 } });

        expect(pickupOrders.findAll).toHaveBeenCalledWith(params);
    });

    it('cancel: reuses DispatchCancelService limited to warehouse_return_pickup (no own cancellation logic)', async () => {
        const { controller, cancellations } = build();

        const result = await controller.cancel(55, { reason: 'Cliente desistió' }, 7);

        expect(PICKUP_ORDER_DISPATCH_TYPE).toBe('warehouse_return_pickup');
        expect(cancellations.cancel).toHaveBeenCalledWith(55, { reason: 'Cliente desistió' }, 7, { type: 'warehouse_return_pickup' });
        expect(result).toEqual({ dispatchId: 55, status: 'cancelled' });
    });
});
