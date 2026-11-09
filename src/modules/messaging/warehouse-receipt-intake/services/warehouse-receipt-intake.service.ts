import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { RouteBatchClosingService } from '../../../../app/route-batch-closing/services/route-batch-closing.service.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { DispatchEventsService } from '../../../dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../../dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DispatchStatusPublicationService } from '../../../dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { isTerminalDispatchStatus } from '../../../dispatch/dispatches/utils/terminal-statuses.js';
import type { DispatchStatusChangedEvent } from '../../../../app/dispatch-status/dispatch-status-changed.event.js';
import type { InventoryReceiptConfirmedData } from '../domain/warehouse-receipt-message.types.js';

const RECEIPT_DIFFERENCE_REASON_CODE = 'INC-RECEIPT-DIFF';
const RMA_PICKUP_TYPE = 'warehouse_return_pickup';
const SUPPLIER_PICKUP_TYPE = 'supplier_pickup';

interface DispatchRow {
    dispatch_id:    number;
    status:         string;
    version:        number;
    route_batch_id: number | null;
    tracking_code:  string | null;
}

/** Socket payloads the consumer emits once the transaction has committed (ST-240.3). */
export interface AppliedReceiptEvents {
    statusChanged: DispatchStatusChangedEvent;
    /** Only when the receipt opened a `receipt_difference` incident. */
    incidentReported?: { dispatchId: number; incidentId: string; reasonCode: string; reportedAt: string; criticality: 'high' };
}

export type ApplyReceiptResult =
    | { status: 'applied'; dispatchId: number; newStatus: string; events: AppliedReceiptEvents }
    | { status: 'orphan'; dispatchId: number | null; referenceId: string }
    | { status: 'ignored' }
    | { status: 'correction'; dispatchId: number };

/**
 * Applies one `inventory.receipt.confirmed` message (ST-240.2, ES-240) inside the caller's
 * transaction: resolves the traslado it confirms, saves the receipt and its items, transitions the
 * dispatch (or leaves it untouched and marks the receipt `orphan`), and evaluates whether its batch
 * can close.
 *
 * Locks the dispatch row first, then `closeIfComplete` locks its route_batch — the opposite order of
 * `DispatchStatusService` (batch, then dispatch). Deadlock risk is low (nothing else locks a single
 * dispatch and then its batch for one of these route_batch_ids concurrently), but it is worth knowing
 * if `closeIfComplete` is ever called from a second place in this same flow.
 */
@Injectable()
export class WarehouseReceiptIntakeService {
    constructor(
        private readonly dispatchEvents: DispatchEventsService,
        private readonly dispatchIncidents: DispatchIncidentsService,
        private readonly statusPublication: DispatchStatusPublicationService,
        private readonly batchClosing: RouteBatchClosingService,
    ) {}

    async apply(data: InventoryReceiptConfirmedData, options: TransactionOptions): Promise<ApplyReceiptResult> {
        const manager = this.manager(options);
        const receivedAt = new Date(data.receivedAt);
        const dispatchType = data.referenceType === 'rma' ? RMA_PICKUP_TYPE : SUPPLIER_PICKUP_TYPE;

        // Idempotency by receiptId (Escenario 5): a repeat or out-of-order recordVersion is ignored
        // outright, before resolving or touching anything else.
        const [existing]: { record_version: number; status: string; dispatch_id: number | null }[] = await manager.query(
            `SELECT record_version, status, dispatch_id FROM warehouse_receipts WHERE receipt_id = $1 FOR UPDATE`,
            [data.receiptId],
        );
        if (existing && data.recordVersion <= existing.record_version) return { status: 'ignored' };

        // A correction (higher recordVersion) on a receipt that was already applied must never degrade
        // it to orphan just because the dispatch has since moved past picked_up_in_transit — that move
        // is exactly what applying it caused. Only the informational data is updated; the dispatch link
        // and its status stay untouched, and the coordinator is told to review the correction by hand.
        if (existing?.status === 'applied' && existing.dispatch_id !== null) {
            await this.updateReceiptInformational(manager, data);
            return { status: 'correction', dispatchId: existing.dispatch_id };
        }

        const [found]: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, s.name AS status, d.version, d.route_batch_id, d.tracking_code
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
               JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
              WHERE d.source_order_ref = $1 AND t.name = $2
              ORDER BY d.dispatch_id
              LIMIT 1
              FOR UPDATE OF d`,
            [data.referenceId, dispatchType],
        );

        const resolvable = found
            && found.status === 'picked_up_in_transit'
            && (!data.trackingCode || data.trackingCode === found.tracking_code);

        if (!resolvable) {
            await this.saveReceipt(manager, data, null, 'orphan');
            return { status: 'orphan', dispatchId: found?.dispatch_id ?? null, referenceId: data.referenceId };
        }

        const newStatus = this.targetStatus(data);
        await this.saveReceipt(manager, data, found.dispatch_id, 'applied');
        const events = await this.transition(manager, found, data, newStatus, receivedAt);
        return { status: 'applied', dispatchId: found.dispatch_id, newStatus, events };
    }

    private targetStatus(data: InventoryReceiptConfirmedData): string {
        if (data.result !== 'complete') return 'incident';
        return data.referenceType === 'rma' ? 'returned_to_warehouse' : 'delivered';
    }

    private async transition(
        manager: EntityManager,
        found: DispatchRow,
        data: InventoryReceiptConfirmedData,
        newStatus: string,
        receivedAt: Date,
    ): Promise<AppliedReceiptEvents> {
        const closesDispatch = isTerminalDispatchStatus(newStatus);
        // TypeORM answers UPDATE ... RETURNING with `[rows, affectedCount]`, not with the rows.
        const [updatedRows]: [{ version: number; updated_at: Date }[], number] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    closed_at = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,
                    updated_at = NOW()
              WHERE dispatch_id = $1
          RETURNING version, updated_at`,
            [found.dispatch_id, newStatus, closesDispatch, receivedAt],
        );
        const updated = updatedRows[0];

        let incidentReported: AppliedReceiptEvents['incidentReported'];
        if (newStatus === 'incident') {
            const [reason]: { incident_reason_id: number }[] = await manager.query(
                `SELECT incident_reason_id FROM incident_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
                [RECEIPT_DIFFERENCE_REASON_CODE],
            );
            if (!reason) throw new Error(`Incident reason ${RECEIPT_DIFFERENCE_REASON_CODE} is missing.`);
            const incidentId = uuidv7();
            await this.dispatchIncidents.create({
                id: incidentId,
                dispatchId: found.dispatch_id,
                incidentReasonId: reason.incident_reason_id,
                description: data.notes ?? `Warehouse receipt ${data.receiptId}: ${data.result}.`,
                occurredAt: receivedAt,
            }, { manager });
            incidentReported = {
                dispatchId: found.dispatch_id, incidentId, reasonCode: RECEIPT_DIFFERENCE_REASON_CODE,
                reportedAt: receivedAt.toISOString(), criticality: 'high',
            };
        }

        // Same transaction as the transition (ST-240.3): a purchase order's result goes to Compras and an
        // RMA that ends in `incident` to Inventarios. `publish` skips a complete RMA
        // (`returned_to_warehouse`): that outcome is Inventarios' own message. The outbox only writes a row,
        // so a broker outage never blocks this transition.
        const outboundRecordVersion = await this.statusPublication.publish(manager, {
            dispatchId: found.dispatch_id,
            status: newStatus,
            previousStatus: found.status,
            occurredAt: receivedAt,
            receipt: { result: data.result, items: data.items },
        });

        await this.dispatchEvents.create({
            dispatchId: found.dispatch_id,
            eventType: 'status_changed',
            detail: `${found.status} -> ${newStatus}`,
            actorType: 'system',
            reason: 'warehouse_receipt_confirmed',
            metadata: {
                receiptId: data.receiptId, result: data.result, version: updated.version,
                ...(outboundRecordVersion !== null && { outboundRecordVersion }),
            },
            occurredAt: receivedAt,
        }, { manager });

        if (found.route_batch_id !== null) {
            await this.batchClosing.closeIfComplete(manager, found.route_batch_id, {
                dispatchId: found.dispatch_id, dispatchStatus: newStatus, cause: 'warehouse_receipt_confirmed',
            });
        }

        return {
            statusChanged: {
                dispatchId: found.dispatch_id,
                status: newStatus,
                previousStatus: found.status,
                version: updated.version,
                updatedAt: new Date(updated.updated_at).toISOString(),
            },
            ...(incidentReported && { incidentReported }),
        };
    }

    private async saveReceipt(
        manager: EntityManager,
        data: InventoryReceiptConfirmedData,
        dispatchId: number | null,
        status: 'applied' | 'orphan',
    ): Promise<void> {
        await manager.query(
            `INSERT INTO warehouse_receipts
                (receipt_id, dispatch_id, reference_type, reference_id, result, received_at, record_version, notes, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (receipt_id) DO UPDATE SET
                dispatch_id = EXCLUDED.dispatch_id, reference_type = EXCLUDED.reference_type,
                reference_id = EXCLUDED.reference_id, result = EXCLUDED.result, received_at = EXCLUDED.received_at,
                record_version = EXCLUDED.record_version, notes = EXCLUDED.notes, status = EXCLUDED.status,
                updated_at = NOW()`,
            [data.receiptId, dispatchId, data.referenceType, data.referenceId, data.result,
                new Date(data.receivedAt), data.recordVersion, data.notes ?? null, status],
        );
        // A correction (higher recordVersion for the same receiptId) replaces its own items outright.
        await manager.query(`DELETE FROM warehouse_receipt_items WHERE receipt_id = $1`, [data.receiptId]);
        for (const item of data.items ?? []) {
            await manager.query(
                `INSERT INTO warehouse_receipt_items
                    (receipt_id, package_id, item_code, accepted_quantity, missing_quantity, damaged_quantity, detail)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [data.receiptId, item.packageId ?? null, item.itemCode ?? null,
                    item.acceptedQuantity, item.missingQuantity, item.damagedQuantity, item.detail ?? null],
            );
        }
    }

    /**
     * Updates notes/result/received_at/record_version/items of an already-`applied` receipt. Never
     * touches status, dispatch_id, reference_type or reference_id — the dispatch link and its status
     * stay exactly as they are, even if the corrected `result` would otherwise imply a different
     * dispatch status. Whether to transition the dispatch given this correction is a decision for a
     * person acting on the `receipt_correction` attention event, never an automatic transition here.
     */
    private async updateReceiptInformational(manager: EntityManager, data: InventoryReceiptConfirmedData): Promise<void> {
        await manager.query(
            `UPDATE warehouse_receipts
                SET record_version = $2, notes = $3, result = $4, received_at = $5, updated_at = NOW()
              WHERE receipt_id = $1`,
            [data.receiptId, data.recordVersion, data.notes ?? null, data.result, new Date(data.receivedAt)],
        );
        await manager.query(`DELETE FROM warehouse_receipt_items WHERE receipt_id = $1`, [data.receiptId]);
        for (const item of data.items ?? []) {
            await manager.query(
                `INSERT INTO warehouse_receipt_items
                    (receipt_id, package_id, item_code, accepted_quantity, missing_quantity, damaged_quantity, detail)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [data.receiptId, item.packageId ?? null, item.itemCode ?? null,
                    item.acceptedQuantity, item.missingQuantity, item.damagedQuantity, item.detail ?? null],
            );
        }
    }

    private manager(options: TransactionOptions) {
        if (!options.manager) throw new Error('Warehouse receipt processing requires the inbound transaction manager.');
        return options.manager;
    }
}
