import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { MessageValidator } from '../../../../plugins/messaging/envelope/message-validator.js';
import { PickupSchedulingService } from './pickup-scheduling.service.js';
import {
    DispatchNotSchedulableException,
    PickupCapacityExceededException,
    PickupWindowNotAvailableException,
    PickupWindowsDoNotIntersectException,
    SupplierPickupIncompleteException,
} from '../exceptions/index.js';

const NOW = new Date('2026-10-19T00:00:00Z');

// Local La Paz is UTC-4: reception 08:00-12:00 is 12:00Z-16:00Z.
const pickupRow = (overrides: Record<string, unknown> = {}) => ({
    dispatch_id: 7,
    type: 'supplier_pickup',
    status: 'pending',
    source_order_ref: 'PO-2026-000087',
    delivery_address: 'Av. Industrial 123',
    destination_warehouse_id: 1,
    warehouse_id: 1,
    scheduled_window_start: new Date('2026-10-20T13:00:00Z'),
    scheduled_window_end: new Date('2026-10-20T20:00:00Z'),
    estimated_weight_kg: '400.00',
    estimated_volume_m3: '3.000',
    tracking_code: null,
    reception_start_time: '08:00:00',
    reception_end_time: '12:00:00',
    ...overrides,
});

interface Setup {
    row?: Record<string, unknown> | null;
    vehicle?: { capacity_kg: string; capacity_m3: string } | null;
    previousVersions?: number[];
}

function build({ row = pickupRow(), vehicle = { capacity_kg: '1000', capacity_m3: '8' }, previousVersions = [] }: Setup = {}) {
    const saved: Record<string, unknown>[] = [];
    const updates: unknown[][] = [];
    const manager = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
            if (sql.includes('FOR UPDATE OF d')) return row ? [row] : [];
            if (sql.includes('FROM vehicles')) return vehicle ? [vehicle] : [];
            if (sql.includes('FROM dispatch_events')) return previousVersions.map((v) => ({ version: String(v) }));
            if (sql.includes('UPDATE dispatches')) {
                updates.push(params);
                return [{ tracking_code: 'DSP-2026-00051' }];
            }
            throw new Error(`unexpected query: ${sql}`);
        }),
        getRepository: vi.fn(() => ({
            create: (value: Record<string, unknown>) => value,
            save: async (value: Record<string, unknown>) => {
                saved.push(value);
                return value;
            },
        })),
    };
    const dataSource = { transaction: async (cb: (m: unknown) => unknown) => await cb(manager) };
    const settings = { getString: vi.fn(async (_key: string, fallback: string) => fallback) };
    const outbox = { enqueue: vi.fn(async () => true) };
    const service = new PickupSchedulingService(dataSource as never, settings as never, outbox as never);
    return { service, manager, saved, updates, outbox, settings };
}

describe('PickupSchedulingService.schedule', () => {
    it('schedules inside the intersection, keeps the supplier window in the event and queues the message', async () => {
        const { service, saved, updates, outbox } = build();

        const result = await service.schedule(7, { vehicleId: 3 }, 9, NOW);

        // Supplier 13:00Z-20:00Z ∩ reception 12:00Z-16:00Z = 13:00Z-16:00Z.
        expect(result).toEqual({
            id: 7,
            status: 'scheduled',
            trackingCode: 'DSP-2026-00051',
            recordVersion: 1,
            pickupWindow: { startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T16:00:00.000Z' },
        });
        expect(updates[0]).toEqual([
            'scheduled',
            new Date('2026-10-20T13:00:00.000Z'),
            new Date('2026-10-20T16:00:00.000Z'),
            7,
        ]);
        expect(saved[0]).toMatchObject({
            eventType: 'pickup_scheduled',
            actorUserId: 9,
            metadata: {
                recordVersion: 1,
                purchaseOrderId: 'PO-2026-000087',
                vehicleId: 3,
                supplierWindow: { startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T20:00:00.000Z' },
            },
        });
        const [envelope, options] = outbox.enqueue.mock.calls[0] as unknown as [
            { type: string; source: string; data: Record<string, unknown> },
            { manager: unknown },
        ];
        expect(envelope).toMatchObject({
            type: 'dispatch.pickup.scheduled',
            source: 'dispatch',
            data: {
                purchaseOrderId: 'PO-2026-000087',
                trackingCode: 'DSP-2026-00051',
                recordVersion: 1,
                pickupWindow: { startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T16:00:00.000Z' },
            },
        });
        expect(options.manager).toBeDefined();
    });

    it('uses the slot the coordinator asks for when it is inside the intersection', async () => {
        const { service } = build();
        const window = { startsAt: new Date('2026-10-20T14:00:00Z'), endsAt: new Date('2026-10-20T15:00:00Z') };

        const result = await service.schedule(7, { vehicleId: 3, window }, 9, NOW);

        expect(result.pickupWindow).toEqual({ startsAt: '2026-10-20T14:00:00.000Z', endsAt: '2026-10-20T15:00:00.000Z' });
    });

    it('rejects a requested slot outside the intersection', async () => {
        const { service, outbox } = build();
        const window = { startsAt: new Date('2026-10-20T17:00:00Z'), endsAt: new Date('2026-10-20T18:00:00Z') };

        await expect(service.schedule(7, { vehicleId: 3, window }, 9, NOW)).rejects.toBeInstanceOf(
            PickupWindowNotAvailableException,
        );
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 when the supplier window and the warehouse hours do not intersect', async () => {
        const { service, updates, outbox } = build({
            row: pickupRow({
                scheduled_window_start: new Date('2026-10-20T17:00:00Z'),
                scheduled_window_end: new Date('2026-10-20T21:00:00Z'),
            }),
        });

        await expect(service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            PickupWindowsDoNotIntersectException,
        );
        expect(updates).toHaveLength(0);
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 when the only common time is already in the past', async () => {
        const { service } = build();

        await expect(service.schedule(7, { vehicleId: 3 }, 9, new Date('2026-10-21T00:00:00Z'))).rejects.toBeInstanceOf(
            PickupWindowsDoNotIntersectException,
        );
    });

    it('falls back to the general delivery window of ES-57 when the warehouse defines no hours', async () => {
        const { service, settings } = build({
            row: pickupRow({ reception_start_time: null, reception_end_time: null }),
        });

        const result = await service.schedule(7, { vehicleId: 3 }, 9, NOW);

        expect(settings.getString).toHaveBeenCalledWith('delivery_window_start', '08:00');
        expect(settings.getString).toHaveBeenCalledWith('delivery_window_end', '20:00');
        // 08:00-20:00 local = 12:00Z-00:00Z; the supplier window 13:00Z-20:00Z fits entirely.
        expect(result.pickupWindow).toEqual({ startsAt: '2026-10-20T13:00:00.000Z', endsAt: '2026-10-20T20:00:00.000Z' });
    });

    it('answers 409 when the estimated weight exceeds the vehicle capacity', async () => {
        const { service, outbox } = build({ vehicle: { capacity_kg: '300', capacity_m3: '8' } });

        await expect(service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            PickupCapacityExceededException,
        );
        expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('answers 409 when the estimated volume exceeds the vehicle capacity', async () => {
        const { service } = build({ vehicle: { capacity_kg: '1000', capacity_m3: '2' } });

        await expect(service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            PickupCapacityExceededException,
        );
    });

    it('answers 409 listing what is missing when the request is incomplete', async () => {
        const { service } = build({
            row: pickupRow({ delivery_address: ' ', warehouse_id: null, scheduled_window_start: null }),
        });

        const error = await service.schedule(7, { vehicleId: 3 }, 9, NOW).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SupplierPickupIncompleteException);
        expect((error as SupplierPickupIncompleteException).message).toContain('pickup address');
        expect((error as SupplierPickupIncompleteException).message).toContain('destination warehouse');
        expect((error as SupplierPickupIncompleteException).message).toContain('supplier schedule');
    });

    it('treats a dispatch in address_review as incomplete', async () => {
        const { service } = build({ row: pickupRow({ status: 'address_review' }) });

        await expect(service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            SupplierPickupIncompleteException,
        );
    });

    it('rejects a dispatch that is not a supplier pickup or is already scheduled', async () => {
        const delivery = build({ row: pickupRow({ type: 'delivery' }) });
        await expect(delivery.service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            DispatchNotSchedulableException,
        );
        const scheduled = build({ row: pickupRow({ status: 'scheduled' }) });
        await expect(scheduled.service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(
            DispatchNotSchedulableException,
        );
    });

    it('answers 404 when the dispatch or the vehicle does not exist', async () => {
        const noDispatch = build({ row: null });
        await expect(noDispatch.service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(NotFoundException);
        const noVehicle = build({ vehicle: null });
        await expect(noVehicle.service.schedule(7, { vehicleId: 3 }, 9, NOW)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('publishes the next recordVersion when the pickup was already published before', async () => {
        const { service } = build({ previousVersions: [1, 2] });

        const result = await service.schedule(7, { vehicleId: 3 }, 9, NOW);

        expect(result.recordVersion).toBe(3);
    });

    it('publishes a message that complies with the dispatch.pickup.scheduled contract', async () => {
        const { service, outbox } = build();
        await service.schedule(7, { vehicleId: 3 }, 9, NOW);

        const [envelope] = outbox.enqueue.mock.calls[0] as unknown as [{ type: string }];
        const validator = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));

        expect(validator.validate('dispatch.pickup.scheduled', envelope)).toMatchObject({ valid: true });
    });

    it('keeps the tracking code the dispatch already had (only fills it when it is null)', async () => {
        const { service, manager } = build({ row: pickupRow({ tracking_code: 'DSP-2026-00010' }) });

        await service.schedule(7, { vehicleId: 3 }, 9, NOW);

        const updateSql = (manager.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches')) ?? [''])[0];
        expect(updateSql).toContain('COALESCE(tracking_code, next_tracking_code())');
    });
});
