import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { buildEnvelope, type MessageEnvelope } from '../../../../plugins/messaging/envelope/message-envelope.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { OutboxService } from '../../outbound-messages/services/outbox.service.js';
import {
    COMPLAINT_RECEIVED_TOPIC,
    COMPLAINT_REJECTED_TOPIC,
    type ComplaintRejectionCode,
    type DeliveryComplaintOpenedData,
    type DispatchRejectionCode,
} from '../domain/complaint-message.types.js';

const DELIVERY_DISPATCH_TYPE = 'delivery';
const DELIVERED_STATUS = 'delivered';

interface DispatchRow {
    dispatch_id:      number;
    tracking_code:    string | null;
    source_order_ref: string;
    status:           string;
}

type Resolution =
    | { ok: true; dispatch: DispatchRow }
    | { ok: false; code: DispatchRejectionCode };

export type ComplaintIntakeResult =
    | { status: 'accepted'; dispatchId: number; caseVersion: number }
    | { status: 'rejected'; code: ComplaintRejectionCode }
    /** The case already holds this version or a newer one: nothing is written and no acknowledgement is sent. */
    | { status: 'ignored' };

/**
 * Applies one `crm.delivery_complaint.opened` message (ST-298.3, ES-298) inside the caller's
 * transaction: resolves the delivered dispatch it refers to, saves the case once per
 * `(source, crmCaseId)` and queues the acknowledgement in the outbox. Case, receipt and
 * acknowledgement commit together, so a persistence error leaves no acknowledgement behind.
 *
 * It never touches `dispatches` or `route_batches`: a complaint is accepted while the batch of the
 * dispatch is still `in_execution`, as long as the individual dispatch is `delivered`.
 */
@Injectable()
export class ComplaintIntakeService {
    constructor(private readonly outbox: OutboxService) {}

    async apply(
        envelope: MessageEnvelope,
        data: DeliveryComplaintOpenedData,
        options: TransactionOptions,
    ): Promise<ComplaintIntakeResult> {
        const manager = this.manager(options);

        // The schema only says `minimum: 1`; the column is an INTEGER. A bigger number would fail inside
        // Postgres and the broker would redeliver it forever, so it is answered like any invalid payload.
        if (data.caseVersion > INT4_MAX) {
            await this.enqueueRejected(manager, envelope, data, 'schema_invalid', '/data/caseVersion');
            return { status: 'rejected', code: 'schema_invalid' };
        }

        // A repeated or older caseVersion never reverts the case in force and gets no acknowledgement.
        const [existing]: { case_version: number }[] = await manager.query(
            `SELECT case_version FROM delivery_complaint_cases
              WHERE source = $1 AND crm_case_id = $2
                FOR UPDATE`,
            [envelope.source, data.crmCaseId],
        );
        if (existing && data.caseVersion <= existing.case_version) return { status: 'ignored' };

        const resolution = await this.resolveDispatch(manager, data);
        if (!resolution.ok) {
            await this.enqueueRejected(manager, envelope, data, resolution.code);
            return { status: 'rejected', code: resolution.code };
        }

        const { dispatch } = resolution;
        const now = new Date();
        await manager.query(
            `INSERT INTO delivery_complaint_cases
                (message_id, source, crm_case_id, case_version, dispatch_id, tracking_code, reason_code,
                 affected_items, opened_at, consumed_at, intake_status, acknowledged_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, 'acknowledged', $10)
             ON CONFLICT (source, crm_case_id) DO UPDATE SET
                message_id = EXCLUDED.message_id, case_version = EXCLUDED.case_version,
                dispatch_id = EXCLUDED.dispatch_id, tracking_code = EXCLUDED.tracking_code,
                reason_code = EXCLUDED.reason_code, affected_items = EXCLUDED.affected_items,
                opened_at = EXCLUDED.opened_at, consumed_at = EXCLUDED.consumed_at,
                intake_status = 'acknowledged', acknowledged_at = EXCLUDED.acknowledged_at
              WHERE delivery_complaint_cases.case_version < EXCLUDED.case_version`,
            [
                envelope.messageId, envelope.source, data.crmCaseId, data.caseVersion, dispatch.dispatch_id,
                data.trackingCode ?? dispatch.tracking_code, data.reasonCode, JSON.stringify(data.affectedItems),
                new Date(data.openedAt), now,
            ],
        );

        await this.outbox.enqueue(
            buildEnvelope({
                type: COMPLAINT_RECEIVED_TOPIC,
                source: 'dispatch',
                occurredAt: now,
                data: {
                    correlationMessageId: envelope.messageId,
                    crmCaseId: data.crmCaseId,
                    caseVersion: data.caseVersion,
                    dispatchId: dispatch.dispatch_id,
                    trackingCode: dispatch.tracking_code,
                    receivedAt: now.toISOString(),
                },
            }),
            { manager },
        );
        return { status: 'accepted', dispatchId: dispatch.dispatch_id, caseVersion: data.caseVersion };
    }

    /**
     * `dispatchId` and/or `trackingCode` must name one delivery dispatch. When both arrive they must
     * be the same one; `salesOrderId` only validates and never resolves a dispatch by itself.
     */
    private async resolveDispatch(manager: EntityManager, data: DeliveryComplaintOpenedData): Promise<Resolution> {
        const dispatchIdParam = data.dispatchId !== undefined && data.dispatchId <= INT4_MAX ? data.dispatchId : null;
        const rows: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, d.tracking_code, d.source_order_ref, s.name AS status
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
              WHERE t.name = $3
                -- The acknowledgement must carry a tracking code; a dispatch without one is not addressable by CRM.
                AND d.tracking_code IS NOT NULL
                AND (($1::int IS NOT NULL AND d.dispatch_id = $1)
                  OR ($2::text IS NOT NULL AND d.tracking_code = $2))
              ORDER BY d.dispatch_id`,
            // A dispatchId beyond INTEGER cannot name any dispatch: it is searched as "no such id".
            [dispatchIdParam, data.trackingCode ?? null, DELIVERY_DISPATCH_TYPE],
        );

        const bothGiven = data.dispatchId !== undefined && data.trackingCode !== undefined;
        if (rows.length === 0) return { ok: false, code: 'dispatch_not_found' };
        if (rows.length > 1) {
            // Two references that point at two different dispatches contradict each other; a single
            // reference that resolves several stops is ambiguous.
            return { ok: false, code: bothGiven ? 'dispatch_reference_mismatch' : 'dispatch_reference_ambiguous' };
        }

        const [dispatch] = rows;
        const idMatches = data.dispatchId === undefined || dispatch.dispatch_id === data.dispatchId;
        const trackingMatches = data.trackingCode === undefined || dispatch.tracking_code === data.trackingCode;
        if (!idMatches || !trackingMatches) return { ok: false, code: 'dispatch_reference_mismatch' };
        if (data.salesOrderId !== undefined && dispatch.source_order_ref !== data.salesOrderId) {
            return { ok: false, code: 'dispatch_reference_mismatch' };
        }
        if (dispatch.status !== DELIVERED_STATUS) return { ok: false, code: 'dispatch_not_delivered' };
        return { ok: true, dispatch };
    }

    private async enqueueRejected(
        manager: EntityManager,
        envelope: MessageEnvelope,
        data: DeliveryComplaintOpenedData,
        code: ComplaintRejectionCode,
        field?: string,
    ): Promise<void> {
        const now = new Date();
        await this.outbox.enqueue(
            buildEnvelope({
                type: COMPLAINT_REJECTED_TOPIC,
                source: 'dispatch',
                occurredAt: now,
                data: {
                    correlationMessageId: envelope.messageId,
                    crmCaseId: data.crmCaseId,
                    caseVersion: data.caseVersion,
                    rejectionCode: code,
                    ...(field ? { field } : {}),
                    rejectedAt: now.toISOString(),
                },
            }),
            { manager },
        );
    }

    private manager(options: TransactionOptions): EntityManager {
        if (!options.manager) throw new Error('Complaint intake requires the inbound transaction manager.');
        return options.manager;
    }
}
