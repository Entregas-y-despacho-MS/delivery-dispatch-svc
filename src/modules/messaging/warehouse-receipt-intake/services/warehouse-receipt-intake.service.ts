import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { RouteBatchClosingService } from '../../../../app/route-batch-closing/services/route-batch-closing.service.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { DispatchEventsService } from '../../../dispatch/dispatch-events/services/dispatch-events.service.js';
import { DispatchIncidentsService } from '../../../dispatch/dispatch-incidents/services/dispatch-incidents.service.js';
import { DispatchStatusPublicationService } from '../../../dispatch/dispatch-status-publication/dispatch-status-publication.service.js';
import { isTerminalDispatchStatus } from '../../../dispatch/dispatches/utils/terminal-statuses.js';
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

export type ApplyReceiptResult =
    | { status: 'applied'; dispatchId: number; newStatus: string }
    | { status: 'orphan'; dispatchId: number | null; referenceId: string }
    | { status: 'ignored' };

/**
 * Applies one `inventory.receipt.confirmed` message (ST-240.2, ES-240) inside the caller's
 * transaction: resolves the traslado it confirms, saves the receipt and its items, transitions the
 * dispatch (or leaves it untouched and marks the receipt `orphan`), and evaluates whether its batch
 * can close.
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
        const [existing]: { record_version: number }[] = await manager.query(
            `SELECT record_version FROM warehouse_receipts WHERE receipt_id = $1`,
            [data.receiptId],
        );
        if (existing && data.recordVersion <= existing.record_version) return { status: 'ignored' };

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
        await this.transition(manager, found, data, newStatus, receivedAt);
        return { status: 'applied', dispatchId: found.dispatch_id, newStatus };
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
    ): Promise<void> {
        const closesDispatch = isTerminalDispatchStatus(newStatus);
        const [updated]: { version: number }[] = await manager.query(
            `UPDATE dispatches
                SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                    closed_at = CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,
                    updated_at = NOW()
              WHERE dispatch_id = $1
          RETURNING version`,
            [found.dispatch_id, newStatus, closesDispatch, receivedAt],
        );

        if (newStatus === 'incident') {
            const [reason]: { incident_reason_id: number }[] = await manager.query(
                `SELECT incident_reason_id FROM incident_reasons WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
                [RECEIPT_DIFFERENCE_REASON_CODE],
            );
            if (!reason) throw new Error(`Incident reason ${RECEIPT_DIFFERENCE_REASON_CODE} is missing.`);
            await this.dispatchIncidents.create({
                id: uuidv7(),
                dispatchId: found.dispatch_id,
                incidentReasonId: reason.incident_reason_id,
                description: data.notes ?? `Warehouse receipt ${data.receiptId}: ${data.result}.`,
                occurredAt: receivedAt,
            }, { manager });
        }

        if (data.referenceType === 'purchase_order') {
            await this.statusPublication.publishTransferUpdate(manager, {
                dispatchId: found.dispatch_id,
                status: newStatus,
                previousStatus: found.status,
                occurredAt: receivedAt,
            });
        }

        await this.dispatchEvents.create({
            dispatchId: found.dispatch_id,
            eventType: 'status_changed',
            detail: `${found.status} -> ${newStatus}`,
            actorType: 'system',
            reason: 'warehouse_receipt_confirmed',
            metadata: { receiptId: data.receiptId, result: data.result, version: updated.version },
            occurredAt: receivedAt,
        }, { manager });

        if (found.route_batch_id !== null) {
            await this.batchClosing.closeIfComplete(manager, found.route_batch_id, {
                dispatchId: found.dispatch_id, dispatchStatus: newStatus, cause: 'warehouse_receipt_confirmed',
            });
        }
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

    private manager(options: TransactionOptions) {
        if (!options.manager) throw new Error('Warehouse receipt processing requires the inbound transaction manager.');
        return options.manager;
    }
}
