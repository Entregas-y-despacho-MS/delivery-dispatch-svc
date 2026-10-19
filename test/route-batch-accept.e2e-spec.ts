// ST-210.1 — HTTP/PostgreSQL acceptance checks for accepting a batch and reporting cotejo failures.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { StoragePort } from '../src/plugins/storage/storage.port.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('Route batch acceptance and cotejo (e2e, ST-210.1)', () => {
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
  let coordinatorToken = '';
  let coordinatorId = 0;
  let rescheduleReasonCode = '';
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
    })
      // Never write test files to the real storage (local disk or Cloudinary).
      .overrideProvider(StoragePort)
      .useValue({
        upload: async ({ filename }: { filename: string }) => ({
          url: `https://files.test/${filename}`,
        }),
      })
      .compile();
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
        `ST2101 driver 1 ${run}`,
        `st2101_driver1_${run}`,
        passwordHash,
        `ST2101 driver 2 ${run}`,
        `st2101_driver2_${run}`,
      ],
    );
    users.driver1 = Number(created[0].user_id);
    users.driver2 = Number(created[1].user_id);
    userIds.push(users.driver1, users.driver2);
    const [{ role_id: coordinatorRoleId }] = await db.query(
      `SELECT role_id FROM roles WHERE name = 'coordinator'`,
    );
    const [coordinator] = await db.query(
      `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
       VALUES ($1, $2, $3, $4, TRUE, FALSE) RETURNING user_id, username`,
      [coordinatorRoleId, `ST2101 coordinator ${run}`, `st2101_coord_${run}`, passwordHash],
    );
    coordinatorId = Number(coordinator.user_id);
    userIds.push(coordinatorId);
    coordinatorToken = (
      await http()
        .post(api('/auth/login'))
        .send({ username: coordinator.username, password })
    ).body.accessToken;
    rescheduleReasonCode = `RES-C${run}`.slice(0, 30);
    await db.query(
      `INSERT INTO reschedule_reasons (code, name, category, active) VALUES ($1, $2, 'operations', TRUE)`,
      [rescheduleReasonCode, `ST2101 motivo ${run}`],
    );
    for (const [index, driver] of (['driver1', 'driver2'] as const).entries()) {
      tokens[driver] = (
        await http()
          .post(api('/auth/login'))
          .send({ username: created[index].username, password })
      ).body.accessToken;
    }
  });

  afterAll(async () => {
    if (db) {
      await withEventPurge(
        db,
        { dispatchRefs: sourceRefs, routeBatchIds: batchIds },
        async (manager) => {
          await manager.query(
            `DELETE FROM outbound_messages WHERE payload #>> '{data,salesOrderId}' = ANY($1::text[])`,
            [sourceRefs],
          );
          await manager.query(
            `DELETE FROM dispatch_reschedules WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref = ANY($1::text[]))`,
            [sourceRefs],
          );
          await manager.query(
            `DELETE FROM reschedule_reasons WHERE code = $1`,
            [rescheduleReasonCode],
          );
          await manager.query(
            `DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref = ANY($1::text[]))`,
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

  async function addDispatch(routeBatchId: number, sequenceOrder: number) {
    const sequence = fixtureSequence++;
    const sourceOrderRef = `ST2101-${run}-${sequence}`;
    sourceRefs.push(sourceOrderRef);
    const [{ dispatch_type_id: typeId }] = await db.query(
      `SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`,
    );
    const [{ dispatch_status_id: assignedId }] = await db.query(
      `SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned'`,
    );
    const [{ dispatch_id: dispatchId }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
          source_order_ref, delivery_address, tracking_code, version)
       VALUES ($1, $2, $3, $4, $5, 'Test destination', $6, 1) RETURNING dispatch_id`,
      [
        typeId,
        assignedId,
        routeBatchId,
        sequenceOrder,
        sourceOrderRef,
        `DSP-2041-${String(sequence + 1).padStart(5, '0')}`,
      ],
    );
    const packageId = `${sourceOrderRef}-PKG`;
    await db.query(
      `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
       VALUES ($1, $2, 20, 20, 20, 5)`,
      [dispatchId, packageId],
    );
    return { dispatchId: Number(dispatchId), packageId };
  }

  async function fixture(
    status = 'confirmed',
    driver: 'driver1' | 'driver2' = 'driver1',
    dispatchCount = 1,
  ) {
    const sequence = fixtureSequence++;
    const [{ route_batch_id: routeBatchId }] = await db.query(
      `INSERT INTO route_batches (status, driver_id, shift_date)
       VALUES ($1, $2, '2041-01-01'::date + $3::int) RETURNING route_batch_id`,
      [status, users[driver], sequence],
    );
    batchIds.push(Number(routeBatchId));
    const dispatches = [];
    for (let order = 1; order <= dispatchCount; order++)
      dispatches.push(await addDispatch(Number(routeBatchId), order));
    return { routeBatchId: Number(routeBatchId), dispatches };
  }

  const uploadPhoto = (
    routeBatchId: number,
    driver: 'driver1' | 'driver2' = 'driver1',
    photoId = uuidv7(),
    file: Buffer = JPEG,
    mime = 'image/jpeg',
  ) =>
    http()
      .post(api(`/route-batches/${routeBatchId}/cotejo-photos`))
      .set(auth(driver))
      .field('photoId', photoId)
      .attach('file', file, { filename: 'photo.jpg', contentType: mime });

  const accept = (
    routeBatchId: number,
    body: object,
    driver: 'driver1' | 'driver2' = 'driver1',
  ) =>
    http()
      .post(api(`/route-batches/${routeBatchId}/accept`))
      .set(auth(driver))
      .send(body);

  const batchEvents = (routeBatchId: number, type: string) =>
    db.query(
      `SELECT * FROM route_batch_events WHERE route_batch_id = $1 AND event_type = $2`,
      [routeBatchId, type],
    );
  const acceptedAt = async (routeBatchId: number) =>
    (
      await db.query(
        `SELECT accepted_at FROM route_batches WHERE route_batch_id = $1`,
        [routeBatchId],
      )
    )[0].accepted_at as Date | null;

  it('accepts a confirmed batch with a conforming check and records accepted_at and the event', async () => {
    const { routeBatchId } = await fixture();
    const eventId = uuidv7();
    const response = await accept(routeBatchId, { eventId });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ routeBatchId, failedDispatchIds: [] });
    expect(await acceptedAt(routeBatchId)).not.toBeNull();
    const [event, ...rest] = await batchEvents(routeBatchId, 'batch_accepted');
    expect(rest).toHaveLength(0);
    expect(event.actor_user_id).toBe(users.driver1);
    expect(event.metadata.eventId).toBe(eventId);
  });

  it('lets the accepted batch start the route', async () => {
    const { routeBatchId } = await fixture();
    const before = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });
    expect(before.status).toBe(409);
    expect(before.body.error).toBe('ROUTE_BATCH_NOT_ACCEPTED');

    expect((await accept(routeBatchId, { eventId: uuidv7() })).status).toBe(200);
    const after = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('in_execution');
  });

  it.each(['provisional', 'pending_final_review', 'in_execution'])(
    'returns 409 when the batch is %s and writes nothing',
    async (status) => {
      const { routeBatchId } = await fixture(status);
      const response = await accept(routeBatchId, { eventId: uuidv7() });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ROUTE_BATCH_NOT_CONFIRMED');
      expect(await acceptedAt(routeBatchId)).toBeNull();
      expect(await batchEvents(routeBatchId, 'batch_accepted')).toHaveLength(0);
    },
  );

  it("returns 403 for another driver's batch and 404 for a missing batch", async () => {
    const { routeBatchId } = await fixture();
    const foreign = await accept(routeBatchId, { eventId: uuidv7() }, 'driver2');
    expect(foreign.status).toBe(403);
    expect(await acceptedAt(routeBatchId)).toBeNull();

    const missing = await accept(2147483000, { eventId: uuidv7() });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('ROUTE_BATCH_NOT_FOUND');
  });

  it('requires a UUID v7 eventId and valid failures', async () => {
    const { routeBatchId, dispatches } = await fixture();
    expect((await accept(routeBatchId, {})).status).toBe(400);
    expect(
      (
        await accept(routeBatchId, {
          eventId: uuidv7(),
          failures: [
            {
              dispatchId: dispatches[0].dispatchId,
              packageIds: [],
              reason: 'lost',
              photoId: 'not-a-uuid',
            },
          ],
        })
      ).status,
    ).toBe(400);
    expect(await acceptedAt(routeBatchId)).toBeNull();
  });

  it('marks the failed stop as "does not leave" with reason, photo and actor, and the route starts without it', async () => {
    const { routeBatchId, dispatches } = await fixture('confirmed', 'driver1', 2);
    const [failed, ok] = dispatches;
    const photoId = uuidv7();
    const photo = await uploadPhoto(routeBatchId, 'driver1', photoId);
    expect(photo.status).toBe(201);
    expect(photo.body.photoId).toBe(photoId);
    expect(JSON.stringify(photo.body)).not.toContain('files.test');

    const eventId = uuidv7();
    const response = await accept(routeBatchId, {
      eventId,
      failures: [
        {
          dispatchId: failed.dispatchId,
          packageIds: [failed.packageId],
          reason: 'damaged',
          detail: 'Crushed corner',
          photoId,
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.failedDispatchIds).toEqual([failed.dispatchId]);

    const events = await db.query(
      `SELECT * FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'cotejo_failed'`,
      [failed.dispatchId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_user_id: users.driver1,
      actor_type: 'user',
      reason: 'damaged',
    });
    expect(events[0].metadata).toMatchObject({
      routeBatchId,
      packageIds: [failed.packageId],
      photo: `https://files.test/${photoId}`,
      detail: 'Crushed corner',
    });
    const [{ count }] = await db.query(
      `SELECT COUNT(*)::int AS count FROM dispatch_incidents WHERE dispatch_id = $1`,
      [failed.dispatchId],
    );
    expect(count).toBe(0);
    const [{ status }] = await db.query(
      `SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
      [failed.dispatchId],
    );
    expect(status).toBe('assigned');

    const start = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });
    expect(start.status).toBe(200);
    expect(start.body.dispatchIds).toEqual([ok.dispatchId]);
    expect(start.body.excludedDispatchIds).toEqual([failed.dispatchId]);
  });

  it('lets the stop leave again once a later cotejo_resolved exists for the same batch', async () => {
    const { routeBatchId, dispatches } = await fixture('confirmed', 'driver1', 2);
    const [failed, ok] = dispatches;
    const photoId = uuidv7();
    await uploadPhoto(routeBatchId, 'driver1', photoId);
    const response = await accept(routeBatchId, {
      eventId: uuidv7(),
      failures: [
        {
          dispatchId: failed.dispatchId,
          packageIds: [failed.packageId],
          reason: 'missing',
          photoId,
        },
      ],
    });
    expect(response.status).toBe(200);
    // The coordinator's resolution is outside this ticket: it is written the way ST-51.5 reads it.
    await db.query(
      `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata)
       VALUES ($1, 'cotejo_resolved', 'system', 'Package found', $2::jsonb)`,
      [failed.dispatchId, JSON.stringify({ routeBatchId })],
    );

    const start = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });
    expect(start.status).toBe(200);
    expect(start.body.dispatchIds).toEqual([failed.dispatchId, ok.dispatchId]);
    expect(start.body.excludedDispatchIds).toEqual([]);
  });

  it('rejects a failure on a dispatch that is not assigned and accepts nothing', async () => {
    const { routeBatchId, dispatches } = await fixture();
    const [{ dispatchId, packageId }] = dispatches;
    await db.query(
      `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'cancelled') WHERE dispatch_id = $1`,
      [dispatchId],
    );
    const photoId = uuidv7();
    await uploadPhoto(routeBatchId, 'driver1', photoId);
    const response = await accept(routeBatchId, {
      eventId: uuidv7(),
      failures: [{ dispatchId, packageIds: [packageId], reason: 'missing', photoId }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('COTEJO_FAILURE_DISPATCH_NOT_ASSIGNED');
    expect(await acceptedAt(routeBatchId)).toBeNull();
  });

  it('full flow: failed cotejo, route start, then the coordinator reschedules the excluded stop and the batch closes', async () => {
    const { routeBatchId, dispatches } = await fixture('confirmed', 'driver1', 2);
    const [failed, ok] = dispatches;
    const photoId = uuidv7();
    await uploadPhoto(routeBatchId, 'driver1', photoId);
    expect(
      (
        await accept(routeBatchId, {
          eventId: uuidv7(),
          failures: [{ dispatchId: failed.dispatchId, packageIds: [failed.packageId], reason: 'does_not_fit', photoId }],
        })
      ).status,
    ).toBe(200);
    const start = await http()
      .post(api(`/route-batches/${routeBatchId}/start`))
      .set(auth('driver1'))
      .send({ eventId: uuidv7() });
    expect(start.status).toBe(200);
    expect(start.body.excludedDispatchIds).toEqual([failed.dispatchId]);

    const statusOf = async (id: number) =>
      (
        await db.query(
          `SELECT s.name AS status FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
          [id],
        )
      )[0].status;
    const batchStatus = async () =>
      (await db.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [routeBatchId]))[0].status;
    // The excluded stop keeps the batch open (D-50) while the departing one is still on the road.
    expect(await statusOf(failed.dispatchId)).toBe('assigned');
    expect(await statusOf(ok.dispatchId)).toBe('out_for_delivery');
    await db.query(
      `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'delivered') WHERE dispatch_id = $1`,
      [ok.dispatchId],
    );
    expect(await batchStatus()).toBe('in_execution');

    const [{ d: date }] = await db.query(
      `SELECT ((NOW() AT TIME ZONE 'America/La_Paz')::date + 3)::text AS d`,
    );
    const reschedule = await http()
      .post(api(`/dispatches/${failed.dispatchId}/reschedule`))
      .set({ Authorization: `Bearer ${coordinatorToken}` })
      .send({
        reasonCode: rescheduleReasonCode,
        windowStart: `${date}T13:00:00Z`,
        windowEnd: `${date}T15:00:00Z`,
      });
    expect(reschedule.status).toBe(200);
    expect(await statusOf(failed.dispatchId)).toBe('rescheduled');
    expect(await batchStatus()).toBe('closed');
    const [{ route_batch_id: leftBatch }] = await db.query(
      `SELECT route_batch_id FROM dispatches WHERE dispatch_id = $1`,
      [failed.dispatchId],
    );
    expect(leftBatch).toBeNull();
  });

  it('rejects failures that do not match the batch and accepts nothing', async () => {
    const { routeBatchId, dispatches } = await fixture();
    const other = await fixture();
    const [{ dispatchId, packageId }] = dispatches;
    const photoId = uuidv7();
    expect((await uploadPhoto(routeBatchId, 'driver1', photoId)).status).toBe(201);
    const failure = { dispatchId, packageIds: [packageId], reason: 'missing', photoId };
    const send = (body: object) => accept(routeBatchId, { eventId: uuidv7(), ...body });

    const cases: [object, string][] = [
      [{ failures: [{ ...failure, photoId: uuidv7() }] }, 'COTEJO_PHOTO_NOT_FOUND'],
      [{ failures: [{ ...failure, dispatchId: other.dispatches[0].dispatchId }] }, 'COTEJO_FAILURE_DISPATCH_NOT_IN_BATCH'],
      [{ failures: [{ ...failure, packageIds: ['NOT-MINE'] }] }, 'COTEJO_FAILURE_PACKAGE_NOT_IN_DISPATCH'],
      [{ failures: [failure, failure] }, 'COTEJO_FAILURE_DUPLICATED_DISPATCH'],
    ];
    for (const [body, error] of cases) {
      const response = await send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(error);
    }
    expect(await acceptedAt(routeBatchId)).toBeNull();
    const events = await db.query(
      `SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'cotejo_failed'`,
      [dispatchId],
    );
    expect(events).toHaveLength(0);
  });

  it('is idempotent by eventId and refuses a second acceptance with another eventId', async () => {
    const { routeBatchId, dispatches } = await fixture();
    const photoId = uuidv7();
    await uploadPhoto(routeBatchId, 'driver1', photoId);
    const body = {
      eventId: uuidv7(),
      failures: [
        {
          dispatchId: dispatches[0].dispatchId,
          packageIds: [dispatches[0].packageId],
          reason: 'does_not_fit',
          photoId,
        },
      ],
    };
    const first = await accept(routeBatchId, body);
    const retry = await accept(routeBatchId, body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(await batchEvents(routeBatchId, 'batch_accepted')).toHaveLength(1);
    const failures = await db.query(
      `SELECT 1 FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'cotejo_failed'`,
      [dispatches[0].dispatchId],
    );
    expect(failures).toHaveLength(1);

    const again = await accept(routeBatchId, { eventId: uuidv7() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ROUTE_BATCH_ALREADY_ACCEPTED');

    const { routeBatchId: otherBatch } = await fixture();
    const reused = await accept(otherBatch, { eventId: body.eventId });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toBe('ROUTE_ACCEPT_EVENT_ID_ALREADY_USED');
  });

  describe('POST /route-batches/:id/cotejo-photos', () => {
    it('is idempotent by photoId and refuses a photoId of another batch', async () => {
      const { routeBatchId } = await fixture();
      const { routeBatchId: otherBatch } = await fixture();
      const photoId = uuidv7();
      const first = await uploadPhoto(routeBatchId, 'driver1', photoId);
      const retry = await uploadPhoto(routeBatchId, 'driver1', photoId);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
      expect(await batchEvents(routeBatchId, 'cotejo_photo_uploaded')).toHaveLength(1);
      const clash = await uploadPhoto(otherBatch, 'driver1', photoId);
      expect(clash.status).toBe(409);
      expect(clash.body.error).toBe('COTEJO_PHOTO_ID_CONFLICT');
    });

    it('rejects another driver (403), a non-confirmed batch (409), a PNG (415) and a missing file (400)', async () => {
      const { routeBatchId } = await fixture();
      const { routeBatchId: pending } = await fixture('pending_final_review');
      expect((await uploadPhoto(routeBatchId, 'driver2')).status).toBe(403);
      const notConfirmed = await uploadPhoto(pending);
      expect(notConfirmed.status).toBe(409);
      expect(notConfirmed.body.error).toBe('ROUTE_BATCH_NOT_CONFIRMED');
      expect((await uploadPhoto(routeBatchId, 'driver1', uuidv7(), PNG, 'image/png')).status).toBe(415);
      const noFile = await http()
        .post(api(`/route-batches/${routeBatchId}/cotejo-photos`))
        .set(auth('driver1'))
        .field('photoId', uuidv7());
      expect(noFile.status).toBe(400);
      expect(await batchEvents(routeBatchId, 'cotejo_photo_uploaded')).toHaveLength(0);
    });
  });
});
