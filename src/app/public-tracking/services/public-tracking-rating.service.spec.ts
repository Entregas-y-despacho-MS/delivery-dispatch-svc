import { describe, expect, it, vi } from 'vitest';
import { PublicTrackingService } from './public-tracking.service.js';
import { RatingAlreadySubmittedException, RatingNotAllowedException } from '../exceptions/index.js';

const TOKEN = '5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f';
const NOW = new Date('2026-10-17T16:00:00Z');
const CREATED_AT = new Date('2026-10-17T16:01:00Z');

function trackingRow(status = 'delivered') {
    return {
        dispatch_id: 7,
        status,
        version: 1,
        tracking_code: 'TRK-000123',
        customer_confirmation: 'pending',
        promise_notified_at: NOW,
        scheduled_window_start: null,
        scheduled_window_end: null,
        delivery_date: null,
        route_batch_id: 500,
        contact_email: null,
        has_contact_email: false,
        reschedule_attempts: 0,
    };
}

function setup(currentStatus = 'delivered', insertResult: unknown[] = [{ score: 4, created_at: CREATED_AT }]) {
    const events: string[] = [];
    const publicQuery = vi.fn(async () => [trackingRow()]);
    const managerQuery = vi.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE OF d')) return [{ dispatch_id: 7, status: currentStatus, driver_id: '42' }];
        if (sql.includes('INSERT INTO dispatch_ratings')) {
            events.push('insert');
            if (insertResult instanceof Error) throw insertResult;
            return insertResult;
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
    });
    const transaction = vi.fn(async (run: (manager: { query: typeof managerQuery }) => Promise<unknown>) => {
        const result = await run({ query: managerQuery });
        events.push('commit');
        return result;
    });
    const invalidate = vi.fn(async (driverId: number) => { events.push(`invalidate:${driverId}`); });
    const settings = {
        getNumber: vi.fn(async (_key: string, fallback: number) => fallback),
        getString: vi.fn(async (_key: string, fallback: string) => fallback),
    };
    const service = new PublicTrackingService(
        { query: publicQuery, transaction } as any,
        settings as any,
        { estimate: vi.fn() } as any,
        { invalidate } as any,
    );
    return { service, events, publicQuery, managerQuery, transaction, invalidate };
}

describe('PublicTrackingService.rate (ST-42.1)', () => {
    it('stores only after rechecking delivered under a row lock, then invalidates metrics after commit', async () => {
        const { service, events, managerQuery, invalidate } = setup();

        await expect(service.rate(TOKEN, 4, NOW)).resolves.toEqual({ score: 4, createdAt: CREATED_AT });

        expect(String(managerQuery.mock.calls[0][0])).toContain('FOR UPDATE OF d');
        expect(String(managerQuery.mock.calls[1][0])).toContain('INSERT INTO dispatch_ratings');
        expect(events).toEqual(['insert', 'commit', 'invalidate:42']);
        expect(invalidate).toHaveBeenCalledWith(42);
    });

    it('rejects a delivery whose state changed before the transaction lock and never writes or invalidates', async () => {
        const { service, managerQuery, invalidate } = setup('in_transit');

        await expect(service.rate(TOKEN, 4, NOW)).rejects.toBeInstanceOf(RatingNotAllowedException);

        expect(managerQuery).toHaveBeenCalledTimes(1);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('maps the real dispatch unique constraint violation to the public 409 and does not invalidate', async () => {
        const duplicate = Object.assign(new Error('duplicate key'), {
            driverError: { code: '23505', constraint: 'dispatch_ratings_dispatch_id_key' },
        });
        const { service, invalidate } = setup('delivered', duplicate as unknown as unknown[]);

        await expect(service.rate(TOKEN, 4, NOW)).rejects.toBeInstanceOf(RatingAlreadySubmittedException);

        expect(invalidate).not.toHaveBeenCalled();
    });
});
