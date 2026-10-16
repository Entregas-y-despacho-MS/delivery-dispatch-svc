import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

export interface FinalReviewBatchRow {
    routeBatchId: number;
    status: string;
    shiftDate: string;
    reviewerUserId: number | null;
    dispatchCount: number;
}

/**
 * Reads and the idempotency record of the 2nd-approval timeline (ST-51.4). Raw SQL on purpose: like the
 * scheduler and the cutoff, this logic belongs to no single table.
 */
@Injectable()
export class FinalReviewRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    /** Batches of a route day in any of `statuses`, with how many orders each holds. */
    async findBatches(shiftDate: string, statuses: readonly string[]): Promise<FinalReviewBatchRow[]> {
        const rows: Array<{ id: number; status: string; shift_date: string; reviewer_user_id: number | null; dispatch_count: string }> =
            await this.dataSource.query(
                `SELECT b.route_batch_id AS id, b.status, to_char(b.shift_date, 'YYYY-MM-DD') AS shift_date,
                        b.reviewer_user_id,
                        (SELECT COUNT(*) FROM dispatches d WHERE d.route_batch_id = b.route_batch_id) AS dispatch_count
                   FROM route_batches b
                  WHERE b.shift_date = $1 AND b.status = ANY($2::text[])
                  ORDER BY b.route_batch_id`,
                [shiftDate, [...statuses]],
            );
        return rows.map((row) => ({
            routeBatchId: row.id,
            status: row.status,
            shiftDate: row.shift_date,
            reviewerUserId: row.reviewer_user_id,
            dispatchCount: Number(row.dispatch_count),
        }));
    }

    /**
     * Writes a batch event only if the batch has none of `eventType` yet and is still in one of
     * `requiredStatuses`, in a single statement, so two instances (or a re-run) cannot both win.
     * Returns whether this call wrote it.
     */
    async recordBatchEventOnce(
        routeBatchId: number,
        eventType: string,
        requiredStatuses: readonly string[],
        reason: string,
        metadata: Record<string, unknown>,
        manager?: EntityManager,
    ): Promise<boolean> {
        const runner = manager ?? this.dataSource;
        const rows: unknown[] = await runner.query(
            `INSERT INTO route_batch_events (route_batch_id, event_type, actor_type, reason, metadata)
             SELECT b.route_batch_id, $2, 'system', $4, $5::jsonb
               FROM route_batches b
              WHERE b.route_batch_id = $1
                AND b.status = ANY($3::text[])
                AND NOT EXISTS (SELECT 1 FROM route_batch_events e WHERE e.route_batch_id = b.route_batch_id AND e.event_type = $2)
             RETURNING route_batch_event_id`,
            [routeBatchId, eventType, [...requiredStatuses], reason, JSON.stringify(metadata)],
        );
        return rows.length > 0;
    }
}
