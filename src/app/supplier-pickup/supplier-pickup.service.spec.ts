import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { SupplierPickupConflictException, SupplierPickupEvidenceRequiredException } from './exceptions/supplier-pickup.exception.js';
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

    beforeEach(() => {
        manager = { query: vi.fn() };
        dataSource = { transaction: vi.fn((work: (manager: unknown) => Promise<unknown>) => work(manager)) };
        dispatchEvents = { findByClientEventId: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) };
        evidences = { findById: vi.fn() };
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
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(),
        })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a dispatch that is not a supplier_pickup', async () => {
        mockOwnership(baseDispatch({ dispatch_type: 'delivery' }));

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(),
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
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(),
        })).rejects.toMatchObject({ response: { error: 'SUPPLIER_PICKUP_ITEMS_MISMATCH' } });
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
            receivedBoxes: 5, occurredAt: new Date().toISOString(),
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
        evidences.findById.mockResolvedValue({ dispatchId: 999, type: 'photo', fileUrl: 'https://files.test/x.jpg' });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(),
            items: [{ itemCode: 'SKU-1', receivedQuantity: 1 }, { itemCode: 'SKU-2', receivedQuantity: 3 }],
            receivedBoxes: 5, occurredAt: new Date().toISOString(), reasonCode: 'INC-QTY', photoId: uuidv7(),
        })).rejects.toBeInstanceOf(SupplierPickupEvidenceRequiredException);
    });

    it('does not re-run the handler for a replayed eventId, and returns the current custody time', async () => {
        const dispatch = baseDispatch({ custody_received_at: new Date('2026-11-03T14:00:00.000Z') });
        mockOwnership(dispatch);
        dispatchEvents.findByClientEventId.mockResolvedValue({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: new Date('2026-11-03T14:00:00.000Z'), metadata: {},
        });

        const result = await service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(),
        });

        expect(result).toEqual({ dispatchId: DISPATCH_ID, status: 'picked_up_in_transit', custodyReceivedAt: dispatch.custody_received_at, hasDiscrepancy: false });
        expect(statusPublication.publishTransferUpdate).not.toHaveBeenCalled();
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('rejects a reused eventId that belongs to a different event', async () => {
        mockOwnership();
        dispatchEvents.findByClientEventId.mockResolvedValue({ dispatchId: 999, eventType: 'status_changed', createdAt: new Date(), metadata: {} });

        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, {
            eventId: uuidv7(), items, receivedBoxes: 5, occurredAt: new Date().toISOString(),
        })).rejects.toBeInstanceOf(SupplierPickupConflictException);
    });

    it('registers the arrival only after the pickup was collected', async () => {
        mockOwnership(baseDispatch({ status: 'in_transit' }));

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString() }))
            .rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_PICKED_UP' } });
    });

    it('refuses a second arrival for the same dispatch', async () => {
        mockOwnership(baseDispatch({ status: 'picked_up_in_transit', arrived_at_warehouse_at: new Date() }));

        await expect(service.registerArrival(DISPATCH_ID, DRIVER_ID, { eventId: uuidv7(), occurredAt: new Date().toISOString() }))
            .rejects.toMatchObject({ response: { error: 'WAREHOUSE_ARRIVAL_ALREADY_REGISTERED' } });
    });
});
