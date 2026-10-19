import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { RouteBatchStatusEnum } from '../../../shared/enums/route-batch-status.enum.js';
import { closeGap, type CurrentStop } from '../../public-tracking/domain/reschedule-layout.js';
import { RouteBatchClosingService } from '../../route-batch-closing/services/route-batch-closing.service.js';
import { batchExitPolicy } from '../domain/batch-exit-policy.js';

export interface LockedBatch {
    id: number;
    status: string;
    version: number;
    stops: LockedStop[];
}

export interface LockedStop {
    dispatchId: number;
    sequence: number | null;
    windowStart: Date | null;
}

export interface BatchExitAudit {
    actorUserId: number;
    reason: string;
    /** Stored in the `order_removed` event, next to what this service adds (batch state before and after...). */
    metadata: Record<string, unknown>;
}

export interface BatchExitResult {
    batchId: number;
    batchStatusBefore: string;
    batchStatusAfter: string;
    /** The batch `version` as it stands after the exit (unchanged for a closed or cancelled batch). */
    batchVersion: number;
    /** `dispatches.version` of the dispatch that left, already incremented. */
    dispatchVersion: number;
    cancelled: boolean;
    closed: boolean;
    shiftedDispatchIds: number[];
}

interface BatchRow {
    id: number;
    status: string;
    version: number;
}

interface StopRow {
    dispatch_id: number;
    sequence_order: number | null;
    scheduled_window_start: Date | null;
}

/**
 * Takes one dispatch out of its route batch for a rescheduling or a return of the coordinator (ST-52.2).
 *
 * `lock` takes the locks in the order everyone else uses (the batch, then its dispatches by id) and the caller
 * must re-check what it decided on under them. `leave` then applies the rule of `batchExitPolicy` for the state
 * of the batch and writes the `order_removed` event. `leave` increments `dispatches.version` and clears
 * `route_batch_id` and `sequence_order`; the caller sets everything else of the dispatch afterwards and must not
 * bump the version again.
 */
@Injectable()
export class BatchExitService {
    constructor(private readonly closing: RouteBatchClosingService) {}

    async lock(manager: EntityManager, batchId: number): Promise<LockedBatch | null> {
        const [batch]: BatchRow[] = await manager.query(
            `SELECT route_batch_id AS id, status, version FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`,
            [batchId],
        );
        if (!batch) return null;
        const stops: StopRow[] = await manager.query(
            `SELECT dispatch_id, sequence_order, scheduled_window_start
               FROM dispatches WHERE route_batch_id = $1 ORDER BY dispatch_id FOR UPDATE`,
            [batchId],
        );
        return {
            id: batch.id,
            status: batch.status,
            version: batch.version,
            stops: stops.map((stop) => ({ dispatchId: stop.dispatch_id, sequence: stop.sequence_order, windowStart: stop.scheduled_window_start })),
        };
    }

    async leave(manager: EntityManager, locked: LockedBatch, dispatchId: number, audit: BatchExitAudit): Promise<BatchExitResult> {
        const policy = batchExitPolicy(locked.status);
        const leaving = locked.stops.find((stop) => stop.dispatchId === dispatchId);
        const remaining: CurrentStop[] = locked.stops.filter((stop) => stop.dispatchId !== dispatchId);

        // The sequence the dispatch held is freed first: the unique index on (batch, sequence) is not deferrable.
        const [leftRows]: [{ version: number }[], number] = await manager.query(
            `UPDATE dispatches
                SET route_batch_id = NULL, sequence_order = NULL, version = version + 1, updated_at = NOW()
              WHERE dispatch_id = $1 AND route_batch_id = $2
              RETURNING version`,
            [dispatchId, locked.id],
        );
        const dispatchVersion = leftRows[0]?.version ?? 0;

        const shiftedDispatchIds: number[] = [];
        if (policy.closeSequenceGap && remaining.length > 0) {
            const placed = closeGap(remaining);
            await manager.query(`UPDATE dispatches SET sequence_order = NULL WHERE route_batch_id = $1 AND sequence_order IS NOT NULL`, [locked.id]);
            await manager.query(
                `UPDATE dispatches AS d
                    SET sequence_order = v.seq,
                        version = d.version + CASE WHEN v.bump THEN 1 ELSE 0 END,
                        updated_at = CASE WHEN v.bump THEN NOW() ELSE d.updated_at END
                   FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS seq, unnest($3::boolean[]) AS bump) AS v
                  WHERE d.dispatch_id = v.id`,
                [placed.map((stop) => stop.dispatchId), placed.map((stop) => stop.sequence), placed.map((stop) => stop.changed)],
            );
            shiftedDispatchIds.push(...placed.filter((stop) => stop.changed).map((stop) => stop.dispatchId));
        }

        let batchStatusAfter = locked.status;
        let batchVersion = locked.version;
        let cancelled = false;
        let closed = false;
        if (policy.touchBatch) {
            if (remaining.length === 0 && policy.cancelWhenEmpty) {
                batchStatusAfter = RouteBatchStatusEnum.CANCELLED;
                cancelled = true;
            }
            batchVersion = locked.version + 1;
            await manager.query(
                `UPDATE route_batches SET status = $2, version = version + 1, updated_at = NOW() WHERE route_batch_id = $1`,
                [locked.id, batchStatusAfter],
            );
            if (policy.evaluateClosing) {
                closed = await this.closing.closeIfComplete(manager, locked.id, { dispatchId, cause: 'dispatch_left_the_batch' });
                if (closed) batchStatusAfter = RouteBatchStatusEnum.CLOSED;
            }
        }

        await this.writeEvent(manager, locked, dispatchId, audit, {
            previousSequence: leaving?.sequence ?? null,
            batchStatusBefore: locked.status,
            batchStatusAfter,
            batchVersion,
            dispatchVersion,
            shiftedDispatchIds,
            batchCancelled: cancelled,
            batchClosed: closed,
        });
        if (cancelled) {
            await manager.query(
                `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
                 VALUES ($1, NULL, 'cancelled', $2, 'user', 'dispatch_left_and_batch_emptied', $3::jsonb)`,
                [locked.id, audit.actorUserId, JSON.stringify({ lastDispatchId: dispatchId, ...audit.metadata })],
            );
        }
        return {
            batchId: locked.id,
            batchStatusBefore: locked.status,
            batchStatusAfter,
            batchVersion,
            dispatchVersion,
            cancelled,
            closed,
            shiftedDispatchIds,
        };
    }

    private async writeEvent(
        manager: EntityManager,
        locked: LockedBatch,
        dispatchId: number,
        audit: BatchExitAudit,
        outcome: Record<string, unknown>,
    ): Promise<void> {
        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, $2, 'order_removed', $3, 'user', $4, $5::jsonb)`,
            [locked.id, dispatchId, audit.actorUserId, audit.reason, JSON.stringify({ dispatchId, ...audit.metadata, ...outcome })],
        );
    }
}
