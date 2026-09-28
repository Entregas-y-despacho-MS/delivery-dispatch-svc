// ES-26 (ST-26.1 + ST-26.3) — Registro de incidente sobre un vehículo (RF-A34, Escenario 2): el
// foco de este archivo es la regla de negocio de transición de estado — que registrar un incidente
// con disablesVehicle=true mueva el vehículo a `maintenance` de inmediato, en la misma transacción,
// y que uno con disablesVehicle=false lo deje intacto. Es la subtarea ST-26.3 ("pruebas
// automatizadas de reglas de negocio para transición de estado de vehículo") vista contra Postgres
// real, complementando los unitarios (sin DB) de
// src/modules/fleet/vehicle-maintenances/services/vehicle-maintenances.service.spec.ts.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Seguro de
// re-correr contra una base compartida: todo lo creado usa un tag único por corrida y se borra en
// afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Registro de incidente sobre un vehículo — transición de estado (e2e, RF-A34, Escenario 2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `VM-${run}`;
    let seq = 0;
    const nextPlate = () => `${tag}${++seq}`.slice(0, 15);
    const nextTypeCode = () => `${tag}-T${++seq}`.replace(/[^A-Z0-9-]/gi, '');

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = () => `/${apiPrefix}/vehicle-maintenances`;
    const post = (body: object, role = 'supervisor') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);

    const vehicleStatusId: Record<string, number> = {};
    const newVehicle = async (statusName = 'active') => {
        const [{ vehicle_id }] = await dataSource.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
             VALUES ($1, 'camioneta', 'Toyota Hilux 2022', $2, 1000, 5) RETURNING vehicle_id`,
            [vehicleStatusId[statusName], nextPlate()],
        );
        return vehicle_id as number;
    };
    const newIncidentType = async (disablesVehicle: boolean, extra: { severity?: string } = {}) => {
        const [{ vehicle_incident_type_id }] = await dataSource.query(
            `INSERT INTO vehicle_incident_types (code, name, severity, disables_vehicle) VALUES ($1, $2, $3, $4) RETURNING vehicle_incident_type_id`,
            [nextTypeCode(), `${tag} tipo ${seq}`, extra.severity ?? (disablesVehicle ? 'critical' : 'minor'), disablesVehicle],
        );
        return vehicle_incident_type_id as number;
    };
    const vehicleStatus = async (vehicleId: number) =>
        (await dataSource.query(`SELECT vs.name FROM vehicles v JOIN vehicle_statuses vs ON vs.vehicle_status_id = v.vehicle_status_id WHERE v.vehicle_id = $1`, [vehicleId]))[0].name as string;
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
                [role_id, `E2E ${role}`, `e2e_vm_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_vm_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM vehicle_maintenances WHERE description LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM vehicles WHERE plate LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM vehicle_incident_types WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_vm_%_${run}`]);
        await app.close();
    });

    // ── Escenario 2 — el corazón de este archivo ─────────────────────────────────
    describe('Escenario 2 — un incidente crítico/disablesVehicle pasa el vehículo a maintenance de inmediato', () => {
        it('disablesVehicle = true → 201, la respuesta y la base reflejan vehicleStatus = maintenance', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} ruido metálico en frenos` });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ vehicleId, vehicleIncidentTypeId: typeId, status: 'pending', vehicleStatus: 'maintenance' });
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });

        it('disablesVehicle = false → 201, pero el vehículo se queda en su estado (active)', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(false);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} rueda gastada, sin urgencia` });

            expect(res.status).toBe(201);
            expect(res.body.vehicleStatus).toBe('active');
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('el registro del incidente persiste de todas formas, aunque no dispare el cambio de estado', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(false);
            const before     = await maintenanceCount(vehicleId);

            await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} registro sin trigger` });

            expect(await maintenanceCount(vehicleId)).toBe(before + 1);
        });

        it('un vehículo ya en maintenance recibe otro incidente disablesVehicle → se queda en maintenance, sin error', async () => {
            const vehicleId = await newVehicle('maintenance');
            const typeId    = await newIncidentType(true);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} segundo incidente crítico` });

            expect(res.status).toBe(201);
            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });

        it('un vehículo out_of_service también pasa a maintenance si se le registra un incidente disablesVehicle', async () => {
            const vehicleId = await newVehicle('out_of_service');
            const typeId    = await newIncidentType(true);

            await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} desde out_of_service` });

            expect(await vehicleStatus(vehicleId)).toBe('maintenance');
        });

        it('severity y disablesVehicle son independientes: un tipo crítico con disablesVehicle=false NO dispara el cambio', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(false, { severity: 'critical' });

            await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} crítico pero no inhabilita` });

            expect(await vehicleStatus(vehicleId)).toBe('active');
        });
    });

    // ── Existencia de las referencias ─────────────────────────────────────────────
    describe('vehicleId y vehicleIncidentTypeId deben existir', () => {
        it('vehicleId inexistente → 404 VEHICLE_NOT_FOUND, nada se guarda', async () => {
            const typeId = await newIncidentType(true);

            const res = await post({ vehicleId: 99999999, vehicleIncidentTypeId: typeId, description: `${tag} vehículo inexistente` });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('VEHICLE_NOT_FOUND');
        });

        it('vehicleIncidentTypeId inexistente → 404 VEHICLE_INCIDENT_TYPE_NOT_FOUND; ni el registro ni el cambio de estado ocurren (atomicidad)', async () => {
            const vehicleId = await newVehicle('active');
            const before     = await maintenanceCount(vehicleId);

            const res = await post({ vehicleId, vehicleIncidentTypeId: 99999999, description: `${tag} tipo inexistente` });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('VEHICLE_INCIDENT_TYPE_NOT_FOUND');
            expect(await maintenanceCount(vehicleId)).toBe(before); // nada se insertó
            expect(await vehicleStatus(vehicleId)).toBe('active');   // nada cambió
        });
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: supervisor y coordinador registran; admin y driver no', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).post(url()).send({})).status).toBe(401);
        });

        it.each(['admin', 'driver'])('%s → 403, nada se guarda', async (role) => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            const before     = await maintenanceCount(vehicleId);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} sin permiso` }, role);

            expect(res.status).toBe(403);
            expect(await maintenanceCount(vehicleId)).toBe(before);
            expect(await vehicleStatus(vehicleId)).toBe('active');
        });

        it('coordinator también puede registrar (mismo criterio que /vehicles)', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);

            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} coordinator` }, 'coordinator');

            expect(res.status).toBe(201);
        });
    });

    // ── Validación ───────────────────────────────────────────────────────────────
    describe('validación', () => {
        it('vehicleId, vehicleIncidentTypeId y description son obligatorios', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            const full = { vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} completo` };
            for (const field of ['vehicleId', 'vehicleIncidentTypeId', 'description']) {
                const body: Record<string, unknown> = { ...full };
                delete body[field];
                expect((await post(body)).status, field).toBe(400);
            }
        });

        it('description vacía o de solo espacios se rechaza', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            expect((await post({ vehicleId, vehicleIncidentTypeId: typeId, description: '' })).status).toBe(400);
            expect((await post({ vehicleId, vehicleIncidentTypeId: typeId, description: '   ' })).status).toBe(400);
        });

        it('un vehicleId o vehicleIncidentTypeId no numérico/negativo/cero → 400', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            for (const bad of [0, -1, 1.5, 'abc']) {
                expect((await post({ vehicleId: bad, vehicleIncidentTypeId: typeId, description: `${tag} malo` })).status, `vehicleId=${bad}`).toBe(400);
                expect((await post({ vehicleId, vehicleIncidentTypeId: bad, description: `${tag} malo` })).status, `typeId=${bad}`).toBe(400);
            }
        });

        it('no se puede elegir status ni id al registrar (eso lo decide el trigger, no el cliente)', async () => {
            const vehicleId = await newVehicle('active');
            const typeId    = await newIncidentType(true);
            const res = await post({ vehicleId, vehicleIncidentTypeId: typeId, description: `${tag} campo extra`, status: 'completed' });
            expect(res.status).toBe(400);
        });
    });
});
