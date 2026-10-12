import { Injectable } from '@nestjs/common';
import type { MutationOptions } from '../../../../shared/dto/options.dto.js';
import { SalesOrderLock } from '../ports/sales-order-lock.port.js';

/**
 * In-memory `SalesOrderLock` for tests: runs the work of the same `salesOrderId` one after another.
 * There is no transaction here, so `work` receives no `manager` and nothing is rolled back.
 */
@Injectable()
export class MemorySalesOrderLockAdapter extends SalesOrderLock {
    /** Tail of the work in progress per order. */
    private readonly tails = new Map<string, Promise<unknown>>();

    async withLock<T>(salesOrderId: string, work: (options: MutationOptions) => Promise<T>): Promise<T> {
        const previous = this.tails.get(salesOrderId) ?? Promise.resolve();
        const run = previous.then(() => work({}));
        const tail = run.then(
            () => undefined,
            () => undefined,
        );
        this.tails.set(salesOrderId, tail);
        try {
            return await run;
        } finally {
            if (this.tails.get(salesOrderId) === tail) this.tails.delete(salesOrderId);
        }
    }
}
