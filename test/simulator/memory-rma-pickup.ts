import type { RmaPickupRequestedData } from '../../src/modules/messaging/rma-pickup-intake/domain/rma-pickup-message.types.js';
import { RmaSyncStatePort, type RmaSyncState } from '../../src/modules/messaging/rma-pickup-intake/ports/rma-sync-state.port.js';
import { MANUAL_SOURCE_REF_PREFIX, PickupOrderService } from '../../src/modules/messaging/rma-pickup-intake/services/pickup-order.service.js';
import { RejectedMessageException } from '../../src/plugins/messaging/exceptions/rejected-message.exception.js';
import type { MemoryTransactionParticipant } from '../../src/plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';

/**
 * In-memory doubles of the two SQL collaborators of `RmaPickupConsumer` (ST-238.2), shared by the simulator
 * harness and the integration spec of the RMA circuit. They take part in the rollback of
 * `MemoryInboundMessageTransactionAdapter`, so a rejected message leaves nothing behind, as in PostgreSQL.
 * The SQL itself (`PickupOrderService`, `TypeOrmRmaSyncStateAdapter`) has its own unit specs.
 */
export class MemoryRmaSyncStateAdapter extends RmaSyncStatePort implements MemoryTransactionParticipant<RmaSyncState[]> {
    private rows = new Map<string, RmaSyncState>();

    async find(rmaId: string): Promise<RmaSyncState | null> {
        const row = this.rows.get(rmaId);
        return row ? { ...row } : null;
    }

    async save(state: RmaSyncState): Promise<void> {
        this.rows.set(state.rmaId, { ...state });
    }

    snapshot(): RmaSyncState[] {
        return [...this.rows.values()].map((row) => ({ ...row }));
    }

    restore(snapshot: RmaSyncState[]): void {
        this.rows = new Map(snapshot.map((row) => [row.rmaId, row]));
    }
}

export interface MemoryPickupRecord {
    dispatchId: number;
    rmaId: string;
    dispatchType: 'warehouse_return_pickup';
    status: 'pickup_scheduled' | 'address_review';
    address: string;
    hasCoordinates: boolean;
    contactName: string;
    returnReason: string;
    warehouseCode: string;
    estimatedBoxes: number | null;
    preferredPickupDate: string | null;
    recordVersion: number;
}

/**
 * Same decisions as `PickupOrderService.createFromRma`: a reserved `MANUAL-` rmaId or an unknown warehouse reject,
 * no coordinates → `address_review`.
 */
export class MemoryPickupOrderService extends PickupOrderService implements MemoryTransactionParticipant<MemoryPickupRecord[]> {
    records: MemoryPickupRecord[] = [];

    constructor(private readonly knownWarehouses: Set<string>) {
        super();
    }

    async createFromRma(
        data: RmaPickupRequestedData,
    ): Promise<{ dispatchId: number; status: 'pickup_scheduled' | 'address_review' }> {
        if (data.rmaId.startsWith(MANUAL_SOURCE_REF_PREFIX)) {
            throw new RejectedMessageException(
                [{ path: '/data/rmaId', keyword: 'reservedPrefix', message: `rmaId must not start with ${MANUAL_SOURCE_REF_PREFIX}.` }],
                'reserved_rma_prefix',
            );
        }
        if (!this.knownWarehouses.has(data.warehouseId)) {
            throw new RejectedMessageException(
                [{ path: '/data/warehouseId', keyword: 'unknownWarehouse', message: `Unknown warehouse ${data.warehouseId}.` }],
                'unknown_warehouse',
            );
        }
        const status = data.pickupAddress.location ? 'pickup_scheduled' : 'address_review';
        const dispatchId = this.records.length + 1;
        this.records.push({
            dispatchId,
            rmaId: data.rmaId,
            dispatchType: 'warehouse_return_pickup',
            status,
            address: data.pickupAddress.line,
            hasCoordinates: data.pickupAddress.location !== undefined,
            contactName: data.contact.name,
            returnReason: data.returnReason,
            warehouseCode: data.warehouseId,
            estimatedBoxes: data.packages?.length ?? null,
            preferredPickupDate: data.preferredPickupDate ?? null,
            recordVersion: data.recordVersion,
        });
        return { dispatchId, status };
    }

    snapshot(): MemoryPickupRecord[] {
        return structuredClone(this.records);
    }

    restore(snapshot: MemoryPickupRecord[]): void {
        this.records = snapshot;
    }
}
