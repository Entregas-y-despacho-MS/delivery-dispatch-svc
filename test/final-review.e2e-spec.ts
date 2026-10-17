// ST-51.4 — Alertas, recordatorio y escalamiento de la 2.ª aprobación, de punta a punta.
//
// Levanta el AppModule real contra una base de datos real y ejecuta los servicios reales de cada hito con un
// reloj simulado (el instante se pasa como `startedAt`; la aprobación tardía recibe su propio `now`). El correo
// se simula y se registra. Todo cuelga de un día de ruta propio (miércoles 2031-03-12) para no tocar datos de
// otros suites, lleva un prefijo único y se borra en afterAll.
//
// La Paz es UTC-4: martes 11-mar 16:00 = 20:00Z (fin de revisión), 16:30 = 20:30Z (recordatorio);
// miércoles 12-mar 07:00 = 11:00Z (escalamiento).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { FinalReviewAlertService } from '../src/app/final-review/services/final-review-alert.service.js';
import { FinalReviewEscalationService } from '../src/app/final-review/services/final-review-escalation.service.js';
import { FinalReviewRepository } from '../src/app/final-review/services/final-review.repository.js';
import { RouteReminderService } from '../src/app/final-review/services/route-reminder.service.js';
import { LateApprovalNoticeListener } from '../src/app/final-review/late-approval-notice.listener.js';
import { NoticeReconciliationService } from '../src/app/final-review/services/notice-reconciliation.service.js';
import { withEventPurge } from './helpers/purge-append-only-events.js';

const SHIFT = '2031-03-12';
const REVIEW_END = new Date('2031-03-11T20:00:00Z');
const REMINDER = new Date('2031-03-11T20:30:00Z');
const ESCALATION = new Date('2031-03-12T11:00:00Z');
const AFTER_RISK = new Date('2031-03-12T13:00:00Z');
const context = (startedAt: Date) => ({ trigger: 'schedule' as const, occurrence: null, startedAt });

type OrderStatus = 'scheduled' | 'assigned' | 'in_planning';

describe('Final review timeline (e2e, ST-51.4)', () => {
    let app: INestApplication;
    let db: DataSource;
    let alert: FinalReviewAlertService;
    let reminder: RouteReminderService;
    let escalation: FinalReviewEscalationService;
    let lateApproval: LateApprovalNoticeListener;
    let repository: FinalReviewRepository;
    let reconciliation: NoticeReconciliationService;
    let warehouseId = 0;
    const sent: Array<{ to: string; template: string }> = [];
    /** The risk notice sent to a `-hold@` address waits here until the test resolves them: an email "in flight". */
    const held: Array<{ to: string; template: string; resolve: (status: 'sent' | 'bounced' | 'failed') => void }> = [];

    const run = Date.now().toString(36).toUpperCase();
    const tag = `E2EFR-${run}`;
    const refs: string[] = [];
    const batchIds: number[] = [];
    let seq = 0;

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(MailerPort)
            .useValue({
                send: async (options: { to: string | string[]; template?: string }) => {
                    const to = Array.isArray(options.to) ? options.to[0] : options.to;
                    sent.push({ to, template: options.template ?? '' });
                    // Only the risk notice is held: whatever follows it (reminder, «se mantiene») must go through.
                    if (to.includes('-hold@') && options.template === 'risk-notice') {
                        return await new Promise<{ status: 'sent' | 'bounced' | 'failed' }>((resolve) => {
                            held.push({ to, template: options.template ?? '', resolve: (status) => resolve({ status }) });
                        });
                    }
                    return { status: to.includes('-bounce@') ? 'bounced' : 'sent' };
                },
            })
            .compile();
        app = moduleRef.createNestApplication();
        await app.init();
        db = moduleRef.get(DataSource);
        alert = moduleRef.get(FinalReviewAlertService);
        reminder = moduleRef.get(RouteReminderService);
        escalation = moduleRef.get(FinalReviewEscalationService);
        lateApproval = moduleRef.get(LateApprovalNoticeListener);
        repository = moduleRef.get(FinalReviewRepository);
        reconciliation = moduleRef.get(NoticeReconciliationService);
        const [wh] = await db.query(`SELECT warehouse_id FROM warehouses WHERE active = TRUE ORDER BY warehouse_id LIMIT 1`);
        warehouseId = wh.warehouse_id;
    });

    afterAll(async () => {
        if (db) {
            await withEventPurge(db, { dispatchRefs: refs.map((ref) => `${ref}%`), routeBatchIds: batchIds }, async (manager) => {
                await manager.query(`DELETE FROM dispatch_packages WHERE dispatch_id IN (SELECT dispatch_id FROM dispatches WHERE source_order_ref = ANY($1::text[]))`, [refs]);
                await manager.query(`DELETE FROM dispatches WHERE source_order_ref = ANY($1::text[])`, [refs]);
                await manager.query(`DELETE FROM route_batches WHERE route_batch_id = ANY($1::int[])`, [batchIds]);
                await manager.query(`DELETE FROM audit_logs WHERE action = 'plan_generation_alert' AND detail LIKE $1`, [`%"shiftDate":"${SHIFT}"%`]);
            });
        }
        await app?.close();
    });

    /** A batch of the route day with one order per entry; `promised` orders already got their promise email. */
    async function makeBatch(status: string, orders: Array<{ status: OrderStatus; promised?: boolean; contact?: 'none' | 'bounce' | 'hold' }>) {
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date) VALUES ($1, $2) RETURNING route_batch_id`, [status, SHIFT],
        );
        batchIds.push(route_batch_id);
        const dispatchIds: number[] = [];
        const emails: string[] = [];
        for (const order of orders) {
            const ref = `${tag}-${++seq}`;
            refs.push(ref);
            const email = order.contact === 'none' ? null : `${ref.toLowerCase()}${order.contact === 'bounce' ? '-bounce' : order.contact === 'hold' ? '-hold' : ''}@example.test`;
            const [{ dispatch_id }] = await db.query(
                `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                        delivery_address, contact_name, contact_email, estimated_weight_kg, origin_warehouse_id, tracking_code,
                        tracking_token, promise_notified_at, scheduled_window_start, scheduled_window_end)
                 VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                         (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = $2),
                         $1, $8, $3, 'Test address', 'E2E customer', $4, 1, $5, next_tracking_code(), $6,
                         CASE WHEN $7::boolean THEN NOW() END, '2031-03-12T13:00:00Z', '2031-03-12T15:00:00Z')
                 RETURNING dispatch_id`,
                [route_batch_id, order.status, ref, email, warehouseId, `tok-${ref}`, order.promised ?? true, dispatchIds.length + 1],
            );
            dispatchIds.push(dispatch_id);
            emails.push(email ?? '');
        }
        return { id: route_batch_id as number, dispatchIds, emails };
    }

    /** What the 2nd approval leaves behind (the real endpoint is covered by its own e2e). */
    async function approve(batch: { id: number; dispatchIds: number[] }) {
        await db.query(`UPDATE route_batches SET status = 'confirmed' WHERE route_batch_id = $1`, [batch.id]);
        await db.query(
            `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned')
              WHERE dispatch_id = ANY($1::int[])`, [batch.dispatchIds],
        );
    }

    const mailsTo = (emails: string[]) => sent.filter((mail) => emails.includes(mail.to));
    const batchEvents = async (batchId: number, type: string): Promise<number> =>
        Number((await db.query(`SELECT COUNT(*) AS n FROM route_batch_events WHERE route_batch_id = $1 AND event_type = $2`, [batchId, type]))[0].n);
    /** Reservations of a customer email (`notice_reserved`) of an order, in any batch. */
    const reserved = async (dispatchId: number, template: string): Promise<number> =>
        Number((await db.query(
            `SELECT COUNT(*) AS n FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'notice_reserved' AND metadata->>'template' = $2`, [dispatchId, template],
        ))[0].n);
    /** Results (`notice_result`) of one kind recorded for a customer email of an order. */
    const results = async (dispatchId: number, template: string, result: string): Promise<number> =>
        Number((await db.query(
            `SELECT COUNT(*) AS n FROM dispatch_events WHERE dispatch_id = $1 AND event_type = 'notice_result' AND metadata->>'template' = $2 AND metadata->>'result' = $3`, [dispatchId, template, result],
        ))[0].n);

    describe('final_review_end_time (16:00 of D-1)', () => {
        it('alerts once about a batch still pending, not about a confirmed one, and never approves', async () => {
            const pending = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            const confirmed = await makeBatch('confirmed', [{ status: 'assigned' }]);

            const first = await alert.run(context(REVIEW_END));
            const second = await alert.run(context(REVIEW_END));

            expect(first.alertedBatchIds).toContain(pending.id);
            expect(first.alertedBatchIds).not.toContain(confirmed.id);
            expect(second.alertedBatchIds).not.toContain(pending.id);
            expect(second.alreadyAlertedBatchIds).toContain(pending.id);
            expect(await batchEvents(pending.id, 'final_review_alerted')).toBe(1);
            expect(await batchEvents(confirmed.id, 'final_review_alerted')).toBe(0);
            const [{ n }] = await db.query(
                `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'plan_generation_alert' AND detail LIKE $1 AND detail LIKE $2`,
                [`%"kind":"final_review_overdue"%`, `%"routeBatchId":${pending.id},%`],
            );
            expect(Number(n)).toBe(1);
            const [row] = await db.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [pending.id]);
            expect(row.status).toBe('pending_final_review');
        });

        it('sends the customers of a pending batch nothing', async () => {
            const pending = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);

            await alert.run(context(REVIEW_END));

            expect(mailsTo(pending.emails)).toHaveLength(0);
        });
    });

    describe('route_reminder_time (16:30 of D-1)', () => {
        it('reminds only the customers of a confirmed batch, once', async () => {
            const confirmed = await makeBatch('confirmed', [{ status: 'assigned' }]);
            const pending = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            const remnant = await makeBatch('provisional', [{ status: 'scheduled' }]);

            await reminder.run(context(REMINDER));
            await reminder.run(context(REMINDER));

            expect(mailsTo(confirmed.emails)).toEqual([{ to: confirmed.emails[0], template: 'reminder' }]);
            expect(mailsTo(pending.emails)).toHaveLength(0);
            expect(mailsTo(remnant.emails)).toHaveLength(0);
            expect(await reserved(confirmed.dispatchIds[0], 'reminder')).toBe(1);
        });
    });

    describe('late approval before the risk notice', () => {
        it('before 16:30 sends nothing now and the 16:30 task sends it', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            await approve(batch);

            await lateApproval.handleRouteAssigned({ routeId: batch.id, driverId: 1, vehicleId: 1, dispatchIds: batch.dispatchIds, version: 1 }, REVIEW_END);
            expect(mailsTo(batch.emails)).toHaveLength(0);

            await reminder.run(context(REMINDER));
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']);
        });

        it('after 16:30 the reminder goes out at the moment of the approval, and only once', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            await reminder.run(context(REMINDER));
            expect(mailsTo(batch.emails)).toHaveLength(0);
            await approve(batch);
            const event = { routeId: batch.id, driverId: 1, vehicleId: 1, dispatchIds: batch.dispatchIds, version: 1 };

            await lateApproval.handleRouteAssigned(event, new Date('2031-03-11T22:00:00Z'));
            await lateApproval.handleRouteAssigned(event, new Date('2031-03-11T22:05:00Z'));

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']);
        });
    });

    describe('final_review_escalation_time (07:00 of D) — case 5.2', () => {
        it('escalates a pending batch and a remnant, keeps the promise and approves nothing', async () => {
            const pending = await makeBatch('pending_final_review', [{ status: 'scheduled' }, { status: 'scheduled' }]);
            const remnant = await makeBatch('provisional', [{ status: 'scheduled' }]);
            const unpromised = await makeBatch('provisional', [{ status: 'in_planning', promised: false }]);
            const before = await db.query(
                `SELECT dispatch_id, version, dispatch_status_id, scheduled_window_start, scheduled_window_end FROM dispatches WHERE dispatch_id = ANY($1::int[]) ORDER BY dispatch_id`,
                [[...pending.dispatchIds, ...remnant.dispatchIds]],
            );

            const first = await escalation.run(context(ESCALATION));
            const second = await escalation.run(context(ESCALATION));

            expect(first.escalatedBatchIds).toEqual(expect.arrayContaining([pending.id, remnant.id]));
            expect(first.withoutPromisedOrdersBatchIds).toContain(unpromised.id);
            expect(second.escalatedBatchIds).not.toContain(pending.id);
            expect(await batchEvents(pending.id, 'final_review_escalated')).toBe(1);
            expect(await batchEvents(pending.id, 'coordinator_task_required')).toBe(1);
            expect(await batchEvents(remnant.id, 'final_review_escalated')).toBe(1);
            expect(await batchEvents(unpromised.id, 'final_review_escalated')).toBe(0);

            const incidents = await db.query(
                `SELECT i.dispatch_id, r.code, r.counts_as_attempt FROM dispatch_incidents i
                   JOIN incident_reasons r ON r.incident_reason_id = i.incident_reason_id
                  WHERE i.dispatch_id = ANY($1::int[])`,
                [[...pending.dispatchIds, ...remnant.dispatchIds, ...unpromised.dispatchIds]],
            );
            expect(incidents).toHaveLength(3);
            expect(incidents.every((incident: any) => incident.code === 'INC-COMP-FAILURE' && incident.counts_as_attempt === false)).toBe(true);

            expect(mailsTo([...pending.emails, ...remnant.emails]).map((mail) => mail.template)).toEqual(Array(3).fill('risk-notice'));
            expect(mailsTo(unpromised.emails)).toHaveLength(0);

            const after = await db.query(
                `SELECT dispatch_id, version, dispatch_status_id, scheduled_window_start, scheduled_window_end FROM dispatches WHERE dispatch_id = ANY($1::int[]) ORDER BY dispatch_id`,
                [[...pending.dispatchIds, ...remnant.dispatchIds]],
            );
            expect(after).toEqual(before);
            const statuses = await db.query(`SELECT status FROM route_batches WHERE route_batch_id = ANY($1::int[]) ORDER BY route_batch_id`, [[pending.id, remnant.id]]);
            expect(statuses.map((row: any) => row.status)).toEqual(['pending_final_review', 'provisional']);
        });

        it('leaves a batch approved on time alone', async () => {
            const confirmed = await makeBatch('confirmed', [{ status: 'assigned' }]);

            const summary = await escalation.run(context(ESCALATION));

            expect(summary.escalatedBatchIds).not.toContain(confirmed.id);
            expect(await batchEvents(confirmed.id, 'final_review_escalated')).toBe(0);
        });
    });

    describe('idempotency record and the lock of the batch', () => {
        it('twenty callers claiming the same order event at once: exactly one wins', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);

            const results = await Promise.all(Array.from({ length: 20 }, () =>
                repository.inBatchLock(batch.id, (scope) => scope.reserveNotice(batch.dispatchIds[0], 'reminder', 'race'))));

            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(1);
        });

        it('the lock is held until the transaction ends: a second caller waits for the first', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);
            const order: string[] = [];

            await Promise.all([
                repository.inBatchLock(batch.id, async () => { order.push('first in'); await new Promise((r) => setTimeout(r, 300)); order.push('first out'); }),
                (async () => {
                    await new Promise((r) => setTimeout(r, 100));
                    await repository.inBatchLock(batch.id, async () => { order.push('second in'); });
                })(),
            ]);

            expect(order).toEqual(['first in', 'first out', 'second in']);
        });

        it('a batch event is written once per batch', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);

            const results = await Promise.all(Array.from({ length: 10 }, () =>
                repository.inBatchLock(batch.id, (scope) => scope.recordBatchEventOnce('final_review_alerted', 'race', {}))));

            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await batchEvents(batch.id, 'final_review_alerted')).toBe(1);
        });

        it('an order that enters another batch is owed its reminder again (events are per batch)', async () => {
            const first = await makeBatch('confirmed', [{ status: 'assigned' }]);
            await reminder.run(context(REMINDER));
            expect(mailsTo(first.emails).map((mail) => mail.template)).toEqual(['reminder']);
            const second = await makeBatch('confirmed', [{ status: 'in_planning', promised: false }]);
            await db.query(`DELETE FROM dispatches WHERE dispatch_id = $1`, [second.dispatchIds[0]]);
            await db.query(`UPDATE dispatches SET route_batch_id = $1 WHERE dispatch_id = $2`, [second.id, first.dispatchIds[0]]);

            await reminder.run(context(REMINDER));

            expect(mailsTo(first.emails).map((mail) => mail.template)).toEqual(['reminder', 'reminder']);
            expect(await reserved(first.dispatchIds[0], 'reminder')).toBe(2);
        });
    });

    describe('hardening found in the review', () => {
        it('the 16:29:59.9 tick still sends the 16:30 reminder', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);

            await reminder.run(context(new Date('2031-03-11T20:29:59.900Z')));

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']);
        });

        it('an order without email opens a coordinator follow-up, once, and sends nothing', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned', contact: 'none' }]);

            await reminder.run(context(REMINDER));
            await reminder.run(context(REMINDER));

            const events = await db.query(
                `SELECT 1 FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'contact_management_required'`, [batch.id],
            );
            expect(events).toHaveLength(1);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(0);
        });

        it('a bounced risk notice is recorded as NOT delivered: a late approval then sends the reminder, not «se mantiene»', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled', contact: 'bounce' }]);

            await escalation.run(context(ESCALATION));
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'bounced')).toBe(1);
            const followUps = await db.query(
                `SELECT 1 FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'contact_management_required'`, [batch.id],
            );
            expect(followUps).toHaveLength(1);

            await approve(batch);
            await lateApproval.handleRouteAssigned({ routeId: batch.id, driverId: 1, vehicleId: 1, dispatchIds: batch.dispatchIds, version: 1 }, AFTER_RISK);

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice', 'reminder']);
        });

        it('the escalation never writes an incident for an order whose batch was approved first', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            await approve(batch);

            const summary = await escalation.run(context(ESCALATION));

            expect(summary.escalatedBatchIds).not.toContain(batch.id);
            const incidents = await db.query(`SELECT 1 FROM dispatch_incidents WHERE dispatch_id = ANY($1::int[])`, [batch.dispatchIds]);
            expect(incidents).toHaveLength(0);
            expect(mailsTo(batch.emails)).toHaveLength(0);
        });

        it('the escalation waits for a concurrent approval that holds the batch lock, then does nothing', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            let released = false;

            const approval = repository.inBatchLock(batch.id, async (scope) => {
                await new Promise((r) => setTimeout(r, 400));
                await scope.manager.query(`UPDATE route_batches SET status = 'confirmed' WHERE route_batch_id = $1`, [batch.id]);
                await scope.manager.query(
                    `UPDATE dispatches SET dispatch_status_id = (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'assigned') WHERE dispatch_id = ANY($1::int[])`,
                    [batch.dispatchIds],
                );
                released = true;
            });
            await new Promise((r) => setTimeout(r, 100));
            const summary = await escalation.run(context(ESCALATION));
            await approval;

            expect(released).toBe(true);
            expect(summary.escalatedBatchIds).not.toContain(batch.id);
            expect(await db.query(`SELECT 1 FROM dispatch_incidents WHERE dispatch_id = ANY($1::int[])`, [batch.dispatchIds])).toHaveLength(0);
            expect(mailsTo(batch.emails)).toHaveLength(0);
        });
    });

    describe('late approval after the risk notice', () => {
        it('sends «tu entrega se mantiene», not the reminder, and only once', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            await escalation.run(context(ESCALATION));
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice']);
            await approve(batch);
            const event = { routeId: batch.id, driverId: 1, vehicleId: 1, dispatchIds: batch.dispatchIds, version: 1 };

            await lateApproval.handleRouteAssigned(event, AFTER_RISK);
            await lateApproval.handleRouteAssigned(event, new Date(AFTER_RISK.getTime() + 60_000));
            await reminder.run(context(new Date('2031-03-12T20:30:00Z')));

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice', 'delivery-maintained']);
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(0);
        });
    });

    /** Waits until the mailer holds a send of `template` to this address (the email is "in flight"). */
    async function waitForHeld(email: string, template: string) {
        for (let attempt = 0; attempt < 100; attempt++) {
            const found = held.find((entry) => entry.to === email && entry.template === template);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`The mailer never received "${template}" for ${email}`);
    }

    const routeAssigned = (batch: { id: number; dispatchIds: number[] }) =>
        ({ routeId: batch.id, driverId: 1, vehicleId: 1, dispatchIds: batch.dispatchIds, version: 1 });

    describe('risk notice in flight when the batch is approved (review of ST-51.4)', () => {
        it('resolved as bounced: the late approval decides nothing meanwhile, then the reminder goes out — never «se mantiene», never twice', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled', contact: 'hold' }]);

            const escalating = escalation.run(context(ESCALATION)); // the mailer holds the risk notice
            const risk = await waitForHeld(batch.emails[0], 'risk-notice');
            expect(await reserved(batch.dispatchIds[0], 'risk-notice')).toBe(1);
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'sent')).toBe(0);

            await approve(batch);
            await lateApproval.handleRouteAssigned(routeAssigned(batch), AFTER_RISK);
            // Nothing was decided around the notice that is still being sent.
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice']);
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(0);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(0);

            risk.resolve('bounced');
            await escalating;

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice', 'reminder']);
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'bounced')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(0);
            const followUps = await db.query(
                `SELECT 1 FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'contact_management_required'`, [batch.id],
            );
            expect(followUps.length).toBeGreaterThanOrEqual(1);
        });

        it('resolved as failed by the transport: the same, the reminder and never «se mantiene»', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled', contact: 'hold' }]);

            const escalating = escalation.run(context(ESCALATION));
            const risk = await waitForHeld(batch.emails[0], 'risk-notice');
            await approve(batch);
            await lateApproval.handleRouteAssigned(routeAssigned(batch), AFTER_RISK);
            risk.resolve('failed');
            await escalating;

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice', 'reminder']);
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'failed')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(0);
        });

        it('resolved as sent: «tu entrega se mantiene», never the reminder, once', async () => {
            const batch = await makeBatch('pending_final_review', [{ status: 'scheduled', contact: 'hold' }]);

            const escalating = escalation.run(context(ESCALATION));
            const risk = await waitForHeld(batch.emails[0], 'risk-notice');
            await approve(batch);
            await lateApproval.handleRouteAssigned(routeAssigned(batch), AFTER_RISK);
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice']);

            risk.resolve('sent');
            await escalating;
            // Asking again changes nothing: each email is reserved once.
            await lateApproval.handleRouteAssigned(routeAssigned(batch), new Date(AFTER_RISK.getTime() + 60_000));

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['risk-notice', 'delivery-maintained']);
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'sent')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(1);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(0);
        });
    });

    describe('abandoned reservations and the reconciliation task', () => {
        /** A risk notice reserved `minutesAgo` minutes ago that never got a result (events are append-only, so it is born old). */
        const reserveRiskNotice = (batch: { id: number; dispatchIds: number[] }, minutesAgo: number) =>
            db.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata, created_at)
                 VALUES ($1, 'notice_reserved', 'system', 'test', $2::jsonb, NOW() - make_interval(mins => $3::int))`,
                [batch.dispatchIds[0], JSON.stringify({ template: 'risk-notice', routeBatchId: batch.id }), minutesAgo],
            );
        const followUps = async (batchId: number, template: string): Promise<number> =>
            Number((await db.query(
                `SELECT COUNT(*) AS n FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'contact_management_required' AND metadata->>'template' = $2`,
                [batchId, template],
            ))[0].n);

        it('a reservation past its lease no longer blocks: the late approval sends the reminder and the sweep closes it once, with one follow-up', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);
            await reserveRiskNotice(batch, 30); // lease is 15 minutes

            await lateApproval.handleRouteAssigned(routeAssigned(batch), AFTER_RISK);
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']);

            await reconciliation.run(context(AFTER_RISK));
            await reconciliation.run(context(AFTER_RISK));

            expect(await results(batch.dispatchIds[0], 'risk-notice', 'abandoned')).toBe(1);
            expect(await followUps(batch.id, 'risk-notice')).toBe(1);
            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']); // never resent, never duplicated
            expect(await reserved(batch.dispatchIds[0], 'delivery-maintained')).toBe(0);
        });

        it('a reservation still inside its lease is in flight: the approval defers and the sweep leaves it alone', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);
            await reserveRiskNotice(batch, 1);

            await lateApproval.handleRouteAssigned(routeAssigned(batch), AFTER_RISK);
            await reconciliation.run(context(AFTER_RISK));

            expect(mailsTo(batch.emails)).toHaveLength(0);
            expect(await results(batch.dispatchIds[0], 'risk-notice', 'abandoned')).toBe(0);
            expect(await followUps(batch.id, 'risk-notice')).toBe(0);
        });

        it('a reminder tick that was lost is sent by the sweep once the hour has come, and only once', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);

            await reconciliation.run(context(REVIEW_END)); // 16:00: too early
            expect(mailsTo(batch.emails)).toHaveLength(0);
            await reconciliation.run(context(REMINDER));
            await reconciliation.run(context(REMINDER));

            expect(mailsTo(batch.emails).map((mail) => mail.template)).toEqual(['reminder']);
            expect(await reserved(batch.dispatchIds[0], 'reminder')).toBe(1);
        });

        it('the sweep sends nothing for a batch that was never approved', async () => {
            const pending = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);

            await reconciliation.run(context(REMINDER));

            expect(mailsTo(pending.emails)).toHaveLength(0);
        });
    });

    describe('guards found by the mutations', () => {
        it('abandonNotice re-checks the lease under the lock: a fresh reservation is not closed, an expired one is, once', async () => {
            const fresh = await makeBatch('confirmed', [{ status: 'assigned' }]);
            const expired = await makeBatch('confirmed', [{ status: 'assigned' }]);
            const reserve = (batch: { id: number; dispatchIds: number[] }, minutesAgo: number) => db.query(
                `INSERT INTO dispatch_events (dispatch_id, event_type, actor_type, reason, metadata, created_at)
                 VALUES ($1, 'notice_reserved', 'system', 'test', $2::jsonb, NOW() - make_interval(mins => $3::int))`,
                [batch.dispatchIds[0], JSON.stringify({ template: 'reminder', routeBatchId: batch.id }), minutesAgo],
            );
            await reserve(fresh, 1);
            await reserve(expired, 30);

            const freshClosed = await repository.inBatchLock(fresh.id, (scope) => scope.abandonNotice(fresh.dispatchIds[0], 'reminder'));
            const expiredClosed = await repository.inBatchLock(expired.id, (scope) => scope.abandonNotice(expired.dispatchIds[0], 'reminder'));
            const expiredAgain = await repository.inBatchLock(expired.id, (scope) => scope.abandonNotice(expired.dispatchIds[0], 'reminder'));

            expect(freshClosed).toBe(false);
            expect(expiredClosed).toBe(true);
            expect(expiredAgain).toBe(false);
            expect(await results(fresh.dispatchIds[0], 'reminder', 'abandoned')).toBe(0);
            expect(await results(expired.dispatchIds[0], 'reminder', 'abandoned')).toBe(1);
        });

        it('an order escalated in one batch is escalated again, with its own incident and notice, when it enters another unapproved batch', async () => {
            const first = await makeBatch('pending_final_review', [{ status: 'scheduled' }]);
            await escalation.run(context(ESCALATION));
            const incidents = async () => Number((await db.query(`SELECT COUNT(*) AS n FROM dispatch_incidents WHERE dispatch_id = $1`, [first.dispatchIds[0]]))[0].n);
            expect(await incidents()).toBe(1);
            expect(await reserved(first.dispatchIds[0], 'risk-notice')).toBe(1);
            const second = await makeBatch('pending_final_review', [{ status: 'in_planning', promised: false }]);
            await db.query(`DELETE FROM dispatches WHERE dispatch_id = $1`, [second.dispatchIds[0]]);
            await db.query(`UPDATE dispatches SET route_batch_id = $1 WHERE dispatch_id = $2`, [second.id, first.dispatchIds[0]]);

            await escalation.run(context(ESCALATION));

            expect(await incidents()).toBe(2);
            expect(await reserved(first.dispatchIds[0], 'risk-notice')).toBe(2);
        });
    });
});
