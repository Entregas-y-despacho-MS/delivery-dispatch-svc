import { resolve } from 'node:path';
import type { DispatchChangeOutcome } from '../../src/modules/messaging/sales-order-intake/ports/existing-dispatch-changes.port.js';
import type { ConsolidatedOrder } from '../../src/modules/messaging/sales-order-intake/domain/consolidated-order.types.js';
import {
    DispatchGenerator,
    type CreatedDispatch,
} from '../../src/modules/messaging/sales-order-intake/ports/dispatch-generator.port.js';
import { MemoryConsolidationRecord } from '../../src/modules/messaging/sales-order-intake/memory/memory-consolidation-record.js';
import { MemoryDispatchGenerator } from '../../src/modules/messaging/sales-order-intake/memory/memory-dispatch-generator.js';
import { MemoryExistingDispatchChanges } from '../../src/modules/messaging/sales-order-intake/memory/memory-existing-dispatch-changes.js';
import { MemoryPendingSalesOrderStore } from '../../src/modules/messaging/sales-order-intake/memory/memory-pending-sales-order.store.js';
import { MarketplaceOrderRepository } from '../../src/modules/messaging/sales-order-intake/repositories/marketplace-order.repository.js';
import { DispatchChangeEvents } from '../../src/modules/messaging/sales-order-intake/services/dispatch-change-events.service.js';
import { MarketplaceOrderConsumer } from '../../src/modules/messaging/sales-order-intake/services/marketplace-order-consumer.service.js';
import { OrderConsolidator } from '../../src/modules/messaging/sales-order-intake/services/order-consolidator.service.js';
import { MemoryOrderSyncStateAdapter } from '../../src/modules/messaging/sales-order-sync/memory/memory-order-sync-state.adapter.js';
import { MemoryPendingShipmentStore } from '../../src/modules/messaging/shipment-intake/memory/memory-pending-shipment.store.js';
import { MemoryWarehouseCodeLookup } from '../../src/modules/messaging/shipment-intake/memory/memory-warehouse-code.lookup.js';
import { ShipmentOrderRepository } from '../../src/modules/messaging/shipment-intake/repositories/shipment-order.repository.js';
import { TypeOrmShipmentBlocksReader } from '../../src/modules/messaging/shipment-intake/repositories/typeorm-shipment-blocks.reader.js';
import { ShipmentOrderConsumer } from '../../src/modules/messaging/shipment-intake/services/shipment-order-consumer.service.js';
import { RmaPickupConsumer } from '../../src/modules/messaging/rma-pickup-intake/services/rma-pickup-consumer.service.js';
import { ProcurementPickupConsumer } from '../../src/modules/messaging/procurement-pickup-intake/services/procurement-pickup-consumer.service.js';
import { WarehouseReceiptConsumer } from '../../src/modules/messaging/warehouse-receipt-intake/services/warehouse-receipt-consumer.service.js';
import { MessageValidator } from '../../src/plugins/messaging/envelope/message-validator.js';
import type { ConsumeOutcome } from '../../src/plugins/messaging/message-consumer.js';
import { MemoryInboundMessageLogAdapter } from '../../src/plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageRejectionAdapter } from '../../src/plugins/messaging/memory/memory-inbound-message-rejection.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from '../../src/plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from '../../src/plugins/messaging/memory/memory-message-bus.adapter.js';
import { MemoryPickupOrderService, MemoryRmaSyncStateAdapter } from './memory-rma-pickup.js';
import {
    createReceiptIntake,
    MemoryWarehouseReceiptStore,
    StoreTransaction,
} from './memory-warehouse-receipt.js';
import type { BuiltScenario, BuiltStep } from './scenario.types.js';

const CONTRACTS_DIR = resolve(import.meta.dirname, '../../contracts/messages');

/** Warehouses that exist in `warehouses.code` of the seed. */
export const KNOWN_WAREHOUSES = ['WH-LPZ-01', 'WH-LPZ-02'];

/**
 * Creates the dispatch like ST-49.1 does and, in the same step, tells the in-memory change adapter
 * about it. Without this a change that arrives after the consolidation would find `no_dispatch`.
 */
class RegisteringDispatchGenerator extends DispatchGenerator {
    constructor(
        private readonly inner: MemoryDispatchGenerator,
        private readonly changes: MemoryExistingDispatchChanges,
    ) {
        super();
    }

    async createFromConsolidated(order: ConsolidatedOrder): Promise<CreatedDispatch> {
        const created = await this.inner.createFromConsolidated(order);
        const location = order.deliveryAddress.location;
        this.changes.add(order.salesOrderId, {
            dispatchId: created.dispatchId,
            status: location === undefined ? 'address_review' : 'pending',
            contactName: order.recipient.name,
            contactPhone: order.recipient.phone,
            contactEmail: order.recipient.email ?? null,
            deliveryAddress: order.deliveryAddress.line,
            deliveryReference: order.deliveryAddress.reference ?? null,
            deliveryLatitude: location?.latitude ?? null,
            deliveryLongitude: location?.longitude ?? null,
            priority: order.priority,
        });
        this.changes.addShipment(order.salesOrderId, {
            packages: order.packages.map((pack) => ({
                ...pack,
                handlingConditions: order.handlingConditions,
            })),
            evidencePolicy: order.evidencePolicy,
            packageReadyAt: order.physicallyPacked ? new Date() : null,
            warehouseCode: order.warehouseId,
        });
        return created;
    }
}

/** What the SQL repository of Compras would have been asked to do; it has no in-memory adapter. */
class RecordingProcurementRepository {
    readonly requested: unknown[] = [];
    readonly updated: unknown[] = [];
    readonly cancelled: unknown[] = [];

    async applyRequested(data: unknown): Promise<DispatchChangeOutcome | null> {
        this.requested.push(data);
        return null;
    }

    async applyUpdated(data: unknown): Promise<DispatchChangeOutcome | null> {
        this.updated.push(data);
        return null;
    }

    async applyCancelled(data: unknown): Promise<DispatchChangeOutcome | null> {
        this.cancelled.push(data);
        return null;
    }
}

export interface PublishedOutcome {
    step: BuiltStep;
    delivery: number;
    outcome: ConsumeOutcome | null;
}

/**
 * The real consumers of Marketplace, Almacén and Compras wired to the in-memory adapters, with the
 * same pipeline as production (schema validation, deduplication, dead-letter, rejection alerts).
 * Only the SQL persistence is replaced; `*.integration.spec.ts` of each consumer covers that.
 */
export async function createHarness() {
    const log = new MemoryInboundMessageLogAdapter();
    const rejection = new MemoryInboundMessageRejectionAdapter();
    const validator = MessageValidator.fromDirectory(CONTRACTS_DIR);
    const bus = new MemoryMessageBusAdapter(validator, log, rejection);
    const transaction = new MemoryInboundMessageTransactionAdapter(log);

    const syncStates = new MemoryOrderSyncStateAdapter();
    const pendingShipments = new MemoryPendingShipmentStore();
    const marketplaceOrders = new MarketplaceOrderRepository(syncStates, new MemoryPendingSalesOrderStore());
    const shipmentOrders = new ShipmentOrderRepository(syncStates, pendingShipments);
    const dispatchChanges = new MemoryExistingDispatchChanges();
    const generator = new MemoryDispatchGenerator();
    const consolidator = new OrderConsolidator(
        syncStates,
        marketplaceOrders,
        new TypeOrmShipmentBlocksReader(pendingShipments),
        new RegisteringDispatchGenerator(generator, dispatchChanges),
        new MemoryConsolidationRecord(),
    );
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const events = new DispatchChangeEvents({
        emit: (event: string, payload: unknown) => {
            emitted.push({ event, payload });
        },
    } as never);
    const procurement = new RecordingProcurementRepository();
    const rmaSyncStates = new MemoryRmaSyncStateAdapter();
    const rmaPickups = new MemoryPickupOrderService(new Set(KNOWN_WAREHOUSES));
    transaction.registerParticipant(rmaSyncStates);
    transaction.registerParticipant(rmaPickups);

    // Almacén's receipt (ST-240.4) resolves the dispatches the RMA and procurement consumers created above.
    const receipts = new MemoryWarehouseReceiptStore(rmaPickups, procurement);
    transaction.registerParticipant(receipts);

    await new MarketplaceOrderConsumer(
        bus, transaction, marketplaceOrders, consolidator, dispatchChanges, events,
    ).onModuleInit();
    await new ShipmentOrderConsumer(
        bus, transaction, shipmentOrders, new MemoryWarehouseCodeLookup(new Set(KNOWN_WAREHOUSES)),
        consolidator, dispatchChanges, events,
    ).onModuleInit();
    await new ProcurementPickupConsumer(bus, transaction, syncStates, procurement as never, events).onModuleInit();
    // The RMA consumer emits straight to the event bus: `emitted` records `dispatch.status_changed` for the web.
    await new RmaPickupConsumer(bus, transaction, rmaSyncStates, rmaPickups, {
        emit: (event: string, payload: unknown) => {
            emitted.push({ event, payload });
        },
    } as never).onModuleInit();

    await new WarehouseReceiptConsumer(
        bus,
        new StoreTransaction(transaction, receipts),
        createReceiptIntake(receipts, validator),
        {
            emit: (event: string, payload: unknown) => {
                emitted.push({ event, payload });
            },
        } as never,
    ).onModuleInit();

    /** Publishes a step as the broker would (`repeat` times, same `messageId`). */
    const publish = async (step: BuiltStep): Promise<PublishedOutcome[]> => {
        const outcomes: PublishedOutcome[] = [];
        for (let delivery = 1; delivery <= step.repeat; delivery++) {
            outcomes.push({ step, delivery, outcome: await bus.publishRaw(step.topic, step.envelope) });
        }
        return outcomes;
    };

    /**
     * Plays a scenario. A withheld step («mensaje perdido») is published last, as the simulator does
     * once `dispatch.sync.requested` asks for it; `beforeAnswer` runs between the two moments.
     */
    const run = async (
        scenario: BuiltScenario,
        beforeAnswer?: () => void | Promise<void>,
    ): Promise<PublishedOutcome[]> => {
        const outcomes: PublishedOutcome[] = [];
        for (const step of scenario.steps.filter((s) => s.respondsTo === undefined)) {
            outcomes.push(...(await publish(step)));
        }
        await beforeAnswer?.();
        for (const step of scenario.steps.filter((s) => s.respondsTo !== undefined)) {
            outcomes.push(...(await publish(step)));
        }
        return outcomes;
    };

    return {
        bus,
        rejection,
        generator,
        dispatchChanges,
        procurement,
        /** Recojos domiciliarios created from `inventory.return.requested` (in-memory `PickupOrderService`). */
        rmaPickups,
        /** Receipts, dispatch states and outbox of the warehouse-receipt circuit (ST-240.4). */
        receipts,
        emitted,
        run,
        publish,
        /** Dispatch the consolidation created for an order, with its current status. */
        dispatchOf: (orderId: string) => dispatchChanges.get(orderId),
        shipmentOf: (orderId: string) => dispatchChanges.getShipment(orderId),
    };
}
