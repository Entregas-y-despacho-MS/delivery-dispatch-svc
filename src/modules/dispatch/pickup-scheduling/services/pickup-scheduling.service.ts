import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { buildEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { generateMessageId } from '../../../../plugins/messaging/envelope/uuid-v7.js';
import { OutboxService } from '../../../messaging/outbound-messages/services/outbox.service.js';
import { SettingsService } from '../../../settings/services/settings.service.js';
import { VehicleNotFoundException } from '../../../fleet/vehicles/exceptions/index.js';
import { IncidentReasonNotFoundException } from '../../../catalog/incident-reasons/exceptions/index.js';
import { RescheduleReasonNotFoundException } from '../../../catalog/reschedule-reasons/exceptions/index.js';
import { DispatchNotFoundException } from '../../dispatches/exceptions/index.js';
import { DispatchStatusEnum } from '../../../../shared/enums/index.js';
import { checkPickupCapacity } from '../domain/pickup-capacity.js';
import { nextPickupRecordVersion } from '../domain/pickup-record-version.js';
import {
    intersectPickupWindows,
    isWithinAnySlot,
    isWithinRescheduleLimit,
    type TimeRange,
} from '../domain/pickup-window.js';
import {
    DispatchNotSchedulableException,
    PickupCapacityExceededException,
    PickupRescheduleOutOfRangeException,
    PickupWindowNotAvailableException,
    PickupWindowsDoNotIntersectException,
    SupplierPickupIncompleteException,
} from '../exceptions/index.js';
import type { PickupRescheduleDto, PickupScheduleDto } from '../dto/pickup-schedule.dto.js';

export const PICKUP_SCHEDULED_EVENT = 'pickup_scheduled';
export const PICKUP_RESCHEDULED_EVENT = 'pickup_rescheduled';
export const PICKUP_SCHEDULED_TOPIC = 'dispatch.pickup.scheduled';
export const INCIDENT_REPORTED_TOPIC = 'dispatch.transfer.incident_reported';
const SUPPLIER_PICKUP_TYPE = 'supplier_pickup';

export interface SchedulePickupInput {
    /** Vehicle whose capacity the estimated load is compared with. */
    vehicleId: number;
    /** Slot to agree; when omitted, the earliest slot still ahead is taken. */
    window?: TimeRange;
}

export interface ReschedulePickupInput {
    /** Catalog reason of the incident (the supplier did not have the load ready). */
    incidentReasonId: number;
    /** Catalog reason of the reprogramming. */
    rescheduleReasonId: number;
    /** New slot to agree; it must fall inside the warehouse reception hours. */
    window: TimeRange;
    description?: string | null;
}

interface PickupRow {
    dispatch_id: number;
    type: string;
    status: string;
    source_order_ref: string;
    delivery_address: string | null;
    destination_warehouse_id: number | null;
    warehouse_id: number | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    estimated_weight_kg: string | null;
    estimated_volume_m3: string | null;
    tracking_code: string | null;
    reception_start_time: string | null;
    reception_end_time: string | null;
}

@Injectable()
export class PickupSchedulingService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly settings: SettingsService,
        private readonly outbox: OutboxService,
    ) {}

    /**
     * Schedules a supplier pickup (ERP-04, ST-75.1). One transaction: the dispatch row is locked, so a
     * repeated or concurrent request finds it already `scheduled` and answers 409 instead of publishing twice.
     * The agreed slot overwrites `scheduled_window_*`; the supplier's own window is kept in the event.
     * The `dispatch.pickup.scheduled` message goes to the outbox in the same transaction (D-54).
     */
    async schedule(
        dispatchId: number,
        input: SchedulePickupInput,
        actorUserId: number,
        now: Date = new Date(),
    ): Promise<PickupScheduleDto> {
        return await this.dataSource.transaction(async (manager) => {
            const row = await this.lockPickup(manager, dispatchId);
            this.assertSchedulable(row);

            const supplier = this.supplierWindow(row);
            const slots = await this.availableSlots(row, supplier, now);
            if (slots.length === 0) throw new PickupWindowsDoNotIntersectException();
            if (input.window && !isWithinAnySlot(input.window, slots)) throw new PickupWindowNotAvailableException();
            const window = input.window ?? slots[0];

            await this.assertCapacity(manager, row, input.vehicleId);

            const recordVersion = await this.nextRecordVersion(manager, dispatchId);
            const [updated]: { tracking_code: string }[] = await manager.query(
                // The CTE makes the driver return plain rows: a bare UPDATE ... RETURNING comes back as [rows, count].
                `WITH moved AS (
                    UPDATE dispatches
                       SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                           scheduled_window_start = $2,
                           scheduled_window_end = $3,
                           tracking_code = COALESCE(tracking_code, next_tracking_code()),
                           updated_at = NOW()
                     WHERE dispatch_id = $4
                 RETURNING tracking_code
                 ) SELECT tracking_code FROM moved`,
                [DispatchStatusEnum.SCHEDULED, window.startsAt, window.endsAt, dispatchId],
            );

            const pickupWindow = { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() };
            await this.recordEvent(manager, {
                dispatchId,
                eventType: PICKUP_SCHEDULED_EVENT,
                detail:    `Pickup scheduled from ${pickupWindow.startsAt} to ${pickupWindow.endsAt}.`,
                actorUserId,
                reason:    null,
                metadata:  {
                    recordVersion,
                    fromStatus: row.status,
                    toStatus: DispatchStatusEnum.SCHEDULED,
                    purchaseOrderId: row.source_order_ref,
                    vehicleId: input.vehicleId,
                    supplierWindow: {
                        startsAt: supplier.startsAt.toISOString(),
                        endsAt: supplier.endsAt.toISOString(),
                    },
                    pickupWindow,
                },
            });

            await this.publishPickupScheduled(manager, {
                purchaseOrderId: row.source_order_ref,
                trackingCode: updated.tracking_code,
                recordVersion,
                pickupWindow,
            });

            return {
                id: dispatchId,
                status: DispatchStatusEnum.SCHEDULED,
                trackingCode: updated.tracking_code,
                recordVersion,
                pickupWindow,
            };
        });
    }

    /**
     * Reschedules a scheduled pickup because the supplier did not have the load ready (ERP-04, Escenario 2).
     * One transaction: records the incident and the `dispatch_reschedules` row (coordinator), moves the
     * agreed slot, and queues `dispatch.transfer.incident_reported` plus a new `dispatch.pickup.scheduled`,
     * both with the next `recordVersion`. The dispatch stays `scheduled` (D-47).
     * The new slot must fall inside the warehouse reception hours and start within `reschedule_window_days`
     * (ES-57) after the current one.
     */
    async reschedule(
        dispatchId: number,
        input: ReschedulePickupInput,
        actorUserId: number,
        now: Date = new Date(),
    ): Promise<PickupRescheduleDto> {
        return await this.dataSource.transaction(async (manager) => {
            const row = await this.lockPickup(manager, dispatchId);
            if (row.type !== SUPPLIER_PICKUP_TYPE) {
                throw new DispatchNotSchedulableException(
                    `Only supplier pickups can be rescheduled (this dispatch is ${row.type}).`,
                );
            }
            if (row.status !== DispatchStatusEnum.SCHEDULED || row.scheduled_window_start === null || row.scheduled_window_end === null) {
                throw new DispatchNotSchedulableException(
                    `A supplier pickup can only be rescheduled while it is scheduled (current status: ${row.status}).`,
                );
            }

            const incidentReason = await this.findActiveReason(manager, 'incident_reasons', 'incident_reason_id', input.incidentReasonId);
            if (!incidentReason) throw new IncidentReasonNotFoundException();
            const rescheduleReason = await this.findActiveReason(manager, 'reschedule_reasons', 'reschedule_reason_id', input.rescheduleReasonId);
            if (!rescheduleReason) throw new RescheduleReasonNotFoundException();

            const { window } = input;
            const reception = await this.receptionHours(row);
            const slots = intersectPickupWindows(window, reception);
            const insideReception =
                slots.length === 1 &&
                slots[0].startsAt.getTime() === window.startsAt.getTime() &&
                slots[0].endsAt.getTime() === window.endsAt.getTime();
            if (!insideReception || window.startsAt.getTime() < now.getTime()) throw new PickupWindowNotAvailableException();

            const maxDays = await this.settings.getNumber('reschedule_window_days', 2);
            const previous = { startsAt: new Date(row.scheduled_window_start), endsAt: new Date(row.scheduled_window_end) };
            if (!isWithinRescheduleLimit(previous.startsAt, window.startsAt, maxDays)) {
                throw new PickupRescheduleOutOfRangeException(maxDays);
            }

            const recordVersion = await this.nextRecordVersion(manager, dispatchId);
            const incidentId = generateMessageId();
            await manager.query(
                `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description)
                 VALUES ($1, $2, $3, $4)`,
                [incidentId, dispatchId, input.incidentReasonId, input.description ?? null],
            );
            await manager.query(
                `INSERT INTO dispatch_reschedules (
                        dispatch_id, reschedule_reason_id, rescheduled_by, rescheduled_by_type,
                        previous_window_start, previous_window_end, new_window_start, new_window_end)
                 VALUES ($1, $2, $3, 'coordinator', $4, $5, $6, $7)`,
                [dispatchId, input.rescheduleReasonId, actorUserId, previous.startsAt, previous.endsAt, window.startsAt, window.endsAt],
            );
            const [updated]: { tracking_code: string }[] = await manager.query(
                `WITH moved AS (
                    UPDATE dispatches
                       SET scheduled_window_start = $1,
                           scheduled_window_end = $2,
                           tracking_code = COALESCE(tracking_code, next_tracking_code()),
                           updated_at = NOW()
                     WHERE dispatch_id = $3
                 RETURNING tracking_code
                 ) SELECT tracking_code FROM moved`,
                [window.startsAt, window.endsAt, dispatchId],
            );

            const pickupWindow = { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() };
            const previousWindow = { startsAt: previous.startsAt.toISOString(), endsAt: previous.endsAt.toISOString() };
            await this.recordEvent(manager, {
                dispatchId,
                eventType: PICKUP_RESCHEDULED_EVENT,
                detail:    `Pickup rescheduled from ${previousWindow.startsAt} to ${pickupWindow.startsAt}: supplier unavailable.`,
                actorUserId,
                reason:    input.description ?? null,
                metadata:  {
                    recordVersion,
                    purchaseOrderId: row.source_order_ref,
                    incidentId,
                    incidentReasonId: input.incidentReasonId,
                    rescheduleReasonId: input.rescheduleReasonId,
                    previousWindow,
                    pickupWindow,
                },
            });

            const occurredAt = new Date();
            const base = {
                purchaseOrderId: row.source_order_ref,
                trackingCode: updated.tracking_code,
                recordVersion,
                updatedAt: occurredAt.toISOString(),
            };
            await this.outbox.enqueue(
                buildEnvelope({
                    type: INCIDENT_REPORTED_TOPIC,
                    source: 'dispatch',
                    occurredAt,
                    data: {
                        ...base,
                        incidentId,
                        reasonCode: incidentReason.code,
                        reportedAt: occurredAt.toISOString(),
                        nextStep: 'reschedule',
                        rescheduledWindow: pickupWindow,
                    },
                }),
                { manager },
            );
            await this.publishPickupScheduled(manager, {
                purchaseOrderId: row.source_order_ref,
                trackingCode: updated.tracking_code,
                recordVersion,
                pickupWindow,
            });

            return {
                id: dispatchId,
                status: DispatchStatusEnum.SCHEDULED,
                trackingCode: updated.tracking_code,
                recordVersion,
                incidentId,
                pickupWindow,
                previousWindow,
            };
        });
    }

    /** Appends to the dispatch's event log; the log is append-only, so this is always an INSERT. */
    private async recordEvent(
        manager: EntityManager,
        event: {
            dispatchId: number;
            eventType: string;
            detail: string;
            actorUserId: number;
            reason: string | null;
            metadata: Record<string, unknown>;
        },
    ): Promise<void> {
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, detail, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, $2, $3, $4, 'user', $5, $6::jsonb)`,
            [event.dispatchId, event.eventType, event.detail, event.actorUserId, event.reason, JSON.stringify(event.metadata)],
        );
    }

    private async findActiveReason(
        manager: EntityManager,
        table: 'incident_reasons' | 'reschedule_reasons',
        idColumn: 'incident_reason_id' | 'reschedule_reason_id',
        id: number,
    ): Promise<{ code: string } | null> {
        const [reason]: { code: string }[] = await manager.query(
            `SELECT code FROM ${table} WHERE ${idColumn} = $1 AND active = TRUE AND deleted_at IS NULL`,
            [id],
        );
        return reason ?? null;
    }

    /** Locks the dispatch and joins what the checks need; 404 if it does not exist. */
    protected async lockPickup(manager: EntityManager, dispatchId: number): Promise<PickupRow> {
        const [row]: PickupRow[] = await manager.query(
            `SELECT d.dispatch_id, t.name AS type, s.name AS status, d.source_order_ref, d.delivery_address,
                    d.destination_warehouse_id, w.warehouse_id,
                    d.scheduled_window_start, d.scheduled_window_end,
                    d.estimated_weight_kg, d.estimated_volume_m3, d.tracking_code,
                    w.reception_start_time, w.reception_end_time
               FROM dispatches d
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
          LEFT JOIN warehouses w ON w.warehouse_id = d.destination_warehouse_id AND w.deleted_at IS NULL
              WHERE d.dispatch_id = $1
                FOR UPDATE OF d`,
            [dispatchId],
        );
        if (!row) throw new DispatchNotFoundException();
        return row;
    }

    /** Type and status gate, then the completeness of origin, destination and schedule. */
    private assertSchedulable(row: PickupRow): void {
        if (row.type !== SUPPLIER_PICKUP_TYPE) {
            throw new DispatchNotSchedulableException(
                `Only supplier pickups can be scheduled (this dispatch is ${row.type}).`,
            );
        }
        const reviewing = row.status === DispatchStatusEnum.ADDRESS_REVIEW;
        if (row.status !== DispatchStatusEnum.PENDING && !reviewing) {
            throw new DispatchNotSchedulableException(
                `A supplier pickup can only be scheduled while it is pending (current status: ${row.status}).`,
            );
        }

        const missing: string[] = [];
        if (!row.delivery_address?.trim()) missing.push('pickup address (origin)');
        if (row.destination_warehouse_id === null || row.warehouse_id === null) missing.push('destination warehouse');
        if (row.scheduled_window_start === null || row.scheduled_window_end === null) missing.push('supplier schedule');
        if (reviewing && missing.length === 0) missing.push('the review of the request (address_review)');
        if (missing.length > 0) throw new SupplierPickupIncompleteException(missing);
    }

    private supplierWindow(row: PickupRow): TimeRange {
        return { startsAt: new Date(row.scheduled_window_start!), endsAt: new Date(row.scheduled_window_end!) };
    }

    /** Supplier window ∩ warehouse reception hours (general delivery window when the catalog has none), still ahead of `now`. */
    protected async availableSlots(row: PickupRow, supplier: TimeRange, now: Date): Promise<TimeRange[]> {
        const reception = await this.receptionHours(row);
        return intersectPickupWindows(supplier, reception)
            .filter((slot) => slot.endsAt.getTime() > now.getTime())
            .map((slot) => (slot.startsAt.getTime() < now.getTime() ? { startsAt: now, endsAt: slot.endsAt } : slot));
    }

    /** Daily reception hours of the destination warehouse; the general delivery window of ES-57 when the catalog has none. */
    private async receptionHours(row: PickupRow): Promise<{ start: string; end: string }> {
        return {
            start: row.reception_start_time ?? (await this.settings.getString('delivery_window_start', '08:00')),
            end: row.reception_end_time ?? (await this.settings.getString('delivery_window_end', '20:00')),
        };
    }

    private async assertCapacity(manager: EntityManager, row: PickupRow, vehicleId: number): Promise<void> {
        const [vehicle]: { capacity_kg: string; capacity_m3: string }[] = await manager.query(
            `SELECT capacity_kg, capacity_m3 FROM vehicles WHERE vehicle_id = $1 AND deleted_at IS NULL`,
            [vehicleId],
        );
        if (!vehicle) throw new VehicleNotFoundException();

        const report = checkPickupCapacity(
            {
                estimatedWeightKg: row.estimated_weight_kg === null ? null : Number(row.estimated_weight_kg),
                estimatedVolumeM3: row.estimated_volume_m3 === null ? null : Number(row.estimated_volume_m3),
            },
            { capacityKg: Number(vehicle.capacity_kg), capacityM3: Number(vehicle.capacity_m3) },
        );
        if (report.fits) return;
        const parts: string[] = [];
        if (report.weight && report.weight.excess > 0) {
            parts.push(`weight ${report.weight.actual} kg over ${report.weight.capacity} kg`);
        }
        if (report.volume && report.volume.excess > 0) {
            parts.push(`volume ${report.volume.actual} m3 over ${report.volume.capacity} m3`);
        }
        throw new PickupCapacityExceededException(parts.join(', '));
    }

    /** Despachos' own outgoing counter for this pickup: highest published version + 1 (first = 1). */
    protected async nextRecordVersion(manager: EntityManager, dispatchId: number): Promise<number> {
        const rows: { version: string | null }[] = await manager.query(
            `SELECT metadata->>'recordVersion' AS version
               FROM dispatch_events
              WHERE dispatch_id = $1 AND event_type = ANY($2)`,
            [dispatchId, [PICKUP_SCHEDULED_EVENT, PICKUP_RESCHEDULED_EVENT]],
        );
        const versions = rows.map((r) => Number(r.version)).filter((v) => Number.isInteger(v) && v > 0);
        return nextPickupRecordVersion(versions);
    }

    protected async publishPickupScheduled(
        manager: EntityManager,
        data: {
            purchaseOrderId: string;
            trackingCode: string;
            recordVersion: number;
            pickupWindow: { startsAt: string; endsAt: string };
        },
    ): Promise<void> {
        const occurredAt = new Date();
        await this.outbox.enqueue(
            buildEnvelope({
                type: PICKUP_SCHEDULED_TOPIC,
                source: 'dispatch',
                occurredAt,
                data: { ...data, updatedAt: occurredAt.toISOString() },
            }),
            { manager },
        );
    }
}
