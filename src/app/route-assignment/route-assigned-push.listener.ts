import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ROUTE_ASSIGNED_EVENT, type RouteAssignedEvent } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';
import { ROUTE_VEHICLE_CHANGED_EVENT, type RouteVehicleChangedEvent } from '../../modules/dispatch/route-batches/events/route-vehicle-changed.event.js';
import { RoutePushNotificationService } from './route-push-notification.service.js';

@Injectable()
export class RouteAssignedPushListener {
    constructor(private readonly notifications: RoutePushNotificationService) {}

    @OnEvent(ROUTE_ASSIGNED_EVENT, { async: true })
    async handleRouteAssigned(event: RouteAssignedEvent): Promise<void> {
        await this.notifications.notify(event);
    }

    @OnEvent(ROUTE_VEHICLE_CHANGED_EVENT, { async: true })
    async handleVehicleChanged(event: RouteVehicleChangedEvent): Promise<void> {
        await this.notifications.notifyVehicleChanged(event);
    }
}
