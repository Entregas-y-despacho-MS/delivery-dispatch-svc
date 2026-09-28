// ES-26 (ST-26.1) — Catálogo de tipos de incidente vehicular (RF-A34): alta con código, severidad
// obligatoria y el flag disablesVehicle, prevención de duplicidad, y las validaciones de integridad
// del catálogo. El trigger de transición de estado del vehículo (Escenario 2) se cubre en
// test/vehicle-maintenances.e2e-spec.ts, que es donde en realidad se dispara.
//
// Levanta el AppModule real contra una base de datos real (con la migración 007 ya aplicada) y pega
// por HTTP con supertest. Complementa a los specs unitarios (sin DB) de
// src/modules/fleet/vehicle-incident-types/.
//
// Seguro de re-correr contra una base compartida: usuarios y tipos de prueba se crean con un
// prefijo único por corrida y se borran en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Catálogo de tipos de incidente vehicular (e2e, RF-A34)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `VIT-${run}`;
    let seq = 0;
    const nextName = () => `${tag} ${++seq}`;
    const nextCode = () => `${tag}-C${++seq}`.replace(/[^A-Z0-9-]/gi, '');

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path = '') => `/${apiPrefix}/vehicle-incident-types${path}`;
    const post = (body: object, role = 'supervisor') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);
    const put = (id: number, body: object, role = 'supervisor') => request(app.getHttpServer()).put(url(`/${id}`)).set(auth(role)).send(body);
    const get = (id: number, role = 'supervisor') => request(app.getHttpServer()).get(url(`/${id}`)).set(auth(role));
    const list = (qs = '', role = 'supervisor') => request(app.getHttpServer()).get(url(`?${qs}`)).set(auth(role));
    const listTag = (qs = '') => list(`search=${encodeURIComponent(tag)}&limit=100${qs ? '&' + qs : ''}`);
    const validBody = (extra: object = {}) => ({ code: nextCode(), name: nextName(), severity: 'critical', disablesVehicle: true, ...extra });
    const created = async (extra: object = {}) => (await post(validBody(extra))).body as any;
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    const row = async (id: number) => (await dataSource.query(`SELECT * FROM vehicle_incident_types WHERE vehicle_incident_type_id = $1`, [id]))[0];
    const countByName = async (name: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM vehicle_incident_types WHERE name = $1`, [name]))[0].c as number;
    const countByCode = async (code: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM vehicle_incident_types WHERE code = $1`, [code]))[0].c as number;

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
        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['supervisor', 'coordinator', 'admin', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `E2E ${role}`, `e2e_vit_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_vit_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM vehicle_incident_types WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_vit_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: supervisor y coordinador administran; admin y driver no entran', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });

        it('supervisor y coordinator pueden listar, leer, crear y editar', async () => {
            for (const role of ['supervisor', 'coordinator']) {
                const type = await created();
                expect((await list('', role)).status, role).toBe(200);
                expect((await get(type.id, role)).status, role).toBe(200);
                expect((await post(validBody(), role)).status, role).toBe(201);
                expect((await put(type.id, { disablesVehicle: false }, role)).status, role).toBe(200);
            }
        });

        it('admin y driver no pueden ni leer ni escribir, y no se modifica nada', async () => {
            const type = await created();
            for (const role of ['admin', 'driver']) {
                expect((await list('', role)).status, `list ${role}`).toBe(403);
                expect((await get(type.id, role)).status, `get ${role}`).toBe(403);
                expect((await post(validBody(), role)).status, `post ${role}`).toBe(403);
                expect((await put(type.id, { disablesVehicle: false }, role)).status, `put ${role}`).toBe(403);
            }
            expect((await get(type.id)).body.disablesVehicle).toBe(true);
        });
    });

    // ── Escenario 1 ────────────────────────────────────────────────────────────
    describe('Escenario 1 — alta de tipo de incidente vehicular', () => {
        it('el ejemplo de la historia: MEC-FRE-01, "Falla en sistema de frenos", crítica, disablesVehicle → 201', async () => {
            const body = { code: nextCode(), name: `${tag} Falla en sistema de frenos`, severity: 'critical', disablesVehicle: true };
            const res = await post(body);

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject(body);
            expect(Object.keys(res.body).sort()).toEqual(['code', 'createdAt', 'disablesVehicle', 'id', 'name', 'severity']);
            expect(await row(res.body.id)).toMatchObject({
                code: body.code, name: body.name, severity: 'critical', disables_vehicle: true, deleted_at: null,
            });
        });

        it('código y nombre se recortan y pasan por su normalización (code a mayúsculas)', async () => {
            const code = nextCode();
            const name = nextName();
            const res = await post({ code: `  ${code.toLowerCase()}  `, name: `  ${name}  `, severity: 'moderate', disablesVehicle: false });
            expect(res.body).toMatchObject({ code, name });
        });

        it('queda disponible de inmediato: aparece por id y en el listado', async () => {
            const type = await created();
            expect((await get(type.id)).status).toBe(200);
            expect(ids(await listTag())).toContain(type.id);
        });

        it('no se puede elegir el id al crear (campo extra) → 400', async () => {
            expect((await post(validBody({ id: 99 }))).status).toBe(400);
        });
    });

    // ── Escenario 3 ────────────────────────────────────────────────────────────
    describe('Escenario 3 — validación de severidad obligatoria', () => {
        it('sin severidad → 400 exigiendo la clasificación, nada se guarda', async () => {
            const body: Record<string, unknown> = validBody();
            delete body.severity;
            const res = await post(body);
            expect(res.status).toBe(400);
            expect(await countByName(body.name as string)).toBe(0);
        });

        it('una severidad fuera de las 3 válidas se rechaza (sin mayúsculas, sin el español) y no se guarda nada', async () => {
            for (const severity of ['CRITICAL', 'Moderate', 'leve', 'crítica', 'ninguna', '']) {
                const body = validBody({ severity });
                const res = await post(body);
                expect(res.status, severity).toBe(400);
                expect(await countByName(body.name)).toBe(0);
            }
        });

        it('el catálogo acepta y persiste exactamente las 3 severidades', async () => {
            for (const severity of ['minor', 'moderate', 'critical']) {
                const res = await created({ severity });
                expect(res.severity).toBe(severity);
                expect((await row(res.id)).severity).toBe(severity);
            }
        });

        it('disablesVehicle también es obligatorio → 400 si falta', async () => {
            const body: Record<string, unknown> = validBody();
            delete body.disablesVehicle;
            expect((await post(body)).status).toBe(400);
        });
    });

    // ── Prevención de duplicidad ─────────────────────────────────────────────────
    describe('prevención de duplicidad (nombre o código)', () => {
        it('409 con el mismo nombre o el mismo código', async () => {
            const first = await created();
            expect((await post(validBody({ name: first.name }))).status).toBe(409);
            expect((await post(validBody({ code: first.code }))).status).toBe(409);
            expect(await countByCode(first.code)).toBe(1);
        });

        it('altas simultáneas con el mismo código: exactamente una gana, el resto 409, ningún 500', async () => {
            const code = nextCode();
            const bodies = Array.from({ length: 6 }, () => ({ ...validBody(), code }));
            const statuses = (await Promise.all(bodies.map((b) => post(b)))).map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            expect(await countByCode(code)).toBe(1);
        });

        it('renombrar/recodificar a uno de otro tipo también da 409', async () => {
            const a = await created();
            const b = await created();
            expect((await put(b.id, { name: a.name })).status).toBe(409);
            expect((await put(b.id, { code: a.code })).status).toBe(409);
        });
    });

    // ── Validación general ───────────────────────────────────────────────────────
    describe('validación', () => {
        it('editar: null se rechaza en todos los campos', async () => {
            const type = await created();
            for (const field of ['code', 'name', 'severity', 'disablesVehicle']) {
                expect((await put(type.id, { [field]: null })).status, field).toBe(400);
            }
        });

        it('un PUT vacío no cambia nada', async () => {
            const type = await created();
            const res = await put(type.id, {});
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ name: type.name, code: type.code });
        });

        it('no hay endpoint DELETE para este catálogo', async () => {
            const type = await created();
            const res = await request(app.getHttpServer()).delete(url(`/${type.id}`)).set(auth('supervisor'));
            expect(res.status).toBe(404);
        });
    });

    // ── Listado ───────────────────────────────────────────────────────────────────
    describe('listado — filtros, orden y búsqueda', () => {
        it('search por código o por nombre, sin distinguir mayúsculas', async () => {
            const type = await created({ name: `${tag} Falla eléctrica` });
            for (const term of ['eléctrica', 'ELÉCTRICA', type.code.toLowerCase()]) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(type.id);
            }
        });

        it('severity y disablesVehicle filtran y se combinan entre sí', async () => {
            const t = `${tag} Filtro`;
            const on  = await created({ name: `${t} on`, severity: 'critical', disablesVehicle: true });
            const off = await created({ name: `${t} off`, severity: 'minor', disablesVehicle: false });

            expect(ids(await list(`search=${encodeURIComponent(t)}&severity=critical&limit=100`))).toEqual([on.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&disablesVehicle=false&limit=100`))).toEqual([off.id]);
        });

        it('ordena por nombre por defecto; sortBy=code y sortBy=severity también funcionan', async () => {
            const t = `${tag} Orden`;
            const b = await created({ name: `${t} B`, code: `${t}-B`, severity: 'moderate' });
            const a = await created({ name: `${t} A`, code: `${t}-A`, severity: 'critical' });
            expect(ids(await list(`search=${encodeURIComponent(t)}&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=code&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=name&sortOrder=desc&limit=100`))).toEqual([b.id, a.id]);
        });

        it('parámetros inválidos → 400', async () => {
            for (const qs of ['limit=101', 'severity=otra', 'disablesVehicle=maybe', 'foo=bar', 'sortBy=disablesVehicle']) {
                expect((await list(qs)).status, qs).toBe(400);
            }
        });

        it('un id inválido → 400; uno inexistente → 404', async () => {
            for (const id of ['abc', '0', '-1']) {
                expect((await request(app.getHttpServer()).get(url(`/${id}`)).set(auth('supervisor'))).status, id).toBe(400);
            }
            const missing = await get(99999999);
            expect([missing.status, missing.body.error]).toEqual([404, 'VEHICLE_INCIDENT_TYPE_NOT_FOUND']);
        });
    });
});
