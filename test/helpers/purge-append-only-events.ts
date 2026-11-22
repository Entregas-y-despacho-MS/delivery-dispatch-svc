import { DataSource, EntityManager } from 'typeorm';

interface EventPurgeScope {
    dispatchRefs?: string[];
    routeBatchIds?: number[];
    userNames?: string[];
}

/** Purge this suite's events, on the same connection as SET LOCAL (and its rows of the order/dispatch history). */
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
        // customer_notifications.dispatch_id is ON DELETE RESTRICT: any suite whose status changes email the customer
        // would otherwise fail to delete its dispatches. The table is checked for first so a database without the
        // migration (ST-39.2) still works: a failed statement would abort the whole transaction.
        const [{ present }] = await manager.query(`SELECT to_regclass('public.customer_notifications') IS NOT NULL AS present`);
        if (present) {
            await manager.query(
                `DELETE FROM customer_notifications
                 WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE ANY($1::text[]) OR route_batch_id = ANY($2::int[]))`,
                params.slice(0, 2),
            );
        }
        // order_dispatch_events (ST-69.1) has no purge escape: its triggers block DELETE and its FKs to dispatches, batches
        // and users are RESTRICT. Inside this transaction only, the delete trigger is disabled (needs the table owner, as the
        // e2e connection is) so just this suite's rows go; DDL is transactional, so a failure re-enables it.
        const [{ history }] = await manager.query(`SELECT to_regclass('public.order_dispatch_events') IS NOT NULL AS history`);
        if (history) {
            await manager.query('ALTER TABLE order_dispatch_events DISABLE TRIGGER trg_order_dispatch_events_prevent_delete');
            await manager.query(
                `DELETE FROM order_dispatch_events
                 WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE ANY($1::text[]) OR route_batch_id = ANY($2::int[]))
                    OR source_order_ref LIKE ANY($1::text[])
                    OR route_batch_id = ANY($2::int[])
                    OR actor_user_id IN (SELECT user_id FROM users WHERE username LIKE ANY($3::text[]))`,
                params,
            );
            await manager.query('ALTER TABLE order_dispatch_events ENABLE TRIGGER trg_order_dispatch_events_prevent_delete');
        }
        if (cleanup) await cleanup(manager);
    });
}
