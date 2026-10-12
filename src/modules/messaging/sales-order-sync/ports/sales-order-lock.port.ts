import type { MutationOptions } from '../../../../shared/dto/options.dto.js';

/**
 * Port that serializes the processing of one sales order. Marketplace and Almacén messages of the
 * same `salesOrderId` can be handled at the same time by different consumers; without this, each one
 * may see only its own uncommitted row, so none consolidates (or both do and create two dispatches).
 *
 * The real adapter (ST-72.4) opens a transaction, takes `pg_advisory_xact_lock(hashtext(salesOrderId))`
 * as its first statement and hands the transaction's `EntityManager` to `work`.
 */
export abstract class SalesOrderLock {
    /**
     * Runs `work` while holding the lock of `salesOrderId`. `work` receives the options to pass
     * (`{ manager }`) to every repository call, so all of them share one transaction. The
     * transaction commits when `work` resolves and rolls back when it throws.
     */
    abstract withLock<T>(salesOrderId: string, work: (options: MutationOptions) => Promise<T>): Promise<T>;
}
