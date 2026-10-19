import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchStatusPublicationService } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import { ReturnDispatchResultDto } from '../dto/return-dispatch-result.dto.js';
import type { ReturnDispatchDto } from '../dto/return-dispatch.dto.js';
import { isReturnableStatus } from '../domain/reschedulable-status.js';
import { DeliveryAttemptsNotExhaustedException, DispatchReturnNotAllowedException, DispatchTypeNotSupportedException } from '../exceptions/index.js';
import { DeliveryAttemptsService } from './delivery-attempts.service.js';
import { DispatchLockService } from './dispatch-lock.service.js';

interface Applied {
    result: ReturnDispatchResultDto;
    event: DispatchStatusChangedEvent;
}

/**
 * Return of a failed delivery to the warehouse by the coordinator (ES-52, Escenario 3; the way out when the delivery
 * attempts are spent). Only from `incident` or `not_delivered`, and only once the attempts reached
 * `max_delivery_attempts`.
 *
 * In ONE transaction: the `dispatch.transfer.status_changed` message is queued in the outbox (before the event, with its
 * `outboundRecordVersion` kept in the event metadata, as the driver transitions do), the dispatch becomes `returned`
 * with an explicit `closed_at` (the moment of the return), and the audit event is written.
 *
 * The dispatch stays linked to its route batch: the history takes the driver and the vehicle from it, and an
 * `incident`, `not_delivered` or `returned` dispatch does not keep a batch open (D-50), so the batch needs nothing.
 * The planning `version` does not move: a return is not a change of plan.
 */
@Injectable()
export class DispatchReturnService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly locks: DispatchLockService,
        private readonly attempts: DeliveryAttemptsService,
        private readonly publication: DispatchStatusPublicationService,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly events: EventEmitter2,
    ) {}

    async returnToWarehouse(dispatchId: number, dto: ReturnDispatchDto, userId: number, now: Date = new Date()): Promise<ReturnDispatchResultDto> {
        const applied = await this.dataSource.transaction(async (manager) => await this.apply(manager, dispatchId, dto, userId, now));
        this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, applied.event);
        return applied.result;
    }

    private async apply(manager: EntityManager, dispatchId: number, dto: ReturnDispatchDto, userId: number, now: Date): Promise<Applied> {
        const dispatch = await this.locks.lockDispatchOnly(manager, dispatchId);
        if (dispatch.type !== 'delivery') throw new DispatchTypeNotSupportedException(dispatch.type);
        if (!isReturnableStatus(dispatch.status)) throw new DispatchReturnNotAllowedException(dispatch.status);

        const attempts = await this.attempts.count(manager, dispatchId);
        if (!attempts.limitReached) throw new DeliveryAttemptsNotExhaustedException(attempts.used, attempts.limit);

        // The cause published with the return is the reason of the last failed attempt the driver reported.
        const [lastIncident]: { code: string }[] = await manager.query(
            `SELECT ir.code
               FROM dispatch_incidents i
               JOIN incident_reasons ir ON ir.incident_reason_id = i.incident_reason_id
              WHERE i.dispatch_id = $1
              ORDER BY i.created_at DESC, i.dispatch_incident_id DESC
              LIMIT 1`,
            [dispatchId],
        );
        const reasonCode = lastIncident?.code ?? null;

        const outboundRecordVersion = await this.publication.publish(manager, {
            dispatchId,
            status: DispatchStatusEnum.RETURNED,
            previousStatus: dispatch.status,
            occurredAt: now,
            ...(reasonCode ? { reasonCode } : {}),
        });

        const [updatedRows]: [{ updated_at: Date }[], number] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    closed_at = $3::timestamptz, updated_at = NOW()
              WHERE dispatch_id = $1
              RETURNING updated_at`,
            [dispatchId, DispatchStatusEnum.RETURNED, now],
        );

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: `${dispatch.status} -> ${DispatchStatusEnum.RETURNED}`,
            actorUserId: userId,
            actorType: 'user',
            reason: 'Coordinator returned the dispatch to the warehouse',
            metadata: {
                previousStatus: dispatch.status,
                status: DispatchStatusEnum.RETURNED,
                version: dispatch.version,
                reasonCode,
                attemptsUsed: attempts.used,
                attemptsLimit: attempts.limit,
                notes: dto.notes ?? null,
                ...(outboundRecordVersion !== null && { outboundRecordVersion }),
            },
            occurredAt: now,
        }, { manager });

        return {
            result: {
                dispatchId,
                status: DispatchStatusEnum.RETURNED,
                previousStatus: dispatch.status,
                closedAt: now.toISOString(),
                reasonCode,
                attemptsUsed: attempts.used,
                attemptsLimit: attempts.limit,
            },
            event: {
                dispatchId,
                status: DispatchStatusEnum.RETURNED,
                previousStatus: dispatch.status,
                version: dispatch.version,
                updatedAt: new Date(updatedRows[0].updated_at).toISOString(),
            },
        };
    }
}
