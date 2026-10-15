import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MessageValidator } from '../../../plugins/messaging/envelope/message-validator.js';
import { OutboxService } from '../../../modules/messaging/outbound-messages/services/outbox.service.js';
import { PromiseFirmingService } from './promise-firming.service.js';

const validator = MessageValidator.fromDirectory(resolve(process.cwd(), 'contracts/messages'));
const NOTIFIED_AT = new Date('2026-10-15T12:00:00.000Z');
const WINDOW_END = new Date(NOTIFIED_AT.getTime() + 720 * 60_000); // 2026-10-16T00:00:00Z

const baseRow = {
    id: 21, status: 'scheduled', version: 3, source_order_ref: 'SO-2026-000123', tracking_code: 'DSP-2026-00045',
    promise_notified_at: NOTIFIED_AT, promise_firmed_at: null, customer_confirmation: 'pending',
    scheduled_window_start: new Date('2026-10-17T14:00:00.000Z'), scheduled_window_end: new Date('2026-10-17T16:00:00.000Z'),
    departure_date: '2026-10-17', warehouse_code: 'WH-LPZ-01',
};
const basePackages = [
    { external_package_id: 'PKG-000123-1', length_cm: '40.00', width_cm: '30.00', height_cm: '25.00', gross_weight_kg: '6.400' },
];

function setup(options?: { row?: Partial<typeof baseRow> | null; packages?: unknown[]; updated?: unknown[]; windowMinutes?: number }) {
    const row = options?.row === null ? null : { ...baseRow, ...options?.row };
    const queued: any[] = [];
    const manager = {
        query: vi.fn(async (sql: string) => {
            if (sql.includes('FROM dispatches d')) return row ? [row] : [];
            if (sql.includes('FROM dispatch_packages')) return options?.packages ?? basePackages;
            if (sql.includes('UPDATE dispatches')) return options?.updated ?? [{ dispatch_id: 21 }];
            return [];
        }),
    };
    const dataSource = { transaction: vi.fn((work: (m: any) => Promise<any>) => work(manager)) };
    // The real OutboxService and validator: the message must satisfy the real contract.
    const outbox = new OutboxService({ manager: { query: vi.fn() } } as never, validator);
    const enqueue = vi.spyOn(outbox, 'enqueue').mockImplementation(async (envelope) => {
        const result = validator.validate(envelope.type, envelope);
        if (!result.valid) throw new Error(`invalid message: ${JSON.stringify(result.errors)}`);
        queued.push(envelope);
        return true;
    });
    const settings = { getNumber: vi.fn().mockResolvedValue(options?.windowMinutes ?? 720) };
    const service = new PromiseFirmingService(dataSource as never, outbox, settings as never);
    return { service, manager, dataSource, enqueue, queued, settings };
}

const wrote = (manager: { query: ReturnType<typeof vi.fn> }) =>
    manager.query.mock.calls.some(([sql]) => /UPDATE dispatches|INSERT INTO dispatch_events/.test(String(sql)));

describe('PromiseFirmingService', () => {
    it('firms in silence once the window closes and queues a contract-valid preparation order', async () => {
        const { service, manager, queued } = setup();

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'firmed', dispatchId: 21, recordVersion: 3, reason: 'window_elapsed' });
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({ type: 'dispatch.shipment.prepare_requested', source: 'dispatch' });
        expect(queued[0].data).toEqual({
            salesOrderId: 'SO-2026-000123', trackingCode: 'DSP-2026-00045', recordVersion: 3,
            updatedAt: WINDOW_END.toISOString(), warehouseId: 'WH-LPZ-01', departureDate: '2026-10-17',
            deliveryWindowStart: '2026-10-17T14:00:00.000Z', deliveryWindowEnd: '2026-10-17T16:00:00.000Z',
            packages: [{ packageId: 'PKG-000123-1', lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 }],
        });
        const update = manager.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE dispatches'))!;
        expect(update[0]).toContain("customer_confirmation = 'confirmed'");
        expect(update[0]).toContain('promise_firmed_at IS NULL');
        expect(update[1]).toEqual([21, WINDOW_END]);
        // The audit event records why the promise became firm; it never touches `version`.
        expect(update[0]).not.toMatch(/version\s*=/);
        const event = manager.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_events'))!;
        expect(event[1][1]).toBe('system');
        expect(JSON.parse(event[1][3])).toMatchObject({ reason: 'window_elapsed', recordVersion: 3 });
    });

    it('does not firm before the window closes (one minute short)', async () => {
        const { service, manager, queued } = setup();

        const result = await service.firm(21, { reason: 'window_elapsed', now: new Date(WINDOW_END.getTime() - 60_000) });

        expect(result).toEqual({ outcome: 'not_eligible', dispatchId: 21, cause: 'window_open' });
        expect(wrote(manager)).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it('reads the window from the setting, not from a constant', async () => {
        const { service, settings, queued } = setup({ windowMinutes: 60 });

        const result = await service.firm(21, { reason: 'window_elapsed', now: new Date(NOTIFIED_AT.getTime() + 60 * 60_000) });

        expect(settings.getNumber).toHaveBeenCalledWith('promise_response_window_minutes', 720);
        expect(result.outcome).toBe('firmed');
        expect(queued).toHaveLength(1);
    });

    it('firms immediately on an explicit customer confirmation, with the customer as actor', async () => {
        const { service, manager, queued } = setup();

        const result = await service.firm(21, { reason: 'customer_confirmed', now: new Date(NOTIFIED_AT.getTime() + 60_000) });

        expect(result).toMatchObject({ outcome: 'firmed', reason: 'customer_confirmed' });
        expect(queued).toHaveLength(1);
        const event = manager.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO dispatch_events'))!;
        expect(event[1][1]).toBe('customer');
    });

    it('never firms a dispatch without a valid notice (a bounce leaves promise_notified_at null)', async () => {
        const { service, manager, queued } = setup({ row: { promise_notified_at: null } });

        for (const reason of ['window_elapsed', 'customer_confirmed'] as const) {
            const result = await service.firm(21, { reason, now: WINDOW_END });
            expect(result).toEqual({ outcome: 'not_eligible', dispatchId: 21, cause: 'no_valid_notice' });
        }
        expect(wrote(manager)).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it('leaves a dispatch with a recorded customer response alone (change_requested keeps its own path)', async () => {
        const { service, queued } = setup({ row: { customer_confirmation: 'change_requested' } });

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'not_eligible', dispatchId: 21, cause: 'customer_response_recorded' });
        expect(queued).toHaveLength(0);
    });

    it('is a no-op for an already firm promise (single emission)', async () => {
        const { service, manager, queued } = setup({ row: { promise_firmed_at: WINDOW_END } });

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'already_firmed', dispatchId: 21 });
        expect(wrote(manager)).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it('loses the race cleanly: the guarded UPDATE touches no row, so nothing is queued', async () => {
        const { service, manager, queued } = setup({ updated: [] });

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'already_firmed', dispatchId: 21 });
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO dispatch_events'))).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it('does not firm or emit when the version is below 1, and says why', async () => {
        const { service, manager, queued } = setup({ row: { version: 0 } });

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'incomplete', dispatchId: 21, cause: 'invalid_version' });
        expect(wrote(manager)).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it.each([
        ['no packages', { packages: [] }, 'missing_packages'],
        ['no tracking code', { row: { tracking_code: null } }, 'missing_tracking_code'],
        ['no batch / departure date', { row: { departure_date: null } }, 'missing_departure_date'],
    ])('does not firm when the order cannot be built: %s', async (_name, options, cause) => {
        const { service, manager, queued } = setup(options as never);

        const result = await service.firm(21, { reason: 'window_elapsed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'incomplete', dispatchId: 21, cause });
        expect(wrote(manager)).toBe(false);
        expect(queued).toHaveLength(0);
    });

    it('does not firm a dispatch in a state that no longer carries the promise', async () => {
        const { service, queued } = setup({ row: { status: 'cancelled' } });

        const result = await service.firm(21, { reason: 'customer_confirmed', now: WINDOW_END });

        expect(result).toEqual({ outcome: 'not_eligible', dispatchId: 21, cause: 'status' });
        expect(queued).toHaveLength(0);
    });

    it('reports a missing dispatch without throwing', async () => {
        const { service } = setup({ row: null });

        expect(await service.firm(99, { reason: 'window_elapsed', now: WINDOW_END }))
            .toEqual({ outcome: 'not_eligible', dispatchId: 99, cause: 'not_found' });
    });

    it('joins an outer transaction instead of opening its own', async () => {
        const { service, manager, dataSource } = setup();
        const outer = { query: manager.query };

        await service.firm(21, { reason: 'customer_confirmed', now: WINDOW_END, manager: outer as never });

        expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('emits a higher recordVersion when the dispatch was moved (rescheduling bumps version)', async () => {
        const first = setup({ row: { version: 3 } });
        const second = setup({ row: { version: 4 } });

        await first.service.firm(21, { reason: 'customer_confirmed', now: WINDOW_END });
        await second.service.firm(21, { reason: 'customer_confirmed', now: WINDOW_END });

        expect(second.queued[0].data.recordVersion).toBeGreaterThan(first.queued[0].data.recordVersion);
        expect(second.queued[0].messageId).not.toBe(first.queued[0].messageId);
    });
});
