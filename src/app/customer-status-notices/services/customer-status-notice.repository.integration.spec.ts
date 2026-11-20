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
    /** The lease stored in the row, as text (what `reserve` and `claimDue` hand out). */
    const storedLease = async (id: number): Promise<string> =>
        (await dataSource.query('SELECT locked_until::text AS lease FROM customer_notifications WHERE customer_notification_id = $1', [id]))[0].lease;
    /** A registered email this test owns. */
    const reserveOne = async (over: Partial<NewNotification> = {}) => (await repository.reserve(notification(over)))!;
    /** A registered email whose next attempt (or lease) ended `minutesAgo` minutes ago, in the given state. */
    const due = async (status: string, minutesAgo = 1, attempts = 0): Promise<number> => {
        const { notificationId } = await reserveOne();
        await dataSource.query(
            `UPDATE customer_notifications
                SET status = $2::varchar, attempts = $3::int, next_attempt_at = NOW() - make_interval(mins => $4::int),
                    locked_until = CASE WHEN $2::varchar = 'sending' THEN NOW() - make_interval(mins => $4::int) END,
                    sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() END
              WHERE customer_notification_id = $1`,
            [notificationId, status, attempts, minutesAgo],
        );
        return notificationId;
    };

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
        const reserved = await repository.reserve(first);
        const id = reserved!.notificationId;
        expect(id).toEqual(expect.any(Number));
        expect(await row(id)).toMatchObject({
            status: 'sending', attempts: 0, notification_type: 'status_change', recipient: 'ana@example.com', template_version: 1,
            dispatch_status: 'delivered', sent_at: null, last_error: null,
        });
        expect((await row(id)).locked_until).toBeInstanceOf(Date);
        expect((await row(id)).next_attempt_at.getTime()).toBeGreaterThan(Date.now());
        expect(reserved!.lease).toBe(await storedLease(id));

        expect(await repository.reserve(first)).toBeNull();
        const count = await dataSource.query('SELECT count(*)::int AS n FROM customer_notifications WHERE idempotency_key = $1', [first.idempotencyKey]);
        expect(count[0].n).toBe(1);
    });

    it('leaves one row when the same event arrives at the same time many times', async () => {
        const event = notification();
        const results = await Promise.all(Array.from({ length: 8 }, () => repository.reserve(event)));
        expect(results.filter((reserved) => reserved !== null)).toHaveLength(1);
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
        const { notificationId, lease } = await reserveOne();
        expect(await repository.recordOutcome(notificationId, lease, { status: 'sent', attemptsMade: 2, nextAttemptAt: null, lastError: null })).toBe(true);
        const stored = await row(notificationId);
        expect(stored).toMatchObject({ status: 'sent', attempts: 2, next_attempt_at: null, locked_until: null });
        expect(stored.sent_at).toBeInstanceOf(Date);
    });

    it('records a transient failure as retrying with the next attempt and the sanitized error', async () => {
        const { notificationId, lease } = await reserveOne();
        const nextAttemptAt = new Date(Date.now() + 5 * 60_000);
        expect(await repository.recordOutcome(notificationId, lease, { status: 'retrying', attemptsMade: 3, nextAttemptAt, lastError: 'connect ECONNREFUSED' })).toBe(true);
        const stored = await row(notificationId);
        expect(stored).toMatchObject({ status: 'retrying', attempts: 3, last_error: 'connect ECONNREFUSED', locked_until: null, sent_at: null });
        expect(stored.next_attempt_at.getTime()).toBe(nextAttemptAt.getTime());
    });

    it('adds the attempts of a later round, keeps the error of a sent email and ends in a final status', async () => {
        const id = await due('retrying', 1, 3);
        await dataSource.query(`UPDATE customer_notifications SET last_error = 'timeout' WHERE customer_notification_id = $1`, [id]);
        const claimed = (await repository.claimDue(100)).find((c) => c.notificationId === id)!;
        expect(await repository.recordOutcome(id, claimed.lease, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null })).toBe(true);
        expect(await row(id)).toMatchObject({ status: 'sent', attempts: 4, last_error: 'timeout', next_attempt_at: null });
    });

    it('records a bounce and an exhausted email as final, with no next attempt', async () => {
        const bounced = await reserveOne();
        await repository.recordOutcome(bounced.notificationId, bounced.lease, { status: 'bounced', attemptsMade: 1, nextAttemptAt: null, lastError: 'rejected' });
        expect(await row(bounced.notificationId)).toMatchObject({ status: 'bounced', next_attempt_at: null });

        const exhausted = await reserveOne();
        await repository.recordOutcome(exhausted.notificationId, exhausted.lease, { status: 'exhausted', attemptsMade: 3, nextAttemptAt: null, lastError: 'timeout' });
        expect(await row(exhausted.notificationId)).toMatchObject({ status: 'exhausted', next_attempt_at: null });
    });

    describe('claimDue', () => {
        const mine = <T extends { dispatchId: number }>(rows: T[]) => rows.filter((claimed) => claimed.dispatchId === dispatchId);

        it('takes over a retrying email whose next attempt arrived, and leases it again', async () => {
            const id = await due('retrying', 1, 3);
            const claimed = mine(await repository.claimDue(100)).filter((c) => c.notificationId === id);
            expect(claimed).toEqual([{
                notificationId: id, dispatchId, dispatchStatus: 'delivered', occurredAt: '2026-11-19T14:30:00.000Z', recipient: 'ana@example.com', attempts: 3,
                lease: expect.any(String),
            }]);
            const stored = await row(id);
            expect(stored.status).toBe('sending');
            expect(stored.attempts).toBe(3);
            expect(stored.locked_until.getTime()).toBeGreaterThan(Date.now());
            expect(stored.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
            expect(claimed[0]!.lease).toBe(await storedLease(id));
        });

        it('takes over a sending email whose lease ran out and counts the attempt of the process that died', async () => {
            const id = await due('sending', 15, 0);
            const claimed = mine(await repository.claimDue(100)).filter((c) => c.notificationId === id);
            expect(claimed).toHaveLength(1);
            expect(claimed[0]!.attempts).toBe(1);
            expect((await row(id)).attempts).toBe(1);
        });

        it('leaves alone what is not due: a live lease, a retry in the future and the final states', async () => {
            const live = await reserveOne();
            const future = await due('retrying', -30);
            const finished = [await due('sent', 5), await due('bounced', 5), await due('exhausted', 5)];
            const claimed = (await repository.claimDue(100)).map((c) => c.notificationId);
            for (const id of [live.notificationId, future, ...finished]) expect(claimed).not.toContain(id);
        });

        it('does not take the same email twice, even when two runs ask at the same time', async () => {
            const ids = await Promise.all(Array.from({ length: 6 }, () => due('retrying', 2)));
            const runs = await Promise.all([repository.claimDue(4), repository.claimDue(4), repository.claimDue(4)]);
            const claimed = runs.flatMap((run) => run.map((c) => c.notificationId)).filter((id) => ids.includes(id));
            expect(new Set(claimed).size).toBe(claimed.length);
            expect(claimed.length).toBe(6);
        });

        it('takes at most the limit, the oldest first', async () => {
            const TEN_DAYS = 14_400;
            const older = await due('retrying', TEN_DAYS + 10);
            const newer = await due('retrying', TEN_DAYS);
            const first = await repository.claimDue(1);
            expect(first.map((c) => c.notificationId)).toEqual([older]);
            const second = await repository.claimDue(1);
            expect(second.map((c) => c.notificationId)).toEqual([newer]);
        });
    });

    describe('the lease is the proof of ownership', () => {
        it('does not overwrite a row that is no longer sending (another process finished it)', async () => {
            const { notificationId, lease } = await reserveOne();
            await repository.recordOutcome(notificationId, lease, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null });
            expect(await repository.recordOutcome(notificationId, lease, { status: 'retrying', attemptsMade: 3, nextAttemptAt: new Date(), lastError: 'late' })).toBe(false);
            expect(await row(notificationId)).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
        });

        it('does not let a process whose lease ran out overwrite the one that took the row over, even while it is still sending', async () => {
            const slow = await reserveOne();
            // the lease of the slow process ran out and the recovery task took the row over with a new one
            await dataSource.query(
                `UPDATE customer_notifications SET locked_until = NOW() - interval '1 minute', next_attempt_at = NOW() - interval '1 minute' WHERE customer_notification_id = $1`,
                [slow.notificationId],
            );
            const takeover = (await repository.claimDue(100)).find((c) => c.notificationId === slow.notificationId)!;
            expect(takeover.lease).not.toBe(slow.lease);

            // the slow process comes back first: its result is refused and the row is untouched
            expect(await repository.recordOutcome(slow.notificationId, slow.lease, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null })).toBe(false);
            expect(await row(slow.notificationId)).toMatchObject({ status: 'sending', sent_at: null, attempts: 1 });

            // the one that owns the row now can record its own
            expect(await repository.recordOutcome(slow.notificationId, takeover.lease, { status: 'sent', attemptsMade: 1, nextAttemptAt: null, lastError: null })).toBe(true);
            expect(await row(slow.notificationId)).toMatchObject({ status: 'sent', attempts: 2 });
        });
    });
});
