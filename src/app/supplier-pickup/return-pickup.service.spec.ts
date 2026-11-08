import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { RegisterReturnPickupDto } from './dto/register-return-pickup.dto.js';
import { ReturnPickupObservationsRequiredException, ReturnPickupPhotoRequiredException, ReturnPickupSignatureRequiredException } from './exceptions/supplier-pickup.exception.js';
import { RETURN_PICKUP_COLLECTION_KIND, ReturnPickupService } from './return-pickup.service.js';

const DISPATCH_ID = 31;
const DRIVER_ID = 9;
const ROUTE_BATCH_ID = 7;
const PHOTO_ID = uuidv7();
const SIGNATURE_ID = uuidv7();

function baseDispatch(overrides: Record<string, unknown> = {}) {
    return {
        dispatch_id: DISPATCH_ID, route_batch_id: ROUTE_BATCH_ID, dispatch_type: 'warehouse_return_pickup', status: 'in_transit',
        tracking_code: 'DSP-2026-00100', source_order_ref: 'RMA-1', custody_received_at: null, arrived_at_warehouse_at: null,
        ...overrides,
    };
}

function request(overrides: Partial<RegisterReturnPickupDto> = {}): RegisterReturnPickupDto {
    return {
        eventId: uuidv7(),
        checklist: { originalPackaging: true, completeParts: true, noMisuseDamage: true },
        photoId: PHOTO_ID, signatureId: SIGNATURE_ID,
        occurredAt: new Date().toISOString(), lat: -16.5, lng: -68.12, accuracy: 8.4,
        ...overrides,
    };
}

describe('ReturnPickupService', () => {
    let manager: { query: ReturnType<typeof vi.fn> };
    let dispatchEvents: { findByClientEventId: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
    let service: ReturnPickupService;
    const custody = new Date('2026-11-07T14:00:00.000Z');

    function mockOwnership(dispatch = baseDispatch(), driverId = DRIVER_ID) {
        manager.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT route_batch_id FROM dispatches')) return [{ route_batch_id: dispatch.route_batch_id }];
            if (sql.includes('SELECT route_batch_id, driver_id FROM route_batches')) return [{ route_batch_id: ROUTE_BATCH_ID, driver_id: driverId }];
            if (sql.includes('FROM dispatches d') && sql.includes('JOIN dispatch_types')) return [dispatch];
            if (sql.includes('FROM dispatch_statuses')) return [{ dispatch_status_id: 8 }];
            if (sql.includes('UPDATE dispatches')) return [{ custody_received_at: custody }];
            return [];
        });
    }

    beforeEach(() => {
        manager = { query: vi.fn() };
        const dataSource = { transaction: vi.fn((work: (m: unknown) => Promise<unknown>) => work(manager)) };
        dispatchEvents = { findByClientEventId: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(undefined) };
        const evidences = {
            findById: vi.fn(async (id: string) => {
                if (id === PHOTO_ID) return { dispatchId: DISPATCH_ID, type: 'photo', fileUrl: 'https://files.test/p.jpg' };
                if (id === SIGNATURE_ID) return { dispatchId: DISPATCH_ID, type: 'signature', fileUrl: 'https://files.test/s.png' };
                return null;
            }),
        };
        service = new ReturnPickupService(dataSource as never, dispatchEvents as never, evidences as never);
        mockOwnership();
    });

    const updates = () => manager.query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE dispatches'));

    it('collects a complete checklist: picked_up_in_transit and one dispatch event, no observations needed', async () => {
        const result = await service.registerCollection(DISPATCH_ID, DRIVER_ID, request());

        expect(result).toEqual({ dispatchId: DISPATCH_ID, status: 'picked_up_in_transit', custodyReceivedAt: custody, checklistComplete: true });
        expect(updates()).toHaveLength(1);
        expect(dispatchEvents.create).toHaveBeenCalledWith(expect.objectContaining({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', actorUserId: DRIVER_ID,
            metadata: expect.objectContaining({ kind: RETURN_PICKUP_COLLECTION_KIND, previousStatus: 'in_transit', status: 'picked_up_in_transit', checklistComplete: true }),
        }), { manager });
    });

    it('accepts an incomplete checklist when observations are given, and stores them trimmed', async () => {
        const result = await service.registerCollection(DISPATCH_ID, DRIVER_ID, request({
            checklist: { originalPackaging: false, completeParts: true, noMisuseDamage: true }, observations: '  Sin caja original  ',
        }));

        expect(result.checklistComplete).toBe(false);
        expect(dispatchEvents.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ observations: 'Sin caja original', checklistComplete: false }) }), { manager });
    });

    it.each([undefined, '', '   '])('rejects an incomplete checklist with observations %j (422), writing nothing', async (observations) => {
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request({
            checklist: { originalPackaging: true, completeParts: false, noMisuseDamage: true }, observations,
        }))).rejects.toBeInstanceOf(ReturnPickupObservationsRequiredException);
        expect(updates()).toHaveLength(0);
        expect(dispatchEvents.create).not.toHaveBeenCalled();
    });

    it('rejects a missing or foreign photo and signature (422)', async () => {
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request({ photoId: uuidv7() }))).rejects.toBeInstanceOf(ReturnPickupPhotoRequiredException);
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request({ signatureId: uuidv7() }))).rejects.toBeInstanceOf(ReturnPickupSignatureRequiredException);
        // a photo id used as the signature (and vice versa) is not valid either
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request({ signatureId: PHOTO_ID }))).rejects.toBeInstanceOf(ReturnPickupSignatureRequiredException);
        expect(updates()).toHaveLength(0);
    });

    it('rejects another type and a status other than in_transit (409)', async () => {
        mockOwnership(baseDispatch({ dispatch_type: 'delivery' }));
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request())).rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_RETURN_PICKUP' } });

        mockOwnership(baseDispatch({ status: 'out_for_delivery' }));
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request())).rejects.toMatchObject({ response: { error: 'DISPATCH_NOT_IN_TRANSIT' } });
        expect(updates()).toHaveLength(0);
    });

    it("forbids a driver whose route does not include the dispatch", async () => {
        mockOwnership(baseDispatch(), 999);
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('answers a retry of the same eventId with the original result and writes nothing', async () => {
        dispatchEvents.findByClientEventId.mockResolvedValue({
            dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: custody, metadata: { kind: RETURN_PICKUP_COLLECTION_KIND, checklistComplete: false },
        });
        mockOwnership(baseDispatch({ status: 'picked_up_in_transit', custody_received_at: custody }));

        const result = await service.registerCollection(DISPATCH_ID, DRIVER_ID, request());
        expect(result).toEqual({ dispatchId: DISPATCH_ID, status: 'picked_up_in_transit', custodyReceivedAt: custody, checklistComplete: false });
        expect(updates()).toHaveLength(0);
        expect(dispatchEvents.create).not.toHaveBeenCalled();
    });

    it('rejects an eventId already used by another kind of event (409)', async () => {
        dispatchEvents.findByClientEventId.mockResolvedValue({ dispatchId: DISPATCH_ID, eventType: 'status_changed', createdAt: custody, metadata: { kind: 'warehouse_arrival' } });
        await expect(service.registerCollection(DISPATCH_ID, DRIVER_ID, request())).rejects.toMatchObject({ response: { error: 'EVENT_ID_ALREADY_USED' } });
    });
});
