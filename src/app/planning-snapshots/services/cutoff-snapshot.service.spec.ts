import { describe, expect, it, vi } from 'vitest';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import type { UniverseDispatchRead } from '../domain/cutoff-universe.js';
import { CutoffSnapshotService, type CaptureCutoffInput } from './cutoff-snapshot.service.js';

const NOW = localInstant('2026-10-13', '15:00');
const NOTIFIED_LONG_AGO = localInstant('2026-10-12', '08:45');
const NOTIFIED_TODAY = localInstant('2026-10-13', '10:00');

const read = (dispatchId: number, over: Partial<UniverseDispatchRead> = {}): UniverseDispatchRead => ({
    dispatchId,
    routeBatchId: 50,
    routeVersion: 4,
    dispatchTypeId: 1,
    dispatchType: 'delivery',
    status: 'scheduled',
    deliveryZoneId: 1,
    originWarehouseId: 1,
    scheduledWindowStart: localInstant('2026-10-14', '09:00'),
    promiseNotifiedAt: NOTIFIED_LONG_AGO,
    promiseFirmedAt: null,
    ...over,
});

const input = (over: Partial<CaptureCutoffInput> = {}): CaptureCutoffInput => ({
    shiftDate: '2026-10-14',
    now: NOW,
    windowMinutes: 720,
    manual: false,
    occurrence: 'route-cutoff@2026-10-13T15:00',
    ...over,
});

/** `query` answers by what the statement does, in the order the service asks. */
function build(options: { headerExists?: boolean; reads?: UniverseDispatchRead[] } = {}) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('INSERT INTO planning_cutoffs')) return options.headerExists ? [] : [{ planning_cutoff_id: 7 }];
        if (sql.includes('SELECT planning_cutoff_id FROM planning_cutoffs')) return [{ planning_cutoff_id: 3 }];
        if (sql.includes('FROM route_batches b')) return options.reads ?? [];
        return [];
    });
    const dataSource = { transaction: vi.fn(async (work: (manager: unknown) => unknown) => await work({ query })) };
    return { service: new CutoffSnapshotService(dataSource as any), query, dataSource };
}

const statements = (query: ReturnType<typeof build>['query'], fragment: string) =>
    query.mock.calls.filter(([sql]) => sql.includes(fragment));

describe('CutoffSnapshotService.capture', () => {
    it('saves the header and every dispatch of the day in one transaction', async () => {
        const { service, query, dataSource } = build({
            reads: [read(1, { promiseFirmedAt: NOTIFIED_LONG_AGO }), read(2, { promiseNotifiedAt: NOTIFIED_TODAY }), read(3, { status: 'in_planning' })],
        });

        const result = await service.capture(input());

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            planningCutoffId: 7,
            created: true,
            counts: { eligible: 1, excluded: 2, byExclusionCode: { cutoff_window_open: 1, cutoff_no_promise: 1 } },
        });
        const [header] = statements(query, 'INSERT INTO planning_cutoffs');
        expect(header[1]).toEqual(['2026-10-14', NOW, 'America/La_Paz', 'scheduled', 'route-cutoff@2026-10-13T15:00']);
        const [items] = statements(query, 'INSERT INTO planning_cutoff_dispatches');
        const saved = JSON.parse((items[1] as unknown[])[1] as string) as Array<{ dispatchId: number; universeStatus: string; exclusionCode: string | null; exclusionDetail: string | null }>;
        expect((items[1] as unknown[])[0]).toBe(7);
        expect(saved.map((entry) => [entry.dispatchId, entry.universeStatus, entry.exclusionCode])).toEqual([
            [1, 'eligible', null],
            [2, 'excluded', 'cutoff_window_open'],
            [3, 'excluded', 'cutoff_no_promise'],
        ]);
        // The database refuses an exclusion without an explanation: the service always sends it.
        for (const entry of saved.filter((item) => item.universeStatus === 'excluded')) expect(entry.exclusionDetail).toBeTruthy();
    });

    it('reads every provisional dispatch of the day without filtering by warehouse, sequence or coordinates', async () => {
        const { service, query } = build({ reads: [read(1)] });

        await service.capture(input());

        const [select] = statements(query, 'FROM route_batches b');
        expect(select[0]).toContain(`b.status = 'provisional'`);
        expect(select[0]).not.toContain('origin_warehouse_id IS NOT NULL');
        expect(select[0]).not.toContain('sequence_order');
        expect(select[1]).toEqual(['2026-10-14']);
    });

    it('keeps the first snapshot of a scheduled occurrence and writes nothing else', async () => {
        const { service, query } = build({ headerExists: true, reads: [read(1)] });

        const result = await service.capture(input());

        expect(result).toEqual({ planningCutoffId: 3, created: false, counts: null });
        expect(statements(query, 'FROM route_batches b')).toHaveLength(0);
        expect(statements(query, 'INSERT INTO planning_cutoff_dispatches')).toHaveLength(0);
    });

    it('saves a header with no dispatches when the day has no provisional batch', async () => {
        const { service, query } = build({ reads: [] });

        const result = await service.capture(input());

        expect(result).toEqual({ planningCutoffId: 7, created: true, counts: { eligible: 0, excluded: 0, byExclusionCode: {} } });
        expect(statements(query, 'INSERT INTO planning_cutoff_dispatches')).toHaveLength(0);
    });

    it('records a manual run with no occurrence', async () => {
        const { service, query } = build({ reads: [] });

        await service.capture(input({ manual: true, occurrence: null }));

        expect(statements(query, 'INSERT INTO planning_cutoffs')[0][1]).toEqual(['2026-10-14', NOW, 'America/La_Paz', 'manual', null]);
    });

    it('does not let a manual run keep an occurrence, which the database would refuse', async () => {
        const { service, query } = build({ reads: [] });

        await service.capture(input({ manual: true, occurrence: 'route-cutoff@x' }));

        expect(statements(query, 'INSERT INTO planning_cutoffs')[0][1]).toEqual(['2026-10-14', NOW, 'America/La_Paz', 'manual', null]);
    });

    it('records a run that arrives without occurrence as manual instead of failing the check', async () => {
        const { service, query } = build({ reads: [] });

        await service.capture(input({ manual: false, occurrence: null }));

        expect(statements(query, 'INSERT INTO planning_cutoffs')[0][1][3]).toBe('manual');
    });

    it('lets the error out when the transaction fails, so the cutoff does not run', async () => {
        const { service, dataSource } = build();
        dataSource.transaction.mockRejectedValueOnce(new Error('connection reset'));

        await expect(service.capture(input())).rejects.toThrow('connection reset');
    });
});
