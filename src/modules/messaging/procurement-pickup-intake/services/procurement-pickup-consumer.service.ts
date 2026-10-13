import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import { OrderSyncStatePort } from '../../sales-order-sync/ports/order-sync-state.port.js';
import type {
    ProcurementPickupCancelledData,
    ProcurementPickupRequestedData,
    ProcurementPickupUpdatedData,
    ProcurementPickupMessage,
} from '../domain/procurement-pickup-message.types.js';
import { ProcurementPickupRepository } from '../repositories/procurement-pickup.repository.js';

export const PROCUREMENT_PICKUP_TOPICS = {
    requested: 'procurement.pickup.requested',
    updated: 'procurement.pickup.updated',
    cancelled: 'procurement.pickup.cancelled',
} as const;

@Injectable()
export class ProcurementPickupConsumer implements OnModuleInit {
    private readonly logger = new Logger(ProcurementPickupConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly syncStates: OrderSyncStatePort,
        private readonly pickups: ProcurementPickupRepository,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(PROCUREMENT_PICKUP_TOPICS.requested, (envelope) =>
            this.handle({ kind: 'requested', data: envelope.data as unknown as ProcurementPickupRequestedData }, envelope),
        );
        await this.bus.subscribe(PROCUREMENT_PICKUP_TOPICS.updated, (envelope) =>
            this.handle({ kind: 'updated', data: envelope.data as unknown as ProcurementPickupUpdatedData }, envelope),
        );
        await this.bus.subscribe(PROCUREMENT_PICKUP_TOPICS.cancelled, (envelope) =>
            this.handle({ kind: 'cancelled', data: envelope.data as unknown as ProcurementPickupCancelledData }, envelope),
        );
    }

    private async handle(message: ProcurementPickupMessage, envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const { purchaseOrderId, recordVersion } = message.data;
        let outcome = 'ignored';
        const result = await this.transaction.process(envelope, purchaseOrderId, async (options) => {
            const current = await this.syncStates.find(purchaseOrderId, 'procurement', options);

            if (message.kind === 'requested') {
                if (current?.cancelledAt || recordVersion <= (current?.lastRecordVersion ?? 0)) return;
                await this.pickups.applyRequested(message.data, options);
                await this.syncStates.save({
                    salesOrderId: purchaseOrderId,
                    source: 'procurement',
                    lastRecordVersion: recordVersion,
                    baseReceived: true,
                    cancelledAt: null,
                    cancelledVersion: null,
                }, options);
                outcome = 'requested';
                return;
            }

            if (message.kind === 'updated') {
                if (!current?.baseReceived || current.cancelledAt || recordVersion <= current.lastRecordVersion) return;
                await this.pickups.applyUpdated(message.data, options);
                await this.syncStates.save({ ...current, lastRecordVersion: recordVersion }, options);
                outcome = 'updated';
                return;
            }

            if (recordVersion <= (current?.lastRecordVersion ?? 0)) return;
            await this.pickups.applyCancelled(message.data, options);
            await this.syncStates.save({
                salesOrderId: purchaseOrderId,
                source: 'procurement',
                lastRecordVersion: recordVersion,
                baseReceived: current?.baseReceived ?? false,
                cancelledAt: message.data.cancelledAt,
                cancelledVersion: recordVersion,
            }, options);
            outcome = 'cancelled';
        });

        if (result === 'duplicate') this.logger.debug(`Ignored repeated purchase order ${purchaseOrderId}.`);
        else this.logger.debug(`${envelope.type} for purchase order ${purchaseOrderId}: ${outcome}.`);
        return result;
    }
}
