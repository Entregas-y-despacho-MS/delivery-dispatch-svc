import { resolve } from 'node:path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScenario, loadScenario } from '../../../../test/simulator/scenarios.js';
import { MemoryPickupOrderService, MemoryRmaSyncStateAdapter } from '../../../../test/simulator/memory-rma-pickup.js';
import { DispatchEventsSocketListener } from '../../../app/dispatch-events/dispatch-events.socket-listener.js';
import { DISPATCH_STATUS_CHANGED_EVENT } from '../../../app/dispatch-status/dispatch-status-changed.event.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { MemoryInboundMessageLogAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-log.adapter.js';
import { MemoryInboundMessageRejectionAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-rejection.adapter.js';
import { MemoryInboundMessageTransactionAdapter } from '../../../plugins/messaging/memory/memory-inbound-message-transaction.adapter.js';
import { MemoryMessageBusAdapter } from '../../../plugins/messaging/memory/memory-message-bus.adapter.js';
import { RmaPickupConsumer, INVENTORY_RETURN_REQUESTED_TOPIC } from './services/rma-pickup-consumer.service.js';

/**
 * ST-238.3 — the whole circuit of an RMA with the in-memory adapters (no Docker, no PostgreSQL):
 * message → schema validation → `RmaPickupConsumer` → pickup order → `dispatch.status_changed` → the real
 * `DispatchEventsSocketListener` → Socket.io rooms; and an invalid or rejected message → dead-letter →
 * alert → `integration.message_rejected` → rooms. The SQL of the pickup order is covered by
 * `pickup-order.service.spec.ts`; the consumer's branches, by `rma-pickup-consumer.service.spec.ts`.
 */
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');
const NOW = new Date('2026-12-01T10:00:00Z');
const STAFF_ROOMS = ['coordinators', 'supervisors'];

function wire() {
    const events = new EventEmitter2();
    const log = new MemoryInboundMessageLogAdapter();
    const rejection = new MemoryInboundMessageRejectionAdapter(events);
    const bus = new MemoryMessageBusAdapter(MessageValidator.fromDirectory(CONTRACTS_DIR), log, rejection);
    const transaction = new MemoryInboundMessageTransactionAdapter(log);
    const syncStates = new MemoryRmaSyncStateAdapter();
    const pickups = new MemoryPickupOrderService(new Set(['WH-LPZ-01', 'WH-LPZ-02']));
    transaction.registerParticipant(syncStates);
    transaction.registerParticipant(pickups);

    // The socket layer: the real listener, with Socket.io and the zone lookup replaced.
    const socket = { emitToRooms: vi.fn() };
    const dataSource = {
        // Like the SQL, it only finds a dispatch that exists.
        query: vi.fn(async (_sql: string, [dispatchId]: [number]) =>
            pickups.records.some((record) => record.dispatchId === dispatchId) ? [{ zone_id: null, driver_id: null }] : [],
        ),
    };
    const listener = new DispatchEventsSocketListener(socket as never, dataSource as never);
    events.on(DISPATCH_STATUS_CHANGED_EVENT, (event) => void listener.forwardStatusChanged(event));
    events.on('integration.message_rejected', (event) => listener.forwardMessageRejected(event));

    const consumer = new RmaPickupConsumer(bus, transaction, syncStates, pickups, events);
    return { bus, log, rejection, pickups, syncStates, socket, consumer };
}

function messagesOf(scenario: string, runId = 'it01') {
    return buildScenario(loadScenario(scenario)!, { runId, now: NOW }).steps;
}

const socketCalls = (socket: { emitToRooms: ReturnType<typeof vi.fn> }, event: string) =>
    socket.emitToRooms.mock.calls.filter(([, name]) => name === event);

describe('circuito del RMA entrante con el adaptador en memoria', () => {
    let ctx: ReturnType<typeof wire>;

    beforeEach(async () => {
        ctx = wire();
        await ctx.consumer.onModuleInit();
    });

    it('mensaje válido → recojo en pickup_scheduled → dispatch.status_changed por socket', async () => {
        const [step] = messagesOf('rma-requested');

        const outcome = await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);

        expect(outcome).toBe('processed');
        expect(ctx.pickups.records).toHaveLength(1);
        expect(ctx.pickups.records[0]).toMatchObject({
            rmaId: 'RMA-SIM-0001-it01',
            dispatchType: 'warehouse_return_pickup',
            status: 'pickup_scheduled',
            warehouseCode: 'WH-LPZ-01',
        });
        expect(await ctx.syncStates.find('RMA-SIM-0001-it01')).toEqual({ rmaId: 'RMA-SIM-0001-it01', lastRecordVersion: 1 });
        expect(await ctx.log.wasProcessed(String(step!.envelope['messageId']))).toBe(true);

        await vi.waitFor(() => expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)).toHaveLength(1));
        const [rooms, event, payload] = socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)[0]!;
        expect(rooms).toEqual(STAFF_ROOMS);
        expect(event).toBe('dispatch.status_changed');
        expect(payload).toMatchObject({ dispatchId: ctx.pickups.records[0]!.dispatchId, status: 'pickup_scheduled' });
        expect(ctx.rejection.alerts).toEqual([]);
        expect(ctx.bus.handlerErrors).toEqual([]);
    });

    it('sin coordenadas → recojo en address_review, también avisado por socket', async () => {
        const [step] = messagesOf('rma-without-coordinates');

        await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);

        expect(ctx.pickups.records[0]).toMatchObject({ status: 'address_review', hasCoordinates: false });
        await vi.waitFor(() => expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)).toHaveLength(1));
        expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)[0]![2]).toMatchObject({ status: 'address_review' });
    });

    it('inválido (campo faltante) → dead-letter, alerta schema_invalid y aviso por socket, sin recojo', async () => {
        const [step] = messagesOf('rma-invalid');

        const outcome = await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);

        expect(outcome).toBe('rejected');
        const deadLetters = ctx.bus.deadLettersOf(INVENTORY_RETURN_REQUESTED_TOPIC);
        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0]!.errors.map((error) => error.message).join(' ')).toContain('returnReason');
        expect(ctx.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['schema_invalid']);
        expect(ctx.pickups.records).toEqual([]);

        await vi.waitFor(() => expect(socketCalls(ctx.socket, 'integration.message_rejected')).toHaveLength(1));
        const [rooms, , payload] = socketCalls(ctx.socket, 'integration.message_rejected')[0]!;
        expect(rooms).toEqual(STAFF_ROOMS);
        expect(payload).toMatchObject({
            messageId: step!.envelope['messageId'],
            type: INVENTORY_RETURN_REQUESTED_TOPIC,
            reasonCode: 'schema_invalid',
        });
        expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)).toEqual([]);
    });

    it('almacén desconocido → dead-letter y alerta unknown_warehouse; nada queda guardado y un reenvío corregido sí se aplica', async () => {
        const [step] = messagesOf('rma-unknown-warehouse');

        const outcome = await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);

        expect(outcome).toBe('rejected');
        expect(ctx.bus.deadLettersOf(INVENTORY_RETURN_REQUESTED_TOPIC)).toHaveLength(1);
        expect(ctx.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['unknown_warehouse']);
        expect(ctx.pickups.records).toEqual([]);
        expect(await ctx.syncStates.find('RMA-SIM-0003-it01')).toBeNull();
        await vi.waitFor(() => expect(socketCalls(ctx.socket, 'integration.message_rejected')).toHaveLength(1));

        // Almacén fixes the warehouse and publishes again (new messageId, same RMA and version).
        const corrected = structuredClone(step!.envelope) as { messageId: string; data: Record<string, unknown> };
        corrected.messageId = '01930000-0000-7000-8000-0000000000aa';
        corrected.data['warehouseId'] = 'WH-LPZ-01';
        expect(await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, corrected)).toBe('processed');
        expect(ctx.pickups.records).toHaveLength(1);
        expect(ctx.pickups.records[0]).toMatchObject({ rmaId: 'RMA-SIM-0003-it01', status: 'pickup_scheduled' });
    });

    it('reenvío del mismo messageId → un solo recojo y un solo aviso por socket', async () => {
        const [step] = messagesOf('rma-duplicate');

        const first = await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);
        const second = await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, step!.envelope);

        expect([first, second]).toEqual(['processed', 'duplicate']);
        expect(ctx.pickups.records).toHaveLength(1);
        await vi.waitFor(() => expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)).toHaveLength(1));
        expect(ctx.rejection.alerts).toEqual([]);
    });

    it('recordVersion antiguo → se ignora: sin segundo recojo ni segundo aviso', async () => {
        const [latest, stale] = messagesOf('rma-stale-version');

        const outcomes = [
            await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, latest!.envelope),
            await ctx.bus.publishRaw(INVENTORY_RETURN_REQUESTED_TOPIC, stale!.envelope),
        ];

        expect(outcomes).toEqual(['processed', 'processed']);
        expect(ctx.pickups.records).toHaveLength(1);
        expect(ctx.pickups.records[0]).toMatchObject({ recordVersion: 3, address: 'Calle 21 de Calacoto 8790, casa 12' });
        expect(await ctx.syncStates.find('RMA-SIM-0006-it01')).toEqual({ rmaId: 'RMA-SIM-0006-it01', lastRecordVersion: 3 });
        await vi.waitFor(() => expect(socketCalls(ctx.socket, DISPATCH_STATUS_CHANGED_EVENT)).toHaveLength(1));
        // The stale message is still recorded as processed: the broker must not redeliver it.
        expect(await ctx.log.wasProcessed(String(stale!.envelope['messageId']))).toBe(true);
    });
});
