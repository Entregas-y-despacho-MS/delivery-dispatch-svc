import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import { InboundMessageTransaction, type TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { ExistingDispatchChanges, type DispatchChangeOutcome } from '../../sales-order-intake/ports/existing-dispatch-changes.port.js';
import { DispatchChangeEvents } from '../../sales-order-intake/services/dispatch-change-events.service.js';
import type { ShipmentChangeBlocks } from '../../sales-order-intake/domain/shipment-change.rules.js';
import { applyShipmentMessage, type ShipmentApplyOutcome } from '../domain/apply-shipment-message.js';
import type {
    ShipmentBlocks,
    ShipmentCancelledData,
    ShipmentMessage,
    ShipmentReadyData,
    ShipmentState,
    ShipmentUpdatedData,
} from '../domain/shipment-message.types.js';
import { ShipmentConsolidator } from '../ports/shipment-consolidator.port.js';
import { WarehouseCodeLookup } from '../ports/warehouse-code.lookup.js';
import { ShipmentOrderRepository } from '../repositories/shipment-order.repository.js';

export const SHIPMENT_TOPICS = {
    ready: 'inventory.shipment.ready',
    updated: 'inventory.shipment.updated',
    cancelled: 'inventory.shipment.cancelled',
} as const;

/**
 * Inventory handler. MessageBus validates the published JSON Schema before these callbacks run.
 * State, consolidation and the processed receipt share the same transaction and order lock.
 * AppModule activates it once ST-72.4 provides the transaction and rejection pipeline.
 */
@Injectable()
export class ShipmentOrderConsumer implements OnModuleInit {
    private readonly logger = new Logger(ShipmentOrderConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly orders: ShipmentOrderRepository,
        private readonly warehouses: WarehouseCodeLookup,
        private readonly consolidator: ShipmentConsolidator,
        private readonly dispatchChanges: ExistingDispatchChanges,
        private readonly events: DispatchChangeEvents,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(SHIPMENT_TOPICS.ready, (envelope) =>
            this.handle({ kind: 'ready', data: envelope.data as unknown as ShipmentReadyData }, envelope),
        );
        await this.bus.subscribe(SHIPMENT_TOPICS.updated, (envelope) =>
            this.handle({ kind: 'updated', data: envelope.data as unknown as ShipmentUpdatedData }, envelope),
        );
        await this.bus.subscribe(SHIPMENT_TOPICS.cancelled, (envelope) =>
            this.handle({ kind: 'cancelled', data: envelope.data as unknown as ShipmentCancelledData }, envelope),
        );
    }

    private async handle(message: ShipmentMessage, envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const { salesOrderId } = message.data;
        let outcome: ShipmentApplyOutcome | undefined;
        const dispatchOutcomes: DispatchChangeOutcome[] = [];

        const result = await this.transaction.process(envelope, salesOrderId, async (options) => {
            const warehouseId = message.kind === 'cancelled' ? undefined : message.data.warehouseId;
            if (warehouseId !== undefined && !(await this.warehouses.exists(warehouseId, options))) {
                throw new RejectedMessageException([{
                    path: '/data/warehouseId',
                    keyword: 'unknownWarehouse',
                    message: `Warehouse code ${warehouseId} does not exist.`,
                }], 'unknown_warehouse');
            }

            const current = await this.orders.find(salesOrderId, options);
            const applied = applyShipmentMessage(current, message);
            outcome = applied.outcome;
            if (outcome === 'applied' || outcome === 'base_completed_late') {
                await this.orders.save(applied.state, options);
                const consolidation = await this.consolidator.tryConsolidate(salesOrderId, options);
                if (consolidation.status === 'already_consolidated') {
                    dispatchOutcomes.push(...(await this.propagateToDispatch(message, applied.state, options)));
                }
            }
        });

        if (result === 'duplicate') this.logger.debug(`Ignored repeated shipment ${envelope.messageId}.`);
        else {
            this.logger.debug(`${envelope.type} of order ${salesOrderId}: ${outcome}.`);
            this.events.emitAfterCommit(dispatchOutcomes);
        }
        return result;
    }

    /**
     * The order already was a dispatch before this message, so what Almacén now says has to reach it:
     * a cancellation, or, for `ready` and `updated`, the packages, the handling conditions, the
     * evidence policy and the packing (`applyShipmentChange`, ST-72.5) and its readiness
     * (`setShipmentReady`). The blocks come from the merged state of Almacén, not from the raw
     * message: a `ready` leaves out what the contract defaults, and the dispatch must mirror what
     * the order now is. `ExistingDispatchChanges` only writes what really differs.
     * `warehouseId` and `availableFrom` are not applied: they have their own rule.
     */
    private async propagateToDispatch(
        message: ShipmentMessage,
        state: ShipmentState,
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome[]> {
        if (message.kind === 'cancelled') {
            return [
                await this.dispatchChanges.cancel({
                    salesOrderId: message.data.salesOrderId,
                    source: 'inventory',
                    cancelledAt: message.data.cancelledAt,
                    reason: message.data.reason,
                }, options),
            ];
        }

        const outcomes: DispatchChangeOutcome[] = [];

        const blocks = shipmentChangeOf(state.blocks);
        if (blocks !== null) {
            outcomes.push(await this.dispatchChanges.applyShipmentChange({
                salesOrderId: message.data.salesOrderId,
                source: 'inventory',
                blocks,
                receivedAt: message.data.updatedAt,
            }, options));
        }

        outcomes.push(await this.dispatchChanges.setShipmentReady({
            salesOrderId: message.data.salesOrderId,
            source: 'inventory',
            ready: message.kind === 'ready' || message.data.isReady,
            receivedAt: message.data.updatedAt,
            reason: message.kind === 'updated' ? message.data.reason : undefined,
        }, options));

        return outcomes;
    }
}

/** The blocks of Almacén that can change a dispatch, or `null` when the state carries none. */
function shipmentChangeOf(blocks: ShipmentBlocks): ShipmentChangeBlocks | null {
    const change: ShipmentChangeBlocks = {};
    if (blocks.packages !== undefined && blocks.packages.length > 0) change.packages = blocks.packages;
    if (blocks.handlingConditions !== undefined) change.handlingConditions = blocks.handlingConditions;
    if (blocks.evidencePolicy !== undefined) change.evidencePolicy = blocks.evidencePolicy;
    if (blocks.physicallyPacked !== undefined) change.physicallyPacked = blocks.physicallyPacked;
    return Object.keys(change).length === 0 ? null : change;
}
