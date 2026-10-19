import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/dispatch-status.enum.js';

/** A dispatch in one of these states keeps its route open (D-50). `incident` and `not_delivered` do not. */
export const OPEN_ROUTE_DISPATCH_STATUSES = [
    DispatchStatusEnum.ASSIGNED,
    DispatchStatusEnum.OUT_FOR_DELIVERY,
    DispatchStatusEnum.IN_TRANSIT,
];

interface ClosedRouteBatchRow {
    closed_at: Date;
}

/**
 * Automatic closing of a route (D-50, ST-30.3). Evaluated inside the transaction of whatever moved or removed
 * a dispatch, so it never depends on the app sending an end-of-day signal.
 */
@Injectable()
export class RouteBatchClosingService {
    /**
     * Closes the batch when no dispatch of it is left in an open state. Only an `in_execution` batch can
     * close; any other state is left as it is. `context` is stored in the `closed` event metadata.
     * Returns whether the batch was closed by this call.
     */
    async closeIfComplete(manager: EntityManager, batchId: number, context: Record<string, unknown>): Promise<boolean> {
        const [openDispatch]: { dispatch_id: number }[] = await manager.query(
            `SELECT d.dispatch_id
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE d.route_batch_id = $1
                AND ds.name = ANY($2::varchar[])
              LIMIT 1`,
            [batchId, OPEN_ROUTE_DISPATCH_STATUSES],
        );
        if (openDispatch) return false;

        // TypeORM answers UPDATE ... RETURNING with [rows, affectedCount] (testing.md), not with the rows.
        const [closedRows]: [ClosedRouteBatchRow[], number] = await manager.query(
            `UPDATE route_batches
                SET status = 'closed', closed_at = NOW(), updated_at = NOW()
              WHERE route_batch_id = $1 AND status = 'in_execution'
              RETURNING closed_at`,
            [batchId],
        );
        if (closedRows.length === 0) return false;

        await manager.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_user_id, actor_type, reason, metadata)
             VALUES ($1, 'closed', NULL, 'system', $2, $3::jsonb)`,
            [batchId, 'All route dispatches are outside active states.', JSON.stringify(context)],
        );
        return true;
    }
}
