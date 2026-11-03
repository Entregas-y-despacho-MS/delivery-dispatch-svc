import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../../../app/dispatch-status/dispatch-status-changed.event.js';
import type { MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import { InboundMessageTransaction } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { MessageBus, type MessageHandlingResult } from '../../../../plugins/messaging/message-bus.port.js';
import type { RmaPickupRequestedData } from '../domain/rma-pickup-message.types.js';
import { RmaSyncStatePort } from '../ports/rma-sync-state.port.js';
import { PickupOrderService } from './pickup-order.service.js';

export const INVENTORY_RETURN_REQUESTED_TOPIC = 'inventory.return.requested';

@Injectable()
export class RmaPickupConsumer implements OnModuleInit {
    private readonly logger = new Logger(RmaPickupConsumer.name);

    constructor(
        private readonly bus: MessageBus,
        private readonly transaction: InboundMessageTransaction,
        private readonly syncStates: RmaSyncStatePort,
        private readonly pickups: PickupOrderService,
        private readonly events: EventEmitter2,
    ) {}

    async onModuleInit(): Promise<void> {
        await this.bus.subscribe(INVENTORY_RETURN_REQUESTED_TOPIC, (envelope) => this.handle(envelope));
    }

    private async handle(envelope: MessageEnvelope): Promise<MessageHandlingResult> {
        const data = envelope.data as unknown as RmaPickupRequestedData;
        const { rmaId, recordVersion } = data;
        let created: { dispatchId: number; status: string } | undefined;

        const result = await this.transaction.process(envelope, rmaId, async (options) => {
            const current = await this.syncStates.find(rmaId, options);
            if (recordVersion <= (current?.lastRecordVersion ?? 0)) return;

            created = await this.pickups.createFromRma(data, options);
            await this.syncStates.save({ rmaId, lastRecordVersion: recordVersion }, options);
        });

        if (result === 'duplicate') {
            this.logger.debug(`Ignored repeated RMA ${rmaId}.`);
            return result;
        }
        if (!created) {
            this.logger.debug(`Ignored RMA ${rmaId}: recordVersion ${recordVersion} is not newer.`);
            return result;
        }

        this.logger.debug(`RMA ${rmaId} created as dispatch ${created.dispatchId} (${created.status}).`);
        this.emitCreated(created.dispatchId, created.status);
        return result;
    }

    private emitCreated(dispatchId: number, status: string): void {
        try {
            this.events.emit(DISPATCH_STATUS_CHANGED_EVENT, {
                dispatchId,
                status,
                previousStatus: status,
                version: 0,
                updatedAt: new Date().toISOString(),
            });
        } catch (error) {
            // The dispatch is already committed; a failing listener must not turn the message into a retry.
            this.logger.error(
                `A listener of ${DISPATCH_STATUS_CHANGED_EVENT} failed for dispatch ${dispatchId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}
