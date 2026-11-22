import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PubSub, type Message, type Subscription } from '@google-cloud/pubsub';
import type { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MessageValidator } from '../src/plugins/messaging/envelope/message-validator.js';
import { MessageBus } from '../src/plugins/messaging/message-bus.port.js';
import { TrackedFixtures, type TrackedDispatch } from './helpers/tracked-dispatch.fixtures.js';

/**
 * CRM → Dispatch complaint intake end to end, through the real Pub/Sub emulator: the suite plays CRM, publishes
 * `crm.delivery_complaint.opened` and reads the acknowledgement Dispatch publishes on
 * `dispatch.delivery_complaint.received|rejected`, then checks the inbox, the case and that neither the dispatch
 * nor its open batch changed.
 *
 * Skipped unless PUBSUB_EMULATOR_HOST is set in the shell. It needs the emulator with the resources created by
 * `node scripts/pubsub/bootstrap.mjs`, and a database with the delivery-dispatch-db schema (migration 030 or
 * later). No other Dispatch instance may be listening on the same emulator: it would take the messages.
 *   PUBSUB_EMULATOR_HOST=localhost:8085 DB_HOST=localhost DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
 *     npx vitest run --config ./vitest.config.e2e.ts crm-complaint-intake.pubsub
 */
const EMULATOR_HOST = process.env.PUBSUB_EMULATOR_HOST;
const PROJECT_ID = process.env.PUBSUB_PROJECT_ID || 'delivery-dispatch-local';
const OPENED = 'crm.delivery_complaint.opened';
const RECEIVED = 'dispatch.delivery_complaint.received';
const REJECTED = 'dispatch.delivery_complaint.rejected';
const DEAD_LETTER = `${OPENED}.dead-letter`;
const WAIT_MS = 20_000;
/** How long a message that must get NO acknowledgement is watched. */
const QUIET_MS = 4_000;
const RUN = randomBytes(3).toString('hex');
const CONTRACTS = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));

type Envelope = { messageId: string; type: string; source: string; data: Record<string, any> };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, what: string): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const value = await read();
        if (done(value)) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
        await sleep(150);
    }
}

describe.skipIf(!EMULATOR_HOST)('CRM complaint intake through the Pub/Sub emulator (ES-298)', { timeout: 60_000 }, () => {
    let app: INestApplication;
    let db: DataSource;
    let fixtures: TrackedFixtures;
    let client: PubSub;
    let batchId: number;
    let sequence = 0;
    let caseSeq = 0;
    const listeners: Subscription[] = [];
    const acks: Envelope[] = [];
    const deadLettered: string[] = [];
    const messageIds: string[] = [];
    /** Dispatches inserted outside the fixtures (not deliveries). */
    const extraDispatchIds: number[] = [];
    /** Published before the app started, as if Dispatch were down when CRM opened the case. */
    let whileDown: { messageId: string; crmCaseId: string; dispatch: TrackedDispatch };

    const newCaseId = () => `CRM-E2E-${RUN}-${++caseSeq}`;

    const complaint = (refs: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
        crmCaseId: newCaseId(), caseVersion: 1, reasonCode: 'DAMAGED_ITEM', openedAt: '2026-11-20T15:00:00Z',
        affectedItems: [{ packageId: 'PKG-1', quantity: 1 }], ...refs, ...over,
    });

    /** Publishes like CRM does: JSON body plus the routing attributes. */
    const publish = async (data: Record<string, unknown>, messageId = uuidv7()): Promise<string> => {
        messageIds.push(messageId);
        const envelope = {
            messageId, type: OPENED, schemaVersion: 1, source: 'crm', occurredAt: new Date().toISOString(), data,
        };
        await client.topic(OPENED).publishMessage({
            json: envelope, attributes: { messageId, type: OPENED, source: 'crm', schemaVersion: '1' },
        });
        return messageId;
    };

    const acksOf = (messageId: string) => acks.filter((ack) => ack.data.correlationMessageId === messageId);
    const ackOf = async (messageId: string): Promise<Envelope> =>
        (await until(() => acksOf(messageId), (found) => found.length > 0, `the acknowledgement of ${messageId}`))[0]!;
    /** Waits for the first acknowledgement and a little longer, so a second (duplicate) one would show up too. */
    const settledAcksOf = async (messageId: string): Promise<Envelope[]> => {
        await ackOf(messageId);
        await sleep(1_500);
        return acksOf(messageId);
    };

    const casesOf = async (crmCaseId: string) =>
        await db.query(`SELECT * FROM delivery_complaint_cases WHERE source = 'crm' AND crm_case_id = $1`, [crmCaseId]);
    const receiptOf = async (messageId: string) =>
        ((await db.query(`SELECT status FROM inbound_messages WHERE message_id = $1`, [messageId]))[0]?.status ?? null) as string | null;
    const dispatchState = async (id: number) =>
        (await db.query(
            `SELECT d.version, d.updated_at, s.name AS status, b.status AS batch_status, b.updated_at AS batch_updated_at
               FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
               LEFT JOIN route_batches b USING (route_batch_id) WHERE d.dispatch_id = $1`, [id]))[0];

    /** A delivery dispatch inside the batch that stays `in_execution`. */
    const dispatchInOpenBatch = async (status = 'delivered') =>
        await fixtures.create({ status, routeBatchId: batchId, sequence: ++sequence });

    const expectReceived = (ack: Envelope, dispatch: TrackedDispatch, crmCaseId: string, caseVersion = 1) => {
        expect(ack).toMatchObject({ type: RECEIVED, source: 'dispatch' });
        expect(ack.data).toMatchObject({ crmCaseId, caseVersion, dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode });
        expect(CONTRACTS.validate(RECEIVED, ack).valid).toBe(true);
    };

    const expectRejected = (ack: Envelope, crmCaseId: string, rejectionCode: string) => {
        expect(ack).toMatchObject({ type: REJECTED, source: 'dispatch' });
        expect(ack.data).toMatchObject({ crmCaseId, rejectionCode });
        expect(CONTRACTS.validate(REJECTED, ack).valid).toBe(true);
    };

    /** A business rejection keeps the receipt (no redelivery) and stores no case. */
    const expectRejectedWithoutCase = async (messageId: string, crmCaseId: string, rejectionCode: string) => {
        const received = await settledAcksOf(messageId);
        expect(received).toHaveLength(1);
        expectRejected(received[0]!, crmCaseId, rejectionCode);
        expect(await casesOf(crmCaseId)).toHaveLength(0);
        expect(await receiptOf(messageId)).toBe('processed');
    };

    const listen = async (topic: string, onMessage: (body: any) => void) => {
        const [subscription] = await client.topic(topic).createSubscription(`${topic}.e2e-crm-${RUN}`);
        subscription.on('message', (message: Message) => {
            message.ack();
            onMessage(JSON.parse(message.data.toString('utf8')));
        });
        listeners.push(subscription);
    };

    beforeAll(async () => {
        client = new PubSub({ projectId: PROJECT_ID, apiEndpoint: EMULATOR_HOST, emulatorMode: true });
        for (const topic of [OPENED, RECEIVED, REJECTED, DEAD_LETTER]) {
            const [exists] = await client.topic(topic).exists();
            if (!exists) throw new Error(`Topic ${topic} is missing: run node scripts/pubsub/bootstrap.mjs first.`);
        }
        // Listen before anything is published, so no acknowledgement is missed.
        await listen(RECEIVED, (body) => acks.push(body));
        await listen(REJECTED, (body) => acks.push(body));
        await listen(DEAD_LETTER, (body) => deadLettered.push(String(body?.message?.messageId ?? '')));

        db = new DataSource({
            type: 'postgres', host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
            username: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
        });
        await db.initialize();
        fixtures = new TrackedFixtures(db, `CRME2E${RUN}`);
        const [warehouse] = await fixtures.warehouses();
        batchId = await fixtures.createBatch({
            shiftDate: '2026-11-20', vehicleId: await fixtures.createVehicle(), zoneId: await fixtures.createZone('C'),
            warehouseId: warehouse!.id, status: 'in_execution',
        });

        // Dispatch is down: CRM still opens the case. The broker keeps it until Dispatch subscribes.
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        whileDown = { messageId: await publish(data), crmCaseId: String(data.crmCaseId), dispatch };

        // The e2e config pins the in-memory bus; this suite needs the real one.
        process.env.MESSAGING_ADAPTER = 'pubsub';
        process.env.PUBSUB_PROJECT_ID = PROJECT_ID;
        process.env.OUTBOX_POLL_INTERVAL_MS = '200';
        delete process.env.PUBSUB_INBOUND_TOPIC;
        delete process.env.PUBSUB_INBOUND_SUBSCRIPTION;
        const { Test } = await import('@nestjs/testing');
        const { AppModule } = await import('../src/app.module.js');
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication({ logger: ['error'] });
        await app.init();
    }, 60_000);

    afterAll(async () => {
        await app?.close();
        await Promise.allSettled(listeners.map(async (subscription) => {
            await subscription.close();
            await subscription.delete();
        }));
        await client?.close();
        if (db?.isInitialized) {
            await db.query(`DROP TRIGGER IF EXISTS trg_e2e_crm_fail ON delivery_complaint_cases`);
            await db.query(`DROP FUNCTION IF EXISTS fn_e2e_crm_fail()`);
            await db.query(`DELETE FROM delivery_complaint_cases WHERE crm_case_id LIKE $1`, [`CRM-E2E-${RUN}-%`]);
            await db.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'correlationMessageId' = ANY($1::text[])`, [messageIds]);
            await db.query(`DELETE FROM inbound_messages WHERE message_id = ANY($1::uuid[])`, [messageIds]);
            await db.query(`DELETE FROM audit_logs WHERE detail::text LIKE ANY($1::text[])`, [messageIds.map((id) => `%${id}%`)]);
            await db.query(`DELETE FROM dispatches WHERE dispatch_id = ANY($1::int[])`, [extraDispatchIds]);
            await fixtures.cleanup();
            await db.destroy();
        }
    });

    it('a complaint published while Dispatch was down is processed once when it comes back', async () => {
        const received = await settledAcksOf(whileDown.messageId);
        expect(received).toHaveLength(1);
        expectReceived(received[0]!, whileDown.dispatch, whileDown.crmCaseId);
        expect(await casesOf(whileDown.crmCaseId)).toHaveLength(1);
        expect(await receiptOf(whileDown.messageId)).toBe('processed');
    });

    it('accepts a delivered dispatch whose batch is still in execution, and changes neither of them', async () => {
        const dispatch = await dispatchInOpenBatch();
        const before = await dispatchState(dispatch.dispatchId);
        expect(before).toMatchObject({ status: 'delivered', batch_status: 'in_execution' });
        const data = complaint({ dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode, salesOrderId: dispatch.ref });
        const messageId = await publish(data);

        const received = await settledAcksOf(messageId);
        expect(received).toHaveLength(1);
        expectReceived(received[0]!, dispatch, data.crmCaseId);
        const [stored] = await casesOf(data.crmCaseId);
        expect(stored).toMatchObject({
            message_id: messageId, case_version: 1, dispatch_id: dispatch.dispatchId, tracking_code: dispatch.trackingCode,
            intake_status: 'acknowledged',
        });
        expect(await receiptOf(messageId)).toBe('processed');
        expect(await dispatchState(dispatch.dispatchId)).toEqual(before);
    });

    it('resolves the dispatch by dispatchId alone and by trackingCode alone', async () => {
        const byId = await dispatchInOpenBatch();
        const byTracking = await dispatchInOpenBatch();
        const idCase = complaint({ dispatchId: byId.dispatchId });
        const trackingCase = complaint({ trackingCode: byTracking.trackingCode });
        const idMessage = await publish(idCase);
        const trackingMessage = await publish(trackingCase);

        expectReceived(await ackOf(idMessage), byId, idCase.crmCaseId);
        expectReceived(await ackOf(trackingMessage), byTracking, trackingCase.crmCaseId);
        expect((await casesOf(trackingCase.crmCaseId))[0]).toMatchObject({ dispatch_id: byTracking.dispatchId });
    });

    it('an order with several dispatches: only its delivery can be claimed, and an order that does not match is rejected', async () => {
        // The schema allows one delivery per order (uq_dispatches_delivery_source_order_ref); the same order can
        // also have dispatches of other types, here a return pickup with the same reference and its own tracking code.
        const delivery = await dispatchInOpenBatch();
        const [{ dispatch_id: pickupId, tracking_code: pickupTracking }] = await db.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, contact_name,
                    contact_phone, estimated_weight_kg, origin_warehouse_id, tracking_code, version, shipment_ready)
             VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'warehouse_return_pickup'),
                     (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'delivered'),
                     $1, 'Calle Secreta 123', 'E2E customer', '+591 70000000', 1,
                     (SELECT warehouse_id FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1),
                     next_tracking_code(), 1, TRUE)
             RETURNING dispatch_id, tracking_code`,
            [delivery.ref],
        );
        extraDispatchIds.push(Number(pickupId));
        const other = await dispatchInOpenBatch();

        const deliveryCase = complaint({ trackingCode: delivery.trackingCode, salesOrderId: delivery.ref });
        expectReceived(await ackOf(await publish(deliveryCase)), delivery, deliveryCase.crmCaseId);
        expect((await casesOf(deliveryCase.crmCaseId))[0]).toMatchObject({ dispatch_id: delivery.dispatchId });

        // The pickup of the same order is not a delivery: CRM cannot open a delivery complaint on it.
        const pickupById = complaint({ dispatchId: Number(pickupId), salesOrderId: delivery.ref });
        await expectRejectedWithoutCase(await publish(pickupById), pickupById.crmCaseId, 'dispatch_not_found');
        const pickupByTracking = complaint({ trackingCode: pickupTracking });
        await expectRejectedWithoutCase(await publish(pickupByTracking), pickupByTracking.crmCaseId, 'dispatch_not_found');

        const wrongOrder = complaint({ dispatchId: other.dispatchId, salesOrderId: delivery.ref });
        await expectRejectedWithoutCase(await publish(wrongOrder), wrongOrder.crmCaseId, 'dispatch_reference_mismatch');
    });

    it('rejects dispatchId and trackingCode that name two different dispatches', async () => {
        const one = await dispatchInOpenBatch();
        const another = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: one.dispatchId, trackingCode: another.trackingCode });
        await expectRejectedWithoutCase(await publish(data), data.crmCaseId, 'dispatch_reference_mismatch');
    });

    it('rejects a dispatch that is not delivered yet and one that does not exist', async () => {
        const onTheWay = await dispatchInOpenBatch('in_transit');
        const notDelivered = complaint({ dispatchId: onTheWay.dispatchId });
        await expectRejectedWithoutCase(await publish(notDelivered), notDelivered.crmCaseId, 'dispatch_not_delivered');
        expect((await dispatchState(onTheWay.dispatchId)).status).toBe('in_transit');

        const missing = complaint({ trackingCode: 'DSP-2099-99999' });
        await expectRejectedWithoutCase(await publish(missing), missing.crmCaseId, 'dispatch_not_found');
    });

    it('an invalid payload is rejected with the field, goes to the dead-letter and never becomes a case', async () => {
        const dispatch = await dispatchInOpenBatch();
        // Neither dispatchId nor trackingCode: the order alone does not identify a dispatch.
        const data = complaint({ salesOrderId: dispatch.ref });
        const messageId = await publish(data);

        const [ack] = await settledAcksOf(messageId);
        expectRejected(ack!, data.crmCaseId, 'schema_invalid');
        expect(ack!.data.field).toBe('/data');
        await until(() => deadLettered, (ids) => ids.includes(messageId), 'the dead-letter copy');
        expect(await receiptOf(messageId)).toBe('rejected');
        expect(await casesOf(data.crmCaseId)).toHaveLength(0);
    });

    it('a message delivered twice with the same messageId stores one case and is acknowledged once', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        const messageId = await publish(data);
        await publish(data, messageId);

        expect(await settledAcksOf(messageId)).toHaveLength(1);
        expect(await casesOf(data.crmCaseId)).toHaveLength(1);
    });

    it('the same or an older caseVersion is ignored without acknowledgement; a newer one updates the same case', async () => {
        const dispatch = await dispatchInOpenBatch();
        const v2 = complaint({ dispatchId: dispatch.dispatchId }, { caseVersion: 2, reasonCode: 'MISSING_ITEM' });
        expectReceived(await ackOf(await publish(v2)), dispatch, v2.crmCaseId, 2);

        const sameVersion = await publish({ ...v2, reasonCode: 'OTHER' });
        const older = await publish({ ...v2, caseVersion: 1, reasonCode: 'OTHER' });
        await sleep(QUIET_MS);
        expect(acksOf(sameVersion)).toHaveLength(0);
        expect(acksOf(older)).toHaveLength(0);
        expect(await receiptOf(older)).toBe('processed');
        expect(await casesOf(v2.crmCaseId)).toEqual([expect.objectContaining({ case_version: 2, reason_code: 'MISSING_ITEM' })]);

        const v3 = await publish({ ...v2, caseVersion: 3, reasonCode: 'WRONG_ITEM' });
        expectReceived(await ackOf(v3), dispatch, v2.crmCaseId, 3);
        expect(await casesOf(v2.crmCaseId)).toEqual([expect.objectContaining({ case_version: 3, reason_code: 'WRONG_ITEM', message_id: v3 })]);
    });

    it('a persistence error leaves no case, receipt or acknowledgement; the broker redelivers and it is processed once', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        // The database rejects this case until the trigger is dropped.
        await db.query(`CREATE FUNCTION fn_e2e_crm_fail() RETURNS trigger AS $$
            BEGIN IF NEW.crm_case_id = '${data.crmCaseId}' THEN RAISE EXCEPTION 'e2e: storage unavailable'; END IF; RETURN NEW; END;
            $$ LANGUAGE plpgsql`);
        await db.query(`CREATE TRIGGER trg_e2e_crm_fail BEFORE INSERT ON delivery_complaint_cases FOR EACH ROW EXECUTE FUNCTION fn_e2e_crm_fail()`);
        try {
            const messageId = await publish(data);
            await sleep(QUIET_MS);
            expect(acksOf(messageId)).toHaveLength(0);
            expect(await receiptOf(messageId)).toBeNull();
            expect(await casesOf(data.crmCaseId)).toHaveLength(0);
            expect(await db.query(`SELECT 1 FROM outbound_messages WHERE payload->'data'->>'correlationMessageId' = $1`, [messageId])).toHaveLength(0);

            await db.query(`DROP TRIGGER trg_e2e_crm_fail ON delivery_complaint_cases`);
            const received = await settledAcksOf(messageId);
            expect(received).toHaveLength(1);
            expectReceived(received[0]!, dispatch, data.crmCaseId);
            expect(await casesOf(data.crmCaseId)).toHaveLength(1);
            expect(await receiptOf(messageId)).toBe('processed');
        } finally {
            await db.query(`DROP TRIGGER IF EXISTS trg_e2e_crm_fail ON delivery_complaint_cases`);
            await db.query(`DROP FUNCTION IF EXISTS fn_e2e_crm_fail()`);
        }
    });

    it('when the broker cannot take the acknowledgement it stays in the outbox and is published once it is back', async () => {
        const bus = app.get(MessageBus);
        const realPublish = bus.publish.bind(bus);
        // Only the acknowledgements fail, as if the broker were unreachable for Dispatch's outbound side.
        const spy = vi.spyOn(bus, 'publish').mockImplementation(async (topic, envelope) => {
            if (topic === RECEIVED) throw new Error('e2e: broker unavailable');
            return await realPublish(topic, envelope);
        });
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        let messageId = '';
        try {
            messageId = await publish(data);
            const outboxRow = () => db.query(
                `SELECT status, attempts FROM outbound_messages WHERE payload->'data'->>'correlationMessageId' = $1`, [messageId]);
            const [pending] = await until(outboxRow, (rows) => rows[0]?.attempts >= 1, 'a failed publish attempt');
            expect(pending.status).toBe('pending');
            // The case is already stored and committed: the failure is only on the way out.
            expect(await casesOf(data.crmCaseId)).toHaveLength(1);
            expect(acksOf(messageId)).toHaveLength(0);
        } finally {
            spy.mockRestore();
        }
        const received = await settledAcksOf(messageId);
        expect(received).toHaveLength(1);
        expectReceived(received[0]!, dispatch, data.crmCaseId);
    });

    it('after every complaint, the batch is still in execution: consuming a complaint never closes it', async () => {
        const [batch] = await db.query(`SELECT status FROM route_batches WHERE route_batch_id = $1`, [batchId]);
        expect(batch.status).toBe('in_execution');
    });
});
