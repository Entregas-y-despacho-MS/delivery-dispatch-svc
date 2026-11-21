// RF-A35 / ST-68.2: audit trail of the sensitive handlers of the "planning and route batches" family
// (planning.run, route_batch.approved, route_batch.assignment_changed): one allowed and one denied operation of each,
// against the real AppModule and database. The plan generator and the cutoff are replaced by doubles (their real runs
// are test/plan-generation.e2e-spec.ts and test/route-cutoff.e2e-spec.ts); the batches it creates are deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';
import { PlanGenerationService } from '../src/app/planning/services/plan-generation.service.js';
import { RouteCutoffService } from '../src/app/route-cutoff/services/route-cutoff.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('audit of planning and route batches (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-batches');
    const batchIds: number[] = [];
    const MISSING = 999_999_999;

    const insertBatch = async (reviewer: number): Promise<number> => {
        const [{ route_batch_id }] = await h.db.query(
            `INSERT INTO route_batches (status, shift_date, reviewer_user_id) VALUES ('provisional', CURRENT_DATE + 61, $1) RETURNING route_batch_id`,
            [reviewer],
        );
        batchIds.push(route_batch_id);
        return route_batch_id as number;
    };
    const reviewerOf = async (id: number): Promise<number> =>
        (await h.db.query('SELECT reviewer_user_id FROM route_batches WHERE route_batch_id = $1', [id]))[0].reviewer_user_id;

    beforeAll(async () => {
        await h.start(['admin', 'coordinator', 'supervisor', 'driver'], (builder) => builder
            .overrideProvider(PlanGenerationService).useValue({ run: async () => ({ status: 'executed' }) })
            .overrideProvider(RouteCutoffService).useValue({ run: async () => ({ status: 'executed' }) }));
    }, 30_000);
    afterAll(async () => {
        if (h.db?.isInitialized) {
            await withEventPurge(h.db, { routeBatchIds: batchIds, userNames: [`${h.prefix}-%`] });
            if (batchIds.length) await h.db.query('DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])', [batchIds]);
        }
        await h.close();
    });

    describe('planning.run', () => {
        it.each(['generate', 'cutoff'] as const)('records POST /planning/%s by the coordinator', async (task) => {
            const { correlationId, response } = h.call('post', `/planning/${task}`, h.users.coordinator.token);
            expect((await response).status).toBe(200);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'planning.run', entity_type: 'planning',
                entity_id: null, result: 'success', status_code: 200, metadata: { task },
            })]);
        });

        it.each(['generate', 'cutoff'] as const)('records the denial of the supervisor on POST /planning/%s', async (task) => {
            const { correlationId, response } = h.call('post', `/planning/${task}`, h.users.supervisor.token);
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'planning.run', result: 'denied', status_code: 403, metadata: { task },
            })]);
        });
    });

    describe('route_batch.assignment_changed', () => {
        it('records the reassignment of the reviewer with the batch as the entity and the new reviewer', async () => {
            const id = await insertBatch(h.users.coordinator.id);
            const { correlationId, response } = h.call('patch', `/route-batches/${id}/reviewer`, h.users.coordinator.token, {
                reviewerUserId: h.users.supervisor.id, reason: 'e2e hand over',
            });
            expect((await response).status).toBe(200);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'route_batch.assignment_changed',
                entity_type: 'route_batch', entity_id: String(id), result: 'success', status_code: 200,
                metadata: { reviewerUserId: h.users.supervisor.id, target: 'reviewer' },
            })]);
            expect(JSON.stringify(rows)).not.toContain('e2e hand over');
            expect(await reviewerOf(id)).toBe(h.users.supervisor.id);
        });

        it('records the denial of a driver on the reviewer, the driver, the vehicle and the stops, and changes nothing', async () => {
            const id = await insertBatch(h.users.coordinator.id);
            const attempts = [
                { method: 'patch', path: `/route-batches/${id}/reviewer`, body: { reviewerUserId: h.users.supervisor.id }, target: 'reviewer' },
                { method: 'patch', path: `/route-batches/${id}/driver`, body: { driverId: h.users.driver.id, version: 1 }, target: 'driver' },
                { method: 'patch', path: `/route-batches/${id}/vehicle`, body: { vehicleId: 1, version: 1 }, target: 'vehicle' },
                { method: 'post', path: `/route-batches/${id}/reassign`, body: { dispatchIds: [1], targetBatchId: id + 1, reasonCode: 'X', version: 1, targetVersion: 1 }, target: 'stops' },
            ] as const;
            for (const { method, path, body, target } of attempts) {
                const { correlationId, response } = h.call(method, path, h.users.driver.token, body);
                expect((await response).status).toBe(403);
                expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.driver.id, actor_role: 'driver', action: 'route_batch.assignment_changed',
                    entity_id: String(id), result: 'denied', status_code: 403, metadata: expect.objectContaining({ target }),
                })]);
            }
            expect(await reviewerOf(id)).toBe(h.users.coordinator.id);
        });

        it('records a batch that does not exist as failed, on the driver, the vehicle and the stops', async () => {
            const attempts = [
                { method: 'patch', path: `/route-batches/${MISSING}/driver`, body: { driverId: h.users.driver.id, version: 1 }, target: 'driver' },
                { method: 'patch', path: `/route-batches/${MISSING}/vehicle`, body: { vehicleId: 1, version: 1 }, target: 'vehicle' },
                { method: 'post', path: `/route-batches/${MISSING}/reassign`, body: { dispatchIds: [1], targetBatchId: MISSING - 1, reasonCode: 'X', version: 1, targetVersion: 1 }, target: 'stops' },
            ] as const;
            for (const { method, path, body, target } of attempts) {
                const { correlationId, response } = h.call(method, path, h.users.coordinator.token, body);
                expect((await response).status).toBe(404);
                expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.coordinator.id, action: 'route_batch.assignment_changed',
                    entity_id: String(MISSING), result: 'failed', status_code: 404, metadata: expect.objectContaining({ target }),
                })]);
            }
        });
    });

    describe('route_batch.approved', () => {
        it.each([['approve-promises', 'promises'], ['approve-final', 'final']] as const)(
            'records POST /route-batches/:id/%s: denied for a driver, failed for a missing batch (stage %s)', async (path, stage) => {
                const id = await insertBatch(h.users.coordinator.id);
                const body = { version: 1, dispatches: [{ dispatchId: 1, version: 1 }] };
                const denied = h.call('post', `/route-batches/${id}/${path}`, h.users.driver.token, body);
                expect((await denied.response).status).toBe(403);
                expect(await h.eventsOf(denied.correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.driver.id, action: 'route_batch.approved', entity_type: 'route_batch',
                    entity_id: String(id), result: 'denied', status_code: 403, metadata: { stage },
                })]);

                const missing = h.call('post', `/route-batches/${MISSING}/${path}`, h.users.coordinator.token, body);
                expect((await missing.response).status).toBe(404);
                expect(await h.eventsOf(missing.correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.coordinator.id, action: 'route_batch.approved',
                    entity_id: String(MISSING), result: 'failed', status_code: 404, metadata: { stage },
                })]);
            },
        );

        it('records an approval attempt without a token with no actor', async () => {
            const { correlationId, response } = h.call('post', `/route-batches/${MISSING}/approve-final`, null, { version: 1, dispatches: [{ dispatchId: 1, version: 1 }] });
            expect((await response).status).toBe(401);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: null, action: 'route_batch.approved', result: 'denied', status_code: 401,
            })]);
        });
    });
});
