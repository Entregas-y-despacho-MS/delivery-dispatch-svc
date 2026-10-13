import { Injectable } from '@nestjs/common';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type {
    ProcurementPickupCancelledData,
    ProcurementPickupProduct,
    ProcurementPickupRequestedData,
    ProcurementPickupUpdatedData,
} from '../domain/procurement-pickup-message.types.js';

interface DispatchRow {
    dispatch_id: number;
    status: string;
    delivery_address: string;
    scheduled_window_start: Date | null;
    scheduled_window_end: Date | null;
    destination_warehouse_id: number | null;
}

interface WarehouseRow {
    warehouse_id: number;
}

type EditableStatus = 'pending' | 'address_review' | 'scheduled';
const EDITABLE_STATUSES = new Set<EditableStatus>(['pending', 'address_review', 'scheduled']);
const ADDRESS_REVIEW_PLACEHOLDER = 'Pendiente de corrección';

@Injectable()
export class ProcurementPickupRepository {
    async applyRequested(data: ProcurementPickupRequestedData, options: TransactionOptions): Promise<void> {
        const manager = this.manager(options);
        const current = await this.find(data.purchaseOrderId, options);
        if (current && !this.isEditable(current.status)) {
            await this.alertCoordinator('supplier_pickup_request_after_terminal_state', data.purchaseOrderId, current, options);
            return;
        }

        const destinationWarehouseId = data.warehouseId
            ? await this.warehouseId(data.warehouseId, options)
            : null;
        const missingFields = this.missingFields({
            address: data.pickupAddress?.line,
            startsAt: data.pickupWindow?.startsAt,
            endsAt: data.pickupWindow?.endsAt,
            destinationWarehouseId,
        });
        const status = missingFields.length > 0 ? 'address_review' : 'pending';
        const address = data.pickupAddress?.line ?? ADDRESS_REVIEW_PLACEHOLDER;
        const values = [
            status, data.purchaseOrderId, address, data.pickupAddress?.reference ?? null,
            data.pickupAddress?.location?.latitude ?? null, data.pickupAddress?.location?.longitude ?? null,
            data.contact?.name ?? null, data.contact?.phone ?? null, data.contact?.email ?? null,
            data.pickupWindow?.startsAt ?? null, data.pickupWindow?.endsAt ?? null,
            data.approvedAt ?? null, destinationWarehouseId,
            data.estimates?.packages ?? null, data.estimates?.weightKg ?? null, data.estimates?.volumeM3 ?? null,
        ];

        let dispatchId: number;
        if (current) {
            dispatchId = current.dispatch_id;
            await manager.query(
                `UPDATE dispatches SET
                    dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                    delivery_address = $3, delivery_reference = $4, delivery_latitude = $5, delivery_longitude = $6,
                    contact_name = $7, contact_phone = $8, contact_email = $9,
                    scheduled_window_start = $10, scheduled_window_end = $11, order_confirmed_at = $12,
                    destination_warehouse_id = $13, estimated_boxes = $14,
                    estimated_weight_kg = $15, estimated_volume_m3 = $16, updated_at = NOW()
                 WHERE dispatch_id = $2`,
                [status, dispatchId, ...values.slice(2)],
            );
        } else {
            const [created] = await manager.query(
                `INSERT INTO dispatches (
                    dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, delivery_reference,
                    delivery_latitude, delivery_longitude, contact_name, contact_phone, contact_email,
                    scheduled_window_start, scheduled_window_end, order_confirmed_at, destination_warehouse_id,
                    estimated_boxes, estimated_weight_kg, estimated_volume_m3
                 ) VALUES (
                    (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup'),
                    (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                    $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
                 ) RETURNING dispatch_id`,
                values,
            ) as { dispatch_id: number }[];
            dispatchId = created.dispatch_id;
        }

        await this.replaceItems(dispatchId, data.products, options);
        await this.recordEvent(dispatchId, current ? 'supplier_pickup_updated' : 'created', {
            source: 'procurement',
            purchaseOrderId: data.purchaseOrderId,
            recordVersion: data.recordVersion,
            supplier: data.supplier,
            missingFields,
        }, options);
        if (missingFields.length > 0) {
            await this.recordAddressReview(dispatchId, data.purchaseOrderId, missingFields, options);
        }
    }

    async applyUpdated(data: ProcurementPickupUpdatedData, options: TransactionOptions): Promise<void> {
        const manager = this.manager(options);
        const current = await this.find(data.purchaseOrderId, options);
        if (!current) return;
        if (!this.isEditable(current.status)) {
            await this.alertCoordinator('supplier_pickup_update_requires_coordinator', data.purchaseOrderId, current, options);
            return;
        }

        const sets: string[] = [];
        const values: unknown[] = [];
        const add = (column: string, value: unknown): void => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };

        if (data.pickupAddress !== undefined) {
            add('delivery_address', data.pickupAddress.line);
            add('delivery_reference', data.pickupAddress.reference ?? null);
            add('delivery_latitude', data.pickupAddress.location?.latitude ?? null);
            add('delivery_longitude', data.pickupAddress.location?.longitude ?? null);
        }
        if (data.contact !== undefined) {
            add('contact_name', data.contact.name);
            add('contact_phone', data.contact.phone);
            add('contact_email', data.contact.email ?? null);
        }
        if (data.pickupWindow !== undefined) {
            add('scheduled_window_start', data.pickupWindow.startsAt);
            add('scheduled_window_end', data.pickupWindow.endsAt);
        }
        let destinationWarehouseId = current.destination_warehouse_id;
        if (data.warehouseId !== undefined) {
            destinationWarehouseId = await this.warehouseId(data.warehouseId, options);
            add('destination_warehouse_id', destinationWarehouseId);
        }
        if (data.estimates !== undefined) {
            add('estimated_boxes', data.estimates.packages ?? null);
            add('estimated_weight_kg', data.estimates.weightKg ?? null);
            add('estimated_volume_m3', data.estimates.volumeM3 ?? null);
        }

        const address = data.pickupAddress?.line ?? current.delivery_address;
        const startsAt = data.pickupWindow?.startsAt ?? current.scheduled_window_start?.toISOString();
        const endsAt = data.pickupWindow?.endsAt ?? current.scheduled_window_end?.toISOString();
        const missingFields = this.missingFields({ address, startsAt, endsAt, destinationWarehouseId });
        const status = missingFields.length > 0 ? 'address_review' : 'pending';
        values.push(status, current.dispatch_id);
        sets.push(`dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $${values.length - 1})`);
        sets.push('updated_at = NOW()');
        await manager.query(`UPDATE dispatches SET ${sets.join(', ')} WHERE dispatch_id = $${values.length}`, values);

        if (data.products !== undefined) await this.replaceItems(current.dispatch_id, data.products, options);
        await this.recordEvent(current.dispatch_id, 'supplier_pickup_updated', {
            source: 'procurement', purchaseOrderId: data.purchaseOrderId, recordVersion: data.recordVersion,
            ...(data.supplier ? { supplier: data.supplier } : {}), missingFields,
        }, options);
        if (missingFields.length > 0) {
            await this.recordAddressReview(current.dispatch_id, data.purchaseOrderId, missingFields, options);
        }
    }

    async applyCancelled(data: ProcurementPickupCancelledData, options: TransactionOptions): Promise<void> {
        const current = await this.find(data.purchaseOrderId, options);
        if (!current) return;
        if (!this.isEditable(current.status)) {
            await this.alertCoordinator('supplier_pickup_cancel_requires_coordinator', data.purchaseOrderId, current, options);
            return;
        }

        const manager = this.manager(options);
        await manager.query(
            `UPDATE dispatches
             SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'cancelled'),
                 updated_at = NOW()
             WHERE dispatch_id = $1`,
            [current.dispatch_id],
        );
        await this.recordEvent(current.dispatch_id, 'status_changed', {
            source: 'procurement', purchaseOrderId: data.purchaseOrderId, recordVersion: data.recordVersion,
            status: 'cancelled', cancelledAt: data.cancelledAt, reason: data.reason ?? null,
        }, options);
    }

    private async find(purchaseOrderId: string, options: TransactionOptions): Promise<DispatchRow | null> {
        const [row] = await this.manager(options).query(
            `SELECT d.dispatch_id, s.name AS status, d.delivery_address,
                    d.scheduled_window_start, d.scheduled_window_end, d.destination_warehouse_id
             FROM dispatches d
             JOIN dispatch_types t ON t.dispatch_type_id = d.dispatch_type_id
             JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
             WHERE t.name = 'supplier_pickup' AND d.source_order_ref = $1
             ORDER BY d.dispatch_id LIMIT 1 FOR UPDATE OF d`,
            [purchaseOrderId],
        ) as DispatchRow[];
        return row ?? null;
    }

    private async warehouseId(code: string, options: TransactionOptions): Promise<number | null> {
        const [row] = await this.manager(options).query(
            `SELECT warehouse_id FROM warehouses
             WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [code],
        ) as WarehouseRow[];
        return row?.warehouse_id ?? null;
    }

    private async replaceItems(dispatchId: number, products: ProcurementPickupProduct[], options: TransactionOptions): Promise<void> {
        const manager = this.manager(options);
        await manager.query('DELETE FROM dispatch_pickup_items WHERE dispatch_id = $1', [dispatchId]);
        for (const product of products) {
            await manager.query(
                `INSERT INTO dispatch_pickup_items (dispatch_id, item_code, description, expected_quantity)
                 VALUES ($1, $2, $3, $4)`,
                [dispatchId, product.productId, product.description ?? product.productId, product.quantity],
            );
        }
    }

    private missingFields(input: {
        address: string | undefined;
        startsAt: string | Date | undefined;
        endsAt: string | Date | undefined;
        destinationWarehouseId: number | null;
    }): string[] {
        const missing: string[] = [];
        if (!input.address || input.address === ADDRESS_REVIEW_PLACEHOLDER) missing.push('pickupAddress');
        if (!input.startsAt || !input.endsAt) missing.push('pickupWindow');
        if (input.destinationWarehouseId === null) missing.push('warehouseId');
        return missing;
    }

    private isEditable(status: string): status is EditableStatus {
        return EDITABLE_STATUSES.has(status as EditableStatus);
    }

    private async recordEvent(
        dispatchId: number,
        eventType: string,
        metadata: Record<string, unknown>,
        options: TransactionOptions,
    ): Promise<void> {
        await this.manager(options).query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata)
             VALUES ($1, $2, 'system', $3::jsonb)`,
            [dispatchId, eventType, JSON.stringify(metadata)],
        );
    }

    private async recordAddressReview(
        dispatchId: number,
        purchaseOrderId: string,
        missingFields: string[],
        options: TransactionOptions,
    ): Promise<void> {
        await this.manager(options).query(
            `INSERT INTO audit_logs (action, detail)
             VALUES ('dispatch_address_review_required', $1)`,
            [JSON.stringify({ dispatchId, purchaseOrderId, source: 'procurement', missingFields })],
        );
    }

    private async alertCoordinator(
        action: string,
        purchaseOrderId: string,
        dispatch: DispatchRow,
        options: TransactionOptions,
    ): Promise<void> {
        await this.manager(options).query(
            `INSERT INTO audit_logs (action, detail) VALUES ($1, $2)`,
            [action, JSON.stringify({ purchaseOrderId, dispatchId: dispatch.dispatch_id, status: dispatch.status })],
        );
    }

    private manager(options: TransactionOptions) {
        if (!options.manager) throw new Error('Supplier pickup handling requires the inbound transaction manager.');
        return options.manager;
    }
}
