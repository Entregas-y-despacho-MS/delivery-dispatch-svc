import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerStatusNoticeRepository, type NewNotification } from './customer-status-notice.repository.js';

/**
 * Against PostgreSQL with `customer_notifications` (delivery-dispatch-db migration 029). Skipped unless TEST_DB_PORT is set:
 *   TEST_DB_HOST=localhost TEST_DB_PORT=55432 TEST_DB_USER=... TEST_DB_PASSWORD=... TEST_DB_NAME=... \
 *     npx vitest run customer-status-notice.repository.integration
 *
 * The repository goes through the pool, so the test creates its own dispatch (tagged) and removes it, and its
 * notifications, in `afterAll`.
 */
const PORT = process.env.TEST_DB_PORT;
const RUN = randomBytes(4).toString('hex');

describe.skipIf(!PORT)('CustomerStatusNoticeRepository against PostgreSQL', () => {
    let dataSource: DataSource;
    let repository: CustomerStatusNoticeRepository;
    let dispatchId: number;
    let counter = 0;

    const notification = (over: Partial<NewNotification> = {}): NewNotification => {
        const key = `it-${RUN}-${++counter}`;
        return {
            dispatchId, notificationType: 'status_change', idempotencyKey: `status_change:${key}`, sourceEventKey: key,
            dispatchStatus: 'delivered', occurredAt: '2026-11-19T14:30:00.000Z', recipient: 'ana@example.com',
            template: 'status-change', templateVersion: 1, ...over,
        };
    };
    const row = async (id: number) => (await dataSource.query('SELECT * FROM customer_notifications WHERE customer_notification_id = $1', [id]))[0];

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'postgres',
            host: process.env.TEST_DB_HOST ?? 'localhost',
            port: Number(PORT),
            username: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASSWORD,
            database: process.env.TEST_DB_NAME,
        });
        await dataSource.initialize();
        repository = new CustomerStatusNoticeRepository(dataSource);
        const [created] = await dataSource.query(
            `INSERT INTO dispatches (dispatch_type_id, dispatch_status_id, source_order_ref, delivery_address, contact_email, tracking_code)
             VALUES ((SELECT dispatch_type_id FROM dispatch_types WHERE name = 'delivery'),
                     (SELECT dispatch_status_id FROM dispatch_statuses WHERE name = 'in_transit'), $1, 'Calle 1', 'ana@example.com', $2)
             RETURNING dispatch_id`,
            [`IT-${RUN}`, `DSP-IT-${RUN}`],
        );
        dispatchId = created.dispatch_id;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) {
            if (dispatchId) {
                await dataSource.query('DELETE FROM customer_notifications WHERE dispatch_id = $1', [dispatchId]);
                await dataSource.query('DELETE FROM dispatches WHERE dispatch_id = $1', [dispatchId]);
            }
            await dataSource.destroy();
        }
    });

    it('reads the dispatch the email is about', async () => {
        expect(await repository.findDispatch(dispatchId)).toMatchObject({
            dispatchId, type: 'delivery', currentStatus: 'in_transit', contactEmail: 'ana@example.com', trackingCode: `DSP-IT-${RUN}`,
        });
        expect(await repository.findDispatch(2_000_000_000)).toBeNull();
    });

    it('registers the email as sending, with a lease, and refuses a second registration of the same key', async () => {
        const first = notification();
        const id = await repository.reserve(first);
        expect(id).toEqual(expect.any(Number));
        expect(await row(id!)).toMatchObject({
            status: 'sending', attempts: 0, notification_type: 'status_change', recipient: 'ana@example.com', template_version: 1,
            dispatch_status: 'delivered', sent_at: null, last_error: null,
        });
        expect((await row(id!)).locked_until).toBeInstanceOf(Date);
        expect((await row(id!)).next_attempt_at.getTime()).toBeGreaterThan(Date.now());

        expect(await repository.reserve(first)).toBeNull();
        const count = await dataSource.query('SELECT count(*)::int AS n FROM customer_notifications WHERE idempotency_key = $1', [first.idempotencyKey]);
        expect(count[0].n).toBe(1);
    });

    it('leaves one row when the same event arrives at the same time many times', async () => {
        const event = notification();
        const results = await Promise.all(Array.from({ length: 8 }, () => repository.reserve(event)));
        expect(results.filter((id) => id !== null)).toHaveLength(1);
        const count = await dataSource.query('SELECT count(*)::int AS n FROM customer_notifications WHERE idempotency_key = $1', [event.idempotencyKey]);
        expect(count[0].n).toBe(1);
    });

    it('registers another passage through the same status (another instant) as another email', async () => {
        const a = notification({ idempotencyKey: `status_change:${dispatchId}:delivered:A-${RUN}`, sourceEventKey: `${dispatchId}:delivered:A-${RUN}` });
        const b = notification({ idempotencyKey: `status_change:${dispatchId}:delivered:B-${RUN}`, sourceEventKey: `${dispatchId}:delivered:B-${RUN}` });
        expect(await repository.reserve(a)).not.toBeNull();
        expect(await repository.reserve(b)).not.toBeNull();
    });

    it('records a sent email: status, attempts, sent_at, and no lease left', async () => {
        const id = (await repository.reserve(notification()))!;
        expect(await repository.recordOutcome(id, { status: 'sent', attemptsMade: 2, nextAttemptAt: null, lastError: null })).toBe(true);
        const stored = await row(id);
        expect(stored).toMatchObject({ status: 'sent', attempts: 2, next_attempt_at: null, locked_until: null });
        expect(stored.sent_at).toBeInstanceOf(Date);
    });

    it('records a transient failure as retrying with the next attempt and the sanitized error', async () => {
        const id = (await repository.reserve(notification()))!;
        const nextAttemptAt = new Date(Date.now() + 5 * 60_000);
        expect(await repository.recordOutcome(id, { status: 'retrying', attemptsMade: 3, nextAttemptAt, lastError: 'connect ECONNREFUSED' })).toBe(true);
        const stored = await row(id);
        expect(stored).toMatchObject({ status: 'retrying', attempts: 3, last_error: 'connect ECONNREFUSED', locked_until: null, sent_at: null });
        expect(stored.next_attempt_at.getTime()).toBe(nextAttemptAt.getTime());
    });

    it('adds the attempts of a later round, keeps the error of a sent email and ends in a final status', async () => {
        const id = (await repository.reserve(notification()))!;
        await repository.recordOutcome(id, { status: 'retrying', attemptsMade: 3, nextAttemptAt: new Date(), lastError: 'timeout' });
        await dataSource.query(`UPDATE customer_notifications SET status = 'sending' WHERE customer_notification_id = $1`, [id]);
        await repository.recordOutcome(id, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null });
        expect(await row(id)).toMatchObject({ status: 'sent', attempts: 4, last_error: 'timeout', next_attempt_at: null });
    });

    it('records a bounce and an exhausted email as final, with no next attempt', async () => {
        const bounced = (await repository.reserve(notification()))!;
        await repository.recordOutcome(bounced, { status: 'bounced', attemptsMade: 1, nextAttemptAt: null, lastError: 'rejected' });
        expect(await row(bounced)).toMatchObject({ status: 'bounced', next_attempt_at: null });

        const exhausted = (await repository.reserve(notification()))!;
        await repository.recordOutcome(exhausted, { status: 'exhausted', attemptsMade: 3, nextAttemptAt: null, lastError: 'timeout' });
        expect(await row(exhausted)).toMatchObject({ status: 'exhausted', next_attempt_at: null });
    });

    it('does not overwrite a row that is no longer sending (another process finished it)', async () => {
        const id = (await repository.reserve(notification()))!;
        await repository.recordOutcome(id, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null });
        expect(await repository.recordOutcome(id, { status: 'retrying', attemptsMade: 3, nextAttemptAt: new Date(), lastError: 'late' })).toBe(false);
        expect(await row(id)).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
    });
});
