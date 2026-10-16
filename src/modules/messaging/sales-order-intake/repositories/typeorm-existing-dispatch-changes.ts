import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';
import { RejectedMessageException } from '../../../../plugins/messaging/exceptions/rejected-message.exception.js';
import type { TransactionOptions } from '../../../../plugins/messaging/inbound-message-transaction.port.js';
import {
    isUsableLocation,
    planCancellation,
    planDeliveryChange,
    planShipmentReadiness,
    statusAfterEdit,
    type ColumnChanges,
    type DispatchSnapshot,
} from '../domain/dispatch-change.rules.js';
import { planShipmentChange, type ShipmentDispatchSnapshot } from '../domain/shipment-change.rules.js';
import {
    ExistingDispatchChanges,
    type ChangeSource,
    type DispatchChangeOutcome,
} from '../ports/existing-dispatch-changes.port.js';

/** Name of the `dispatch_statuses` row of an order proposed in a provisional batch. */
const IN_PLANNING = 'in_planning';

interface DispatchRow {
    dispatch_id: number;
    status: string;
    route_batch_id: number | null;
    contact_name: string | null;
    contact_phone: string | null;
    contact_email: string | null;
    delivery_address: string;
    delivery_reference: string | null;
    delivery_latitude: string | null;
    delivery_longitude: string | null;
    delivery_zone_id: number | null;
    priority: string;
    shipment_ready: boolean;
}

/** Columns that `ColumnChanges` can set, by the name the rules use. */
const COLUMN_OF: Record<keyof ColumnChanges, string> = {
    contactName: 'contact_name',
    contactPhone: 'contact_phone',
    contactEmail: 'contact_email',
    deliveryAddress: 'delivery_address',
    deliveryReference: 'delivery_reference',
    deliveryLatitude: 'delivery_latitude',
    deliveryLongitude: 'delivery_longitude',
    priority: 'priority',
};

/**
 * `ExistingDispatchChanges` on top of `dispatches` and `dispatch_events`, with plain SQL like the
 * dispatch generator (ST-49.1). Everything runs in `options.manager`: the change, its event and
 * the receipt of the message commit together.
 *
 * Leaving the proposed batch is a planning move (D-09), so it raises the `version` of the dispatch
 * and of the batch it leaves; a coordinator who was reviewing that batch gets a 409 instead of
 * approving a stale plan.
 */
@Injectable()
export class TypeOrmExistingDispatchChanges extends ExistingDispatchChanges {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {
        super();
    }

    async applyDeliveryChange(
        input: Parameters<ExistingDispatchChanges['applyDeliveryChange']>[0],
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome> {
        const manager = this.managerOf(options);
        const snapshot = await this.lock(manager, input.salesOrderId);
        if (!snapshot) return { status: 'no_dispatch' };

        const plan = planDeliveryChange(snapshot, input.blocks);
        if (plan.kind === 'ignore') {
            return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: plan.reason };
        }
        if (plan.kind === 'attention') {
            return await this.raiseAttention(manager, snapshot, {
                source: input.source,
                changeType: 'order_changed',
                receivedAt: input.receivedAt,
                changedBlocks: plan.changedBlocks,
            });
        }
        if (Object.keys(plan.columns).length === 0) {
            return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: 'no_change' };
        }

        const location = input.blocks.deliveryAddress?.location;
        const zoneId = plan.locationChanged && isUsableLocation(location) ? await this.findZone(manager, location) : null;
        const statusAfter = statusAfterEdit({
            current: snapshot.status,
            removedFromProposal: plan.removeFromProposal,
            locationChanged: plan.locationChanged,
            hasZone: zoneId !== null,
        });

        const sets: string[] = [];
        const params: unknown[] = [snapshot.dispatchId];
        const push = (sql: string, value: unknown) => {
            params.push(value);
            sets.push(sql.replace('?', `$${params.length}`));
        };
        for (const key of Object.keys(plan.columns) as (keyof ColumnChanges)[]) {
            push(`${COLUMN_OF[key]} = ?`, plan.columns[key]);
        }
        if (plan.locationChanged) push('delivery_zone_id = ?', zoneId);
        if (statusAfter !== snapshot.status) {
            push('dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = ?)', statusAfter);
        }
        if (plan.removeFromProposal) await this.leaveBatch(manager, snapshot, sets);
        sets.push('updated_at = NOW()');

        await manager.query(`UPDATE dispatches SET ${sets.join(', ')} WHERE dispatch_id = $1`, params);
        await this.recordEvent(manager, snapshot.dispatchId, 'order_changed', {
            source: input.source,
            receivedAt: input.receivedAt,
            changedBlocks: plan.changedBlocks,
            changes: plan.diff,
            statusBefore: snapshot.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
        });

        return {
            status: 'applied',
            dispatchId: snapshot.dispatchId,
            statusBefore: snapshot.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: Object.keys(plan.columns),
        };
    }

    async cancel(
        input: Parameters<ExistingDispatchChanges['cancel']>[0],
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome> {
        const manager = this.managerOf(options);
        const snapshot = await this.lock(manager, input.salesOrderId);
        if (!snapshot) return { status: 'no_dispatch' };

        const plan = planCancellation(snapshot);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: plan.reason };
        if (plan.kind === 'attention') {
            return await this.raiseAttention(manager, snapshot, {
                source: input.source,
                changeType: 'order_cancelled',
                receivedAt: input.cancelledAt,
                reason: input.reason,
            });
        }

        const sets = [
            `dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'cancelled')`,
            'updated_at = NOW()',
        ];
        if (plan.removeFromProposal) await this.leaveBatch(manager, snapshot, sets);

        await manager.query(`UPDATE dispatches SET ${sets.join(', ')} WHERE dispatch_id = $1`, [snapshot.dispatchId]);
        await this.recordEvent(manager, snapshot.dispatchId, 'status_changed', {
            source: input.source,
            from: snapshot.status,
            to: 'cancelled',
            reasonCode: 'order_cancelled',
            cancelledAt: input.cancelledAt,
            reason: input.reason ?? null,
            removedFromProposal: plan.removeFromProposal,
        });

        return {
            status: 'applied',
            dispatchId: snapshot.dispatchId,
            statusBefore: snapshot.status,
            statusAfter: 'cancelled',
            removedFromProposal: plan.removeFromProposal,
            changedFields: ['status'],
        };
    }

    async setShipmentReady(
        input: Parameters<ExistingDispatchChanges['setShipmentReady']>[0],
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome> {
        const manager = this.managerOf(options);
        const snapshot = await this.lock(manager, input.salesOrderId);
        if (!snapshot) return { status: 'no_dispatch' };

        const plan = planShipmentReadiness(snapshot, input.ready);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: plan.reason };
        if (plan.kind === 'noop') return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: 'no_change' };
        if (plan.kind === 'attention') {
            return await this.raiseAttention(manager, snapshot, {
                source: input.source,
                changeType: 'order_changed',
                receivedAt: input.receivedAt,
                changedBlocks: ['shipment_ready'],
                reason: input.reason,
            });
        }

        const statusAfter = statusAfterEdit({
            current: snapshot.status,
            removedFromProposal: plan.removeFromProposal,
            locationChanged: false,
            hasZone: true,
        });
        const params: unknown[] = [snapshot.dispatchId, plan.ready];
        const sets = ['shipment_ready = $2', 'updated_at = NOW()'];
        if (statusAfter !== snapshot.status) {
            params.push(statusAfter);
            sets.push(`dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $${params.length})`);
        }
        if (plan.removeFromProposal) await this.leaveBatch(manager, snapshot, sets);

        await manager.query(`UPDATE dispatches SET ${sets.join(', ')} WHERE dispatch_id = $1`, params);
        await this.recordEvent(manager, snapshot.dispatchId, 'shipment_readiness_changed', {
            source: input.source,
            receivedAt: input.receivedAt,
            ready: plan.ready,
            reason: input.reason ?? null,
            statusBefore: snapshot.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
        });

        return {
            status: 'applied',
            dispatchId: snapshot.dispatchId,
            statusBefore: snapshot.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: ['shipment_ready'],
        };
    }

    async applyShipmentChange(
        input: Parameters<ExistingDispatchChanges['applyShipmentChange']>[0],
        options: TransactionOptions,
    ): Promise<DispatchChangeOutcome> {
        const manager = this.managerOf(options);
        const delivery = await this.lock(manager, input.salesOrderId);
        if (!delivery) return { status: 'no_dispatch' };

        const snapshot = await this.shipmentSnapshotOf(manager, delivery);
        const plan = planShipmentChange(snapshot, input.blocks);

        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: plan.reason };
        if (plan.kind === 'noop') return { status: 'ignored', dispatchId: snapshot.dispatchId, reason: 'no_change' };
        if (plan.kind === 'attention') {
            return await this.raiseAttention(manager, delivery, {
                source: input.source,
                changeType: 'order_changed',
                receivedAt: input.receivedAt,
                changedBlocks: plan.changedBlocks,
                changes: plan.diff,
            });
        }

        // The code of the new origin warehouse is resolved before anything is written; a code that does
        // not exist (or is inactive) is a rejected message, so the transaction rolls back.
        let originWarehouseId: number | null = null;
        if (plan.warehouseCode !== null) {
            const [warehouse]: { id: number }[] = await manager.query(
                `SELECT warehouse_id AS id FROM warehouses WHERE code = $1 AND active = TRUE AND deleted_at IS NULL`,
                [plan.warehouseCode],
            );
            if (!warehouse) {
                throw new RejectedMessageException(
                    [
                        {
                            path: '/data/warehouseId',
                            keyword: 'unknownWarehouse',
                            message: `Warehouse code ${plan.warehouseCode} does not exist or is inactive.`,
                        },
                    ],
                    'unknown_warehouse',
                );
            }
            originWarehouseId = warehouse.id;
        }

        // The packages are upserted by `external_package_id` and the ones that are no longer sent are
        // deleted, so a package that did not change keeps its row (and its id).
        if (plan.packages !== null) {
            for (const item of plan.packages) {
                await manager.query(
                    `INSERT INTO dispatch_packages
                        (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg, handling_conditions)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (dispatch_id, external_package_id) DO UPDATE SET
                        length_cm = EXCLUDED.length_cm,
                        width_cm = EXCLUDED.width_cm,
                        height_cm = EXCLUDED.height_cm,
                        gross_weight_kg = EXCLUDED.gross_weight_kg,
                        handling_conditions = EXCLUDED.handling_conditions,
                        updated_at = NOW()`,
                    [
                        snapshot.dispatchId,
                        item.packageId,
                        item.lengthCm,
                        item.widthCm,
                        item.heightCm,
                        item.grossWeightKg,
                        item.handlingConditions,
                    ],
                );
            }
            await manager.query(
                `DELETE FROM dispatch_packages WHERE dispatch_id = $1 AND external_package_id <> ALL($2::text[])`,
                [snapshot.dispatchId, plan.packages.map((item) => item.packageId)],
            );
        }

        const params: unknown[] = [snapshot.dispatchId];
        const sets: string[] = ['updated_at = NOW()'];
        if (plan.evidencePolicy !== null) {
            params.push(plan.evidencePolicy);
            sets.push(`evidence_policy = $${params.length}`);
        }
        if (plan.fillPackageReadyAt) sets.push('package_ready_at = NOW()');
        if (originWarehouseId !== null) {
            params.push(originWarehouseId);
            sets.push(`origin_warehouse_id = $${params.length}`);
        }
        if (plan.statusAfter !== snapshot.status) {
            params.push(plan.statusAfter);
            sets.push(`dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $${params.length})`);
        }
        if (plan.removeFromProposal) await this.leaveBatch(manager, delivery, sets);

        await manager.query(`UPDATE dispatches SET ${sets.join(', ')} WHERE dispatch_id = $1`, params);
        await this.recordEvent(manager, snapshot.dispatchId, 'shipment_changed', {
            source: input.source,
            receivedAt: input.receivedAt,
            changedBlocks: plan.changedBlocks,
            changes: plan.diff,
            statusBefore: snapshot.status,
            statusAfter: plan.statusAfter,
            removedFromProposal: plan.removeFromProposal,
        });

        return {
            status: 'applied',
            dispatchId: snapshot.dispatchId,
            statusBefore: snapshot.status,
            statusAfter: plan.statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: plan.changedBlocks,
        };
    }

    /** The package side of a dispatch that `lock` already locked: its policy, packing moment and rows. */
    private async shipmentSnapshotOf(
        manager: EntityManager,
        delivery: DispatchSnapshot,
    ): Promise<ShipmentDispatchSnapshot> {
        const [header]: { evidence_policy: string; package_ready_at: Date | null; warehouse_code: string | null }[] =
            await manager.query(
            `SELECT d.evidence_policy, d.package_ready_at, w.code AS warehouse_code
               FROM dispatches d
               LEFT JOIN warehouses w ON w.warehouse_id = d.origin_warehouse_id
              WHERE d.dispatch_id = $1`,
            [delivery.dispatchId],
        );
        const rows: {
            external_package_id: string;
            length_cm: string;
            width_cm: string;
            height_cm: string;
            gross_weight_kg: string;
            handling_conditions: string[];
        }[] = await manager.query(
            `SELECT external_package_id, length_cm, width_cm, height_cm, gross_weight_kg, handling_conditions
               FROM dispatch_packages WHERE dispatch_id = $1 ORDER BY external_package_id`,
            [delivery.dispatchId],
        );
        return {
            dispatchId: delivery.dispatchId,
            status: delivery.status,
            routeBatchId: delivery.routeBatchId,
            evidencePolicy: header.evidence_policy,
            packageReadyAt: header.package_ready_at,
            originWarehouseCode: header.warehouse_code,
            packages: rows.map((row) => ({
                packageId: row.external_package_id,
                lengthCm: Number(row.length_cm),
                widthCm: Number(row.width_cm),
                heightCm: Number(row.height_cm),
                grossWeightKg: Number(row.gross_weight_kg),
                handlingConditions: row.handling_conditions,
            })),
        };
    }

    private managerOf(options: TransactionOptions): EntityManager {
        return options.manager ?? this.dataSource.manager;
    }

    /**
     * The delivery dispatch of the order, locked for the rest of the transaction.
     *
     * Lock order: **batch first, then the order**, like the cutoff, the 1st approval and the generator
     * (ST-51.3). An `in_planning` order in a batch is the only one that later calls `leaveBatch`, which
     * writes the batch; locking the order first and the batch second would make this transaction and the
     * cutoff wait on each other (deadlock `40P01`). Any other order never touches its batch, so its batch
     * is not locked: that would only queue unrelated writers behind a message.
     *
     * The batch is read without a lock to know which one to take. If the order moved to another batch in
     * the meantime, that one is locked too after the order (a window of milliseconds; the cutoff retries
     * a deadlock, and so does the message).
     */
    private async lock(manager: EntityManager, salesOrderId: string): Promise<DispatchSnapshot | null> {
        const [peek]: { route_batch_id: number | null; status: string }[] = await manager.query(
            `SELECT d.route_batch_id, s.name AS status
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.source_order_ref = $1
                AND d.dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery')`,
            [salesOrderId],
        );
        let lockedBatchId: number | null = null;
        if (peek && peek.status === IN_PLANNING && peek.route_batch_id !== null) {
            await this.lockBatch(manager, peek.route_batch_id);
            lockedBatchId = peek.route_batch_id;
        }

        const rows: DispatchRow[] = await manager.query(
            `SELECT d.dispatch_id, s.name AS status, d.route_batch_id, d.contact_name, d.contact_phone,
                    d.contact_email, d.delivery_address, d.delivery_reference, d.delivery_latitude,
                    d.delivery_longitude, d.delivery_zone_id, d.priority, d.shipment_ready
               FROM dispatches d
               JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
              WHERE d.source_order_ref = $1
                AND d.dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery')
                FOR UPDATE OF d`,
            [salesOrderId],
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        if (row.status === IN_PLANNING && row.route_batch_id !== null && row.route_batch_id !== lockedBatchId) {
            await this.lockBatch(manager, row.route_batch_id);
        }
        return {
            dispatchId: row.dispatch_id,
            status: row.status,
            routeBatchId: row.route_batch_id,
            contactName: row.contact_name,
            contactPhone: row.contact_phone,
            contactEmail: row.contact_email,
            deliveryAddress: row.delivery_address,
            deliveryReference: row.delivery_reference,
            deliveryLatitude: row.delivery_latitude === null ? null : Number(row.delivery_latitude),
            deliveryLongitude: row.delivery_longitude === null ? null : Number(row.delivery_longitude),
            deliveryZoneId: row.delivery_zone_id,
            priority: row.priority,
            shipmentReady: row.shipment_ready,
        };
    }

    private async lockBatch(manager: EntityManager, routeBatchId: number): Promise<void> {
        await manager.query(`SELECT route_batch_id FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`, [routeBatchId]);
    }

    /** Same polygon test as the dispatch generator. */
    private async findZone(
        manager: EntityManager,
        location: { latitude: number; longitude: number },
    ): Promise<number | null> {
        const rows: { id: number }[] = await manager.query(
            `SELECT delivery_zone_id AS id FROM delivery_zones
              WHERE deleted_at IS NULL AND boundary IS NOT NULL
                AND boundary @> point($1::float8, $2::float8)
              ORDER BY delivery_zone_id LIMIT 1`,
            [location.longitude, location.latitude],
        );
        return rows[0]?.id ?? null;
    }

    /**
     * Takes the dispatch out of its proposed batch: adds the `SET` parts to the caller's update and
     * raises the version of the batch it leaves (D-09).
     */
    private async leaveBatch(manager: EntityManager, snapshot: DispatchSnapshot, sets: string[]): Promise<void> {
        sets.push('route_batch_id = NULL', 'sequence_order = NULL', 'version = version + 1');
        await manager.query(`UPDATE route_batches SET version = version + 1 WHERE route_batch_id = $1`, [
            snapshot.routeBatchId,
        ]);
    }

    private async raiseAttention(
        manager: EntityManager,
        snapshot: DispatchSnapshot,
        data: {
            source: ChangeSource;
            changeType: 'order_changed' | 'order_cancelled';
            receivedAt: string;
            changedBlocks?: string[];
            reason?: string;
            /** Before and after of what changed, when the caller has it (package changes do). */
            changes?: unknown;
        },
    ): Promise<DispatchChangeOutcome> {
        await this.recordEvent(manager, snapshot.dispatchId, 'change_requires_attention', {
            source: data.source,
            changeType: data.changeType,
            receivedAt: data.receivedAt,
            changedBlocks: data.changedBlocks ?? [],
            reason: data.reason ?? null,
            status: snapshot.status,
            ...(data.changes !== undefined ? { changes: data.changes } : {}),
        });
        return {
            status: 'attention_required',
            dispatchId: snapshot.dispatchId,
            event: {
                dispatchId: snapshot.dispatchId,
                source: data.source,
                changeType: data.changeType,
                receivedAt: data.receivedAt,
            },
        };
    }

    private async recordEvent(
        manager: EntityManager,
        dispatchId: number,
        eventType: string,
        metadata: Record<string, unknown>,
    ): Promise<void> {
        await manager.query(
            `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, metadata)
             VALUES ($1, $2, 'system', $3::jsonb)`,
            [dispatchId, eventType, JSON.stringify(metadata)],
        );
    }
}
