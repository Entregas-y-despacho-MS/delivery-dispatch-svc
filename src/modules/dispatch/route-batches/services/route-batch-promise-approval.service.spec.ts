import { describe, expect, it, vi } from 'vitest';
import { RouteBatchPromiseApprovalService } from './route-batch-promise-approval.service.js';

function setup(options?: { reviewerId?: number | null; version?: number; dispatches?: any[]; mail?: any }) {
    const rows = options?.dispatches ?? [{
        id: 21, version: 2, status: 'in_planning', contact_email: 'customer@example.test',
        scheduled_window_start: new Date('2026-10-16T13:00:00.000Z'),
        scheduled_window_end: new Date('2026-10-16T15:00:00.000Z'), tracking_token: null, promise_notified_at: null,
    }, {
        id: 22, version: 0, status: 'in_planning', contact_email: null,
        scheduled_window_start: new Date('2026-10-16T15:00:00.000Z'),
        scheduled_window_end: new Date('2026-10-16T17:00:00.000Z'), tracking_token: null, promise_notified_at: null,
    }];
    const manager = { query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM route_batches')) return [{ id: 7, version: options?.version ?? 1, status: 'provisional', reviewer_user_id: options?.reviewerId ?? 9, vehicle_id: 4 }];
        if (sql.includes('FROM dispatches d')) return rows;
        return [];
    }) };
    const dataSource = { transaction: vi.fn((work: (manager: any) => Promise<any>) => work(manager)) };
    const capacity = { assertAssignable: vi.fn().mockResolvedValue({ assignable: true }) };
    const mailer = { send: vi.fn().mockResolvedValue(options?.mail ?? { status: 'sent' }) };
    const config = { get: vi.fn().mockReturnValue('https://dispatch.example.test') };
    return {
        service: new RouteBatchPromiseApprovalService(dataSource as any, capacity as any, mailer as any, config as any),
        manager, dataSource, capacity, mailer, rows,
    };
}

describe('RouteBatchPromiseApprovalService', () => {
    it('approves current dispatch versions, sends after commit, and only timestamps a successful email', async () => {
        const { service, dataSource, manager, capacity, mailer } = setup();
        const result = await service.approve(7, {
            version: 1,
            dispatches: [{ dispatchId: 21, version: 2 }, { dispatchId: 22, version: 0 }],
        }, 9);

        expect(result).toMatchObject({ routeBatchId: 7, version: 2, approvedCount: 2, removedCount: 0, emailCount: 1 });
        expect(result.emailResults).toEqual([{ dispatchId: 21, result: 'sent' }, { dispatchId: 22, result: 'skipped' }]);
        expect(dataSource.transaction).toHaveBeenCalledTimes(2);
        expect(capacity.assertAssignable).toHaveBeenCalledWith(7, 4, expect.anything());
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({
            template: 'promise',
            metadata: { dispatchId: 21, routeBatchId: 7 },
        }));
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('SET promise_notified_at = COALESCE'))).toBe(true);
    });

    it('returns an approved dispatch to pending and audits its removal', async () => {
        const { service, manager } = setup();
        const result = await service.approve(7, {
            version: 1,
            dispatches: [{ dispatchId: 21, version: 2 }, { dispatchId: 22, version: 0 }],
            removeDispatchIds: [22],
        }, 9);

        expect(result).toMatchObject({ approvedCount: 1, removedCount: 1 });
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('removed_from_provisional_batch'))).toBe(true);
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('dispatch_removed_before_approval'))).toBe(true);
    });

    it('does not mutate or send when the batch version is stale', async () => {
        const { service, manager, capacity, mailer } = setup({ version: 2 });

        await expect(service.approve(7, { version: 1, dispatches: [{ dispatchId: 21, version: 2 }, { dispatchId: 22, version: 0 }] }, 9))
            .rejects.toMatchObject({ response: expect.objectContaining({ error: 'ROUTE_BATCH_VERSION_CONFLICT' }) });
        expect(manager.query).toHaveBeenCalledTimes(1);
        expect(capacity.assertAssignable).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('rejects another coordinator before changing the batch', async () => {
        const { service, manager } = setup({ reviewerId: 10 });

        await expect(service.approve(7, { version: 1, dispatches: [{ dispatchId: 21, version: 2 }, { dispatchId: 22, version: 0 }] }, 9))
            .rejects.toMatchObject({ response: expect.objectContaining({ error: 'ROUTE_BATCH_REVIEWER_MISMATCH' }) });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('does not treat a bounce as notification and records coordinator follow-up', async () => {
        const { service, manager } = setup({ mail: { status: 'bounced' } });
        await service.approve(7, { version: 1, dispatches: [{ dispatchId: 21, version: 2 }, { dispatchId: 22, version: 0 }] }, 9);

        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('SET promise_notified_at = COALESCE'))).toBe(false);
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('contact_management_required'))).toBe(true);
        expect(manager.query.mock.calls.some(([sql]) => String(sql).includes('promise_email_bounced'))).toBe(true);
    });
});
