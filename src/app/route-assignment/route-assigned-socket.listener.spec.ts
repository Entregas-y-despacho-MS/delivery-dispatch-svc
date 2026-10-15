import { describe, expect, it, vi } from 'vitest';
import { ROUTE_ASSIGNED_EVENT } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';
import { DISPATCH_BOARD_ROOM } from '../tracking/services/tracking.service.js';
import { RouteAssignedSocketListener } from './route-assigned-socket.listener.js';

describe('RouteAssignedSocketListener', () => {
  it('notifies the dispatch board and the assigned driver through the socket plugin', () => {
    const socket = { emitToRoom: vi.fn(), emitToUser: vi.fn() };
    const listener = new RouteAssignedSocketListener(socket as any);
    const event = { routeId: 12, driverId: 34, vehicleId: 56, dispatchIds: [77], version: 5 };

    listener.handleRouteAssigned(event);

    expect(socket.emitToRoom).toHaveBeenCalledWith(DISPATCH_BOARD_ROOM, ROUTE_ASSIGNED_EVENT, event);
    expect(socket.emitToUser).toHaveBeenCalledWith(34, ROUTE_ASSIGNED_EVENT, event);
  });
});
