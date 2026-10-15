// ST-75.1 (ERP-04) — programación y reprogramación de recogidas en proveedor.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Seguro de
// re-correr contra una base compartida: todo lo que crea lleva un prefijo único por corrida y se borra en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('Programación de recogidas en proveedor (e2e, ST-75.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const run = Date.now().toString(36).toUpperCase();
    const tag = `PK${run}`;
    let seq = 0;
    let supplierPickupTypeId: number;
    let deliveryTypeId: number;
    let vehicleId: number;
    let smallVehicleId: number;
    let incidentReasonId: number;
    let rescheduleReasonId: number;
    let warehouseId: number;
    let receptionStart: string;
    let receptionEnd: string;
    const statusIds: Record<string, number> = {};

    // A day far enough ahead that every slot is still in the future whenever the suite runs.
    const day = (offset = 0): string => {
        const date = new Date(Date.UTC(2030, 0, 15 + offset));
        return date.toISOString().slice(0, 10);
    };
    /** Local La Paz `HH:mm` of a day as an ISO instant (UTC-4, no daylight saving). */
    const local = (date: string, time: string): string => {
        const [h, m] = time.split(':').map(Number);
        return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h + 4, m)).toISOString();
    };

    /** The first half hour of the warehouse reception hours of a day. */
    const firstHalfHour = (offsetDays = 0) => {
        const windowStart = local(day(offsetDays), receptionStart.slice(0, 5));
        const windowEnd = new Date(new Date(windowStart).getTime() + 30 * 60_000).toISOString();
        return { windowStart, windowEnd };
    };

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const post = (id: number | string, path: string, body: object = {}, role = 'coordinator') =>
        request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/${path}`).set(auth(role)).send(body);

    /** A supplier pickup the way ST-74.1 leaves it: pending, supplier window the whole of `date`. */
    const insertPickup = async (o: { status?: string; type?: number; address?: string | null; weight?: number } = {}) => {
        const n = ++seq;
        const orderRef = `${tag}-${String(n).padStart(3, '0')}`;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address,
                                     destination_warehouse_id, estimated_weight_kg, estimated_volume_m3,
                                     scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8) RETURNING dispatch_id`,
            [
                o.type ?? supplierPickupTypeId, statusIds[o.status ?? 'pending'], orderRef,
                o.address === undefined ? 'Planta Norte, Calle 5' : o.address, warehouseId, o.weight ?? 100,
                local(day(), '00:00'), local(day(), '23:00'),
            ],
        );
        return { id: dispatch_id as number, orderRef };
    };

    const state = async (id: number) => (await dataSource.query(
        `SELECT s.name AS status, d.tracking_code, d.scheduled_window_start AS start, d.scheduled_window_end AS end
           FROM dispatches d JOIN dispatch_statuses s ON s.dispatch_status_id = d.dispatch_status_id
          WHERE d.dispatch_id = $1`, [id]))[0];
    const outbox = async (orderRef: string) => await dataSource.query(
        `SELECT type, payload->'data' AS data FROM outbound_messages WHERE payload->'data'->>'purchaseOrderId' = $1 ORDER BY created_at`,
        [orderRef]);

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        dataSource = moduleRef.get(DataSource);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            const username = `e2e_pk_${role}_${run}`;
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false)`,
                [role_id, `Recogida ${role} ${run}`, username, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        for (const r of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[r.name] = r.id;
        [{ dispatch_type_id: supplierPickupTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'supplier_pickup'`);
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        [{ incident_reason_id: incidentReasonId }] = await dataSource.query(
            `SELECT incident_reason_id FROM incident_reasons WHERE active = TRUE AND deleted_at IS NULL ORDER BY incident_reason_id LIMIT 1`);
        [{ reschedule_reason_id: rescheduleReasonId }] = await dataSource.query(
            `SELECT reschedule_reason_id FROM reschedule_reasons WHERE active = TRUE AND deleted_at IS NULL ORDER BY reschedule_reason_id LIMIT 1`);
        [{ warehouse_id: warehouseId, reception_start_time: receptionStart, reception_end_time: receptionEnd }] = await dataSource.query(
            `SELECT warehouse_id, reception_start_time, reception_end_time FROM warehouses
              WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1`);

        const [{ vehicle_status_id }] = await dataSource.query(`SELECT vehicle_status_id FROM vehicle_statuses ORDER BY vehicle_status_id LIMIT 1`);
        for (const [key, kg] of [['big', 5000], ['small', 50]] as const) {
            const [{ vehicle_id }] = await dataSource.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
                 VALUES ($1, 'truck', $2, $3, $4, 20) RETURNING vehicle_id`,
                [vehicle_status_id, `${tag} ${key}`, `${tag.slice(0, 6)}${key === 'big' ? 'B' : 'S'}`, kg],
            );
            if (key === 'big') vehicleId = vehicle_id; else smallVehicleId = vehicle_id;
        }
    });

    afterAll(async () => {
        await dataSource.query(
            `DELETE FROM outbound_messages WHERE payload->'data'->>'purchaseOrderId' LIKE $1`, [`${tag}%`]);
        await withEventPurge(dataSource, { dispatchRefs: [`${tag}%`], userNames: [`e2e_pk_%_${run}`] });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM vehicles WHERE model LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_pk_%_${run}`]);
        await app.close();
    });

    describe('permisos y validación', () => {
        it('sin token → 401', async () => {
            const { id } = await insertPickup();
            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/dispatches/${id}/pickup-schedule`).send({ vehicleId });
            expect(res.status).toBe(401);
        });

        it('supervisor y driver → 403 y no cambia nada', async () => {
            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId }, 'supervisor')).status).toBe(403);
            expect((await post(id, 'pickup-schedule', { vehicleId }, 'driver')).status).toBe(403);
            expect((await state(id)).status).toBe('pending');
        });

        it('cuerpo inválido → 400 con VALIDATION_FAILED, sin vehículo o con fecha sin desfase', async () => {
            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', {})).status).toBe(400);
            const res = await post(id, 'pickup-schedule', { vehicleId, windowStart: '2030-01-15T10:00:00', windowEnd: '2030-01-15T11:00:00' });
            expect(res.status).toBe(400);
            expect(res.body.message.join(' ')).toContain('windowStart');
        });

        it('solo un extremo de la franja o fin anterior al inicio → 400 INVALID_PICKUP_WINDOW', async () => {
            const { id } = await insertPickup();
            const one = await post(id, 'pickup-schedule', { vehicleId, windowStart: local(day(), '09:00') });
            expect(one.status).toBe(400);
            expect(one.body.error).toBe('INVALID_PICKUP_WINDOW');
            const inverted = await post(id, 'pickup-schedule', { vehicleId, windowStart: local(day(), '10:00'), windowEnd: local(day(), '09:00') });
            expect(inverted.status).toBe(400);
            expect(inverted.body.error).toBe('INVALID_PICKUP_WINDOW');
        });
    });

    describe('agendado', () => {
        it('agenda dentro de la intersección: scheduled, código de traslado y mensaje en la outbox', async () => {
            const { id, orderRef } = await insertPickup();

            const res = await post(id, 'pickup-schedule', { vehicleId });

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id, status: 'scheduled', recordVersion: 1 });
            expect(res.body.trackingCode).toMatch(/^DSP-\d{4}-\d{5}$/);
            const row = await state(id);
            expect(row.status).toBe('scheduled');
            expect(row.tracking_code).toBe(res.body.trackingCode);
            expect(row.start.toISOString()).toBe(res.body.pickupWindow.startsAt);

            const messages = await outbox(orderRef);
            expect(messages).toHaveLength(1);
            expect(messages[0].type).toBe('dispatch.pickup.scheduled');
            expect(messages[0].data).toMatchObject({ purchaseOrderId: orderRef, recordVersion: 1 });
        });

        it('una franja pedida dentro del horario del almacén se respeta', async () => {
            const { id } = await insertPickup();
            const { windowStart, windowEnd } = firstHalfHour();

            const res = await post(id, 'pickup-schedule', { vehicleId, windowStart, windowEnd });

            expect(res.status).toBe(200);
            expect(res.body.pickupWindow).toEqual({ startsAt: windowStart, endsAt: windowEnd });
        });

        it('una franja fuera del horario del almacén → 409 PICKUP_WINDOW_NOT_AVAILABLE', async () => {
            const { id } = await insertPickup();
            const [h] = receptionEnd.split(':').map(Number);
            const windowStart = local(day(), `${String(Math.min(h + 1, 22)).padStart(2, '0')}:00`);
            const windowEnd = local(day(), `${String(Math.min(h + 2, 23)).padStart(2, '0')}:00`);

            const res = await post(id, 'pickup-schedule', { vehicleId, windowStart, windowEnd });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('PICKUP_WINDOW_NOT_AVAILABLE');
            expect((await state(id)).status).toBe('pending');
        });

        it('carga estimada mayor que la del vehículo → 409 PICKUP_CAPACITY_EXCEEDED y no publica nada', async () => {
            const { id, orderRef } = await insertPickup({ weight: 400 });

            const res = await post(id, 'pickup-schedule', { vehicleId: smallVehicleId });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('PICKUP_CAPACITY_EXCEEDED');
            expect((await state(id)).status).toBe('pending');
            expect(await outbox(orderRef)).toHaveLength(0);
        });

        it('solicitud incompleta o en address_review → 409 SUPPLIER_PICKUP_INCOMPLETE', async () => {
            const noAddress = await insertPickup({ address: ' ' });
            const res = await post(noAddress.id, 'pickup-schedule', { vehicleId });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('SUPPLIER_PICKUP_INCOMPLETE');

            const review = await insertPickup({ status: 'address_review' });
            expect((await post(review.id, 'pickup-schedule', { vehicleId })).body.error).toBe('SUPPLIER_PICKUP_INCOMPLETE');
        });

        it('no es una recogida o ya está agendada → 409 DISPATCH_NOT_SCHEDULABLE', async () => {
            const delivery = await insertPickup({ type: deliveryTypeId });
            expect((await post(delivery.id, 'pickup-schedule', { vehicleId })).body.error).toBe('DISPATCH_NOT_SCHEDULABLE');

            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId })).status).toBe(200);
            const again = await post(id, 'pickup-schedule', { vehicleId });
            expect(again.status).toBe(409);
            expect(again.body.error).toBe('DISPATCH_NOT_SCHEDULABLE');
        });

        it('despacho o vehículo inexistente → 404', async () => {
            expect((await post(2_000_000_000, 'pickup-schedule', { vehicleId })).body.error).toBe('DISPATCH_NOT_FOUND');
            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId: 2_000_000_000 })).body.error).toBe('VEHICLE_NOT_FOUND');
        });
    });

    describe('reprogramación', () => {
        const body = (offsetDays: number) => ({
            ...firstHalfHour(offsetDays),
            incidentReasonId,
            rescheduleReasonId,
            description: 'El proveedor no tenía la carga lista',
        });

        it('registra incidencia y reprogramación del coordinador y publica los dos mensajes con versión 2', async () => {
            const { id, orderRef } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId })).status).toBe(200);

            const res = await post(id, 'pickup-reschedule', body(1));

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id, status: 'scheduled', recordVersion: 2 });
            expect(res.body.incidentId).toMatch(/^[0-9a-f-]{36}$/);
            expect((await state(id)).start.toISOString()).toBe(res.body.pickupWindow.startsAt);

            const [reschedule] = await dataSource.query(
                `SELECT rescheduled_by_type, rescheduled_by FROM dispatch_reschedules WHERE dispatch_id = $1`, [id]);
            expect(reschedule.rescheduled_by_type).toBe('coordinator');
            expect(reschedule.rescheduled_by).not.toBeNull();
            const [incident] = await dataSource.query(
                `SELECT incident_reason_id FROM dispatch_incidents WHERE dispatch_incident_id = $1`, [res.body.incidentId]);
            expect(incident.incident_reason_id).toBe(incidentReasonId);

            const messages = await outbox(orderRef);
            expect(messages.map((m: { type: string }) => m.type).sort()).toEqual([
                'dispatch.pickup.scheduled', 'dispatch.pickup.scheduled', 'dispatch.transfer.incident_reported',
            ]);
            expect(messages.map((m: { data: { recordVersion: number } }) => m.data.recordVersion).sort()).toEqual([1, 2, 2]);
        });

        it('una recogida que no está agendada → 409 DISPATCH_NOT_SCHEDULABLE', async () => {
            const { id } = await insertPickup();
            const res = await post(id, 'pickup-reschedule', body(1));
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_NOT_SCHEDULABLE');
        });

        it('una nueva fecha más allá de reschedule_window_days → 409 PICKUP_RESCHEDULE_OUT_OF_RANGE', async () => {
            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId })).status).toBe(200);

            const res = await post(id, 'pickup-reschedule', body(60));

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('PICKUP_RESCHEDULE_OUT_OF_RANGE');
        });

        it('motivos inexistentes → 404', async () => {
            const { id } = await insertPickup();
            expect((await post(id, 'pickup-schedule', { vehicleId })).status).toBe(200);

            const noIncident = await post(id, 'pickup-reschedule', { ...body(1), incidentReasonId: 2_000_000_000 });
            expect(noIncident.body.error).toBe('INCIDENT_REASON_NOT_FOUND');
            const noReschedule = await post(id, 'pickup-reschedule', { ...body(1), rescheduleReasonId: 2_000_000_000 });
            expect(noReschedule.body.error).toBe('RESCHEDULE_REASON_NOT_FOUND');
        });
    });
});
