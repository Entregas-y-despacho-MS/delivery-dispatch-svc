import { Injectable, OnModuleDestroy } from '@nestjs/common';
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
import { ROUTE_BATCH_REASSIGNED_EVENT, type RouteBatchReassignedEvent } from '../../modules/dispatch/route-batches/events/route-batch-reassigned.event.js';
import { OPERATIONAL_ALERT_ACKNOWLEDGED_EVENT, OPERATIONAL_ALERT_RAISED_EVENT, type OperationalAlertRaisedEvent } from '../../modules/operational-alerts/events/operational-alert-raised.event.js';

const ROLE_ROOMS = ['coordinators', 'supervisors'];
// Leave headroom under ES-60's strict <2s marker refresh requirement.
const LOCATION_EMIT_THROTTLE_MS = 1500;

/**
 * Point time used to order points. The tracking endpoint tolerates a few minutes of device clock drift into the future,
 * and a value that is not a date must not switch the ordering off, so both are pinned to "now": a skewed clock can never
 * make every later, correct point look older than the last one.
 */
const orderingTime = (recordedAt: string): number => {
    const parsed = Date.parse(recordedAt);
    return Number.isFinite(parsed) ? Math.min(parsed, Date.now()) : Date.now();
};

type EnrichedLocationPayload = DispatchLocationUpdatedEvent & { driverId: number; vehicleId: number | null; routeBatchId: number | null };

@Injectable()
export class DispatchEventsSocketListener implements OnModuleDestroy {
    // Per-driver throttle state for 'dispatch.location.updated' (ST-60.1) — a background GPS report,
    // or a batch synced after regaining signal, can apply several points for the same driver within
    // one window; the live fleet map only needs one redraw per driver every LOCATION_EMIT_THROTTLE_MS,
    // but that redraw must always be the LATEST known point, never the first one of the burst (a
    // leading-edge-only throttle would strand the board on a stale position until the next report).
    // Trailing-edge: the first point of a window emits immediately; every point that arrives before
    // the window elapses replaces the pending one, which flushes when the window is up. In-memory and
    // per-instance is enough here — it only throttles a redraw rate, a missed window after a restart
    // is harmless.
    private readonly lastLocationEmitAt = new Map<number, number>();
    private readonly lastLocationRecordedAt = new Map<number, number>();
    private readonly pendingLocation = new Map<number, { payload: EnrichedLocationPayload; timer: NodeJS.Timeout }>();

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
     * ES-66, Escenario 1: `OperationalAlertsService.raise()` already resolved the subject's zone, so
     * no DB lookup is needed here (unlike `forwardDispatchEvent`) — straight to its rooms, or every
     * coordinator/supervisor when the alert has no zone (e.g. a driver with no assigned zone).
     */
    @OnEvent(OPERATIONAL_ALERT_RAISED_EVENT, { async: true })
    forwardOperationalAlertRaised(event: OperationalAlertRaisedEvent): void {
        const rooms = event.zoneId === null ? [...ROLE_ROOMS] : [`coordinator-zone:${event.zoneId}`, `supervisor-zone:${event.zoneId}`];
        this.socket.emitToRooms(rooms, OPERATIONAL_ALERT_RAISED_EVENT, event);
    }

    @OnEvent(OPERATIONAL_ALERT_ACKNOWLEDGED_EVENT, { async: true })
    forwardOperationalAlertAcknowledged(event: OperationalAlertRaisedEvent & { acknowledgedBy: number; acknowledgedAt: Date | string }): void {
        const rooms = event.zoneId === null ? [...ROLE_ROOMS] : [`coordinator-zone:${event.zoneId}`, `supervisor-zone:${event.zoneId}`];
        this.socket.emitToRooms(rooms, OPERATIONAL_ALERT_ACKNOWLEDGED_EVENT, event);
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

        const driverId = target.driver_id as number;
        const payload: EnrichedLocationPayload = {
            ...event,
            driverId,
            vehicleId:    target.vehicle_id,
            routeBatchId: target.route_batch_id,
        };

        // The lookup above is async, so two points of one driver can get here in the opposite order they were
        // reported. A point older than the one already on the board is dropped: the map must never step back.
        const recordedAt = orderingTime(event.recordedAt);
        const lastRecorded = this.lastLocationRecordedAt.get(driverId);
        if (lastRecorded !== undefined && recordedAt < lastRecorded) return;

        const lastEmit = this.lastLocationEmitAt.get(driverId);
        const elapsed = lastEmit === undefined ? Infinity : Date.now() - lastEmit;
        if (elapsed >= LOCATION_EMIT_THROTTLE_MS) {
            // The window is open: this point goes out now and supersedes whatever was waiting. If a late timer
            // were left alive it would emit the older point right after this one and the map would step back.
            const stale = this.pendingLocation.get(driverId);
            if (stale) {
                clearTimeout(stale.timer);
                this.pendingLocation.delete(driverId);
            }
            this.emitLocation(driverId, payload);
            return;
        }

        // Already something pending for this driver inside the window: this newer point replaces it —
        // the timer already running will flush it, no new timer needed.
        const pending = this.pendingLocation.get(driverId);
        if (pending) {
            // Never replace a newer pending point with an older one.
            if (!(recordedAt < orderingTime(pending.payload.recordedAt))) pending.payload = payload;
            return;
        }
        const timer = setTimeout(() => {
            const flushed = this.pendingLocation.get(driverId);
            this.pendingLocation.delete(driverId);
            if (flushed) this.emitLocation(driverId, flushed.payload);
        }, LOCATION_EMIT_THROTTLE_MS - elapsed);
        this.pendingLocation.set(driverId, { payload, timer });
    }

    private emitLocation(driverId: number, payload: EnrichedLocationPayload): void {
        this.lastLocationEmitAt.set(driverId, Date.now());
        this.lastLocationRecordedAt.set(driverId, orderingTime(payload.recordedAt));
        this.socket.emitToRoom('dispatch-board', DISPATCH_LOCATION_UPDATED_EVENT, payload);
    }

    /** Pending trailing-edge timers must not outlive the instance (test teardown, hot reload, shutdown). */
    onModuleDestroy(): void {
        for (const { timer } of this.pendingLocation.values()) clearTimeout(timer);
        this.pendingLocation.clear();
        this.lastLocationEmitAt.clear();
        this.lastLocationRecordedAt.clear();
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

    /** ES-63 — notifies the board and both drivers that stops moved between two in_execution route batches. */
    @OnEvent(ROUTE_BATCH_REASSIGNED_EVENT, { async: true })
    forwardBatchReassigned(event: RouteBatchReassignedEvent): void {
        const rooms = [...ROLE_ROOMS, `driver:${event.fromDriverId}`, `driver:${event.toDriverId}`];
        this.socket.emitToRooms([...new Set(rooms)], ROUTE_BATCH_REASSIGNED_EVENT, event);
    }

    @OnEvent('integration.message_rejected', { async: true })
    forwardMessageRejected(event: unknown): void { this.socket.emitToRooms(ROLE_ROOMS, 'integration.message_rejected', event); }
    @OnEvent('integration.order_incomplete', { async: true })
    forwardOrderIncomplete(event: unknown): void { this.socket.emitToRooms(ROLE_ROOMS, 'integration.order_incomplete', event); }
}
