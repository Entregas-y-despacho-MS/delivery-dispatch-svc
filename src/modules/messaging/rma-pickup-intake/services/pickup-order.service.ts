import { Injectable } from '@nestjs/common';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import type { ManualPickupCreated, ManualPickupInput } from '../domain/manual-pickup.types.js';
import type { RmaPickupRequestedData } from '../domain/rma-pickup-message.types.js';
import { WarehouseNotAvailableException } from '../exceptions/index.js';

/**
 * Prefix of the `source_order_ref` of the pickups registered by hand (`MANUAL-<tracking code>`): it is how the origin
 * (`manual` or `rma`) is told apart, so no RMA id may start with it (ST-81.2).
 */
export const MANUAL_SOURCE_REF_PREFIX = 'MANUAL-';

interface WarehouseRow {
    warehouse_id: number;
}

interface CreatedDispatch {
    dispatchId: number;
    status: 'pickup_scheduled' | 'address_review';
}

/**
 * Creates pickup orders (`dispatch_type = warehouse_return_pickup`). `createFromRma` is used by the
 * `inventory.return.requested` consumer (ST-238.2); `createManual` by the coordinator's form (ST-81.2). Both write
 * inside the transaction the caller opens.
 */
@Injectable()
export class PickupOrderService {
    /**
     * Throws `RejectedMessageException` before writing anything: `reserved_rma_prefix` when the `rmaId` starts with
     * `MANUAL-` (reserved for the pickups the coordinator registers by hand, whose origin is derived from that prefix,
     * ST-81.2) and `unknown_warehouse` when the warehouse does not exist.
     */
    async createFromRma(data: RmaPickupRequestedData, options: TransactionOptions): Promise<CreatedDispatch> {
        const manager = this.manager(options);
        if (data.rmaId.startsWith(MANUAL_SOURCE_REF_PREFIX)) {
            throw new RejectedMessageException(
                [{ path: '/data/rmaId', keyword: 'reservedPrefix', message: `rmaId must not start with ${MANUAL_SOURCE_REF_PREFIX}.` }],
                'reserved_rma_prefix',
            );
        }
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
                return_reason, destination_warehouse_id, estimated_boxes, preferred_pickup_date, tracking_code
             ) VALUES (
                (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, next_tracking_code()
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

    /**
     * Registers a pickup by hand (ST-81.2) inside the caller's transaction. It always starts in `pickup_scheduled`
     * (the form marks the point on the map, so the coordinates are required) and its `source_order_ref` is
     * `MANUAL-<tracking code>`, which is how the origin is told apart from an RMA. The RMA the coordinator may mention
     * goes only in the metadata of the `created_manually` event: as `source_order_ref` it would collide with the
     * unique index when the message of that RMA arrives later.
     * Throws `WarehouseNotAvailableException` (422) before writing anything when the warehouse is not usable.
     */
    async createManual(input: ManualPickupInput, userId: number, options: TransactionOptions): Promise<ManualPickupCreated> {
        const manager = this.manager(options);
        const warehouseId = await this.warehouseIdByCode(input.warehouseCode, options);
        if (warehouseId === null) throw new WarehouseNotAvailableException(input.warehouseCode);

        const [{ code: trackingCode }] = (await manager.query('SELECT next_tracking_code() AS code')) as { code: string }[];
        const sourceOrderRef = `${MANUAL_SOURCE_REF_PREFIX}${trackingCode}`;
        const [created] = (await manager.query(
            `INSERT INTO dispatches (
                dispatch_type_id, dispatch_status_id, source_order_ref, tracking_code, delivery_address, delivery_reference,
                delivery_latitude, delivery_longitude, contact_name, contact_phone, contact_email,
                return_reason, package_contents, destination_warehouse_id, estimated_boxes, preferred_pickup_date
             ) VALUES (
                (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'pickup_scheduled'),
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                ($14::date)::timestamp AT TIME ZONE 'America/La_Paz'
             ) RETURNING dispatch_id`,
            [
                sourceOrderRef,
                trackingCode,
                input.address,
                input.reference ?? null,
                input.latitude,
                input.longitude,
                input.contactName,
                input.contactPhone,
                input.contactEmail ?? null,
                input.returnReason,
                input.packageContents,
                warehouseId,
                input.estimatedBoxes ?? null,
                input.preferredPickupDate,
            ],
        )) as { dispatch_id: number }[];
        const dispatchId = created.dispatch_id;

        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, metadata)
             VALUES ($1, 'created_manually', $2, 'user', $3::jsonb)`,
            [
                dispatchId,
                userId,
                JSON.stringify({
                    source: 'manual',
                    rmaId: input.rmaId ?? null,
                    warehouseCode: input.warehouseCode,
                    preferredPickupDate: input.preferredPickupDate,
                }),
            ],
        );

        return { dispatchId, status: 'pickup_scheduled', trackingCode, sourceOrderRef };
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
