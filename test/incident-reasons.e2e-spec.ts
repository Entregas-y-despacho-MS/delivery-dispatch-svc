// ES-24 (ST-24.1 + ST-24.3) — Catálogo de motivos de incidencia (RF-A32): alta con código único y
// flag de evidencia fotográfica, desactivación que preserva el histórico, y el consumo/persistencia
// offline por la app móvil del repartidor.
//
// Levanta el AppModule real contra una base de datos real (con la migración 004 ya aplicada) y pega
// por HTTP con supertest. Complementa a los specs unitarios (sin DB) de
// src/modules/catalog/incident-reasons/.
//
// Seguro de re-correr contra una base compartida: usuarios, motivos y despachos de prueba se crean
// con un prefijo único por corrida y se borran en afterAll. No depende de los 3 motivos sembrados.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Motivos de incidencia (e2e, RF-A32)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `IR-${run}`;
    let seq = 0;
    // `name` has its own unique index too (like delivery_zones' code+name), so every default body
    // needs a name as unique as its code — reusing a fixed name across created() calls was a 409.
    const nextCode = () => `${tag}-${++seq}`;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path = '') => `/${apiPrefix}/incident-reasons${path}`;
    const post = (body: object, role = 'coordinator') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);
    const put = (id: number, body: object, role = 'coordinator') => request(app.getHttpServer()).put(url(`/${id}`)).set(auth(role)).send(body);
    const get = (id: number, role = 'coordinator') => request(app.getHttpServer()).get(url(`/${id}`)).set(auth(role));
    const list = (qs = '', role = 'coordinator') => request(app.getHttpServer()).get(url(`?${qs}`)).set(auth(role));
    const listTag = (qs = '') => list(`search=${encodeURIComponent(tag)}&limit=100${qs ? '&' + qs : ''}`);
    const validBody = (extra: object = {}) => { const code = nextCode(); return { code, name: `Motivo ${code}`, requiresEvidence: true, ...extra }; };
    const created = async (extra: object = {}) => (await post(validBody(extra))).body as any;
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    const row = async (id: number) => (await dataSource.query(`SELECT * FROM incident_reasons WHERE incident_reason_id = $1`, [id]))[0];
    const countByCode = async (code: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM incident_reasons WHERE code = $1`, [code]))[0].c as number;

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
                [role_id, `E2E ${role}`, `e2e_ir_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_ir_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM dispatch_incidents WHERE incident_reason_id IN (SELECT incident_reason_id FROM incident_reasons WHERE code LIKE $1)`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`ir-${run}-%`]);
        await dataSource.query(`DELETE FROM incident_reasons WHERE code LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_ir_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: coordinador y supervisor administran; el repartidor solo lee', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });

        it('coordinator, supervisor y driver pueden listar y leer; admin no', async () => {
            const reason = await created();
            for (const role of ['coordinator', 'supervisor', 'driver']) {
                expect((await list('', role)).status, role).toBe(200);
                expect((await get(reason.id, role)).status, role).toBe(200);
            }
            expect((await list('', 'admin')).status).toBe(403);
            expect((await get(reason.id, 'admin')).status).toBe(403);
        });

        it('solo coordinator y supervisor crean/editan; admin y driver no, y no se modifica nada', async () => {
            const reason = await created();
            for (const role of ['admin', 'driver']) {
                expect((await post(validBody(), role)).status, `post ${role}`).toBe(403);
                expect((await put(reason.id, { active: false }, role)).status, `put ${role}`).toBe(403);
            }
            expect((await get(reason.id)).body.active).toBe(true);
        });

        it('permisos antes que validación: un body inválido de un rol sin permiso da 403, no 400', async () => {
            expect((await post({ requiresEvidence: 'nope' }, 'driver')).status).toBe(403);
        });

        it('root pasa cualquier chequeo de rol', async () => {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = 'root'`);
            await dataSource.query(`INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1,'E2E root',$2,$3,false)`, [role_id, `e2e_ir_root_${run}`, await hashPassword('E2eTest1234')]);
            const rootTok = (await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username: `e2e_ir_root_${run}`, password: 'E2eTest1234' })).body.accessToken;
            const res = await request(app.getHttpServer()).post(url()).set({ Authorization: `Bearer ${rootTok}` }).send(validBody());
            expect(res.status).toBe(201);
        });
    });

    // ── Escenario 1 ────────────────────────────────────────────────────────────
    describe('Escenario 1 — alta y parametrización de un motivo', () => {
        it('el ejemplo de la historia: código, nombre y requiere_fotografia:true → 201 y habilitado', async () => {
            const body = { code: `${tag}-CLI-AUS`, name: 'Cliente Ausente', requiresEvidence: true };
            const res = await post(body);

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ code: body.code, name: body.name, requiresEvidence: true, active: true });
            expect(Object.keys(res.body).sort()).toEqual(['active', 'code', 'createdAt', 'id', 'name', 'requiresEvidence']);
            expect(await row(res.body.id)).toMatchObject({
                code: body.code, name: body.name, requires_evidence: true, active: true, deleted_at: null,
            });
        });

        it('requiresEvidence: false también es válido (no toda incidencia necesita foto)', async () => {
            const res = await post(validBody({ requiresEvidence: false }));
            expect(res.body.requiresEvidence).toBe(false);
        });

        it('el código se recorta y se pasa a mayúsculas; el nombre solo se recorta', async () => {
            const code = nextCode();
            // El nombre incorpora el tag único de la corrida: un literal fijo ("Dirección incorrecta")
            // puede chocar con basura de una corrida anterior en una base compartida (uq_incident_reasons_name).
            const name = `${tag} Dirección incorrecta`;
            const res = await post({ code: `  ${code.toLowerCase()}  `, name: `  ${name}  `, requiresEvidence: false });
            expect(res.body).toMatchObject({ code, name });
        });

        it('queda disponible de inmediato: aparece por id y en el listado', async () => {
            const reason = await created();
            expect((await get(reason.id)).status).toBe(200);
            expect(ids(await listTag())).toContain(reason.id);
        });

        it('no se puede elegir el estado ni el id al crear (campos extra) → 400', async () => {
            expect((await post(validBody({ active: false }))).status).toBe(400);
            expect((await post(validBody({ id: 99 }))).status).toBe(400);
        });
    });

    // ── Escenario 2 ────────────────────────────────────────────────────────────
    describe('Escenario 2 — desactivación preserva el histórico', () => {
        it('un motivo en desuso: desactivarlo lo saca del listado activo pero el histórico sigue intacto', async () => {
            const reason = await created();
            const [{ dispatch_id }] = await dataSource.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address) VALUES (1,3,$1,'Av. Test 1') RETURNING dispatch_id`,
                [`ir-${run}-${reason.id}`],
            );
            const [{ dispatch_incident_id }] = await dataSource.query(
                `INSERT INTO dispatch_incidents (dispatch_incident_id, dispatch_id, incident_reason_id, description) VALUES (gen_random_uuid(), $1, $2, 'Nadie atendió') RETURNING dispatch_incident_id`,
                [dispatch_id, reason.id],
            );

            const put1 = await put(reason.id, { active: false });
            expect(put1.body.active).toBe(false);

            // deja de ofrecerse para incidencias nuevas...
            expect((await list('active=true')).body.data.map((r: any) => r.id)).not.toContain(reason.id);
            // ...pero el incidente histórico sigue apuntando exactamente al mismo motivo, intacto.
            const [incident] = await dataSource.query(`SELECT incident_reason_id FROM dispatch_incidents WHERE dispatch_incident_id = $1`, [dispatch_incident_id]);
            expect(incident.incident_reason_id).toBe(reason.id);
            expect(await row(reason.id)).toMatchObject({ deleted_at: null, active: false });

            // y se puede reactivar
            expect((await put(reason.id, { active: true })).body.active).toBe(true);
        });

        it('no hay endpoint de borrado para este catálogo (la salida es desactivar)', async () => {
            const reason = await created();
            const res = await request(app.getHttpServer()).delete(url(`/${reason.id}`)).set(auth('coordinator'));
            expect(res.status).toBe(404); // la ruta no existe
        });
    });

    // ── Escenario 3 ────────────────────────────────────────────────────────────
    describe('Escenario 3 — control de unicidad de código', () => {
        it('409 INCIDENT_REASON_CODE_ALREADY_EXISTS con el mismo código, también con espacios y otra capitalización', async () => {
            const first = await created();
            for (const code of [first.code, `  ${first.code}  `, first.code.toLowerCase()]) {
                const res = await post(validBody({ code }));
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('INCIDENT_REASON_CODE_ALREADY_EXISTS');
            }
            expect(await countByCode(first.code)).toBe(1);
        });

        it('altas simultáneas con el mismo código: exactamente una gana, el resto 409, ningún 500', async () => {
            const body = validBody();
            const statuses = (await Promise.all(Array.from({ length: 6 }, () => post(body)))).map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            expect(await countByCode(body.code)).toBe(1);
        });

        it('el mismo formulario propio (sin cambiar el código) no da 409 al editar otro campo', async () => {
            const reason = await created();
            expect((await put(reason.id, { code: reason.code, name: 'Renombrado' })).status).toBe(200);
        });

        it('el código de otro motivo tampoco se puede tomar al editar', async () => {
            const a = await created();
            const b = await created();
            const res = await put(b.id, { code: a.code });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('INCIDENT_REASON_CODE_ALREADY_EXISTS');
        });
    });

    // ── Validación de campos ───────────────────────────────────────────────────
    describe('validación', () => {
        it('code, name y requiresEvidence son obligatorios', async () => {
            for (const field of ['code', 'name', 'requiresEvidence']) {
                const body: Record<string, unknown> = validBody();
                delete body[field];
                const res = await post(body);
                expect(res.status, field).toBe(400);
                if (field === 'code') expect(await countByCode(body.code as string)).toBe(0);
            }
        });

        it('code y name vacíos o de solo espacios se rechazan', async () => {
            for (const value of ['', '   ']) {
                expect((await post(validBody({ code: value }))).status).toBe(400);
                expect((await post(validBody({ name: value }))).status).toBe(400);
            }
        });

        it('code sobre 30 caracteres y name sobre 150 se rechazan', async () => {
            expect((await post(validBody({ code: 'A'.repeat(31) }))).status).toBe(400);
            expect((await post(validBody({ name: 'A'.repeat(151) }))).status).toBe(400);
        });

        it('requiresEvidence debe ser un booleano real, no la cadena "true"', async () => {
            expect((await post(validBody({ requiresEvidence: 'true' }))).status).toBe(400);
        });

        it('editar: null se rechaza en todos los campos (ninguno es nullable)', async () => {
            const reason = await created();
            for (const field of ['code', 'name', 'requiresEvidence', 'active']) {
                expect((await put(reason.id, { [field]: null })).status, field).toBe(400);
            }
            expect(await row(reason.id)).toMatchObject({ code: reason.code, name: reason.name });
        });

        it('un cambio válido junto con uno inválido no se aplica a medias', async () => {
            const reason = await created();
            expect((await put(reason.id, { name: 'NO debe guardarse', requiresEvidence: 'nope' }))).toMatchObject({ status: 400 });
            expect((await row(reason.id)).name).toBe(reason.name);
        });

        it('un PUT vacío no cambia nada', async () => {
            const reason = await created();
            const res = await put(reason.id, {});
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ code: reason.code, name: reason.name });
        });
    });

    // ── Listado: filtros, orden y paginación (consumo offline) ────────────────
    describe('listado — filtros, orden y paginación', () => {
        it('search por nombre y por código, sin distinguir mayúsculas', async () => {
            const reason = await created({ name: `${tag} Paquete mojado` });
            for (const term of ['paquete', 'PAQUETE', reason.code.toLowerCase()]) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(reason.id);
            }
        });

        it('los comodines % y _ se buscan literalmente', async () => {
            const pct = await created({ name: `${tag} Desc 50% off` });
            await created({ name: `${tag} Desc 500 off` });
            expect(ids(await list(`search=${encodeURIComponent(`${tag} Desc 50%`)}&limit=100`))).toEqual([pct.id]);
        });

        it('active y requiresEvidence filtran y se combinan entre sí', async () => {
            const t = `${tag} Filtro`;
            const on  = await created({ name: `${t} on`, requiresEvidence: true });
            const off = await created({ name: `${t} off`, requiresEvidence: false });
            await put(off.id, { active: false });

            expect(ids(await list(`search=${encodeURIComponent(t)}&active=true&limit=100`))).toEqual([on.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&active=false&limit=100`))).toEqual([off.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&requiresEvidence=true&limit=100`))).toEqual([on.id]);
            expect((await list(`search=${encodeURIComponent(t)}&limit=100`)).body.data.map((r: any) => r.id).sort()).toEqual([on.id, off.id].sort());
        });

        it('un active vacío (?active=) no filtra y no rompe (antes daba 500 en otros catálogos)', async () => {
            const on  = await created();
            const off = await created();
            await put(off.id, { active: false });

            const res = await listTag('active=');

            expect(res.status).toBe(200);
            expect(ids(res)).toEqual(expect.arrayContaining([on.id, off.id]));
        });

        it('sin coincidencias → data vacía, total 0, 0 páginas', async () => {
            expect((await list(`search=${encodeURIComponent('zzz-no-existe-' + run)}`)).body).toMatchObject({ data: [], meta: { total: 0, pages: 0 } });
        });

        it('ordena por nombre por defecto; sortBy=code y sortOrder=desc también funcionan', async () => {
            const t = `${tag} Orden`;
            const b = await created({ name: `${t} B`, code: `${tag}-ORD-B` });
            const a = await created({ name: `${t} A`, code: `${tag}-ORD-A` });
            expect(ids(await list(`search=${encodeURIComponent(t)}&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=code&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=name&sortOrder=desc&limit=100`))).toEqual([b.id, a.id]);
        });

        it('la paginación recorre todo sin repetir ni saltar filas', async () => {
            const t = `${tag} Pag`;
            for (let i = 0; i < 12; i++) await created({ name: `${t} ${String(i).padStart(2, '0')}` });
            const seen: number[] = [];
            for (const page of [1, 2, 3, 4]) seen.push(...ids(await list(`search=${encodeURIComponent(t)}&limit=5&page=${page}`)));

            expect(seen).toHaveLength(12);
            expect(new Set(seen).size).toBe(12);
            expect(seen).toEqual(ids(await list(`search=${encodeURIComponent(t)}&limit=100`)));
        });

        it('parámetros inválidos → 400', async () => {
            for (const qs of ['limit=101', 'limit=0', 'page=0', 'active=maybe', 'requiresEvidence=maybe', `search=${'a'.repeat(101)}`, 'foo=bar', 'sortBy=active']) {
                expect((await list(qs)).status, qs).toBe(400);
            }
        });

        it('entradas raras en search no rompen nada', async () => {
            for (const term of ["' OR 1=1 --", '\\', '%%%%', 'ñandú', '   ']) {
                expect((await list(term ? `search=${encodeURIComponent(term)}` : '')).status, term).toBe(200);
            }
        });
    });

    // ── Consumo/persistencia offline (ST-24.3) ─────────────────────────────────
    describe('consumo y persistencia offline — lo que el repartidor descarga y cachea', () => {
        it('el repartidor puede bajar el catálogo completo habilitado con una sola llamada (active=true&limit=100)', async () => {
            const t = `${tag} Offline`;
            for (let i = 0; i < 5; i++) await created({ name: `${t} ${i}` });
            const off = await created({ name: `${t} deshabilitado` });
            await put(off.id, { active: false });

            const res = await list(`search=${encodeURIComponent(t)}&active=true&limit=100`, 'driver');

            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(5);
            expect(res.body.data.map((r: any) => r.id)).not.toContain(off.id);
        });

        it('la forma serializada es estable: tipos correctos para persistir en el dispositivo', async () => {
            const reason = await created();
            const res = await get(reason.id, 'driver');

            expect(typeof res.body.id).toBe('number');
            expect(typeof res.body.code).toBe('string');
            expect(typeof res.body.name).toBe('string');
            expect(typeof res.body.requiresEvidence).toBe('boolean');
            expect(typeof res.body.active).toBe('boolean');
            expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt); // ISO 8601 real, no un objeto ni un timestamp numérico
            expect(res.body.deletedAt).toBeUndefined(); // nunca se filtra un campo interno del servidor
        });

        it('dos descargas seguidas del mismo motivo son idénticas (para que el dispositivo pueda comparar sin falsos cambios)', async () => {
            const reason = await created();
            const first  = await get(reason.id, 'driver');
            const second = await get(reason.id, 'driver');
            expect(first.body).toEqual(second.body);
        });
    });
});
