import { Injectable } from '@nestjs/common';
import type { ConsolidatedOrder } from '../domain/consolidated-order.types.js';
import { DispatchGenerator, type CreatedDispatch } from '../ports/dispatch-generator.port.js';

/**
 * Stand-in for `ST-49.1` until it exists, and the generator of the tests: it records what it was
 * asked to create and hands out sequential ids. Like the unique index of the database, it refuses
 * a second dispatch for the same sales order.
 */
@Injectable()
export class MemoryDispatchGenerator extends DispatchGenerator {
    readonly created: { dispatchId: number; order: ConsolidatedOrder }[] = [];

    async createFromConsolidated(order: ConsolidatedOrder): Promise<CreatedDispatch> {
        if (this.created.some((entry) => entry.order.salesOrderId === order.salesOrderId)) {
            throw new Error(`A delivery dispatch already exists for ${order.salesOrderId}.`);
        }
        const dispatchId = this.created.length + 1;
        this.created.push({ dispatchId, order: structuredClone(order) });
        return { dispatchId };
    }
}
