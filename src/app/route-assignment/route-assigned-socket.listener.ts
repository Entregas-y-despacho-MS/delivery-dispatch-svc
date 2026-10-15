import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketService } from '../../plugins/socket/socket.service.js';
import { DISPATCH_BOARD_ROOM } from '../tracking/services/tracking.service.js';
import { ROUTE_ASSIGNED_EVENT, type RouteAssignedEvent } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';

@Injectable()
export class RouteAssignedSocketListener {
  constructor(private readonly socket: SocketService) {}

  @OnEvent(ROUTE_ASSIGNED_EVENT, { async: true })
  handleRouteAssigned(event: RouteAssignedEvent): void {
    this.socket.emitToRoom(DISPATCH_BOARD_ROOM, ROUTE_ASSIGNED_EVENT, event);
    this.socket.emitToUser(event.driverId, ROUTE_ASSIGNED_EVENT, event);
  }
}
