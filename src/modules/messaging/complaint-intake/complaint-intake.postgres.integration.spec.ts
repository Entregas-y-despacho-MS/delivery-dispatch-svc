import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TrackedFixtures } from '../../../../test/helpers/tracked-dispatch.fixtures.js';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import type { MessageEnvelope } from '../../../plugins/messaging/envelope/message-envelope.js';
import { v7 as uuidv7 } from 'uuid';
import type { MessageHandler } from '../../../plugins/messaging/message-bus.port.js';
import { InboundMessageTransactionService } from '../inbound-messages/services/inbound-message-transaction.service.js';
import { OutboxService } from '../outbound-messages/services/outbox.service.js';
import { COMPLAINT_OPENED_TOPIC, type DeliveryComplaintOpenedData } from './domain/complaint-message.types.js';
import { ComplaintConsumer } from './services/complaint-consumer.service.js';
import { ComplaintIntakeService } from './services/complaint-intake.service.js';

/**
 * ST-298.3 against PostgreSQL with the delivery-dispatch-db schema loaded (migration 030 or later). Skipped
 * unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=55432 TEST_DB_USER=postgres TEST_DB_PASSWORD=test TEST_DB_NAME=ddb_test \
 *     npx vitest run complaint-intake.postgres
 *
 * The real consumer, transaction service, intake service and outbox (with the checked-in JSON Schemas) run over
 * real SQL and really commit; every row the suite creates is removed in `afterAll`.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');
const CONTRACTS_DIR = resolve(process.cwd(), 'contracts/messages');

describe.skipIf(!PORT)('CRM complaint intake against PostgreSQL (ST-298.3)', () => {
    let dataSource: DataSource;
    let fixtures: TrackedFixtures;
    let handler: MessageHandler;
    let batchId: number;
    let caseSeq = 0;
    let sequence = 0;
    const messageIds: string[] = [];
    const untrackedIds: number[] = [];

    const buildConsumer = async (outbox: Pick<OutboxService, 'enqueue'>): Promise<MessageHandler> => {
        let captured!: MessageHandler;
        const bus = { subscribe: async (_topic: string, h: MessageHandler) => { captured = h; } };
        const intake = new ComplaintIntakeService(outbox as OutboxService);
        await new ComplaintConsumer(bus as never, new InboundMessageTransactionService(dataSource), intake).onModuleInit();
        return captured;
    };

    const newCaseId = () => `CRM-${RUN}-${++caseSeq}`;

    const envelopeOf = (data: DeliveryComplaintOpenedData, messageId = uuidv7()): MessageEnvelope => {
        messageIds.push(messageId);
        return {
            messageId, type: COMPLAINT_OPENED_TOPIC, schemaVersion: 1, source: 'crm',
            occurredAt: '2026-11-20T15:00:01Z', data: data as unknown as Record<string, unknown>,
        };
    };

    const complaint = (over: Partial<DeliveryComplaintOpenedData> = {}): DeliveryComplaintOpenedData => ({
        crmCaseId: newCaseId(), caseVersion: 1, reasonCode: 'DAMAGED_ITEM', openedAt: '2026-11-20T15:00:00Z',
        affectedItems: [{ packageId: 'PKG-1', quantity: 1 }], ...over,
    });

    const casesOf = async (crmCaseId: string) =>
        (await dataSource.query(`SELECT * FROM delivery_complaint_cases WHERE source = 'crm' AND crm_case_id = $1`, [crmCaseId])) as Record<string, any>[];
    const acksFor = async (messageId: string) =>
        (await dataSource.query(`SELECT type, payload FROM outbound_messages WHERE payload->'data'->>'correlationMessageId' = $1`, [messageId])) as { type: string; payload: MessageEnvelope }[];
    const receiptOf = async (messageId: string) =>
        (await dataSource.query(`SELECT status FROM inbound_messages WHERE message_id = $1`, [messageId])) as { status: string }[];
    const dispatchRow = async (id: number) =>
        (await dataSource.query(
            `SELECT d.version, d.updated_at, s.name AS status, b.status AS batch_status
               FROM dispatches d JOIN dispatch_statuses s USING (dispatch_status_id)
               LEFT JOIN route_batches b USING (route_batch_id) WHERE d.dispatch_id = $1`, [id]))[0] as Record<string, any>;

    /** A delivery dispatch inside the batch that stays `in_execution`. */
    const dispatchInOpenBatch = async (status = 'delivered') =>
        await fixtures.create({ status, routeBatchId: batchId, sequence: ++sequence });

    /** A delivered delivery dispatch that never got its tracking code (the column is nullable). */
    const untrackedDelivered = async () => {
        const ref = `CMP${RUN}-UT-${++sequence}`;
        const [{ dispatch_id }] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, route_batch_id, sequence_order, source_order_ref,
                    delivery_address, contact_name, contact_phone, estimated_weight_kg, origin_warehouse_id, version, shipment_ready)
             VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                     (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'delivered'),
                     $1, $2, $3, 'Calle Secreta 123', 'E2E customer', '+591 70000000', 1,
                     (SELECT warehouse_id FROM warehouses WHERE active = TRUE AND deleted_at IS NULL ORDER BY warehouse_id LIMIT 1), 1, TRUE)
             RETURNING dispatch_id`,
            [batchId, 1000 + sequence, ref],
        );
        untrackedIds.push(Number(dispatch_id));
        return Number(dispatch_id);
    };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres', host: process.env.TEST_DB_HOST ?? 'localhost', port: Number(PORT),
            username: process.env.TEST_DB_USER, password: process.env.TEST_DB_PASSWORD, database: process.env.TEST_DB_NAME,
        });
        await dataSource.initialize();
        fixtures = new TrackedFixtures(dataSource, `CMP${RUN}`);
        const [warehouse] = await fixtures.warehouses();
        batchId = await fixtures.createBatch({
            shiftDate: '2026-11-20', vehicleId: await fixtures.createVehicle(), zoneId: await fixtures.createZone('C'),
            warehouseId: warehouse!.id, status: 'in_execution',
        });
        handler = await buildConsumer(new OutboxService(dataSource, MessageValidator.fromDirectory(CONTRACTS_DIR)));
    });

    afterEach(async () => {
        await dataSource.query(`DELETE FROM delivery_complaint_cases WHERE crm_case_id LIKE $1`, [`CRM-${RUN}-%`]);
    });

    afterAll(async () => {
        if (!dataSource?.isInitialized) return;
        await dataSource.query(`DELETE FROM outbound_messages WHERE payload->'data'->>'correlationMessageId' = ANY($1::text[])`, [messageIds]);
        await dataSource.query(`DELETE FROM inbound_messages WHERE message_id = ANY($1::uuid[])`, [messageIds]);
        await dataSource.query(`DELETE FROM dispatches WHERE dispatch_id = ANY($1::int[])`, [untrackedIds]);
        await fixtures.cleanup();
        await dataSource.destroy();
    });

    it('accepts a complaint about a delivered dispatch whose batch is still in execution, and leaves both untouched', async () => {
        const dispatch = await dispatchInOpenBatch();
        const before = await dispatchRow(dispatch.dispatchId);
        expect(before).toMatchObject({ status: 'delivered', batch_status: 'in_execution' });
        const data = complaint({ dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode, salesOrderId: dispatch.ref });
        const message = envelopeOf(data);

        expect(await handler(message)).toBe('receipt-committed');

        const [stored] = await casesOf(data.crmCaseId);
        expect(stored).toMatchObject({
            message_id: message.messageId, case_version: 1, dispatch_id: dispatch.dispatchId, tracking_code: dispatch.trackingCode,
            reason_code: 'DAMAGED_ITEM', affected_items: [{ packageId: 'PKG-1', quantity: 1 }], intake_status: 'acknowledged',
        });
        expect(stored!.acknowledged_at).not.toBeNull();
        const acks = await acksFor(message.messageId);
        expect(acks).toHaveLength(1);
        expect(acks[0]).toMatchObject({ type: 'dispatch.delivery_complaint.received' });
        expect(acks[0]!.payload.data).toMatchObject({
            correlationMessageId: message.messageId, crmCaseId: data.crmCaseId, caseVersion: 1,
            dispatchId: dispatch.dispatchId, trackingCode: dispatch.trackingCode,
        });
        expect(await receiptOf(message.messageId)).toEqual([{ status: 'processed' }]);
        // The dispatch and its batch are exactly as they were.
        expect(await dispatchRow(dispatch.dispatchId)).toEqual(before);
    });

    it('resolves the dispatch by tracking code alone', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ trackingCode: dispatch.trackingCode });

        await handler(envelopeOf(data));

        expect((await casesOf(data.crmCaseId))[0]).toMatchObject({ dispatch_id: dispatch.dispatchId });
    });

    it.each([
        ['dispatch_not_found', async () => complaint({ dispatchId: 2_147_000_000 })],
        ['dispatch_not_delivered', async () => complaint({ dispatchId: (await dispatchInOpenBatch('in_transit')).dispatchId })],
        ['dispatch_not_delivered', async () => complaint({ dispatchId: (await dispatchInOpenBatch('not_delivered')).dispatchId })],
        ['dispatch_reference_mismatch', async () => {
            const [one, other] = [await dispatchInOpenBatch(), await dispatchInOpenBatch()];
            return complaint({ dispatchId: one.dispatchId, trackingCode: other.trackingCode });
        }],
        ['dispatch_reference_mismatch', async () => {
            const dispatch = await dispatchInOpenBatch();
            return complaint({ dispatchId: dispatch.dispatchId, salesOrderId: 'SO-OF-ANOTHER-ORDER' });
        }],
    ])('rejects with %s: no case, a rejected acknowledgement and a committed receipt', async (code, build) => {
        const data = await build();
        const message = envelopeOf(data);

        expect(await handler(message)).toBe('receipt-committed');

        expect(await casesOf(data.crmCaseId)).toHaveLength(0);
        const acks = await acksFor(message.messageId);
        expect(acks).toHaveLength(1);
        expect(acks[0]!.type).toBe('dispatch.delivery_complaint.rejected');
        expect(acks[0]!.payload.data).toMatchObject({
            correlationMessageId: message.messageId, crmCaseId: data.crmCaseId, caseVersion: 1, rejectionCode: code,
        });
        expect(JSON.stringify(acks[0]!.payload)).not.toMatch(/DAMAGED_ITEM|PKG-1/);
        expect(await receiptOf(message.messageId)).toEqual([{ status: 'processed' }]);
    });

    it('a delivered dispatch without a tracking code cannot be acknowledged, so it is answered as not found instead of retried forever', async () => {
        const dispatchId = await untrackedDelivered();
        const data = complaint({ dispatchId });
        const message = envelopeOf(data);

        expect(await handler(message)).toBe('receipt-committed');

        expect(await casesOf(data.crmCaseId)).toHaveLength(0);
        expect((await acksFor(message.messageId))[0]!.payload.data).toMatchObject({ rejectionCode: 'dispatch_not_found' });
    });

    it('a dispatchId beyond INTEGER is not found, and a caseVersion beyond INTEGER is schema_invalid, instead of a retry loop', async () => {
        const hugeDispatch = complaint({ dispatchId: 2_147_483_648 });
        const hugeVersion = complaint({ dispatchId: (await dispatchInOpenBatch()).dispatchId, caseVersion: 2_147_483_648 });
        const [first, second] = [envelopeOf(hugeDispatch), envelopeOf(hugeVersion)];

        expect(await handler(first)).toBe('receipt-committed');
        expect(await handler(second)).toBe('receipt-committed');

        expect((await acksFor(first.messageId))[0]!.payload.data).toMatchObject({ rejectionCode: 'dispatch_not_found' });
        expect((await acksFor(second.messageId))[0]!.payload.data).toMatchObject({
            rejectionCode: 'schema_invalid', field: '/data/caseVersion', crmCaseId: hugeVersion.crmCaseId,
        });
        expect(await casesOf(hugeVersion.crmCaseId)).toHaveLength(0);
    });

    it('a redelivered messageId stores nothing more and acknowledges nothing more', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        const message = envelopeOf(data);

        await handler(message);
        expect(await handler(message)).toBe('duplicate');

        expect(await casesOf(data.crmCaseId)).toHaveLength(1);
        expect(await acksFor(message.messageId)).toHaveLength(1);
    });

    it('the same case in the same or an older version never reverts or duplicates the case in force', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId, caseVersion: 3, reasonCode: 'LATE_DELIVERY' });
        const first = envelopeOf(data);
        await handler(first);

        const sameVersion = envelopeOf({ ...data, reasonCode: 'WRONG_ITEM' });
        const older = envelopeOf({ ...data, caseVersion: 2, reasonCode: 'WRONG_ITEM' });
        await handler(sameVersion);
        await handler(older);

        const cases = await casesOf(data.crmCaseId);
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ message_id: first.messageId, case_version: 3, reason_code: 'LATE_DELIVERY' });
        expect(await acksFor(sameVersion.messageId)).toHaveLength(0);
        expect(await acksFor(older.messageId)).toHaveLength(0);
        // Both were consumed: the broker does not redeliver them.
        expect(await receiptOf(sameVersion.messageId)).toEqual([{ status: 'processed' }]);
        expect(await receiptOf(older.messageId)).toEqual([{ status: 'processed' }]);
    });

    it('a newer version updates the same case (still one row) and is acknowledged again', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId, reasonCode: 'LATE_DELIVERY' });
        await handler(envelopeOf(data));

        const second = envelopeOf({ ...data, caseVersion: 2, reasonCode: 'WRONG_ITEM' });
        await handler(second);

        const cases = await casesOf(data.crmCaseId);
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ message_id: second.messageId, case_version: 2, reason_code: 'WRONG_ITEM' });
        expect((await acksFor(second.messageId))[0]!.payload.data).toMatchObject({ caseVersion: 2 });
    });

    it('two simultaneous deliveries of the same case produce one case', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });

        await Promise.all([handler(envelopeOf(data)), handler(envelopeOf(data))]);

        expect(await casesOf(data.crmCaseId)).toHaveLength(1);
    });

    it('a persistence error rolls everything back: no case, no acknowledgement, no receipt, and the broker retries', async () => {
        const dispatch = await dispatchInOpenBatch();
        // `affected_items` must hold 1 to 100 items: the database refuses an empty list at the INSERT.
        const data = complaint({ dispatchId: dispatch.dispatchId, affectedItems: [] });
        const message = envelopeOf(data);

        await expect(handler(message)).rejects.toThrow(/chk_delivery_complaint_cases_affected_items/);

        expect(await casesOf(data.crmCaseId)).toHaveLength(0);
        expect(await acksFor(message.messageId)).toHaveLength(0);
        expect(await receiptOf(message.messageId)).toHaveLength(0);
    });

    it('an acknowledgement that cannot be queued does not leave a case behind', async () => {
        const dispatch = await dispatchInOpenBatch();
        const failing = await buildConsumer({ enqueue: async () => { throw new Error('outbox unavailable'); } });
        const data = complaint({ dispatchId: dispatch.dispatchId });
        const message = envelopeOf(data);

        await expect(failing(message)).rejects.toThrow('outbox unavailable');

        expect(await casesOf(data.crmCaseId)).toHaveLength(0);
        expect(await receiptOf(message.messageId)).toHaveLength(0);
        // The retry (the broker redelivers) succeeds once the outbox is back.
        expect(await handler(message)).toBe('receipt-committed');
        expect(await casesOf(data.crmCaseId)).toHaveLength(1);
    });

    it('the unique key of the table is what keeps a second case out', async () => {
        const dispatch = await dispatchInOpenBatch();
        const data = complaint({ dispatchId: dispatch.dispatchId });
        await handler(envelopeOf(data));

        await expect(dataSource.query(
            `INSERT INTO delivery_complaint_cases (message_id, source, crm_case_id, case_version, dispatch_id, reason_code, affected_items, opened_at)
             VALUES ($1, 'crm', $2, 9, $3, 'DAMAGED_ITEM', '[{"quantity":1,"itemCode":"X"}]'::jsonb, NOW())`,
            [randomUUID(), data.crmCaseId, dispatch.dispatchId],
        )).rejects.toThrow(/uq_delivery_complaint_cases_source_crm_case_id/);
    });
});
