// ST-51.5 — HTTP/PostgreSQL acceptance checks for starting a route.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('POST /route-batches/:id/start (e2e, ST-51.5)', () => {
  let app: INestApplication;
  let db: DataSource;
  let prefix: string;
  const tokens: Record<'driver1' | 'driver2', string> = {
    driver1: '',
    driver2: '',
  };
  const users: Record<'driver1' | 'driver2', number> = {
    driver1: 0,
    driver2: 0,
  };
  const sourceRefs: string[] = [];
  const batchIds: number[] = [];
  const userIds: number[] = [];
  const run = Date.now().toString(36).toUpperCase();
  let fixtureSequence = 0;

  const http = () => request(app.getHttpServer());
  const api = (path: string) => `/${prefix}${path}`;
  const auth = (driver: 'driver1' | 'driver2') => ({
    Authorization: `Bearer ${tokens[driver]}`,
  });

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

    const [{ role_id: driverRoleId }] = await db.query(
      `SELECT role_id FROM roles WHERE name = 'driver'`,
    );
    const password = 'E2eTest1234';
    const passwordHash = await hashPassword(password);
    const created = await db.query(
      `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
       VALUES ($1, $2, $3, $4, TRUE, FALSE), ($1, $5, $6, $4, TRUE, FALSE)
       RETURNING user_id, username`,
      [
        driverRoleId,
        `ST515 driver 1 ${run}`,
        `st515_driver1_${run}`,
        passwordHash,
        `ST515 driver 2 ${run}`,
        `st515_driver2_${run}`,
      ],
    );
    users.driver1 = Number(created[0].user_id);
    users.driver2 = Number(created[1].user_id);
    userIds.push(users.driver1, users.driver2);
    tokens.driver1 = (
      await http()
        .post(api('/auth/login'))
        .send({ username: created[0].username, password })
    ).body.accessToken;
    tokens.driver2 = (
      await http()
        .post(api('/auth/login'))
        .send({ username: created[1].username, password })
    ).body.accessToken;
  });

  afterAll(async () => {
    if (db) {
      await withEventPurge(
        db,
        { dispatchRefs: sourceRefs, routeBatchIds: batchIds },
        async (manager) => {
          await manager.query(
            `DELETE FROM outbound_messages WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = ANY($1::text[])`,
            [sourceRefs],
          );
          await manager.query(
            `DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`,
            [sourceRefs],
          );
          await manager.query(
            `DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`,
            [batchIds],
          );
          await manager.query(
            `DELETE FROM users WHERE user_id = ANY($1::int[])`,
            [userIds],
          );
        },
      );
    }
    await app?.close();
  });

  async function fixture(
    status = 'confirmed',
    driver: 'driver1' | 'driver2' = 'driver1',
    trackingCode: string | null = `DSP-2040-${String(fixtureSequence + 1).padStart(5, '0')}`,
    accepted = status === 'confirmed',
  ) {
    const sequence = fixtureSequence++;
    const sourceOrderRef = `ST515-${run}-${sequence}`;
    sourceRefs.push(sourceOrderRef);
    const shiftDate = `2040-01-01`;
    const [{ route_batch_id: routeBatchId }] = await db.query(
      `INSERT INTO route_batches (status, driver_id, shift_date, accepted_at)
       VALUES ($1, $2, $3::date + $4::int, $5) RETURNING route_batch_id`,
      [status, users[driver], shiftDate, sequence, accepted ? new Date() : null],
    );
    batchIds.push(Number(routeBatchId));
    const [{ dispatch_type_id: typeId }] = await db.query(
      `SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`,
    );
    const [{ dispatch_status_id: assignedId }] = await db.query(
      `SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned'`,
    );
    const [{ dispatch_id: dispatchId }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
          source_order_ref, delivery_address, tracking_code, version)
       VALUES ($1, $2, $3, 1, $4, 'Test destination', $5, 4) RETURNING dispatch_id`,
      [
        typeId,
        assignedId,
        routeBatchId,
        sourceOrderRef,
        trackingCode,
      ],
    );
    const packageId = `${sourceOrderRef}-PKG`;
    await db.query(
      `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
       VALUES ($1, $2, 20, 20, 20, 5)`,
      [dispatchId, packageId],
    );
    return {
      routeBatchId: Number(routeBatchId),
      dispatchId: Number(dispatchId),
      sourceOrderRef,
      packageId,
    };
  }

  it('starts the confirmed route even when accepted_at is null, and persists custody and outbox data', async () => {
    const { routeBatchId, dispatchId, sourceOrderRef, packageId } =
      await fixture();
    const eventId = uuidv7();
    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      routeBatchId,
      status: 'in_execution',
      dispatchIds: [dispatchId],
      excludedDispatchIds: [],
    });
    const [{ status: batchStatus, accepted_at: acceptedAt }] = await db.query(
      `SELECT status, accepted_at FROM route_batches WHERE route_batch_id = $1`,
      [routeBatchId],
    );
    expect(batchStatus).toBe('in_execution');
    expect(acceptedAt).toBeNull();
    const [{ status: dispatchStatus }] = await db.query(
      `SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
      [dispatchId],
    );
    expect(dispatchStatus).toBe('out_for_delivery');
    const [{ metadata: custody }] = await db.query(
      `SELECT metadata FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'route_started'`,
      [routeBatchId],
    );
    expect(custody).toMatchObject({
      eventId,
      driverId: users.driver1,
      dispatchIds: [dispatchId],
      dispatches: [{ dispatchId, packageIds: [packageId] }],
    });
    const [{ payload }] = await db.query(
      `SELECT payload FROM outbound_messages WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = $1`,
      [sourceOrderRef],
    );
    expect(payload.data).toMatchObject({
      salesOrderId: sourceOrderRef,
      driverId: String(users.driver1),
      packageIds: [packageId],
      recordVersion: 4,
    });
  });

  it('keeps a route confirmed when an assigned dispatch has no contract-required tracking code', async () => {
    const { routeBatchId, dispatchId, sourceOrderRef } = await fixture('confirmed', 'driver1', null);

    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('DISPATCH_TRACKING_CODE_REQUIRED');
    const [{ status: batchStatus }] = await db.query(
      `SELECT status FROM route_batches WHERE route_batch_id = $1`,
      [routeBatchId],
    );
    expect(batchStatus).toBe('confirmed');
    const [{ status: dispatchStatus, tracking_code: trackingCode }] = await db.query(
      `SELECT s.name AS status, d.tracking_code
         FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
        WHERE d.dispatch_id = $1`,
      [dispatchId],
    );
    expect(dispatchStatus).toBe('assigned');
    expect(trackingCode).toBeNull();
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM outbound_messages
        WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = $1`,
      [sourceOrderRef],
    );
    expect(count).toBe(0);
  });

  it('returns 409 when the batch is not confirmed', async () => {
    const { routeBatchId, dispatchId } = await fixture('provisional');
    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_NOT_CONFIRMED');
    const [{ status }] = await db.query(
      `SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
      [dispatchId],
    );
    expect(status).toBe('assigned');
  });

  it('returns 409 when the confirmed batch was not accepted by the driver yet (ST-210.1)', async () => {
    const { routeBatchId, dispatchId } = await fixture(
      'confirmed',
      'driver1',
      undefined,
      false,
    );
    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_NOT_ACCEPTED');
    const [{ status }] = await db.query(
      `SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
      [dispatchId],
    );
    expect(status).toBe('assigned');
  });

  it('returns the same result on an idempotent retry and creates one departure message', async () => {
    const { routeBatchId, sourceOrderRef } = await fixture();
    const eventId = uuidv7();
    const send = () =>
      http()
        .post(api(`/route-batches/${routeBatchId}/start`))
        .set(auth('driver1'))
        .send({ eventId });
    const first = await send();
    const retry = await send();

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const [{ count: routeEvents }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'route_started'`,
      [routeBatchId],
    );
    const [{ count: messages }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM outbound_messages WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = $1`,
      [sourceOrderRef],
    );
    expect(routeEvents).toBe(1);
    expect(messages).toBe(1);
  });

  it('starts only dispatches without an unresolved cotejo failure and repeats the exclusions idempotently', async () => {
    const { routeBatchId, dispatchId, sourceOrderRef } = await fixture();
    const excludedOrderRef = `${sourceOrderRef}-EXCLUDED`;
    sourceRefs.push(excludedOrderRef);
    const [{ dispatch_type_id: typeId }] = await db.query(
      `SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`,
    );
    const [{ dispatch_status_id: assignedId }] = await db.query(
      `SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned'`,
    );
    const [{ dispatch_id: excludedDispatchId }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
          source_order_ref, delivery_address, tracking_code, version)
       VALUES ($1, $2, $3, 2, $4, 'Excluded test destination', NULL, 1) RETURNING dispatch_id`,
      [typeId, assignedId, routeBatchId, excludedOrderRef],
    );
    const excludedPackageId = `${excludedOrderRef}-PKG`;
    await db.query(
      `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
       VALUES ($1, $2, 20, 20, 20, 5)`,
      [excludedDispatchId, excludedPackageId],
    );
    await db.query(
      `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
       VALUES ($1, 'cotejo_failed', $2, 'user', 'Package did not pass the physical check', $3::jsonb)`,
      [
        excludedDispatchId,
        users.driver1,
        JSON.stringify({
          routeBatchId,
          packageIds: [excludedPackageId],
          photo: 'e2e://cotejo-failure.jpg',
        }),
      ],
    );

    const eventId = uuidv7();
    const send = () =>
      http()
        .post(api(`/route-batches/${routeBatchId}/start`))
        .set(auth('driver1'))
        .send({ eventId });
    const first = await send();
    const retry = await send();

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      dispatchIds: [dispatchId],
      excludedDispatchIds: [Number(excludedDispatchId)],
    });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const [{ metadata: routeStarted }] = await db.query(
      `SELECT metadata FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'route_started'`,
      [routeBatchId],
    );
    expect(routeStarted).toMatchObject({
      dispatchIds: [dispatchId],
      excludedDispatchIds: [Number(excludedDispatchId)],
    });
    const statuses = await db.query(
      `SELECT d.dispatch_id, s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
        WHERE d.dispatch_id = ANY($1::int[]) ORDER BY d.dispatch_id`,
      [[dispatchId, excludedDispatchId]],
    );
    expect(statuses).toEqual([
      { dispatch_id: dispatchId, status: 'out_for_delivery' },
      { dispatch_id: Number(excludedDispatchId), status: 'assigned' },
    ]);
    const messages = await db.query(
      `SELECT payload #>> '{data,salesOrderId}' AS order_ref FROM outbound_messages
        WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = ANY($1::text[])
        ORDER BY payload #>> '{data,salesOrderId}'`,
      [[sourceOrderRef, excludedOrderRef]],
    );
    expect(messages).toEqual([{ order_ref: sourceOrderRef }]);
  });

  it('returns a dedicated 409 and leaves the batch confirmed when every dispatch is excluded', async () => {
    const { routeBatchId, dispatchId, packageId, sourceOrderRef } =
      await fixture();
    await db.query(
      `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
       VALUES ($1, 'cotejo_failed', $2, 'user', 'Package did not pass the physical check', $3::jsonb)`,
      [
        dispatchId,
        users.driver1,
        JSON.stringify({ routeBatchId, packageIds: [packageId] }),
      ],
    );

    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_ALL_DISPATCHES_EXCLUDED');
    const [{ status }] = await db.query(
      `SELECT status FROM route_batches WHERE route_batch_id = $1`,
      [routeBatchId],
    );
    expect(status).toBe('confirmed');
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM outbound_messages WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = $1`,
      [sourceOrderRef],
    );
    expect(count).toBe(0);
  });

  it('returns 403 when another driver starts the route', async () => {
    const { routeBatchId, sourceOrderRef } = await fixture();
    const response = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver2'))
      .send({ eventId: uuidv7() });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('INSUFFICIENT_PERMISSIONS');
    const [{ status }] = await db.query(
      `SELECT status FROM route_batches WHERE route_batch_id = $1`,
      [routeBatchId],
    );
    expect(status).toBe('confirmed');
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM outbound_messages WHERE type = 'dispatch.shipment.departed' AND payload #>> '{data,salesOrderId}' = $1`,
      [sourceOrderRef],
    );
    expect(count).toBe(0);
  });
});
