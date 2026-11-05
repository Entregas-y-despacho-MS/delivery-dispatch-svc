// ST-64.1 (RF-A17) — Historial, seguimiento y cierre de mantenimientos, y la guarda de lotes
// comprometidos (ST-62.1) aplicada al registro (RF-A34). Levanta el AppModule real contra una base
// real y pega por HTTP con supertest. Seguro de re-correr: todo lo creado usa un tag único por corrida
// y se borra en afterAll.
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

describe('Mantenimientos de vehículos — historial, seguimiento y cierre (e2e, ST-64.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const routeBatchIds: number[] = [];

    const run = Date.now().toString(36).toUpperCase();
    const tag = `VH-${run}`;
    let seq = 0;
    const nextPlate = () => `${tag}${++seq}`.slice(0, 15);
    const nextTypeCode = () => `${tag}-T${++seq}`.replace(/[^A-Z0-9-]/gi, '');

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (suffix = '') => `/${apiPrefix}/vehicle-maintenances${suffix}`;
    const post = (body: object, role = 'supervisor') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);
    const patchStatus = (id: number | string, body: object, role = 'supervisor') =>
        request(app.getHttpServer()).patch(url(`/${id}/status`)).set(auth(role)).send(body);
    const list = (query: Record<string, string | number>, role = 'supervisor') =>
        request(app.getHttpServer()).get(url()).query(query).set(auth(role));

    const vehicleStatusId: Record<string, number> = {};
    const newVehicle = async (statusName = 'active') => {
        const [{ vehicle_id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'camioneta', 'Toyota Hilux 2022', $2, 1000, 5) RETURNING vehicle_id`,
            [vehicleStatusId[statusName], nextPlate()],
        );
        return vehicle_id as number;
    };
    const newIncidentType = async (disablesVehicle: boolean) => {
        const [{ vehicle_incident_type_id }] = await dataSource.query(
            `INSERT INTO vehicle_incident_types (code, name, severity, disables_vehicle) VALUES ($1, $2, 'minor', $3) RETURNING vehicle_incident_type_id`,
            [nextTypeCode(), `${tag} tipo ${seq}`, disablesVehicle],
        );
        return vehicle_incident_type_id as number;
    };
    /** Inserta directamente un mantenimiento (permite sin tipo de incidente y con fecha de registro fija). */
    const newMaintenance = async (vehicleId: number, opts: { status?: string; typeId?: number | null; createdAt?: string } = {}) => {
        const [{ vehicle_maintenance_id }] = await dataSource.query(
            `INSERT INTO vehicle_maintenances (vehicle_id, vehicle_incident_type_id, description, status, created_at)
             VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW())) RETURNING vehicle_maintenance_id`,
            [vehicleId, opts.typeId ?? null, `${tag} mantenimiento ${++seq}`, opts.status ?? 'pending', opts.createdAt ?? null],
        );
        return vehicle_maintenance_id as number;
    };
    const vehicleStatus = async (vehicleId: number) =>
        (await dataSource.query(`SELECT vs.name FROM vehicles v JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id WHERE v.vehicle_id = $1`, [vehicleId]))[0].name as string;
    const maintenanceRow = async (id: number) =>
        (await dataSource.query(`SELECT status, completed_at FROM vehicle_maintenances WHERE vehicle_maintenance_id = $1`, [id]))[0] as { status: string; completed_at: Date | null };
    const maintenanceCount = async (vehicleId: number) =>
        (await dataSource.query(`SELECT count(*)::int AS c FROM vehicle_maintenances WHERE vehicle_id = $1`, [vehicleId]))[0].c as number;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

        apiPrefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(apiPrefix);
        app.useGlobalPipes(new ValidationPipe({
            transform:            true,
            whitelist:            true,
            forbidNonWhitelisted: true,
            transformOptions:     { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();

        dataSource = moduleRef.get(DataSource);
        for (const r of await dataSource.query(`SELECT vehicle_status_id, name FROM vehicle_statuses`)) vehicleStatusId[r.name] = r.vehicle_status_id;

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['supervisor', 'coordinator', 'admin', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `E2E ${role}`, `e2e_vh_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_vh_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await withEventPurge(dataSource, { userNames: [`e2e_vh_%_${run}`] });
        if (routeBatchIds.length > 0) await dataSource.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [routeBatchIds]);
        await dataSource.query(`DELETE FROM vehicle_maintenances WHERE description LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM vehicles WHERE plate LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM vehicle_incident_types WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_vh_%_${run}`]);
        await app.close();
    });

    // ── Historial (Escenario 1) ──────────────────────────────────────────────────
    describe('GET /vehicle-maintenances — historial con filtros y paginación', () => {
        let vehicleId: number;
        let otherVehicleId: number;
        let typeId: number;
        let idPendingOld: number;
        let idInProgress: number;
        let idCompleted: number;
        let idPreventive: number;

        beforeAll(async () => {
            vehicleId      = await newVehicle('active');
            otherVehicleId = await newVehicle('active');
            typeId         = await newIncidentType(false);
            idPendingOld = await newMaintenance(vehicleId, { status: 'pending',     typeId, createdAt: '2026-01-10T15:00:00Z' });
            idInProgress = await newMaintenance(vehicleId, { status: 'in_progress', typeId, createdAt: '2026-02-10T15:00:00Z' });
            idCompleted  = await newMaintenance(vehicleId, { status: 'completed',   typeId, createdAt: '2026-03-10T15:00:00Z' });
            idPreventive = await newMaintenance(vehicleId, { status: 'pending',     typeId: null, createdAt: '2026-04-10T15:00:00Z' });
            await newMaintenance(otherVehicleId, { status: 'pending', typeId });
        });

        it('lista los del vehículo, el más reciente primero, con vehículo, tipo y maintenanceType', async () => {
            const res = await list({ vehicleId });

            expect(res.status).toBe(200);
            expect(res.body.data.map((m: { id: number }) => m.id)).toEqual([idPreventive, idCompleted, idInProgress, idPendingOld]);
            expect(res.body.meta).toMatchObject({ page: 1, limit: 10, total: 4, pages: 1 });

            const [preventive, , inProgress] = res.body.data;
            expect(preventive).toMatchObject({ vehicleId, vehicleIncidentTypeId: null, vehicleIncidentType: null, maintenanceType: 'preventive', completedAt: null });
            expect(preventive.vehicle).toMatchObject({ id: vehicleId });
            expect(inProgress).toMatchObject({ status: 'in_progress', maintenanceType: 'corrective', vehicleIncidentTypeId: typeId });
            expect(inProgress.vehicleIncidentType).toMatchObject({ id: typeId });
        });

        it('filtra por estado', async () => {
            const res = await list({ vehicleId, status: 'pending' });
            expect(res.body.data.map((m: { id: number }) => m.id)).toEqual([idPreventive, idPendingOld]);
        });

        it('filtra por fechas (días de Bolivia, ambos extremos inclusivos)', async () => {
            const both = await list({ vehicleId, from: '2026-02-10', to: '2026-03-10' });
            expect(both.body.data.map((m: { id: number }) => m.id)).toEqual([idCompleted, idInProgress]);

            const onlyFrom = await list({ vehicleId, from: '2026-03-11' });
            expect(onlyFrom.body.data.map((m: { id: number }) => m.id)).toEqual([idPreventive]);

            const onlyTo = await list({ vehicleId, to: '2026-01-10' });
            expect(onlyTo.body.data.map((m: { id: number }) => m.id)).toEqual([idPendingOld]);
        });

        it('el día se calcula en hora de Bolivia: 2026-03-11T02:00Z es todavía el 10 de marzo allá', async () => {
            const vid = await newVehicle('active');
            const late = await newMaintenance(vid, { createdAt: '2026-03-11T02:00:00Z' });

            expect((await list({ vehicleId: vid, from: '2026-03-10', to: '2026-03-10' })).body.data.map((m: { id: number }) => m.id)).toEqual([late]);
            expect((await list({ vehicleId: vid, from: '2026-03-11', to: '2026-03-11' })).body.data).toEqual([]);
        });

        it('combina filtros', async () => {
            const res = await list({ vehicleId, status: 'pending', from: '2026-03-01' });
            expect(res.body.data.map((m: { id: number }) => m.id)).toEqual([idPreventive]);
        });

        it('pagina', async () => {
            const res = await list({ vehicleId, page: 2, limit: 3 });
            expect(res.body.data.map((m: { id: number }) => m.id)).toEqual([idPendingOld]);
            expect(res.body.meta).toMatchObject({ page: 2, limit: 3, total: 4, pages: 2 });
        });

        it('el historial conserva el vehículo y el tipo aunque se hayan eliminado después', async () => {
            const vid  = await newVehicle('active');
            const tid  = await newIncidentType(false);
            const id   = await newMaintenance(vid, { typeId: tid });
            await dataSource.query(`UPDATE vehicles SET deleted_at = NOW() WHERE vehicle_id = $1`, [vid]);
            await dataSource.query(`UPDATE vehicle_incident_types SET deleted_at = NOW() WHERE vehicle_incident_type_id = $1`, [tid]);

            const res = await list({ vehicleId: vid });

            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0]).toMatchObject({ id, vehicleId: vid, maintenanceType: 'corrective', vehicleIncidentTypeId: tid });
            expect(res.body.data[0].vehicle).toMatchObject({ id: vid });
        });

        it('coordinator también puede listar', async () => {
            expect((await list({ vehicleId }, 'coordinator')).status).toBe(200);
        });

        it('sin token → 401; admin y driver → 403', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
            for (const role of ['admin', 'driver']) expect((await list({}, role)).status, role).toBe(403);
        });

        it.each([
            [{ status: 'done' }],
            [{ vehicleId: 'abc' }],
            [{ vehicleId: 0 }],
            [{ from: '2026-13-40' }],
            [{ from: '10/03/2026' }],
            [{ to: 'ayer' }],
            [{ limit: 101 }],
            [{ page: 0 }],
        ])('parámetro inválido %j → 400', async (query) => {
            expect((await list(query as Record<string, string | number>)).status).toBe(400);
        });

        it('from posterior a to → 400 INVALID_MAINTENANCE_DATE_RANGE', async () => {
            const res = await list({ from: '2026-03-10', to: '2026-03-09' });
            expect(res.status).toBe(400);
            expect(res.body.error).toBe('INVALID_MAINTENANCE_DATE_RANGE');
        });
    });

    // ── Transiciones (Escenario 2) ───────────────────────────────────────────────
    describe('PATCH /vehicle-maintenances/:id/status — transiciones', () => {
        it('pending → in_progress → completed, en ese orden; completed_at solo se fija al final', async () => {
            const vehicleId = await newVehicle('maintenance');
            const id = await newMaintenance(vehicleId, { status: 'pending' });

            const started = await patchStatus(id, { status: 'in_progress' });
            expect(started.status).toBe(200);
            expect(started.body).toMatchObject({ id, status: 'in_progress', completedAt: null, vehicleStatus: 'maintenance' });
            expect((await maintenanceRow(id)).completed_at).toBeNull();

            const done = await patchStatus(id, { status: 'completed' });
            expect(done.status).toBe(200);
            expect(done.body.status).toBe('completed');
            expect(done.body.completedAt).toEqual(expect.any(String));
            expect((await maintenanceRow(id)).completed_at).not.toBeNull();
        });

        it.each([
            ['pending', 'completed'],
            ['pending', 'pending'],
            ['in_progress', 'pending'],
            ['in_progress', 'in_progress'],
            ['completed', 'pending'],
            ['completed', 'in_progress'],
            ['completed', 'completed'],
        ])('%s → %s → 409 INVALID_MAINTENANCE_TRANSITION y nada cambia', async (from, to) => {
            const vehicleId = await newVehicle('maintenance');
            const id = await newMaintenance(vehicleId, { status: from });
            const before = await maintenanceRow(id);

            const res = await patchStatus(id, { status: to });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('INVALID_MAINTENANCE_TRANSITION');
            expect(await maintenanceRow(id)).toEqual(before);
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });

        it('un mantenimiento inexistente → 404 VEHICLE_MAINTENANCE_NOT_FOUND', async () => {
            const res = await patchStatus(99999999, { status: 'in_progress' });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('VEHICLE_MAINTENANCE_NOT_FOUND');
        });

        it('validación: status inválido, ausente o con campos extra → 400; :id inválido → 400', async () => {
            const vehicleId = await newVehicle('maintenance');
            const id = await newMaintenance(vehicleId, { status: 'pending' });

            expect((await patchStatus(id, { status: 'cancelled' })).status).toBe(400);
            expect((await patchStatus(id, {})).status).toBe(400);
            expect((await patchStatus(id, { status: 'in_progress', completedAt: '2026-01-01' })).status).toBe(400);
            expect((await patchStatus('abc', { status: 'in_progress' })).status).toBe(400);
            expect((await maintenanceRow(id)).status).toBe('pending');
        });

        it('coordinator puede avanzar; sin token → 401; admin y driver → 403 sin cambios', async () => {
            const vehicleId = await newVehicle('maintenance');
            const id = await newMaintenance(vehicleId, { status: 'pending' });

            expect((await request(app.getHttpServer()).patch(url(`/${id}/status`)).send({ status: 'in_progress' })).status).toBe(401);
            for (const role of ['admin', 'driver']) expect((await patchStatus(id, { status: 'in_progress' }, role)).status, role).toBe(403);
            expect((await maintenanceRow(id)).status).toBe('pending');

            expect((await patchStatus(id, { status: 'in_progress' }, 'coordinator')).status).toBe(200);
        });
    });

    // ── Cierre y reactivación (Escenario 2) ──────────────────────────────────────
    describe('completar un mantenimiento y reactivar el vehículo', () => {
        it('sin otro mantenimiento abierto → el vehículo vuelve a active, en la misma respuesta', async () => {
            const vehicleId = await newVehicle('maintenance');
            const id = await newMaintenance(vehicleId, { status: 'in_progress' });

            const res = await patchStatus(id, { status: 'completed' });

            expect(res.status).toBe(200);
            expect(res.body.vehicleStatus).toBe('active');
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it.each(['pending', 'in_progress'])('con otro mantenimiento %s del mismo vehículo → se cierra pero el vehículo sigue en maintenance', async (otherStatus) => {
            const vehicleId = await newVehicle('maintenance');
            const id    = await newMaintenance(vehicleId, { status: 'in_progress' });
            const other = await newMaintenance(vehicleId, { status: otherStatus });

            const res = await patchStatus(id, { status: 'completed' });

            expect(res.status).toBe(200);
            expect(res.body.vehicleStatus).toBe('maintenance');
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
            expect((await maintenanceRow(other)).status).toBe(otherStatus);
        });

        it('al cerrar el último de dos mantenimientos, el vehículo recién ahí vuelve a active', async () => {
            const vehicleId = await newVehicle('maintenance');
            const first  = await newMaintenance(vehicleId, { status: 'in_progress' });
            const second = await newMaintenance(vehicleId, { status: 'in_progress' });

            await patchStatus(first, { status: 'completed' });
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');

            await patchStatus(second, { status: 'completed' });
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('un mantenimiento ya completado de ese vehículo no cuenta como abierto', async () => {
            const vehicleId = await newVehicle('maintenance');
            await newMaintenance(vehicleId, { status: 'completed' });
            const id = await newMaintenance(vehicleId, { status: 'in_progress' });

            await patchStatus(id, { status: 'completed' });

            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('un mantenimiento abierto de OTRO vehículo no impide reactivar', async () => {
            const vehicleId = await newVehicle('maintenance');
            await newMaintenance(await newVehicle('maintenance'), { status: 'pending' });
            const id = await newMaintenance(vehicleId, { status: 'in_progress' });

            await patchStatus(id, { status: 'completed' });

            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('si una persona dejó el vehículo en out_of_service, cerrar el mantenimiento no lo reactiva', async () => {
            const vehicleId = await newVehicle('out_of_service');
            const id = await newMaintenance(vehicleId, { status: 'in_progress' });

            const res = await patchStatus(id, { status: 'completed' });

            expect(res.status).toBe(200);
            expect(res.body.vehicleStatus).toBe('out_of_service');
            expect(await vehicleStatus(vehicleId)).toBe('out_of_service');
        });

        it('cerrar los dos últimos a la vez deja el vehículo en active y ambos completed (sin interbloqueo)', async () => {
            const vehicleId = await newVehicle('maintenance');
            const a = await newMaintenance(vehicleId, { status: 'in_progress' });
            const b = await newMaintenance(vehicleId, { status: 'in_progress' });

            const [ra, rb] = await Promise.all([patchStatus(a, { status: 'completed' }), patchStatus(b, { status: 'completed' })]);

            expect([ra.status, rb.status]).toEqual([200, 200]);
            expect((await maintenanceRow(a)).status).toBe('completed');
            expect((await maintenanceRow(b)).status).toBe('completed');
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });
    });

    // ── Registro con ruta comprometida (Escenario 3) ─────────────────────────────
    describe('POST /vehicle-maintenances — guarda de lotes comprometidos (ST-62.1)', () => {
        const newBatch = async (vehicleId: number, status: string) => {
            const [{ route_batch_id }] = await dataSource.query(
                `INSERT INTO route_batches (status, vehicle_id, shift_date) VALUES ($1, $2, '2026-11-20') RETURNING route_batch_id`,
                [status, vehicleId],
            );
            routeBatchIds.push(route_batch_id as number);
            return route_batch_id as number;
        };

        it.each(['confirmed', 'in_execution'])('lote %s + tipo que inhabilita → 409 con los lotes afectados; no se guarda nada ni cambia el vehículo', async (batchStatus) => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            const batchId   = await newBatch(vehicleId, batchStatus);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} con lote ${batchStatus}` });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('VEHICLE_HAS_ACTIVE_BATCHES');
            expect(res.body.details.batches).toEqual([{ id: batchId, shiftDate: '2026-11-20' }]);
            expect(await maintenanceCount(vehicleId)).toBe(0);
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('lote confirmado + tipo que NO inhabilita → 201: el vehículo no se mueve, así que no hay conflicto', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(false);
            await newBatch(vehicleId, 'confirmed');

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} menor con lote` });

            expect(res.status).toBe(201);
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('lote en otro estado (p. ej. provisional) no bloquea el registro', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            await newBatch(vehicleId, 'provisional');

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} lote provisional` });

            expect(res.status).toBe(201);
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });

        it('un lote comprometido de OTRO vehículo no bloquea', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            await newBatch(await newVehicle('active'), 'in_execution');

            expect((await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} otro vehículo` })).status).toBe(201);
        });

        it('vehículo que ya está en maintenance no se mueve: sigue registrándose aunque tenga un lote', async () => {
            const vehicleId = await newVehicle('maintenance');
            const typeId    = await newIncidentType(true);
            await newBatch(vehicleId, 'confirmed');

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} ya en taller` });

            expect(res.status).toBe(201);
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });
    });
});
