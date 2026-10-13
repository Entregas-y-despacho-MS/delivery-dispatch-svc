// ST-50.4 (D-42) — revisor del lote provisional: balance de carga, reasignación manual y automática,
// y lote sin revisor cuando no hay coordinadores activos.
//
// Levanta el AppModule real contra una base de datos real. Seguro de re-correr contra una base compartida:
//  - las pruebas de balance y de "sin coordinadores" corren dentro de una transacción que SIEMPRE se revierte
//    (desactivan a los demás coordinadores y crean lotes ahí dentro), así que no dejan rastro ni afectan a otros;
//  - lo que sí se confirma (endpoint manual, reasignación automática) lleva un prefijo único por corrida y se borra en afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { hashPassword } from '../src/shared/utils/crypto.util.js';
import { RouteBatchReviewerService } from '../src/modules/dispatch/route-batches/services/route-batch-reviewer.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

class Rollback extends Error {}

describe('Revisor del lote provisional (e2e, ST-50.4)', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let reviewers: RouteBatchReviewerService;
    let apiPrefix: string;
    const tokens: Record<string, string> = {};
    const userIds: Record<string, number> = {};
    const roleIds: Record<string, number> = {};
    const batchIds: number[] = [];

    const run = Date.now().toString(36).toUpperCase();
    const prefix = `e2e_rev_`;
    const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
    const reassign = (id: number | string, body: object, role = 'coordinator') =>
        request(app.getHttpServer()).patch(`/${apiPrefix}/route-batches/${id}/reviewer`).set(auth(role)).send(body);

    const createUser = async (key: string, role: string, opts: { active?: boolean; login?: boolean } = {}) => {
        const username = `${prefix}${key}_${run}`;
        const [{ user_id }] = await dataSource.query(
            `INSERT INTO users (role_id, full_name, username, password_hash, requires_pwd_change, active)
             VALUES ($1, $2, $3, $4, false, $5) RETURNING user_id`,
            [roleIds[role], `Revisor ${key} ${run}`, username, await hashPassword('E2eTest1234'), opts.active ?? true],
        );
        userIds[key] = user_id;
        if (opts.login) {
            const res = await request(app.getHttpServer()).post(`/${apiPrefix}/auth/login`).send({ username, password: 'E2eTest1234' });
            tokens[key] = res.body.accessToken as string;
        }
    };

    // shift_date lejano y sin conductor ni vehículo: no choca con los índices únicos ni con otros suites.
    const insertBatch = async (status: string, reviewer: number | null, manager: EntityManager | DataSource = dataSource, track = true): Promise<number> => {
        const [{ route_batch_id }] = await manager.query(
            `INSERT INTO route_batches (status, shift_date, reviewer_user_id) VALUES ($1, CURRENT_DATE + 60, $2) RETURNING route_batch_id`,
            [status, reviewer],
        );
        if (track) batchIds.push(route_batch_id);
        return route_batch_id as number;
    };
    const batch = async (id: number) => (await dataSource.query(`SELECT status, version, reviewer_user_id FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const eventsOf = async (id: number, manager: EntityManager | DataSource = dataSource) => await manager.query(
        `SELECT event_type, actor_user_id, actor_type, reason, metadata FROM route_batch_events WHERE route_batch_id = $1 ORDER BY route_batch_event_id`, [id]);

    // Todo lo que pase dentro se revierte: nada de lo que se haga aquí llega a la base.
    const inRollback = async (fn: (manager: EntityManager) => Promise<void>) => {
        try {
            await dataSource.transaction(async (manager) => { await fn(manager); throw new Rollback(); });
        } catch (error) {
            if (!(error instanceof Rollback)) throw error;
        }
    };
    const deactivateOtherCoordinators = async (manager: EntityManager, keepKeys: string[] = []) => {
        const keep = keepKeys.map((k) => userIds[k]);
        await manager.query(
            `UPDATE users SET active = FALSE
              WHERE role_id = $1 AND NOT (user_id = ANY($2::int[]))`,
            [roleIds.coordinator, keep],
        );
    };

    const waitFor = async <T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 5000): Promise<T> => {
        const started = Date.now();
        for (;;) {
            const value = await read();
            if (done(value) || Date.now() - started > timeoutMs) return value;
            await new Promise((r) => setTimeout(r, 100));
        }
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
        reviewers = app.get(RouteBatchReviewerService);

        for (const r of await dataSource.query(`SELECT role_id AS id, name FROM roles`)) roleIds[r.name] = r.id;

        // Orden de creación = orden de id: A < B < C (el desempate es por menor id).
        await createUser('coordinator', 'coordinator', { login: true });
        await createUser('coordB', 'coordinator');
        await createUser('coordC', 'coordinator');
        await createUser('inactive', 'coordinator', { active: false });
        await createUser('supervisor', 'supervisor', { login: true });
        await createUser('admin', 'admin', { login: true });
        await createUser('driver', 'driver', { login: true });
    });

    afterAll(async () => {
        const tag = `${prefix}%_${run}`;
        await withEventPurge(dataSource, { routeBatchIds: batchIds, userNames: [tag] });
        if (batchIds.length) await dataSource.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
        await dataSource.query(`DELETE FROM users WHERE username LIKE $1`, [tag]);
        await app.close();
    });

    describe('balance de carga al crear el lote', () => {
        it('va al coordinador activo con menos lotes provisionales pendientes y desempata por menor id', async () => {
            await inRollback(async (manager) => {
                await deactivateOtherCoordinators(manager, ['coordinator', 'coordB', 'coordC']);
                // A tiene 2 pendientes, B 1, C 0. Los lotes ya confirmados no cuentan como carga.
                await insertBatch('provisional', userIds.coordinator, manager, false);
                await insertBatch('provisional', userIds.coordinator, manager, false);
                await insertBatch('provisional', userIds.coordB, manager, false);
                for (let i = 0; i < 3; i++) await insertBatch('confirmed', userIds.coordC, manager, false);

                const first = await insertBatch('provisional', null, manager, false);
                expect(await reviewers.assignReviewer(first, { manager })).toEqual({ routeBatchId: first, reviewerUserId: userIds.coordC, changed: true });

                // Ahora B y C tienen 1 cada uno: gana el de menor id (B).
                const second = await insertBatch('provisional', null, manager, false);
                expect((await reviewers.assignReviewer(second, { manager })).reviewerUserId).toBe(userIds.coordB);

                // B=2, C=1, A=2 → C otra vez.
                const third = await insertBatch('provisional', null, manager, false);
                expect((await reviewers.assignReviewer(third, { manager })).reviewerUserId).toBe(userIds.coordC);

                const [event] = await eventsOf(first, manager);
                expect(event).toMatchObject({
                    event_type: 'reviewer_assigned', actor_user_id: null, actor_type: 'system',
                    metadata: { to: userIds.coordC, pendingBatches: 0, mode: 'automatic', trigger: 'batch_created' },
                });
            });
        });

        it('nunca elige a un coordinador inactivo, aunque sea el que menos carga tiene', async () => {
            await inRollback(async (manager) => {
                await deactivateOtherCoordinators(manager, ['coordinator', 'inactive']);
                await insertBatch('provisional', userIds.coordinator, manager, false);

                const id = await insertBatch('provisional', null, manager, false);
                const result = await reviewers.assignReviewer(id, { manager });

                expect(result.reviewerUserId).toBe(userIds.coordinator);
            });
        });

        it('un lote que ya tiene revisor no se toca ni registra otro evento', async () => {
            await inRollback(async (manager) => {
                const id = await insertBatch('provisional', userIds.coordB, manager, false);

                const result = await reviewers.assignReviewer(id, { manager });

                expect(result).toEqual({ routeBatchId: id, reviewerUserId: userIds.coordB, changed: false });
                expect(await eventsOf(id, manager)).toHaveLength(0);
            });
        });
    });

    describe('sin coordinadores activos', () => {
        it('el lote queda sin revisor (visible para todos) y se registra reviewer_unassigned', async () => {
            await inRollback(async (manager) => {
                await deactivateOtherCoordinators(manager);
                const id = await insertBatch('provisional', null, manager, false);

                const result = await reviewers.assignReviewer(id, { manager });

                expect(result).toEqual({ routeBatchId: id, reviewerUserId: null, changed: false });
                const [row] = await manager.query(`SELECT reviewer_user_id FROM route_batches WHERE route_batch_id = $1`, [id]);
                expect(row.reviewer_user_id).toBeNull();
                const [event] = await eventsOf(id, manager);
                expect(event).toMatchObject({
                    event_type: 'reviewer_unassigned', actor_user_id: null, actor_type: 'system',
                    metadata: { reason: 'no_active_coordinators' },
                });
            });
        });

        it('un supervisor activo no recibe lotes por balance: solo los coordinadores', async () => {
            await inRollback(async (manager) => {
                await deactivateOtherCoordinators(manager);
                const id = await insertBatch('provisional', null, manager, false);

                const result = await reviewers.assignReviewer(id, { manager });

                expect(result.reviewerUserId).toBeNull();
            });
        });
    });

    describe('reasignación manual (PATCH /route-batches/:id/reviewer)', () => {
        it('sin token → 401; admin y driver → 403 y no cambia nada; coordinator y supervisor → 200', async () => {
            const id = await insertBatch('provisional', userIds.coordinator);

            const anon = await request(app.getHttpServer()).patch(`/${apiPrefix}/route-batches/${id}/reviewer`).send({ reviewerUserId: userIds.coordB });
            expect(anon.status).toBe(401);
            expect((await reassign(id, { reviewerUserId: userIds.coordB }, 'admin')).status).toBe(403);
            expect((await reassign(id, { reviewerUserId: userIds.coordB }, 'driver')).status).toBe(403);
            expect((await batch(id)).reviewer_user_id).toBe(userIds.coordinator);

            expect((await reassign(id, { reviewerUserId: userIds.coordB }, 'supervisor')).status).toBe(200);
            expect((await reassign(id, { reviewerUserId: userIds.coordinator }, 'coordinator')).status).toBe(200);
        });

        it('pasa el lote completo a otro coordinador: 200, queda guardado, no cambia la versión y registra el evento con el usuario y el motivo', async () => {
            const id = await insertBatch('provisional', userIds.coordinator);

            const res = await reassign(id, { reviewerUserId: userIds.coordB, reason: 'Turno terminado' });

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ id, status: 'provisional', reviewerUserId: userIds.coordB, version: 0 });
            expect(await batch(id)).toMatchObject({ reviewer_user_id: userIds.coordB, version: 0, status: 'provisional' });
            expect(await eventsOf(id)).toEqual([expect.objectContaining({
                event_type: 'reviewer_reassigned', actor_user_id: userIds.coordinator, actor_type: 'user', reason: 'Turno terminado',
                metadata: { from: userIds.coordinator, to: userIds.coordB, mode: 'manual' },
            })]);
        });

        it('también puede pasarse a un supervisor, y asignarse un lote que estaba sin revisor', async () => {
            const id = await insertBatch('provisional', null);

            const res = await reassign(id, { reviewerUserId: userIds.supervisor });

            expect(res.status).toBe(200);
            expect(res.body.reviewerUserId).toBe(userIds.supervisor);
            expect((await eventsOf(id))[0].metadata).toEqual({ from: null, to: userIds.supervisor, mode: 'manual' });
        });

        it('con el mismo revisor responde 200 y no registra otro evento', async () => {
            const id = await insertBatch('provisional', userIds.coordB);

            const res = await reassign(id, { reviewerUserId: userIds.coordB });

            expect(res.status).toBe(200);
            expect(await eventsOf(id)).toHaveLength(0);
        });

        it('destino inactivo, admin, repartidor o inexistente → 409 ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE y no cambia nada', async () => {
            const id = await insertBatch('provisional', userIds.coordinator);

            for (const target of [userIds.inactive, userIds.admin, userIds.driver, 2_000_000_000]) {
                const res = await reassign(id, { reviewerUserId: target });
                expect(res.status).toBe(409);
                expect(res.body.error).toBe('ROUTE_BATCH_REVIEWER_NOT_ELIGIBLE');
            }
            expect((await batch(id)).reviewer_user_id).toBe(userIds.coordinator);
            expect(await eventsOf(id)).toHaveLength(0);
        });

        it.each(['pending_final_review', 'confirmed', 'in_execution', 'closed', 'cancelled'])('lote %s → 409 ROUTE_BATCH_NOT_PROVISIONAL', async (status) => {
            const id = await insertBatch(status, userIds.coordinator);

            const res = await reassign(id, { reviewerUserId: userIds.coordB });

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_PROVISIONAL');
            expect((await batch(id)).reviewer_user_id).toBe(userIds.coordinator);
        });

        it('lote inexistente → 404 ROUTE_BATCH_NOT_FOUND', async () => {
            const res = await reassign(2_000_000_000, { reviewerUserId: userIds.coordB });

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('ROUTE_BATCH_NOT_FOUND');
        });

        it('validación: id no numérico, reviewerUserId ausente/no entero/enorme, motivo vacío o demasiado largo → 400', async () => {
            const id = await insertBatch('provisional', userIds.coordinator);

            expect((await reassign('abc', { reviewerUserId: userIds.coordB })).status).toBe(400);
            expect((await reassign(id, {})).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: 'x' })).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: 1.5 })).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: 0 })).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: 9_999_999_999 })).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: userIds.coordB, reason: '' })).status).toBe(400);
            expect((await reassign(id, { reviewerUserId: userIds.coordB, reason: 'x'.repeat(501) })).status).toBe(400);
            expect((await batch(id)).reviewer_user_id).toBe(userIds.coordinator);
        });
    });

    describe('reasignación automática cuando el revisor deja de estar activo', () => {
        const putUser = (id: number, body: object) =>
            request(app.getHttpServer()).put(`/${apiPrefix}/users/${id}`).set(auth('admin')).send(body);

        it('al desactivar al revisor, sus lotes provisionales pasan completos a otro coordinador activo y queda el evento del sistema', async () => {
            await createUser('leaving', 'coordinator');
            const mine = await insertBatch('provisional', userIds.leaving);
            const other = await insertBatch('provisional', userIds.leaving);
            const confirmed = await insertBatch('confirmed', userIds.leaving);

            const res = await putUser(userIds.leaving, { active: false });
            expect(res.status).toBe(200);

            const moved = await waitFor(() => batch(mine), (b) => b.reviewer_user_id !== userIds.leaving);
            expect(moved.reviewer_user_id).not.toBeNull();
            expect(moved.reviewer_user_id).not.toBe(userIds.leaving);
            expect((await batch(other)).reviewer_user_id).not.toBe(userIds.leaving);
            // Un lote que ya no está en revisión no se toca.
            expect((await batch(confirmed)).reviewer_user_id).toBe(userIds.leaving);

            const evs = await eventsOf(mine);
            expect(evs).toHaveLength(1);
            expect(evs[0]).toMatchObject({
                event_type: 'reviewer_reassigned', actor_user_id: null, actor_type: 'system',
                metadata: { from: userIds.leaving, to: moved.reviewer_user_id, mode: 'automatic', trigger: 'user_deactivated' },
            });
        });

        it('al cambiarle el rol a repartidor, también pierde sus lotes en revisión', async () => {
            await createUser('retired', 'coordinator');
            const id = await insertBatch('provisional', userIds.retired);

            const res = await request(app.getHttpServer())
                .patch(`/${apiPrefix}/users/${userIds.retired}/role`).set(auth('admin')).send({ roleId: roleIds.driver });
            expect(res.status).toBe(200);

            const moved = await waitFor(() => batch(id), (b) => b.reviewer_user_id !== userIds.retired);
            expect(moved.reviewer_user_id).not.toBe(userIds.retired);
            expect((await eventsOf(id))[0]).toMatchObject({ event_type: expect.stringMatching(/^reviewer_(reassigned|unassigned)$/), actor_type: 'system' });
        });

        it('el barrido es idempotente: volver a correrlo no cambia nada', async () => {
            const before = await reviewers.reassignFromIneligibleReviewers();
            const again = await reviewers.reassignFromIneligibleReviewers();

            expect(again).toEqual([]);
            expect(before.every((r) => r.changed)).toBe(true);
        });
    });
});
