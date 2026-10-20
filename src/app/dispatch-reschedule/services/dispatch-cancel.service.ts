import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { DispatchEventsService } from '../../../modules/dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchStatusPublicationService } from '../../../modules/dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../../dispatch-status/dispatch-status-changed.event.js';
import { RouteBatchClosingService } from '../../route-batch-closing/services/route-batch-closing.service.js';
import { CancelDispatchResultDto } from '../dto/cancel-dispatch-result.dto.js';
import type { CancelDispatchDto } from '../dto/cancel-dispatch.dto.js';
import { isCancellableByCoordinator } from '../domain/reschedulable-status.js';
import { DispatchCancelNotAllowedException, DispatchTypeNotSupportedException } from '../exceptions/index.js';
import { DispatchLockService } from './dispatch-lock.service.js';

/** Reason published to the ERP when the coordinator cancels (the cancellations that come from Marketplace carry `ORDER-CANCELLED`). */
export const COORDINATOR_CANCELLED_REASON_CODE = 'COORD-CANCELLED';

interface Applied {
    result: CancelDispatchResultDto;
    event: DispatchStatusChangedEvent;
}

/**
 * Cancellation of a delivery by the coordinator (ES-52). Only from `assigned`: the case that needs it is a stop the
 * driver cannot take, such as a dispatch left out of the route by a failed cotejo (ST-210.1), which keeps its route
 * batch open (D-50) until someone resolves it.
 *
 * In ONE transaction, locking the batch before the dispatch as the rest of the system does: the
 * `dispatch.transfer.status_changed` message is queued in the outbox (before the event, with its
 * `outboundRecordVersion` kept in the event metadata), the dispatch becomes `cancelled` with an explicit `closed_at`,
 * the audit event is written and the batch is closed when nothing in it is left open (`RouteBatchClosingService`).
 *
 * The dispatch stays linked to its route batch (the history takes the driver and the vehicle from it) and its planning
 * `version` does not move: a cancellation is not a change of plan.
 */
@Injectable()
export class DispatchCancelService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly locks: DispatchLockService,
        private readonly publication: DispatchStatusPublicationService,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly closing: RouteBatchClosingService,
        private readonly events: EventEmitter2,
    ) {}

    async cancel(dispatchId: number, dto: CancelDispatchDto, userId: number, now: Date = new Date()): Promise<CancelDispatchResultDto> {
        const applied = await this.dataSource.transaction(async (manager) => await this.apply(manager, dispatchId, dto, userId, now));
        this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, applied.event);
        return applied.result;
    }

    private async apply(manager: EntityManager, dispatchId: number, dto: CancelDispatchDto, userId: number, now: Date): Promise<Applied> {
        const { dispatch, batch } = await this.locks.lock(manager, dispatchId);
        if (dispatch.type !== 'delivery') throw new DispatchTypeNotSupportedException(dispatch.type);
        if (!isCancellableByCoordinator(dispatch.status)) throw new DispatchCancelNotAllowedException(dispatch.status);

        const outboundRecordVersion = await this.publication.publish(manager, {
            dispatchId,
            status: DispatchStatusEnum.CANCELLED,
            previousStatus: dispatch.status,
            occurredAt: now,
            reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
        });

        const [updatedRows]: [{ updated_at: Date }[], number] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    closed_at = $3::timestamptz, updated_at = NOW()
              WHERE dispatch_id = $1
              RETURNING updated_at`,
            [dispatchId, DispatchStatusEnum.CANCELLED, now],
        );

        await this.dispatchEvents.create({
            dispatchId,
            eventType: 'status_changed',
            detail: `${dispatch.status} -> ${DispatchStatusEnum.CANCELLED}`,
            actorUserId: userId,
            actorType: 'user',
            reason: dto.reason,
            metadata: {
                previousStatus: dispatch.status,
                status: DispatchStatusEnum.CANCELLED,
                version: dispatch.version,
                reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
                routeBatchId: batch?.id ?? null,
                ...(outboundRecordVersion !== null && { outboundRecordVersion }),
            },
            occurredAt: now,
        }, { manager });

        const routeBatchClosed = batch
            ? await this.closing.closeIfComplete(manager, batch.id, { dispatchId, dispatchStatus: DispatchStatusEnum.CANCELLED, cause: 'dispatch_cancelled_by_coordinator' })
            : false;

        return {
            result: {
                dispatchId,
                status: DispatchStatusEnum.CANCELLED,
                previousStatus: dispatch.status,
                closedAt: now.toISOString(),
                reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
                routeBatchId: batch?.id ?? null,
                routeBatchClosed,
            },
            event: {
                dispatchId,
                status: DispatchStatusEnum.CANCELLED,
                previousStatus: dispatch.status,
                version: dispatch.version,
                updatedAt: new Date(updatedRows[0].updated_at).toISOString(),
            },
        };
    }
}
