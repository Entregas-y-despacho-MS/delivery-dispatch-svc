import { describe, expect, it, vi } from 'vitest';
import { RouteAssignedPushListener } from './route-assigned-push.listener.js';

describe('RouteAssignedPushListener', () => {
    it('passes the committed assignment snapshot to the push service', async () => {
        const notifications = { notify: vi.fn().mockResolvedValue(undefined) };
        const listener = new RouteAssignedPushListener(notifications as any);
        const event = {
            routeId: 18,
            driverId: 4,
            vehicleId: 7,
            dispatchIds: [31],
            dispatches: [{ dispatchId: 31, priority: 'normal' }],
            zoneName: 'Centro',
            version: 5,
        };

        await listener.handleRouteAssigned(event);

        expect(notifications.notify).toHaveBeenCalledWith(event);
    });

    it("skips the push for a reassignment's own route.assigned: notifyReassigned already covers it (ES-63)", async () => {
        const notifications = { notify: vi.fn() };
        const listener = new RouteAssignedPushListener(notifications as any);
        const event = {
            routeId: 18, driverId: 4, vehicleId: 7, dispatchIds: [31],
            dispatches: [{ dispatchId: 31, priority: 'normal' }], zoneName: 'Centro', version: 5,
            fromReassignment: true,
        };

        await listener.handleRouteAssigned(event);

        expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('passes vehicle replacements to the dedicated notification path', async () => {
        const notifications = { notify: vi.fn(), notifyVehicleChanged: vi.fn().mockResolvedValue(undefined) };
        const listener = new RouteAssignedPushListener(notifications as any);
        const event = { routeId: 18, driverId: 4, vehicleId: 7, vehiclePlate: 'ABC-123', zoneName: 'Centro', version: 6, acceptanceRevoked: true };

        await listener.handleVehicleChanged(event);

        expect(notifications.notifyVehicleChanged).toHaveBeenCalledWith(event);
        expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('passes a batch reassignment to its own notification path', async () => {
        const notifications = { notifyReassigned: vi.fn().mockResolvedValue(undefined) };
        const listener = new RouteAssignedPushListener(notifications as any);
        const event = { fromBatchId: 10, toBatchId: 20, fromDriverId: 4, toDriverId: 9, dispatchIds: [31], fromVersion: 6, toVersion: 3, zoneName: 'Centro' };

        await listener.handleBatchReassigned(event);

        expect(notifications.notifyReassigned).toHaveBeenCalledWith(event);
    });
});
