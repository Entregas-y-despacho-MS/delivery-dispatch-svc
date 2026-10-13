import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ConsolidatedOrder } from '../../../messaging/sales-order-intake/domain/consolidated-order.types.js';
import { DispatchGenerator, type CreatedDispatch } from '../../../messaging/sales-order-intake/ports/dispatch-generator.port.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import { calculateServiceTerm } from './service-term.js';

interface IdRow { id: number }
interface SettingRow { setting_key: string; setting_value: string }

/** ST-49.1: creates one delivery and all its packages inside the caller's message transaction. */
@Injectable()
export class TypeOrmDispatchGenerator extends DispatchGenerator {
    async createFromConsolidated(order: ConsolidatedOrder, options: TransactionOptions): Promise<CreatedDispatch> {
        const manager = options.manager;
        if (!manager) throw new Error('Dispatch generation requires the inbound message transaction manager.');
        if (!order.packages.length) throw new Error('A consolidated order requires at least one package.');

        const [warehouse] = await manager.query(
            `SELECT warehouse_id AS id FROM warehouses WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
            [order.warehouseId],
        ) as IdRow[];
        if (!warehouse) throw new Error(`Unknown or inactive warehouse: ${order.warehouseId}`);

        const location = order.deliveryAddress.location;
        const validLocation = location !== undefined
            && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
            && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
        const [zone] = validLocation ? await manager.query(
            `SELECT delivery_zone_id AS id FROM delivery_zones
             WHERE deleted_at IS NULL AND boundary IS NOT NULL
               AND boundary @> point($1::float8, $2::float8)
             ORDER BY delivery_zone_id LIMIT 1`,
            [location.longitude, location.latitude],
        ) as IdRow[] : [];
        const addressReview = !zone;

        const settings = await manager.query(
            `SELECT setting_key, setting_value FROM settings WHERE setting_key IN
             ('service_min_operating_days', 'service_max_operating_days',
              'plan_working_days', 'plan_non_working_dates')`,
        ) as SettingRow[];
        const values = new Map(settings.map(({ setting_key, setting_value }) => [setting_key, setting_value]));
        const required = (key: string): string => {
            const value = values.get(key);
            if (value === undefined) throw new Error(`Missing service term setting: ${key}`);
            return value;
        };
        const term = calculateServiceTerm(
            order.confirmedAt,
            Number(required('service_min_operating_days')),
            Number(required('service_max_operating_days')),
            new Set(required('plan_working_days').split(',').map(Number)),
            new Set(required('plan_non_working_dates').split(',').filter(Boolean)),
        );

        const [dispatch] = await manager.query(
            `INSERT INTO dispatches (
                dispatch_type_id, dispatch_status_id, source_order_ref, priority,
                delivery_address, delivery_reference, delivery_latitude, delivery_longitude,
                delivery_zone_id, contact_name, contact_phone, contact_email,
                payment_status_label, evidence_policy, package_ready_at,
                order_confirmed_at, origin_warehouse_id, tracking_code, shipment_ready
             ) VALUES (
                (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1),
                $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                'paid', $12, $13, $14, $15, next_tracking_code(), TRUE
             ) RETURNING dispatch_id AS id`,
            [
                addressReview ? 'address_review' : 'pending',
                order.salesOrderId, order.priority, order.deliveryAddress.line,
                order.deliveryAddress.reference ?? null,
                validLocation ? location.latitude : null,
                validLocation ? location.longitude : null,
                zone?.id ?? null,
                order.recipient.name, order.recipient.phone, order.recipient.email ?? null,
                order.evidencePolicy, order.physicallyPacked ? new Date() : null,
                new Date(order.confirmedAt), warehouse.id,
            ],
        ) as IdRow[];

        for (const item of order.packages) {
            await manager.query(
                `INSERT INTO dispatch_packages (
                    dispatch_id, external_package_id, length_cm, width_cm, height_cm,
                    gross_weight_kg, handling_conditions
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [dispatch.id, item.packageId, item.lengthCm, item.widthCm, item.heightCm,
                    item.grossWeightKg, order.handlingConditions],
            );
        }

        // No scheduled window or tracking token is set here. The planning flow owns both.
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata)
             VALUES ($1, 'created', 'system', $2::jsonb)`,
            [dispatch.id, JSON.stringify({
                source: 'marketplace_inventory',
                serviceTerm: term,
                addressReview,
            })],
        );
        if (addressReview) await this.recordAddressReview(manager, dispatch.id, order.salesOrderId);
        return { dispatchId: dispatch.id };
    }

    private async recordAddressReview(manager: EntityManager, dispatchId: number, salesOrderId: string): Promise<void> {
        // The coordinator's inbox exposes address_review as read-only. This audit record makes
        // the reason visible to the future coordinator alert surface without emitting before commit.
        await manager.query(
            `INSERT INTO audit_logs (action, detail) VALUES ('dispatch_address_review_required', $1)`,
            [JSON.stringify({ dispatchId, salesOrderId, reason: 'missing_or_uncovered_location' })],
        );
    }
}
