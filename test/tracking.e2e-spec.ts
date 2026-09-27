// RF-U11 — Pruebas de integración de la ingesta de telemetría GPS del repartidor:
// POST /tracking/locations. Escenario 1 (posición en vivo), Escenario 3 (lote de puntos
// desordenado por buffer offline — solo el más nuevo por despacho gana, vía el guardrail de
// DispatchesService.updateLocation), pertenencia del despacho al repartidor, y permisos.
//
// La retransmisión por Socket.IO (evento 'dispatch.location.updated' a la sala 'dispatch-board')
// NO se prueba acá con un cliente de socket real — eso exigiría levantar un puerto HTTP real y
// sumar socket.io-client como dependencia solo para esto. Ya está cubierto de punta a punta, en
// piezas, por unitarios: socket.gateway.spec.ts (el plugin anuncia la conexión con el rol) +
// tracking.service.spec.ts (quién se une a la sala, y que se emite con el payload correcto).
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

describe('Tracking GPS del repartidor (e2e, RF-U11)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    let pendingStatusId: number;

    const run = Date.now().toString(36).toUpperCase();
    let orderSeq = 0;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = () => `/${apiPrefix}/tracking/locations`;
    const report = (locations: object[], role = 'driver1') => request(app.getHttpServer()).post(url()).set(auth(role)).send({ locations });
    const point = (dispatchId: number, over: object = {}) => ({ dispatchId, latitude: -17.783, longitude: -63.182, recordedAt: isoMinutesAgo(5), ...over });

    const isoMinutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const isoMinutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

    // A fresh dispatch per scenario — avoids one test's stored last_location_at leaking into another's.
    const freshDispatch = async (routeBatchId: number) => {
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, source_order_ref, delivery_address)
             VALUES (1, $1, $2, $3, 'Av. Test 123') RETURNING dispatch_id`,
            [pendingStatusId, routeBatchId, `trk-${run}-${++orderSeq}`],
        );
        return dispatch_id as number;
    };
    const lastLocation = async (dispatchId: number) =>
        (await dataSource.query(`SELECT last_latitude, last_longitude, last_location_at FROM dispatches WHERE dispatch_id = $1`, [dispatchId]))[0];

    let routeBatch1: number;
    let routeBatch2: number;

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
        const passwordHash = await hashPassword('E2eTest1234');
        // driver1/driver2: two different drivers, to prove a driver can't report on the other's dispatch.
        for (const role of ['driver1', 'driver2', 'coordinator', 'admin', 'supervisor']) {
            const roleName = role.startsWith('driver') ? 'driver' : role;
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [roleName]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `E2E ${role}`, `e2e_trk_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_trk_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        pendingStatusId = (await dataSource.query(`SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'pending'`))[0].dispatch_status_id;

        const driverIdOf = async (role: string) => (await dataSource.query(`SELECT user_id FROM users WHERE username = $1`, [`e2e_trk_${role}_${run}`]))[0].user_id;
        [{ route_batch_id: routeBatch1 }] = await dataSource.query(`INSERT INTO route_batches (driver_id, shift_date) VALUES ($1, CURRENT_DATE) RETURNING route_batch_id`, [await driverIdOf('driver1')]);
        [{ route_batch_id: routeBatch2 }] = await dataSource.query(`INSERT INTO route_batches (driver_id, shift_date) VALUES ($1, CURRENT_DATE) RETURNING route_batch_id`, [await driverIdOf('driver2')]);
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`trk-${run}-%`]);
        await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id IN ($1, $2)`, [routeBatch1, routeBatch2]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_trk_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: solo el repartidor', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).post(url()).send({ locations: [point(1)] })).status).toBe(401);
        });

        it.each(['coordinator', 'admin', 'supervisor'])('%s → 403 (esto lo manda el repartidor, no el panel)', async (role) => {
            const res = await report([point(1)], role);
            expect(res.status).toBe(403);
            expect(res.body.error).toBe('INSUFFICIENT_PERMISSIONS');
        });
    });

    // ── Escenario 1: posición en vivo ────────────────────────────────────────────
    describe('Escenario 1 — un punto en vivo', () => {
        it('guarda lat/lng/recordedAt y responde applied', async () => {
            const dispatchId = await freshDispatch(routeBatch1);
            const p = point(dispatchId);

            const res = await report([p]);

            expect(res.status).toBe(201);
            expect(res.body.results).toEqual([{ dispatchId, outcome: 'applied' }]);
            const row = await lastLocation(dispatchId);
            expect(Number(row.last_latitude)).toBe(-17.783);
            expect(Number(row.last_longitude)).toBe(-63.182);
            expect(new Date(row.last_location_at).toISOString()).toBe(p.recordedAt);
        });
    });

    // ── Escenario 3: lote desordenado (buffer offline) ──────────────────────────
    describe('Escenario 3 — lote de puntos fuera de orden', () => {
        it('el orden de ENVÍO no importa: el resultado final es el mismo que si hubieran llegado en orden', async () => {
            const dispatchId = await freshDispatch(routeBatch1);
            const oldest = point(dispatchId, { latitude: -1, longitude: -1, recordedAt: isoMinutesAgo(30) });
            const middle = point(dispatchId, { latitude: -2, longitude: -2, recordedAt: isoMinutesAgo(20) });
            const newest = point(dispatchId, { latitude: -3, longitude: -3, recordedAt: isoMinutesAgo(10) });

            // Enviados fuera de orden a propósito — se aplican cronológicamente (oldest, middle, newest),
            // y como cada uno es genuinamente más nuevo que el anterior, los 3 son "applied": no hay
            // ningún punto repetido/empatado en este lote que el guardrail tenga que rechazar.
            const res = await report([middle, newest, oldest]);

            expect(res.status).toBe(201);
            expect(res.body.results).toEqual([
                { dispatchId, outcome: 'applied' },
                { dispatchId, outcome: 'applied' },
                { dispatchId, outcome: 'applied' },
            ]);
            // Lo que importa: el que terminó guardado es el cronológicamente más nuevo (newest),
            // sin importar que se haya mandado último en el array.
            const row = await lastLocation(dispatchId);
            expect(Number(row.last_latitude)).toBe(-3);
            expect(new Date(row.last_location_at).toISOString()).toBe(newest.recordedAt);
        });

        it('dos puntos del mismo instante en un mismo lote: el segundo en aplicarse es stale (no es estrictamente más nuevo)', async () => {
            const dispatchId = await freshDispatch(routeBatch1);
            const sameInstant = isoMinutesAgo(5);
            const a = point(dispatchId, { latitude: -1, longitude: -1, recordedAt: sameInstant });
            const b = point(dispatchId, { latitude: -2, longitude: -2, recordedAt: sameInstant });

            const res = await report([a, b]);

            const outcomes = res.body.results.map((r: any) => r.outcome);
            expect(outcomes.sort()).toEqual(['applied', 'stale']); // uno de los dos gana, el otro no (empate, no "más nuevo")
        });

        it('un punto viejo que llega DESPUÉS de uno ya guardado más nuevo → stale, no pisa nada', async () => {
            const dispatchId = await freshDispatch(routeBatch1);
            const first = point(dispatchId, { recordedAt: isoMinutesAgo(5) });
            await report([first]);

            const stale = point(dispatchId, { latitude: -9, longitude: -9, recordedAt: isoMinutesAgo(15) });
            const res = await report([stale]);

            expect(res.body.results).toEqual([{ dispatchId, outcome: 'stale' }]);
            const row = await lastLocation(dispatchId);
            expect(Number(row.last_latitude)).toBe(-17.783); // sigue siendo el de `first`, no el de `stale`
        });
    });

    // ── Pertenencia del despacho ─────────────────────────────────────────────────
    describe('un repartidor solo puede reportar sobre despachos de su propia ruta', () => {
        it('un despacho de OTRO repartidor → failed, "Dispatch not found."', async () => {
            const otherDriversDispatch = await freshDispatch(routeBatch2);

            const res = await report([point(otherDriversDispatch)]); // driver1 reportando sobre uno de driver2

            expect(res.status).toBe(201);
            expect(res.body.results).toEqual([{ dispatchId: otherDriversDispatch, outcome: 'failed', error: 'Dispatch not found.' }]);
        });

        it('un despacho inexistente → failed, mismo mensaje (no revela si existe o no)', async () => {
            const res = await report([point(999_999)]);
            expect(res.body.results).toEqual([{ dispatchId: 999_999, outcome: 'failed', error: 'Dispatch not found.' }]);
        });
    });

    // ── Reloj del dispositivo ────────────────────────────────────────────────────
    describe('recordedAt implausible', () => {
        it('en el futuro → failed, y no se guarda nada', async () => {
            const dispatchId = await freshDispatch(routeBatch1);

            const res = await report([point(dispatchId, { recordedAt: isoMinutesFromNow(10) })]);

            expect(res.body.results[0]).toMatchObject({ dispatchId, outcome: 'failed' });
            expect(res.body.results[0].error).toMatch(/future/i);
            const row = await lastLocation(dispatchId);
            expect(row.last_location_at).toBeNull();
        });
    });

    // ── Validación ───────────────────────────────────────────────────────────────
    describe('validación del cuerpo', () => {
        it('locations vacío → 400', async () => {
            const res = await report([]);
            expect(res.status).toBe(400);
        });

        it('falta locations → 400', async () => {
            const res = await request(app.getHttpServer()).post(url()).set(auth('driver1')).send({});
            expect(res.status).toBe(400);
        });

        it.each([
            ['dispatchId', { dispatchId: undefined }],
            ['dispatchId no entero', { dispatchId: 'x' }],
            ['latitude fuera de rango', { latitude: 999 }],
            ['longitude fuera de rango', { longitude: -999 }],
            ['recordedAt no es una fecha', { recordedAt: 'ayer' }],
        ])('%s → 400, nada se guarda', async (_label, over) => {
            const res = await report([{ ...point(1), ...over }]);
            expect(res.status).toBe(400);
        });
    });

    // ── Forma de la respuesta ────────────────────────────────────────────────────
    describe('varios puntos de distintos despachos en un mismo lote', () => {
        it('un resultado por punto, en el mismo orden en que se mandaron', async () => {
            const a = await freshDispatch(routeBatch1);
            const b = await freshDispatch(routeBatch1);

            const res = await report([point(b), point(a)]); // a propósito, b primero

            expect(res.body.results.map((r: any) => r.dispatchId)).toEqual([b, a]);
            expect(res.body.results.every((r: any) => r.outcome === 'applied')).toBe(true);
        });
    });
});
