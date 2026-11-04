// ST-241.3 — HTTP/PostgreSQL checks for «Excluidos por cotejo»: the list, the coordinator's resolution and the
// `planning.alert` raised when a batch starts with excluded stops.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { StoragePort } from '../src/plugins/storage/storage.port.js';
import { PLANNING_ALERT_EVENT, type PlanningAlertEvent } from '../src/app/planning/services/planning-alerts.service.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const NO_ID = 2147483000;

describe('Cotejo exclusions: list, resolution and alert (e2e, ST-241.3)', () => {
  let app: INestApplication;
  let db: DataSource;
  let prefix: string;
  const tokens = { driver: '', coordinator: '', supervisor: '' };
  const users = { driver: 0, coordinator: 0, supervisor: 0 };
  const sourceRefs: string[] = [];
  const batchIds: number[] = [];
  const userIds: number[] = [];
  const alerts: PlanningAlertEvent[] = [];
  const run = Date.now().toString(36).toUpperCase();
  let sequence = 0;

  const http = () => request(app.getHttpServer());
  const api = (path: string) => `/${prefix}${path}`;
  const as = (who: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      // Never write to the real storage; the signed URL is recognizable and differs from the stored one.
      .overrideProvider(StoragePort)
      .useValue({
        upload: async ({ filename }: { filename: string }) => ({ url: `https://files.test/${filename}` }),
        getAccessUrl: async (url: string, ttlSeconds: number) => ({
          url: `https://signed.test/${encodeURIComponent(url)}?ttl=${ttlSeconds}`,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
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
    moduleRef.get(EventEmitter2).on(PLANNING_ALERT_EVENT, (event: PlanningAlertEvent) => alerts.push(event));

    const password = 'E2eTest1234';
    const passwordHash = await hashPassword(password);
    for (const role of ['driver', 'coordinator', 'supervisor'] as const) {
      const [{ role_id: roleId }] = await db.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
      const username = `st2413_${role}_${run}`;
      const [created] = await db.query(
        `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
         VALUES ($1, $2, $3, $4, TRUE, FALSE) RETURNING user_id`,
        [roleId, `ST2413 ${role} ${run}`, username, passwordHash],
      );
      users[role] = Number(created.user_id);
      userIds.push(users[role]);
      tokens[role] = (await http().post(api('/auth/login')).send({ username, password })).body.accessToken;
    }
  });

  afterAll(async () => {
    if (db) {
      await withEventPurge(db, { dispatchRefs: sourceRefs, routeBatchIds: batchIds }, async (manager) => {
        await manager.query(`DELETE FROM outbound_messages WHERE payload #>> '{data,salesOrderId}' = ANY($1::text[])`, [sourceRefs]);
        for (const routeBatchId of batchIds)
          await manager.query(`DELETE FROM audit_logs WHERE action = 'plan_generation_alert' AND detail LIKE $1`, [
            `%"kind":"cotejo_exclusion_pending"%"routeBatchId":${routeBatchId},%`,
          ]);
        await manager.query(
          `DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref = ANY($1::text[]))`,
          [sourceRefs],
        );
        await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [sourceRefs]);
        await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        await manager.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [userIds]);
      });
    }
    await app?.close();
  });

  async function addDispatch(routeBatchId: number, sequenceOrder: number, status = 'assigned') {
    const n = sequence++;
    const sourceOrderRef = `ST2413-${run}-${n}`;
    sourceRefs.push(sourceOrderRef);
    const [{ dispatch_type_id: typeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
    const [{ dispatch_status_id: statusId }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $1`, [status]);
    const [{ dispatch_id: dispatchId }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
          source_order_ref, delivery_address, contact_name, tracking_code, version)
       VALUES ($1, $2, $3, $4, $5, $6, 'Maria Test', $7, 1) RETURNING dispatch_id`,
      [typeId, statusId, routeBatchId, sequenceOrder, sourceOrderRef, `Address ${sourceOrderRef}`, `DSP-2413-${String(n + 1).padStart(5, '0')}`],
    );
    const packageId = `${sourceOrderRef}-PKG`;
    await db.query(
      `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
       VALUES ($1, $2, 20, 20, 20, 5)`,
      [dispatchId, packageId],
    );
    return { dispatchId: Number(dispatchId), packageId, sourceOrderRef };
  }

  /** A batch of `count` assigned stops. `accepted` stamps `accepted_at` (the driver already did the cotejo). */
  async function fixture(status = 'in_execution', count = 1, accepted = true) {
    const n = sequence++;
    const [{ route_batch_id: routeBatchId }] = await db.query(
      `INSERT INTO route_batches (status, driver_id, shift_date, accepted_at)
       VALUES ($1, $2, '2043-01-01'::date + $3::int, CASE WHEN $4::boolean THEN NOW() END) RETURNING route_batch_id`,
      [status, users.driver, n, accepted],
    );
    batchIds.push(Number(routeBatchId));
    const dispatches = [];
    for (let order = 1; order <= count; order++) dispatches.push(await addDispatch(Number(routeBatchId), order));
    return { routeBatchId: Number(routeBatchId), dispatches };
  }

  const cotejoEvent = (
    dispatchId: number,
    type: 'cotejo_failed' | 'cotejo_resolved',
    routeBatchId: number,
    extra: Record<string, unknown> = {},
    reason = type === 'cotejo_failed' ? 'damaged' : 'Found',
  ) =>
    db.query(
      `INSERT INTO dispatch_events (dispatch_id, event_type, actor_user_id, actor_type, reason, metadata)
       VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
      [dispatchId, type, users.driver, reason, JSON.stringify({ routeBatchId, ...extra })],
    );
  const failed = (dispatchId: number, routeBatchId: number, packageId: string, extra: Record<string, unknown> = {}, reason = 'damaged') =>
    cotejoEvent(dispatchId, 'cotejo_failed', routeBatchId, { packageId, packageIds: [packageId], photo: `https://files.test/${packageId}`, ...extra }, reason);

  const list = async () => {
    const response = await http().get(api('/route-batches/cotejo-exclusions')).set(as('coordinator'));
    expect(response.status).toBe(200);
    return response.body.data as Array<Record<string, any>>;
  };
  const listed = async (...dispatchIds: number[]) => (await list()).filter((item) => dispatchIds.includes(item.dispatchId));
  const resolve = (dispatchId: number, body: object = {}, who: keyof typeof tokens = 'coordinator') =>
    http().post(api(`/dispatches/${dispatchId}/cotejo-resolved`)).set(as(who)).send(body);
  const resolvedEvents = (dispatchId: number) =>
    db.query(`SELECT * FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'cotejo_resolved'`, [dispatchId]);
  const statusOf = async (dispatchId: number) =>
    (await db.query(`SELECT s.name FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [dispatchId]))[0].name;
  const alertRows = (routeBatchId: number) =>
    db.query(`SELECT * FROM audit_logs WHERE action = 'plan_generation_alert' AND detail LIKE $1`, [
      `%"kind":"cotejo_exclusion_pending"%"routeBatchId":${routeBatchId},%`,
    ]);
  const alertsOf = (routeBatchId: number) =>
    alerts.filter((alert) => alert.kind === 'cotejo_exclusion_pending' && alert.detail.routeBatchId === routeBatchId);

  describe('GET /route-batches/cotejo-exclusions', () => {
    it('lists the failed stop with its address, reason, package, detail and a signed photo url (never the stored one)', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId, { detail: 'Crushed corner' });

      const [item, ...rest] = await listed(stop.dispatchId);

      expect(rest).toHaveLength(0);
      expect(item).toMatchObject({
        dispatchId: stop.dispatchId,
        routeBatchId,
        sequenceOrder: 1,
        sourceOrderRef: stop.sourceOrderRef,
        deliveryAddress: `Address ${stop.sourceOrderRef}`,
        contactName: 'Maria Test',
      });
      expect(item.shiftDate).toMatch(/^2043-\d{2}-\d{2}$/);
      expect(item.failures).toHaveLength(1);
      expect(item.failures[0]).toMatchObject({ packageId: stop.packageId, reason: 'damaged', detail: 'Crushed corner' });
      expect(item.failures[0].photoUrl).toBe(`https://signed.test/${encodeURIComponent(`https://files.test/${stop.packageId}`)}?ttl=300`);
      expect(JSON.stringify(item)).not.toContain('"https://files.test');
      expect(Date.parse(item.failures[0].reportedAt)).toBeGreaterThan(0);
    });

    it('answers 200 to the supervisor and rejects the driver (403) and a missing token (401)', async () => {
      expect((await http().get(api('/route-batches/cotejo-exclusions')).set(as('supervisor'))).status).toBe(200);
      expect((await http().get(api('/route-batches/cotejo-exclusions')).set(as('driver'))).status).toBe(403);
      expect((await http().get(api('/route-batches/cotejo-exclusions'))).status).toBe(401);
    });

    it('is not read as a route batch id', async () => {
      const response = await http().get(api('/route-batches/cotejo-exclusions')).set(as('coordinator'));
      expect(response.body).toHaveProperty('data');
      expect(response.body.error).toBeUndefined();
    });

    it('lists one stop with a failure per package, each with its own reason and photo, and orders stops by batch and route order', async () => {
      const { routeBatchId, dispatches } = await fixture('in_execution', 2);
      const [first, second] = dispatches;
      await db.query(
        `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg) VALUES ($1, $2, 20, 20, 20, 5)`,
        [first.dispatchId, `${first.packageId}-B`],
      );
      await failed(second.dispatchId, routeBatchId, second.packageId);
      await failed(first.dispatchId, routeBatchId, first.packageId, {}, 'missing');
      await failed(first.dispatchId, routeBatchId, `${first.packageId}-B`, { photo: 'https://files.test/other' }, 'does_not_fit');

      const items = await listed(first.dispatchId, second.dispatchId);

      expect(items.map((item) => item.dispatchId)).toEqual([first.dispatchId, second.dispatchId]);
      expect(items[0].failures.map((f: any) => [f.packageId, f.reason])).toEqual([
        [first.packageId, 'missing'],
        [`${first.packageId}-B`, 'does_not_fit'],
      ]);
      expect(items[0].failures[1].photoUrl).toContain(encodeURIComponent('https://files.test/other'));
    });

    it('does not list stops that are resolved, outside an in_execution batch, not assigned, without failure or failed in another batch', async () => {
      const exec = await fixture('in_execution', 4);
      const [resolved, noEvent, rescheduled, otherBatch] = exec.dispatches;
      await failed(resolved.dispatchId, exec.routeBatchId, resolved.packageId);
      await cotejoEvent(resolved.dispatchId, 'cotejo_resolved', exec.routeBatchId);
      await failed(rescheduled.dispatchId, exec.routeBatchId, rescheduled.packageId);
      await db.query(
        `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'rescheduled') WHERE dispatch_id = $1`,
        [rescheduled.dispatchId],
      );
      await failed(otherBatch.dispatchId, exec.routeBatchId + 100000, otherBatch.packageId);
      const confirmed = await fixture('confirmed', 1);
      await failed(confirmed.dispatches[0].dispatchId, confirmed.routeBatchId, confirmed.dispatches[0].packageId);

      const ids = [resolved, noEvent, rescheduled, otherBatch, confirmed.dispatches[0]].map(({ dispatchId }) => dispatchId);
      expect(await listed(...ids)).toEqual([]);
    });

    it('lists the stop again, with only the new failure, when it fails after a resolution', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, 'OLD-PKG');
      await cotejoEvent(stop.dispatchId, 'cotejo_resolved', routeBatchId);
      await failed(stop.dispatchId, routeBatchId, 'NEW-PKG');

      const [item] = await listed(stop.dispatchId);

      expect(item.failures.map((f: any) => f.packageId)).toEqual(['NEW-PKG']);
    });
  });

  describe('POST /dispatches/:id/cotejo-resolved', () => {
    it('records cotejo_resolved with the actor and note, keeps the stop assigned and takes it out of the list', async () => {
      const { routeBatchId, dispatches } = await fixture('in_execution', 2);
      const [stop, other] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);
      await failed(other.dispatchId, routeBatchId, other.packageId);

      const response = await resolve(stop.dispatchId, { note: 'Found in the warehouse' });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ dispatchId: stop.dispatchId, routeBatchId });
      expect(Date.parse(response.body.resolvedAt)).toBeGreaterThan(0);
      const [event, ...rest] = await resolvedEvents(stop.dispatchId);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({ actor_user_id: users.coordinator, actor_type: 'user', reason: 'Found in the warehouse' });
      expect(event.metadata).toEqual({ routeBatchId, resolvedBy: users.coordinator, note: 'Found in the warehouse' });
      expect(await statusOf(stop.dispatchId)).toBe('assigned');
      expect((await listed(stop.dispatchId, other.dispatchId)).map((item) => item.dispatchId)).toEqual([other.dispatchId]);
    });

    it('frees the whole stop with one resolution even if several packages failed, and works without a note', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);
      await failed(stop.dispatchId, routeBatchId, `${stop.packageId}-B`);

      expect((await resolve(stop.dispatchId)).status).toBe(200);

      expect(await listed(stop.dispatchId)).toEqual([]);
      const [event] = await resolvedEvents(stop.dispatchId);
      expect(event.metadata.note).toBeNull();
    });

    it('answers 409 COTEJO_EXCLUSION_NOT_PENDING to a second resolution and writes no second event', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);
      expect((await resolve(stop.dispatchId)).status).toBe(200);

      const again = await resolve(stop.dispatchId);

      expect(again.status).toBe(409);
      expect(again.body.error).toBe('COTEJO_EXCLUSION_NOT_PENDING');
      expect(await resolvedEvents(stop.dispatchId)).toHaveLength(1);
    });

    it('answers 409 COTEJO_EXCLUSION_NOT_PENDING for a stop that never failed', async () => {
      const { dispatches } = await fixture();

      const response = await resolve(dispatches[0].dispatchId);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('COTEJO_EXCLUSION_NOT_PENDING');
      expect(await resolvedEvents(dispatches[0].dispatchId)).toHaveLength(0);
    });

    it('answers 409 ROUTE_BATCH_NOT_IN_EXECUTION when the batch has not started', async () => {
      const { routeBatchId, dispatches } = await fixture('confirmed');
      await failed(dispatches[0].dispatchId, routeBatchId, dispatches[0].packageId);

      const response = await resolve(dispatches[0].dispatchId);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('ROUTE_BATCH_NOT_IN_EXECUTION');
      expect(await resolvedEvents(dispatches[0].dispatchId)).toHaveLength(0);
    });

    it('answers 409 COTEJO_DISPATCH_NOT_ASSIGNED when the stop is no longer assigned', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);
      await db.query(
        `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'rescheduled') WHERE dispatch_id = $1`,
        [stop.dispatchId],
      );

      const response = await resolve(stop.dispatchId);

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('COTEJO_DISPATCH_NOT_ASSIGNED');
      expect(await resolvedEvents(stop.dispatchId)).toHaveLength(0);
    });

    it('answers 404 to a missing dispatch, 400 to a bad id or note, 403 to supervisor and driver and 401 without token', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);

      const missing = await resolve(NO_ID);
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('DISPATCH_NOT_FOUND');
      expect((await http().post(api('/dispatches/abc/cotejo-resolved')).set(as('coordinator')).send({})).status).toBe(400);
      expect((await resolve(stop.dispatchId, { note: 'x'.repeat(501) })).status).toBe(400);
      expect((await resolve(stop.dispatchId, { unknown: true })).status).toBe(400);
      expect((await resolve(stop.dispatchId, {}, 'supervisor')).status).toBe(403);
      expect((await resolve(stop.dispatchId, {}, 'driver')).status).toBe(403);
      expect((await http().post(api(`/dispatches/${stop.dispatchId}/cotejo-resolved`)).send({})).status).toBe(401);
      expect(await resolvedEvents(stop.dispatchId)).toHaveLength(0);
      expect(await listed(stop.dispatchId)).toHaveLength(1);
    });

    it('lets two concurrent resolutions write exactly one event', async () => {
      const { routeBatchId, dispatches } = await fixture();
      const [stop] = dispatches;
      await failed(stop.dispatchId, routeBatchId, stop.packageId);

      const [a, b] = await Promise.all([resolve(stop.dispatchId), resolve(stop.dispatchId)]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await resolvedEvents(stop.dispatchId)).toHaveLength(1);
    });
  });

  describe('planning.alert when a batch starts with excluded stops', () => {
    const accept = (routeBatchId: number, body: object) =>
      http().post(api(`/route-batches/${routeBatchId}/accept`)).set(as('driver')).send(body);
    const start = (routeBatchId: number, eventId: string) =>
      http().post(api(`/route-batches/${routeBatchId}/start`)).set(as('driver')).send({ eventId });

    it('raises cotejo_exclusion_pending once and the excluded stop then shows up in the list until the coordinator resolves it', async () => {
      const { routeBatchId, dispatches } = await fixture('confirmed', 2, false);
      const [bad, ok] = dispatches;
      const photoId = uuidv7();
      const upload = await http()
        .post(api(`/route-batches/${routeBatchId}/cotejo-photos`))
        .set(as('driver'))
        .field('photoId', photoId)
        .attach('file', JPEG, { filename: 'photo.jpg', contentType: 'image/jpeg' });
      expect(upload.status).toBe(201);
      const accepted = await accept(routeBatchId, {
        eventId: uuidv7(),
        failures: [{ dispatchId: bad.dispatchId, packageId: bad.packageId, reason: 'missing', photoId }],
      });
      expect(accepted.status).toBe(200);
      expect(alertsOf(routeBatchId)).toHaveLength(0);

      const eventId = uuidv7();
      const started = await start(routeBatchId, eventId);

      expect(started.status).toBe(200);
      expect(started.body.excludedDispatchIds).toEqual([bad.dispatchId]);
      expect(started.body.dispatchIds).toEqual([ok.dispatchId]);
      const [alert, ...more] = alertsOf(routeBatchId);
      expect(more).toHaveLength(0);
      expect(alert).toMatchObject({ kind: 'cotejo_exclusion_pending', severity: 'exception' });
      expect(alert.detail).toEqual({ routeBatchId, excludedDispatchIds: [bad.dispatchId] });
      const rows = await alertRows(routeBatchId);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
      expect(JSON.parse(rows[0].detail)).toMatchObject({ kind: 'cotejo_exclusion_pending', severity: 'exception', routeBatchId, excludedDispatchIds: [bad.dispatchId] });

      // A retry of the same start (offline queue) answers the same result and does not alert again.
      const replay = await start(routeBatchId, eventId);
      expect(replay.status).toBe(200);
      expect(alertsOf(routeBatchId)).toHaveLength(1);
      expect(await alertRows(routeBatchId)).toHaveLength(1);

      // The excluded stop is now listed with the driver's reason and photo, and the coordinator can resolve it.
      const [item] = await listed(bad.dispatchId);
      expect(item.failures[0]).toMatchObject({ packageId: bad.packageId, reason: 'missing' });
      expect(item.failures[0].photoUrl).toContain(encodeURIComponent(`https://files.test/${photoId}`));
      expect(await listed(ok.dispatchId)).toEqual([]);
      expect((await resolve(bad.dispatchId, { note: 'Appeared' })).status).toBe(200);
      expect(await listed(bad.dispatchId)).toEqual([]);
      expect(await statusOf(bad.dispatchId)).toBe('assigned');
    });

    it('does not raise the alert when the batch starts without excluded stops', async () => {
      const { routeBatchId } = await fixture('confirmed', 1, false);
      expect((await accept(routeBatchId, { eventId: uuidv7() })).status).toBe(200);

      const started = await start(routeBatchId, uuidv7());

      expect(started.status).toBe(200);
      expect(started.body.excludedDispatchIds).toEqual([]);
      expect(alertsOf(routeBatchId)).toHaveLength(0);
      expect(await alertRows(routeBatchId)).toHaveLength(0);
    });

    it('does not raise the alert when the start is refused (every stop excluded)', async () => {
      const { routeBatchId, dispatches } = await fixture('confirmed', 1);
      await failed(dispatches[0].dispatchId, routeBatchId, dispatches[0].packageId);

      const started = await start(routeBatchId, uuidv7());

      expect(started.status).toBe(409);
      expect(started.body.error).toBe('ROUTE_BATCH_ALL_DISPATCHES_EXCLUDED');
      expect(alertsOf(routeBatchId)).toHaveLength(0);
    });

    it('does not exclude a stop whose failure was already resolved before the start (no alert)', async () => {
      const { routeBatchId, dispatches } = await fixture('confirmed', 1);
      await failed(dispatches[0].dispatchId, routeBatchId, dispatches[0].packageId);
      await cotejoEvent(dispatches[0].dispatchId, 'cotejo_resolved', routeBatchId);

      const started = await start(routeBatchId, uuidv7());

      expect(started.status).toBe(200);
      expect(started.body.excludedDispatchIds).toEqual([]);
      expect(alertsOf(routeBatchId)).toHaveLength(0);
    });
  });
});
