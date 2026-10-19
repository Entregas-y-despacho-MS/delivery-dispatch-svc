import { describe, expect, it, vi } from 'vitest';
import { DispatchKanbanService } from './dispatch-kanban.service.js';

describe('DispatchKanbanService', () => {
    it('returns complete stable catalogs and restricts drivers to active, non-deleted users', async () => {
        const query = vi.fn()
            .mockResolvedValueOnce([{ id: 4, fullName: 'Ana Driver' }, { id: 8, fullName: 'Zoe Driver' }])
            .mockResolvedValueOnce([{ id: 2, name: 'delivery' }, { id: 5, name: 'warehouse_return_pickup' }]);
        const service = new DispatchKanbanService({ query } as never);

        await expect(service.findFilters()).resolves.toEqual({
            drivers: [{ id: 4, fullName: 'Ana Driver' }, { id: 8, fullName: 'Zoe Driver' }],
            dispatchTypes: [{ id: 2, name: 'delivery' }, { id: 5, name: 'warehouse_return_pickup' }],
        });
        expect(query).toHaveBeenCalledTimes(2);
        expect(query.mock.calls[0][0]).toContain("r.name = 'driver' AND u.active = TRUE AND u.deleted_at IS NULL");
        expect(query.mock.calls[0][0]).toContain('ORDER BY u.full_name ASC, u.user_id ASC');
        expect(query.mock.calls[1][0]).toContain('FROM dispatch_types');
        expect(query.mock.calls[1][0]).toContain('ORDER BY name ASC, dispatch_type_id ASC');
    });

    it('groups statuses, computes volume totals and hides expired reservation details', async () => {
        const query = vi.fn(async () => [
            {
                id: 1, source_order_ref: 'SO-1', tracking_code: null, status: 'pending',
                dispatch_type_id: 2, dispatch_type_name: 'delivery', zone_id: 3, zone_name: 'Centro',
                driver_id: null, driver_name: null, vehicle_id: null, vehicle_plate: null,
                window_start: null, window_end: null, priority: 'normal', volume_m3: '1.25',
                attempt_count: '0', attempt_limit: '3', route_batch_id: null, route_batch_status: null,
                reserved_by: null, reserved_by_name: null, reservation_expires_at: null,
            },
            {
                id: 2, source_order_ref: 'SO-2', tracking_code: 'TR-2', status: 'not_delivered',
                dispatch_type_id: 2, dispatch_type_name: 'delivery', zone_id: 3, zone_name: 'Centro',
                driver_id: 9, driver_name: 'Driver', vehicle_id: 5, vehicle_plate: 'ABC-123',
                window_start: null, window_end: null, priority: 'urgent', volume_m3: '0.75',
                attempt_count: '1', attempt_limit: '3', route_batch_id: 7, route_batch_status: 'confirmed',
                reserved_by: 42, reserved_by_name: 'Other coordinator', reservation_expires_at: new Date('2026-10-19T12:00:00Z'),
            },
        ]);
        const service = new DispatchKanbanService({ query } as never);

        const result = await service.findAll({ date: '2026-10-19', delivery_zone_id: 3, driver_id: 9, dispatch_type_id: 2 }, 100);

        expect(query).toHaveBeenCalledWith(expect.stringContaining("s.name <> 'cancelled'"), ['2026-10-19', 3, 9, 2]);
        expect(result.columns).toHaveLength(13);
        expect(result.columns.find((column) => column.key === 'pending')).toMatchObject({ ordersCount: 1, volumeM3: 1.25 });
        expect(result.columns.find((column) => column.key === 'incident')).toMatchObject({ ordersCount: 1, volumeM3: 0.75 });
        expect(result.columns.find((column) => column.key === 'incident')?.dispatches[0]).toMatchObject({
            status: 'not_delivered', attemptCount: 1, attemptLimit: 3, inbox: 'reserved',
            reservation: { reservedByMe: false },
        });
    });
});
