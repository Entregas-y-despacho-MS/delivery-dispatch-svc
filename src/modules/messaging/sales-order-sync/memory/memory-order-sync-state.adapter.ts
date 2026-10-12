import { Injectable } from '@nestjs/common';
import {
    OrderSyncStatePort,
    type OrderSyncSource,
    type OrderSyncState,
} from '../ports/order-sync-state.port.js';

/** In-memory `OrderSyncStatePort` for the tests of the consumers; it needs neither Docker nor a database. */
@Injectable()
export class MemoryOrderSyncStateAdapter extends OrderSyncStatePort {
    private readonly rows = new Map<string, OrderSyncState>();

    async find(salesOrderId: string, source: OrderSyncSource): Promise<OrderSyncState | null> {
        const row = this.rows.get(this.keyOf(salesOrderId, source));
        return row ? { ...row } : null;
    }

    async findAllOf(salesOrderId: string): Promise<OrderSyncState[]> {
        return [...this.rows.values()].filter((row) => row.salesOrderId === salesOrderId).map((row) => ({ ...row }));
    }

    async save(state: OrderSyncState): Promise<void> {
        this.rows.set(this.keyOf(state.salesOrderId, state.source), { ...state });
    }

    private keyOf(salesOrderId: string, source: OrderSyncSource): string {
        return `${source}|${salesOrderId}`;
    }
}
