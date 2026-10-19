import { describe, expect, it, vi } from 'vitest';
import { DispatchDetailService } from './dispatch-detail.service.js';
import { DispatchNotFoundException } from '../exceptions/index.js';

const at = (iso: string) => new Date(iso);

function build(overrides: { dispatch?: unknown; events?: unknown[]; evidences?: unknown[] } = {}) {
    const dispatch = overrides.dispatch === undefined ? {
        id: 5, trackingCode: 'T1', sourceOrderRef: 'SO-1', priority: 'normal', evidencePolicy: 'hand_delivery_standard',
        paymentStatusLabel: null, scheduledWindowStart: null, scheduledWindowEnd: null, createdAt: at('2026-10-18T10:00:00Z'),
        dispatchType: { id: 1, name: 'delivery' }, dispatchStatus: { id: 2, name: 'delivered' },
        deliveryZone: null, serviceLevel: null, packages: [], routeBatch: null, sequenceOrder: null,
        deliveryAddress: 'Calle 1', deliveryReference: null, deliveryLatitude: '-16.500000', deliveryLongitude: null,
        contactName: null, contactPhone: null,
    } : overrides.dispatch;
    const repo = (rows: unknown) => ({ findOne: vi.fn().mockResolvedValue(rows), find: vi.fn().mockResolvedValue(rows) });
    const dispatches = repo(dispatch);
    const events = repo(overrides.events ?? []);
    const incidents = repo([]);
    const reschedules = repo([]);
    const evidences = repo(overrides.evidences ?? []);
    const storage = { getAccessUrl: vi.fn().mockResolvedValue({ url: 'http://signed', expiresAt: at('2026-10-18T10:05:00Z') }) };
    const service = new DispatchDetailService(dispatches as any, events as any, incidents as any, reschedules as any, evidences as any, storage as any);
    return { service, storage, dispatches, events, incidents, reschedules, evidences };
}

describe('DispatchDetailService', () => {
    it('throws DISPATCH_NOT_FOUND when the dispatch does not exist and reads nothing else', async () => {
        const { service, events } = build({ dispatch: null });
        await expect(service.findDetail(9)).rejects.toBeInstanceOf(DispatchNotFoundException);
        expect(events.find).not.toHaveBeenCalled();
    });

    it('exposes only whitelisted metadata keys of an event', async () => {
        const { service } = build({ events: [{
            id: 1, eventType: 'status_changed', detail: null, reason: null, actorType: 'user', actorUser: { id: 3, fullName: 'Op', passwordHash: 'x' },
            createdAt: at('2026-10-18T10:00:00Z'),
            metadata: { status: 'in_transit', latitude: -16.5, longitude: -68.1, occurredAt: '2026-10-18T09:59:00.000Z', outboundRecordVersion: 7, otp: '123456' },
        }] });
        const { timeline } = await service.findDetail(5);
        expect(timeline[0]).toEqual({
            id: 1, eventType: 'status_changed', detail: null, status: 'in_transit', reason: null,
            occurredAt: '2026-10-18T09:59:00.000Z', latitude: -16.5, longitude: -68.1,
            actorType: 'user', operator: { id: 3, fullName: 'Op' },
        });
    });

    it('returns null coordinates when the event recorded none', async () => {
        const { service } = build({ events: [{ id: 1, eventType: 'created', detail: null, reason: null, actorType: 'system', actorUser: null, createdAt: at('2026-10-18T10:00:00Z'), metadata: null }] });
        const { timeline } = await service.findDetail(5);
        expect(timeline[0]).toMatchObject({ latitude: null, longitude: null, operator: null, occurredAt: '2026-10-18T10:00:00.000Z' });
    });

    it('returns a signed URL for evidence with a file, never the stored one, and none for an OTP', async () => {
        const { service, storage } = build({ evidences: [
            { id: 'a', type: 'photo', fileUrl: 'http://x/uploads/a.jpg', capturedAt: null, createdAt: at('2026-10-18T10:00:00Z'), latitude: null, longitude: null, receiverName: null, receiverDocument: null, otpCode: null },
            { id: 'b', type: 'otp', fileUrl: null, capturedAt: null, createdAt: at('2026-10-18T10:01:00Z'), latitude: null, longitude: null, receiverName: null, receiverDocument: null, otpCode: null },
        ] });
        const detail = await service.findDetail(5);
        expect(storage.getAccessUrl).toHaveBeenCalledTimes(1);
        expect(detail.evidences[0]).toMatchObject({ accessUrl: 'http://signed', accessUrlExpiresAt: '2026-10-18T10:05:00.000Z' });
        expect(detail.evidences[1]).toMatchObject({ accessUrl: null, accessUrlExpiresAt: null });
        expect(JSON.stringify(detail)).not.toContain('uploads/a.jpg');
    });

    it('answers an empty evidence list and no receiver when there is none', async () => {
        const { service } = build();
        const detail = await service.findDetail(5);
        expect(detail.evidences).toEqual([]);
        expect(detail.receiver).toBeNull();
        expect(detail.destination.latitude).toBe(-16.5);
    });

    it('takes the receiver from the signature evidence', async () => {
        const { service } = build({ evidences: [{ id: 's', type: 'signature', fileUrl: 'http://x/uploads/s.png', capturedAt: at('2026-10-18T11:00:00Z'), createdAt: at('2026-10-18T11:01:00Z'), latitude: -16.5, longitude: -68.1, receiverName: 'Ana', receiverDocument: '123' }] });
        const detail = await service.findDetail(5);
        expect(detail.receiver).toMatchObject({ id: 's', receiverName: 'Ana', capturedAt: '2026-10-18T11:00:00.000Z' });
    });
});
