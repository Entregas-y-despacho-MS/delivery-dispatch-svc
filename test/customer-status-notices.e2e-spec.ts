import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { MailerPort, type MailOptions } from '../src/plugins/mailer/mailer.port.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../src/app/dispatch-status/dispatch-status-changed.event.js';
import { INCIDENT_REPORTED_EVENT } from '../src/app/dispatch-incidents/domain/incident-report.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// ST-39.1: the email of a status change, against a real database (disposable one; see .claude/rules/back-testing.md).
describe('customer status change email (ST-39.1, RF-U16)', () => {
    let app: INestApplication;
    let db: DataSource;
    let events: EventEmitter2;
    const run = Date.now().toString(36);
    const sourcePrefix = `ST391-${run}`;
    const sent: MailOptions[] = [];
    const statuses: Record<string, number> = {};
    const types: Record<string, number> = {};
    let sequence = 0;
    let mailStatus: 'sent' | 'bounced' = 'sent';

    async function dispatch(over: { type?: string; email?: string | null; token?: string | null; expires?: string | null } = {}): Promise<number> {
        const n = ++sequence;
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, tracking_code, delivery_address,
                                     contact_email, contact_phone, tracking_token, tracking_token_expires_at)
             VALUES ($1, $2, $3, $4, 'Secret street 123', $5, '+59170000999', $6, $7) RETURNING dispatch_id`,
            [
                types[over.type ?? 'delivery'], statuses.out_for_delivery, `${sourcePrefix}-${n}`, `DSP-9${run.slice(-3)}-${String(n).padStart(5, '0')}`,
                over.email === undefined ? 'ana@example.com' : over.email,
                over.token === undefined ? `tok-${run}-${n}` : over.token, over.expires ?? null,
            ],
        );
        return id;
    }
    const changed = (dispatchId: number, status: string, previousStatus: string, updatedAt = new Date().toISOString()): DispatchStatusChangedEvent =>
        ({ dispatchId, status, previousStatus, version: 1, updatedAt });
    // The listener is `async: true`: emitting returns before it finishes, so each emit waits for the work to settle.
    const emit = async (event: DispatchStatusChangedEvent) => {
        await events.emitAsync(DISPATCH_STATUS_CHANGED_EVENT, event);
        await new Promise((resolve) => setTimeout(resolve, 400));
    };
    const notifications = (id: number) => db.query(
        `SELECT * FROM customer_notifications WHERE dispatch_id = $1 ORDER BY customer_notification_id`, [id]);

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort).useValue({ send: async (mail: MailOptions) => { sent.push(mail); return { status: mailStatus }; } })
            .compile();
        app = moduleRef.createNestApplication();
        await app.init();
        db = moduleRef.get(DataSource);
        events = moduleRef.get(EventEmitter2);
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statuses[row.name] = row.dispatch_status_id;
        for (const row of await db.query('SELECT name, dispatch_type_id FROM dispatch_types')) types[row.name] = row.dispatch_type_id;
    }, 30000);

    afterAll(async () => {
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${sourcePrefix}%`] }, async (manager) => {
            // The incident test raises an operational alert; its FK is ON DELETE SET NULL, so leaving it would orphan an open
            // alert that collides (uq_operational_alerts_open_subject) with the orphan of the next run on the same database.
            await manager.query(
                'DELETE FROM operational_alerts WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)', [`${sourcePrefix}%`]);
            await manager.query(
                'DELETE FROM customer_notifications WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref LIKE $1)', [`${sourcePrefix}%`]);
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${sourcePrefix}%`]);
        });
        await app?.close();
    });

    it('sends one email with the right data for an eligible transition and records it', async () => {
        const id = await dispatch();
        const before = sent.length;
        await emit(changed(id, 'out_for_delivery', 'assigned', '2026-11-19T14:30:00.000Z'));

        expect(sent.length).toBe(before + 1);
        const mail = sent[before]!;
        expect(mail).toMatchObject({ to: 'ana@example.com', subject: 'Tu pedido salió a ruta', template: 'status-change' });
        expect(mail.context).toMatchObject({ statusLabel: 'En ruta' });
        expect(mail.context!.occurredAt).toContain('10:30');
        expect(mail.context!.trackingCode).toMatch(/^DSP-9/);
        expect(mail.context!.trackingUrl).toMatch(/\/seguimiento\/tok-/);
        expect(JSON.stringify(mail)).not.toMatch(/Secret street|\+59170000999/);
        expect(JSON.stringify(mail.metadata)).not.toMatch(/tok-|ana@example/);

        const recorded = await notifications(id);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({
            notification_type: 'status_change', dispatch_status: 'out_for_delivery', recipient: 'ana@example.com', template: 'status-change',
            template_version: 1, status: 'sent', attempts: 1, next_attempt_at: null, locked_until: null, last_error: null,
            idempotency_key: `status_change:${id}:out_for_delivery:2026-11-19T14:30:00.000Z`,
        });
        expect(recorded[0].sent_at).toBeInstanceOf(Date);
        expect(JSON.stringify(recorded)).not.toMatch(/tok-|Secret street|\+59170000999/);
    });

    it('sends nothing for statuses outside the table, for the same status and for non-delivery dispatches', async () => {
        const id = await dispatch();
        const pickup = await dispatch({ type: 'supplier_pickup' });
        const before = sent.length;
        await emit(changed(id, 'assigned', 'scheduled'));
        await emit(changed(id, 'scheduled', 'in_planning'));
        await emit(changed(id, 'delivered', 'delivered'));
        await emit(changed(pickup, 'delivered', 'in_transit'));
        await emit(changed(999_999_999, 'delivered', 'in_transit'));
        expect(sent.length).toBe(before);
        expect(await notifications(id)).toHaveLength(0);
    });

    it('does not repeat the email of the same transition, but sends the next passage through the same status', async () => {
        const id = await dispatch();
        const before = sent.length;
        const first = changed(id, 'incident', 'in_transit', '2026-11-19T15:00:00.000Z');
        await Promise.all([emit(first), emit(first)]);
        await emit(first);
        expect(sent.length).toBe(before + 1);

        await emit(changed(id, 'incident', 'in_transit', '2026-11-19T18:00:00.000Z'));
        expect(sent.length).toBe(before + 2);
        expect(await notifications(id)).toHaveLength(2);
    });

    it('sends nothing without a recipient, and sends no link when there is no token or it expired', async () => {
        const noEmail = await dispatch({ email: null });
        const noToken = await dispatch({ token: null });
        const expired = await dispatch({ expires: '2020-01-01T00:00:00Z' });
        const before = sent.length;
        await emit(changed(noEmail, 'delivered', 'in_transit'));
        expect(sent.length).toBe(before);
        await emit(changed(noToken, 'delivered', 'in_transit'));
        await emit(changed(expired, 'delivered', 'in_transit'));
        expect(sent.length).toBe(before + 2);
        expect(sent[before]!.context!.trackingUrl).toBe('');
        expect(sent[before + 1]!.context!.trackingUrl).toBe('');
        expect(sent[before]!.context!.trackingCode).toBeTruthy();
    });

    it('sends the incident email when the driver reports an incident (that flow does not emit status_changed)', async () => {
        const id = await dispatch();
        await db.query('UPDATE dispatches SET dispatch_status_id = $1 WHERE dispatch_id = $2', [statuses.incident, id]);
        const before = sent.length;
        const report = { dispatchId: id, incidentId: 'inc-1', reasonCode: 'INC-X', reportedAt: '2026-11-19T16:00:00.000Z', criticality: 'high' };
        await events.emitAsync(INCIDENT_REPORTED_EVENT, report);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await events.emitAsync(INCIDENT_REPORTED_EVENT, report);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(sent.length).toBe(before + 1);
        expect(sent[before]!.subject).toBe('Tuvimos un inconveniente con tu entrega');
        expect(JSON.stringify(sent[before])).not.toContain('INC-X');
    });

    it('ignores an incident event of an order that is not in incident', async () => {
        const id = await dispatch();
        const before = sent.length;
        await events.emitAsync(INCIDENT_REPORTED_EVENT, { dispatchId: id, incidentId: 'inc-2', reasonCode: 'INC-X', reportedAt: new Date().toISOString(), criticality: 'low' });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(sent.length).toBe(before);
    });

    it('records a bounce as final, after one attempt and with no retry scheduled', async () => {
        const id = await dispatch();
        mailStatus = 'bounced';
        const before = sent.length;
        try { await emit(changed(id, 'not_delivered', 'in_transit')); } finally { mailStatus = 'sent'; }
        expect(sent.length).toBe(before + 1);
        const [recorded] = await notifications(id);
        expect(recorded).toMatchObject({ dispatch_status: 'not_delivered', status: 'bounced', attempts: 1, next_attempt_at: null });
        expect(recorded.last_error).toBeTruthy();
    });
});
