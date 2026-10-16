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
    let warehouseId = 0;
    const sent: Array<{ to: string; template: string }> = [];

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
                    return { status: 'sent' };
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
    async function makeBatch(status: string, orders: Array<{ status: OrderStatus; promised?: boolean }>) {
        const [{ route_batch_id }] = await db.query(
            `INSERT INTO route_batches (status, shift_date) VALUES ($1, $2) RETURNING route_batch_id`, [status, SHIFT],
        );
        batchIds.push(route_batch_id);
        const dispatchIds: number[] = [];
        const emails: string[] = [];
        for (const order of orders) {
            const ref = `${tag}-${++seq}`;
            refs.push(ref);
            const email = `${ref.toLowerCase()}@example.test`;
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
            emails.push(email);
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
    const dispatchEvents = async (dispatchId: number, type: string): Promise<number> =>
        Number((await db.query(`SELECT COUNT(*) AS n FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2`, [dispatchId, type]))[0].n);

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
            expect(await dispatchEvents(confirmed.dispatchIds[0], 'route_reminder_sent')).toBe(1);
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

    describe('idempotency record', () => {
        it('two callers claiming the same order event at once: exactly one wins', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);

            const results = await Promise.all([
                repository.claimDispatchEvent(batch.dispatchIds[0], 'route_reminder_sent', 'race', {}),
                repository.claimDispatchEvent(batch.dispatchIds[0], 'route_reminder_sent', 'race', {}),
            ]);

            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await dispatchEvents(batch.dispatchIds[0], 'route_reminder_sent')).toBe(1);
        });

        it('a batch event is not written for a batch that left the required status', async () => {
            const batch = await makeBatch('confirmed', [{ status: 'assigned' }]);

            const wrote = await repository.recordBatchEventOnce(batch.id, 'final_review_alerted', ['pending_final_review'], 'late', {});

            expect(wrote).toBe(false);
            expect(await batchEvents(batch.id, 'final_review_alerted')).toBe(0);
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
            expect(await dispatchEvents(batch.dispatchIds[0], 'delivery_maintained_sent')).toBe(1);
            expect(await dispatchEvents(batch.dispatchIds[0], 'route_reminder_sent')).toBe(0);
        });
    });
});
