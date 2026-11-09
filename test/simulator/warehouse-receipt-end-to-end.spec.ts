import { describe, expect, it } from 'vitest';
import { createHarness, type PublishedOutcome } from './scenario-harness.js';
import { buildScenario, loadScenario, scenariosOf } from './scenarios.js';
import type { DispatchKind } from './memory-warehouse-receipt.js';

/**
 * ST-240.4 — the warehouse-receipt scenarios of `simulate:demo-returns` played end to end against the real
 * consumers (RMA, Compras and Almacén's receipt) with the in-memory adapters: no Docker, no PostgreSQL, no broker.
 *
 * The person who runs the demo moves the dispatch to `picked_up_in_transit` during the pause that precedes the
 * receipt (`pauseBefore`); here `play` does the same by forcing the state. The SQL of the intake service has its own
 * PostgreSQL spec (`warehouse-receipt.postgres.integration.spec.ts`).
 */
const NOW = new Date('2026-12-01T10:00:00Z');
const played = new Set<string>();

async function play(name: string) {
    const fixture = loadScenario(name);
    expect(fixture, `no existe el escenario ${name}`).toBeDefined();
    played.add(name);
    const built = buildScenario(fixture!, { runId: 'test01', now: NOW });
    const harness = await createHarness();
    const outcomes: PublishedOutcome[] = [];
    for (const step of built.steps) {
        if (step.pauseBefore) {
            // What the courier does during the demo's pause: pick the load up.
            const data = step.envelope['data'] as { referenceType: 'rma' | 'purchase_order'; referenceId: string };
            const kind: DispatchKind = data.referenceType === 'rma' ? 'warehouse_return_pickup' : 'supplier_pickup';
            harness.receipts.forceStatus(data.referenceId, kind, 'picked_up_in_transit');
        }
        outcomes.push(...(await harness.publish(step)));
    }
    return { built, harness, outcomes: outcomes.map((entry) => entry.outcome) };
}

const eventsNamed = (harness: Awaited<ReturnType<typeof createHarness>>, name: string) =>
    harness.emitted.filter((entry) => entry.event === name).map((entry) => entry.payload as Record<string, unknown>);

describe('recepción de Almacén: escenarios de simulate:demo-returns', () => {
    it('receipt-rma-complete: RMA → recojo → picked_up_in_transit → recepción → returned_to_warehouse', async () => {
        const { harness, outcomes, built } = await play('receipt-rma-complete');
        const rmaId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed']);
        // The RMA created the pickup scheduled; the receipt, once collected, closed it.
        expect(harness.rmaPickups.records).toMatchObject([{ rmaId, status: 'pickup_scheduled' }]);
        expect(harness.receipts.dispatchOf(rmaId, 'warehouse_return_pickup')).toMatchObject({ status: 'returned_to_warehouse' });
        expect(Object.values(harness.receipts.receipts)).toMatchObject([{ status: 'applied', result: 'complete' }]);
        // Inventarios originates the complete outcome of a return: nothing is published to it.
        expect(harness.receipts.outbox).toEqual([]);
        expect(eventsNamed(harness, 'dispatch.status_changed').map((p) => p['status'])).toContain('returned_to_warehouse');
        expect(harness.rejection.alerts).toEqual([]);
    });

    it('receipt-rma-damaged: el RMA con daños pasa a incident y se avisa a Inventarios', async () => {
        const { harness, outcomes, built } = await play('receipt-rma-damaged');
        const rmaId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed']);
        const dispatch = harness.receipts.dispatchOf(rmaId, 'warehouse_return_pickup')!;
        expect(dispatch.status).toBe('incident');
        expect(harness.receipts.incidents).toMatchObject([{ dispatchId: dispatch.id }]);
        expect(harness.receipts.outbox).toHaveLength(1);
        expect(harness.receipts.outbox[0]).toMatchObject({
            type: 'dispatch.transfer.status_changed',
            data: {
                salesOrderId: rmaId, status: 'incident', previousStatus: 'picked_up_in_transit', result: 'with_differences',
                items: [{ itemCode: 'SKU-LAP-14', acceptedQuantity: 0, damagedQuantity: 1 }],
            },
        });
        expect(eventsNamed(harness, 'dispatch.incident_reported')).toMatchObject([{ dispatchId: dispatch.id, reasonCode: 'INC-RECEIPT-DIFF' }]);
    });

    it('receipt-pickup-complete: la recogida en proveedor recibida completa queda delivered y Compras recibe el resultado', async () => {
        const { harness, outcomes, built } = await play('receipt-pickup-complete');
        const purchaseOrderId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed']);
        expect(harness.receipts.dispatchOf(purchaseOrderId, 'supplier_pickup')).toMatchObject({ status: 'delivered' });
        expect(harness.receipts.incidents).toEqual([]);
        expect(harness.receipts.outbox).toHaveLength(1);
        const data = harness.receipts.outbox[0]!.data as Record<string, unknown>;
        expect(data).toMatchObject({ purchaseOrderId, status: 'delivered', result: 'complete' });
        expect(data).not.toHaveProperty('items');
    });

    it('receipt-pickup-missing: la recogida con faltantes pasa a incident y Compras recibe solo los ítems con diferencias', async () => {
        const { harness, outcomes, built } = await play('receipt-pickup-missing');
        const purchaseOrderId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed']);
        const dispatch = harness.receipts.dispatchOf(purchaseOrderId, 'supplier_pickup')!;
        expect(dispatch.status).toBe('incident');
        expect(harness.receipts.incidents).toMatchObject([{ dispatchId: dispatch.id }]);
        expect(harness.receipts.outbox).toHaveLength(1);
        expect(harness.receipts.outbox[0]).toMatchObject({
            type: 'dispatch.transfer.status_changed',
            data: {
                purchaseOrderId, trackingCode: dispatch.tracking, status: 'incident', result: 'with_differences',
                items: [{ itemCode: 'SKU-LAP-14', acceptedQuantity: 8, missingQuantity: 1, damagedQuantity: 1 }],
            },
        });
        expect((harness.receipts.outbox[0]!.data as { items: unknown[] }).items).toHaveLength(1);
        expect(eventsNamed(harness, 'dispatch.incident_reported')).toHaveLength(1);
    });

    it('receipt-unknown-reference: la recepción queda orphan, nada cambia y se avisa a la web', async () => {
        const { harness, outcomes } = await play('receipt-unknown-reference');

        expect(outcomes).toEqual(['processed']);
        expect(Object.values(harness.receipts.receipts)).toMatchObject([{ status: 'orphan', dispatch_id: null }]);
        expect(harness.receipts.dispatches).toEqual([]);
        expect(harness.receipts.outbox).toEqual([]);
        expect(eventsNamed(harness, 'dispatch.change_requires_attention')).toMatchObject([{ changeType: 'orphan_receipt' }]);
        expect(eventsNamed(harness, 'dispatch.status_changed')).toEqual([]);
    });

    it('receipt-not-picked-up: con el despacho aún en pickup_scheduled la recepción queda orphan y el despacho no se mueve', async () => {
        const { harness, outcomes, built } = await play('receipt-not-picked-up');
        const rmaId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed']);
        expect(harness.receipts.dispatchOf(rmaId, 'warehouse_return_pickup')).toMatchObject({ status: 'pickup_scheduled' });
        expect(Object.values(harness.receipts.receipts)).toMatchObject([{ status: 'orphan', dispatch_id: null }]);
        expect(harness.receipts.outbox).toEqual([]);
        expect(eventsNamed(harness, 'dispatch.change_requires_attention')).toMatchObject([{ changeType: 'orphan_receipt' }]);
    });

    it('receipt-invalid: sin items va al dead-letter por esquema y no guarda nada', async () => {
        const { harness, outcomes } = await play('receipt-invalid');

        expect(outcomes).toEqual(['rejected']);
        const deadLetters = harness.bus.deadLettersOf('inventory.receipt.confirmed');
        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0]!.errors.map((error) => error.message).join(' ')).toContain('items');
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['schema_invalid']);
        expect(harness.receipts.receipts).toEqual({});
        expect(harness.receipts.outbox).toEqual([]);
    });

    it('receipt-duplicate: la segunda entrega se ignora: una recepción, un cambio de estado, un evento', async () => {
        const { harness, outcomes, built } = await play('receipt-duplicate');
        const rmaId = built.steps[0]!.orderId;

        expect(outcomes).toEqual(['processed', 'processed', 'duplicate']);
        expect(Object.keys(harness.receipts.receipts)).toHaveLength(1);
        expect(harness.receipts.dispatchOf(rmaId, 'warehouse_return_pickup')).toMatchObject({ status: 'returned_to_warehouse' });
        expect(harness.receipts.events).toHaveLength(1);
        expect(eventsNamed(harness, 'dispatch.status_changed').filter((p) => p['status'] === 'returned_to_warehouse')).toHaveLength(1);
    });

    it('una segunda corrida con otro runId no es ignorada por la deduplicación de la primera', async () => {
        const fixture = loadScenario('receipt-rma-complete')!;
        const harness = await createHarness();
        for (const runId of ['run001', 'run002']) {
            const built = buildScenario(fixture, { runId, now: NOW });
            for (const step of built.steps) {
                if (step.pauseBefore) {
                    harness.receipts.forceStatus(step.orderId, 'warehouse_return_pickup', 'picked_up_in_transit');
                }
                expect((await harness.publish(step)).map((entry) => entry.outcome)).toEqual(['processed']);
            }
        }

        expect(Object.keys(harness.receipts.receipts)).toHaveLength(2);
        expect(harness.receipts.dispatches.map((dispatch) => dispatch.status)).toEqual(['returned_to_warehouse', 'returned_to_warehouse']);
    });

    it('los escenarios que esperan al repartidor lo declaran con pauseBefore en la recepción, y los demás no', () => {
        const withPause = scenariosOf('demo-returns')
            .filter((fixture) => fixture.steps.some((step) => step.pauseBefore === true))
            .map((fixture) => fixture.scenario)
            .sort();
        expect(withPause).toEqual([
            'receipt-pickup-complete', 'receipt-pickup-missing', 'receipt-rma-complete', 'receipt-rma-damaged', 'receipt-duplicate',
        ].sort());
        for (const fixture of scenariosOf('demo-returns')) {
            for (const step of fixture.steps.filter((s) => s.pauseBefore === true)) {
                expect(step.message['type']).toBe('inventory.receipt.confirmed');
            }
        }
    });

    it('cubre los ocho escenarios de ST-240.4 y todos tienen su prueba (corre al final del archivo)', () => {
        const names = scenariosOf('demo-returns').map((fixture) => fixture.scenario).sort();
        expect(names).toEqual([
            'receipt-duplicate', 'receipt-invalid', 'receipt-not-picked-up', 'receipt-pickup-complete',
            'receipt-pickup-missing', 'receipt-rma-complete', 'receipt-rma-damaged', 'receipt-unknown-reference',
        ]);
        expect(names.filter((name) => !played.has(name))).toEqual([]);
    });
});
