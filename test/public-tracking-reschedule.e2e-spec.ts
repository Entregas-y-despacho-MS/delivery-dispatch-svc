// ST-224.1 — The customer's rescheduling by token, end to end (stage 5).
//
// Real AppModule and database, a routing double (1 km = 60 s) and a mailer that keeps what it was asked to send.
// The code, the proof and the slots go through the real endpoints. Every scenario builds its own zone, batches and
// customer, so one rescheduling never changes what another one sees; dates come from today with the operating
// calendar of the settings. Everything carries a per-run tag and is removed in afterAll; the settings it
// touches are restored.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/services/app.config.js';
import { SettingsService } from '../src/modules/settings/services/settings.service.js';
import { MailerPort } from '../src/plugins/mailer/mailer.port.js';
import { OsrmPort } from '../src/plugins/osrm/osrm.port.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { localDate, localInstant, operatingDayAfter } from '../src/app/planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../src/app/planning/domain/planning-settings.js';
import { PromiseWindowCandidatesRepository } from '../src/app/promise-firming/services/promise-window-candidates.repository.js';
import { PromiseWindowCloseService } from '../src/app/promise-firming/services/promise-window-close.service.js';
import { TrackedFixtures, type TrackedDispatch } from './helpers/tracked-dispatch.fixtures.js';

const MIN = 60_000;
const SETTINGS_UNDER_TEST = ['stop_service_minutes', 'planning_margin_pct', 'warehouse_prep_lead_minutes', 'reschedule_code_expiry_minutes'];

describe('Rescheduling by token (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let settings: SettingsService;
    let fixtures: TrackedFixtures;
    let close: PromiseWindowCloseService;
    let prefix: string;
    let warehouseId = 0;
    let d2 = '';
    let d3 = '';
    const osrm = new FakeOsrm();
    const originals = new Map<string, string>();
    const mails: { to: string; template: string; subject: string; context: Record<string, any> }[] = [];
    const scope = new Set<number>();

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const base = (token: string) => `/${prefix}/public/tracking/${token}`;
    const codes = () => mails.filter((mail) => mail.template === 'reschedule-code');

    class ScopedCandidates extends PromiseWindowCandidatesRepository {
        async findClosable(now: Date, windowMinutes: number, limit?: number) {
            return (await super.findClosable(now, windowMinutes, limit)).filter((id) => scope.has(id));
        }
    }

    async function setSetting(key: string, value: string) {
        await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
        await settings.refresh();
    }

    /** A fresh code, checked through the real endpoints: the proof of one rescheduling. */
    async function proofFor(token: string): Promise<string> {
        const sent = await http().post(`${base(token)}/verification-code`);
        expect(sent.status).toBe(200);
        const checked = await http().post(`${base(token)}/verification-code/verify`).send({ code: codes().at(-1)!.context.code });
        expect(checked.status).toBe(200);
        return checked.body.proof as string;
    }

    const slotsFor = async (token: string, proof: string) => {
        const res = await http().get(`${base(token)}/slots`).set('X-Verification-Proof', proof);
        expect(res.status).toBe(200);
        return res.body.slots as { slotId: string; deliveryDate: string; windowStart: string; windowEnd: string }[];
    };
    const reschedule = (token: string, slotId: string, proof?: string) => {
        const req = http().post(`${base(token)}/reschedule`).send({ slotId });
        return proof === undefined ? req : req.set('X-Verification-Proof', proof);
    };

    interface Scenario {
        zoneId: number;
        own: TrackedDispatch;
        ownBatch: number;
        /** Open batches: D2 (one told stop, 09:00-11:00) and D3 (one told stop, 09:00-11:00). */
        batchD2: number;
        batchD3: number;
        toldD2: TrackedDispatch;
        toldD3: TrackedDispatch;
        neighbour?: TrackedDispatch;
    }

    /** The customer, scheduled for D3 alone in its batch (or with a neighbour), and two open batches to move to. */
    async function scenario(options: { neighbour?: boolean; packages?: boolean; notifiedAt?: Date | null } = {}): Promise<Scenario> {
        const zoneId = await fixtures.createZone('S');
        const batch = async (date: string) => await fixtures.createBatch({ shiftDate: date, vehicleId: await fixtures.createVehicle(), zoneId, warehouseId });
        const told = async (batchId: number, date: string) => await fixtures.create({
            routeBatchId: batchId, zoneId, warehouseId, km: 2, sequence: 1, weightKg: 1,
            windowStart: localInstant(date, '09:00'), windowEnd: localInstant(date, '11:00'),
        });
        const ownBatch = await batch(d3);
        const own = await fixtures.create({
            routeBatchId: ownBatch, zoneId, warehouseId, km: 1, sequence: 1, weightKg: 10, packages: options.packages,
            notifiedAt: options.notifiedAt, windowStart: localInstant(d3, '09:00'), windowEnd: localInstant(d3, '11:00'),
        });
        scope.add(own.dispatchId);
        const neighbour = options.neighbour
            ? await fixtures.create({
                routeBatchId: ownBatch, zoneId, warehouseId, km: 3, sequence: 2, weightKg: 1, customerConfirmation: 'confirmed',
                windowStart: localInstant(d3, '11:00'), windowEnd: localInstant(d3, '13:00'),
            })
            : undefined;
        const batchD2 = await batch(d2);
        const batchD3 = await batch(d3);
        return { zoneId, own, ownBatch, batchD2, batchD3, toldD2: await told(batchD2, d2), toldD3: await told(batchD3, d3), neighbour };
    }

    const dispatchRow = async (id: number) => (await db.query(
        `SELECT s.name AS status, d.version, d.route_batch_id, d.sequence_order, d.customer_confirmation, d.promise_notified_at,
                d.promise_firmed_at, d.scheduled_window_start, d.scheduled_window_end
           FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id) WHERE d.dispatch_id = $1`, [id]))[0];
    const batchRow = async (id: number) => (await db.query(`SELECT status, version FROM route_batches WHERE route_batch_id = $1`, [id]))[0];
    const stopsOf = async (batchId: number) => await db.query(
        `SELECT dispatch_id, sequence_order, version, scheduled_window_start, scheduled_window_end FROM dispatches
          WHERE route_batch_id = $1 ORDER BY sequence_order`, [batchId]);
    const orders = async (ref: string) => await db.query(
        `SELECT payload FROM outbound_messages WHERE type = 'dispatch.shipment.prepare_requested' AND payload->'data'->>'salesOrderId' = $1
          ORDER BY (payload->'data'->>'recordVersion')::int`, [ref]);
    const reschedulings = async (id: number) => await db.query(`SELECT * FROM dispatch_reschedules WHERE dispatch_id = $1 ORDER BY dispatch_reschedule_id`, [id]);
    const batchEvents = async (id: number, type: string) => await db.query(
        `SELECT route_batch_id, dispatch_id, actor_type, reason, metadata FROM route_batch_events WHERE dispatch_id = $1 AND event_type = $2`, [id, type]);
    const dispatchEvents = async (id: number, type: string) => await db.query(
        `SELECT actor_type, reason, metadata FROM dispatch_events WHERE dispatch_id = $1 AND event_type = $2`, [id, type]);

    /** Everything a rescheduling could have touched, to prove a refusal changed nothing. */
    async function snapshot(s: Scenario) {
        const ids = [s.ownBatch, s.batchD2, s.batchD3];
        return {
            own: await dispatchRow(s.own.dispatchId),
            batches: await Promise.all(ids.map(batchRow)),
            stops: await Promise.all(ids.map(stopsOf)),
            reschedulings: (await reschedulings(s.own.dispatchId)).length,
            orders: (await orders(s.own.ref)).length,
            batchEvents: (await db.query(`SELECT COUNT(*)::int AS n FROM route_batch_events WHERE route_batch_id = ANY($1::int[])`, [ids]))[0].n,
        };
    }

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(osrm)
            .overrideProvider(MailerPort).useValue({ send: async (mail: any) => { mails.push(mail); return { status: 'sent' }; } })
            .overrideProvider(PromiseWindowCandidatesRepository)
            .useFactory({ factory: (ds: DataSource) => new ScopedCandidates(ds), inject: [DataSource] })
            .compile();
        app = moduleRef.createNestApplication();
        prefix = app.get(AppConfig).apiPrefix;
        app.setGlobalPrefix(prefix);
        app.useGlobalPipes(new ValidationPipe({
            transform: true, whitelist: true, forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: false },
        }));
        app.useGlobalFilters(new HttpExceptionFilter());
        await app.init();
        db = moduleRef.get(DataSource);
        settings = moduleRef.get(SettingsService);
        close = moduleRef.get(PromiseWindowCloseService);
        fixtures = new TrackedFixtures(db, `E2EPUBRSC-${run}`);

        for (const key of SETTINGS_UNDER_TEST) {
            const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]);
            originals.set(key, row?.setting_value ?? '');
        }
        await setSetting('stop_service_minutes', '15');
        await setSetting('planning_margin_pct', '20');
        await setSetting('warehouse_prep_lead_minutes', '60');
        await setSetting('reschedule_code_expiry_minutes', '10');

        const calendar = (await loadPlanningSettings(settings)).values!.calendar;
        const today = localDate(new Date());
        d2 = operatingDayAfter(today, 2, calendar);
        d3 = operatingDayAfter(today, 3, calendar);
        warehouseId = (await fixtures.warehouses())[0].id;
    });

    afterAll(async () => {
        if (db) {
            for (const [key, value] of originals) await setSetting(key, value);
            await fixtures.cleanup();
        }
        await app?.close();
    });

    describe('a valid rescheduling', () => {
        it('moves the dispatch to the chosen batch keeping it scheduled, and firms the promise without renewing the notice', async () => {
            const s = await scenario();
            const before = await dispatchRow(s.own.dispatchId);
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;

            const res = await reschedule(s.own.token, slot.slotId, proof);

            expect(res.status).toBe(200);
            expect(res.headers['cache-control']).toBe('no-store');
            expect(res.body).toMatchObject({
                status: 'scheduled', customerConfirmation: 'rescheduled', deliveryDate: d2,
                windowStart: localInstant(d2, '09:00').toISOString(), windowEnd: localInstant(d2, '11:00').toISOString(),
                selfService: { open: true, rescheduleAttemptsLeft: 1, canConfirm: false, canReschedule: true },
            });
            const after = await dispatchRow(s.own.dispatchId);
            expect(after).toMatchObject({ status: 'scheduled', route_batch_id: s.batchD2, customer_confirmation: 'rescheduled', version: before.version + 1 });
            expect(after.promise_firmed_at).not.toBeNull();
            // The clock of the 12 hours is the one of the first notice.
            expect(after.promise_notified_at).toEqual(before.promise_notified_at);
            expect(after.scheduled_window_start).toEqual(localInstant(d2, '09:00'));
            expect(after.scheduled_window_end).toEqual(localInstant(d2, '11:00'));
        });

        it('enters the new batch and leaves the old one: both versions move and the empty origin is cancelled', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const [destination, origin] = [await batchRow(s.batchD2), await batchRow(s.ownBatch)];

            await reschedule(s.own.token, slot.slotId, proof);

            expect(await batchRow(s.batchD2)).toMatchObject({ status: 'provisional', version: destination.version + 1 });
            expect(await batchRow(s.ownBatch)).toMatchObject({ status: 'cancelled', version: origin.version + 1 });
            expect(await stopsOf(s.ownBatch)).toEqual([]);
            const stops = await stopsOf(s.batchD2);
            expect(stops.map((stop: any) => stop.sequence_order)).toEqual([1, 2]);
            expect(stops.map((stop: any) => Number(stop.dispatch_id)).sort()).toEqual([s.own.dispatchId, s.toldD2.dispatchId].sort());
            const [cancelled] = await batchEvents(s.own.dispatchId, 'cancelled');
            expect(cancelled).toBeUndefined();
            expect((await db.query(`SELECT reason FROM route_batch_events WHERE route_batch_id = $1 AND event_type = 'cancelled'`, [s.ownBatch])))
                .toMatchObject([{ reason: 'customer_rescheduled_emptied' }]);
        });

        it('keeps the window of a customer already told: the stop that was there is never pushed out of it', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const before = (await stopsOf(s.batchD2))[0];

            await reschedule(s.own.token, slot.slotId, proof);

            const told = (await stopsOf(s.batchD2)).find((stop: any) => Number(stop.dispatch_id) === s.toldD2.dispatchId);
            expect(told.scheduled_window_start).toEqual(before.scheduled_window_start);
            expect(told.scheduled_window_end).toEqual(before.scheduled_window_end);
            // It moved one place down, so its version moved with it (D-09).
            expect(told.sequence_order).toBe(2);
            expect(told.version).toBe(before.version + 1);
        });

        it('closes the gap in the old batch when other customers stay in it, and bumps only those that changed place', async () => {
            const s = await scenario({ neighbour: true });
            const neighbourBefore = await dispatchRow(s.neighbour!.dispatchId);
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;

            await reschedule(s.own.token, slot.slotId, proof);

            expect(await batchRow(s.ownBatch)).toMatchObject({ status: 'provisional' });
            const neighbourAfter = await dispatchRow(s.neighbour!.dispatchId);
            expect(neighbourAfter).toMatchObject({ sequence_order: 1, version: neighbourBefore.version + 1, route_batch_id: s.ownBatch });
            // Its slot and its promise are untouched.
            expect(neighbourAfter.scheduled_window_start).toEqual(neighbourBefore.scheduled_window_start);
            expect(neighbourAfter.promise_firmed_at).toBeNull();
        });

        it('writes the rescheduling by the customer and one batch event of the movement, linked by their metadata', async () => {
            const s = await scenario();
            const before = await dispatchRow(s.own.dispatchId);
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;

            await reschedule(s.own.token, slot.slotId, proof);

            const [row] = await reschedulings(s.own.dispatchId);
            expect(row).toMatchObject({
                rescheduled_by: null, rescheduled_by_type: 'customer',
                previous_route_batch_id: s.ownBatch, new_route_batch_id: s.batchD2,
            });
            expect(row.previous_window_start).toEqual(before.scheduled_window_start);
            expect(row.new_window_start).toEqual(localInstant(d2, '09:00'));
            expect(row.new_window_end).toEqual(localInstant(d2, '11:00'));
            const [reason] = await db.query(`SELECT code FROM reschedule_reasons WHERE reschedule_reason_id = $1`, [row.reschedule_reason_id]);
            expect(reason.code).toBe('RES-CLI-SELF');

            const events = await batchEvents(s.own.dispatchId, 'customer_rescheduled');
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ route_batch_id: s.batchD2, actor_type: 'customer' });
            expect(events[0].metadata).toMatchObject({
                rescheduleId: row.dispatch_reschedule_id, fromBatchId: s.ownBatch, toBatchId: s.batchD2, recordVersion: 2,
                fromBatchCancelled: true, promiseFirmedByThisRescheduling: true,
            });
            expect(await dispatchEvents(s.own.dispatchId, 'moved_between_batches')).toMatchObject([{ actor_type: 'customer', reason: 'customer_reschedule' }]);
            expect(await dispatchEvents(s.own.dispatchId, 'promise_firmed')).toMatchObject([{ actor_type: 'customer', metadata: { reason: 'customer_rescheduled', recordVersion: 2 } }]);
        });

        it('queues one preparation order with the new date, slot and a higher recordVersion', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            expect(await orders(s.own.ref)).toHaveLength(0);

            await reschedule(s.own.token, slot.slotId, proof);

            const queued = await orders(s.own.ref);
            expect(queued).toHaveLength(1);
            expect(queued[0].payload.data).toMatchObject({
                salesOrderId: s.own.ref, recordVersion: 2, departureDate: d2,
                deliveryWindowStart: localInstant(d2, '09:00').toISOString(), deliveryWindowEnd: localInstant(d2, '11:00').toISOString(),
            });
        });

        it('does not emit a second order when the 12 h window closes afterwards', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            await reschedule(s.own.token, slot.slotId, proof);
            const notifiedAt: Date = (await dispatchRow(s.own.dispatchId)).promise_notified_at;

            await close.run(new Date(notifiedAt.getTime() + 725 * MIN));

            expect(await orders(s.own.ref)).toHaveLength(1);
            expect((await dispatchRow(s.own.dispatchId)).customer_confirmation).toBe('rescheduled');
        });

        it('sends the customer an email with the new slot and records it, without renewing the notice', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const before = mails.length;

            await reschedule(s.own.token, slot.slotId, proof);

            const confirmation = mails.slice(before).filter((mail) => mail.template === 'promise');
            expect(confirmation).toHaveLength(1);
            expect(confirmation[0]).toMatchObject({ to: 'customer@example.test', subject: 'Tu entrega fue reprogramada' });
            expect(confirmation[0].context.trackingUrl).toContain(`/seguimiento/${s.own.token}`);
            expect(await dispatchEvents(s.own.dispatchId, 'reschedule_confirmation_sent')).toHaveLength(1);
            expect(await dispatchEvents(s.own.dispatchId, 'promise_email_sent')).toHaveLength(0);
        });

        it('never writes the token to the audit trail, the batch events or the outbox', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            await reschedule(s.own.token, slot.slotId, proof);

            const [{ n }] = await db.query(
                `SELECT (
                    (SELECT COUNT(*) FROM dispatch_events WHERE dispatch_id = $1 AND (reason LIKE $2 OR detail LIKE $2 OR metadata::text LIKE $2))
                  + (SELECT COUNT(*) FROM route_batch_events WHERE dispatch_id = $1 AND (reason LIKE $2 OR metadata::text LIKE $2))
                  + (SELECT COUNT(*) FROM outbound_messages WHERE payload::text LIKE $2)
                 )::int AS n`,
                [s.own.dispatchId, `%${s.own.token}%`],
            );
            expect(n).toBe(0);
        });
    });

    describe('a second rescheduling', () => {
        it('replaces the order with a higher recordVersion, keeps the promise and the notice, and ends the self-service at the limit', async () => {
            const s = await scenario();
            const firstProof = await proofFor(s.own.token);
            const first = (await slotsFor(s.own.token, firstProof)).find((candidate) => candidate.deliveryDate === d2)!;
            await reschedule(s.own.token, first.slotId, firstProof);
            const afterFirst = await dispatchRow(s.own.dispatchId);

            // The proof was spent: another rescheduling needs another code.
            const secondProof = await proofFor(s.own.token);
            const options = await slotsFor(s.own.token, secondProof);
            const second = options.find((candidate) => candidate.deliveryDate === d3)!;
            const res = await reschedule(s.own.token, second.slotId, secondProof);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                customerConfirmation: 'rescheduled', deliveryDate: d3,
                selfService: { open: false, closedReason: 'max_attempts', rescheduleAttemptsLeft: 0, canReschedule: false, canRequestChange: true },
            });
            const queued = await orders(s.own.ref);
            expect(queued.map((q: any) => q.payload.data.recordVersion)).toEqual([2, 3]);
            expect(queued[1].payload.messageId).not.toBe(queued[0].payload.messageId);
            expect(queued[1].payload.data).toMatchObject({ departureDate: d3, deliveryWindowStart: localInstant(d3, '09:00').toISOString() });
            const afterSecond = await dispatchRow(s.own.dispatchId);
            expect(afterSecond).toMatchObject({ route_batch_id: s.batchD3, version: afterFirst.version + 1 });
            expect(afterSecond.promise_firmed_at).toEqual(afterFirst.promise_firmed_at);
            expect(afterSecond.promise_notified_at).toEqual(afterFirst.promise_notified_at);
            expect(await reschedulings(s.own.dispatchId)).toHaveLength(2);
            expect(await dispatchEvents(s.own.dispatchId, 'promise_firmed')).toHaveLength(1);
            expect(await dispatchEvents(s.own.dispatchId, 'preparation_order_reissued')).toMatchObject([{ actor_type: 'customer', metadata: { recordVersion: 3 } }]);
            // The batch it left the second time (D2, with the told stop) keeps the told stop alone, numbered from 1.
            expect((await stopsOf(s.batchD2)).map((stop: any) => [Number(stop.dispatch_id), stop.sequence_order])).toEqual([[s.toldD2.dispatchId, 1]]);
        });

        it('does not allow a third one: the limit of max_reschedule_attempts', async () => {
            const s = await scenario();
            const firstProof = await proofFor(s.own.token);
            await reschedule(s.own.token, (await slotsFor(s.own.token, firstProof)).find((c) => c.deliveryDate === d2)!.slotId, firstProof);
            const secondProof = await proofFor(s.own.token);
            await reschedule(s.own.token, (await slotsFor(s.own.token, secondProof)).find((c) => c.deliveryDate === d3)!.slotId, secondProof);
            const frozen = await snapshot(s);
            const sentCodes = codes().length;

            const code = await http().post(`${base(s.own.token)}/verification-code`);
            const listing = await http().get(`${base(s.own.token)}/slots`).set('X-Verification-Proof', secondProof);
            const attempt = await reschedule(s.own.token, buildSomeSlot(), secondProof);

            for (const res of [code, listing, attempt]) {
                expect(res.status).toBe(409);
                expect(res.body).toMatchObject({ error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason: 'max_attempts' } });
            }
            expect(codes()).toHaveLength(sentCodes);
            expect(await snapshot(s)).toEqual(frozen);
        });
    });

    describe('the proof', () => {
        it('is required, and a missing or wrong one moves nothing', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof))[0];
            const frozen = await snapshot(s);

            for (const header of [undefined, '', 'nope', 'a'.repeat(64)]) {
                const res = await reschedule(s.own.token, slot.slotId, header);
                expect(res.status).toBe(403);
                expect(res.body.error).toBe('VERIFICATION_REQUIRED');
            }
            expect(await snapshot(s)).toEqual(frozen);
        });

        it('is spent by a rescheduling: the same one cannot be used again', async () => {
            const s = await scenario({ neighbour: true });
            const proof = await proofFor(s.own.token);
            const options = await slotsFor(s.own.token, proof);
            await reschedule(s.own.token, options.find((candidate) => candidate.deliveryDate === d2)!.slotId, proof);
            const frozen = await snapshot(s);

            const again = await reschedule(s.own.token, options.find((candidate) => candidate.deliveryDate === d3)!.slotId, proof);

            expect(again.status).toBe(403);
            expect(again.body.error).toBe('VERIFICATION_REQUIRED');
            expect(await snapshot(s)).toEqual(frozen);
        });

        it('is claimed atomically: simultaneous requests with the same proof and the same slot reschedule exactly once', async () => {
            const s = await scenario({ neighbour: true });
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const before = await dispatchRow(s.own.dispatchId);

            const results = await Promise.all(Array.from({ length: 8 }, () => reschedule(s.own.token, slot.slotId, proof)));

            expect(results.filter((res) => res.status === 200)).toHaveLength(1);
            for (const refused of results.filter((res) => res.status !== 200)) {
                expect(refused.status).toBe(403);
                expect(refused.body.error).toBe('VERIFICATION_REQUIRED');
            }
            // One movement, one order, one version bump: not eight.
            expect(await reschedulings(s.own.dispatchId)).toHaveLength(1);
            expect(await orders(s.own.ref)).toHaveLength(1);
            expect((await dispatchRow(s.own.dispatchId)).version).toBe(before.version + 1);
            expect(await batchEvents(s.own.dispatchId, 'customer_rescheduled')).toHaveLength(1);
            expect((await reschedule(s.own.token, slot.slotId, proof)).status).toBe(403);
        });

        it('is claimed atomically: simultaneous requests with the same proof and different slots move the delivery once', async () => {
            const s = await scenario({ neighbour: true });
            const proof = await proofFor(s.own.token);
            const options = await slotsFor(s.own.token, proof);
            const toD2 = options.find((candidate) => candidate.deliveryDate === d2)!;
            const toD3 = options.find((candidate) => candidate.deliveryDate === d3)!;

            const results = await Promise.all([toD2, toD3, toD2, toD3].map((slot) => reschedule(s.own.token, slot.slotId, proof)));

            expect(results.filter((res) => res.status === 200)).toHaveLength(1);
            expect(results.filter((res) => res.status === 403)).toHaveLength(3);
            expect(await reschedulings(s.own.dispatchId)).toHaveLength(1);
            expect(await orders(s.own.ref)).toHaveLength(1);
            const winner = results.find((res) => res.status === 200)!;
            expect((await dispatchRow(s.own.dispatchId)).route_batch_id).toBe(winner.body.deliveryDate === d2 ? s.batchD2 : s.batchD3);
        });

        it('is given back when the rescheduling does not happen, also under simultaneous requests', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const chosen = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const [{ vehicle_id }] = await db.query(`SELECT vehicle_id FROM route_batches WHERE route_batch_id = $1`, [s.batchD2]);
            await db.query(`UPDATE vehicles SET capacity_kg = 1 WHERE vehicle_id = $1`, [vehicle_id]);
            const frozen = await snapshot(s);

            const results = await Promise.all(Array.from({ length: 4 }, () => reschedule(s.own.token, chosen.slotId, proof)));

            // The one that held the proof was refused for the slot; the others never had it. Nothing moved.
            expect(results.filter((res) => res.status === 409).map((res) => res.body.error)).toEqual(['SLOT_NO_LONGER_AVAILABLE']);
            expect(results.filter((res) => res.status === 403)).toHaveLength(3);
            expect(await snapshot(s)).toEqual(frozen);
            // And the customer still has the proof for another choice.
            const other = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d3)!;
            expect((await reschedule(s.own.token, other.slotId, proof)).status).toBe(200);
        });

        it('belongs to one delivery: the proof of another customer does not move this one', async () => {
            const mine = await scenario();
            const other = await scenario();
            const otherProof = await proofFor(other.own.token);
            const slot = (await slotsFor(other.own.token, otherProof))[0];
            const frozen = await snapshot(mine);

            const res = await reschedule(mine.own.token, slot.slotId, otherProof);

            expect(res.status).toBe(403);
            expect(await snapshot(mine)).toEqual(frozen);
        });
    });

    describe('what stops it', () => {
        it('the original window elapsed: nothing can be started or finished, and nothing moves', async () => {
            const s = await scenario({ notifiedAt: new Date(Date.now() - 721 * MIN) });
            const frozen = await snapshot(s);

            const code = await http().post(`${base(s.own.token)}/verification-code`);
            const attempt = await reschedule(s.own.token, buildSomeSlot(), 'a'.repeat(64));

            for (const res of [code, attempt]) {
                expect(res.status).toBe(409);
                expect(res.body).toMatchObject({ error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason: 'window_elapsed' } });
            }
            expect(await snapshot(s)).toEqual(frozen);
        });

        it('the window ends between the proof and the choice: the choice is refused and nothing moves', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            await db.query(`UPDATE dispatches SET promise_notified_at = NOW() - INTERVAL '13 hours' WHERE dispatch_id = $1`, [s.own.dispatchId]);
            const frozen = await snapshot(s);

            const res = await reschedule(s.own.token, slot.slotId, proof);

            expect(res.status).toBe(409);
            expect(res.body.details).toEqual({ reason: 'window_elapsed' });
            expect(await snapshot(s)).toEqual(frozen);
        });

        it('the customer already confirmed or asked for a change', async () => {
            const confirmed = await scenario();
            const proof = await proofFor(confirmed.own.token);
            const slot = (await slotsFor(confirmed.own.token, proof))[0];
            expect((await http().post(`${base(confirmed.own.token)}/confirm`)).status).toBe(200);
            const frozen = await snapshot(confirmed);

            const res = await reschedule(confirmed.own.token, slot.slotId, proof);

            expect(res.status).toBe(409);
            expect(res.body.details).toEqual({ reason: 'confirmed' });
            expect(await snapshot(confirmed)).toEqual(frozen);
        });

        it('the notice never reached the customer (bounced) or there is no email', async () => {
            const bounced = await scenario({ notifiedAt: null });

            const res = await http().post(`${base(bounced.own.token)}/verification-code`);

            expect(res.status).toBe(409);
            expect(res.body.details).toEqual({ reason: 'no_valid_notice' });
        });

        it('the slot is gone when it is chosen: 409, nothing moves, and the proof is still good for another choice', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const options = await slotsFor(s.own.token, proof);
            const chosen = options.find((candidate) => candidate.deliveryDate === d2)!;
            // The only vehicle of that batch can no longer carry the customer's load.
            const [{ vehicle_id }] = await db.query(`SELECT vehicle_id FROM route_batches WHERE route_batch_id = $1`, [s.batchD2]);
            await db.query(`UPDATE vehicles SET capacity_kg = 1 WHERE vehicle_id = $1`, [vehicle_id]);
            const frozen = await snapshot(s);

            const res = await reschedule(s.own.token, chosen.slotId, proof);

            expect(res.status).toBe(409);
            expect(res.body.error).toBe('SLOT_NO_LONGER_AVAILABLE');
            expect(await snapshot(s)).toEqual(frozen);
            const fresh = await slotsFor(s.own.token, proof);
            expect(fresh.map((candidate) => candidate.deliveryDate)).not.toContain(d2);
            const other = fresh.find((candidate) => candidate.deliveryDate === d3)!;
            expect((await reschedule(s.own.token, other.slotId, proof)).status).toBe(200);
        });

        it('the destination changed after the listing: the choice is judged on the plan as it is now', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const chosen = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            // Another customer is added to the destination batch meanwhile (the batch version moves).
            const extra = await fixtures.create({
                routeBatchId: s.batchD2, zoneId: s.zoneId, warehouseId, km: 4, sequence: 2, weightKg: 1,
                windowStart: localInstant(d2, '09:00'), windowEnd: localInstant(d2, '11:00'),
            });
            await db.query(`UPDATE route_batches SET version = version + 1 WHERE route_batch_id = $1`, [s.batchD2]);

            const res = await reschedule(s.own.token, chosen.slotId, proof);

            expect(res.status).toBe(200);
            const stops = await stopsOf(s.batchD2);
            expect(stops.map((stop: any) => stop.sequence_order)).toEqual([1, 2, 3]);
            expect(stops.map((stop: any) => Number(stop.dispatch_id))).toContain(extra.dispatchId);
        });

        it('does not firm a promise whose order cannot be built: the rescheduling is undone completely', async () => {
            const s = await scenario({ packages: false });
            const proof = await proofFor(s.own.token);
            const slot = (await slotsFor(s.own.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
            const frozen = await snapshot(s);

            const res = await reschedule(s.own.token, slot.slotId, proof);

            expect(res.status).toBe(409);
            expect(res.body.details).toEqual({ reason: 'order_incomplete' });
            expect(await snapshot(s)).toEqual(frozen);
            expect((await dispatchRow(s.own.dispatchId)).promise_firmed_at).toBeNull();
            // The proof was not spent: the customer can still list the slots, ask for a change or try again.
            expect((await slotsFor(s.own.token, proof)).length).toBeGreaterThan(0);
        });

        it('rejects a malformed slot id as a validation error and an unknown one as no longer available', async () => {
            const s = await scenario();
            const proof = await proofFor(s.own.token);
            const frozen = await snapshot(s);

            for (const slotId of ['', 'abc', '1', '1.', '.1', '1.2.3', 12]) {
                const res = await http().post(`${base(s.own.token)}/reschedule`).set('X-Verification-Proof', proof).send({ slotId });
                expect(res.status).toBe(400);
                expect(res.body.error).toBe('Bad Request');
            }
            expect((await http().post(`${base(s.own.token)}/reschedule`).set('X-Verification-Proof', proof).send({})).status).toBe(400);
            const unknown = await reschedule(s.own.token, '999999.1789000000', proof);
            expect(unknown.status).toBe(409);
            expect(unknown.body.error).toBe('SLOT_NO_LONGER_AVAILABLE');
            expect(await snapshot(s)).toEqual(frozen);
        });

        it('the tracking code does not open it, and an unknown token answers the same 404', async () => {
            const s = await scenario();

            const byCode = await reschedule(s.own.trackingCode, buildSomeSlot(), 'a'.repeat(64));
            const unknown = await reschedule('00000000-0000-4000-8000-000000000000', buildSomeSlot(), 'a'.repeat(64));

            for (const res of [byCode, unknown]) {
                expect(res.status).toBe(404);
                expect(res.body).toMatchObject({ error: 'TRACKING_LINK_NOT_FOUND', path: `/${prefix}/public/tracking/:token/reschedule` });
            }
        });
    });

    describe('two customers at once', () => {
        it('never leaves a batch with a repeated or missing place, and each customer is either moved or untouched', async () => {
            const zoneId = await fixtures.createZone('R');
            const batch = async (date: string) => await fixtures.createBatch({ shiftDate: date, vehicleId: await fixtures.createVehicle(), zoneId, warehouseId });
            const destination = await batch(d2);
            await fixtures.create({
                routeBatchId: destination, zoneId, warehouseId, km: 2, sequence: 1, weightKg: 1,
                windowStart: localInstant(d2, '09:00'), windowEnd: localInstant(d2, '11:00'),
            });
            const customers: { dispatch: TrackedDispatch; origin: number }[] = [];
            for (let i = 0; i < 3; i++) {
                const origin = await batch(d3);
                const dispatch = await fixtures.create({
                    routeBatchId: origin, zoneId, warehouseId, km: 1 + i * 0.5, sequence: 1, weightKg: 1,
                    windowStart: localInstant(d3, '09:00'), windowEnd: localInstant(d3, '11:00'),
                });
                customers.push({ dispatch, origin });
            }
            // The codes are asked one after the other (the mailer keeps them in a list); only the choices race.
            const prepared = [];
            for (const { dispatch } of customers) {
                const proof = await proofFor(dispatch.token);
                const slot = (await slotsFor(dispatch.token, proof)).find((candidate) => candidate.deliveryDate === d2)!;
                prepared.push({ dispatch, proof, slot });
            }

            const results = await Promise.all(prepared.map(({ dispatch, proof, slot }) => reschedule(dispatch.token, slot.slotId, proof)));

            for (const res of results) expect([200, 409]).toContain(res.status);
            expect(results.some((res) => res.status === 200)).toBe(true);
            for (const res of results.filter((r) => r.status === 409)) expect(res.body.error).toBe('SLOT_NO_LONGER_AVAILABLE');
            const stops = await stopsOf(destination);
            expect(stops.map((stop: any) => stop.sequence_order)).toEqual(stops.map((_stop: any, i: number) => i + 1));
            const moved = new Set(stops.map((stop: any) => Number(stop.dispatch_id)));
            for (const [i, { dispatch, origin }] of customers.entries()) {
                const row = await dispatchRow(dispatch.dispatchId);
                if (results[i].status === 200) {
                    expect(moved.has(dispatch.dispatchId)).toBe(true);
                    expect(row.route_batch_id).toBe(destination);
                    expect(await orders(dispatch.ref)).toHaveLength(1);
                } else {
                    expect(moved.has(dispatch.dispatchId)).toBe(false);
                    expect(row.route_batch_id).toBe(origin);
                    expect(await orders(dispatch.ref)).toHaveLength(0);
                    expect(await reschedulings(dispatch.dispatchId)).toHaveLength(0);
                }
            }
        });
    });

    /** A well-formed id that matches no offer, for the requests that must be refused before the slot matters. */
    function buildSomeSlot(): string {
        return `1.${Math.floor(Date.now() / 1000)}`;
    }
});
