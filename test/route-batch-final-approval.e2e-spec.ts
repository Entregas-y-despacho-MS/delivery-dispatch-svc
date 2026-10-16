import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { ROUTE_ASSIGNED_EVENT } from '../src/modules/dispatch/route-batches/events/route-assigned.event.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('POST /route-batches/:id/approve-final (e2e)', () => {
  let app: INestApplication;
  let db: DataSource;
  let prefix: string;
  let coordinatorId: number;
  let driverId: number;
  let coordinatorToken: string;
  const run = Date.now().toString(36);
  const userNames = [`st512_%_${run}`];
  const sourceRefs: string[] = [];
  const batchIds: number[] = [];
  const vehicleIds: number[] = [];
  const userIds: number[] = [];
  let emitted: ReturnType<typeof vi.spyOn>;
  let fixtureCount = 0;

  const http = () => request(app.getHttpServer());
  const api = (path: string) => `/${prefix}${path}`;
  const auth = { get authorization() { return `Bearer ${coordinatorToken}`; } };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prefix = app.get(AppConfig).apiPrefix;
    app.setGlobalPrefix(prefix);
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, transformOptions: { enableImplicitConversion: false } }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    db = moduleRef.get(DataSource);
    emitted = vi.spyOn(moduleRef.get(EventEmitter2), 'emit');

    const [{ role_id: coordinatorRoleId }] = await db.query(`SELECT role_id FROM roles WHERE name = 'coordinator'`);
    const [{ role_id: driverRoleId }] = await db.query(`SELECT role_id FROM roles WHERE name = 'driver'`);
    const passwordHash = await hashPassword('E2eTest1234');
    const users = await db.query(
      `INSERT INTO users (role_id, full_name, username, password_hash, active, requires_pwd_change)
       VALUES ($1, $2, $3, $4, TRUE, FALSE), ($5, $6, $7, $4, TRUE, FALSE)
       RETURNING user_id, username`,
      [coordinatorRoleId, `ST512 coordinator ${run}`, `st512_coordinator_${run}`, passwordHash, driverRoleId, `ST512 driver ${run}`, `st512_driver_${run}`],
    );
    coordinatorId = Number(users[0].user_id);
    driverId = Number(users[1].user_id);
    userIds.push(coordinatorId, driverId);
    coordinatorToken = (await http().post(api('/auth/login')).send({ username: users[0].username, password: 'E2eTest1234' })).body.accessToken;
  });

  afterAll(async () => {
    if (db) {
      await withEventPurge(db, { dispatchRefs: sourceRefs.map((ref) => `${ref}%`), routeBatchIds: batchIds, userNames }, async (manager) => {
        await manager.query(`DELETE FROM dispatches WHERE source_order_ref LIKE ANY($1::text[])`, [sourceRefs.map((ref) => `${ref}%`)]);
        await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        await manager.query(`DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])`, [vehicleIds]);
        await manager.query(`DELETE FROM users WHERE user_id = ANY($1::int[])`, [userIds]);
      });
    }
    await app?.close();
  });

  async function fixture(options: { capacityKg?: number; status?: string } = {}) {
    const [{ vehicle_status_id: activeVehicleStatusId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`);
    const [{ dispatch_type_id: deliveryTypeId }] = await db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
    const [{ dispatch_status_id: scheduledStatusId }] = await db.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'scheduled'`);
    const [{ vehicle_id: vehicleId }] = await db.query(
      `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
       VALUES ($1, 'van', 'ST512 e2e', $2, $3, 10) RETURNING vehicle_id`,
      [activeVehicleStatusId, `S${run.slice(-5)}${vehicleIds.length}`, options.capacityKg ?? 100],
    );
    vehicleIds.push(Number(vehicleId));
    const shiftDate = `2026-10-${String(20 + fixtureCount++).padStart(2, '0')}`;
    const [{ route_batch_id: routeBatchId }] = await db.query(
      `INSERT INTO route_batches (status, version, proposed_driver_id, vehicle_id, shift_date)
       VALUES ($1, 4, $2, $3, $4) RETURNING route_batch_id`,
      [options.status ?? 'pending_final_review', driverId, vehicleId, shiftDate],
    );
    batchIds.push(Number(routeBatchId));
    const sourceOrderRef = `ST512-${run}-${sourceRefs.length}`;
    sourceRefs.push(sourceOrderRef);
    const [{ dispatch_id: dispatchId }] = await db.query(
      `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order,
          source_order_ref, delivery_address, delivery_latitude, delivery_longitude, scheduled_window_start, scheduled_window_end)
       VALUES ($1, $2, $3, 1, $4, 'Test destination', -16.5, -68.1, '2026-10-20T13:00:00Z', '2026-10-20T15:00:00Z')
       RETURNING dispatch_id`,
      [deliveryTypeId, scheduledStatusId, routeBatchId, sourceOrderRef],
    );
    await db.query(
      `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
       VALUES ($1, $2, 20, 20, 20, 5)`,
      [dispatchId, `${sourceOrderRef}-package`],
    );
    return { routeBatchId: Number(routeBatchId), dispatchId: Number(dispatchId), vehicleId: Number(vehicleId), sourceOrderRef, shiftDate };
  }

  function requestBody(dispatchId: number) {
    return { version: 4, dispatches: [{ dispatchId, version: 0 }] };
  }

  it('confirms the whole batch and dispatch, records audit events, then emits route.assigned', async () => {
    const { routeBatchId, dispatchId, vehicleId } = await fixture();
    const response = await http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization)
      .send(requestBody(dispatchId));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ routeBatchId, version: 5, driverId, vehicleId, dispatchIds: [dispatchId] });
    const batchRows = await db.query(`SELECT status, version, driver_id, vehicle_id FROM route_batches WHERE route_batch_id = $1`, [routeBatchId]);
    expect(batchRows[0]).toMatchObject({ status: 'confirmed', version: 5, driver_id: driverId, vehicle_id: vehicleId });
    const dispatchRows = await db.query(
      `SELECT s.name AS status, d.version FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`,
      [dispatchId],
    );
    expect(dispatchRows[0]).toMatchObject({ status: 'assigned', version: 1 });
    expect(await db.query(`SELECT event_type FROM route_batch_events WHERE route_batch_id = $1`, [routeBatchId]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'final_approved' })]));
    expect(await db.query(`SELECT event_type FROM dispatch_events WHERE dispatch_id = $1`, [dispatchId]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'assigned' })]));
    expect(emitted).toHaveBeenCalledWith(ROUTE_ASSIGNED_EVENT, { routeId: routeBatchId, driverId, vehicleId, dispatchIds: [dispatchId], version: 5 });
  });

  it('rejects a load above capacity without changing the batch', async () => {
    const { routeBatchId, dispatchId } = await fixture({ capacityKg: 1 });
    const response = await http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization).send(requestBody(dispatchId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_CAPACITY_EXCEEDED');
    const [{ status }] = await db.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [routeBatchId]);
    expect(status).toBe('pending_final_review');
  });

  it('allows only one of two concurrent approvals with the same expected versions', async () => {
    const { routeBatchId, dispatchId } = await fixture();
    const send = () => http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization).send(requestBody(dispatchId));
    const responses = await Promise.all([send(), send()]);

    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(responses.find(({ status }) => status === 409)?.body.error).toBe('ROUTE_BATCH_VERSION_CONFLICT');
    const [{ count }] = await db.query(`SELECT COUNT(*)::int AS count FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'final_approved'`, [routeBatchId]);
    expect(count).toBe(1);
  });

  it('rejects an inactive vehicle', async () => {
    const { routeBatchId, dispatchId, vehicleId } = await fixture();
    const [{ vehicle_status_id: maintenanceId }] = await db.query(`SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'maintenance'`);
    await db.query(`UPDATE vehicles SET vehicle_status_id = $2 WHERE vehicle_id = $1`, [vehicleId, maintenanceId]);
    const response = await http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization).send(requestBody(dispatchId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_VEHICLE_NOT_ACTIVE');
  });

  it('rejects a driver already assigned to another route that day', async () => {
    const { routeBatchId, dispatchId, shiftDate } = await fixture();
    const [{ active_vehicle_status_id: activeVehicleStatusId }] = await db.query(
      `SELECT vehicle_status_id AS active_vehicle_status_id FROM vehicle_statuses WHERE name = 'active'`,
    );
    const [{ vehicle_id: otherVehicleId }] = await db.query(
      `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
       VALUES ($1, 'van', 'ST512 busy e2e', $2, 100, 10) RETURNING vehicle_id`,
      [activeVehicleStatusId, `B${run.slice(-5)}${vehicleIds.length}`],
    );
    vehicleIds.push(Number(otherVehicleId));
    const [{ route_batch_id: otherBatchId }] = await db.query(
      `INSERT INTO route_batches (status, driver_id, vehicle_id, shift_date)
       VALUES ('confirmed', $1, $2, $3) RETURNING route_batch_id`,
      [driverId, otherVehicleId, shiftDate],
    );
    batchIds.push(Number(otherBatchId));
    const response = await http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization).send(requestBody(dispatchId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_DRIVER_NOT_AVAILABLE');
  });

  it('rejects a batch that has not entered final review', async () => {
    const { routeBatchId, dispatchId } = await fixture({ status: 'provisional' });
    const response = await http().post(api(`/route-batches/${routeBatchId}/approve-final`))
      .set('Authorization', auth.authorization).send(requestBody(dispatchId));

    expect(response.status).toBe(409);
    expect(response.body.error).toBe('ROUTE_BATCH_NOT_PENDING_FINAL_REVIEW');
  });
});
