import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { buildEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { InvalidOutboundMessageException } from '../../messaging/outbound-messages/exceptions/index.js';
import { OutboxService } from '../../messaging/outbound-messages/services/outbox.service.js';
import {
    dispatchStatusMessageId,
    dispatchStatusMessagePayload,
    DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC,
    PUBLISHED_DELIVERY_OUTCOME_STATUSES,
} from './dispatch-status-message.js';

interface DispatchIdentityRow {
    dispatch_type: string;
    source_order_ref: string;
    tracking_code: string | null;
}

interface RecordVersionRow {
    version: string | null;
}

export interface PublishDispatchStatusChangeInput {
    dispatchId: number;
    status: string;
    previousStatus: string;
    occurredAt: Date;
    reasonCode?: string;
}

const ORDER_ID_TYPES = new Set(['delivery', 'warehouse_return_pickup', 'supplier_pickup', 'supplier_return']);
/** Creates the external status message in the same transaction as its dispatch transition. */
@Injectable()
export class DispatchStatusPublicationService {
    constructor(private readonly outbox: OutboxService) {}

    async publish(
        manager: EntityManager,
        input: PublishDispatchStatusChangeInput,
    ): Promise<number | null> {
        if (!PUBLISHED_DELIVERY_OUTCOME_STATUSES.includes(input.status)) return null;
        return await this.publishMessage(manager, input);
    }

    /**
     * Supplier-pickup custody updates (ST-239.2): `picked_up_in_transit` is not a delivery outcome
     * (`PUBLISHED_DELIVERY_OUTCOME_STATUSES`), but Compras still needs to know about it. Unlike
     * `publish`, this never returns `null` for a skipped status — callers decide when to call it.
     */
    async publishTransferUpdate(
        manager: EntityManager,
        input: PublishDispatchStatusChangeInput,
    ): Promise<number> {
        return await this.publishMessage(manager, input);
    }

    private async publishMessage(
        manager: EntityManager,
        input: PublishDispatchStatusChangeInput,
    ): Promise<number> {
        const [dispatch]: DispatchIdentityRow[] = await manager.query(
            `SELECT t.name AS dispatch_type, d.source_order_ref, d.tracking_code
               FROM dispatches d
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
              WHERE d.dispatch_id = $1
              FOR UPDATE OF d`,
            [input.dispatchId],
        );
        if (!dispatch || !ORDER_ID_TYPES.has(dispatch.dispatch_type)) {
            throw new InvalidOutboundMessageException(DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC, [{
                path: '/data/salesOrderId',
                message: 'The dispatch has no supported order identity.',
                keyword: 'orderIdentity',
            }]);
        }
        if (!dispatch.tracking_code) {
            throw new InvalidOutboundMessageException(DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC, [{
                path: '/data/trackingCode',
                message: 'A tracking code is required by the status-changed contract.',
                keyword: 'required',
            }]);
        }

        const recordVersion = await this.nextRecordVersion(manager, input.dispatchId);
        const occurredAt = input.occurredAt.toISOString();
        const data = dispatchStatusMessagePayload({
            dispatchId: input.dispatchId,
            dispatchType: dispatch.dispatch_type,
            sourceOrderRef: dispatch.source_order_ref,
            trackingCode: dispatch.tracking_code,
            status: input.status,
            previousStatus: input.previousStatus,
            occurredAt,
            recordVersion,
            reasonCode: input.reasonCode,
        });

        await this.outbox.enqueue(buildEnvelope({
            type: DISPATCH_TRANSFER_STATUS_CHANGED_TOPIC,
            source: 'dispatch',
            occurredAt: input.occurredAt,
            messageId: dispatchStatusMessageId(input.dispatchId, input.status, recordVersion, input.occurredAt),
            data,
        }), { manager });

        return recordVersion;
    }

    private async nextRecordVersion(manager: EntityManager, dispatchId: number): Promise<number> {
        // This outbound sequence is separate from dispatch.version. The dispatch row is locked above
        // so concurrent result transitions cannot read the same previous value.
        const [row]: RecordVersionRow[] = await manager.query(
            `SELECT MAX(
                       CASE
                           WHEN metadata->>'outboundRecordVersion' ~ '^[1-9][0-9]{0,15}$'
                           THEN (metadata->>'outboundRecordVersion')::numeric
                       END
                   )::text AS version
               FROM dispatch_events
              WHERE dispatch_id = $1
                AND event_type = 'status_changed'
                AND metadata ? 'outboundRecordVersion'`,
            [dispatchId],
        );
        const previousVersion = Number(row?.version);
        if (!Number.isSafeInteger(previousVersion) || previousVersion <= 0) return 1;
        return previousVersion + 1;
    }
}
