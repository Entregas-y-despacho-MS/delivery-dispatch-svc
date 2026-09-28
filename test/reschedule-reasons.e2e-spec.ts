// ES-25 (ST-25.1 + ST-25.3) — Catálogo de motivos de reprogramación/reasignación (RF-A33): alta con
// categorización de responsabilidad, prevención de duplicidad, y las validaciones de integridad
// del catálogo.
//
// Levanta el AppModule real contra una base de datos real (con la migración 005 ya aplicada) y pega
// por HTTP con supertest. Complementa a los specs unitarios (sin DB) de
// src/modules/catalog/reschedule-reasons/.
//
// Seguro de re-correr contra una base compartida: usuarios y motivos de prueba se crean con un
// prefijo único por corrida y se borran en afterAll. No depende de datos sembrados (no hay ninguno).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';

describe('Motivos de reprogramación/reasignación (e2e, RF-A33)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};

    const run = Date.now().toString(36).toUpperCase();
    const tag = `RR-${run}`;
    let seq = 0;
    const nextName = () => `${tag} ${++seq}`;
    // Cada created()/validBody() necesita un code Y un name únicos por separado (dos índices únicos
    // distintos) — cada uno incrementa `seq` independientemente, así ningún valor se repite nunca,
    // sin importar cuál de los dos lo esté usando (mismo bug ya encontrado antes en incident-reasons:
    // reusar el mismo valor para ambos campos hacía que una colisión de nombre se reportara como si
    // fuera de código, o viceversa).
    const nextCode = () => `${tag}-C${++seq}`.replace(/[^A-Z0-9-]/gi, '');

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const url = (path = '') => `/${apiPrefix}/reschedule-reasons${path}`;
    const post = (body: object, role = 'coordinator') => request(app.getHttpServer()).post(url()).set(auth(role)).send(body);
    const put = (id: number, body: object, role = 'coordinator') => request(app.getHttpServer()).put(url(`/${id}`)).set(auth(role)).send(body);
    const get = (id: number, role = 'coordinator') => request(app.getHttpServer()).get(url(`/${id}`)).set(auth(role));
    const list = (qs = '', role = 'coordinator') => request(app.getHttpServer()).get(url(`?${qs}`)).set(auth(role));
    const listTag = (qs = '') => list(`search=${encodeURIComponent(tag)}&limit=100${qs ? '&' + qs : ''}`);
    const validBody = (extra: object = {}) => ({ code: nextCode(), name: nextName(), description: 'Detalle de prueba', category: 'client', ...extra });
    const created = async (extra: object = {}) => (await post(validBody(extra))).body as any;
    const ids = (res: request.Response) => res.body.data.map((r: any) => r.id);

    const row = async (id: number) => (await dataSource.query(`SELECT * FROM reschedule_reasons WHERE reschedule_reason_id = $1`, [id]))[0];
    const countByName = async (name: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM reschedule_reasons WHERE name = $1`, [name]))[0].c as number;
    const countByCode = async (code: string) => (await dataSource.query(`SELECT count(*)::int AS c FROM reschedule_reasons WHERE code = $1`, [code]))[0].c as number;

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
                [role_id, `E2E ${role}`, `e2e_rr_${role}_${run}`, passwordHash],
            );
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username: `e2e_rr_${role}_${run}`, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM reschedule_reasons WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_rr_%_${run}`]);
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos: coordinador y supervisor administran; admin y driver no entran', () => {
        it('sin token → 401', async () => {
            expect((await request(app.getHttpServer()).get(url())).status).toBe(401);
        });

        it('coordinator y supervisor pueden listar, leer, crear y editar', async () => {
            for (const role of ['coordinator', 'supervisor']) {
                const reason = await created();
                expect((await list('', role)).status, role).toBe(200);
                expect((await get(reason.id, role)).status, role).toBe(200);
                expect((await post(validBody(), role)).status, role).toBe(201);
                expect((await put(reason.id, { active: false }, role)).status, role).toBe(200);
            }
        });

        it('admin y driver no pueden ni leer ni escribir, y no se modifica nada', async () => {
            const reason = await created();
            for (const role of ['admin', 'driver']) {
                expect((await list('', role)).status, `list ${role}`).toBe(403);
                expect((await get(reason.id, role)).status, `get ${role}`).toBe(403);
                expect((await post(validBody(), role)).status, `post ${role}`).toBe(403);
                expect((await put(reason.id, { active: false }, role)).status, `put ${role}`).toBe(403);
            }
            expect((await get(reason.id)).body.active).toBe(true);
        });

        it('permisos antes que validación: un body inválido de un rol sin permiso da 403, no 400', async () => {
            expect((await post({ category: 'nope' }, 'driver')).status).toBe(403);
        });
    });

    // ── Escenario 1 ────────────────────────────────────────────────────────────
    describe('Escenario 1 — registro de motivo de reprogramación/reasignación', () => {
        it('el primer ejemplo de la historia: "Solicitud expresa del cliente", categoría client → 201 y habilitado', async () => {
            const body = { code: nextCode(), name: `${tag} Solicitud expresa del cliente`, description: 'El cliente pidió mover la entrega', category: 'client' };
            const res = await post(body);

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ ...body, active: true, affectsSla: true });
            expect(Object.keys(res.body).sort()).toEqual(['active', 'affectsSla', 'category', 'code', 'createdAt', 'description', 'id', 'name']);
            expect(await row(res.body.id)).toMatchObject({
                code: body.code, name: body.name, description: body.description, category: 'client', active: true, deleted_at: null,
            });
        });

        it('el segundo ejemplo de la historia: "Avería mecánica en ruta", force_majeure', async () => {
            const res = await post({ code: nextCode(), name: `${tag} Avería mecánica en ruta`, category: 'force_majeure' });
            expect(res.status).toBe(201);
            expect(res.body.category).toBe('force_majeure');
            expect(res.body.description).toBeNull();
            expect(res.body.affectsSla).toBe(false); // solo `client` afecta la métrica de SLA
        });

        it('descripción opcional: omitida o vacía queda null; el nombre, el código y la descripción se recortan', async () => {
            const omitted = await post({ code: nextCode(), name: nextName(), category: 'operations' });
            expect(omitted.body.description).toBeNull();
            const blank = await post(validBody({ description: '   ' }));
            expect(blank.body.description).toBeNull();
            const name = nextName();
            const code = nextCode();
            const trimmed = await post({ code: `  ${code.toLowerCase()}  `, name: `  ${name}  `, description: '  hola  ', category: 'operations' });
            expect(trimmed.body).toMatchObject({ code, name, description: 'hola' });
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
    describe('Escenario 2 — categorización de impacto en SLA', () => {
        it('el catálogo acepta y persiste exactamente las 3 categorías de la historia', async () => {
            for (const category of ['client', 'operations', 'force_majeure']) {
                const res = await created({ category });
                expect(res.category).toBe(category);
                expect((await row(res.id)).category).toBe(category);
            }
        });

        it('affectsSla es true solo para client — computado, no se guarda en la base', async () => {
            const client = await created({ category: 'client' });
            const operations = await created({ category: 'operations' });
            const forceMajeure = await created({ category: 'force_majeure' });

            expect(client.affectsSla).toBe(true);
            expect(operations.affectsSla).toBe(false);
            expect(forceMajeure.affectsSla).toBe(false);
            // No es una columna propia: no aparece en la fila cruda de la base.
            expect(await row(client.id)).not.toHaveProperty('affects_sla');
        });

        it('una categoría fuera de las 3 válidas se rechaza (sin mayúsculas, sin espacios, sin sinónimos) y no se guarda nada', async () => {
            for (const category of ['CLIENT', 'Operations', 'force majeure', 'cliente', 'ninguna', '']) {
                const body = validBody({ category });
                const res = await post(body);
                expect(res.status, category).toBe(400);
                expect(await countByName(body.name)).toBe(0);
            }
        });

        it('category es obligatoria: falta → 400', async () => {
            const body: Record<string, unknown> = validBody();
            delete body.category;
            expect((await post(body)).status).toBe(400);
            expect(await countByName(body.name as string)).toBe(0);
        });

        it('la categoría se puede recategorizar después (ej. de client a operations)', async () => {
            const reason = await created({ category: 'client' });
            const res = await put(reason.id, { category: 'operations' });
            expect(res.body.category).toBe('operations');
        });
    });

    // ── Escenario 3 ────────────────────────────────────────────────────────────
    describe('Escenario 3 — prevención de duplicidad (nombre o código)', () => {
        it('409 RESCHEDULE_REASON_CODE_ALREADY_EXISTS con el mismo nombre, también con espacios alrededor', async () => {
            const first = await created();
            for (const name of [first.name, `  ${first.name}  `]) {
                const res = await post(validBody({ name }));
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('RESCHEDULE_REASON_CODE_ALREADY_EXISTS');
            }
            expect(await countByName(first.name)).toBe(1);
        });

        it('409 con el mismo código, también con espacios/mayúsculas distintas (se normaliza antes de comparar)', async () => {
            const first = await created();
            for (const code of [first.code, `  ${first.code.toLowerCase()}  `]) {
                const res = await post(validBody({ code }));
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('RESCHEDULE_REASON_CODE_ALREADY_EXISTS');
            }
            expect(await countByCode(first.code)).toBe(1);
        });

        it('altas simultáneas con el mismo nombre: exactamente una gana, el resto 409, ningún 500', async () => {
            const body = validBody();
            const statuses = (await Promise.all(Array.from({ length: 6 }, () => post(body)))).map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            expect(await countByName(body.name)).toBe(1);
        });

        it('altas simultáneas con el mismo código (nombres distintos): exactamente una gana, el resto 409, ningún 500', async () => {
            const code = nextCode();
            const bodies = Array.from({ length: 6 }, () => ({ ...validBody(), code }));
            const statuses = (await Promise.all(bodies.map((b) => post(b)))).map((r) => r.status);

            expect(statuses.filter((s) => s === 201)).toHaveLength(1);
            expect(statuses.filter((s) => s === 409)).toHaveLength(5);
            expect(await countByCode(code)).toBe(1);
        });

        it('renombrar a un nombre de otro motivo también da 409', async () => {
            const a = await created();
            const b = await created();
            const res = await put(b.id, { name: a.name });
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('RESCHEDULE_REASON_CODE_ALREADY_EXISTS');
        });

        it('cambiar el código a uno de otro motivo también da 409; al propio código no se rechequea (200)', async () => {
            const a = await created();
            const b = await created();
            const clash = await put(b.id, { code: a.code });
            expect(clash.status).toBe(409);
            expect(clash.body.error).toBe('RESCHEDULE_REASON_CODE_ALREADY_EXISTS');

            const noop = await put(b.id, { code: b.code });
            expect(noop.status).toBe(200);
        });

        it('cambiar el código a uno nuevo (sin colisión) se guarda de verdad', async () => {
            const reason = await created();
            const newCode = nextCode();

            const res = await put(reason.id, { code: newCode });

            expect(res.status).toBe(200);
            expect(res.body.code).toBe(newCode);
            expect((await row(reason.id)).code).toBe(newCode);
        });

        it('desactivar un motivo no libera ni su nombre ni su código (no hay endpoint de borrado en este catálogo)', async () => {
            const first = await created();
            await put(first.id, { active: false });
            expect((await post(validBody({ name: first.name }))).status).toBe(409);
            expect((await post(validBody({ code: first.code }))).status).toBe(409);
        });
    });

    // ── Validación de campos ───────────────────────────────────────────────────
    describe('validación', () => {
        it('code, name y category son obligatorios', async () => {
            for (const field of ['code', 'name', 'category']) {
                const body: Record<string, unknown> = validBody();
                delete body[field];
                expect((await post(body)).status, field).toBe(400);
            }
        });

        it('name vacío o de solo espacios se rechaza', async () => {
            expect((await post(validBody({ name: '' }))).status).toBe(400);
            expect((await post(validBody({ name: '   ' }))).status).toBe(400);
        });

        it('code vacío o de solo espacios se rechaza', async () => {
            expect((await post(validBody({ code: '' }))).status).toBe(400);
            expect((await post(validBody({ code: '   ' }))).status).toBe(400);
        });

        it('name sobre 150, code sobre 30 y description sobre 255 se rechazan', async () => {
            expect((await post(validBody({ name: 'A'.repeat(151) }))).status).toBe(400);
            expect((await post(validBody({ code: 'A'.repeat(31) }))).status).toBe(400);
            expect((await post(validBody({ description: 'A'.repeat(256) }))).status).toBe(400);
        });

        it('editar: null se rechaza en code/name/category/active; description sí acepta null', async () => {
            const reason = await created();
            for (const field of ['code', 'name', 'category', 'active']) {
                expect((await put(reason.id, { [field]: null })).status, field).toBe(400);
            }
            expect((await put(reason.id, { description: null })).status).toBe(200);
            expect(await row(reason.id)).toMatchObject({ code: reason.code, name: reason.name, category: reason.category, active: true });
        });

        it('un cambio válido junto con uno inválido no se aplica a medias', async () => {
            const reason = await created();
            expect((await put(reason.id, { name: 'NO debe guardarse', category: 'otra' }))).toMatchObject({ status: 400 });
            expect((await row(reason.id)).name).toBe(reason.name);
        });

        it('un PUT vacío no cambia nada', async () => {
            const reason = await created();
            const res = await put(reason.id, {});
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ name: reason.name, category: reason.category });
        });

        it('no hay endpoint DELETE para este catálogo', async () => {
            const reason = await created();
            const res = await request(app.getHttpServer()).delete(url(`/${reason.id}`)).set(auth('coordinator'));
            expect(res.status).toBe(404);
        });
    });

    // ── Listado: filtros, orden y paginación ───────────────────────────────────
    describe('listado — filtros, orden y paginación', () => {
        it('search por nombre y por descripción, sin distinguir mayúsculas', async () => {
            const reason = await created({ name: `${tag} Paquete perdido`, description: 'motivo poco frecuente' });
            for (const term of ['paquete', 'PAQUETE', 'frecuente']) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(reason.id);
            }
        });

        it('search también encuentra por código, sin distinguir mayúsculas', async () => {
            const code = `${tag}-PERDIDO`;
            const reason = await created({ code });
            for (const term of [code, code.toLowerCase()]) {
                expect(ids(await list(`search=${encodeURIComponent(term)}&limit=100`)), term).toContain(reason.id);
            }
        });

        it('los comodines % y _ se buscan literalmente', async () => {
            const pct = await created({ name: `${tag} Desc 50% off` });
            await created({ name: `${tag} Desc 500 off` });
            expect(ids(await list(`search=${encodeURIComponent(`${tag} Desc 50%`)}&limit=100`))).toEqual([pct.id]);
        });

        it('category y active filtran y se combinan entre sí', async () => {
            const t = `${tag} Filtro`;
            const on  = await created({ name: `${t} on`, category: 'client' });
            const off = await created({ name: `${t} off`, category: 'operations' });
            await put(off.id, { active: false });

            expect(ids(await list(`search=${encodeURIComponent(t)}&category=client&limit=100`))).toEqual([on.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&active=false&limit=100`))).toEqual([off.id]);
            expect((await list(`search=${encodeURIComponent(t)}&limit=100`)).body.data.map((r: any) => r.id).sort()).toEqual([on.id, off.id].sort());
        });

        it('la búsqueda no se salta el filtro active en NINGUNA rama del OR (ni código, ni nombre, ni descripción)', async () => {
            const t = `${tag} NoSaltar`;
            // El texto buscado está SOLO en el CÓDIGO del primero, SOLO en el NOMBRE del segundo, y
            // SOLO en la DESCRIPCIÓN del tercero — así las 3 ramas del OR (código / nombre /
            // descripción) tienen algo que filtrar, y si el filtro active se saltara en cualquiera de
            // las tres, el ítem deshabilitado de esa rama aparecería igual.
            const byCode = await created({ code: `${t}CODE`, name: `${tag} otro nombre ${++seq}` });
            const byName = await created({ name: `${t} on` });
            const byDescription = await created({ name: `${tag} otro nombre ${++seq}`, description: `descripción con ${t}` });
            await put(byCode.id, { active: false });
            await put(byDescription.id, { active: false });

            const enabledOnly = ids(await list(`search=${encodeURIComponent(t)}&active=true&limit=100`));
            expect(enabledOnly).toContain(byName.id);
            expect(enabledOnly).not.toContain(byCode.id);
            expect(enabledOnly).not.toContain(byDescription.id);

            const disabledOnly = ids(await list(`search=${encodeURIComponent(t)}&active=false&limit=100`));
            expect(disabledOnly.sort()).toEqual([byCode.id, byDescription.id].sort());
        });

        it('un active vacío (?active=) no filtra y no rompe', async () => {
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

        it('ordena por nombre por defecto; sortBy=code, sortBy=category y sortOrder=desc también funcionan', async () => {
            const t = `${tag} Orden`;
            const b = await created({ name: `${t} B`, code: `${t}-B`, category: 'operations' });
            const a = await created({ name: `${t} A`, code: `${t}-A`, category: 'client' });
            expect(ids(await list(`search=${encodeURIComponent(t)}&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=code&limit=100`))).toEqual([a.id, b.id]);
            expect(ids(await list(`search=${encodeURIComponent(t)}&sortBy=category&limit=100`))).toEqual([a.id, b.id]);
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
            for (const qs of ['limit=101', 'limit=0', 'page=0', 'active=maybe', 'category=otra', `search=${'a'.repeat(101)}`, 'foo=bar', 'sortBy=active']) {
                expect((await list(qs)).status, qs).toBe(400);
            }
        });

        it('entradas raras en search no rompen nada', async () => {
            for (const term of ["' OR 1=1 --", '\\', '%%%%', 'ñandú', '   ']) {
                expect((await list(term ? `search=${encodeURIComponent(term)}` : '')).status, term).toBe(200);
            }
        });

        it('un id inválido (no numérico, 0, fuera de rango de INTEGER) → 400; uno inexistente → 404', async () => {
            for (const id of ['abc', '0', '-1', '99999999999']) {
                expect((await request(app.getHttpServer()).get(url(`/${id}`)).set(auth('coordinator'))).status, id).toBe(400);
            }
            const missing = await get(99999999);
            expect([missing.status, missing.body.error]).toEqual([404, 'RESCHEDULE_REASON_NOT_FOUND']);
        });
    });
});
