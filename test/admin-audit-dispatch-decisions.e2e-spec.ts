// RF-A35 / ST-68.2: audit trail of the sensitive handlers of the "dispatch decisions" family (dispatch.cancelled,
// dispatch.rescheduled, tracking_link.revealed), against the real AppModule and database. Succeeding operations are
// checked for the priority change, the cancellation of a dispatch and the reveal of the tracking link; reschedule,
// return and the cancellation of a pickup order are checked as denied and as failed (a missing dispatch), because
// their success fixtures (delivery slots, a real pickup) live in their own e2e files. The dispatches it creates are
// deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

describe('audit of dispatch decisions (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-dispatch');
    const tag = `E2EAUD${Date.now().toString(36).toUpperCase()}`;
    const MISSING = 999_999_999;
    let sequence = 0;
    const trackingBase = Date.now() % 90_000; // the outbound message needs a DSP-YYYY-NNNNN tracking code
    let typeId = 0;
    const statusIds: Record<string, number> = {};

    const insertDispatch = async (status = 'pending'): Promise<number> => {
        const n = ++sequence;
        const [{ dispatch_id }] = await h.db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, priority, delivery_address, contact_name, tracking_code,
                                     scheduled_window_start, scheduled_window_end)
             VALUES ($1, $2, $3, 'normal', 'Dirección de prueba', $4, $5, NOW() + INTERVAL '2 days', NOW() + INTERVAL '2 days 3 hours')
             RETURNING dispatch_id`,
            [typeId, statusIds[status], `${tag}-${String(n).padStart(3, '0')}`, `${tag} Cliente ${n}`, `DSP-2042-${String(trackingBase + n).padStart(5, '0')}`],
        );
        return dispatch_id as number;
    };
    const statusOf = async (id: number): Promise<string> =>
        (await h.db.query(`SELECT s.name FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0].name;
    const priorityOf = async (id: number): Promise<string> =>
        (await h.db.query('SELECT priority FROM dispatches WHERE dispatch_id = $1', [id]))[0].priority;

    beforeAll(async () => {
        await h.start(['admin', 'coordinator', 'supervisor', 'driver']);
        [{ dispatch_type_id: typeId }] = await h.db.query(`SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'`);
        for (const row of await h.db.query('SELECT dispatch_status_id, name FROM dispatch_statuses')) statusIds[row.name] = row.dispatch_status_id;
    }, 30_000);
    afterAll(async () => {
        if (h.db?.isInitialized) {
            await withEventPurge(h.db, { dispatchRefs: [`${tag}%`], userNames: [`${h.prefix}-%`] });
            await h.db.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${tag}%`]);
        }
        await h.close();
    });

    describe('dispatch.rescheduled', () => {
        it('records the priority change by the coordinator with the dispatch as the entity and the new priority', async () => {
            const id = await insertDispatch();
            const { correlationId, response } = h.call('patch', `/dispatches/${id}/priority`, h.users.coordinator.token, { priority: 'urgent' });
            expect((await response).status).toBe(200);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'dispatch.rescheduled', entity_type: 'dispatch',
                entity_id: String(id), result: 'success', status_code: 200, metadata: { priority: 'urgent', operation: 'priority' },
            })]);
            expect(await priorityOf(id)).toBe('urgent');
        });

        it('records the denial of a driver on the priority change and leaves the dispatch unchanged', async () => {
            const id = await insertDispatch();
            const { correlationId, response } = h.call('patch', `/dispatches/${id}/priority`, h.users.driver.token, { priority: 'urgent' });
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.driver.id, action: 'dispatch.rescheduled', entity_id: String(id), result: 'denied', status_code: 403,
            })]);
            expect(await priorityOf(id)).toBe('normal');
        });

        it('records the denial of the supervisor on the reschedule and the return, and a missing dispatch as failed', async () => {
            const id = await insertDispatch();
            const slot = { windowStart: '2030-01-15T13:00:00Z', windowEnd: '2030-01-15T15:00:00Z' };
            const attempts = [
                { path: 'reschedule', body: { reasonCode: 'RES-OPS-ROUTE', ...slot }, operation: 'reschedule' },
                { path: 'return', body: {}, operation: 'return' },
            ] as const;
            for (const { path, body, operation } of attempts) {
                const denied = h.call('post', `/dispatches/${id}/${path}`, h.users.supervisor.token, body);
                expect((await denied.response).status).toBe(403);
                expect(await h.eventsOf(denied.correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.supervisor.id, action: 'dispatch.rescheduled', entity_id: String(id),
                    result: 'denied', status_code: 403, metadata: expect.objectContaining({ operation }),
                })]);

                const missing = h.call('post', `/dispatches/${MISSING}/${path}`, h.users.coordinator.token, body);
                const missingRes = await missing.response;
                expect(missingRes.status).toBe(404);
                expect(await h.eventsOf(missing.correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users.coordinator.id, action: 'dispatch.rescheduled', entity_id: String(MISSING),
                    result: 'failed', status_code: 404, metadata: expect.objectContaining({ operation }),
                })]);
            }
            expect(await statusOf(id)).toBe('pending');
        });
    });

    describe('dispatch.cancelled', () => {
        it('records the cancellation by the coordinator with the dispatch as the entity and without the reason text', async () => {
            const id = await insertDispatch();
            const reason = 'e2e secret reason text';
            const { correlationId, response } = h.call('post', `/dispatches/${id}/cancel`, h.users.coordinator.token, { reason });
            const res = await response;
            expect(res.status).toBe(200);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'dispatch.cancelled', entity_type: 'dispatch',
                entity_id: String(id), result: 'success', status_code: 200, metadata: {},
            })]);
            expect(JSON.stringify(rows)).not.toContain(reason);
            expect(await statusOf(id)).toBe('cancelled');
        });

        it('records the denial of the supervisor on the cancellation and keeps the dispatch', async () => {
            const id = await insertDispatch();
            const { correlationId, response } = h.call('post', `/dispatches/${id}/cancel`, h.users.supervisor.token, { reason: 'e2e' });
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'dispatch.cancelled', entity_id: String(id), result: 'denied', status_code: 403,
            })]);
            expect(await statusOf(id)).toBe('pending');
        });

        it('records PATCH /pickup-orders/:id/cancel: denied for the supervisor, failed for a missing order', async () => {
            const denied = h.call('patch', `/pickup-orders/${MISSING}/cancel`, h.users.supervisor.token, { reason: 'e2e' });
            expect((await denied.response).status).toBe(403);
            expect(await h.eventsOf(denied.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'dispatch.cancelled', entity_id: String(MISSING),
                result: 'denied', status_code: 403, metadata: {},
            })]);

            const missing = h.call('patch', `/pickup-orders/${MISSING}/cancel`, h.users.coordinator.token, { reason: 'e2e' });
            const missingRes = await missing.response;
            expect(missingRes.status).toBe(404);
            expect(await h.eventsOf(missing.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'dispatch.cancelled', entity_id: String(MISSING),
                result: 'failed', status_code: 404, metadata: {},
            })]);
        });
    });

    describe('tracking_link.revealed', () => {
        it('records the denial of the supervisor, who can read the list but not the customer credential', async () => {
            const { correlationId, response } = h.call('post', `/dispatches/change-requests/${MISSING}/tracking-link`, h.users.supervisor.token);
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'tracking_link.revealed', entity_type: 'dispatch',
                entity_id: String(MISSING), result: 'denied', status_code: 403, metadata: {},
            })]);
        });

        it('records the reveal by the coordinator as success, with the dispatch as the entity and never the link or the token', async () => {
            const id = await insertDispatch('scheduled');
            const token = `${tag.toLowerCase()}-token-${id}`;
            await h.db.query(
                `UPDATE dispatches SET customer_confirmation = 'change_requested', contact_email = NULL, tracking_token = $2, tracking_token_expires_at = NOW() + INTERVAL '1 day' WHERE dispatch_id = $1`,
                [id, token],
            );
            const { correlationId, response } = h.call('post', `/dispatches/change-requests/${id}/tracking-link`, h.users.coordinator.token);
            const res = await response;
            expect(res.status).toBe(200);
            expect(res.body.trackingUrl).toContain(token); // the coordinator does get the link...
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'tracking_link.revealed', entity_type: 'dispatch',
                entity_id: String(id), result: 'success', status_code: 200, metadata: {},
            })]);
            expect(JSON.stringify(rows)).not.toContain(token); // ...and the audit trail never does
            expect(JSON.stringify(rows)).not.toMatch(/seguimiento|http/);
        });

        it('records the attempt of the coordinator on a dispatch that does not exist as failed, never with a link', async () => {
            const { correlationId, response } = h.call('post', `/dispatches/change-requests/${MISSING}/tracking-link`, h.users.coordinator.token);
            const res = await response;
            expect(res.status).toBe(404);
            const rows = await h.eventsOf(correlationId);
            expect(rows).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'tracking_link.revealed', entity_id: String(MISSING),
                result: 'failed', status_code: 404, metadata: {},
            })]);
            expect(JSON.stringify(rows)).not.toMatch(/trackingUrl|\/public\/tracking|https?:\/\//);
        });
    });
});
