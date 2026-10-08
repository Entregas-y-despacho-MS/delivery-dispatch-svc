// ST-48.2 (RF-A40) — bandeja de pedidos pendientes con filtros, orden, paginación y reserva suave.
//
// Levanta el AppModule real contra una base de datos real (con las migraciones 009 y 010 aplicadas) y pega
// por HTTP con supertest. Seguro de re-correr contra una base compartida: todo lo que crea lleva un prefijo
// único por corrida (en el nombre del destinatario, para acotar cada consulta con `search`) y se borra en
// afterAll. La clave order_reservation_ttl_minutes se restaura al terminar.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';

const TZ = 'America/La_Paz';

describe('Bandeja de pedidos pendientes y reserva suave (e2e, ST-48.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let settings: SettingsService;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const fullNames: Record<string, string> = {};
    const statusIds: Record<string, number> = {};
    let deliveryTypeId: number;
    let originalTtl: string | undefined;

    const run = Date.now().toString(36).toUpperCase();
    const tag = `T${run}`;
    let seq = 0;

    const zones: number[] = [];
    const levels: Record<string, number> = {};

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const inboxUrl = (qs = '') => `/${apiPrefix}/pending-orders${qs ? '?' + qs : ''}`;
    const resUrl = (path = '') => `/${apiPrefix}/dispatch-reservations${path}`;
    const inbox = (qs = '', role = 'coordinator') => request(app.getHttpServer()).get(inboxUrl(qs)).set(auth(role));
    // Every query is narrowed to this run's rows with `search=<tag>`, so other test files' rows never leak in.
    // Defaults are only added when the query does not set them itself (a repeated param would arrive as an array).
    const mine = (qs = '', role = 'coordinator') => {
        const parts = [qs];
        if (!/(^|&)search=/.test(qs)) parts.push(`search=${tag}`);
        if (!/(^|&)limit=/.test(qs)) parts.push('limit=100');
        return inbox(parts.filter(Boolean).join('&'), role);
    };
    const ids = (res: request.Response): number[] => res.body.data.map((r: any) => r.id);
    const reserve = (dispatchIds: number[], role = 'coordinator') =>
        request(app.getHttpServer()).post(resUrl()).set(auth(role)).send({ dispatchIds });
    const renew = (role = 'coordinator') => request(app.getHttpServer()).post(resUrl('/renew')).set(auth(role)).send();
    const release = (body: object = {}, role = 'coordinator') =>
        request(app.getHttpServer()).post(resUrl('/release')).set(auth(role)).send(body);

    // days: offset from today in Bolivia time; at: local time of the window start.
    const insert = async (o: {
        status?: string; priority?: string; zone?: number | null; level?: string | null; name?: string | null;
        days?: number | null; at?: string; weightKg?: number; createdMinutesAgo?: number; ref?: string;
        packages?: { l: number; w: number; h: number; kg: number }[];
    } = {}): Promise<number> => {
        const n = ++seq;
        const days = o.days === undefined ? 0 : o.days;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, delivery_zone_id, service_level_id, source_order_ref,
                                     priority, delivery_address, contact_name, tracking_code, scheduled_window_start, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'Dirección de prueba', $7, $8,
                     CASE WHEN $9::int IS NULL THEN NULL
                          ELSE (((NOW() AT TIME ZONE '${TZ}')::date + $9::int + $10::time) AT TIME ZONE '${TZ}') END,
                     NOW() - $11::int * INTERVAL '1 minute')
             RETURNING dispatch_id`,
            [
                deliveryTypeId, statusIds[o.status ?? 'pending'], o.zone ?? null,
                o.level === undefined || o.level === null ? null : levels[o.level],
                o.ref ?? `${tag}-${String(n).padStart(3, '0')}`, o.priority ?? 'normal',
                o.name === undefined ? `${tag} Cliente ${n}` : o.name, `${tag}${n}`,
                days, o.at ?? '09:00', o.createdMinutesAgo ?? 0,
            ],
        );
        for (const [i, p] of (o.packages ?? []).entries()) {
            await dataSource.query(
                `INSERT INTO dispatch_packages (dispatch_id, external_package_id, length_cm, width_cm, height_cm, gross_weight_kg)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [dispatch_id, `PKG-${n}-${i}`, p.l, p.w, p.h, p.kg],
            );
        }
        return dispatch_id as number;
    };

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
        settings = app.get(SettingsService);

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'coordinator2', 'supervisor', 'admin', 'driver']) {
            const roleName = role === 'coordinator2' ? 'coordinator' : role;
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [roleName]);
            const username = `e2e_po_${role}_${run}`;
            fullNames[role] = `Coord ${role} ${run}`;
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [role_id, fullNames[role], username, passwordHash],
            );
            userIds[role] = user_id;
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        for (const row of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[row.name] = row.id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        for (const [i, name] of [`${tag} Zona A`, `${tag} Zona B`].entries()) {
            const [{ delivery_zone_id }] = await dataSource.query(
                `INSERT INTO delivery_zones (code, name, estimated_time_min) VALUES ($1, $2, 30) RETURNING delivery_zone_id`,
                [`${tag}Z${i}`, name],
            );
            zones.push(delivery_zone_id);
        }
        for (const [key, minutes] of [['s30', 30], ['s60', 60], ['s120', 120]] as const) {
            const [{ service_level_id }] = await dataSource.query(
                `INSERT INTO service_levels (name, target_time_min, priority_level) VALUES ($1, $2, 1) RETURNING service_level_id`,
                [`${tag}-${key}`, minutes],
            );
            levels[key] = service_level_id;
        }

        const [setting] = await dataSource.query(`SELECT setting_value FROM settings WHERE setting_key = 'order_reservation_ttl_minutes'`);
        originalTtl = setting?.setting_value;
    });

    // Each test starts with no reservations held by the two test coordinators, so counts do not depend on test order.
    beforeEach(async () => {
        await dataSource.query(`DELETE FROM dispatch_reservations WHERE reserved_by = ANY($1)`, [[userIds.coordinator, userIds.coordinator2]]);
    });

    afterAll(async () => {
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_po_%_${run}`]);
        if (originalTtl !== undefined) {
            await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = 'order_reservation_ttl_minutes'`, [originalTtl]);
            await settings.refresh();
        }
        await app.close();
    });

    // ── Permisos ───────────────────────────────────────────────────────────────
    describe('permisos', () => {
        it('sin token → 401 en la bandeja y en las reservas', async () => {
            expect((await request(app.getHttpServer()).get(inboxUrl())).status).toBe(401);
            expect((await request(app.getHttpServer()).post(resUrl()).send({ dispatchIds: [1] })).status).toBe(401);
        });

        it('coordinator y supervisor leen la bandeja; admin y driver no', async () => {
            for (const role of ['coordinator', 'supervisor']) expect((await mine('', role)).status, role).toBe(200);
            for (const role of ['admin', 'driver']) expect((await mine('', role)).status, role).toBe(403);
        });

        it('solo el coordinador reserva, renueva y libera', async () => {
            const id = await insert();
            for (const role of ['supervisor', 'admin', 'driver']) {
                expect((await reserve([id], role)).status, `reserve ${role}`).toBe(403);
                expect((await renew(role)).status, `renew ${role}`).toBe(403);
                expect((await release({}, role)).status, `release ${role}`).toBe(403);
            }
        });
    });

    // ── Qué entra a la bandeja ─────────────────────────────────────────────────
    describe('estados incluidos y excluidos', () => {
        it('incluye pending y rescheduled de hoy; excluye cualquier otro estado y los reprogramados para otro día', async () => {
            const pending = await insert({ status: 'pending' });
            const pendingNoWindow = await insert({ status: 'pending', days: null });
            const rescheduledToday = await insert({ status: 'rescheduled', days: 0 });
            const rescheduledTomorrow = await insert({ status: 'rescheduled', days: 1 });
            const rescheduledYesterday = await insert({ status: 'rescheduled', days: -1 });
            const rescheduledNoDate = await insert({ status: 'rescheduled', days: null });
            const others: number[] = [];
            for (const status of ['address_review', 'in_planning', 'scheduled', 'assigned', 'out_for_delivery', 'in_transit',
                'delivered', 'not_delivered', 'incident', 'returned', 'pickup_scheduled']) {
                others.push(await insert({ status }));
            }

            const res = await mine('limit=100');
            expect(res.status).toBe(200);
            const got = ids(res);
            expect(got).toEqual(expect.arrayContaining([pending, pendingNoWindow, rescheduledToday]));
            for (const excluded of [rescheduledTomorrow, rescheduledYesterday, rescheduledNoDate, ...others]) {
                expect(got, `dispatch ${excluded}`).not.toContain(excluded);
            }
        });

        it('"hoy" se mide en hora de Bolivia, no en UTC', async () => {
            // 23:30 locally is already the next day in UTC; it must still count as today.
            const lateToday = await insert({ status: 'rescheduled', days: 0, at: '23:30' });
            // 00:30 locally is still the previous day in UTC; it must still count as today.
            const earlyToday = await insert({ status: 'rescheduled', days: 0, at: '00:30' });
            const got = ids(await mine());
            expect(got).toEqual(expect.arrayContaining([lateToday, earlyToday]));
        });

        it('devuelve todos los campos esperados, con peso y volumen de los bultos', async () => {
            const id = await insert({
                zone: zones[0], level: 's60', priority: 'urgent', name: `${tag} Campos`, at: '10:00',
                packages: [{ l: 100, w: 50, h: 40, kg: 12.5 }, { l: 50, w: 50, h: 40, kg: 2.25 }],
            });
            const res = await mine(`search=${encodeURIComponent(tag + ' Campos')}`);
            const row = res.body.data.find((r: any) => r.id === id);
            expect(Object.keys(row).sort()).toEqual([
                'address', 'id', 'locked', 'orderNumber', 'packagesCount', 'priority', 'recipient', 'recipientPhone', 'reservation',
                'shift', 'slaDueAt', 'status', 'trackingCode', 'volumeM3', 'weightKg', 'windowEnd', 'windowStart', 'zoneId', 'zoneName',
            ].sort());
            expect(row).toMatchObject({
                recipient: `${tag} Campos`, zoneId: zones[0], zoneName: `${tag} Zona A`, priority: 'urgent', status: 'pending',
                shift: 'morning', packagesCount: 2, locked: false, reservation: null,
            });
            expect(row.weightKg).toBeCloseTo(14.75, 3);
            expect(row.volumeM3).toBeCloseTo(0.3, 6); // 0.2 + 0.1
            expect(typeof row.weightKg).toBe('number');
            expect(typeof row.volumeM3).toBe('number');
            expect(row.slaDueAt).toBeTruthy();
        });

        it('un pedido sin bultos suma peso y volumen 0', async () => {
            const id = await insert({ name: `${tag} SinBultos` });
            const row = (await mine(`search=${encodeURIComponent(tag + ' SinBultos')}`)).body.data.find((r: any) => r.id === id);
            expect(row).toMatchObject({ packagesCount: 0, weightKg: 0, volumeM3: 0, slaDueAt: null, shift: 'morning' });
        });
    });

    // ── Filtros ────────────────────────────────────────────────────────────────
    describe('filtros', () => {
        let zoneA1: number, zoneA2: number, zoneB1: number, morningUrgent: number, afternoonNormal: number, noWindow: number;
        const name = `${tag} Filtros`;

        beforeAll(async () => {
            zoneA1 = await insert({ name, zone: zones[0], priority: 'urgent', at: '08:00' });
            zoneA2 = await insert({ name, zone: zones[0], priority: 'normal', at: '15:00' });
            zoneB1 = await insert({ name, zone: zones[1], priority: 'normal', at: '11:59' });
            morningUrgent = await insert({ name, zone: zones[1], priority: 'urgent', at: '12:00' });
            afternoonNormal = await insert({ name, zone: null, priority: 'normal', at: '18:30' });
            noWindow = await insert({ name, zone: null, priority: 'normal', days: null });
        });

        const filtered = async (qs: string) => ids(await mine(`search=${encodeURIComponent(name)}&${qs}`)).sort((a, b) => a - b);
        const sorted = (...xs: number[]) => xs.sort((a, b) => a - b);

        it('sin filtros devuelve todos los de la corrida', async () => {
            expect(await filtered('')).toEqual(sorted(zoneA1, zoneA2, zoneB1, morningUrgent, afternoonNormal, noWindow));
        });

        it('por zona (delivery_zone_id)', async () => {
            expect(await filtered(`delivery_zone_id=${zones[0]}`)).toEqual(sorted(zoneA1, zoneA2));
            expect(await filtered(`delivery_zone_id=${zones[1]}`)).toEqual(sorted(zoneB1, morningUrgent));
        });

        it('por turno: morning < 12:00, afternoon desde las 12:00; sin franja no entra a ninguno', async () => {
            expect(await filtered('shift=morning')).toEqual(sorted(zoneA1, zoneB1));
            expect(await filtered('shift=afternoon')).toEqual(sorted(zoneA2, morningUrgent, afternoonNormal));
        });

        it('por prioridad', async () => {
            expect(await filtered('priority=urgent')).toEqual(sorted(zoneA1, morningUrgent));
            expect(await filtered('priority=normal')).toEqual(sorted(zoneA2, zoneB1, afternoonNormal, noWindow));
        });

        it('los filtros se combinan (AND)', async () => {
            expect(await filtered(`delivery_zone_id=${zones[0]}&priority=urgent`)).toEqual([zoneA1]);
            expect(await filtered(`delivery_zone_id=${zones[1]}&shift=afternoon&priority=urgent`)).toEqual([morningUrgent]);
            expect(await filtered(`delivery_zone_id=${zones[0]}&shift=afternoon&priority=urgent`)).toEqual([]);
        });

        it('búsqueda por cliente: parcial y sin distinguir mayúsculas', async () => {
            const id = await insert({ name: `${tag} Zuleta Quispe` });
            expect(ids(await mine('search=' + encodeURIComponent(`${tag} zuleta`)))).toEqual([id]);
            expect(ids(await mine('search=' + encodeURIComponent(`${tag} ZULETA QUISPE`)))).toEqual([id]);
        });

        it('búsqueda por código de guía', async () => {
            const id = await insert({ name: null });
            const [{ tracking_code }] = await dataSource.query(`SELECT tracking_code FROM dispatches WHERE dispatch_id = $1`, [id]);
            expect(ids(await inbox(`search=${encodeURIComponent(tracking_code)}&limit=100`))).toEqual([id]);
        });

        it('% y _ se buscan literalmente, no como comodines', async () => {
            const withPercent = await insert({ name: `${tag} 50% Descuento` });
            const plain = await insert({ name: `${tag} 50 Descuento` });
            expect(ids(await inbox(`search=${encodeURIComponent(`${tag} 50%`)}&limit=100`))).toEqual([withPercent]);
            expect(ids(await inbox(`search=${encodeURIComponent(`${tag} 50_`)}&limit=100`))).toEqual([]);
            expect(plain).toBeGreaterThan(0);
        });

        it('valores inválidos → 400', async () => {
            for (const qs of ['shift=night', 'priority=high', 'delivery_zone_id=abc', 'delivery_zone_id=0', 'delivery_zone_id=99999999999', `search=${'x'.repeat(101)}`]) {
                expect((await inbox(qs)).status, qs).toBe(400);
            }
        });
    });

    // ── Orden ──────────────────────────────────────────────────────────────────
    describe('orden', () => {
        const name = `${tag} Orden`;
        let urgent30: number, urgent120: number, normal30: number, normal60: number, normalNoSla: number;

        beforeAll(async () => {
            normal60 = await insert({ name, priority: 'normal', level: 's60' });
            normal30 = await insert({ name, priority: 'normal', level: 's30' });
            urgent120 = await insert({ name, priority: 'urgent', level: 's120' });
            urgent30 = await insert({ name, priority: 'urgent', level: 's30' });
            normalNoSla = await insert({ name, priority: 'normal', level: null });
        });

        const sortedIds = async (qs = '') => ids(await mine(`search=${encodeURIComponent(name)}&${qs}`));

        it('por defecto: urgentes primero y luego por vencimiento de SLA (sin SLA al final)', async () => {
            expect(await sortedIds()).toEqual([urgent30, urgent120, normal30, normal60, normalNoSla]);
        });

        it('el vencimiento sale de la creación más el tiempo objetivo del nivel de servicio', async () => {
            const res = await mine(`search=${encodeURIComponent(name)}`);
            const byId = new Map<number, any>(res.body.data.map((r: any) => [r.id, r]));
            const [{ created_at }] = await dataSource.query(`SELECT created_at FROM dispatches WHERE dispatch_id = $1`, [normal60]);
            expect(new Date(byId.get(normal60).slaDueAt).getTime() - new Date(created_at).getTime()).toBe(60 * 60_000);
        });

        it('sortBy=orderNumber asc y desc', async () => {
            const asc = [normal60, normal30, urgent120, urgent30, normalNoSla];
            expect(await sortedIds('sortBy=orderNumber&order=asc')).toEqual(asc);
            expect(await sortedIds('sortBy=orderNumber&order=desc')).toEqual([...asc].reverse());
        });

        it('sortBy=recipient (el empate se desempata por id)', async () => {
            const a = await insert({ name: `${tag} Orden Aaa` });
            const z = await insert({ name: `${tag} Orden Zzz` });
            const got = ids(await mine(`search=${encodeURIComponent(tag + ' Orden')}&sortBy=recipient&order=asc`));
            expect(got.indexOf(a)).toBeLessThan(got.indexOf(z));
            expect(got.slice(got.indexOf(a) - 5, got.indexOf(a))).toEqual([normal60, normal30, urgent120, urgent30, normalNoSla]);
            const desc = ids(await mine(`search=${encodeURIComponent(tag + ' Orden')}&sortBy=recipient&order=desc`));
            expect(desc[0]).toBe(z);
        });

        it('sortBy=zone, window, weight y priority', async () => {
            const n = `${tag} Orden2`;
            const heavyA = await insert({ name: n, zone: zones[1], at: '16:00', priority: 'normal', packages: [{ l: 10, w: 10, h: 10, kg: 30 }] });
            const lightB = await insert({ name: n, zone: zones[0], at: '09:00', priority: 'urgent', packages: [{ l: 10, w: 10, h: 10, kg: 5 }] });
            const none = await insert({ name: n, zone: null, at: '12:00', priority: 'normal' });
            const by = async (qs: string) => ids(await mine(`search=${encodeURIComponent(n)}&${qs}`));

            expect(await by('sortBy=zone&order=asc')).toEqual([lightB, heavyA, none]);
            expect(await by('sortBy=zone&order=desc')).toEqual([heavyA, lightB, none]);
            expect(await by('sortBy=window&order=asc')).toEqual([lightB, none, heavyA]);
            expect(await by('sortBy=window&order=desc')).toEqual([heavyA, none, lightB]);
            expect(await by('sortBy=weight&order=asc')).toEqual([none, lightB, heavyA]);
            expect(await by('sortBy=weight&order=desc')).toEqual([heavyA, lightB, none]);
            expect(await by('sortBy=priority&order=asc')).toEqual([lightB, heavyA, none]);
            expect(await by('sortBy=priority&order=desc')).toEqual([heavyA, none, lightB]);
        });

        it('sortBy u order inválidos → 400', async () => {
            expect((await inbox('sortBy=color')).status).toBe(400);
            expect((await inbox('sortBy=weight&order=sideways')).status).toBe(400);
            expect((await inbox('sortOrder=asc')).status).toBe(400); // el parámetro se llama `order`
        });
    });

    // ── Paginación ─────────────────────────────────────────────────────────────
    describe('paginación', () => {
        const name = `${tag} Pagina`;
        const created: number[] = [];

        beforeAll(async () => {
            for (let i = 0; i < 25; i++) created.push(await insert({ name, priority: 'normal' }));
        });

        const page = (qs: string) => mine(`search=${encodeURIComponent(name)}&${qs}`);

        it('responde { data, total, page, limit } y por defecto 10 por página', async () => {
            const res = await inbox(`search=${encodeURIComponent(name)}`);
            expect(Object.keys(res.body).sort()).toEqual(['data', 'limit', 'page', 'total']);
            expect(res.body).toMatchObject({ total: 25, page: 1, limit: 10 });
            expect(res.body.data).toHaveLength(10);
        });

        it('recorre todas las páginas sin repetir ni saltar pedidos', async () => {
            const seen: number[] = [];
            for (const p of [1, 2, 3]) {
                const res = await page(`limit=10&page=${p}&sortBy=orderNumber`);
                expect(res.body).toMatchObject({ total: 25, page: p, limit: 10 });
                seen.push(...ids(res));
            }
            expect(seen).toHaveLength(25);
            expect(new Set(seen).size).toBe(25);
            expect(seen.sort((a, b) => a - b)).toEqual([...created].sort((a, b) => a - b));
        });

        it('la última página trae el resto y una página fuera de rango viene vacía', async () => {
            expect((await page('limit=10&page=3')).body.data).toHaveLength(5);
            const beyond = await page('limit=10&page=4');
            expect(beyond.status).toBe(200);
            expect(beyond.body).toMatchObject({ data: [], total: 25, page: 4, limit: 10 });
        });

        it('el límite máximo es 100', async () => {
            expect((await page('limit=100')).status).toBe(200);
            expect((await page('limit=101')).status).toBe(400);
            expect((await page('limit=0')).status).toBe(400);
            expect((await page('page=0')).status).toBe(400);
            expect((await page('page=abc')).status).toBe(400);
        });
    });

    // ── Reserva suave ──────────────────────────────────────────────────────────
    describe('reserva suave', () => {
        const rowFor = async (id: number, role: string, name: string) =>
            (await mine(`search=${encodeURIComponent(name)}`, role)).body.data.find((r: any) => r.id === id);

        it('quien reserva ve el pedido propio como in_planning sin bloquear; los demás lo ven bloqueado con nombre y vencimiento', async () => {
            const name = `${tag} Reserva1`;
            const a = await insert({ name });
            const b = await insert({ name });
            const res = await reserve([a, b]);
            expect(res.status).toBe(201);
            expect(res.body.reserved).toBe(2);

            const other = await rowFor(a, 'coordinator2', name);
            expect(other).toMatchObject({
                status: 'in_planning', locked: true,
                reservation: { reservedById: userIds.coordinator, reservedByName: fullNames.coordinator, reservedByMe: false },
            });
            expect(new Date(other.reservation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
            expect(new Date(other.reservation.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);

            const own = await rowFor(a, 'coordinator', name);
            expect(own).toMatchObject({ status: 'in_planning', locked: false, reservation: { reservedById: userIds.coordinator, reservedByMe: true } });

            const supervisor = await rowFor(a, 'supervisor', name);
            expect(supervisor).toMatchObject({ status: 'in_planning', locked: true });
        });

        it('los pedidos reservados siguen listados; el que no se reservó queda libre', async () => {
            const name = `${tag} Reserva2`;
            const reserved = await insert({ name });
            const free = await insert({ name });
            await reserve([reserved]);
            const res = await mine(`search=${encodeURIComponent(name)}`, 'coordinator2');
            expect(ids(res).sort((x, y) => x - y)).toEqual([reserved, free].sort((x, y) => x - y));
            expect(res.body.data.find((r: any) => r.id === free)).toMatchObject({ status: 'pending', locked: false, reservation: null });
        });

        it('otro coordinador no puede reservar un pedido ajeno: 409 y nada del lote queda reservado', async () => {
            const name = `${tag} Reserva3`;
            const taken = await insert({ name });
            const free = await insert({ name });
            expect((await reserve([taken])).status).toBe(201);

            const res = await reserve([free, taken], 'coordinator2');
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_ALREADY_RESERVED');
            expect(res.body.message).toContain(String(taken));
            expect(res.body.message).not.toContain(String(free));

            const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM dispatch_reservations WHERE dispatch_id = $1`, [free]);
            expect(count).toBe(0);
            expect(await rowFor(taken, 'coordinator2', name)).toMatchObject({ reservation: { reservedById: userIds.coordinator } });
        });

        it('reservar de nuevo los pedidos propios es válido y los renueva', async () => {
            const name = `${tag} Reserva4`;
            const id = await insert({ name });
            expect((await reserve([id])).status).toBe(201);
            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() + INTERVAL '2 minutes' WHERE dispatch_id = $1`, [id]);
            const again = await reserve([id]);
            expect(again.status).toBe(201);
            expect(new Date(again.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
        });

        it('no se reservan pedidos inexistentes ni fuera de la bandeja (assigned, rescheduled de otro día): 409', async () => {
            const name = `${tag} Reserva5`;
            const ok = await insert({ name });
            const assigned = await insert({ name, status: 'assigned' });
            const tomorrow = await insert({ name, status: 'rescheduled', days: 1 });
            const res = await reserve([ok, assigned, tomorrow, 2147483000]);
            expect(res.status).toBe(409);
            expect(res.body.error).toBe('DISPATCH_NOT_RESERVABLE');
            for (const id of [assigned, tomorrow, 2147483000]) expect(res.body.message).toContain(String(id));
            expect(res.body.message).not.toContain(`: ${ok},`);
            const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM dispatch_reservations WHERE dispatch_id = $1`, [ok]);
            expect(count).toBe(0);
        });

        it('valida el cuerpo → 400', async () => {
            for (const body of [{}, { dispatchIds: [] }, { dispatchIds: 'x' }, { dispatchIds: [1, 1] }, { dispatchIds: [0] }, { dispatchIds: [1.5] },
                { dispatchIds: [2147483648] }, { dispatchIds: Array.from({ length: 201 }, (_, i) => i + 1) }, { dispatchIds: [1], extra: true }]) {
                const res = await request(app.getHttpServer()).post(resUrl()).set(auth('coordinator')).send(body);
                expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
            }
        });

        it('liberar (confirmar o cancelar la planificación) deja el pedido libre y de nuevo en su estado', async () => {
            const name = `${tag} Reserva6`;
            const a = await insert({ name });
            const b = await insert({ name });
            await reserve([a, b]);

            const partial = await release({ dispatchIds: [a] });
            expect(partial.status).toBe(200);
            expect(partial.body.released).toBe(1);
            expect(await rowFor(a, 'coordinator2', name)).toMatchObject({ status: 'pending', locked: false, reservation: null });
            expect(await rowFor(b, 'coordinator2', name)).toMatchObject({ status: 'in_planning', locked: true });

            const all = await release();
            expect(all.body.released).toBe(1);
            expect(await rowFor(b, 'coordinator2', name)).toMatchObject({ status: 'pending', locked: false, reservation: null });
            expect((await reserve([a, b], 'coordinator2')).status).toBe(201);
        });

        it('un coordinador no puede liberar la reserva de otro', async () => {
            const name = `${tag} Reserva7`;
            const id = await insert({ name });
            await reserve([id]);
            const res = await release({ dispatchIds: [id] }, 'coordinator2');
            expect(res.status).toBe(200);
            expect(res.body.released).toBe(0);
            expect(await rowFor(id, 'coordinator2', name)).toMatchObject({ locked: true });
        });

        it('valida el cuerpo de liberar → 400', async () => {
            for (const body of [{ dispatchIds: [] }, { dispatchIds: ['a'] }, { dispatchIds: [1, 1] }, { nope: 1 }]) {
                expect((await release(body)).status, JSON.stringify(body)).toBe(400);
            }
        });
    });

    // ── Renovación ─────────────────────────────────────────────────────────────
    describe('renovación', () => {
        it('la actividad del coordinador empuja el vencimiento de todas sus reservas vivas', async () => {
            const name = `${tag} Renueva1`;
            const a = await insert({ name });
            const b = await insert({ name });
            await reserve([a, b]);
            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() + INTERVAL '1 minute' WHERE dispatch_id = ANY($1)`, [[a, b]]);

            const res = await renew();
            expect(res.status).toBe(200);
            expect(res.body.renewed).toBeGreaterThanOrEqual(2);
            expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);

            const rows = await dataSource.query(`SELECT expires_at, last_activity_at FROM dispatch_reservations WHERE dispatch_id = ANY($1)`, [[a, b]]);
            for (const row of rows) expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
        });

        it('renovar solo toca las reservas propias', async () => {
            const name = `${tag} Renueva2`;
            const id = await insert({ name });
            await reserve([id]);
            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() + INTERVAL '1 minute' WHERE dispatch_id = $1`, [id]);
            await renew('coordinator2');
            const [{ expires_at }] = await dataSource.query(`SELECT expires_at FROM dispatch_reservations WHERE dispatch_id = $1`, [id]);
            expect(new Date(expires_at).getTime()).toBeLessThan(Date.now() + 2 * 60_000);
        });

        it('una reserva ya vencida no se resucita al renovar', async () => {
            const name = `${tag} Renueva3`;
            const id = await insert({ name });
            await reserve([id]);
            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() - INTERVAL '1 minute' WHERE dispatch_id = $1`, [id]);
            await renew();
            const row = (await mine(`search=${encodeURIComponent(name)}`, 'coordinator2')).body.data.find((r: any) => r.id === id);
            expect(row).toMatchObject({ status: 'pending', locked: false, reservation: null });
        });

        it('sin reservas vivas responde renewed: 0', async () => {
            await release();
            const res = await renew();
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ renewed: 0, expiresAt: null });
        });
    });

    // ── Expiración ─────────────────────────────────────────────────────────────
    describe('expiración', () => {
        it('una reserva vencida deja de bloquear: el pedido vuelve a verse libre y en su estado', async () => {
            const name = `${tag} Expira1`;
            const id = await insert({ name });
            await reserve([id]);
            expect(await (async () => (await mine(`search=${encodeURIComponent(name)}`, 'coordinator2')).body.data[0])()).toMatchObject({ locked: true });

            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE dispatch_id = $1`, [id]);
            const row = (await mine(`search=${encodeURIComponent(name)}`, 'coordinator2')).body.data[0];
            expect(row).toMatchObject({ status: 'pending', locked: false, reservation: null });
        });

        it('otro coordinador puede tomar un pedido cuya reserva venció', async () => {
            const name = `${tag} Expira2`;
            const id = await insert({ name });
            await reserve([id]);
            expect((await reserve([id], 'coordinator2')).status).toBe(409);

            await dataSource.query(`UPDATE dispatch_reservations SET expires_at = NOW() - INTERVAL '1 second' WHERE dispatch_id = $1`, [id]);
            expect((await reserve([id], 'coordinator2')).status).toBe(201);
            const row = (await mine(`search=${encodeURIComponent(name)}`, 'coordinator')).body.data[0];
            expect(row).toMatchObject({ status: 'in_planning', locked: true, reservation: { reservedById: userIds.coordinator2, reservedByName: fullNames.coordinator2 } });
        });

        it('el tiempo de vida sale de order_reservation_ttl_minutes (15 por defecto)', async () => {
            const name = `${tag} Expira3`;
            const id = await insert({ name });
            const before = await reserve([id]);
            expect(new Date(before.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
            await release();

            try {
                await dataSource.query(`UPDATE settings SET setting_value = '5' WHERE setting_key = 'order_reservation_ttl_minutes'`);
                await settings.refresh();
                const res = await reserve([id]);
                const ms = new Date(res.body.expiresAt).getTime() - Date.now();
                expect(ms).toBeGreaterThan(4 * 60_000);
                expect(ms).toBeLessThanOrEqual(5 * 60_000 + 5_000);
                const renewed = await renew();
                expect(new Date(renewed.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 5_000);
            } finally {
                await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = 'order_reservation_ttl_minutes'`, [originalTtl ?? '15']);
                await settings.refresh();
                await release();
            }
        });

        it('si el valor de la clave no es válido se usa el valor por defecto de 15 minutos', async () => {
            const id = await insert({ name: `${tag} Expira4` });
            try {
                await dataSource.query(`UPDATE settings SET setting_value = 'abc' WHERE setting_key = 'order_reservation_ttl_minutes'`);
                await settings.refresh();
                const res = await reserve([id]);
                expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
            } finally {
                await dataSource.query(`UPDATE settings SET setting_value = $1 WHERE setting_key = 'order_reservation_ttl_minutes'`, [originalTtl ?? '15']);
                await settings.refresh();
                await release();
            }
        });

        it('borrar el despacho borra su reserva', async () => {
            const id = await insert({ name: `${tag} Expira5` });
            await reserve([id]);
            await dataSource.query(`DELETE FROM dispatches WHERE dispatch_id = $1`, [id]);
            const [{ count }] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM dispatch_reservations WHERE dispatch_id = $1`, [id]);
            expect(count).toBe(0);
        });
    });
});
