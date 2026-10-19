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

    it('routes GPS updates only to the live board room', () => {
        const socket = { emitToRoom: vi.fn() };
        const listener = new DispatchEventsSocketListener(socket as never, {} as never);
        const event = { dispatchId: 7, latitude: -17.7, longitude: -63.1, recordedAt: '2026-10-19T12:00:00.000Z' };

        listener.forwardLocationUpdated(event);

        expect(socket.emitToRoom).toHaveBeenCalledWith('dispatch-board', 'dispatch.location.updated', event);
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
