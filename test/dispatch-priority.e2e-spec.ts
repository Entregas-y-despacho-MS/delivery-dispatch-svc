// ST-58.2 (RF-A11) — cambio manual de la prioridad de un despacho y orden de la bandeja.
//
// Levanta el AppModule real contra una base de datos real y pega por HTTP con supertest. Seguro de
// re-correr contra una base compartida: todo lo que crea lleva un prefijo único por corrida y se borra en afterAll.
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

const TZ = 'America/La_Paz';

describe('Prioridad del despacho (e2e, ST-58.2)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const statusIds: Record<string, number> = {};
    const levels: Record<string, number> = {};
    let deliveryTypeId: number;

    const run = Date.now().toString(36).toUpperCase();
    const tag = `P${run}`;
    let seq = 0;

    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const patch = (id: number | string, body: object = {}, role = 'coordinator') =>
        request(app.getHttpServer()).patch(`/${apiPrefix}/dispatches/${id}/priority`).set(auth(role)).send(body);
    const inbox = (qs: string, role = 'coordinator') =>
        request(app.getHttpServer()).get(`/${apiPrefix}/pending-orders?limit=100&${qs}`).set(auth(role));

    const insert = async (o: { status?: string; priority?: string; level?: string | null; name?: string } = {}): Promise<number> => {
        const n = ++seq;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, service_level_id, source_order_ref, priority,
                                     delivery_address, contact_name, tracking_code, scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, $4, $5, 'Dirección de prueba', $6, $7,
                     ((NOW() AT TIME ZONE '${TZ}')::date + TIME '09:00') AT TIME ZONE '${TZ}',
                     ((NOW() AT TIME ZONE '${TZ}')::date + TIME '12:00') AT TIME ZONE '${TZ}')
             RETURNING dispatch_id`,
            [
                deliveryTypeId, statusIds[o.status ?? 'pending'],
                o.level ? levels[o.level] : null,
                `${tag}-${String(n).padStart(3, '0')}`, o.priority ?? 'normal',
                o.name ?? `${tag} Cliente ${n}`, `${tag}${n}`,
            ],
        );
        return dispatch_id as number;
    };

    const row = async (id: number) => (await dataSource.query(
        `SELECT priority, dispatch_status_id, service_level_id, scheduled_window_start, scheduled_window_end, created_at
           FROM dispatches WHERE dispatch_id = $1`, [id]))[0];
    const events = async (id: number) => await dataSource.query(
        `SELECT event_type, actor_user_id, actor_type, metadata FROM dispatch_events
          WHERE dispatch_id = $1 AND event_type = 'priority_changed' ORDER BY dispatch_event_id`, [id]);

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

        const passwordHash = await hashPassword('E2eTest1234');
        for (const role of ['coordinator', 'supervisor', 'admin', 'driver']) {
            const [{ role_id }] = await dataSource.query(`SELECT role_id FROM roles WHERE name = $1`, [role]);
            const username = `e2e_pri_${role}_${run}`;
            const [{ user_id }] = await dataSource.query(
                `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change)
                 VALUES ($1, $2, $3, $4, false) RETURNING user_id`,
                [role_id, `Prioridad ${role} ${run}`, username, passwordHash],
            );
            userIds[role] = user_id;
            const res = await request(app.getHttpServer())
                .post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[role] = res.body.accessToken as string;
        }

        for (const r of await dataSource.query(`SELECT dispatch_status_id AS id, name FROM dispatch_statuses`)) statusIds[r.name] = r.id;
        [{ dispatch_type_id: deliveryTypeId }] = await dataSource.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);

        for (const [key, minutes] of [['s30', 30], ['s60', 60], ['s120', 120]] as const) {
            const [{ service_level_id }] = await dataSource.query(
                `INSERT INTO service_levels (name, target_time_min, priority_level) VALUES ($1, $2, 1) RETURNING service_level_id`,
                [`${tag}-${key}`, minutes],
            );
            levels[key] = service_level_id;
        }
    });

    afterAll(async () => {
        await withEventPurge(dataSource, { dispatchRefs: [`${tag}%`], userNames: [`e2e_pri_%_${run}`] });
        await dataSource.query(`DELETE FROM dispatches WHERE source_order_ref LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`${tag}%`]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [`e2e_pri_%_${run}`]);
        await app.close();
    });

    describe('permisos', () => {
        it('sin token → 401', async () => {
            const id = await insert();
            const res = await request(app.getHttpServer()).patch(`/${apiPrefix}/dispatches/${id}/priority`).send({ priority: 'urgent' });
            expect(res.status).toBe(401);
        });

        it('admin y driver → 403 y no cambia nada; coordinator y supervisor → 200', async () => {
            const id = await insert();
            expect((await patch(id, { priority: 'urgent' }, 'admin')).status).toBe(403);
            expect((await patch(id, { priority: 'urgent' }, 'driver')).status).toBe(403);
            expect((await row(id)).priority).toBe('normal');

            expect((await patch(id, { priority: 'urgent' }, 'supervisor')).status).toBe(200);
            expect((await patch(id, { priority: 'normal' }, 'coordinator')).status).toBe(200);
        });
    });

    describe('cambio manual', () => {
        it('normal → urgent: 200, queda guardado y registra el evento con el usuario que lo hizo', async () => {
            const id = await insert();

            const res = await patch(id, { priority: 'urgent' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ id, priority: 'urgent', status: 'pending' });
            expect((await row(id)).priority).toBe('urgent');
            const evs = await events(id);
            expect(evs).toHaveLength(1);
            expect(evs[0]).toMatchObject({
                actor_user_id: userIds.coordinator, actor_type: 'user', metadata: { from: 'normal', to: 'urgent' },
            });
        });

        it('urgent → normal registra un segundo evento, ahora con el supervisor', async () => {
            const id = await insert({ priority: 'urgent' });

            const res = await patch(id, { priority: 'normal' }, 'supervisor');

            expect(res.status).toBe(200);
            expect((await row(id)).priority).toBe('normal');
            const evs = await events(id);
            expect(evs).toHaveLength(1);
            expect(evs[0]).toMatchObject({ actor_user_id: userIds.supervisor, metadata: { from: 'urgent', to: 'normal' } });
        });

        it('no cambia el estado, el plazo, la franja ni el nivel de servicio (D-15)', async () => {
            const id = await insert({ status: 'scheduled', level: 's60' });
            const before = await row(id);

            expect((await patch(id, { priority: 'urgent' })).status).toBe(200);

            const after = await row(id);
            expect(after.dispatch_status_id).toBe(before.dispatch_status_id);
            expect(after.service_level_id).toBe(before.service_level_id);
            expect(after.created_at).toEqual(before.created_at);
            expect(after.scheduled_window_start).toEqual(before.scheduled_window_start);
            expect(after.scheduled_window_end).toEqual(before.scheduled_window_end);
        });

        it.each(['pending', 'in_planning', 'scheduled'])('se puede cambiar en estado %s', async (status) => {
            const id = await insert({ status });

            const res = await patch(id, { priority: 'urgent' });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe(status);
        });

        it('con la misma prioridad responde 200 y no registra otro evento', async () => {
            const id = await insert({ priority: 'urgent' });

            const res = await patch(id, { priority: 'urgent' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ id, priority: 'urgent', status: 'pending' });
            expect(await events(id)).toHaveLength(0);
        });

        it('acepta la prioridad en mayúsculas', async () => {
            const id = await insert();
            expect((await patch(id, { priority: 'URGENT' })).status).toBe(200);
            expect((await row(id)).priority).toBe('urgent');
        });
    });

    describe('estado no permitido', () => {
        it.each(['assigned', 'in_transit', 'delivered', 'cancelled', 'rescheduled', 'address_review'])(
            'en estado %s → 409 DISPATCH_PRIORITY_NOT_CHANGEABLE, sin cambio ni evento',
            async (status) => {
                if (statusIds[status] === undefined) return; // el catálogo de la base no lo trae
                const id = await insert({ status });

                const res = await patch(id, { priority: 'urgent' });

                expect(res.status).toBe(409);
                expect(res.body.error).toBe('DISPATCH_PRIORITY_NOT_CHANGEABLE');
                expect((await row(id)).priority).toBe('normal');
                expect(await events(id)).toHaveLength(0);
            },
        );
    });

    describe('validación', () => {
        it('despacho inexistente → 404', async () => {
            const res = await patch(2147483647, { priority: 'urgent' });
            expect(res.status).toBe(404);
            expect(res.body.error).toBe('DISPATCH_NOT_FOUND');
        });

        it('id no numérico → 400', async () => {
            expect((await patch('abc', { priority: 'urgent' })).status).toBe(400);
        });

        it('prioridad inválida, ausente o campos de más → 400', async () => {
            const id = await insert();
            expect((await patch(id, { priority: 'low' })).status).toBe(400);
            expect((await patch(id, {})).status).toBe(400);
            expect((await patch(id, { priority: 'urgent', status: 'delivered' })).status).toBe(400);
            expect((await row(id)).priority).toBe('normal');
        });
    });

    describe('orden de la bandeja', () => {
        const name = `${tag} Bandeja`;
        let normal30: number, normal60: number, normal120: number, urgent60: number;

        beforeAll(async () => {
            normal120 = await insert({ name, level: 's120' });
            normal60 = await insert({ name, level: 's60' });
            normal30 = await insert({ name, level: 's30' });
            urgent60 = await insert({ name, level: 's60', priority: 'urgent' });
        });

        const listed = async (qs = '') => (await inbox(`search=${encodeURIComponent(name)}&${qs}`)).body.data.map((r: any) => r.id);

        it('por defecto: urgentes primero y luego por vencimiento de SLA', async () => {
            expect(await listed()).toEqual([urgent60, normal30, normal60, normal120]);
        });

        it('al marcar uno urgente sube al tope y el resto conserva su orden', async () => {
            expect((await patch(normal120, { priority: 'urgent' })).status).toBe(200);

            // Entre urgentes manda el SLA (60 min antes que 120); entre normales, el SLA también.
            expect(await listed()).toEqual([urgent60, normal120, normal30, normal60]);
        });

        it('filtro solo urgentes: únicamente los urgentes, por vencimiento de SLA', async () => {
            expect(await listed('priority=urgent')).toEqual([urgent60, normal120]);
        });

        it('al volver a normal, deja de aparecer en el filtro de urgentes', async () => {
            expect((await patch(normal120, { priority: 'normal' })).status).toBe(200);

            expect(await listed('priority=urgent')).toEqual([urgent60]);
            expect(await listed()).toEqual([urgent60, normal30, normal60, normal120]);
        });
    });
});
