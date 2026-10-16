// ST-72.5 (corrección) — Orden de bloqueo del adaptador de cambios sobre despachos existentes.
//
// El corte de D-1 (ST-51.3), la 1.ª aprobación y el generador bloquean el LOTE y después sus pedidos. El
// adaptador de ST-72.5 bloqueaba el PEDIDO y después subía la versión de su lote: con un pedido `in_planning`
// de un lote provisional, un mensaje de Almacén y el corte se esperaban mutuamente (deadlock 40P01).
//
// Esta prueba usa dos transacciones reales contra Postgres: una hace lo que hace el corte (bloquea el lote y
// después el pedido) y la otra ejecuta el adaptador. Sin el arreglo, Postgres aborta una con `40P01`; con él, el
// adaptador espera al lote y termina cuando la otra confirma. Todo lo que crea lleva un prefijo único y se borra.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryRunner } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { TypeOrmExistingDispatchChanges } from '../src/modules/messaging/sales-order-intake/repositories/typeorm-existing-dispatch-changes.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Lock order of the changes over existing dispatches (e2e, ST-72.5 fix)', () => {
    let app: Awaited<ReturnType<TestingModule['createNestApplication']>>;
    let dataSource: DataSource;
    const run = Date.now().toString(36).toUpperCase();
    const refPrefix = `E2ELOCK-${run}-`;
    let seq = 0;
    let zoneId = 0;
    let warehouseId = 0;
    const batchIds: number[] = [];

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    /** A provisional batch with one `in_planning` order in it: the case that leaves the batch on a change. */
    const makeBatchWithOrder = async () => {
        const [{ route_batch_id }] = await dataSource.query(
            `INSERT INTO route_batches (status, version, shift_date, delivery_zone_id, origin_warehouse_id)
             VALUES ('provisional', 1, CURRENT_DATE + 30, $1, $2) RETURNING route_batch_id`,
            [zoneId, warehouseId],
        );
        batchIds.push(route_batch_id);
        const ref = `${refPrefix}${++seq}`;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, origin_warehouse_id,
                                     source_order_ref, delivery_address, delivery_latitude, delivery_longitude,
                                     estimated_weight_kg, order_confirmed_at, shipment_ready, route_batch_id,
                                     sequence_order, version)
             VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                     (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'in_planning'),
                     $1, $2, $3, 'Dirección de prueba', -16.5, -68.1, 10, NOW(), TRUE, $4, 1, 1)
             RETURNING dispatch_id`,
            [zoneId, warehouseId, ref, route_batch_id],
        );
        return { batchId: route_batch_id as number, dispatchId: dispatch_id as number, ref };
    };

    const open = async (): Promise<QueryRunner> => {
        const runner = dataSource.createQueryRunner();
        await runner.connect();
        await runner.startTransaction();
        return runner;
    };

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(new FakeOsrm())
            .compile();
        app = moduleRef.createNestApplication();
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const [zone] = await dataSource.query(
            `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
            [`LK${run}`.slice(0, 20), `Zona e2e bloqueo ${run}`],
        );
        zoneId = zone.delivery_zone_id;
        const [wh] = await dataSource.query(`SELECT warehouse_id FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouseId = wh.warehouse_id;
    });

    afterAll(async () => {
        if (dataSource) {
            await withEventPurge(dataSource, { dispatchRefs: [`${refPrefix}%`], routeBatchIds: batchIds });
            await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${refPrefix}%`]);
            if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
            if (zoneId) await dataSource.query(`DELETE FROM delivery_zones WHERE delivery_zone_id = $1`, [zoneId]);
        }
        await app?.close();
    });

    it('waits for the batch held by the cutoff instead of deadlocking with it', async () => {
        const { batchId, dispatchId, ref } = await makeBatchWithOrder();
        const changes = new TypeOrmExistingDispatchChanges(dataSource);

        // "The cutoff": locks the batch first, like the real writer does.
        const cutoff = await open();
        await cutoff.query(`SELECT route_batch_id FROM route_batches WHERE route_batch_id = $1 FOR UPDATE`, [batchId]);

        // A cancellation from Marketplace for the same order arrives meanwhile.
        const message = await open();
        const handled = changes
            .cancel(
                { salesOrderId: ref, source: 'marketplace', cancelledAt: new Date().toISOString(), reason: 'Cliente' },
                { manager: message.manager },
            )
            .then(
                async (outcome) => {
                    await message.commitTransaction();
                    return { outcome, error: null as unknown };
                },
                async (error: unknown) => {
                    await message.rollbackTransaction();
                    return { outcome: null, error };
                },
            );

        // Let the message reach its first lock, then the cutoff takes the order (second step of its order).
        await sleep(400);
        let cutoffError: unknown = null;
        try {
            await cutoff.query(`SELECT dispatch_id FROM dispatches WHERE dispatch_id = $1 FOR UPDATE`, [dispatchId]);
            await cutoff.commitTransaction();
        } catch (error) {
            cutoffError = error;
            await cutoff.rollbackTransaction();
        }
        const result = await handled;
        await cutoff.release();
        await message.release();

        const code = (error: unknown) => (error as { driverError?: { code?: string } } | null)?.driverError?.code ?? null;
        expect(code(cutoffError)).toBeNull();
        expect(code(result.error)).toBeNull();
        expect(result.outcome).toMatchObject({ status: 'applied', statusBefore: 'in_planning', statusAfter: 'cancelled' });

        const [dispatch] = await dataSource.query(
            `SELECT s.name AS status, d.route_batch_id FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
              WHERE d.dispatch_id = $1`, [dispatchId]);
        expect(dispatch).toMatchObject({ status: 'cancelled', route_batch_id: null });
        const [batch] = await dataSource.query(`SELECT version FROM route_batches WHERE route_batch_id = $1`, [batchId]);
        expect(batch.version).toBe(2);
    });
});
