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
import { cancellableStatusesOf, isCancellableByCoordinator, leavesBatchWhenCancelled } from '../domain/reschedulable-status.js';
import { DispatchCancelNotAllowedException, DispatchTypeNotSupportedException } from '../exceptions/index.js';
import { BatchExitService, type BatchExitResult } from './batch-exit.service.js';
import { DispatchLockService } from './dispatch-lock.service.js';

/** Reason published to the ERP when the coordinator cancels (the cancellations that come from Marketplace carry `ORDER-CANCELLED`). */
export const COORDINATOR_CANCELLED_REASON_CODE = 'COORD-CANCELLED';

export interface CancelDispatchOptions {
    /** Dispatch type of the calling endpoint; defaults to `delivery`. */
    type?: string;
}

/**
 * Types whose cancellation is announced to the ERP. A pickup (`warehouse_return_pickup`) is not (ST-81.2, D3): the
 * payload would carry the RMA as `salesOrderId` to Marketplace, which receives every status without a filter, and a
 * manual pickup has no RMA at all. Telling Almacén about a cancelled RMA is a pending item (`PENDIENTES.md`).
 */
const PUBLISHES_CANCELLATION_TYPES: readonly string[] = ['delivery'];

interface Applied {
    result: CancelDispatchResultDto;
    event: DispatchStatusChangedEvent;
}

/**
 * Cancellation of a delivery by the coordinator (ES-52, ES-241) from any state before the route starts: `pending`,
 * `address_review`, `in_planning`, `scheduled` and `assigned`. The case of `assigned` is a stop the driver cannot take,
 * such as a dispatch left out of the route by a failed cotejo (ST-210.1), which keeps its route batch open (D-50)
 * until someone resolves it.
 *
 * In ONE transaction, locking the batch before the dispatch as the rest of the system does: the
 * `dispatch.transfer.status_changed` message is queued in the outbox (before the event, with its
 * `outboundRecordVersion` kept in the event metadata), the dispatch becomes `cancelled` with an explicit `closed_at`,
 * the audit event is written and the batch is closed when nothing in it is left open (`RouteBatchClosingService`).
 *
 * From `assigned` the dispatch stays linked to its route batch (the history takes the driver and the vehicle from it)
 * and its planning `version` does not move: a cancellation is not a change of plan. From `in_planning` and `scheduled`
 * it is still in a batch that is being planned, so it leaves it (`BatchExitService`, D-09: the `version` of the dispatch
 * and of the batch go up) and the capacity of the batch is free again.
 */
@Injectable()
export class DispatchCancelService {
    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly locks: DispatchLockService,
        private readonly publication: DispatchStatusPublicationService,
        private readonly dispatchEvents: DispatchEventsService,
        private readonly closing: RouteBatchClosingService,
        private readonly batchExit: BatchExitService,
        private readonly events: EventEmitter2,
    ) {}

    /**
     * `options.type` is the dispatch type the calling endpoint serves (default `delivery`): a dispatch of another type
     * answers 409 `DISPATCH_TYPE_NOT_SUPPORTED`, so each endpoint only cancels its own kind.
     */
    async cancel(
        dispatchId: number,
        dto: CancelDispatchDto,
        userId: number,
        options: CancelDispatchOptions = {},
        now: Date = new Date(),
    ): Promise<CancelDispatchResultDto> {
        const type = options.type ?? 'delivery';
        const applied = await this.dataSource.transaction(async (manager) => await this.apply(manager, dispatchId, dto, userId, type, now));
        this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, applied.event);
        return applied.result;
    }

    private async apply(manager: EntityManager, dispatchId: number, dto: CancelDispatchDto, userId: number, type: string, now: Date): Promise<Applied> {
        const { dispatch, batch } = await this.locks.lock(manager, dispatchId);
        if (dispatch.type !== type) throw new DispatchTypeNotSupportedException(dispatch.type, type);
        if (!isCancellableByCoordinator(dispatch.status, type)) {
            throw new DispatchCancelNotAllowedException(dispatch.status, cancellableStatusesOf(type));
        }

        let exit: BatchExitResult | null = null;
        if (batch && leavesBatchWhenCancelled(dispatch.status)) {
            exit = await this.batchExit.leave(manager, batch, dispatchId, {
                actorUserId: userId,
                reason: dto.reason,
                metadata: { cause: 'coordinator_cancelled', reasonCode: COORDINATOR_CANCELLED_REASON_CODE },
            });
        }

        const outboundRecordVersion = PUBLISHES_CANCELLATION_TYPES.includes(type)
            ? await this.publication.publish(manager, {
                dispatchId,
                status: DispatchStatusEnum.CANCELLED,
                previousStatus: dispatch.status,
                occurredAt: now,
                reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
            })
            : null;

        const [updatedRows]: [{ version: number; updated_at: Date }[], number] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    closed_at = $3::timestamptz, updated_at = NOW()
              WHERE dispatch_id = $1
              RETURNING version, updated_at`,
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
                version: updatedRows[0].version,
                reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
                routeBatchId: exit ? null : batch?.id ?? null,
                ...(exit && { fromBatchId: exit.batchId, batchStatusBefore: exit.batchStatusBefore, batchStatusAfter: exit.batchStatusAfter, batchVersion: exit.batchVersion }),
                ...(outboundRecordVersion !== null && { outboundRecordVersion }),
            },
            occurredAt: now,
        }, { manager });

        // After leaving the batch, `leave` already evaluated the closing of a batch in execution.
        const routeBatchClosed = exit
            ? exit.closed
            : batch
                ? await this.closing.closeIfComplete(manager, batch.id, { dispatchId, dispatchStatus: DispatchStatusEnum.CANCELLED, cause: 'dispatch_cancelled_by_coordinator' })
                : false;

        return {
            result: {
                dispatchId,
                status: DispatchStatusEnum.CANCELLED,
                previousStatus: dispatch.status,
                closedAt: now.toISOString(),
                reasonCode: COORDINATOR_CANCELLED_REASON_CODE,
                routeBatchId: exit ? null : batch?.id ?? null,
                routeBatchClosed,
            },
            event: {
                dispatchId,
                status: DispatchStatusEnum.CANCELLED,
                previousStatus: dispatch.status,
                version: updatedRows[0].version,
                updatedAt: new Date(updatedRows[0].updated_at).toISOString(),
            },
        };
    }
}
