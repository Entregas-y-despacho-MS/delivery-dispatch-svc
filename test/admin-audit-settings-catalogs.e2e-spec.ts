// RF-A35 / ST-68.2: audit trail of the sensitive handlers of the "business configuration and catalogs" family
// (setting.updated, catalog.changed): one allowed and one denied operation of each, against the real AppModule and
// database. The settings it writes keep their current value; the catalog rows it creates are deleted in afterAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditE2eHarness } from './helpers/audit-e2e.harness.js';

describe('audit of settings and catalogs (ST-68.2)', () => {
    const h = new AuditE2eHarness('audit-config');
    const tag = Date.now().toString(36).toUpperCase();
    const settingKey = 'max_failed_login_attempts';

    beforeAll(async () => { await h.start(['admin', 'coordinator', 'supervisor', 'driver']); }, 30_000);
    afterAll(async () => {
        if (h.db?.isInitialized) {
            await h.db.query(`DELETE FROM delivery_zones WHERE code LIKE $1`, [`Z${tag}%`]);
            await h.db.query(`DELETE FROM service_levels WHERE name LIKE $1`, [`${h.prefix}%`]);
            await h.db.query(`DELETE FROM incident_reasons WHERE code LIKE $1`, [`I${tag}%`]);
            await h.db.query(`DELETE FROM reschedule_reasons WHERE code LIKE $1`, [`R${tag}%`]);
            await h.db.query(`DELETE FROM vehicle_incident_types WHERE code LIKE $1`, [`V${tag}%`]);
        }
        await h.close();
    });

    describe('setting.updated', () => {
        it('records PUT /settings/:key by the coordinator with the key as the entity and the new value', async () => {
            const [{ setting_value }] = await h.db.query('SELECT setting_value FROM settings WHERE setting_key = $1', [settingKey]);
            const { correlationId, response } = h.call('put', `/settings/${settingKey}`, h.users.coordinator.token, { value: setting_value });
            expect((await response).status).toBe(200);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, actor_role: 'coordinator', action: 'setting.updated', entity_type: 'setting',
                entity_id: settingKey, result: 'success', status_code: 200,
                // ST-310.1 / ES-68: the version the change produced and the value it replaced (the same one here).
                metadata: { value: setting_value, previousValue: setting_value, settingsVersion: expect.any(Number) },
            })]);
        });

        it('records the denial of an admin and leaves the setting unchanged', async () => {
            const read = async () => (await h.db.query('SELECT setting_value FROM settings WHERE setting_key = $1', [settingKey]))[0].setting_value;
            const before = await read();
            const { correlationId, response } = h.call('put', `/settings/${settingKey}`, h.users.admin.token, { value: '99' });
            expect((await response).status).toBe(403);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.admin.id, action: 'setting.updated', entity_id: settingKey, result: 'denied', status_code: 403,
            })]);
            expect(await read()).toBe(before);
        });

        it('records a rejected value as failed', async () => {
            const { correlationId, response } = h.call('put', `/settings/${settingKey}`, h.users.coordinator.token, { value: 'not-a-number' });
            expect((await response).status).toBe(400);
            expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({ action: 'setting.updated', result: 'failed', status_code: 400 })]);
        });

        it('records PUT /settings/alert-thresholds by the supervisor, and the denial of the coordinator', async () => {
            const { slaAlertMinOnTimePct, gpsStaleAlertMinutes, driverIncidentAlertPerDay } = (await h.call('get', '/settings/alert-thresholds', h.users.supervisor.token).response).body;
            const current = { slaAlertMinOnTimePct, gpsStaleAlertMinutes, driverIncidentAlertPerDay };
            const allowed = h.call('put', '/settings/alert-thresholds', h.users.supervisor.token, current);
            expect((await allowed.response).status).toBe(200);
            expect(await h.eventsOf(allowed.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.supervisor.id, action: 'setting.updated', entity_type: 'setting', entity_id: null,
                result: 'success', status_code: 200,
                metadata: {
                    ...current, setting: 'alert-thresholds', settingsVersion: expect.any(Number),
                    previousSlaAlertMinOnTimePct: current.slaAlertMinOnTimePct,
                    previousGpsStaleAlertMinutes: current.gpsStaleAlertMinutes,
                    previousDriverIncidentAlertPerDay: current.driverIncidentAlertPerDay,
                },
            })]);

            const denied = h.call('put', '/settings/alert-thresholds', h.users.coordinator.token, current);
            expect((await denied.response).status).toBe(403);
            expect(await h.eventsOf(denied.correlationId)).toEqual([expect.objectContaining({
                actor_user_id: h.users.coordinator.id, action: 'setting.updated', result: 'denied', status_code: 403,
            })]);
        });
    });

    describe('catalog.changed', () => {
        const catalogs = [
            { catalog: 'delivery-zones', path: '/delivery-zones', allowed: 'coordinator', denied: 'admin',
              body: () => ({ code: `Z${tag}1`, name: `${h.prefix} zone`, estimatedTimeMin: 45 }), update: { name: `${h.prefix} zone 2` }, remove: true },
            { catalog: 'service-levels', path: '/service-levels', allowed: 'coordinator', denied: 'supervisor',
              body: () => ({ name: `${h.prefix} level`, targetTimeMin: 180, priorityLevel: 9 }), update: { description: 'e2e' }, remove: true },
            { catalog: 'incident-reasons', path: '/incident-reasons', allowed: 'coordinator', denied: 'supervisor',
              body: () => ({ code: `I${tag}-1`, name: `${h.prefix} incident`, requiresEvidence: false }), update: { name: `${h.prefix} incident 2` }, remove: false },
            { catalog: 'reschedule-reasons', path: '/reschedule-reasons', allowed: 'coordinator', denied: 'supervisor',
              body: () => ({ code: `R${tag}1`, name: `${h.prefix} reschedule`, category: 'operations' }), update: { name: `${h.prefix} reschedule 2` }, remove: false },
            { catalog: 'vehicle-incident-types', path: '/vehicle-incident-types', allowed: 'supervisor', denied: 'driver',
              body: () => ({ code: `V${tag}1`, name: `${h.prefix} vehicle`, severity: 'minor', disablesVehicle: false }), update: { name: `${h.prefix} vehicle 2` }, remove: false },
        ] as const;

        describe.each(catalogs)('$catalog', (entry) => {
            it('records the creation, the edit and the deletion with the id of the entry and the catalog', async () => {
                const token = h.users[entry.allowed].token;
                const actor = { actor_user_id: h.users[entry.allowed].id, actor_role: entry.allowed, action: 'catalog.changed', entity_type: 'catalog' };

                const created = h.call('post', entry.path, token, entry.body());
                const createdRes = await created.response;
                expect(createdRes.status).toBe(201);
                const id = String(createdRes.body.id);
                expect(await h.eventsOf(created.correlationId)).toEqual([expect.objectContaining({
                    ...actor, entity_id: id, result: 'success', status_code: 201, metadata: { catalog: entry.catalog, operation: 'create' },
                })]);

                const updated = h.call('put', `${entry.path}/${id}`, token, entry.update);
                expect((await updated.response).status).toBe(200);
                expect(await h.eventsOf(updated.correlationId)).toEqual([expect.objectContaining({
                    ...actor, entity_id: id, result: 'success', status_code: 200, metadata: { catalog: entry.catalog, operation: 'update' },
                })]);

                if (entry.remove) {
                    const removed = h.call('delete', `${entry.path}/${id}`, token);
                    expect((await removed.response).status).toBe(204);
                    expect(await h.eventsOf(removed.correlationId)).toEqual([expect.objectContaining({
                        ...actor, entity_id: id, result: 'success', status_code: 204, metadata: { catalog: entry.catalog, operation: 'delete' },
                    })]);
                }
            });

            it('records the denial of a role that cannot change it, and does not create the entry', async () => {
                const body = entry.body();
                const probe = { ...body, ...('code' in body ? { code: `${'code' in body ? String(body.code).slice(0, -1) : ''}9` } : { name: `${h.prefix} denied` }) };
                const { correlationId, response } = h.call('post', entry.path, h.users[entry.denied].token, probe);
                expect((await response).status).toBe(403);
                expect(await h.eventsOf(correlationId)).toEqual([expect.objectContaining({
                    actor_user_id: h.users[entry.denied].id, action: 'catalog.changed', entity_id: null, result: 'denied', status_code: 403,
                    metadata: { catalog: entry.catalog, operation: 'create' },
                })]);
            });
        });
    });
});
