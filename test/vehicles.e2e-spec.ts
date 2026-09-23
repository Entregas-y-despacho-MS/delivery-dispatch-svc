// ST-22.3 — Pruebas de integración sobre validaciones de carga volumétrica y peso (RF-A30).
//
// Levanta el AppModule real contra una base de datos real (misma config que la app vía .env, con el
// schema y la migración de vehículos ya aplicados) y pega por HTTP con supertest. Cubre el
// Escenario 3 (capacidades físicas coherentes → 400 y nada guardado) en el alta y en la
// actualización, y de paso los Escenarios 1 y 2 (alta exitosa, placa duplicada) que comparten
// endpoint. La validación de los DTOs en sí, sin DB, está en
// src/modules/fleet/vehicles/dto/vehicle-capacity-validation.spec.ts.
//
// Seguro de re-correr contra una base compartida: los usuarios y vehículos de prueba se crean con un
// prefijo único por corrida y se borran en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { User } from '../src/modules/auth/users/entities/user.entity.js';
import { Role } from '../src/modules/auth/roles/entities/role.entity.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

const MAX_CAPACITY = 99999999.99; // NUMERIC(10,2)

describe('Vehículos — validaciones de peso y volumen (e2e, RF-A30)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const createdUserIds: number[] = [];

    const run = Date.now().toString(36).toUpperCase();
    let seq = 0;
    const nextPlate = () => `IT${run}-${++seq}`;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const validBody = (extra: object = {}) => ({
        type: 'camioneta', model: 'Toyota Hilux 2022', plate: nextPlate(), capacityKg: 1000, capacityM3: 5, ...extra,
    });
    const create = (body: object, role = 'supervisor') =>
        request(app.getHttpServer()).post(`/${apiPrefix}/vehicles`).set(auth(role)).send(body);
    const update = (id: number, body: object, role = 'supervisor') =>
        request(app.getHttpServer()).put(`/${apiPrefix}/vehicles/${id}`).set(auth(role)).send(body);
    const rowByPlate = async (plate: string) =>
        (await dataSource.query(
            `SELECT vehicle_id, model, capacity_kg::text AS kg, capacity_m3::text AS m3, updated_at FROM vehicles WHERE plate = $1`, [plate],
        ))[0] as { vehicle_id: number; model: string; kg: string; m3: string; updated_at: Date } | undefined;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();

        // Same bootstrap as main.ts — the 400 shape and route prefix depend on it.
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
        const userRepo = dataSource.getRepository(User);
        const roleRepo = dataSource.getRepository(Role);
        const password     = 'E2eTest1234';
        const passwordHash = await hashPassword(password);

        for (const role of ['supervisor', 'coordinator', 'driver']) {
            const roleRow = await roleRepo.findOneByOrFail({ name: role });
            const user = await userRepo.save(userRepo.create({
                fullName: `E2E ${role}`, username: `e2e_veh_${role}_${run}`, passwordHash,
                roleId: roleRow.id, active: true, requiresPwdChange: false,
            }));
            createdUserIds.push(user.id);
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: user.username, password });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM vehicles WHERE plate LIKE $1`, [`IT${run}-%`]);
        if (createdUserIds.length > 0) await dataSource.getRepository(User).delete(createdUserIds);
        await app.close();
    });

    // ── Escenario 3 — alta ─────────────────────────────────────────────────────
    describe('Escenario 3 — POST /vehicles con capacidades inválidas → 400 y nada guardado', () => {
        const BAD: [label: string, value: unknown][] = [
            ['cero', 0],
            ['negativo', -1],
            ['negativo con decimales', -0.01],
            ['más de 2 decimales', 10.123],
            ['sobre el máximo de NUMERIC(10,2)', 100000000],
            ['muy por encima del máximo', 1e9],
            ['string numérico', '100'],
            ['null', null],
            ['booleano', true],
        ];
        const FIELDS: [field: 'capacityKg' | 'capacityM3', unit: string][] = [['capacityKg', 'kg'], ['capacityM3', 'm3']];

        for (const [field, unit] of FIELDS) {
            for (const [label, value] of BAD) {
                it(`${field} = ${label}`, async () => {
                    const body = validBody({ [field]: value });
                    const res = await create(body);

                    expect(res.status).toBe(400);
                    expect(res.body.message.join(' ')).toContain(`Capacity in ${unit}`);
                    expect(await rowByPlate(body.plate)).toBeUndefined();
                });
            }

            it(`${field} faltante`, async () => {
                const body: Record<string, unknown> = validBody();
                delete body[field];
                const res = await create(body);

                expect(res.status).toBe(400);
                expect(await rowByPlate(body.plate as string)).toBeUndefined();
            });
        }

        it('peso válido con volumen inválido (y al revés): cada campo se valida por separado', async () => {
            for (const patch of [{ capacityKg: 500, capacityM3: 0 }, { capacityKg: 0, capacityM3: 3 }]) {
                const body = validBody(patch);
                expect((await create(body)).status).toBe(400);
                expect(await rowByPlate(body.plate)).toBeUndefined();
            }
        });

        it('ambos inválidos a la vez: el 400 informa los dos', async () => {
            const res = await create(validBody({ capacityKg: 0, capacityM3: -5 }));

            expect(res.status).toBe(400);
            const message = res.body.message.join(' ');
            expect(message).toContain('Capacity in kg');
            expect(message).toContain('Capacity in m3');
        });
    });

    describe('valores límite válidos en el alta', () => {
        it('mínimo (0.01) y máximo (99999999.99) se aceptan y se guardan exactos', async () => {
            const min = validBody({ capacityKg: 0.01, capacityM3: 0.01 });
            const max = validBody({ capacityKg: MAX_CAPACITY, capacityM3: MAX_CAPACITY });

            const resMin = await create(min);
            const resMax = await create(max);

            expect(resMin.status).toBe(201);
            expect(resMax.status).toBe(201);
            expect(resMax.body.capacityKg).toBe(MAX_CAPACITY);
            expect(resMax.body.capacityM3).toBe(MAX_CAPACITY);
            expect(await rowByPlate(min.plate)).toMatchObject({ kg: '0.01', m3: '0.01' });
            expect(await rowByPlate(max.plate)).toMatchObject({ kg: '99999999.99', m3: '99999999.99' });
        });

        it('enteros y decimales se guardan sin perder precisión, y la API los devuelve como número', async () => {
            const body = validBody({ capacityKg: 1200.55, capacityM3: 8 });
            const res = await create(body);

            expect(res.status).toBe(201);
            expect(res.body.capacityKg).toBe(1200.55);
            expect(res.body.capacityM3).toBe(8);
            expect(typeof res.body.capacityKg).toBe('number');
            expect(await rowByPlate(body.plate)).toMatchObject({ kg: '1200.55', m3: '8.00' });
        });
    });

    // ── Escenario 3 — actualización ────────────────────────────────────────────
    describe('Escenario 3 — PUT /vehicles/:id', () => {
        let id: number;
        let plate: string;

        beforeAll(async () => {
            const body = validBody({ capacityKg: 1000, capacityM3: 5 });
            plate = body.plate;
            id = (await create(body)).body.id;
        });

        const expectUntouched = async () => {
            expect(await rowByPlate(plate)).toMatchObject({ model: 'Toyota Hilux 2022', kg: '1000.00', m3: '5.00' });
        };

        for (const [field, unit] of [['capacityKg', 'kg'], ['capacityM3', 'm3']] as const) {
            for (const [label, value] of [['cero', 0], ['negativo', -3], ['más de 2 decimales', 1.234], ['sobre el máximo', 1e9], ['string', '7'], ['null', null]] as const) {
                it(`${field} = ${label} → 400 y el vehículo queda intacto`, async () => {
                    const res = await update(id, { [field]: value });

                    expect(res.status).toBe(400);
                    expect(res.body.message.join(' ')).toContain(`Capacity in ${unit}`);
                    await expectUntouched();
                });
            }
        }

        it('null en otros campos obligatorios también es 400, no un 500 de la base', async () => {
            for (const field of ['type', 'model', 'plate', 'vehicleStatusId']) {
                const res = await update(id, { [field]: null });
                expect(res.status, field).toBe(400);
            }
            await expectUntouched();
        });

        it('un cambio válido junto con una capacidad inválida no se aplica a medias', async () => {
            const res = await update(id, { model: 'Modelo que NO debe guardarse', capacityKg: 0 });

            expect(res.status).toBe(400);
            await expectUntouched();
        });

        it('los rechazos no tocan updated_at', async () => {
            const before = (await rowByPlate(plate))!.updated_at;
            await update(id, { capacityM3: -1 });
            expect((await rowByPlate(plate))!.updated_at).toEqual(before);
        });

        it('actualizar solo el volumen deja el peso intacto (y viceversa)', async () => {
            const onlyM3 = await update(id, { capacityM3: 6.25 });
            expect(onlyM3.status).toBe(200);
            expect(onlyM3.body).toMatchObject({ capacityKg: 1000, capacityM3: 6.25 });

            const onlyKg = await update(id, { capacityKg: 1500.5 });
            expect(onlyKg.status).toBe(200);
            expect(onlyKg.body).toMatchObject({ capacityKg: 1500.5, capacityM3: 6.25 });
        });

        it('los valores límite válidos se aceptan al actualizar', async () => {
            const res = await update(id, { capacityKg: 0.01, capacityM3: MAX_CAPACITY });

            expect(res.status).toBe(200);
            expect(await rowByPlate(plate)).toMatchObject({ kg: '0.01', m3: '99999999.99' });
        });
    });

    // ── Precedencia entre errores ──────────────────────────────────────────────
    describe('orden en que se responden los errores', () => {
        it('sin token → 401 aunque el body sea inválido', async () => {
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/vehicles`).send(validBody({ capacityKg: 0 }));
            expect(res.status).toBe(401);
        });

        it('rol sin permiso → 403 aunque el body sea inválido (permisos antes que validación)', async () => {
            const body = validBody({ capacityKg: 0 });
            const res = await create(body, 'driver');

            expect(res.status).toBe(403);
            expect(await rowByPlate(body.plate)).toBeUndefined();
        });

        it('placa duplicada + capacidad inválida → 400 (la validación va antes que el conflicto)', async () => {
            const first = validBody();
            expect((await create(first)).status).toBe(201);

            const res = await create({ ...first, capacityM3: 0 });
            expect(res.status).toBe(400);
        });
    });

    // ── Escenarios 1 y 2 (mismo endpoint) ──────────────────────────────────────
    describe('Escenarios 1 y 2 — alta exitosa y placa duplicada', () => {
        it('supervisor y coordinator pueden registrar; el estado inicial es active', async () => {
            for (const role of ['supervisor', 'coordinator']) {
                const res = await create(validBody(), role);
                expect(res.status, role).toBe(201);
                expect(res.body.vehicleStatus.name).toBe('active');
            }
        });

        it('la misma placa (aun con otra capitalización o espacios) → 409 VEHICLE_PLATE_ALREADY_EXISTS', async () => {
            const body = validBody();
            expect((await create(body)).status).toBe(201);

            for (const plateVariant of [body.plate, ` ${body.plate.toLowerCase()} `]) {
                const res = await create({ ...body, plate: plateVariant });
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('VEHICLE_PLATE_ALREADY_EXISTS');
            }
        });

        it('altas simultáneas con la misma placa: exactamente una gana, el resto 409, ningún 500', async () => {
            const body = validBody();
            const results = await Promise.all(Array.from({ length: 6 }, () => create(body)));
            const statuses = results.map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            const [{ count }] = await dataSource.query(`SELECT count(*)::int AS count FROM vehicles WHERE plate = $1`, [body.plate]);
            expect(count).toBe(1);
        });

        it('al dar de baja un vehículo, su placa se puede volver a registrar', async () => {
            const body = validBody();
            const first = await create(body);
            const del = await request(app.getHttpServer()).delete(`/${apiPrefix}/vehicles/${first.body.id}`).set(auth('supervisor'));
            expect(del.status).toBe(204);

            const again = await create(body);
            expect(again.status).toBe(201);
            expect(again.body.id).not.toBe(first.body.id);
        });
    });

    // ── Datos previos a la migración ───────────────────────────────────────────
    describe('vehículos anteriores a la migración (capacity_m3 = 0, model = Unspecified)', () => {
        it('se pueden leer, y solo se corrigen con valores válidos', async () => {
            const plate = nextPlate();
            const [{ vehicle_id }] = await dataSource.query(
                `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3)
                 VALUES (1, 'moto', 'Unspecified', $1, 50, 0) RETURNING vehicle_id`, [plate],
            );

            const got = await request(app.getHttpServer()).get(`/${apiPrefix}/vehicles/${vehicle_id}`).set(auth('supervisor'));
            expect(got.status).toBe(200);
            expect(got.body).toMatchObject({ model: 'Unspecified', capacityM3: 0 });

            expect((await update(vehicle_id, { capacityM3: 0 })).status).toBe(400); // 0 sigue sin ser válido
            const fixed = await update(vehicle_id, { model: 'Honda XR150', capacityM3: 0.4 });
            expect(fixed.status).toBe(200);
            expect(fixed.body).toMatchObject({ model: 'Honda XR150', capacityM3: 0.4 });
        });
    });
});
