import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DispatchStatusEnum } from '../../../shared/enums/index.js';

/** Upper bound per run; the rest is picked up by the next tick (the query is ordered by oldest notice). */
export const PROMISE_WINDOW_BATCH_SIZE = 500;

/**
 * Dispatches whose response window may have closed: a valid notice (`promise_notified_at` is never set by
 * a bounce, ST-215.2), no firmness yet and no customer response recorded. Only a first filter:
 * `PromiseFirmingService.firm` re-checks everything under a row lock before writing.
 */
@Injectable()
export class PromiseWindowCandidatesRepository {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async findClosable(now: Date, windowMinutes: number, limit: number = PROMISE_WINDOW_BATCH_SIZE): Promise<number[]> {
        const rows: { id: number }[] = await this.dataSource.query(
            `SELECT d.dispatch_id AS id
               FROM dispatches d
               JOIN dispatch_statuses ds ON ds.dispatch_status_id = d.dispatch_status_id
              WHERE ds.name = ANY($1::text[])
                AND d.promise_notified_at IS NOT NULL
                AND d.promise_firmed_at IS NULL
                AND d.customer_confirmation = 'pending'
                AND d.promise_notified_at + make_interval(mins => $2::int) <= $3
              ORDER BY d.promise_notified_at, d.dispatch_id
              LIMIT $4`,
            [[DispatchStatusEnum.SCHEDULED, DispatchStatusEnum.ASSIGNED], windowMinutes, now, limit],
        );
        return rows.map((row) => row.id);
    }
}
