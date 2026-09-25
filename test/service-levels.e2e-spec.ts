// ST-23.3 — Pruebas de integración de niveles de servicio (RF-A31): jerarquía de prioridades,
// validación de tiempos objetivo (Escenario 2) y protección de niveles con despachos activos
// (Escenario 3).
//
// Levanta el AppModule real contra una base de datos real (misma config que la app vía .env, con el
// schema y la migración 003 ya aplicados) y pega por HTTP con supertest. Complementa a los specs
// unitarios (sin DB) de src/modules/catalog/service-levels/ y de DispatchesService.
//
// Seguro de re-correr contra una base compartida: usuarios, niveles y despachos de prueba se crean
// con un prefijo único por corrida y se borran en afterAll. No depende de los datos de arranque.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Niveles de servicio (e2e, RF-A31)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const statusId: Record<string, number> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `SL-${run}`;
    let seq = 0;
    let orderSeq = 0;
    const nextName = (label = 'N') => `${tag} ${label}${++seq}`;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path = '') => `/${apiPrefix}/service-levels${path}`;
    const post = (body: object, role = 'coordinator') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);
    const put = (id: number, body: object, role = 'coordinator') => request(app.getHttpServer()).put(url(`/${id}`)).set(auth(role)).send(body);
    const del = (id: number, role = 'coordinator') => request(app.getHttpServer()).delete(url(`/${id}`)).set(auth(role));
    const get = (id: number, role = 'coordinator') => request(app.getHttpServer()).get(url(`/${id}`)).set(auth(role));
    const list = (qs = '', role = 'coordinator') => request(app.getHttpServer()).get(url(`?${qs}`)).set(auth(role));
    const listTag = (qs = '') => list(`search=${encodeURIComponent(tag)}&limit=100${qs ? '&' + qs : ''}`);
    const validBody = (extra: object = {}) => ({ name: nextName(), description: 'Entrega prioritaria', targetTimeMin: 120, priorityLevel: 1, ...extra });
    const created = async (extra: object = {}) => (await post(validBody(extra))).body as any;
    const ids = (res: request.Response) => res.body.data.map((l: any) => l.id);

    const row = async (id: number) => (await dataSource.query(`SELECT * FROM service_levels WHERE service_level_id = $1`, [id]))[0];
    const countByName = async (name: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM service_levels WHERE name = $1`, [name]))[0].c as number;
    const dispatchFor = async (levelId: number, status: string) => {
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, service_level_id, source_order_ref, delivery_address)
             VALUES (1, $1, $2, $3, 'Av. Test 123') RETURNING dispatch_id`,
            [statusId[status], levelId, `sl-${run}-${++orderSeq}`],
        );
        return dispatch_id as number;
    };

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
        for (const role of ['coordinator', 'admin', 'supervisor', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change) VALUES ($1, $2, $3, $4, false)`,
                [role_id, `E2E ${role}`, `e2e_sl_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_sl_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
        for (const r of await dataSource.query(`SELECT dispatch_status_id, name FROM dispatch_statuses`)) statusId[r.name] = r.dispatch_status_id;
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`sl-${run}-%`]);
        await dataSource.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_sl_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: solo el coordinador', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });

        it('admin, supervisor y driver → 403 en los 5 endpoints, y no se modifica nada', async () => {
            const level = await created();
            for (const role of ['admin', 'supervisor', 'driver']) {
                expect((await list('', role)).status, `list ${role}`).toBe(403);
                expect((await get(level.id, role)).status, `get ${role}`).toBe(403);
                expect((await post(validBody(), role)).status, `post ${role}`).toBe(403);
                expect((await put(level.id, { active: false }, role)).status, `put ${role}`).toBe(403);
                expect((await del(level.id, role)).status, `delete ${role}`).toBe(403);
            }
            expect((await get(level.id)).body.active).toBe(true);
        });

        it('permisos antes que validación: un body inválido de un rol sin permiso da 403, no 400', async () => {
            expect((await post({ targetTimeMin: 1 }, 'driver')).status).toBe(403);
        });
    });

    // ── Escenario 1 ────────────────────────────────────────────────────────────
    describe('Escenario 1 — alta de un nivel de servicio', () => {
        it('el ejemplo de la historia: "Express 2 Horas", 120 min, prioridad alta → 201 y habilitado', async () => {
            const body = { name: `${tag} Express 2 Horas`, description: 'Entrega en 2 horas', targetTimeMin: 120, priorityLevel: 1 };
            const res = await post(body);

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ ...body, active: true });
            expect(Object.keys(res.body).sort()).toEqual(['active', 'createdAt', 'description', 'id', 'name', 'priorityLevel', 'targetTimeMin']);
            expect(await row(res.body.id)).toMatchObject({
                name: body.name, description: body.description, target_time_min: 120, priority_level: 1, active: true, deleted_at: null,
            });
        });

        it('descripción opcional: omitida o vacía queda null; el nombre y la descripción se recortan', async () => {
            const omitted = await post({ name: nextName(), targetTimeMin: 60, priorityLevel: 3 });
            expect(omitted.body.description).toBeNull();
            const blank = await post(validBody({ description: '   ' }));
            expect(blank.body.description).toBeNull();
            const trimmed = await post({ name: `  ${tag} Recortado  `, description: '  hola  ', targetTimeMin: 60, priorityLevel: 2 });
            expect(trimmed.body).toMatchObject({ name: `${tag} Recortado`, description: 'hola' });
        });

        it('queda disponible de inmediato: aparece por id y en el listado', async () => {
            const level = await created();
            expect((await get(level.id)).status).toBe(200);
            expect(ids(await listTag())).toContain(level.id);
        });

        it('acepta los valores límite: 15 y 43200 minutos, prioridad 1 y 32767', async () => {
            expect((await post(validBody({ targetTimeMin: 15, priorityLevel: 1 }))).status).toBe(201);
            const max = await post(validBody({ targetTimeMin: 43200, priorityLevel: 32767 }));
            expect(max.status).toBe(201);
            expect(max.body).toMatchObject({ targetTimeMin: 43200, priorityLevel: 32767 });
        });

        it('no se puede elegir el estado ni el id al crear (campos extra) → 400', async () => {
            expect((await post(validBody({ active: false }))).status).toBe(400);
            expect((await post(validBody({ id: 99 }))).status).toBe(400);
        });
    });

    // ── Escenario 2 ────────────────────────────────────────────────────────────
    describe('Escenario 2 — tiempos objetivo inválidos → 400 y no se crea el registro', () => {
        const BAD: [label: string, value: unknown][] = [
            ['14 minutos (justo bajo el mínimo)', 14], ['cero', 0], ['negativo', -5], ['14.9', 14.9], ['15.5 (no entero)', 15.5],
            ['texto numérico', '120'], ['texto', 'abc'], ['null', null], ['booleano', true], ['array', []], ['objeto', {}],
            ['sobre el máximo (43201)', 43201], ['muy grande', 1e9],
        ];
        for (const [label, value] of BAD) {
            it(`targetTimeMin = ${label}`, async () => {
                const body = validBody({ targetTimeMin: value });
                const res = await post(body);

                expect(res.status).toBe(400);
                expect(res.body.message.join(' ')).toContain('Target time');
                expect(await countByName(body.name)).toBe(0);
            });
        }

        it('targetTimeMin faltante', async () => {
            const body: Record<string, unknown> = validBody();
            delete body.targetTimeMin;
            expect((await post(body)).status).toBe(400);
            expect(await countByName(body.name as string)).toBe(0);
        });

        it('el mensaje nombra el mínimo de 15 minutos', async () => {
            expect((await post(validBody({ targetTimeMin: 10 }))).body.message).toContain('Target time must be at least 15 minutes.');
        });

        it('prioridad inválida (0, negativa, decimal, texto, null, fuera de rango, faltante) no crea nada', async () => {
            for (const value of [0, -1, 1.5, '1', null, 32768, 1e9]) {
                const body = validBody({ priorityLevel: value });
                expect((await post(body)).status, String(value)).toBe(400);
                expect(await countByName(body.name)).toBe(0);
            }
            const body: Record<string, unknown> = validBody();
            delete body.priorityLevel;
            expect((await post(body)).status).toBe(400);
        });

        it('nombre y descripción inválidos', async () => {
            expect((await post(validBody({ name: '' }))).status).toBe(400);
            expect((await post(validBody({ name: '     ' }))).status).toBe(400);
            expect((await post(validBody({ name: 'N'.repeat(51) }))).status).toBe(400);
            expect((await post(validBody({ description: 'D'.repeat(256) }))).status).toBe(400);
            expect((await post(validBody({ description: 123 }))).status).toBe(400);
        });
    });

    // ── Unicidad del nombre ────────────────────────────────────────────────────
    describe('nombre único', () => {
        it('409 SERVICE_LEVEL_NAME_ALREADY_EXISTS con el mismo nombre, también con espacios alrededor', async () => {
            const first = await created();
            for (const name of [first.name, `  ${first.name}  `]) {
                const res = await post(validBody({ name }));
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('SERVICE_LEVEL_NAME_ALREADY_EXISTS');
            }
            expect(await countByName(first.name)).toBe(1);
        });

        it('altas simultáneas con el mismo nombre: exactamente una gana, el resto 409, ningún 500', async () => {
            const body = validBody();
            const statuses = (await Promise.all(Array.from({ length: 6 }, () => post(body)))).map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            expect(await countByName(body.name)).toBe(1);
        });

        it('tras dar de baja un nivel, su nombre se puede reutilizar', async () => {
            const first = await created();
            expect((await del(first.id)).status).toBe(204);
            const again = await post(validBody({ name: first.name }));
            expect(again.status).toBe(201);
            expect(again.body.id).not.toBe(first.id);
        });
    });

    // ── Jerarquía / ordenamiento ───────────────────────────────────────────────
    describe('jerarquía de prioridades: orden del listado', () => {
        it('ordena por prioridad (1 primero), luego por tiempo objetivo, luego por id, incluso con empates', async () => {
            const t = `${tag} Orden`;
            const defs = [{ p: 3, t: 200 }, { p: 1, t: 120 }, { p: 2, t: 60 }, { p: 1, t: 90 }, { p: 2, t: 60 }, { p: 1, t: 90 }, { p: 5, t: 15 }];
            const made: any[] = [];
            for (const d of defs) made.push(await created({ name: `${t} ${made.length}`, priorityLevel: d.p, targetTimeMin: d.t }));
            const expected = [...made]
                .sort((a, b) => a.priorityLevel - b.priorityLevel || a.targetTimeMin - b.targetTimeMin || a.id - b.id)
                .map((l) => l.id);

            expect(ids(await list(`search=${encodeURIComponent(t)}&limit=100`))).toEqual(expected);
        });

        it('cambiar la prioridad con PUT reordena el listado', async () => {
            const t = `${tag} Reorden`;
            const a = await created({ name: `${t} A`, priorityLevel: 1 });
            const b = await created({ name: `${t} B`, priorityLevel: 2 });
            const order = async () => ids(await list(`search=${encodeURIComponent(t)}&limit=100`));
            expect(await order()).toEqual([a.id, b.id]);

            await put(b.id, { priorityLevel: 1, targetTimeMin: 15 });
            await put(a.id, { priorityLevel: 4 });

            expect(await order()).toEqual([b.id, a.id]);
        });

        it('la paginación recorre todo sin repetir ni saltar filas (con empates de prioridad)', async () => {
            const t = `${tag} Pag`;
            for (let i = 0; i < 12; i++) {
                await created({ name: `${t} ${String(i).padStart(2, '0')}`, priorityLevel: (i % 3) + 1, targetTimeMin: 30 + (i % 2) * 30 });
            }
            const seen: number[] = [];
            for (const page of [1, 2, 3, 4]) seen.push(...ids(await list(`search=${encodeURIComponent(t)}&limit=5&page=${page}`)));

            expect(seen).toHaveLength(12);
            expect(new Set(seen).size).toBe(12);
            expect(seen).toEqual(ids(await list(`search=${encodeURIComponent(t)}&limit=100`)));
        });
    });

    // ── Listado: filtros y búsqueda ────────────────────────────────────────────
    describe('listado — filtros y búsqueda', () => {
        it('search por nombre y por descripción, sin distinguir mayúsculas', async () => {
            const level = await created({ name: `${tag} Nocturno`, description: 'Reparto de madrugada' });
            for (const term of ['nocturno', 'NOCTURNO', 'madrugada', 'MADRUG']) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(level.id);
            }
        });

        it('los comodines % y _ se buscan literalmente', async () => {
            const pct = await created({ name: `${tag} Desc 50% off` });
            await created({ name: `${tag} Desc 500 off` });
            const und = await created({ name: `${tag} Desc a_b` });
            await created({ name: `${tag} Desc axb` });

            expect(ids(await list(`search=${encodeURIComponent(`${tag} Desc 50%`)}`))).toEqual([pct.id]);
            expect(ids(await list(`search=${encodeURIComponent(`${tag} Desc a_b`)}`))).toEqual([und.id]);
        });

        it('active=true/false filtra, y la búsqueda no se salta ese filtro (ni por nombre ni por descripción)', async () => {
            const t = `${tag} Filtro`;
            // El texto buscado está en el NOMBRE del habilitado y solo en la DESCRIPCIÓN del deshabilitado:
            // así cada rama del OR (nombre / descripción) tiene algo que filtrar.
            const on  = await created({ name: `${t} on`, description: 'sin el texto' });
            const off = await created({ name: `${tag} otro nombre ${++seq}`, description: `descripción con ${t}` });
            await put(off.id, { active: false });
            const search = async (extra: string) => ids(await list(`search=${encodeURIComponent(t)}&limit=100&${extra}`));

            expect(await search('active=true')).toEqual([on.id]);
            expect(await search('active=false')).toEqual([off.id]);
            expect((await search('')).sort()).toEqual([on.id, off.id].sort());
        });

        it('un active vacío (?active=, típico de una opción "todos") no filtra y no rompe (antes daba 500)', async () => {
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

        it('parámetros inválidos → 400', async () => {
            for (const qs of ['limit=101', 'limit=0', 'page=0', 'active=maybe', `search=${'a'.repeat(101)}`, 'foo=bar', 'sortBy=name']) {
                expect((await list(qs)).status, qs).toBe(400);
            }
        });

        it('entradas raras en search no rompen nada (comillas, SQL, barra invertida, unicode)', async () => {
            for (const term of ["' OR 1=1 --", "'; DROP TABLE service_levels; --", '\\', '%%%%', 'ñandú', '   ']) {
                expect((await list(`search=${encodeURIComponent(term)}`)).status, term).toBe(200);
            }
            expect((await dataSource.query(`SELECT count(*)::int AS c FROM service_levels`))[0].c).toBeGreaterThan(0);
        });
    });

    // ── Edición ────────────────────────────────────────────────────────────────
    describe('actualización', () => {
        let level: any;
        beforeAll(async () => { level = await created({ name: `${tag} Upd`, description: 'orig', targetTimeMin: 100, priorityLevel: 4 }); });

        it('parcial: solo cambia lo enviado; PUT {} no cambia nada', async () => {
            const partial = await put(level.id, { targetTimeMin: 90 });
            expect(partial.body).toMatchObject({ name: `${tag} Upd`, description: 'orig', targetTimeMin: 90, priorityLevel: 4, active: true });
            const empty = await put(level.id, {});
            expect(empty.status).toBe(200);
            expect(empty.body.targetTimeMin).toBe(90);
        });

        it('un tiempo objetivo inválido al editar → 400 y el nivel queda intacto', async () => {
            for (const value of [14, 0, -1, 15.5, '60', 'abc', 43201, null]) {
                expect((await put(level.id, { targetTimeMin: value })).status, String(value)).toBe(400);
            }
            expect((await row(level.id)).target_time_min).toBe(90);
        });

        it('null en un campo obligatorio → 400 (no un 500 de la base)', async () => {
            for (const field of ['name', 'targetTimeMin', 'priorityLevel', 'active']) {
                expect((await put(level.id, { [field]: null })).status, field).toBe(400);
            }
            expect(await row(level.id)).toMatchObject({ name: `${tag} Upd`, target_time_min: 90, priority_level: 4, active: true });
        });

        it('un cambio válido junto con uno inválido no se aplica a medias', async () => {
            expect((await put(level.id, { name: `${tag} NO debe guardarse`, targetTimeMin: 5 })).status).toBe(400);
            expect((await row(level.id)).name).toBe(`${tag} Upd`);
        });

        it('la descripción se puede borrar con null o texto vacío, y reemplazar con texto', async () => {
            expect((await put(level.id, { description: null })).body.description).toBeNull();
            expect((await put(level.id, { description: 'nueva' })).body.description).toBe('nueva');
            expect((await put(level.id, { description: '' })).body.description).toBeNull();
        });

        it('nombre: el de otro nivel → 409; el propio (o uno nuevo) → 200', async () => {
            const other = await created({ name: `${tag} Otro` });
            const dup = await put(level.id, { name: other.name });
            expect(dup.status).toBe(409);
            expect(dup.body.error).toBe('SERVICE_LEVEL_NAME_ALREADY_EXISTS');
            expect((await put(level.id, { name: `${tag} Upd` })).status).toBe(200);
            expect((await put(level.id, { name: `${tag} Upd renombrado` })).body.name).toBe(`${tag} Upd renombrado`);
        });

        it('active debe ser un booleano de verdad', async () => {
            expect((await put(level.id, { active: 'false' })).status).toBe(400);
            expect((await put(level.id, { active: 0 })).status).toBe(400);
        });

        it('desactivar y reactivar: el nivel sigue en el listado con su estado', async () => {
            expect((await put(level.id, { active: false })).body.active).toBe(false);
            expect(ids(await listTag('active=false'))).toContain(level.id);
            expect((await put(level.id, { active: true })).body.active).toBe(true);
        });

        it('inexistente → 404 SERVICE_LEVEL_NOT_FOUND; id no numérico → 400', async () => {
            const missing = await put(99999999, { active: false });
            expect(missing.status).toBe(404);
            expect(missing.body.error).toBe('SERVICE_LEVEL_NOT_FOUND');
            expect((await request(app.getHttpServer()).put(url('/abc')).set(auth('coordinator')).send({})).status).toBe(400);
        });

        it('actualiza updated_at', async () => {
            const before = (await row(level.id)).updated_at;
            await new Promise((resolve) => setTimeout(resolve, 20));
            await put(level.id, { priorityLevel: 6 });
            expect(new Date((await row(level.id)).updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
        });
    });

    // ── Escenario 3 ────────────────────────────────────────────────────────────
    describe('Escenario 3 — un nivel con despachos activos no se puede borrar, solo desactivar', () => {
        it('con un despacho PENDING → DELETE 409 SERVICE_LEVEL_IN_USE y el nivel sigue ahí', async () => {
            const level = await created();
            await dispatchFor(level.id, 'pending');

            const res = await del(level.id);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('SERVICE_LEVEL_IN_USE');
            expect(res.body.message).toContain('Disable it instead');
            expect((await row(level.id)).deleted_at).toBeNull();
            expect((await get(level.id)).status).toBe(200);
        });

        it('también con un despacho IN_TRANSIT', async () => {
            const level = await created();
            await dispatchFor(level.id, 'in_transit');
            expect((await del(level.id)).status).toBe(409);
        });

        it('la salida es desactivarlo: PUT active=false → 200, y los despachos activos conservan su nivel', async () => {
            const level = await created();
            const dispatchId = await dispatchFor(level.id, 'pending');

            expect((await put(level.id, { active: false })).body.active).toBe(false);

            const [dispatch] = await dataSource.query(`SELECT service_level_id, dispatch_status_id FROM dispatches WHERE dispatch_id = $1`, [dispatchId]);
            expect(dispatch).toEqual({ service_level_id: level.id, dispatch_status_id: statusId.pending });
            expect((await del(level.id)).status).toBe(409); // desactivado, pero mientras haya activos no se borra
        });

        it('uno entregado + uno pendiente → sigue bloqueado', async () => {
            const level = await created();
            await dispatchFor(level.id, 'delivered');
            await dispatchFor(level.id, 'pending');
            expect((await del(level.id)).status).toBe(409);
        });

        it('cuando el último despacho activo termina, ya se puede borrar', async () => {
            const level = await created();
            const dispatchId = await dispatchFor(level.id, 'in_transit');
            expect((await del(level.id)).status).toBe(409);

            await dataSource.query(`UPDATE dispatches SET dispatch_status_id = $1 WHERE dispatch_id = $2`, [statusId.delivered, dispatchId]);

            expect((await del(level.id)).status).toBe(204);
        });

        it('solo despachos terminados (delivered / returned) → baja lógica, y el historial sigue apuntando al nivel', async () => {
            const level = await created();
            const first = await dispatchFor(level.id, 'delivered');
            const second = await dispatchFor(level.id, 'returned');

            expect((await del(level.id)).status).toBe(204);

            expect((await row(level.id)).deleted_at).not.toBeNull();
            const rows = await dataSource.query(`SELECT service_level_id FROM dispatches WHERE dispatch_id = ANY($1)`, [[first, second]]);
            expect(rows.map((r: any) => r.service_level_id)).toEqual([level.id, level.id]);
        });

        it('not_delivered NO cuenta como activo (decisión: solo pending e in_transit)', async () => {
            const level = await created();
            await dispatchFor(level.id, 'not_delivered');
            expect((await del(level.id)).status).toBe(204);
        });

        it('los despachos activos de OTRO nivel no bloquean el borrado', async () => {
            const busy = await created();
            const free = await created();
            await dispatchFor(busy.id, 'pending');
            expect((await del(free.id)).status).toBe(204);
        });

        it('sin despachos → baja lógica: desaparece de GET y del listado; borrar de nuevo → 404', async () => {
            const level = await created();
            expect((await del(level.id)).status).toBe(204);
            expect((await get(level.id)).status).toBe(404);
            expect(ids(await listTag())).not.toContain(level.id);

            const again = await del(level.id);
            expect(again.status).toBe(404);
            expect(again.body.error).toBe('SERVICE_LEVEL_NOT_FOUND');
            expect((await del(99999999)).status).toBe(404);
        });

        it('un intento de borrado rechazado no deja rastro', async () => {
            const level = await created();
            await dispatchFor(level.id, 'pending');
            const before = await row(level.id);

            await del(level.id);

            expect(await row(level.id)).toEqual(before);
        });
    });
});
