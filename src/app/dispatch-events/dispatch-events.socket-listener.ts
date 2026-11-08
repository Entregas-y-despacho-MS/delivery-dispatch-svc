import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SocketService } from '../../plugins/socket/socket.service.js';
import { RoleEnum } from '../../shared/enums/index.js';
import { SOCKET_CONNECTED_EVENT, type SocketConnectedEvent } from '../../plugins/socket/events/socket-connected.event.js';
import { todayInOperatingTimeZone } from '../../modules/dispatch/dispatches/utils/operating-date.util.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../dispatch-status/dispatch-status-changed.event.js';
import { ROUTE_ASSIGNED_EVENT, type RouteAssignedEvent } from '../../modules/dispatch/route-batches/events/route-assigned.event.js';
import { ROUTE_VEHICLE_CHANGED_EVENT, type RouteVehicleChangedEvent } from '../../modules/dispatch/route-batches/events/route-vehicle-changed.event.js';
import { DELIVERY_ZONE_CREATED_EVENT, type DeliveryZoneCreatedEvent } from '../../modules/catalog/delivery-zones/events/delivery-zone-created.event.js';
import { DISPATCH_LOCATION_UPDATED_EVENT, type DispatchLocationUpdatedEvent } from '../tracking/events/dispatch-location-updated.event.js';

const ROLE_ROOMS = ['coordinators', 'supervisors'];
const LOCATION_EMIT_THROTTLE_MS = 2000;

@Injectable()
export class DispatchEventsSocketListener {
    // Per-driver last emission time for 'dispatch.location.updated' (ST-60.1) — a background GPS
    // report can arrive every few seconds; the live fleet map only needs one redraw per driver
    // every LOCATION_EMIT_THROTTLE_MS, not one socket message per point. In-memory and per-instance
    // is enough here: it only throttles a redraw rate, so a missed window after a restart is harmless.
    private readonly lastLocationEmitAt = new Map<number, number>();

    constructor(
        private readonly socket: SocketService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {}

    @OnEvent(SOCKET_CONNECTED_EVENT, { async: true })
    async joinAuthorizedZoneRooms({ socketId, userId, role }: SocketConnectedEvent): Promise<void> {
        let zones: { zone_id: number | null }[] = [];
        if (role === RoleEnum.COORDINATOR || role === RoleEnum.SUPERVISOR || role === RoleEnum.ROOT) {
            zones = await this.dataSource.query(
                `SELECT delivery_zone_id AS zone_id FROM delivery_zones WHERE deleted_at IS NULL`,
            );
        } else if (role === RoleEnum.DRIVER) {
            zones = await this.dataSource.query(
                `SELECT DISTINCT COALESCE(d.delivery_zone_id, rb.delivery_zone_id) AS zone_id
                   FROM route_batches rb
                   LEFT JOIN dispatches d ON d.route_batch_id = rb.route_batch_id
                  WHERE rb.driver_id = $1 AND rb.shift_date = $2::date
                    AND rb.status IN ('confirmed', 'in_execution')`,
                [userId, todayInOperatingTimeZone()],
            );
        }
        for (const { zone_id } of zones) {
            if (zone_id === null) continue;
            this.socket.joinRoom(socketId, `zone:${zone_id}`);
            if (role === RoleEnum.COORDINATOR || role === RoleEnum.ROOT) this.socket.joinRoom(socketId, `coordinator-zone:${zone_id}`);
            if (role === RoleEnum.SUPERVISOR || role === RoleEnum.ROOT) this.socket.joinRoom(socketId, `supervisor-zone:${zone_id}`);
        }
    }

    @OnEvent(DELIVERY_ZONE_CREATED_EVENT, { async: true })
    async joinNewZoneForActiveDispatchRoles({ deliveryZoneId }: DeliveryZoneCreatedEvent): Promise<void> {
        this.socket.joinRoomMembers('coordinators', `coordinator-zone:${deliveryZoneId}`);
        this.socket.joinRoomMembers('supervisors', `supervisor-zone:${deliveryZoneId}`);
    }

    @OnEvent(DISPATCH_STATUS_CHANGED_EVENT, { async: true })
    async forwardStatusChanged(event: { dispatchId?: number }): Promise<void> {
        await this.forwardDispatchEvent(DISPATCH_STATUS_CHANGED_EVENT, event, 'roles-zone-driver');
    }
    @OnEvent('dispatch.incident_reported', { async: true })
    async forwardIncidentReported(event: { dispatchId?: number }): Promise<void> {
        await this.forwardDispatchEvent('dispatch.incident_reported', event, 'roles-zone');
    }
    @OnEvent('dispatch.evidence_registered', { async: true })
    async forwardEvidenceRegistered(event: { dispatchId?: number }): Promise<void> {
        await this.forwardDispatchEvent('dispatch.evidence_registered', event, 'roles');
    }
    @OnEvent('dispatch.change_requires_attention', { async: true })
    async forwardChangeRequiresAttention(event: { dispatchId?: number }): Promise<void> {
        await this.forwardDispatchEvent('dispatch.change_requires_attention', event, 'coordinators');
    }
    /**
     * Enriches the point with driverId/vehicleId/routeBatchId (additive, ST-60.1 — GET /fleet/live-positions
     * returns the same three ids so the live map can match a marker to this broadcast) and throttles
     * the broadcast to one per driver per LOCATION_EMIT_THROTTLE_MS. The point itself is still written
     * on every report (TrackingService.updateLocation) — only this board redraw is rate-limited.
     */
    @OnEvent(DISPATCH_LOCATION_UPDATED_EVENT, { async: true })
    async forwardLocationUpdated(event: DispatchLocationUpdatedEvent): Promise<void> {
        const [target] = await this.dataSource.query(
            `SELECT rb.route_batch_id, rb.driver_id, rb.vehicle_id
               FROM dispatches d LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE d.dispatch_id = $1`,
            [event.dispatchId],
        );
        if (!target || target.driver_id === null) return;

        const now = Date.now();
        const lastEmit = this.lastLocationEmitAt.get(target.driver_id);
        if (lastEmit !== undefined && now - lastEmit < LOCATION_EMIT_THROTTLE_MS) return;
        this.lastLocationEmitAt.set(target.driver_id, now);

        this.socket.emitToRoom('dispatch-board', DISPATCH_LOCATION_UPDATED_EVENT, {
            ...event,
            driverId:     target.driver_id,
            vehicleId:    target.vehicle_id,
            routeBatchId: target.route_batch_id,
        });
    }

    private async forwardDispatchEvent(
        eventName: string,
        event: { dispatchId?: number },
        audience: 'roles-zone-driver' | 'roles-zone' | 'roles' | 'coordinators',
    ): Promise<void> {
        if (!Number.isInteger(event?.dispatchId)) return;
        const [target] = await this.dataSource.query(
            `SELECT COALESCE(d.delivery_zone_id, rb.delivery_zone_id) AS zone_id, rb.driver_id
               FROM dispatches d LEFT JOIN route_batches rb ON rb.route_batch_id = d.route_batch_id
              WHERE d.dispatch_id = $1`,
            [event.dispatchId],
        );
        if (!target) return;
        const rooms = audience === 'roles' ? [...ROLE_ROOMS]
            : audience === 'coordinators' ? ['coordinators']
                : audience === 'roles-zone' ? [] : [...ROLE_ROOMS];
        if (audience === 'roles-zone' && target.zone_id !== null) {
            rooms.push(`coordinator-zone:${target.zone_id}`, `supervisor-zone:${target.zone_id}`);
        } else if (audience === 'roles-zone') {
            rooms.push(...ROLE_ROOMS);
        }
        if (audience === 'roles-zone-driver' && target.zone_id !== null) rooms.push(`zone:${target.zone_id}`);
        if (audience === 'roles-zone-driver' && target.driver_id !== null) rooms.push(`driver:${target.driver_id}`);
        this.socket.emitToRooms(rooms, eventName, event);
    }

    @OnEvent(ROUTE_ASSIGNED_EVENT, { async: true })
    async forwardRouteAssigned(event: RouteAssignedEvent): Promise<void> {
        const rooms = ['coordinators', `driver:${event.driverId}`];
        const payload = {
            routeId: event.routeId,
            driverId: event.driverId,
            vehicleId: event.vehicleId,
            dispatchIds: event.dispatchIds,
            version: event.version,
        };
        this.socket.emitToRooms([...new Set(rooms)], ROUTE_ASSIGNED_EVENT, payload);
    }

    @OnEvent(ROUTE_VEHICLE_CHANGED_EVENT, { async: true })
    async forwardRouteVehicleChanged(event: RouteVehicleChangedEvent): Promise<void> {
        const rooms = ['coordinators', 'supervisors'];
        if (event.driverId !== null) rooms.push(`driver:${event.driverId}`);
        this.socket.emitToRooms([...new Set(rooms)], ROUTE_VEHICLE_CHANGED_EVENT, {
            routeId: event.routeId,
            driverId: event.driverId,
            vehicleId: event.vehicleId,
            vehiclePlate: event.vehiclePlate,
            version: event.version,
            acceptanceRevoked: event.acceptanceRevoked,
        });
    }

    @OnEvent('integration.message_rejected', { async: true })
    forwardMessageRejected(event: unknown): void { this.socket.emitToRooms(ROLE_ROOMS, 'integration.message_rejected', event); }
    @OnEvent('integration.order_incomplete', { async: true })
    forwardOrderIncomplete(event: unknown): void { this.socket.emitToRooms(ROLE_ROOMS, 'integration.order_incomplete', event); }
}
