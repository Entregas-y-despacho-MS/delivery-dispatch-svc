import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ProcurementPickupRepository } from './procurement-pickup.repository.js';

/**
 * Against PostgreSQL with delivery-dispatch-db migration 015 applied. Skipped unless TEST_DB_PORT
 * is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=5433 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run procurement-pickup.repository.integration
 *
 * Each test rolls back its transaction so no fixture or audit/event row remains in the database.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');

describe.skipIf(!PORT)('ProcurementPickupRepository against PostgreSQL', () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let counter = 0;

  const purchaseOrderId = (): string => `IT-PO-${RUN}-${++counter}`;
  const manager = (): EntityManager => runner.manager;
  const options = () => ({ manager: manager() });

  const createScheduledPickup = async (orderId: string): Promise<number> => {
    const [warehouse] = await manager().query(
      `SELECT warehouse_id, code FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1`,
    );
    if (!warehouse)
      throw new Error('The test database needs an active warehouse fixture.');

    const repository = new ProcurementPickupRepository();
    const created = await repository.applyRequested(
      {
        purchaseOrderId: orderId,
        recordVersion: 1,
        updatedAt: '2026-10-14T17:00:00Z',
        approvedAt: '2026-10-14T16:00:00Z',
        supplier: { supplierId: 'SUP-IT', name: 'Proveedor de prueba' },
        contact: {
          name: 'Contacto de prueba',
          phone: '+59170000000',
          email: 'pickup-it@example.com',
        },
        pickupAddress: {
          line: 'Planta Norte, Calle 5',
          reference: 'Portón azul',
          location: { latitude: -16.5, longitude: -68.1 },
        },
        pickupWindow: {
          startsAt: '2026-10-20T13:00:00Z',
          endsAt: '2026-10-20T18:00:00Z',
        },
        warehouseId: warehouse.code as string,
        products: [{ productId: 'SKU-IT', quantity: 2 }],
        estimates: { weightKg: 18 },
      },
      options(),
    );
    expect(created).toBeNull();

    const [row] = await manager().query(
      `SELECT dispatch_id AS id FROM dispatches WHERE source_order_ref = $1 AND dispatch_type_id = (SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup')`,
      [orderId],
    );

    await manager().query(
      `UPDATE dispatches
          SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'scheduled')
        WHERE dispatch_id = $1`,
      [row.id],
    );
    return row.id as number;
  };

  const dispatchState = async (id: number) => {
    const [row] = await manager().query(
      `SELECT s.name AS status, d.estimated_weight_kg, d.destination_warehouse_id
         FROM dispatches d
         JOIN dispatch_statuses s USING (dispatch_status_id)
        WHERE d.dispatch_id = $1`,
      [id],
    );
    return row;
  };

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.TEST_DB_HOST ?? 'localhost',
      port: Number(PORT),
      username: process.env.TEST_DB_USER,
      password: process.env.TEST_DB_PASSWORD,
      database: process.env.TEST_DB_NAME,
    });
    await dataSource.initialize();
  });

  beforeEach(async () => {
    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
  });

  afterEach(async () => {
    if (runner?.isTransactionActive) await runner.rollbackTransaction();
    if (runner && !runner.isReleased) await runner.release();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('keeps the scheduled status when an estimate-only update is applied', async () => {
    const orderId = purchaseOrderId();
    const dispatchId = await createScheduledPickup(orderId);
    const repository = new ProcurementPickupRepository();

    const outcome = await repository.applyUpdated(
      {
        purchaseOrderId: orderId,
        recordVersion: 2,
        updatedAt: '2026-10-14T18:00:00Z',
        estimates: { weightKg: 24 },
      },
      options(),
    );

    expect(outcome).toBeNull();
    expect(await dispatchState(dispatchId)).toMatchObject({
      status: 'scheduled',
      estimated_weight_kg: '24.00',
    });
    const events = await manager().query(
      `SELECT event_type FROM dispatch_events WHERE dispatch_id = $1 ORDER BY dispatch_event_id`,
      [dispatchId],
    );
    expect(
      events.map(({ event_type }: { event_type: string }) => event_type),
    ).toContain('supplier_pickup_updated');
    expect(
      events.map(({ event_type }: { event_type: string }) => event_type),
    ).not.toContain('change_requires_attention');
  });

  it('preserves a scheduled pickup in the existing-request update branch', async () => {
    const orderId = purchaseOrderId();
    const dispatchId = await createScheduledPickup(orderId);
    const [dispatch] = await manager().query(
      `SELECT destination_warehouse_id FROM dispatches WHERE dispatch_id = $1`,
      [dispatchId],
    );
    const [warehouse] = await manager().query(
      `SELECT code FROM warehouses WHERE warehouse_id = $1`,
      [dispatch.destination_warehouse_id],
    );
    const repository = new ProcurementPickupRepository();

    const outcome = await repository.applyRequested(
      {
        purchaseOrderId: orderId,
        recordVersion: 2,
        updatedAt: '2026-10-14T18:00:00Z',
        approvedAt: '2026-10-14T16:00:00Z',
        supplier: { supplierId: 'SUP-IT', name: 'Proveedor de prueba' },
        contact: {
          name: 'Contacto de prueba',
          phone: '+59170000000',
          email: 'pickup-it@example.com',
        },
        pickupAddress: {
          line: 'Planta Norte, Calle 5',
          reference: 'Portón azul',
          location: { latitude: -16.5, longitude: -68.1 },
        },
        pickupWindow: {
          startsAt: '2026-10-20T13:00:00Z',
          endsAt: '2026-10-20T18:00:00Z',
        },
        warehouseId: warehouse.code as string,
        products: [{ productId: 'SKU-IT', quantity: 2 }],
        estimates: { weightKg: 26 },
      },
      options(),
    );

    expect(outcome).toBeNull();
    expect(await dispatchState(dispatchId)).toMatchObject({
      status: 'scheduled',
      estimated_weight_kg: '26.00',
    });
  });

  it('alerts without modifying a scheduled pickup when its required destination becomes unavailable', async () => {
    const orderId = purchaseOrderId();
    const dispatchId = await createScheduledPickup(orderId);
    const before = await dispatchState(dispatchId);
    const repository = new ProcurementPickupRepository();

    const outcome = await repository.applyUpdated(
      {
        purchaseOrderId: orderId,
        recordVersion: 2,
        updatedAt: '2026-10-14T18:00:00Z',
        warehouseId: `MISSING-${RUN}`,
      },
      options(),
    );

    expect(outcome).toMatchObject({
      status: 'attention_required',
      dispatchId,
      event: { changeType: 'order_changed' },
    });
    expect(await dispatchState(dispatchId)).toEqual(before);
    const events = await manager().query(
      `SELECT event_type FROM dispatch_events WHERE dispatch_id = $1 ORDER BY dispatch_event_id`,
      [dispatchId],
    );
    expect(
      events.map(({ event_type }: { event_type: string }) => event_type),
    ).toContain('change_requires_attention');
  });
});
