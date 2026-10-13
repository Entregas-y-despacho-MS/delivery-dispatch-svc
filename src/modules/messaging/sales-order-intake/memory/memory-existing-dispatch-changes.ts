import { Injectable } from '@nestjs/common';
import {
    isUsableLocation,
    planCancellation,
    planDeliveryChange,
    planShipmentReadiness,
    statusAfterEdit,
    type DispatchSnapshot,
} from '../domain/dispatch-change.rules.js';
import {
    planShipmentChange,
    type DispatchPackageSnapshot,
    type ShipmentDispatchSnapshot,
} from '../domain/shipment-change.rules.js';
import {
    ExistingDispatchChanges,
    type ChangeSource,
    type DispatchChangeOutcome,
} from '../ports/existing-dispatch-changes.port.js';

/** What the in-memory adapter remembers about what it did, for the assertions of a test. */
export interface RecordedDispatchEvent {
    dispatchId: number;
    eventType: string;
    metadata: Record<string, unknown>;
}

/** The shipment side of a dispatch: its packages, evidence policy and packing moment. */
export interface ShipmentDetails {
    packages: DispatchPackageSnapshot[];
    evidencePolicy: string;
    packageReadyAt: Date | null;
    /** `warehouses.code` of the origin warehouse of the dispatch, or `null`. */
    warehouseCode: string | null;
}

/**
 * In-memory `ExistingDispatchChanges` for tests. It applies the same pure rules as the SQL adapter
 * over dispatches that the test registers with `add`. Zones: a usable location is "covered" unless
 * `uncoveredLocations` says otherwise.
 */
@Injectable()
export class MemoryExistingDispatchChanges extends ExistingDispatchChanges {
    private readonly dispatches = new Map<string, DispatchSnapshot>();
    private readonly shipments = new Map<string, ShipmentDetails>();
    readonly events: RecordedDispatchEvent[] = [];
    /** Batches whose version went up because a dispatch left them. */
    readonly batchVersionBumps: number[] = [];
    /** Dispatch versions that went up because the dispatch left its batch. */
    readonly dispatchVersionBumps: number[] = [];
    uncoveredLocations = false;

    add(salesOrderId: string, snapshot: Partial<DispatchSnapshot> & { dispatchId: number }): void {
        this.dispatches.set(salesOrderId, {
            status: 'pending',
            routeBatchId: null,
            contactName: 'María López',
            contactPhone: '+59170000000',
            contactEmail: null,
            deliveryAddress: 'Av. Arce 2345',
            deliveryReference: null,
            deliveryLatitude: -16.5412,
            deliveryLongitude: -68.0731,
            deliveryZoneId: 1,
            priority: 'normal',
            shipmentReady: true,
            ...snapshot,
        });
    }

    get(salesOrderId: string): DispatchSnapshot | undefined {
        const found = this.dispatches.get(salesOrderId);
        return found ? { ...found } : undefined;
    }

    /** Registers the packages, evidence policy and packing moment of a dispatch added with `add`. */
    addShipment(
        salesOrderId: string,
        details: {
            packages?: DispatchPackageSnapshot[];
            evidencePolicy?: string;
            packageReadyAt?: Date | null;
            warehouseCode?: string | null;
        },
    ): void {
        this.shipments.set(salesOrderId, {
            packages: [],
            evidencePolicy: 'hand_delivery_standard',
            packageReadyAt: null,
            warehouseCode: null,
            ...structuredClone(details),
        });
    }

    getShipment(salesOrderId: string): ShipmentDetails | undefined {
        const found = this.shipments.get(salesOrderId);
        return found ? structuredClone(found) : undefined;
    }

    async applyShipmentChange(
        input: Parameters<ExistingDispatchChanges['applyShipmentChange']>[0],
        _options?: Parameters<ExistingDispatchChanges['applyShipmentChange']>[1],
    ): Promise<DispatchChangeOutcome> {
        const current = this.dispatches.get(input.salesOrderId);
        if (!current) return { status: 'no_dispatch' };

        const details = this.shipments.get(input.salesOrderId) ?? {
            packages: [],
            evidencePolicy: 'hand_delivery_standard',
            packageReadyAt: null,
            warehouseCode: null,
        };
        const snapshot: ShipmentDispatchSnapshot = {
            dispatchId: current.dispatchId,
            status: current.status,
            routeBatchId: current.routeBatchId,
            packages: structuredClone(details.packages),
            evidencePolicy: details.evidencePolicy,
            packageReadyAt: details.packageReadyAt,
            originWarehouseCode: details.warehouseCode,
        };

        const plan = planShipmentChange(snapshot, input.blocks);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: current.dispatchId, reason: plan.reason };
        if (plan.kind === 'noop') return { status: 'ignored', dispatchId: current.dispatchId, reason: 'no_change' };
        if (plan.kind === 'attention') {
            this.events.push({
                dispatchId: current.dispatchId,
                eventType: 'change_requires_attention',
                metadata: {
                    source: input.source,
                    changeType: 'order_changed',
                    changedBlocks: plan.changedBlocks,
                    changes: plan.diff,
                    status: current.status,
                },
            });
            return {
                status: 'attention_required',
                dispatchId: current.dispatchId,
                event: {
                    dispatchId: current.dispatchId,
                    source: input.source,
                    changeType: 'order_changed',
                    receivedAt: input.receivedAt,
                },
            };
        }

        this.shipments.set(input.salesOrderId, {
            packages: plan.packages ?? snapshot.packages,
            evidencePolicy: plan.evidencePolicy ?? snapshot.evidencePolicy,
            packageReadyAt: plan.fillPackageReadyAt ? new Date() : snapshot.packageReadyAt,
            warehouseCode: plan.warehouseCode ?? snapshot.originWarehouseCode,
        });
        const next: DispatchSnapshot = { ...current, status: plan.statusAfter };
        if (plan.removeFromProposal) this.leaveBatch(next);
        this.dispatches.set(input.salesOrderId, next);

        this.events.push({
            dispatchId: current.dispatchId,
            eventType: 'shipment_changed',
            metadata: {
                source: input.source,
                receivedAt: input.receivedAt,
                changedBlocks: plan.changedBlocks,
                changes: plan.diff,
                statusBefore: current.status,
                statusAfter: plan.statusAfter,
                removedFromProposal: plan.removeFromProposal,
            },
        });
        return {
            status: 'applied',
            dispatchId: current.dispatchId,
            statusBefore: current.status,
            statusAfter: plan.statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: plan.changedBlocks,
        };
    }

    async applyDeliveryChange(
        input: Parameters<ExistingDispatchChanges['applyDeliveryChange']>[0],
    ): Promise<DispatchChangeOutcome> {
        const current = this.dispatches.get(input.salesOrderId);
        if (!current) return { status: 'no_dispatch' };

        const plan = planDeliveryChange(current, input.blocks);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: current.dispatchId, reason: plan.reason };
        if (plan.kind === 'attention') {
            return this.attention(current, input.source, 'order_changed', input.receivedAt, plan.changedBlocks);
        }
        if (Object.keys(plan.columns).length === 0) {
            return { status: 'ignored', dispatchId: current.dispatchId, reason: 'no_change' };
        }

        const location = input.blocks.deliveryAddress?.location;
        const hasZone = plan.locationChanged ? isUsableLocation(location) && !this.uncoveredLocations : true;
        const statusAfter = statusAfterEdit({
            current: current.status,
            removedFromProposal: plan.removeFromProposal,
            locationChanged: plan.locationChanged,
            hasZone,
        });

        const next: DispatchSnapshot = { ...current, ...plan.columns, status: statusAfter };
        if (plan.locationChanged) next.deliveryZoneId = hasZone ? 1 : null;
        if (plan.removeFromProposal) this.leaveBatch(next);
        this.dispatches.set(input.salesOrderId, next);

        this.events.push({
            dispatchId: current.dispatchId,
            eventType: 'order_changed',
            metadata: { source: input.source, changes: plan.diff, statusBefore: current.status, statusAfter },
        });
        return {
            status: 'applied',
            dispatchId: current.dispatchId,
            statusBefore: current.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: Object.keys(plan.columns),
        };
    }

    async cancel(input: Parameters<ExistingDispatchChanges['cancel']>[0]): Promise<DispatchChangeOutcome> {
        const current = this.dispatches.get(input.salesOrderId);
        if (!current) return { status: 'no_dispatch' };

        const plan = planCancellation(current);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: current.dispatchId, reason: plan.reason };
        if (plan.kind === 'attention') {
            return this.attention(current, input.source, 'order_cancelled', input.cancelledAt, []);
        }

        const next: DispatchSnapshot = { ...current, status: 'cancelled' };
        if (plan.removeFromProposal) this.leaveBatch(next);
        this.dispatches.set(input.salesOrderId, next);
        this.events.push({
            dispatchId: current.dispatchId,
            eventType: 'status_changed',
            metadata: { source: input.source, from: current.status, to: 'cancelled' },
        });
        return {
            status: 'applied',
            dispatchId: current.dispatchId,
            statusBefore: current.status,
            statusAfter: 'cancelled',
            removedFromProposal: plan.removeFromProposal,
            changedFields: ['status'],
        };
    }

    async setShipmentReady(
        input: Parameters<ExistingDispatchChanges['setShipmentReady']>[0],
    ): Promise<DispatchChangeOutcome> {
        const current = this.dispatches.get(input.salesOrderId);
        if (!current) return { status: 'no_dispatch' };

        const plan = planShipmentReadiness(current, input.ready);
        if (plan.kind === 'ignore') return { status: 'ignored', dispatchId: current.dispatchId, reason: plan.reason };
        if (plan.kind === 'noop') return { status: 'ignored', dispatchId: current.dispatchId, reason: 'no_change' };
        if (plan.kind === 'attention') {
            return this.attention(current, input.source, 'order_changed', input.receivedAt, ['shipment_ready']);
        }

        const statusAfter = statusAfterEdit({
            current: current.status,
            removedFromProposal: plan.removeFromProposal,
            locationChanged: false,
            hasZone: true,
        });
        const next: DispatchSnapshot = { ...current, shipmentReady: plan.ready, status: statusAfter };
        if (plan.removeFromProposal) this.leaveBatch(next);
        this.dispatches.set(input.salesOrderId, next);
        this.events.push({
            dispatchId: current.dispatchId,
            eventType: 'shipment_readiness_changed',
            metadata: { source: input.source, ready: plan.ready },
        });
        return {
            status: 'applied',
            dispatchId: current.dispatchId,
            statusBefore: current.status,
            statusAfter,
            removedFromProposal: plan.removeFromProposal,
            changedFields: ['shipment_ready'],
        };
    }

    private leaveBatch(snapshot: DispatchSnapshot): void {
        if (snapshot.routeBatchId !== null) this.batchVersionBumps.push(snapshot.routeBatchId);
        this.dispatchVersionBumps.push(snapshot.dispatchId);
        snapshot.routeBatchId = null;
    }

    private attention(
        snapshot: DispatchSnapshot,
        source: ChangeSource,
        changeType: 'order_changed' | 'order_cancelled',
        receivedAt: string,
        changedBlocks: string[],
    ): DispatchChangeOutcome {
        this.events.push({
            dispatchId: snapshot.dispatchId,
            eventType: 'change_requires_attention',
            metadata: { source, changeType, changedBlocks, status: snapshot.status },
        });
        return {
            status: 'attention_required',
            dispatchId: snapshot.dispatchId,
            event: { dispatchId: snapshot.dispatchId, source, changeType, receivedAt },
        };
    }
}
