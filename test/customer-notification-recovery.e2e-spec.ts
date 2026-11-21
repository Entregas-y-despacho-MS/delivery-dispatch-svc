import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { MailerPort, type MailOptions } from '../src/plugins/mailer/mailer.port.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../src/app/dispatch-status/dispatch-status-changed.event.js';
import { CustomerStatusNoticeService } from '../src/app/customer-status-notices/services/customer-status-notice.service.js';
import { CustomerStatusNoticeRepository } from '../src/app/customer-status-notices/services/customer-status-notice.repository.js';
import { ScheduledTaskRegistry } from '../src/app/scheduler/services/scheduled-task-registry.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// ST-39.2: one logical send per event and recovery after a provider failure, against a real database
// (disposable one; see .claude/rules/back-testing.md). The provider is replaced by one the test controls.
describe('customer status email: idempotent send and recovery (ST-39.2, RF-U16)', () => {
    type Provider = 'sent' | 'bounced' | 'failed' | 'throw';

    let app: INestApplication;
    let db: DataSource;
    let events: EventEmitter2;
    let notices: CustomerStatusNoticeService;
    let registry: ScheduledTaskRegistry;
    const run = Date.now().toString(36);
    const sourcePrefix = `ST392-${run}`;
    const sent: MailOptions[] = [];
    const attempts: MailOptions[] = [];
    const statuses: Record<string, number> = {};
    const types: Record<string, number> = {};
    let sequence = 0;
    let provider: Provider = 'sent';

    async function dispatch(): Promise<number> {
        const n = ++sequence;
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, tracking_code, delivery_address,
                                     contact_email, tracking_token)
             VALUES ($1, $2, $3, $4, 'Secret street 123', ' Ana@Example.COM ', $5) RETURNING dispatch_id`,
            [types.delivery, statuses.delivered, `${sourcePrefix}-${n}`, `DSP-8${run.slice(-3)}-${String(n).padStart(5, '0')}`, `tok-${run}-${n}`],
        );
        return id;
    }
    const delivered = (dispatchId: number, updatedAt: string): DispatchStatusChangedEvent =>
        ({ dispatchId, status: 'delivered', previousStatus: 'in_transit', version: 1, updatedAt });
    const rows = (id: number) => db.query('SELECT * FROM customer_notifications WHERE dispatch_id = $1 ORDER BY customer_notification_id', [id]);
    const mailsOf = (id: number) => attempts.filter((mail) => (mail.metadata as { dispatchId: number }).dispatchId === id);
    const makeDue = (id: number) => db.query(
        `UPDATE customer_notifications SET next_attempt_at = NOW() - interval '1 minute' WHERE dispatch_id = $1 AND status = 'retrying'`, [id]);

    /** The listener is `async: true`: wait until the row of the dispatch stops being `sending`. */
    async function emit(event: DispatchStatusChangedEvent): Promise<void> {
        await events.emitAsync(DISPATCH_STATUS_CHANGED_EVENT, event);
        for (let i = 0; i < 60; i += 1) {
            const [row] = await rows(event.dispatchId);
            if (row && row.status !== 'sending') return;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort).useValue({
                send: async (mail: MailOptions) => {
                    attempts.push(mail);
                    if (provider === 'throw') throw new Error('connect ECONNREFUSED smtp.provider.test:587');
                    if (provider === 'failed') return { status: 'failed', error: 'SMTP did not accept any recipient.' };
                    if (provider === 'sent') sent.push(mail);
                    return { status: provider };
                },
            })
            .compile();
        app = moduleRef.createNestApplication();
        await app.init();
        db = moduleRef.get(DataSource);
        events = moduleRef.get(EventEmitter2);
        notices = moduleRef.get(CustomerStatusNoticeService);
        registry = moduleRef.get(ScheduledTaskRegistry);
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statuses[row.name] = row.dispatch_status_id;
        for (const row of await db.query('SELECT name, dispatch_type_id FROM dispatch_types')) types[row.name] = row.dispatch_type_id;
    }, 30000);

    afterAll(async () => {
        provider = 'sent';
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${sourcePrefix}%`] }, async (manager) => {
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${sourcePrefix}%`]);
        });
        await app?.close();
    });

    it('registers the recovery task in the scheduler, every 5 minutes', () => {
        expect(registry.get('customer-notification-recovery')?.schedule).toEqual({ kind: 'every-minutes', minutes: 5 });
    });

    it('leaves one logical send for two deliveries of the same event, with the data of the notification recorded', async () => {
        const id = await dispatch();
        provider = 'sent';
        const event = delivered(id, '2026-11-19T14:30:00.000Z');
        await Promise.all([emit(event), emit(event)]);
        await emit(event);

        expect(mailsOf(id)).toHaveLength(1);
        const stored = await rows(id);
        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({
            notification_type: 'status_change', idempotency_key: `status_change:${id}:delivered:2026-11-19T14:30:00.000Z`,
            source_event_key: `${id}:delivered:2026-11-19T14:30:00.000Z`, dispatch_status: 'delivered', recipient: 'ana@example.com',
            template: 'status-change', template_version: 1, status: 'sent', attempts: 1, last_error: null, locked_until: null, next_attempt_at: null,
        });
        expect(stored[0].sent_at).toBeInstanceOf(Date);
        expect(JSON.stringify(stored)).not.toMatch(/tok-|Secret street/);
    });

    it('a provider that is down leaves the email recoverable and the dispatch untouched; the task recovers it', async () => {
        const id = await dispatch();
        provider = 'throw';
        const event = delivered(id, '2026-11-19T15:00:00.000Z');
        const statusBefore = (await db.query('SELECT dispatch_status_id FROM dispatches WHERE dispatch_id = $1', [id]))[0].dispatch_status_id;

        await emit(event);

        expect(mailsOf(id)).toHaveLength(3);
        const [failing] = await rows(id);
        expect(failing).toMatchObject({ status: 'retrying', attempts: 3, locked_until: null, sent_at: null });
        expect(failing.last_error).toBe('Error: connect ECONNREFUSED smtp.provider.test:587');
        const minutesAhead = (failing.next_attempt_at.getTime() - Date.now()) / 60_000;
        expect(minutesAhead).toBeGreaterThan(4);
        expect(minutesAhead).toBeLessThanOrEqual(5.1);
        // the transition that originated the email is exactly as it was
        expect((await db.query('SELECT dispatch_status_id FROM dispatches WHERE dispatch_id = $1', [id]))[0].dispatch_status_id).toBe(statusBefore);

        // nothing is retried before its time...
        await notices.recoverDue();
        expect(mailsOf(id)).toHaveLength(3);
        // ...a second delivery of the same event during the outage creates nothing...
        await emit(event);
        expect(await rows(id)).toHaveLength(1);
        expect(mailsOf(id)).toHaveLength(3);

        // ...and once the provider is back and the time has come, the task sends it, once
        provider = 'sent';
        await makeDue(id);
        const summary = await notices.recoverDue();
        expect(summary.sent).toBeGreaterThanOrEqual(1);
        expect(mailsOf(id)).toHaveLength(4);
        expect((mailsOf(id)[3] as MailOptions).to).toBe('ana@example.com');
        const [recovered] = await rows(id);
        expect(recovered).toMatchObject({ status: 'sent', attempts: 4, next_attempt_at: null, locked_until: null, last_error: 'Error: connect ECONNREFUSED smtp.provider.test:587' });
        expect(recovered.sent_at).toBeInstanceOf(Date);

        await notices.recoverDue();
        expect(mailsOf(id)).toHaveLength(4);
    });

    it('stops after 6 attempts: exhausted, with waits of 5, 15 and 60 minutes, and nothing retries it afterwards', async () => {
        const id = await dispatch();
        provider = 'failed';
        await emit(delivered(id, '2026-11-19T16:00:00.000Z'));
        const waits: number[] = [];
        const minutesAhead = async () => (await rows(id))[0].next_attempt_at.getTime() - Date.now();

        waits.push(Math.round(await minutesAhead() / 60_000));
        for (let i = 0; i < 3; i += 1) {
            await makeDue(id);
            await notices.recoverDue();
            const [row] = await rows(id);
            if (row.status === 'retrying') waits.push(Math.round(await minutesAhead() / 60_000));
        }

        expect(waits).toEqual([5, 15, 60]);
        const [exhausted] = await rows(id);
        expect(exhausted).toMatchObject({ status: 'exhausted', attempts: 6, next_attempt_at: null, locked_until: null, sent_at: null });
        expect(exhausted.last_error).toBe('SMTP did not accept any recipient.');
        expect(mailsOf(id)).toHaveLength(6);

        provider = 'sent';
        await notices.recoverDue();
        expect(mailsOf(id)).toHaveLength(6);
    });

    it('does not retry a bounce: one attempt, final, and the task leaves it alone', async () => {
        const id = await dispatch();
        provider = 'bounced';
        await emit(delivered(id, '2026-11-19T17:00:00.000Z'));
        provider = 'sent';
        await notices.recoverDue();

        expect(mailsOf(id)).toHaveLength(1);
        expect((await rows(id))[0]).toMatchObject({ status: 'bounced', attempts: 1, next_attempt_at: null });
    });

    it('recovers an email whose process died after registering it (the lease ran out), counting that attempt', async () => {
        const id = await dispatch();
        provider = 'sent';
        const repository = app.get(CustomerStatusNoticeRepository);
        const key = `${id}:delivered:2026-11-19T18:00:00.000Z`;
        const { notificationId } = (await repository.reserve({
            dispatchId: id, notificationType: 'status_change', idempotencyKey: `status_change:${key}`, sourceEventKey: key, dispatchStatus: 'delivered',
            occurredAt: '2026-11-19T18:00:00.000Z', recipient: 'ana@example.com', template: 'status-change', templateVersion: 1,
        }))!;

        // while the lease is alive the task leaves it to the process that owns it
        await notices.recoverDue();
        expect(mailsOf(id)).toHaveLength(0);

        await db.query(
            `UPDATE customer_notifications SET locked_until = NOW() - interval '1 minute', next_attempt_at = NOW() - interval '1 minute' WHERE customer_notification_id = $1`, [notificationId]);
        await notices.recoverDue();

        expect(mailsOf(id)).toHaveLength(1);
        expect((await rows(id))[0]).toMatchObject({ status: 'sent', attempts: 2, locked_until: null });
    });
});
