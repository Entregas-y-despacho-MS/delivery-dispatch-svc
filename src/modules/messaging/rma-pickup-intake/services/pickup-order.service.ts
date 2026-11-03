import { Injectable } from '@nestjs/common';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { RmaPickupRequestedData } from '../domain/rma-pickup-message.types.js';

interface WarehouseRow {
    warehouse_id: number;
}

interface CreatedDispatch {
    dispatchId: number;
    status: 'pickup_scheduled' | 'address_review';
}

/**
 * Creates pickup orders (`dispatch_type = warehouse_return_pickup`). `createFromRma` is used by the
 * `inventory.return.requested` consumer (ST-238.2); `ST-81.2` will add `createManual`/`cancel`/`list`
 * to this same class for the coordinator's manual recojos.
 */
@Injectable()
export class PickupOrderService {
    /** Throws `RejectedMessageException('unknown_warehouse')` before writing anything. */
    async createFromRma(data: RmaPickupRequestedData, options: TransactionOptions): Promise<CreatedDispatch> {
        const manager = this.manager(options);
        const warehouseId = await this.warehouseIdByCode(data.warehouseId, options);
        if (warehouseId === null) {
            throw new RejectedMessageException(
                [{ path: '/data/warehouseId', keyword: 'unknownWarehouse', message: `Unknown warehouse ${data.warehouseId}.` }],
                'unknown_warehouse',
            );
        }

        const status: CreatedDispatch['status'] = data.pickupAddress.location ? 'pickup_scheduled' : 'address_review';
        const estimatedBoxes = data.packages?.length ?? null;
        const [created] = (await manager.query(
            `INSERT INTO dispatches (
                dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, delivery_reference,
                delivery_latitude, delivery_longitude, contact_name, contact_phone, contact_email,
                return_reason, destination_warehouse_id, estimated_boxes, preferred_pickup_date
             ) VALUES (
                (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
             ) RETURNING dispatch_id`,
            [
                status,
                data.rmaId,
                data.pickupAddress.line,
                data.pickupAddress.reference ?? null,
                data.pickupAddress.location?.latitude ?? null,
                data.pickupAddress.location?.longitude ?? null,
                data.contact.name,
                data.contact.phone,
                data.contact.email ?? null,
                data.returnReason,
                warehouseId,
                estimatedBoxes,
                data.preferredPickupDate ?? null,
            ],
        )) as { dispatch_id: number }[];
        const dispatchId = created.dispatch_id;

        for (const pkg of data.packages ?? []) {
            await manager.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [dispatchId, pkg.packageId, pkg.lengthCm, pkg.widthCm, pkg.heightCm, pkg.grossWeightKg],
            );
        }

        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata)
             VALUES ($1, 'created_from_rma', 'system', $2::jsonb)`,
            [
                dispatchId,
                JSON.stringify({
                    source: 'inventory',
                    rmaId: data.rmaId,
                    salesOrderId: data.salesOrderId ?? null,
                    recordVersion: data.recordVersion,
                    approvedAt: data.approvedAt,
                }),
            ],
        );

        return { dispatchId, status };
    }

    private async warehouseIdByCode(code: string, options: TransactionOptions): Promise<number | null> {
        const [row] = (await this.manager(options).query(
            `SELECT warehouse_id FROM warehouses WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [code],
        )) as WarehouseRow[];
        return row?.warehouse_id ?? null;
    }

    private manager(options: TransactionOptions) {
        if (!options.manager) throw new Error('Pickup order creation requires the inbound transaction manager.');
        return options.manager;
    }
}
