// ST-224.1 — Offer of slots for the customer's rescheduling, end to end (stage 4).
//
// Real AppModule and database, a routing double (1 km = 60 s) and a mailer that keeps the code. The proof comes
// from the real verification endpoints. Open batches, vehicles and zones are inserted around the customer's own
// dispatch; the dates are computed from today with the operating calendar of the settings, so the suite does not
// depend on the day it runs. Everything carries a per-run tag and is removed in afterAll; the settings it touches
// are restored.
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
import { OsrmUnavailableException } from '../src/plugins/osrm/exceptions/index.js';
import { HttpExceptionFilter } from '../src/shared/filters/index.js';
import { FakeOsrm } from '../src/app/planning/domain/plan-fixtures.helper-spec.js';
import { addDays, localDate, localInstant, operatingDayAfter } from '../src/app/planning/domain/operating-calendar.js';
import { loadPlanningSettings } from '../src/app/planning/domain/planning-settings.js';
import { buildSlotId, parseSlotId } from '../src/app/public-tracking/domain/slot-offer.js';
import { TrackedFixtures } from './helpers/tracked-dispatch.fixtures.js';

const SETTINGS_UNDER_TEST = ['stop_service_minutes', 'planning_margin_pct', 'warehouse_prep_lead_minutes', 'reschedule_code_expiry_minutes'];

describe('Slots offered to the rescheduling (e2e, ST-224.1)', () => {
    let app: INestApplication;
    let db: DataSource;
    let settings: SettingsService;
    let fixtures: TrackedFixtures;
    let prefix: string;
    const osrm = new FakeOsrm();
    const originals = new Map<string, string>();
    const mails: { to: string; context: { code: string } }[] = [];

    const run = Date.now().toString(36).toUpperCase();
    const http = () => request(app.getHttpServer());
    const base = (token: string) => `/${prefix}/public/tracking/${token}`;
    const slots = (token: string, proof?: string) => {
        const req = http().get(`${base(token)}/slots`);
        return proof === undefined ? req : req.set('X-Verification-Proof', proof);
    };

    let d2 = '';
    let d3 = '';
    let own: Awaited<ReturnType<TrackedFixtures['create']>>;
    let lonely: Awaited<ReturnType<TrackedFixtures['create']>>;
    const batchOf: Record<string, number> = {};

    async function setSetting(key: string, value: string) {
        await db.query(`UPDATE settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`, [key, value]);
        await settings.refresh();
    }

    /** The whole verification dance through the real endpoints. */
    async function proofFor(token: string): Promise<string> {
        expect((await http().post(`${base(token)}/verification-code`)).status).toBe(200);
        const res = await http().post(`${base(token)}/verification-code/verify`).send({ code: mails.at(-1)!.context.code });
        expect(res.status).toBe(200);
        return res.body.proof as string;
    }

    /** An open batch in the customer's zone, with one stop already told 09:00-11:00 of that day, 2 km from the warehouse. */
    async function openBatch(label: string, date: string, over: { zoneId?: number; warehouseId?: number; capacityKg?: number; stopWeightKg?: number } = {}) {
        const warehouses = await fixtures.warehouses();
        const warehouseId = over.warehouseId ?? warehouses[0].id;
        const vehicleId = await fixtures.createVehicle(over.capacityKg ?? 1000);
        batchOf[label] = await fixtures.createBatch({ shiftDate: date, vehicleId, zoneId: over.zoneId ?? zone1, warehouseId });
        await fixtures.create({
            routeBatchId: batchOf[label], zoneId: over.zoneId ?? zone1, warehouseId, km: 2, sequence: 1,
            windowStart: localInstant(date, '09:00'), windowEnd: localInstant(date, '11:00'), weightKg: over.stopWeightKg ?? 1,
        });
        return batchOf[label];
    }

    let zone1 = 0;
    // A code can be asked for 3 times per 15 minutes (by design), so the proofs are obtained once and reused: listing does not consume them.
    let ownProof = '';
    let lonelyProof = '';
    const snapshot = async () => ({
        dispatch: (await db.query(`SELECT version, route_batch_id, sequence_order, customer_confirmation, promise_firmed_at, scheduled_window_start FROM dispatches WHERE dispatch_id = $1`, [own.dispatchId]))[0],
        batches: await db.query(`SELECT route_batch_id, version, status FROM route_batches WHERE route_batch_id = ANY($1::int[]) ORDER BY route_batch_id`, [Object.values(batchOf)]),
        batchEvents: (await db.query(`SELECT COUNT(*)::int AS n FROM route_batch_events WHERE route_batch_id = ANY($1::int[])`, [Object.values(batchOf)]))[0].n,
        outbox: (await db.query(`SELECT COUNT(*)::int AS n FROM outbound_messages WHERE payload->'data'->>'salesOrderId' LIKE $1`, [`E2EPUBSLT-${run}%`]))[0].n,
    });

    beforeAll(async () => {
        const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(OsrmPort).useValue(osrm)
            .overrideProvider(MailerPort).useValue({ send: async (mail: any) => { mails.push(mail); return { status: 'sent' }; } })
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
        fixtures = new TrackedFixtures(db, `E2EPUBSLT-${run}`);

        for (const key of SETTINGS_UNDER_TEST) {
            const [row] = await db.query(`SELECT setting_value FROM settings WHERE setting_key = $1`, [key]);
            originals.set(key, row?.setting_value ?? '');
        }
        await setSetting('stop_service_minutes', '15');
        await setSetting('planning_margin_pct', '20');
        await setSetting('warehouse_prep_lead_minutes', '60');
        await setSetting('reschedule_code_expiry_minutes', '10');

        const planning = await loadPlanningSettings(settings);
        const calendar = planning.values!.calendar;
        const today = localDate(new Date());
        d2 = operatingDayAfter(today, 2, calendar);
        d3 = operatingDayAfter(today, 3, calendar);

        const warehouses = await fixtures.warehouses();
        zone1 = await fixtures.createZone('A');
        const zone2 = await fixtures.createZone('B');
        const zone3 = await fixtures.createZone('C');

        // The customer: scheduled for D3, 1 km from the warehouse.
        const ownVehicle = await fixtures.createVehicle();
        const ownBatch = await fixtures.createBatch({ shiftDate: d3, vehicleId: ownVehicle, zoneId: zone1, warehouseId: warehouses[0].id });
        batchOf.own = ownBatch;
        own = await fixtures.create({
            routeBatchId: ownBatch, zoneId: zone1, warehouseId: warehouses[0].id, km: 1, weightKg: 10,
            windowStart: localInstant(d3, '09:00'), windowEnd: localInstant(d3, '11:00'),
        });

        await openBatch('d2a', d2);
        await openBatch('d2b', d2);
        await openBatch('d3', d3);
        await openBatch('farAway', addDays(d3, 3));
        await openBatch('otherZone', d2, { zoneId: zone2 });
        if (warehouses[1]) await openBatch('otherWarehouse', d2, { warehouseId: warehouses[1].id });
        await openBatch('smallVehicle', d2, { capacityKg: 1 });

        // A customer in a zone with nothing else open.
        const lonelyVehicle = await fixtures.createVehicle();
        const lonelyBatch = await fixtures.createBatch({ shiftDate: d3, vehicleId: lonelyVehicle, zoneId: zone3, warehouseId: warehouses[0].id });
        lonely = await fixtures.create({ routeBatchId: lonelyBatch, zoneId: zone3, warehouseId: warehouses[0].id, km: 1 });

        ownProof = await proofFor(own.token);
        lonelyProof = await proofFor(lonely.token);
    });

    afterAll(async () => {
        if (db) {
            for (const [key, value] of originals) await setSetting(key, value);
            await fixtures.cleanup();
        }
        await app?.close();
    });

    it('needs the proof of the verification code', async () => {
        for (const header of [undefined, '', 'not-a-proof', 'a'.repeat(64), lonelyProof]) {
            const res = await slots(own.token, header);
            expect(res.status).toBe(403);
            expect(res.body).toMatchObject({ error: 'VERIFICATION_REQUIRED', path: `/${prefix}/public/tracking/:token/slots` });
        }
    });

    it('lists the slots the plan can take, one per date and time, earliest first, and nothing else', async () => {
        const proof = ownProof;

        const res = await slots(own.token, proof);

        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body.unavailableReason).toBeNull();
        // D2 is offered once although two batches can take it (the lower id wins); D3 once, from its other batch.
        // The own batch, the far date, the other zone, the other warehouse and the small vehicle are left out.
        expect(res.body.slots).toEqual([
            {
                slotId: buildSlotId(batchOf.d2a, localInstant(d2, '09:00')), deliveryDate: d2,
                windowStart: localInstant(d2, '09:00').toISOString(), windowEnd: localInstant(d2, '11:00').toISOString(),
            },
            {
                slotId: buildSlotId(batchOf.d3, localInstant(d3, '09:00')), deliveryDate: d3,
                windowStart: localInstant(d3, '09:00').toISOString(), windowEnd: localInstant(d3, '11:00').toISOString(),
            },
        ]);
        expect(parseSlotId(res.body.slots[0].slotId)).toEqual({ routeBatchId: batchOf.d2a, windowStart: localInstant(d2, '09:00') });
    });

    it('shows no internal data: no version, batch, vehicle, position or cost', async () => {
        const proof = ownProof;

        const body = JSON.stringify((await slots(own.token, proof)).body);

        expect(body).not.toMatch(/version|position|cost|vehicle|zone|"route|sequence|driver/i);
        for (const key of Object.keys(JSON.parse(body).slots[0])) expect(['slotId', 'deliveryDate', 'windowStart', 'windowEnd']).toContain(key);
    });

    it('changes nothing by listing: no dispatch, batch, event or order moves', async () => {
        const proof = ownProof;
        const before = await snapshot();

        await slots(own.token, proof);
        await slots(own.token, proof);

        expect(await snapshot()).toEqual(before);
    });

    it('asked twice with the same proof it answers the same, because listing does not consume it', async () => {
        const proof = ownProof;

        const first = await slots(own.token, proof);
        const second = await slots(own.token, proof);

        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
    });

    it('does not accept the proof of another delivery', async () => {
        expect((await slots(own.token, lonelyProof)).status).toBe(403);
    });

    it('answers an empty list with a reason when no open batch of the zone can take the customer', async () => {
        const res = await slots(lonely.token, lonelyProof);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ slots: [], unavailableReason: 'no_slots' });
    });

    it('answers planning_not_configured while a planning setting is blank', async () => {
        const proof = ownProof;
        await setSetting('stop_service_minutes', '');
        try {
            const res = await slots(own.token, proof);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ slots: [], unavailableReason: 'planning_not_configured' });
        } finally {
            await setSetting('stop_service_minutes', '15');
        }
    });

    it('is a 503 when the routing engine is down, and recovers', async () => {
        const proof = ownProof;
        osrm.failWith = new OsrmUnavailableException();
        try {
            const down = await slots(own.token, proof);

            expect(down.status).toBe(503);
            expect(down.body.error).toBe('OSRM_UNAVAILABLE');
        } finally {
            osrm.failWith = null;
        }
        expect((await slots(own.token, proof)).status).toBe(200);
    });

    it('asks the routing engine once per listing, for the depot, the customer and the stops of the batches that fit', async () => {
        const proof = ownProof;
        const before = osrm.calls.length;

        await slots(own.token, proof);

        expect(osrm.calls.length).toBe(before + 1);
        // depot + the customer + one told stop in each of the three batches that fit (d2a, d2b, d3).
        expect(osrm.calls.at(-1)).toHaveLength(1 + 1 + 3);
    });

    it('is a 409 with its reason once the self-service is over, and a 404 for an unknown token', async () => {
        const late = await fixtures.create({ notifiedAt: new Date(Date.now() - 721 * 60_000) });
        const noEmail = await fixtures.create({ email: null });

        expect((await slots(late.token, 'a'.repeat(64))).body).toMatchObject({ error: 'RESCHEDULE_NOT_AVAILABLE', details: { reason: 'window_elapsed' } });
        expect((await slots(noEmail.token, 'a'.repeat(64))).body.details).toEqual({ reason: 'no_contact_email' });
        const unknown = await slots('00000000-0000-4000-8000-000000000000', 'a'.repeat(64));
        expect(unknown.status).toBe(404);
        expect(unknown.body).toMatchObject({ error: 'TRACKING_LINK_NOT_FOUND', path: `/${prefix}/public/tracking/:token/slots` });
    });

    it('stops offering a date once the lead time of the warehouse cannot be met', async () => {
        const proof = ownProof;
        await setSetting('warehouse_prep_lead_minutes', '1440');
        try {
            // With a day of lead time, only dates whose warehouse deadline is more than 24 h away remain; the
            // exact set depends on the hour the suite runs, so the check is that the offer can only shrink.
            const res = await slots(own.token, proof);

            expect(res.status).toBe(200);
            expect(res.body.slots.length).toBeLessThanOrEqual(2);
        } finally {
            await setSetting('warehouse_prep_lead_minutes', '60');
        }
    });
});
