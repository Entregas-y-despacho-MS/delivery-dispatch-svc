import { ForbiddenException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DeliveryEvidencesService } from '../../../modules/dispatch/delivery-evidences/services/delivery-evidences.service.js';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { FINAL_STATUSES } from '../../../modules/dispatch/dispatches/services/dispatches.service.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DispatchEvidenceRequiredException } from '../exceptions/dispatch-evidence-required.exception.js';
import { DispatchStatusConflictException } from '../exceptions/dispatch-status-conflict.exception.js';
import { DispatchStatusResponseDto } from '../dto/dispatch-status-response.dto.js';
import { UpdateDispatchStatusDto } from '../dto/update-dispatch-status.dto.js';
import { assertDriverDispatchTransition } from '../domain/dispatch-status-transition.js';
import { DISPATCH_STATUS_CHANGED_EVENT, DispatchStatusChangedEvent } from '../dispatch-status-changed.event.js';

interface DispatchRow {
    id: number;
    route_batch_id: number | null;
    status: string;
    evidence_policy: string;
    version: number;
    updated_at: Date;
}

interface RouteBatchRow {
    id: number;
    driver_id: number | null;
    status: string;
}

interface IdempotencyRow {
    dispatchId: number;
    eventType: string;
    createdAt: Date;
    metadata: Record<string, unknown> | null;
}

interface LatestEventRow {
    created_at: Date;
}

interface TransitionResult {
    response: DispatchStatusResponseDto;
    event?: DispatchStatusChangedEvent;
}

const MAX_FUTURE_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const EVIDENCE_FOR_POLICY: Readonly<Record<string, string>> = {
    hand_delivery_standard: 'signature',
    contactless_delivery:   'photo',
    high_value_control:     'otp',
};

@Injectable()
export class DispatchStatusService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly deliveryEvidences: DeliveryEvidencesService,
        private readonly events: EventEmitter2,
    ) {}

    async update(dispatchId: number, dto: UpdateDispatchStatusDto, driverId: number): Promise<DispatchStatusResponseDto> {
        this.assertPlausibleTime(dto.occurredAt);
        const result = await this.dataSource.transaction(async (manager) => this.applyTransition(manager, dispatchId, dto, driverId));

        // Downstream publication, automatic batch closure and socket notifications must never
        // observe a transition that later rolls back.
        if (result.event) this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, result.event);
        return result.response;
    }

    private async applyTransition(manager: EntityManager, dispatchId: number, dto: UpdateDispatchStatusDto, driverId: number): Promise<TransitionResult> {
        const [identity]: { route_batch_id: number | null }[] = await manager.query(
            'SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1',
            [dispatchId],
        );
        if (!identity) throw new DispatchNotFoundException();
        if (identity.route_batch_id === null) throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });

        // Locking the batch serializes transitions across its stops, so two concurrent requests
        // cannot make two dispatches `in_transit` at the same time.
        const [batch]: RouteBatchRow[] = await manager.query(
            `SELECT route_batch_id AS id, driver_id, status
               FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [identity.route_batch_id],
        );
        const [dispatch]: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id AS id, d.route_batch_id, ds.name AS status,
                    d.evidence_policy, d.version, d.updated_at
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE d.dispatch_id = $1
              FOR UPDATE OF d`,
            [dispatchId],
        );
        if (!dispatch) throw new DispatchNotFoundException();
        if (!batch || batch.driver_id !== driverId || dispatch.route_batch_id !== batch.id) {
            throw new ForbiddenException({ message: 'Dispatch is not assigned to your route.', error: 'INSUFFICIENT_PERMISSIONS' });
        }
        if (batch.status !== 'in_execution') {
            throw new DispatchStatusConflictException('ROUTE_BATCH_NOT_IN_EXECUTION', 'The route batch must be in execution before a driver can change a dispatch status.');
        }

        const previous: IdempotencyRow | null = await this.dispatchEvents.findByClientEventId(dto.eventId, { manager });
        if (previous) {
            if (previous.dispatchId !== dispatchId || previous.eventType !== 'status_changed') {
                throw new DispatchStatusConflictException('EVENT_ID_ALREADY_USED', 'This eventId was already used for another event.');
            }
            return {
                response: {
                    dispatchId,
                    status: dispatch.status as DispatchStatusResponseDto['status'],
                    previousStatus: String(previous.metadata?.previousStatus ?? dispatch.status),
                    version: dispatch.version,
                    updatedAt: dispatch.updated_at,
                },
            };
        }

        if (FINAL_STATUSES.includes(dispatch.status)) {
            throw new DispatchStatusConflictException('DISPATCH_STATUS_TERMINAL', `The dispatch is already ${dispatch.status} and cannot change status.`);
        }
        assertDriverDispatchTransition(dispatch.status, dto.status);

        const latestEvents: LatestEventRow[] = await manager.query(
            `SELECT created_at
               FROM dispatch_events
              WHERE dispatch_id = $1 AND event_type = 'status_changed'
              ORDER BY created_at DESC, dispatch_event_id DESC
              LIMIT 1`,
            [dispatchId],
        );
        if (latestEvents[0] && new Date(dto.occurredAt).getTime() < new Date(latestEvents[0].created_at).getTime()) {
            throw new DispatchStatusConflictException('DISPATCH_STATUS_EVENT_OUT_OF_ORDER', 'This event is older than the last recorded status change.');
        }

        if (dto.status === DispatchStatusEnum.IN_TRANSIT) {
            const [active]: { dispatch_id: number }[] = await manager.query(
                `SELECT d.dispatch_id
                   FROM dispatches d
                   JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
                  WHERE d.route_batch_id = $1 AND d.dispatch_id <> $2 AND ds.name = $3
                  LIMIT 1`,
                [batch.id, dispatchId, DispatchStatusEnum.IN_TRANSIT],
            );
            if (active) {
                throw new DispatchStatusConflictException('ANOTHER_DISPATCH_IN_TRANSIT', 'Another dispatch on this route is already in transit.');
            }
        }

        if (dto.status === DispatchStatusEnum.DELIVERED) {
            const evidenceType = EVIDENCE_FOR_POLICY[dispatch.evidence_policy];
            if (!evidenceType || !(await this.deliveryEvidences.existsByDispatchAndType(dispatchId, evidenceType, { manager }))) {
                throw new DispatchEvidenceRequiredException(evidenceType ?? dispatch.evidence_policy);
            }
        }

        const [target]: { dispatch_status_id: number }[] = await manager.query(
            'SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1',
            [dto.status],
        );
        if (!target) throw new DispatchStatusConflictException('DISPATCH_STATUS_UNKNOWN', `Status ${dto.status} is not configured.`);

        const [updated]: { updated_at: Date }[] = await manager.query(
            `WITH updated AS (
                UPDATE dispatches
                   SET dispatch_status_id = $1, updated_at = now()
                 WHERE dispatch_id = $2
                 RETURNING updated_at
             )
             SELECT updated_at FROM updated`,
            [target.dispatch_status_id, dispatchId],
        );
        const occurredAt = new Date(dto.occurredAt);
        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: `${dispatch.status} -> ${dto.status}`,
            clientEventId: dto.eventId,
            actorUserId: driverId,
            actorType: 'user',
            reason: 'Driver updated dispatch status',
            metadata: {
                previousStatus: dispatch.status,
                status: dto.status,
                version: dispatch.version,
                occurredAt: dto.occurredAt,
                lat: dto.lat,
                lng: dto.lng,
                accuracy: dto.accuracy,
            },
            occurredAt,
        }, { manager });

        const event: DispatchStatusChangedEvent = {
            dispatchId,
            status: dto.status,
            previousStatus: dispatch.status,
            version: dispatch.version,
            updatedAt: new Date(updated.updated_at).toISOString(),
        };
        return {
            response: { dispatchId, status: dto.status, previousStatus: dispatch.status, version: dispatch.version, updatedAt: updated.updated_at },
            event,
        };
    }

    private assertPlausibleTime(occurredAt: string): void {
        const timestamp = new Date(occurredAt).getTime();
        const now = Date.now();
        if (timestamp > now + MAX_FUTURE_MS || timestamp < now - MAX_AGE_MS) {
            throw new DispatchStatusConflictException('DISPATCH_STATUS_EVENT_TIME_INVALID', 'occurredAt is in the future or more than 30 days old. Check the device clock.');
        }
    }
}
