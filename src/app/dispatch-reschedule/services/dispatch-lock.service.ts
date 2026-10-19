import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DispatchNotFoundException } from '../../../modules/dispatch/dispatches/exceptions/dispatch-not-found.exception.js';
import { DispatchChangedConcurrentlyException } from '../exceptions/index.js';
import { BatchExitService, type LockedBatch } from './batch-exit.service.js';

export interface LockedDispatch {
    id: number;
    status: string;
    type: string;
    version: number;
    routeBatchId: number | null;
    scheduledWindowStart: Date | null;
    scheduledWindowEnd: Date | null;
    customerConfirmation: string;
}

export interface LockedDispatchContext {
    dispatch: LockedDispatch;
    /** The batch of the dispatch with all its stops, locked; `null` when the dispatch is in none. */
    batch: LockedBatch | null;
}

interface DispatchRow {
    id: number;
    status: string;
    type: string;
    version: number;
    route_batch_id: number | null;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    customer_confirmation: string;
}

/**
 * Locks a dispatch for an action of the coordinator in the order the rest of the system uses: its batch first, then
 * the dispatches of the batch by id. The batch is known only by reading the dispatch, so the dispatch is read
 * again under the lock and, if it moved meanwhile, the request is refused (409) instead of acting on a stale state.
 */
@Injectable()
export class DispatchLockService {
    constructor(private readonly batchExit: BatchExitService) {}

    async lock(manager: EntityManager, dispatchId: number): Promise<LockedDispatchContext> {
        const [pre]: { route_batch_id: number | null }[] = await manager.query(
            'SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1',
            [dispatchId],
        );
        if (!pre) throw new DispatchNotFoundException();

        const batch = pre.route_batch_id === null ? null : await this.batchExit.lock(manager, pre.route_batch_id);
        const [row]: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id AS id, ds.name AS status, dt.name AS type, d.version, d.route_batch_id,
                    d.scheduled_window_start, d.scheduled_window_end, d.customer_confirmation
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types dt ON dt.dispatch_type_id = d.dispatch_type_id
              WHERE d.dispatch_id = $1
              FOR UPDATE OF d`,
            [dispatchId],
        );
        if (!row) throw new DispatchNotFoundException();
        if (row.route_batch_id !== pre.route_batch_id) throw new DispatchChangedConcurrentlyException();

        return {
            batch,
            dispatch: {
                id: row.id,
                status: row.status,
                type: row.type,
                version: row.version,
                routeBatchId: row.route_batch_id,
                scheduledWindowStart: row.scheduled_window_start,
                scheduledWindowEnd: row.scheduled_window_end,
                customerConfirmation: row.customer_confirmation,
            },
        };
    }
}
