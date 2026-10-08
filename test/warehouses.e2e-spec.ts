// Corrección de ES-26/ST-26.1 — catálogo de solo lectura de almacenes. No hay endpoint de alta: los
// datos de prueba se insertan directo por SQL (como los usuarios de prueba de los demás e2e),
// reflejando que en producción esta tabla se siembra por migración, no por API.
//
// Levanta el AppModule real contra una base de datos real (con la migración 008 ya aplicada) y pega
// por HTTP con supertest. Complementa al spec unitario (sin DB) de
// src/modules/catalog/warehouses/.
//
// Seguro de re-correr contra una base compartida: almacenes y usuarios de prueba se crean con un
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

describe('Almacenes (e2e, corrección de ES-26/ST-26.1)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `WH-${run}`;
    let seq = 0;
    const nextCode = () => `${tag}-${++seq}`.replace(/[^A-Z0-9-]/gi, '').slice(0, 30);

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path = '') => `/${apiPrefix}/warehouses${path}`;
    const get = (id: number, role = 'coordinator') => request(app.getHttpServer()).get(url(`/${id}`)).set(auth(role));
    const list = (qs = '', role = 'coordinator') => request(app.getHttpServer()).get(url(`?${qs}`)).set(auth(role));
    const listTag = (qs = '') => list(`search=${encodeURIComponent(tag)}&limit=100${qs ? '&' + qs : ''}`);
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    const insert = async (over: Partial<Record<string, unknown>> = {}): Promise<number> => {
        const row = {
            code: nextCode(), name: `${tag} Almacén ${seq}`, address: 'Dirección de prueba',
            latitude: -16.5, longitude: -68.15, contact_name: null, contact_phone: null,
            reception_start_time: '08:00', reception_end_time: '18:00', active: true,
            ...over,
        };
        const [{ warehouse_id }] = await dataSource.query(
            `INSERT INTO warehouses (code, name, address, latitude, longitude, contact_name, contact_phone, reception_start_time, reception_end_time, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING warehouse_id`,
            [row.code, row.name, row.address, row.latitude, row.longitude, row.contact_name, row.contact_phone, row.reception_start_time, row.reception_end_time, row.active],
        );
        return warehouse_id as number;
    };

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
        for (const role of ['coordinator', 'supervisor', 'admin', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `E2E ${role}`, `e2e_wh_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_wh_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM warehouses WHERE code LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_wh_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: coordinador y supervisor leen; admin y driver no entran', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });

        it('coordinator y supervisor pueden listar y leer', async () => {
            const id = await insert();
            for (const role of ['coordinator', 'supervisor']) {
                expect((await list('', role)).status, role).toBe(200);
                expect((await get(id, role)).status, role).toBe(200);
            }
        });

        it('admin y driver no pueden leer', async () => {
            const id = await insert();
            for (const role of ['admin', 'driver']) {
                expect((await list('', role)).status, `list ${role}`).toBe(403);
                expect((await get(id, role)).status, `get ${role}`).toBe(403);
            }
        });

        it('no hay endpoint de escritura para este catálogo', async () => {
            const res = await request(app.getHttpServer()).post(url()).set(auth('coordinator')).send({});
            expect(res.status).toBe(404);
        });
    });

    // ── Lectura ────────────────────────────────────────────────────────────────
    describe('lectura', () => {
        it('devuelve el almacén con todos los campos esperados', async () => {
            const id = await insert({ contact_name: 'Operaciones', contact_phone: '+591 2 1234567' });
            const res = await get(id);

            expect(res.status).toBe(200);
            expect(Object.keys(res.body).sort()).toEqual([
                'active', 'address', 'code', 'contactName', 'contactPhone', 'id', 'latitude',
                'longitude', 'name', 'receptionEndTime', 'receptionStartTime',
            ].sort());
            expect(res.body).toMatchObject({
                contactName: 'Operaciones', contactPhone: '+591 2 1234567',
                receptionStartTime: '08:00:00', receptionEndTime: '18:00:00', active: true,
            });
            expect(typeof res.body.latitude).toBe('number');
            expect(typeof res.body.longitude).toBe('number');
        });

        it('contact_name/contact_phone null se devuelven como null', async () => {
            const id = await insert({ contact_name: null, contact_phone: null });
            const res = await get(id);
            expect(res.body.contactName).toBeNull();
            expect(res.body.contactPhone).toBeNull();
        });

        it('un id inválido (no numérico, 0, negativo) → 400; uno inexistente → 404', async () => {
            for (const id of ['abc', '0', '-1']) {
                expect((await request(app.getHttpServer()).get(url(`/${id}`)).set(auth('coordinator'))).status, id).toBe(400);
            }
            const missing = await get(99999999);
            expect([missing.status, missing.body.error]).toEqual([404, 'WAREHOUSE_NOT_FOUND']);
        });
    });

    // ── Listado: filtros, orden y paginación ────────────────────────────────────
    describe('listado — filtros, orden y paginación', () => {
        it('search por código y por nombre, sin distinguir mayúsculas', async () => {
            const id = await insert({ name: `${tag} Depósito Central` });
            for (const term of ['depósito', 'DEPÓSITO', tag.toLowerCase()]) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(id);
            }
        });

        it('active filtra y se combina con search', async () => {
            const t = `${tag} Filtro`;
            const on  = await insert({ name: `${t} on` });
            const off = await insert({ name: `${t} off`, active: false });

            expect(ids(await list(`search=${encodeURIComponent(t)}&active=true&limit=100`))).toEqual([on]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&active=false&limit=100`))).toEqual([off]);
        });

        it('la búsqueda no se salta el filtro active en ninguna rama del OR (código o nombre)', async () => {
            const t = `${tag} NoSaltar`;
            const byCode = await insert({ code: `${t}CODE`.replace(/[^A-Z0-9-]/gi, '').slice(0, 30), name: `${tag} otro ${++seq}`, active: false });
            const byName = await insert({ name: `${t} activo` });

            const enabledOnly = ids(await list(`search=${encodeURIComponent(t)}&active=true&limit=100`));
            expect(enabledOnly).toContain(byName);
            expect(enabledOnly).not.toContain(byCode);
        });

        it('un active vacío (?active=) no filtra', async () => {
            const on  = await insert();
            const off = await insert({ active: false });
            const res = await listTag('active=');
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual(expect.arrayContaining([on, off]));
        });

        it('ordena por nombre por defecto; sortBy=code y sortOrder=desc también funcionan', async () => {
            const t = `${tag} Orden`;
            const b = await insert({ name: `${t} B`, code: `${t}-B`.replace(/[^A-Z0-9-]/gi, '').slice(0, 30) });
            const a = await insert({ name: `${t} A`, code: `${t}-A`.replace(/[^A-Z0-9-]/gi, '').slice(0, 30) });
            expect(ids(await list(`search=${encodeURIComponent(t)}&limit=100`))).toEqual([a, b]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=code&limit=100`))).toEqual([a, b]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=name&sortOrder=desc&limit=100`))).toEqual([b, a]);
        });

        it('sin coincidencias → data vacía, total 0, 0 páginas', async () => {
            expect((await list(`search=${encodeURIComponent('zzz-no-existe-' + run)}`)).body).toMatchObject({ data: [], meta: { total: 0, pages: 0 } });
        });

        it('parámetros inválidos → 400', async () => {
            for (const qs of ['limit=101', 'limit=0', 'page=0', 'active=maybe', `search=${'a'.repeat(101)}`, 'foo=bar', 'sortBy=active']) {
                expect((await list(qs)).status, qs).toBe(400);
            }
        });
    });
});
