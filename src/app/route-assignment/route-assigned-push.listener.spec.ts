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

    it('passes vehicle replacements to the dedicated notification path', async () => {
        const notifications = { notify: vi.fn(), notifyVehicleChanged: vi.fn().mockResolvedValue(undefined) };
        const listener = new RouteAssignedPushListener(notifications as any);
        const event = { routeId: 18, driverId: 4, vehicleId: 7, vehiclePlate: 'ABC-123', zoneName: 'Centro', version: 6, acceptanceRevoked: true };

        await listener.handleVehicleChanged(event);

        expect(notifications.notifyVehicleChanged).toHaveBeenCalledWith(event);
        expect(notifications.notify).not.toHaveBeenCalled();
    });
});
