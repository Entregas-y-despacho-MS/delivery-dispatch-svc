import { describe, expect, it, vi } from 'vitest';
import { DispatchEventsSocketListener } from './dispatch-events.socket-listener.js';

describe('DispatchEventsSocketListener', () => {
    it('targets permitted role, zone and driver rooms once as a union', async () => {
        const socket = { emitToRooms: vi.fn() };
        const dataSource = { query: vi.fn(async () => [{ zone_id: 12, driver_id: 45 }]) };
        const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

        const event = { dispatchId: 7, status: 'in_transit', previousStatus: 'out_for_delivery', version: 2, updatedAt: '2026-10-19T12:00:00.000Z' };
        await listener.forwardStatusChanged(event);

        expect(socket.emitToRooms).toHaveBeenCalledWith(['coordinators', 'supervisors', 'zone:12', 'driver:45'], 'dispatch.status_changed', event);
        expect(dataSource.query.mock.calls[0]?.[0]).toContain('COALESCE(d.delivery_zone_id, rb.delivery_zone_id)');
    });

    it('uses event-specific audiences and excludes drivers from zone incidents', async () => {
        const socket = { emitToRooms: vi.fn() };
        const dataSource = { query: vi.fn(async () => [{ zone_id: 12, driver_id: 45 }]) };
        const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);
        const event = { dispatchId: 7 };

        await listener.forwardIncidentReported(event);
        await listener.forwardEvidenceRegistered(event);
        await listener.forwardChangeRequiresAttention(event);

        expect(socket.emitToRooms.mock.calls).toEqual([
            [['coordinator-zone:12', 'supervisor-zone:12'], 'dispatch.incident_reported', event],
            [['coordinators', 'supervisors'], 'dispatch.evidence_registered', event],
            [['coordinators'], 'dispatch.change_requires_attention', event],
        ]);
        const incidentRooms = socket.emitToRooms.mock.calls[0]![0] as string[];
        expect(incidentRooms).not.toContain('zone:12');
        expect(incidentRooms).not.toContain('driver:45');
    });

    it('notifies coordinator and supervisor rooms for incidents without a delivery zone', async () => {
        const socket = { emitToRooms: vi.fn() };
        const dataSource = { query: vi.fn(async () => [{ zone_id: null, driver_id: null }]) };
        const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

        await listener.forwardIncidentReported({ dispatchId: 8 });

        expect(socket.emitToRooms).toHaveBeenCalledWith(
            ['coordinators', 'supervisors'], 'dispatch.incident_reported', { dispatchId: 8 },
        );
    });

    it('adds active coordinators and supervisors to a newly created zone room', async () => {
        const socket = { joinRoomMembers: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);

        await listener.joinNewZoneForActiveDispatchRoles({ deliveryZoneId: 29 });

        expect(socket.joinRoomMembers.mock.calls).toEqual([
            ['coordinators', 'coordinator-zone:29'],
            ['supervisors', 'supervisor-zone:29'],
        ]);
    });

    describe('forwardLocationUpdated (ST-60.1)', () => {
        const event = { dispatchId: 7, latitude: -17.7, longitude: -63.1, recordedAt: '2026-10-19T12:00:00.000Z' };

        it('enriches the point with routeBatchId/driverId/vehicleId and routes it only to the live board room', async () => {
            const socket = { emitToRoom: vi.fn() };
            const dataSource = { query: vi.fn(async () => [{ route_batch_id: 93, driver_id: 45, vehicle_id: 5 }]) };
            const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

            await listener.forwardLocationUpdated(event);

            expect(socket.emitToRoom).toHaveBeenCalledWith('dispatch-board', 'dispatch.location.updated', {
                ...event, driverId: 45, vehicleId: 5, routeBatchId: 93,
            });
        });

        it('does not forward when the dispatch has no assigned driver (should not happen, but no room to target)', async () => {
            const socket = { emitToRoom: vi.fn() };
            const dataSource = { query: vi.fn(async () => [{ route_batch_id: null, driver_id: null, vehicle_id: null }]) };
            const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

            await listener.forwardLocationUpdated(event);

            expect(socket.emitToRoom).not.toHaveBeenCalled();
        });

        it('emits the first point of a window immediately, independently per driver', async () => {
            const socket = { emitToRoom: vi.fn() };
            const dataSource = { query: vi.fn()
                .mockResolvedValueOnce([{ route_batch_id: 93, driver_id: 45, vehicle_id: 5 }])
                .mockResolvedValueOnce([{ route_batch_id: 94, driver_id: 46, vehicle_id: 6 }]) };
            const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

            await listener.forwardLocationUpdated(event);
            await listener.forwardLocationUpdated({ ...event, dispatchId: 8 }); // a different driver's own point

            expect(socket.emitToRoom).toHaveBeenCalledTimes(2);
            listener.onModuleDestroy();
        });

        it('queues every point that arrives inside the window and flushes only the latest one when it elapses (never the first or a middle one)', async () => {
            vi.useFakeTimers();
            try {
                const socket = { emitToRoom: vi.fn() };
                const dataSource = { query: vi.fn(async () => [{ route_batch_id: 93, driver_id: 45, vehicle_id: 5 }]) };
                const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

                await listener.forwardLocationUpdated({ ...event, latitude: -17.700 }); // t=0 — emits immediately
                expect(socket.emitToRoom).toHaveBeenCalledTimes(1);

                vi.advanceTimersByTime(500);
                await listener.forwardLocationUpdated({ ...event, latitude: -17.701 }); // t=0.5s — queued, not the one that should flush
                vi.advanceTimersByTime(500);
                await listener.forwardLocationUpdated({ ...event, latitude: -17.702 }); // t=1s — replaces the queued one
                expect(socket.emitToRoom).toHaveBeenCalledTimes(1); // still only the first point so far

                await vi.advanceTimersByTimeAsync(1000); // t=2s — the window since t=0 elapses, the pending timer fires
                expect(socket.emitToRoom).toHaveBeenCalledTimes(2);
                expect(socket.emitToRoom).toHaveBeenLastCalledWith('dispatch-board', 'dispatch.location.updated', expect.objectContaining({ latitude: -17.702 }));

                listener.onModuleDestroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it('onModuleDestroy clears a pending flush so it never fires after teardown', async () => {
            vi.useFakeTimers();
            try {
                const socket = { emitToRoom: vi.fn() };
                const dataSource = { query: vi.fn(async () => [{ route_batch_id: 93, driver_id: 45, vehicle_id: 5 }]) };
                const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

                await listener.forwardLocationUpdated(event);
                await listener.forwardLocationUpdated(event); // queued

                listener.onModuleDestroy();
                await vi.advanceTimersByTimeAsync(2000);

                expect(socket.emitToRoom).toHaveBeenCalledTimes(1); // the queued one never fired
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it('sends integration alerts only to coordinator and supervisor rooms', () => {
        const socket = { emitToRooms: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = { salesOrderId: 'SO-1', missingSource: 'inventory', attempts: 3, detectedAt: '2026-10-19T12:00:00.000Z' };

        listener.forwardOrderIncomplete(event);

        expect(socket.emitToRooms).toHaveBeenCalledWith(['coordinators', 'supervisors'], 'integration.order_incomplete', event);
    });

    it('forwards rejected-message alerts only to coordinator and supervisor rooms', () => {
        const socket = { emitToRooms: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = {
            messageId: 'message-1', type: 'inventory.shipment.ready', source: 'inventory',
            salesOrderId: 'SO-1', reasonCode: 'schema_invalid', rejectedAt: '2026-10-19T12:00:00.000Z',
        };

        listener.forwardMessageRejected(event);

        expect(socket.emitToRooms).toHaveBeenCalledWith(['coordinators', 'supervisors'], 'integration.message_rejected', event);
    });

    it('projects route assignment onto the catalog payload and targets coordinators plus assigned driver', async () => {
        const socket = { emitToRooms: vi.fn() };
        const dataSource = { query: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);
        const event = { routeId: 3, driverId: 45, vehicleId: 5, dispatchIds: [7], version: 4, zoneName: 'internal-only', dispatches: [] };

        await listener.forwardRouteAssigned(event);

        expect(socket.emitToRooms).toHaveBeenCalledWith(
            ['coordinators', 'driver:45'],
            'route.assigned',
            { routeId: 3, driverId: 45, vehicleId: 5, dispatchIds: [7], version: 4 },
        );
        expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('projects a confirmed vehicle replacement to coordinators, supervisors and the assigned driver without route.assigned', async () => {
        const socket = { emitToRooms: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = { routeId: 3, driverId: 45, vehicleId: 5, vehiclePlate: 'ABC-123', zoneName: 'Centro', version: 6, acceptanceRevoked: true };

        await listener.forwardRouteVehicleChanged(event);

        expect(socket.emitToRooms).toHaveBeenCalledWith(
            ['coordinators', 'supervisors', 'driver:45'],
            'route.vehicle_changed',
            { routeId: 3, driverId: 45, vehicleId: 5, vehiclePlate: 'ABC-123', version: 6, acceptanceRevoked: true },
        );
    });

    it('forwards an operational alert with a zone to that zone\'s coordinator/supervisor rooms only', () => {
        const socket = { emitToRooms: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = { id: 1, kind: 'gps_stale', severity: 'warning', zoneId: 2, dispatchId: null, driverId: 7, detail: {} };

        listener.forwardOperationalAlertRaised(event as never);

        expect(socket.emitToRooms).toHaveBeenCalledWith(['coordinator-zone:2', 'supervisor-zone:2'], 'operational.alert_raised', event);
    });

    it('forwards an operational alert without a zone to every coordinator/supervisor', () => {
        const socket = { emitToRooms: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = { id: 1, kind: 'driver_incidents', severity: 'warning', zoneId: null, dispatchId: null, driverId: 7, detail: {} };

        listener.forwardOperationalAlertRaised(event as never);

        expect(socket.emitToRooms).toHaveBeenCalledWith(['coordinators', 'supervisors'], 'operational.alert_raised', event);
    });

    it('joins coordinators to every active zone and drivers only to zones on their active route today', async () => {
        const socket = { joinRoom: vi.fn() };
        const dataSource = { query: vi.fn()
            .mockResolvedValueOnce([{ zone_id: 2 }, { zone_id: 5 }])
            .mockResolvedValueOnce([{ zone_id: 5 }]) };
        const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);

        await listener.joinAuthorizedZoneRooms({ socketId: 'coord-socket', userId: 10, role: 'coordinator' as never });
        await listener.joinAuthorizedZoneRooms({ socketId: 'driver-socket', userId: 77, role: 'driver' as never });

        expect(socket.joinRoom.mock.calls).toEqual([
            ['coord-socket', 'zone:2'], ['coord-socket', 'coordinator-zone:2'],
            ['coord-socket', 'zone:5'], ['coord-socket', 'coordinator-zone:5'],
            ['driver-socket', 'zone:5'],
        ]);
        expect(dataSource.query.mock.calls[1]?.[1]).toEqual([77, expect.any(String)]);
    });
});
