import { describe, expect, it, vi } from 'vitest';
import { TrackingLinkRevealService } from './tracking-link-reveal.service.js';

const TOKEN = '5b0a7c1e-0d0e-4a44-9d5f-3a1b2c3d4e5f';

const row = (over: Record<string, unknown> = {}) => ({
    status: 'scheduled', customer_confirmation: 'change_requested', has_contact_email: false,
    tracking_token: TOKEN, has_live_token: true, ...over,
});

function setup(rows: Record<string, unknown>[], webUrl?: string) {
    const manager = { query: vi.fn(async (sql: string) => (sql.includes('FOR UPDATE') ? rows : [])) };
    const dataSource = { transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => await work(manager)) };
    const config = { get: vi.fn((_key: string, fallback: string) => webUrl ?? fallback) };
    const service = new TrackingLinkRevealService(dataSource as any, config as any);
    const writes = () => manager.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT'));
    return { service, manager, dataSource, writes };
}

describe('TrackingLinkRevealService.reveal', () => {
    it('shows the tracking page of a customer without email who has a pending request', async () => {
        const { service } = setup([row()]);

        await expect(service.reveal(7, 42)).resolves.toEqual({ dispatchId: 7, trackingUrl: `http://localhost:5173/seguimiento/${TOKEN}` });
    });

    it('builds the link from the public web address of the configuration, with no double slash', async () => {
        const { service } = setup([row()], 'https://entregas.example.com/');

        expect((await service.reveal(7, 42)).trackingUrl).toBe(`https://entregas.example.com/seguimiento/${TOKEN}`);
    });

    it('reads the dispatch under a row lock, in the same transaction that records the event', async () => {
        const { service, manager, dataSource } = setup([row()]);

        await service.reveal(7, 42);

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(String(manager.query.mock.calls[0][0])).toContain('FOR UPDATE OF d');
        expect(manager.query.mock.calls[0][1]).toEqual([7]);
        expect(manager.query.mock.calls).toHaveLength(2);
    });

    it('records who asked for it and when, and never the link or the token', async () => {
        const { service, writes } = setup([row()]);

        await service.reveal(7, 42);

        const [event] = writes();
        expect(String(event[0])).toContain("'user'");
        expect(String(event[0])).toContain("'{}'::jsonb");
        expect(event[1]).toEqual([7, 'tracking_link_revealed', 42]);
        expect(JSON.stringify(event)).not.toContain(TOKEN);
        expect(JSON.stringify(event)).not.toContain('seguimiento');
    });

    it('records every time it is shown: two requests are two events', async () => {
        const { service, writes } = setup([row()]);

        await service.reveal(7, 42);
        await service.reveal(7, 43);

        expect(writes().map((call) => call[1])).toEqual([[7, 'tracking_link_revealed', 42], [7, 'tracking_link_revealed', 43]]);
    });

    it('is a 404 for a dispatch that does not exist', async () => {
        const { service, writes } = setup([]);

        await expect(service.reveal(999, 42)).rejects.toMatchObject({ status: 404, response: { error: 'DISPATCH_NOT_FOUND' } });
        expect(writes()).toHaveLength(0);
    });

    describe('what it refuses, writing nothing', () => {
        it.each([
            ['the customer did not ask for a change', { customer_confirmation: 'pending' }],
            ['the customer confirmed', { customer_confirmation: 'confirmed' }],
            ['the request was already resolved', { customer_confirmation: 'rescheduled' }],
            ['the delivery is on the road', { status: 'out_for_delivery' }],
            ['the delivery is done', { status: 'delivered' }],
        ])('is a 409 CHANGE_REQUEST_NOT_PENDING when %s', async (_name, over) => {
            const { service, writes } = setup([row(over)]);

            await expect(service.reveal(7, 42)).rejects.toMatchObject({ status: 409, response: { error: 'CHANGE_REQUEST_NOT_PENDING' } });
            expect(writes()).toHaveLength(0);
        });

        it('is a 409 with its reason when the order has an email: the customer already got the link there', async () => {
            const { service, writes } = setup([row({ has_contact_email: true })]);

            await expect(service.reveal(7, 42)).rejects.toMatchObject({
                status: 409, response: { error: 'TRACKING_LINK_NOT_AVAILABLE', details: { reason: 'has_contact_email' } },
            });
            expect(writes()).toHaveLength(0);
        });

        it('is a 409 with its reason when the token does not exist or expired', async () => {
            const { service, writes } = setup([row({ has_live_token: false })]);

            await expect(service.reveal(7, 42)).rejects.toMatchObject({
                status: 409, response: { error: 'TRACKING_LINK_NOT_AVAILABLE', details: { reason: 'no_live_token' } },
            });
            expect(writes()).toHaveLength(0);
        });

        it('does not leak the token in any refusal', async () => {
            for (const over of [{ has_contact_email: true }, { has_live_token: false }, { customer_confirmation: 'pending' }]) {
                const { service } = setup([row(over)]);

                const error = await service.reveal(7, 42).catch((e) => e);

                expect(JSON.stringify(error.getResponse())).not.toContain(TOKEN);
            }
        });
    });
});
