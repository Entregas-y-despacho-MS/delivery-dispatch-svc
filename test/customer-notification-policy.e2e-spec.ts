import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication, type LoggerService } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MAILER_OPTIONS } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { DISPATCH_STATUS_CHANGED_EVENT, type DispatchStatusChangedEvent } from '../src/app/dispatch-status/dispatch-status-changed.event.js';
import { STATUS_NOTICE_TABLE, STATUS_NOTICE_TEMPLATE } from '../src/app/customer-status-notices/domain/status-notice-table.js';
import { CustomerStatusNoticeService } from '../src/app/customer-status-notices/services/customer-status-notice.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

// RF-U16: the whole customer email policy through the real SMTP adapter (SmtpAdapter → MailerService → the
// Handlebars template) against a real database. Only the provider is simulated: a nodemailer transport the test
// controls, so it can accept, reject the recipient (bounce) or fail (provider down).
describe('customer status email: the whole policy through the real mailer (RF-U16)', () => {
    type ProviderMode = 'accept' | 'reject' | 'down';

    interface DeliveredMail {
        to: string;
        subject: string;
        html: string;
        dispatchRef: string;
    }

    /** Nodemailer custom transport: what reaches the provider, already rendered by the template engine. */
    let mode: ProviderMode = 'accept';
    const providerCalls: DeliveredMail[] = [];
    const accepted: DeliveredMail[] = [];
    const fakeProvider = {
        name: 'simulated-provider',
        version: '1.0.0',
        send(mail: { data: { to: string; subject: string; html: string } }, callback: (error: Error | null, info?: object) => void): void {
            const to = String(mail.data.to);
            const delivered: DeliveredMail = { to, subject: mail.data.subject, html: String(mail.data.html), dispatchRef: refOf(String(mail.data.html)) };
            providerCalls.push(delivered);
            if (mode === 'down') return callback(new Error('connect ECONNREFUSED smtp.provider.test:587'));
            const envelope = { from: 'noreply@example.com', to: [to] };
            if (mode === 'reject') return callback(null, { accepted: [], rejected: [to], envelope, messageId: `<${providerCalls.length}@test>` });
            accepted.push(delivered);
            return callback(null, { accepted: [to], rejected: [], envelope, messageId: `<${providerCalls.length}@test>` });
        },
    };

    /** Every line the application logs, to prove no personal data or token reaches the logs. */
    const logs: string[] = [];
    const capture = (...args: unknown[]): void => { logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
    const logger: LoggerService = { log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture };

    let app: INestApplication;
    let db: DataSource;
    let events: EventEmitter2;
    let notices: CustomerStatusNoticeService;
    let webUrl: string;
    const run = Date.now().toString(36);
    /** Three digits for the tracking codes of this run (the code pattern is DSP-NNNN-NNNNN). */
    const runDigits = String(Date.now() % 1000).padStart(3, '0');
    const sourcePrefix = `ST393-${run}`;
    const statuses: Record<string, number> = {};
    const types: Record<string, number> = {};
    let sequence = 0;

    const PHONE = '+59170000777';
    const ADDRESS = 'Calle Secreta 742, piso 3';
    /** The approved policy, written here on purpose: removing or adding a status in the code must fail this suite. */
    const ELIGIBLE = ['out_for_delivery', 'in_transit', 'delivered', 'incident', 'not_delivered', 'rescheduled', 'cancelled', 'returned'];

    interface TestDispatch { id: number; trackingCode: string; token: string; email: string }

    /** The tracking code is in the rendered email, so it tells which dispatch a provider call belongs to. */
    const refOf = (html: string): string => html.match(/DSP-\d{4}-\d{5}/)?.[0] ?? '';

    async function dispatch(over: { type?: string; email?: string | null } = {}): Promise<TestDispatch> {
        const n = ++sequence;
        const trackingCode = `DSP-7${runDigits}-${String(n).padStart(5, '0')}`;
        const token = `tok-${run}-${n}-secreto`;
        const email = over.email === undefined ? ` Cliente.${run}.${n}@Example.COM ` : over.email;
        const [{ dispatch_id: id }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, tracking_code, delivery_address,
                                     contact_email, contact_phone, tracking_token)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING dispatch_id`,
            [types[over.type ?? 'delivery'], statuses.in_transit, `${sourcePrefix}-${n}`, trackingCode, ADDRESS, email, PHONE, token],
        );
        return { id, trackingCode, token, email: email ?? '' };
    }

    /** Each case gets its own minute so the expected La Paz time (UTC-4) is unambiguous. */
    const instantFor = (n: number): { iso: string; laPaz: string } => {
        const minute = String(n % 60).padStart(2, '0');
        return { iso: `2026-11-19T15:${minute}:00.000Z`, laPaz: `11:${minute}` };
    };
    const change = (dispatchId: number, status: string, previousStatus: string, iso: string): DispatchStatusChangedEvent =>
        ({ dispatchId, status, previousStatus, version: 1, updatedAt: iso });
    const rows = (id: number) => db.query('SELECT * FROM customer_notifications WHERE dispatch_id = $1', [id]);
    const callsOf = (d: TestDispatch) => providerCalls.filter((mail) => mail.dispatchRef === d.trackingCode);
    const acceptedOf = (d: TestDispatch) => accepted.filter((mail) => mail.dispatchRef === d.trackingCode);

    /**
     * The listener is `async: true`: wait until the notification of the dispatch settles. When no notification is
     * expected there is nothing to wait for, so a short grace lets a wrong send show up before the assertions.
     */
    async function emit(event: DispatchStatusChangedEvent, expectNotification = true): Promise<void> {
        await events.emitAsync(DISPATCH_STATUS_CHANGED_EVENT, event);
        if (!expectNotification) {
            await new Promise((resolve) => setTimeout(resolve, 300));
            return;
        }
        for (let i = 0; i < 60; i += 1) {
            const [row] = await rows(event.dispatchId);
            if (row && row.status !== 'sending') return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MAILER_OPTIONS).useValue({
                transport: fakeProvider,
                defaults: { from: '"Despachos" <noreply@example.com>' },
                template: { adapter: new HandlebarsAdapter(), dir: join(process.cwd(), 'src/plugins/mailer/templates'), options: { strict: true } },
            })
            .compile();
        app = moduleRef.createNestApplication({ logger });
        await app.init();
        db = moduleRef.get(DataSource);
        events = moduleRef.get(EventEmitter2);
        notices = moduleRef.get(CustomerStatusNoticeService);
        webUrl = moduleRef.get(ConfigService).get<string>('PUBLIC_WEB_URL', 'http://localhost:5173')!.replace(/\/$/, '');
        for (const row of await db.query('SELECT name, dispatch_status_id FROM dispatch_statuses')) statuses[row.name] = row.dispatch_status_id;
        for (const row of await db.query('SELECT name, dispatch_type_id FROM dispatch_types')) types[row.name] = row.dispatch_type_id;
    }, 30000);

    afterAll(async () => {
        mode = 'accept';
        if (db?.isInitialized) await withEventPurge(db, { dispatchRefs: [`${sourcePrefix}%`] }, async (manager) => {
            await manager.query('DELETE FROM dispatches WHERE source_order_ref LIKE $1', [`${sourcePrefix}%`]);
        });
        await app?.close();
    });

    it('the code notifies exactly the approved statuses', () => {
        expect(Object.keys(STATUS_NOTICE_TABLE).sort()).toEqual([...ELIGIBLE].sort());
    });

    describe.each(ELIGIBLE)('notifiable status %s', (status) => {
        const entry = STATUS_NOTICE_TABLE[status] ?? { subject: '(missing)', statusLabel: '(missing)', message: '(missing)' };

        it('sends exactly one rendered email for the event, even when it arrives twice, with no personal data or token outside the link', async () => {
            mode = 'accept';
            const d = await dispatch();
            const at = instantFor(++sequence);
            const event = change(d.id, status, 'assigned', at.iso);
            await Promise.all([emit(event), emit(event)]);
            await emit(event);

            expect(callsOf(d)).toHaveLength(1);
            const [mail] = acceptedOf(d);
            expect(mail!.to).toBe(d.email.trim().toLowerCase());
            expect(mail!.subject).toBe(entry.subject);
            expect(mail!.html).toContain(`<h1>${entry.statusLabel}</h1>`);
            expect(mail!.html).toContain(entry.message);
            expect(mail!.html).toContain('19 de noviembre de 2026');
            expect(mail!.html).toContain(at.laPaz);
            expect(mail!.html).toContain(`Código de seguimiento: ${d.trackingCode}`);
            expect(mail!.html).toContain(`href="${webUrl}/seguimiento/${d.token}"`);
            // the token appears only inside the link, and nothing personal or internal is in the body
            expect(mail!.html.split(d.token)).toHaveLength(2);
            expect(mail!.html).not.toContain(PHONE);
            expect(mail!.html).not.toContain(ADDRESS);
            expect(mail!.html.toLowerCase()).not.toContain(d.email.trim().toLowerCase());

            const [row] = await rows(d.id);
            expect(row).toMatchObject({ dispatch_status: status, status: 'sent', attempts: 1, recipient: d.email.trim().toLowerCase(), template: STATUS_NOTICE_TEMPLATE });
            expect(await rows(d.id)).toHaveLength(1);
        });

        it('sends nothing when the dispatch has no recipient', async () => {
            mode = 'accept';
            for (const email of [null, '   ']) {
                const d = await dispatch({ email });
                await emit(change(d.id, status, 'assigned', instantFor(++sequence).iso), false);
                expect(callsOf(d)).toHaveLength(0);
                expect(await rows(d.id)).toHaveLength(0);
            }
        });

        it('keeps a provider failure recoverable and, once the provider is back, sends it exactly once', async () => {
            mode = 'down';
            const d = await dispatch();
            const event = change(d.id, status, 'assigned', instantFor(++sequence).iso);
            await emit(event);

            expect(callsOf(d)).toHaveLength(3);
            expect(acceptedOf(d)).toHaveLength(0);
            const [failing] = await rows(d.id);
            expect(failing).toMatchObject({ status: 'retrying', attempts: 3, sent_at: null });
            expect(failing.last_error).not.toMatch(/@|tok-/);

            // the same event during the outage creates nothing new
            await emit(event);
            expect(await rows(d.id)).toHaveLength(1);

            mode = 'accept';
            await db.query(`UPDATE customer_notifications SET next_attempt_at = NOW() - interval '1 minute' WHERE dispatch_id = $1`, [d.id]);
            await notices.recoverDue();
            await notices.recoverDue();

            expect(acceptedOf(d)).toHaveLength(1);
            expect(acceptedOf(d)[0]!.subject).toBe(entry.subject);
            expect((await rows(d.id))[0]).toMatchObject({ status: 'sent', attempts: 4 });
        });

        it('does not retry a permanent failure (the provider rejects the recipient)', async () => {
            mode = 'reject';
            const d = await dispatch();
            await emit(change(d.id, status, 'assigned', instantFor(++sequence).iso));
            expect(callsOf(d)).toHaveLength(1);
            expect((await rows(d.id))[0]).toMatchObject({ status: 'bounced', attempts: 1, next_attempt_at: null });

            // even with the provider back and a due date forced on the row, the recovery never picks a bounce
            mode = 'accept';
            await db.query(`UPDATE customer_notifications SET next_attempt_at = NOW() - interval '1 minute' WHERE dispatch_id = $1`, [d.id]);
            await notices.recoverDue();
            expect(callsOf(d)).toHaveLength(1);
            expect(acceptedOf(d)).toHaveLength(0);
            expect((await rows(d.id))[0]).toMatchObject({ status: 'bounced', attempts: 1 });
        });
    });

    it('sends nothing for every status outside the policy, for a change to the same status and for a non-delivery dispatch', async () => {
        mode = 'accept';
        const excluded = Object.keys(statuses).filter((status) => !ELIGIBLE.includes(status));
        expect(excluded.length).toBeGreaterThan(0);
        for (const status of excluded) {
            const d = await dispatch();
            await emit(change(d.id, status, 'in_transit', instantFor(++sequence).iso), false);
            expect({ status, calls: callsOf(d).length, rows: (await rows(d.id)).length }).toEqual({ status, calls: 0, rows: 0 });
        }

        const same = await dispatch();
        await emit(change(same.id, 'delivered', 'delivered', instantFor(++sequence).iso), false);
        expect(callsOf(same)).toHaveLength(0);

        for (const type of Object.keys(types).filter((name) => name !== 'delivery')) {
            const d = await dispatch({ type });
            await emit(change(d.id, 'cancelled', 'pending', instantFor(++sequence).iso), false);
            expect({ type, calls: callsOf(d).length, rows: (await rows(d.id)).length }).toEqual({ type, calls: 0, rows: 0 });
        }
    });

    it('never writes a recipient address, phone, address or tracking token to the logs', () => {
        const everything = logs.join('\n');
        expect(logs.length).toBeGreaterThan(0);
        expect(everything).not.toMatch(new RegExp(`cliente\\.${run}`, 'i'));
        expect(everything).not.toContain(`tok-${run}`);
        expect(everything).not.toContain(PHONE);
        expect(everything).not.toContain(ADDRESS);
    });
});
