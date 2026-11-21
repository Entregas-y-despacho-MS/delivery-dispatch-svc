// RF-A35 / ST-68.2: audit trail of the sensitive handlers of the "fleet" family (vehicle.changed): one allowed and
// one denied operation of each, against the real AppModule and database. The vehicles it creates are deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

describe('audit of the fleet (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-fleet');
    const tag = Date.now().toString(36).toUpperCase();
    let sequence = 0;
    const vehicleBody = () => ({ type: 'Van', model: 'E2E', plate: `V${tag}${++sequence}`, capacityKg: 500, capacityM3: 4 });

    beforeAll(async () => { await h.start(['admin', 'coordinator', 'supervisor', 'driver']); }, 30_000);
    afterAll(async () => {
        if (h.db?.isInitialized) {
            const ids = (await h.db.query('SELECT vehicle_id FROM vehicles WHERE plate LIKE $1', [`V${tag}%`])).map((row: { vehicle_id: number }) => row.vehicle_id);
            if (ids.length) {
                await h.db.query('DELETE FROM vehicles WHERE vehicle_id = ANY($1::int[])', [ids]);
            }
        }
        await h.close();
    });

    it.each(['supervisor', 'coordinator'] as const)('records the creation, status change, edit and deletion by the %s', async (role) => {
        const token = h.users[role].token;
        const actor = { actor_user_id: h.users[role].id, actor_role: role, action: 'vehicle.changed', entity_type: 'vehicle' };

        const created = h.call('post', '/vehicles', token, vehicleBody());
        const createdRes = await created.response;
        expect(createdRes.status).toBe(201);
        const id = String(createdRes.body.id);
        expect(await h.eventsOf(created.correlationId)).toEqual([expect.objectContaining({
            ...actor, entity_id: id, result: 'success', status_code: 201, metadata: { operation: 'create' },
        })]);

        const status = h.call('patch', `/vehicles/${id}/status`, token, { status: 'maintenance', reason: 'e2e check' });
        expect((await status.response).status).toBe(200);
        const statusRows = await h.eventsOf(status.correlationId);
        expect(statusRows).toEqual([expect.objectContaining({
            ...actor, entity_id: id, result: 'success', status_code: 200, metadata: { status: 'maintenance', operation: 'status' },
        })]);
        expect(JSON.stringify(statusRows)).not.toContain('e2e check');

        const updated = h.call('put', `/vehicles/${id}`, token, { model: 'E2E 2' });
        expect((await updated.response).status).toBe(200);
        expect(await h.eventsOf(updated.correlationId)).toEqual([expect.objectContaining({
            ...actor, entity_id: id, result: 'success', status_code: 200, metadata: { operation: 'update' },
        })]);

        const removed = h.call('delete', `/vehicles/${id}`, token);
        expect((await removed.response).status).toBe(204);
        expect(await h.eventsOf(removed.correlationId)).toEqual([expect.objectContaining({
            ...actor, entity_id: id, result: 'success', status_code: 204, metadata: { operation: 'delete' },
        })]);
    });

    it.each(['admin', 'driver'] as const)('records the denial of the %s on every operation and changes nothing', async (role) => {
        const token = h.users[role].token;
        const [{ vehicle_id }] = await h.db.query(
            `INSERT INTO vehicles (vehicle_status_id, type, model, plate, capacity_kg, capacity_m3) VALUES ((SELECT vehicle_status_id FROM vehicle_statuses WHERE name = 'active'), 'Van', 'E2E', $1, 500, 4) RETURNING vehicle_id`,
            [`V${tag}D${role === 'admin' ? 1 : 2}`],
        );
        const id = String(vehicle_id);
        const attempts = [
            { method: 'post', path: '/vehicles', body: vehicleBody(), operation: 'create', entity: null },
            { method: 'patch', path: `/vehicles/${id}/status`, body: { status: 'maintenance', reason: 'e2e' }, operation: 'status', entity: id },
            { method: 'put', path: `/vehicles/${id}`, body: { model: 'Hacked' }, operation: 'update', entity: id },
            { method: 'delete', path: `/vehicles/${id}`, body: undefined, operation: 'delete', entity: id },
        ] as const;
        for (const { method, path, body, operation, entity } of attempts) {
            const { correlationId, response } = h.call(method, path, token, body);
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users[role].id, actor_role: role, action: 'vehicle.changed', entity_id: entity,
                result: 'denied', status_code: 403, metadata: expect.objectContaining({ operation }),
            })]);
        }
        const [row] = await h.db.query('SELECT model, deleted_at FROM vehicles WHERE vehicle_id = $1', [vehicle_id]);
        expect(row).toEqual({ model: 'E2E', deleted_at: null });
    });

    it('records a vehicle that does not exist as failed with the requested id', async () => {
        const { correlationId, response } = h.call('delete', '/vehicles/999999999', h.users.supervisor.token);
        expect((await response).status).toBe(404);
        expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
            action: 'vehicle.changed', entity_id: '999999999', result: 'failed', status_code: 404,
        })]);
    });

    it('records an attempt without a token with no actor', async () => {
        const { correlationId, response } = h.call('post', '/vehicles', null, vehicleBody());
        expect((await response).status).toBe(401);
        expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
            actor_user_id: null, action: 'vehicle.changed', result: 'denied', status_code: 401,
        })]);
    });
});
