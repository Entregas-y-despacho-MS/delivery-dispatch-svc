import { describe, expect, it } from 'vitest';
import { buildScenario, loadScenario, scenariosOf } from './scenarios.js';
import { createHarness } from './scenario-harness.js';

/**
 * What each ERP-simulator scenario (ST-73.2) does to the real consumers of Marketplace, Almacén and
 * Compras, with the in-memory adapters (no Docker, no PostgreSQL). The `expected` text of every fixture
 * is what the README tells the person to observe; this file keeps it true.
 *
 * Persistence is the only thing not exercised here: the SQL adapters have their own integration specs
 * and the manual run against the emulator is described in the README.
 */
const NOW = new Date('2026-12-01T10:00:00Z');
const played = new Set<string>();

async function play(name: string) {
    const fixture = loadScenario(name);
    expect(fixture, `no existe el escenario ${name}`).toBeDefined();
    played.add(name);
    const built = buildScenario(fixture!, { runId: 'test01', now: NOW });
    const harness = await createHarness();
    const outcomes = await harness.run(built);
    return { built, harness, outcomes, orderId: built.steps[0]!.orderId };
}

const outcomesOf = (outcomes: Awaited<ReturnType<typeof play>>['outcomes']) =>
    outcomes.map((entry) => entry.outcome);

describe('escenarios de Marketplace y Almacén contra los consumidores reales', () => {
    it('complete-order: crea un despacho pending', async () => {
        const { harness, orderId, outcomes } = await play('complete-order');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'processed']);
        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)).toMatchObject({ status: 'pending' });
        expect(harness.rejection.alerts).toEqual([]);
    });

    it('complete-order: el despacho nace con bultos empacados y su almacén de origen', async () => {
        const { harness, orderId } = await play('complete-order');

        expect(harness.generator.created[0]!.order).toMatchObject({
            warehouseId: 'WH-LPZ-01',
            physicallyPacked: true,
        });
        expect(harness.shipmentOf(orderId)).toMatchObject({ warehouseCode: 'WH-LPZ-01' });
        expect(harness.shipmentOf(orderId)!.packageReadyAt).toBeInstanceOf(Date);
    });

    it('out-of-order: el mismo despacho aunque los bultos lleguen primero', async () => {
        const { harness, orderId, outcomes } = await play('out-of-order');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'processed']);
        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)).toMatchObject({ status: 'pending' });
    });

    it('duplicate-message: la segunda entrega se ignora y hay un solo despacho', async () => {
        const { harness, outcomes } = await play('duplicate-message');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'duplicate', 'processed']);
        expect(harness.generator.created).toHaveLength(1);
    });

    it('stale-version: la versión 2 llega tarde y no pisa la dirección de la versión 3', async () => {
        const { harness, orderId } = await play('stale-version');

        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)!.deliveryAddress).toBe('Calle 21 de Calacoto 8790, casa 12');
    });

    it('address-change: el despacho existente toma la nueva dirección', async () => {
        const { harness, orderId } = await play('address-change');

        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)!.deliveryAddress).toBe('Calle 21 de Calacoto 8790, casa 12');
    });

    it('cancellation: el despacho pasa a cancelled', async () => {
        const { harness, orderId } = await play('cancellation');

        expect(harness.dispatchOf(orderId)).toMatchObject({ status: 'cancelled' });
    });

    it('invalid-message: va al dead-letter por esquema y no crea despacho', async () => {
        const { harness, outcomes, built } = await play('invalid-message');

        expect(outcomesOf(outcomes)).toEqual(['rejected']);
        const deadLetters = harness.bus.deadLettersOf('marketplace.sales_order.confirmed');
        expect(deadLetters).toHaveLength(1);
        expect(deadLetters[0]!.originalTopic).toBe('marketplace.sales_order.confirmed');
        expect(deadLetters[0]!.errors.map((error) => error.message).join(' ')).toContain('recipient');
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['schema_invalid']);
        expect(harness.generator.created).toHaveLength(0);
        expect(harness.dispatchOf(built.steps[0]!.orderId)).toBeUndefined();
    });

    it('lost-delivery-data: el registro que responde la solicitud completa el pedido', async () => {
        const { harness, orderId, outcomes } = await play('lost-delivery-data');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'processed']);
        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)).toMatchObject({ status: 'pending' });
    });

    it('lost-delivery-data: sin la respuesta no hay despacho', async () => {
        const fixture = loadScenario('lost-delivery-data')!;
        const built = buildScenario(fixture, { runId: 'test01', now: NOW });
        const harness = await createHarness();

        await harness.publish(built.steps.find((step) => step.respondsTo === undefined)!);

        expect(harness.generator.created).toHaveLength(0);
    });

    it('lost-shipment: el aviso de bultos que responde la solicitud completa el pedido', async () => {
        const { harness, orderId, outcomes } = await play('lost-shipment');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'processed']);
        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)).toMatchObject({ status: 'pending' });
    });

    it('unknown-warehouse: dead-letter por almacén desconocido y sin despacho', async () => {
        const { harness, outcomes } = await play('unknown-warehouse');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'rejected']);
        expect(harness.bus.deadLettersOf('inventory.shipment.ready')).toHaveLength(1);
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['unknown_warehouse']);
        expect(harness.generator.created).toHaveLength(0);
    });

    it('packages-change: el despacho existente pasa a dos bultos', async () => {
        const { harness, orderId } = await play('packages-change');

        expect(harness.generator.created).toHaveLength(1);
        expect(harness.shipmentOf(orderId)!.packages).toHaveLength(2);
    });

    it('shipment-cancelled: no queda un despacho activo', async () => {
        const { harness, orderId } = await play('shipment-cancelled');

        expect(harness.generator.created).toHaveLength(1);
        expect(harness.dispatchOf(orderId)!.status).toBe('cancelled');
    });

    it('invalid-shipment: dead-letter por esquema', async () => {
        const { harness, outcomes } = await play('invalid-shipment');

        expect(outcomesOf(outcomes)).toEqual(['rejected']);
        expect(harness.bus.deadLettersOf('inventory.shipment.ready')).toHaveLength(1);
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['schema_invalid']);
    });
});

describe('escenarios de Compras contra el consumidor real', () => {
    it('pickup-requested: llega a la creación del despacho de recogida', async () => {
        const { harness, outcomes, orderId } = await play('pickup-requested');

        expect(outcomesOf(outcomes)).toEqual(['processed']);
        expect(harness.procurement.requested).toHaveLength(1);
        expect(harness.procurement.requested[0]).toMatchObject({ purchaseOrderId: orderId });
    });

    it('pickup-window-change: la solicitud es seguida por el cambio de ventana', async () => {
        const { harness } = await play('pickup-window-change');

        expect(harness.procurement.requested).toHaveLength(1);
        expect(harness.procurement.updated).toHaveLength(1);
    });

    it('pickup-cancelled: la cancelación llega al despacho de recogida', async () => {
        const { harness } = await play('pickup-cancelled');

        expect(harness.procurement.requested).toHaveLength(1);
        expect(harness.procurement.cancelled).toHaveLength(1);
    });

    it('duplicate-pickup: la segunda entrega se ignora', async () => {
        const { harness, outcomes } = await play('duplicate-pickup');

        expect(outcomesOf(outcomes)).toEqual(['processed', 'duplicate']);
        expect(harness.procurement.requested).toHaveLength(1);
    });

    it('invalid-pickup-window: dead-letter por ventana, sin llegar al repositorio', async () => {
        const { harness, outcomes } = await play('invalid-pickup-window');

        expect(outcomesOf(outcomes)).toEqual(['rejected']);
        expect(harness.bus.deadLettersOf('procurement.pickup.requested')).toHaveLength(1);
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['invalid_pickup_window']);
        expect(harness.procurement.requested).toHaveLength(0);
    });

    it('invalid-pickup: dead-letter por esquema', async () => {
        const { harness, outcomes } = await play('invalid-pickup');

        expect(outcomesOf(outcomes)).toEqual(['rejected']);
        expect(harness.rejection.alerts.map((alert) => alert.reasonCode)).toEqual(['schema_invalid']);
        expect(harness.procurement.requested).toHaveLength(0);
    });
});

describe('cobertura de escenarios', () => {
    it('todo fixture tiene una prueba de comportamiento (corre al final del archivo)', () => {
        const all = (['marketplace', 'inventory', 'procurement'] as const).flatMap((script) =>
            scenariosOf(script).map((fixture) => fixture.scenario),
        );
        expect(all.filter((name) => !played.has(name))).toEqual([]);
    });
});
