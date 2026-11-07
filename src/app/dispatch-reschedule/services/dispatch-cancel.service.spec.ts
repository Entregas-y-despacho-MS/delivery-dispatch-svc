import { describe, expect, it, vi } from 'vitest';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../dispatch-status/dispatch-status-changed.event.js';
import { DispatchCancelNotAllowedException, DispatchTypeNotSupportedException } from '../exceptions/index.js';
import { COORDINATOR_CANCELLED_REASON_CODE, DispatchCancelService } from './dispatch-cancel.service.js';

const NOW = new Date('2026-11-03T15:00:00.000Z');
const batch = { id: 9, status: 'provisional', version: 3, stops: [] };

function build(opts: { status: string; type?: string; batch?: typeof batch | null; version?: number }) {
    const manager = {
        query: vi.fn().mockResolvedValue([[{ version: opts.version ?? 4, updated_at: NOW }], 1]),
    };
    const dataSource = { transaction: vi.fn(async (work: (m: unknown) => unknown) => await work(manager)) };
    const dispatch = { id: 5, status: opts.status, type: opts.type ?? 'delivery', version: 2 };
    const locks = { lock: vi.fn().mockResolvedValue({ dispatch, batch: opts.batch === undefined ? null : opts.batch }) };
    const publication = { publish: vi.fn().mockResolvedValue(1) };
    const dispatchEvents = { create: vi.fn().mockResolvedValue(undefined) };
    const closing = { closeIfComplete: vi.fn().mockResolvedValue(false) };
    const batchExit = {
        leave: vi.fn().mockResolvedValue({ batchId: 9, batchStatusBefore: 'provisional', batchStatusAfter: 'provisional', batchVersion: 4, dispatchVersion: 3, cancelled: false, closed: false, shiftedDispatchIds: [] }),
    };
    const events = { emit: vi.fn() };
    const service = new DispatchCancelService(dataSource as never, locks as never, publication as never, dispatchEvents as never, closing as never, batchExit as never, events as never);
    return { service, manager, publication, dispatchEvents, closing, batchExit, events };
}

const dto = { reason: 'Cliente desistió' };

describe('DispatchCancelService', () => {
    it.each(['pending', 'address_review'])('%s sin lote: publica, cancela y no toca ningún lote', async (status) => {
        const { service, publication, batchExit, closing, events } = build({ status });

        const result = await service.cancel(5, dto, 7, {}, NOW);

        expect(result).toMatchObject({ status: 'cancelled', previousStatus: status, routeBatchId: null, routeBatchClosed: false });
        expect(publication.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'cancelled', previousStatus: status, reasonCode: COORDINATOR_CANCELLED_REASON_CODE }));
        expect(batchExit.leave).not.toHaveBeenCalled();
        expect(closing.closeIfComplete).not.toHaveBeenCalled();
        expect(events.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, expect.objectContaining({ status: 'cancelled', version: 4 }));
    });

    it.each(['in_planning', 'scheduled'])('%s en un lote: sale del lote antes de publicar y no evalúa el cierre', async (status) => {
        const { service, publication, batchExit, closing, dispatchEvents } = build({ status, batch });
        const order: string[] = [];
        batchExit.leave.mockImplementation(async () => { order.push('leave'); return { batchId: 9, batchStatusBefore: 'provisional', batchStatusAfter: 'provisional', batchVersion: 4, dispatchVersion: 3, cancelled: false, closed: false }; });
        publication.publish.mockImplementation(async () => { order.push('publish'); return 1; });

        const result = await service.cancel(5, dto, 7, {}, NOW);

        expect(order).toEqual(['leave', 'publish']);
        expect(batchExit.leave).toHaveBeenCalledWith(expect.anything(), batch, 5, expect.objectContaining({ actorUserId: 7, reason: dto.reason }));
        expect(result).toMatchObject({ routeBatchId: null, routeBatchClosed: false });
        expect(closing.closeIfComplete).not.toHaveBeenCalled();
        expect(dispatchEvents.create).toHaveBeenCalledWith(
            expect.objectContaining({ metadata: expect.objectContaining({ routeBatchId: null, fromBatchId: 9, batchVersion: 4 }) }),
            expect.anything(),
        );
    });

    it('in_planning en un lote en ejecución que cierra al salir: routeBatchClosed refleja el cierre de leave', async () => {
        const { service, batchExit } = build({ status: 'in_planning', batch: { ...batch, status: 'in_execution' } });
        batchExit.leave.mockResolvedValue({ batchId: 9, batchStatusBefore: 'in_execution', batchStatusAfter: 'closed', batchVersion: 4, dispatchVersion: 3, cancelled: false, closed: true, shiftedDispatchIds: [] });

        const result = await service.cancel(5, dto, 7, {}, NOW);

        expect(result).toMatchObject({ routeBatchId: null, routeBatchClosed: true });
    });

    it('assigned: conserva el lote y evalúa su cierre', async () => {
        const { service, batchExit, closing } = build({ status: 'assigned', batch: { ...batch, status: 'in_execution' } });
        closing.closeIfComplete.mockResolvedValue(true);

        const result = await service.cancel(5, dto, 7, {}, NOW);

        expect(batchExit.leave).not.toHaveBeenCalled();
        expect(result).toMatchObject({ routeBatchId: 9, routeBatchClosed: true });
    });

    it.each(['out_for_delivery', 'in_transit', 'delivered', 'incident', 'not_delivered', 'rescheduled', 'returned', 'cancelled'])('%s → DISPATCH_CANCEL_NOT_ALLOWED sin escribir nada', async (status) => {
        const { service, publication, manager } = build({ status });

        await expect(service.cancel(5, dto, 7, {}, NOW)).rejects.toBeInstanceOf(DispatchCancelNotAllowedException);

        expect(publication.publish).not.toHaveBeenCalled();
        expect(manager.query).not.toHaveBeenCalled();
    });

    it('un despacho que no es de entrega → DISPATCH_TYPE_NOT_SUPPORTED', async () => {
        const { service } = build({ status: 'assigned', type: 'supplier_pickup' });

        await expect(service.cancel(5, dto, 7, {}, NOW)).rejects.toBeInstanceOf(DispatchTypeNotSupportedException);
    });

    it('un recojo de cliente en el endpoint de entregas → DISPATCH_TYPE_NOT_SUPPORTED sin escribir nada', async () => {
        const { service, publication, manager } = build({ status: 'pickup_scheduled', type: 'warehouse_return_pickup' });

        await expect(service.cancel(5, dto, 7, {}, NOW)).rejects.toBeInstanceOf(DispatchTypeNotSupportedException);

        expect(publication.publish).not.toHaveBeenCalled();
        expect(manager.query).not.toHaveBeenCalled();
    });

    describe('recojo de cliente (warehouse_return_pickup)', () => {
        const pickup = { type: 'warehouse_return_pickup' };

        it.each(['pickup_scheduled', 'address_review'])('%s sin lote: se cancela sin publicar al ERP y sin tocar ningún lote', async (status) => {
            const { service, publication, batchExit, closing, events, dispatchEvents } = build({ status, type: pickup.type });

            const result = await service.cancel(5, dto, 7, pickup, NOW);

            expect(result).toMatchObject({ status: 'cancelled', previousStatus: status, routeBatchId: null, routeBatchClosed: false });
            expect(publication.publish).not.toHaveBeenCalled();
            expect(batchExit.leave).not.toHaveBeenCalled();
            expect(closing.closeIfComplete).not.toHaveBeenCalled();
            expect(events.emit).toHaveBeenCalledWith(DISPATCH_STATUS_CHANGED_EVENT, expect.objectContaining({ status: 'cancelled', version: 4 }));
            const metadata = dispatchEvents.create.mock.calls[0][0].metadata as Record<string, unknown>;
            expect(metadata).not.toHaveProperty('outboundRecordVersion');
        });

        it('in_planning en un lote: sale del lote (sube la versión, D-09) y no publica', async () => {
            const { service, publication, batchExit, closing } = build({ status: 'in_planning', type: pickup.type, batch });

            const result = await service.cancel(5, dto, 7, pickup, NOW);

            expect(batchExit.leave).toHaveBeenCalledWith(expect.anything(), batch, 5, expect.objectContaining({ actorUserId: 7, reason: dto.reason }));
            expect(result).toMatchObject({ previousStatus: 'in_planning', routeBatchId: null });
            expect(publication.publish).not.toHaveBeenCalled();
            expect(closing.closeIfComplete).not.toHaveBeenCalled();
        });

        it.each(['pending', 'scheduled', 'assigned', 'in_transit', 'picked_up_in_transit', 'delivered', 'cancelled'])('%s → DISPATCH_CANCEL_NOT_ALLOWED sin escribir nada', async (status) => {
            const { service, publication, manager } = build({ status, type: pickup.type });

            const error = await service.cancel(5, dto, 7, pickup, NOW).catch((e: unknown) => e);

            expect(error).toBeInstanceOf(DispatchCancelNotAllowedException);
            expect((error as DispatchCancelNotAllowedException).message).toContain('pickup_scheduled, address_review or in_planning');
            expect(publication.publish).not.toHaveBeenCalled();
            expect(manager.query).not.toHaveBeenCalled();
        });

        it('una entrega en el endpoint de recojos → DISPATCH_TYPE_NOT_SUPPORTED', async () => {
            const { service } = build({ status: 'pending', type: 'delivery' });

            await expect(service.cancel(5, dto, 7, pickup, NOW)).rejects.toBeInstanceOf(DispatchTypeNotSupportedException);
        });
    });
});
