import { describe, expect, it, vi } from 'vitest';
import { PlanningSnapshotsService } from './planning-snapshots.service.js';
import type { BaselineStopRow, CutoffRow, StartedManifestRow, UniverseRow } from '../repositories/planning-snapshots.repository.js';

const cutoff = (id: number, at: string, over: Partial<CutoffRow> = {}): CutoffRow => ({
    id,
    shiftDate: '2026-10-14',
    cutoffAt: new Date(at),
    operatingTimezone: 'America/La_Paz',
    triggerType: 'scheduled',
    occurrence: `route-cutoff@${id}`,
    eligible: 3,
    excluded: 2,
    ...over,
});
const eligible = (dispatchId: number, confirmed = false): UniverseRow => ({ dispatchId, universeStatus: 'eligible', exclusionCode: null, exclusionDetail: null, routeBatchId: 50, confirmed });
const excluded = (dispatchId: number, code: string, detail: string | null): UniverseRow => ({ dispatchId, universeStatus: 'excluded', exclusionCode: code, exclusionDetail: detail, routeBatchId: 50, confirmed: false });
const manifest = (routeBatchId: number, over: Partial<StartedManifestRow> = {}): StartedManifestRow => ({
    manifestId: routeBatchId * 10,
    routeBatchId,
    manifestVersion: 2,
    routeVersion: 6,
    startedAt: new Date('2026-10-14T12:00:00Z'),
    vehicle: { id: 1, name: 'ABC-123' },
    driver: { id: 4, name: 'Ana' },
    zone: { id: 1, name: 'Centro' },
    warehouse: { id: 1, name: 'Central' },
    ...over,
});
const baseline = (routeBatchId: number, dispatchId: number, currentStatus: string, over: Partial<BaselineStopRow> = {}): BaselineStopRow => ({
    routeBatchId,
    dispatchId,
    dispatchType: 'delivery',
    currentStatus,
    sequenceOrder: dispatchId,
    startedState: 'departing',
    ...over,
});

function build(setup: {
    cutoffs?: CutoffRow[];
    byId?: CutoffRow | null;
    universe?: UniverseRow[];
    outside?: number;
    manifests?: StartedManifestRow[];
    stops?: BaselineStopRow[];
    unknown?: number[];
} = {}) {
    const repository = {
        findCutoffsOfDay: vi.fn(async () => setup.cutoffs ?? []),
        findCutoff: vi.fn(async () => setup.byId ?? null),
        findUniverse: vi.fn(async () => setup.universe ?? []),
        countConfirmedOutsideUniverse: vi.fn(async () => setup.outside ?? 0),
        findStartedManifests: vi.fn(async () => setup.manifests ?? []),
        findBaselineStops: vi.fn(async () => setup.stops ?? []),
        findRoutesWithoutBaseline: vi.fn(async () => setup.unknown ?? []),
    };
    return { service: new PlanningSnapshotsService(repository as never), repository };
}

describe('PlanningSnapshotsService.listCutoffs', () => {
    it('marks the first scheduled cutoff as the official one, whatever the order of the read', async () => {
        const { service } = build({ cutoffs: [cutoff(1, '2026-10-13T10:00:00Z', { triggerType: 'manual', occurrence: null }), cutoff(2, '2026-10-13T19:00:00Z'), cutoff(3, '2026-10-13T21:00:00Z')] });

        const result = await service.listCutoffs({ date: '2026-10-14' });

        expect(result.date).toBe('2026-10-14');
        expect(result.data.map((item) => [item.id, item.official])).toEqual([[1, false], [2, true], [3, false]]);
        expect(result.data[1]).toMatchObject({ cutoffAt: '2026-10-13T19:00:00.000Z', operatingTimezone: 'America/La_Paz', eligible: 3, excluded: 2 });
    });

    it('answers an empty list when the day has no snapshot', async () => {
        const { service } = build();
        expect((await service.listCutoffs({ date: '2026-10-14' })).data).toEqual([]);
    });
});

describe('PlanningSnapshotsService.getCoverage', () => {
    it('is not available without any snapshot, and reads nothing else', async () => {
        const { service, repository } = build();

        const result = await service.getCoverage({ date: '2026-10-14' });

        expect(result).toEqual({ date: '2026-10-14', available: false, reason: 'NO_SNAPSHOT', cutoff: null, coverage: null, excluded: null });
        expect(repository.findUniverse).not.toHaveBeenCalled();
    });

    it('is not available when the day has only manual runs and no cutoff was asked for', async () => {
        const { service } = build({ cutoffs: [cutoff(1, '2026-10-13T19:00:00Z', { triggerType: 'manual', occurrence: null })] });
        expect(await service.getCoverage({ date: '2026-10-14' })).toMatchObject({ available: false, reason: 'NO_OFFICIAL_SNAPSHOT' });
    });

    it('computes confirmed over the eligible ones of the official cutoff, with every exclusion explained', async () => {
        const { service, repository } = build({
            cutoffs: [cutoff(2, '2026-10-13T19:00:00Z'), cutoff(3, '2026-10-13T21:00:00Z')],
            universe: [
                eligible(1, true),
                eligible(2, true),
                eligible(3),
                excluded(4, 'cutoff_window_open', 'The customer can still answer'),
                excluded(5, 'cutoff_no_promise', null),
            ],
            outside: 2,
        });

        const result = await service.getCoverage({ date: '2026-10-14', zoneId: 1, shift: 'morning' });

        expect(repository.findUniverse).toHaveBeenCalledWith(2, { zoneId: 1, warehouseId: undefined, shift: 'morning' });
        expect(result).toMatchObject({ available: true, reason: null, cutoff: { id: 2, official: true } });
        expect(result.coverage).toEqual({ eligible: 3, confirmed: 2, pending: 1, coveragePct: 66.67, confirmedOutsideUniverse: 2 });
        expect(result.excluded?.total).toBe(2);
        expect(result.excluded?.byCode.map((item) => [item.code, item.count])).toEqual([['cutoff_no_promise', 1], ['cutoff_window_open', 1]]);
        expect(result.excluded?.byCode.every((item) => item.explanation.length > 0)).toBe(true);
        expect(result.excluded?.data).toEqual([
            { dispatchId: 4, code: 'cutoff_window_open', detail: 'The customer can still answer', routeBatchId: 50, detailPath: '/dispatches/4/detail' },
            expect.objectContaining({ dispatchId: 5, code: 'cutoff_no_promise', detailPath: '/dispatches/5/detail', detail: expect.stringContaining('never approved') }),
        ]);
    });

    it('reads the cutoff that was asked for, and marks whether it is the official one', async () => {
        const second = cutoff(3, '2026-10-13T21:00:00Z');
        const { service, repository } = build({ byId: second, cutoffs: [cutoff(2, '2026-10-13T19:00:00Z'), second], universe: [eligible(1)] });

        const result = await service.getCoverage({ cutoffId: 3 });

        expect(repository.findUniverse).toHaveBeenCalledWith(3, expect.any(Object));
        expect(result.cutoff).toMatchObject({ id: 3, official: false, shiftDate: '2026-10-14' });
        expect(result.date).toBe('2026-10-14');
    });

    it('is not available for a cutoff that does not exist', async () => {
        const { service } = build({ byId: null });
        expect(await service.getCoverage({ date: '2026-10-14', cutoffId: 999 })).toMatchObject({ available: false, reason: 'NO_SNAPSHOT' });
    });

    it('has no percentage when nothing was eligible', async () => {
        const { service } = build({ cutoffs: [cutoff(2, '2026-10-13T19:00:00Z')], universe: [excluded(1, 'cutoff_no_promise', 'x')] });
        const result = await service.getCoverage({ date: '2026-10-14' });
        expect(result.coverage).toMatchObject({ eligible: 0, confirmed: 0, coveragePct: null });
    });

    it('keeps the code itself as the explanation of a code the catalog no longer knows', async () => {
        const { service } = build({ cutoffs: [cutoff(2, '2026-10-13T19:00:00Z')], universe: [excluded(1, 'old_rule', 'An old explanation')] });
        const result = await service.getCoverage({ date: '2026-10-14' });
        expect(result.excluded?.byCode[0]).toMatchObject({ code: 'old_rule', explanation: 'old_rule' });
        expect(result.excluded?.data[0].detail).toBe('An old explanation');
    });
});

describe('PlanningSnapshotsService.getRouteCompletion', () => {
    it('reports every route with its stops by result, apart, and a total weighted by stops', async () => {
        const { service } = build({
            manifests: [manifest(50), manifest(60)],
            stops: [
                baseline(50, 1, 'delivered'),
                baseline(50, 2, 'not_delivered'),
                baseline(50, 3, 'out_for_delivery'),
                baseline(50, 4, 'cancelled', { startedState: null }),
                baseline(60, 5, 'delivered'),
            ],
            unknown: [70],
        });

        const result = await service.getRouteCompletion({ date: '2026-10-14' });

        expect(result.summary).toMatchObject({ routesWithBaseline: 2, routesUnknown: 1, departed: 4, finalized: 3, finalizedPct: 75 });
        expect(result.summary.counts).toEqual({ delivered: 2, pickupCompleted: 0, unsuccessful: 1, pending: 1, excludedAtStart: 0, cancelledBeforeStart: 1, removedBeforeStart: 0 });
        expect(result.data.map((route) => [route.routeBatchId, route.finalizedPct])).toEqual([[50, 66.67], [60, 100]]);
        // Weighted by stops: (2 + 1) / (3 + 1) = 75, not the average of 66.67 and 100.
        expect(result.summary.finalizedPct).toBe(75);
        expect(result.data[0].stops.map((stop) => [stop.dispatchId, stop.outcome])).toEqual([[1, 'delivered'], [2, 'unsuccessful'], [3, 'pending'], [4, 'cancelled_before_start']]);
        expect(result.data[0].stops[0].detailPath).toBe('/dispatches/1/detail');
        expect(result.unknownRouteBatchIds).toEqual([70]);
    });

    it('passes the vehicle, driver, zone and warehouse of the start and its dates', async () => {
        const { service } = build({ manifests: [manifest(50)], stops: [baseline(50, 1, 'delivered')] });
        const [route] = (await service.getRouteCompletion({ date: '2026-10-14' })).data;
        expect(route).toMatchObject({
            routeBatchId: 50, manifestVersion: 2, routeVersion: 6, startedAt: '2026-10-14T12:00:00.000Z',
            vehicle: { id: 1, name: 'ABC-123' }, driver: { id: 4, name: 'Ana' }, zone: { id: 1, name: 'Centro' }, warehouse: { id: 1, name: 'Central' },
        });
    });

    it('has no routes and no percentage when no route started that day', async () => {
        const { service } = build({ unknown: [8, 9] });

        const result = await service.getRouteCompletion({ date: '2026-10-14' });

        expect(result.data).toEqual([]);
        expect(result.summary).toMatchObject({ routesWithBaseline: 0, routesUnknown: 2, departed: 0, finalized: 0, finalizedPct: null });
        expect(result.unknownRouteBatchIds).toEqual([8, 9]);
    });

    it('leaves out a route with no stop of the chosen shift, and passes the filters down', async () => {
        const { service, repository } = build({ manifests: [manifest(50), manifest(60)], stops: [baseline(50, 1, 'delivered')] });

        const result = await service.getRouteCompletion({ date: '2026-10-14', zoneId: 1, warehouseId: 2, shift: 'afternoon' });

        expect(result.data.map((route) => route.routeBatchId)).toEqual([50]);
        expect(repository.findStartedManifests).toHaveBeenCalledWith('2026-10-14', { zoneId: 1, warehouseId: 2, shift: 'afternoon' });
        expect(repository.findBaselineStops).toHaveBeenCalledWith([50, 60], 'afternoon');
        expect(repository.findRoutesWithoutBaseline).toHaveBeenCalledWith('2026-10-14', { zoneId: 1, warehouseId: 2, shift: 'afternoon' });
    });

    it('gives the same baseline while the route advances: only the results move', async () => {
        const before = await build({ manifests: [manifest(50)], stops: [baseline(50, 1, 'out_for_delivery'), baseline(50, 2, 'out_for_delivery')] }).service.getRouteCompletion({ date: '2026-10-14' });
        const after = await build({ manifests: [manifest(50)], stops: [baseline(50, 1, 'delivered'), baseline(50, 2, 'out_for_delivery')] }).service.getRouteCompletion({ date: '2026-10-14' });

        expect(after.summary.departed).toBe(before.summary.departed);
        expect(before.summary.finalized).toBe(0);
        expect(after.summary.finalized).toBe(1);
    });
});
