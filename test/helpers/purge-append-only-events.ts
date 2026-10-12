import { DataSource, EntityManager } from 'typeorm';

interface EventPurgeScope {
    dispatchRefs?: string[];
    routeBatchIds?: number[];
    userNames?: string[];
}

/** Purge only this suite's events, on the same connection as SET LOCAL. */
export async function withEventPurge(
    dataSource: DataSource,
    scope: EventPurgeScope,
    cleanup?: (manager: EntityManager) => Promise<void>,
): Promise<void> {
    await dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.allow_event_purge = 'on'`);
        const params = [scope.dispatchRefs ?? [], scope.routeBatchIds ?? [], scope.userNames ?? []];
        await manager.query(
            `DELETE FROM route_batch_events
             WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE ANY($1::text[]) OR route_batch_id = ANY($2::int[]))
                OR route_batch_id = ANY($2::int[])
                OR route_batch_id IN (SELECT route_batch_id FROM route_batches WHERE driver_id IN (SELECT user_id FROM users WHERE username LIKE ANY($3::text[])))
                OR actor_user_id IN (SELECT user_id FROM users WHERE username LIKE ANY($3::text[]))`,
            params,
        );
        await manager.query(
            `DELETE FROM dispatch_events
             WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE ANY($1::text[]) OR route_batch_id = ANY($2::int[]))
                OR actor_user_id IN (SELECT user_id FROM users WHERE username LIKE ANY($3::text[]))`,
            params,
        );
        if (cleanup) await cleanup(manager);
    });
}
