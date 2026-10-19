// ST-33.2 — GET /dispatches/my-history: historial paginado del repartidor.
// Dataset aislado por corrida; todos sus registros se eliminan en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('GET /dispatches/my-history (e2e, ST-33.2)', () => {
  let app: INestApplication;
  let db: DataSource;
  let prefix: string;
  const run = Date.now().toString(36).toUpperCase();
  const tag = `e2e_dh33_${run}`;
  const token: Record<string, string> = {};
  const userIds: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const dispatchRefs: string[] = [];
  const batchIds: number[] = [];
  const dispatchIds: Record<string, number> = {};
  let deliveryTypeId: number;
  let primaryEvidenceId: string;

  const http = () => request(app.getHttpServer());
  const url = () => `/${prefix}/dispatches/my-history`;
  const get = (who: string, query: Record<string, string | number> = {}) =>
    http()
      .get(url())
      .query(query)
      .set({ Authorization: `Bearer ${token[who]}` });

  const createUser = async (key: string, role: string): Promise<number> => {
    const username = `${tag}_${key}`;
    const [{ role_id: roleId }] = await db.query(
      `SELECT role_id FROM roles WHERE name = $1`,
      [role],
    );
    const [{ user_id: id }] = await db.query(
      `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, FALSE, TRUE) RETURNING user_id`,
      [
        roleId,
        `History ${key} ${run}`,
        username,
        await hashPassword('E2eTest1234'),
      ],
    );
    userIds[key] = id as number;
    const login = await http()
      .post(`/${prefix}/auth/login`)
      .send({ username, password: 'E2eTest1234' });
    expect(login.status, `login for ${key}`).toBe(200);
    token[key] = login.body.accessToken as string;
    return id as number;
  };

  const createBatch = async (driverId: number): Promise<number> => {
    const [{ route_batch_id: id }] = await db.query(
      `INSERT INTO route_batches (driver_id, shift_date, status)
             VALUES ($1, DATE '2040-03-01' + $2::int, 'closed') RETURNING route_batch_id`,
      [driverId, batchIds.length],
    );
    batchIds.push(id as number);
    return id as number;
  };

  const insertDispatch = async (
    key: string,
    batchId: number,
    status: string,
    closedAt: string,
  ): Promise<number> => {
    const ref = `DH33-${run}-${key}`;
    const trackingCode = `H${run.slice(-7)}${key}`;
    dispatchRefs.push(ref);
    const [{ dispatch_id: id }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref,
                                    tracking_code, delivery_address, contact_name, closed_at)
             VALUES ($1, $2, $3, $4, $5, 'Dirección e2e', $6, $7) RETURNING dispatch_id`,
      [
        deliveryTypeId,
        statuses[status],
        batchId,
        ref,
        trackingCode,
        `Cliente ${key}`,
        closedAt,
      ],
    );
    dispatchIds[key] = id as number;
    return id as number;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prefix = app.get(AppConfig).apiPrefix;
    app.setGlobalPrefix(prefix);
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    db = moduleRef.get(DataSource);

    const [{ dispatch_type_id: typeId }] = await db.query(
      `SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`,
    );
    deliveryTypeId = typeId;
    for (const row of await db.query(
      `SELECT dispatch_status_id, name FROM dispatch_statuses`,
    ))
      statuses[row.name] = row.dispatch_status_id;

    const driver1 = await createUser('driver1', 'driver');
    const driver2 = await createUser('driver2', 'driver');
    await createUser('coordinator', 'coordinator');
    const batch1 = await createBatch(driver1);
    const batch2 = await createBatch(driver2);

    // In Bolivia both first rows belong to March 10; the third is exactly March 11 00:00.
    await insertDispatch('A1', batch1, 'delivered', '2040-03-11T03:30:00.000Z');
    primaryEvidenceId = uuidv7();
    await db.query(
      `INSERT INTO delivery_evidences (delivery_evidence_id, dispatch_id, type, file_url, receiver_name)
       VALUES ($1, $2, 'signature', 'https://example.test/e2e-signature', 'Receptor ST-33.2')`,
      [primaryEvidenceId, dispatchIds.A1],
    );
    await insertDispatch('A2', batch1, 'returned', '2040-03-11T03:59:59.999Z');
    await insertDispatch('A3', batch1, 'delivered', '2040-03-11T04:00:00.000Z');
    await insertDispatch('B1', batch2, 'delivered', '2040-03-10T15:00:00.000Z');
    await insertDispatch('A4', batch1, 'cancelled', '2040-03-12T15:00:00.000Z');
    await insertDispatch(
      'A5',
      batch1,
      'in_transit',
      '2040-03-13T15:00:00.000Z',
    );
  });

  afterAll(async () => {
    if (db?.isInitialized) {
      await withEventPurge(
        db,
        {
          dispatchRefs: [`DH33-${run}-%`],
          routeBatchIds: batchIds,
          userNames: Object.keys(userIds).map((key) => `${tag}_${key}`),
        },
        async (manager) => {
          await manager.query(
            `DELETE FROM delivery_evidences WHERE dispatch_id = ANY($1::int[])`,
            [Object.values(dispatchIds)],
          );
          await manager.query(
            `DELETE FROM dispatches WHERE source_order_ref LIKE $1`,
            [`DH33-${run}-%`],
          );
          await manager.query(
            `DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`,
            [batchIds],
          );
          await manager.query(
            `DELETE FROM users WHERE username LIKE ANY($1::text[])`,
            [Object.keys(userIds).map((key) => `${tag}_${key}`)],
          );
        },
      );
    }
    await app?.close();
  });

  describe('acceso', () => {
    it('sin token → 401', async () => {
      expect((await http().get(url())).status).toBe(401);
    });

    it('un rol distinto de repartidor → 403', async () => {
      const res = await get('coordinator');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  it('pagina los resultados y conserva el total global', async () => {
    const first = await get('driver1', { page: 1, limit: 2 });
    const second = await get('driver1', { page: 2, limit: 2 });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(first.body.data).toHaveLength(2);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(second.body.data).toHaveLength(1);
    expect(
      [...first.body.data, ...second.body.data].map(
        (row: { trackingCode: string }) => row.trackingCode,
      ),
    ).toHaveLength(3);
  });

  it('incluye datos del despacho, cierre y comprobante de entrega', async () => {
    const res = await get('driver1', { search: `H${run.slice(-7)}A1` });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        trackingCode: `H${run.slice(-7)}A1`,
        customerName: 'Cliente A1',
        receiverName: 'Receptor ST-33.2',
        closedAt: '2040-03-11T03:30:00.000Z',
        evidenceId: primaryEvidenceId,
        status: 'delivered',
      }),
    ]);
  });

  it('incluye ambos extremos del rango de fechas según la hora de Bolivia', async () => {
    const march10 = await get('driver1', {
      from: '2040-03-10',
      to: '2040-03-10',
    });
    const march11 = await get('driver1', {
      from: '2040-03-11',
      to: '2040-03-11',
    });

    expect(march10.body.total).toBe(2);
    expect(
      march10.body.data
        .map((row: { trackingCode: string }) => row.trackingCode)
        .sort(),
    ).toEqual([`H${run.slice(-7)}A1`, `H${run.slice(-7)}A2`].sort());
    expect(march11.body.total).toBe(1);
    expect(march11.body.data[0].trackingCode).toBe(`H${run.slice(-7)}A3`);
  });

  it('filtra por estado final y por búsqueda parcial del código de guía', async () => {
    const delivered = await get('driver1', { status: 'delivered' });
    const returned = await get('driver1', { status: 'returned' });
    const search = await get('driver1', { search: `h${run.slice(-7)}a2` });

    expect(delivered.body.total).toBe(2);
    expect(
      delivered.body.data.every(
        (row: { status: string }) => row.status === 'delivered',
      ),
    ).toBe(true);
    expect(returned.body.total).toBe(1);
    expect(returned.body.data[0].status).toBe('returned');
    expect(search.body.total).toBe(1);
    expect(search.body.data[0].trackingCode).toBe(`H${run.slice(-7)}A2`);
  });

  it('el JWT limita la consulta a las entregas del repartidor autenticado', async () => {
    const driver1 = await get('driver1');
    const driver2 = await get('driver2');

    expect(driver1.body.total).toBe(3);
    expect(
      driver1.body.data.map(
        (row: { trackingCode: string }) => row.trackingCode,
      ),
    ).not.toContain(`H${run.slice(-7)}B1`);
    expect(driver2.body.total).toBe(1);
    expect(driver2.body.data[0].trackingCode).toBe(`H${run.slice(-7)}B1`);
  });

  it('excluye otros estados, aunque el despacho tenga fecha de cierre', async () => {
    const res = await get('driver1');
    const included = res.body.data.map((row: { status: string }) => row.status);

    expect(res.body.total).toBe(3);
    expect(included).not.toContain('cancelled');
    expect(included).not.toContain('in_transit');
  });

  it('un período sin registros responde 200 con la forma paginada vacía', async () => {
    const res = await get('driver1', { from: '2050-01-01', to: '2050-01-02' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], total: 0, page: 1, limit: 20 });
  });

  it.each([
    ['page sobre el máximo', { page: 1_000_001 }],
    ['search sobre el máximo', { search: 'x'.repeat(101) }],
  ])('rechaza %s con 400', async (_description, query) => {
    expect((await get('driver1', query)).status).toBe(400);
  });
});
