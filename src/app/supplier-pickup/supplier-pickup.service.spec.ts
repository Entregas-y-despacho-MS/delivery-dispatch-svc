import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { SupplierPickupConflictException, SupplierPickupEvidenceRequiredException, SupplierPickupSignatureRequiredException } from './exceptions/supplier-pickup.exception.js';
import { SupplierPickupService } from './supplier-pickup.service.js';

const DISPATCH_ID = 21;
const DRIVER_ID = 9;
const ROUTE_BATCH_ID = 7;

function baseDispatch(overrides: Record<string, unknown> = {}) {
    return {
        dispatch_id: DISPATCH_ID,
        route_batch_id: ROUTE_BATCH_ID,
        dispatch_type: 'supplier_pickup',
        status: 'in_transit',
        tracking_code: 'DSP-2026-00099',
        source_order_ref: 'PO-1',
        custody_received_at: null,
        arrived_at_warehouse_at: null,
        ...overrides,
    };
}

describe('SupplierPickupService', () => {
    let dataSource: { transaction: ReturnType<typeof vi.fn> };
    let dispatchEvents: { findByClientEventId: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    let evidences: { findById: ReturnType<typeof vi.fn> };
    let incidents: { create: ReturnType<typeof vi.fn> };
    let statusPublication: { publishTransferUpdate: ReturnType<typeof vi.fn> };
    let outbox: { enqueue: ReturnType<typeof vi.fn> };
    let service: SupplierPickupService;
    let manager: { query: ReturnType<typeof vi.fn> };

    const items = [{ itemCode: 'SKU-1', receivedQuantity: 2 }, { itemCode: 'SKU-2', receivedQuantity: 3 }];
    const expectedItems = [{ item_code: 'SKU-1', expected_quantity: '2' }, { item_code: 'SKU-2', expected_quantity: '3' }];
    const gps = { lat: -16.5, lng: -68.12, accuracy: 8.4 };
    const SIGNATURE_ID = uuidv7();

    beforeEach(() => {
        manager = { query: vi.fn() };
        dataSource = { transaction: vi.fn((work: (manager: unknown) => Promise<unknown>) => work(manager)) };
        dispatchEvents = { findByClientEventId: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) };
        evidences = { findById: vi.fn(async (id: string) => (id === SIGNATURE_ID ? { dispatchId: DISPATCH_ID, type: 'signature', fileUrl: 'https://files.test/sig.png' } : null)) };
        incidents = { create: vi.fn().mockResolvedValue(undefined) };
        statusPublication = { publishTransferUpdate: vi.fn().mockResolvedValue(1) };
        outbox = { enqueue: vi.fn().mockResolvedValue(true) };
        service = new SupplierPickupService(
            dataSource as never, dispatchEvents as never, evidences as never, incidents as never, statusPublication as never, outbox as never,
        );
    });

    function mockOwnership(dispatch = baseDispatch()) {
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: dispatch.route_batch_id }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: DRIVER_ID }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [dispatch];
            return [];
        });
    }

    it('forbids a driver whose route does not include the dispatch', async () => {
        mockOwnership();
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: ROUTE_BATCH_ID }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: 999 }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [baseDispatch()];
            return [];
        });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a dispatch that is not a supplier_pickup', async () => {
        mockOwnership(baseDispatch({ dispatch_type: 'delivery' }));

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_SUPPLIER_PICKUP' } });
    });

    it('rejects items that do not match exactly the expected set', async () => {
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: ROUTE_BATCH_ID }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: DRIVER_ID }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [baseDispatch()];
            if (sql.includes('FROM dispatch_pickup_items')) return [{ item_code: 'SKU-1', expected_quantity: '2' }];
            return [];
        });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toMatchObject({ response: { error: 'SUPPLIER_PICKUP_ITEMS_MISMATCH' } });
    });

    it('rejects a missing or foreign signature', async () => {
        mockOwnership();

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: uuidv7(), ...gps,
        })).rejects.toBeInstanceOf(SupplierPickupSignatureRequiredException);
    });

    it('requires reasonCode and a valid photo when a quantity differs from the expected one', async () => {
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: ROUTE_BATCH_ID }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: DRIVER_ID }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [baseDispatch()];
            if (sql.includes('FROM dispatch_pickup_items')) return expectedItems;
            return [];
        });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(),
            items: [{ itemCode: 'SKU-1', receivedQuantity: 1 }, { itemCode: 'SKU-2', receivedQuantity: 3 }],
            receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toBeInstanceOf(SupplierPickupEvidenceRequiredException);
    });

    it('rejects a photo that was not uploaded for this dispatch', async () => {
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: ROUTE_BATCH_ID }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: DRIVER_ID }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [baseDispatch()];
            if (sql.includes('FROM dispatch_pickup_items')) return expectedItems;
            return [];
        });
        evidences.findById.mockImplementation(async (id: string) =>
            id === SIGNATURE_ID ? { dispatchId: DISPATCH_ID, type: 'signature', fileUrl: 'https://files.test/sig.png' } : { dispatchId: 999, type: 'photo', fileUrl: 'https://files.test/x.jpg' },
        );

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(),
            items: [{ itemCode: 'SKU-1', receivedQuantity: 1 }, { itemCode: 'SKU-2', receivedQuantity: 3 }],
            receivedBoxes: 5, occurredAt: new Date().toISOString(), reasonCode: 'INC-QTY', photoId: uuidv7(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toBeInstanceOf(SupplierPickupEvidenceRequiredException);
    });

    it('does not re-run the handler for a replayed eventId, and returns the current custody time', async () => {
        const dispatch = baseDispatch({ custody_received_at: new Date('2026-11-03T14:00:00.000Z') });
        mockOwnership(dispatch);
        dispatchEvents.findByClientEventId.mockResolvedValue({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: new Date('2026-11-03T14:00:00.000Z'), metadata: { kind: 'supplier_pickup_collection' },
        });

        const result = await service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        });

        expect(result).toEqual({ dispatchId: DISPATCH_ID, status: 'picked_up_in_transit', custodyReceivedAt: dispatch.custody_received_at, hasDiscrepancy: false });
        expect(statusPublication.publishTransferUpdate).not.toHaveBeenCalled();
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a reused eventId that belongs to a different event', async () => {
        mockOwnership();
        dispatchEvents.findByClientEventId.mockResolvedValue({ dispatchId: 999, eventType: 'status_changed', createdAt: new Date(), metadata: {} });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toBeInstanceOf(SupplierPickupConflictException);
    });

    it('registers the arrival of a customer return pickup and publishes it without changing the status (ST-80.2)', async () => {
        mockOwnership(baseDispatch({ dispatch_type: 'warehouse_return_pickup', status: 'picked_up_in_transit' }));
        const arrivedAt = new Date('2026-11-07T16:00:00.000Z');
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: ROUTE_BATCH_ID }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: DRIVER_ID }];
            if (sql.includes('JOIN dispatch_types')) return [baseDispatch({ dispatch_type: 'warehouse_return_pickup', status: 'picked_up_in_transit' })];
            if (sql.includes('arrived_at_warehouse_at = $1')) return [{ arrived_at_warehouse_at: arrivedAt }];
            return [];
        });

        const result = await service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: arrivedAt.toISOString(), ...gps });

        expect(result).toEqual({ dispatchId: DISPATCH_ID, arrivedAtWarehouseAt: arrivedAt });
        expect(statusPublication.publishTransferUpdate).toHaveBeenCalledWith(manager, expect.objectContaining({ status: 'picked_up_in_transit', previousStatus: 'picked_up_in_transit' }));
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('SET dispatch_status_id'))).toBe(false);
    });

    it('still rejects the arrival of a delivery', async () => {
        mockOwnership(baseDispatch({ dispatch_type: 'delivery', status: 'picked_up_in_transit' }));

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps }))
            .rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_SUPPLIER_PICKUP' } });
    });

    it('registers the arrival only after the pickup was collected', async () => {
        mockOwnership(baseDispatch({ status: 'in_transit' }));

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps }))
            .rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_PICKED_UP' } });
    });

    it('refuses a second arrival for the same dispatch', async () => {
        mockOwnership(baseDispatch({ status: 'picked_up_in_transit', arrived_at_warehouse_at: new Date() }));

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps }))
            .rejects.toMatchObject({ response: { error: 'WAREHOUSE_ARRIVAL_ALREADY_REGISTERED' } });
    });

    it('rejects a collection eventId reused against the arrival endpoint, and vice versa', async () => {
        mockOwnership(baseDispatch({ status: 'picked_up_in_transit' }));
        dispatchEvents.findByClientEventId.mockResolvedValue({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: new Date(), metadata: { kind: 'supplier_pickup_collection' },
        });

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString(), ...gps }))
            .rejects.toBeInstanceOf(SupplierPickupConflictException);

        dispatchEvents.findByClientEventId.mockResolvedValue({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: new Date(), metadata: { kind: 'warehouse_arrival' },
        });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(), signatureId: SIGNATURE_ID, ...gps,
        })).rejects.toBeInstanceOf(SupplierPickupConflictException);
    });
});
