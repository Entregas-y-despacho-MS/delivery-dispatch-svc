import { describe, expect, it, vi } from 'vitest';
import { CustomerResponseService } from './customer-response.service.js';
import type { TrackingContext } from './public-tracking.service.js';

const NOW = new Date('2026-10-17T16:00:00Z');

function context(overrides: { selfService?: Partial<TrackingContext['selfService']>; confirmation?: string; status?: string } = {}): TrackingContext {
    return {
        dispatchId: 7,
        status: overrides.status ?? 'scheduled',
        version: 1,
        row: { customer_confirmation: overrides.confirmation ?? 'pending', status: overrides.status ?? 'scheduled' } as any,
        selfService: {
            open: true,
            closedReason: null,
            windowClosesAt: new Date('2026-10-18T02:00:00Z'),
            rescheduleAttemptsLeft: 2,
            canConfirm: true,
            canReschedule: true,
            canRequestChange: true,
            ...overrides.selfService,
        },
    };
}

function setup(ctx: TrackingContext, options: { firmResult?: unknown; current?: { status: string; customer_confirmation: string } | undefined } = {}) {
    const resolve = vi.fn(async () => ctx);
    const view = vi.fn(async () => ({ marker: 'view' }));
    const firm = vi.fn(async () => options.firmResult ?? { outcome: 'firmed', dispatchId: 7, recordVersion: 1, reason: 'customer_confirmed' });
    const current = 'current' in options ? options.current : { status: 'scheduled', customer_confirmation: 'pending' };
    const manager = {
        query: vi.fn(async (sql: string) => (sql.includes('FOR UPDATE') ? (current ? [current] : []) : [])),
    };
    const dataSource = { transaction: vi.fn(async (work: (m: typeof manager) => Promise<unknown>) => await work(manager)) };
    const service = new CustomerResponseService(dataSource as any, { resolve, view } as any, { firm } as any);
    return { service, resolve, view, firm, manager, dataSource };
}

describe('CustomerResponseService.confirm', () => {
    it('firms the promise as a customer confirmation and answers the updated page', async () => {
        const { service, firm, view } = setup(context());

        await expect(service.confirm('tok', NOW)).resolves.toEqual({ marker: 'view' });

        expect(firm).toHaveBeenCalledWith(7, { reason: 'customer_confirmed', now: NOW });
        expect(view).toHaveBeenCalledWith('tok', NOW);
    });

    it('treats a parallel click that already firmed it as done', async () => {
        const { service } = setup(context(), { firmResult: { outcome: 'already_firmed', dispatchId: 7 } });

        await expect(service.confirm('tok', NOW)).resolves.toEqual({ marker: 'view' });
    });

    it.each([
        ['the window elapsed', { selfService: { open: false, closedReason: 'window_elapsed', canConfirm: false } }, 'window_elapsed'],
        ['the customer already confirmed', { confirmation: 'confirmed', selfService: { open: false, closedReason: 'confirmed', canConfirm: false } }, 'confirmed'],
        ['the notice never reached the customer', { selfService: { open: false, closedReason: 'no_valid_notice', canConfirm: false } }, 'no_valid_notice'],
        ['a rescheduling already firmed it', { confirmation: 'rescheduled', selfService: { canConfirm: false } }, 'rescheduled'],
    ])('is a 409 with its reason when %s, and does not touch the promise', async (_name, overrides, reason) => {
        const { service, firm } = setup(context(overrides as any));

        await expect(service.confirm('tok', NOW)).rejects.toMatchObject({
            status: 409, response: { error: 'CONFIRMATION_NOT_AVAILABLE', details: { reason } },
        });
        expect(firm).not.toHaveBeenCalled();
    });

    it('is a 409 when the promise cannot be firmed because the order is incomplete', async () => {
        const { service } = setup(context(), { firmResult: { outcome: 'incomplete', dispatchId: 7, cause: 'missing_packages' } });

        await expect(service.confirm('tok', NOW)).rejects.toMatchObject({ response: { details: { reason: 'order_incomplete' } } });
    });

    it('is a 409 with the cause when a racing answer was recorded first', async () => {
        const { service } = setup(context(), { firmResult: { outcome: 'not_eligible', dispatchId: 7, cause: 'customer_response_recorded' } });

        await expect(service.confirm('tok', NOW)).rejects.toMatchObject({ response: { details: { reason: 'customer_response_recorded' } } });
    });
});

describe('CustomerResponseService.requestChange', () => {
    it('marks the delivery, keeps the text as an event and moves nothing', async () => {
        const { service, manager, view } = setup(context());

        await expect(service.requestChange('tok', 'After the 28th, please', NOW)).resolves.toEqual({ marker: 'view' });

        const writes = manager.query.mock.calls.map((call) => String(call[0]));
        expect(writes.some((sql) => sql.includes("customer_confirmation = 'change_requested'"))).toBe(true);
        expect(writes.join(' ')).not.toMatch(/version\s*=/);
        expect(writes.join(' ')).not.toContain('promise_firmed_at');
        expect(writes.join(' ')).not.toContain('promise_notified_at');
        const insert = manager.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO dispatch_events'))!;
        expect(insert[1]).toEqual([
            7,
            'Customer asked for a change from the tracking link',
            'After the 28th, please',
            JSON.stringify({ previousCustomerConfirmation: 'pending', selfServiceOpen: true, selfServiceClosedReason: null, status: 'scheduled' }),
        ]);
        expect(view).toHaveBeenCalledWith('tok', NOW);
    });

    it('records that the self-service was already over when the customer asked', async () => {
        const { service, manager } = setup(
            context({ selfService: { open: false, closedReason: 'window_elapsed' } }),
            { current: { status: 'scheduled', customer_confirmation: 'confirmed' } },
        );

        await service.requestChange('tok', 'Move it', NOW);

        const insert = manager.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO dispatch_events'))!;
        expect(JSON.parse((insert[1] as string[])[3])).toMatchObject({
            previousCustomerConfirmation: 'confirmed', selfServiceOpen: false, selfServiceClosedReason: 'window_elapsed',
        });
    });

    it.each([
        ['a request is already pending', context({ confirmation: 'change_requested', selfService: { canRequestChange: false } }), 'change_requested'],
        ['the delivery is not in a state the coordinator can change', context({ status: 'delivered', selfService: { canRequestChange: false, closedReason: 'not_open' } }), 'not_open'],
    ])('is a 409 when %s, before opening a transaction', async (_name, ctx, reason) => {
        const { service, dataSource } = setup(ctx);

        await expect(service.requestChange('tok', 'x', NOW)).rejects.toMatchObject({
            status: 409, response: { error: 'CHANGE_REQUEST_NOT_AVAILABLE', details: { reason } },
        });
        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('re-checks under the row lock: a request that lost the race is a 409 and writes nothing', async () => {
        const { service, manager } = setup(context(), { current: { status: 'scheduled', customer_confirmation: 'change_requested' } });

        await expect(service.requestChange('tok', 'x', NOW)).rejects.toMatchObject({ response: { details: { reason: 'change_requested' } } });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('re-checks the state under the lock too', async () => {
        const { service, manager } = setup(context(), { current: { status: 'out_for_delivery', customer_confirmation: 'pending' } });

        await expect(service.requestChange('tok', 'x', NOW)).rejects.toMatchObject({ response: { details: { reason: 'not_open' } } });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });
});
