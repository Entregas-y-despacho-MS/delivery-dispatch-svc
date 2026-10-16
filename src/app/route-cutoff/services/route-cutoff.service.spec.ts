import { describe, expect, it, vi } from 'vitest';
import { PlanningSettingsMissingException } from '../../planning/exceptions/index.js';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import { RAW_SETTINGS, vehicle, WAREHOUSE } from '../../planning/domain/plan-fixtures.helper-spec.js';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { batch, NOTIFIED_TODAY, SHIFT_DATE, stop } from '../domain/cutoff-fixtures.helper-spec.js';
import { RouteCutoffService } from './route-cutoff.service.js';

// 2026-10-13 is a Tuesday: its next operating day is Wednesday 2026-10-14 (SHIFT_DATE).
const TUESDAY_CUTOFF = localInstant('2026-10-13', '15:00');
const SATURDAY = localInstant('2026-10-17', '15:00');

function build(over: { settings?: Record<string, string>; batches?: ReturnType<typeof batch>[]; osrmFails?: boolean } = {}) {
    const raw = { ...RAW_SETTINGS, ...over.settings };
    const settings = { getString: vi.fn((key: string) => raw[key] ?? '') };
    const read = { batches: over.batches ?? [], skippedBatchIds: [] as number[] };
    const batches = {
        findProvisionalBatches: vi.fn(async () => read),
        findOccupiedVehicleIds: vi.fn(async () => []),
    };
    const candidates = {
        findVehicles: vi.fn(async () => [vehicle(1, 1000), vehicle(2, 1000)]),
        findWarehouses: vi.fn(async () => [WAREHOUSE]),
    };
    const osrm = {
        tableMaxCoordinates: 100,
        getDurationMatrix: vi.fn(async (coordinates: unknown[]) => {
            if (over.osrmFails) throw new OsrmUnavailableException();
            return { durations: coordinates.map((_, i) => coordinates.map((__, j) => (i === j ? 0 : 60))) };
        }),
    };
    const writer = {
        applyGroup: vi.fn(async (group: { key: string; plan: { batches: Array<{ routeBatchId: number | null }> } }) => ({
            key: group.key,
            status: 'applied' as const,
            batches: group.plan.batches.map((b) => ({
                routeBatchId: b.routeBatchId ?? 99, status: 'pending_final_review' as const, failures: [], warnings: [], vehicleId: 1, stops: 1,
            })),
            createdBatchIds: [], remnantBatchIds: [], cancelledBatchIds: [], releasedDispatchIds: [],
            remnantDispatchIds: [], staleReasons: [],
        })),
    };
    const alerts = { raise: vi.fn(async () => undefined) };
    const service = new RouteCutoffService(
        settings as any, batches as any, candidates as any, osrm as any, writer as any, alerts as any,
    );
    return { service, batches, osrm, writer, alerts };
}

const ctx = (startedAt: Date, trigger: 'schedule' | 'manual' = 'schedule') => ({ trigger, occurrence: 'route-cutoff@x', startedAt });

describe('RouteCutoffService', () => {
    it('blocks a scheduled run when a mandatory setting is empty, and writes nothing', async () => {
        const { service, batches, alerts } = build({ settings: { stop_service_minutes: '' } });

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(summary.status).toBe('blocked');
        expect(summary.missingKeys).toContain('stop_service_minutes');
        expect(batches.findProvisionalBatches).not.toHaveBeenCalled();
        expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.any(Object));
    });

    it('answers 422 to a manual run with a missing setting', async () => {
        const { service } = build({ settings: { planning_margin_pct: '' } });
        await expect(service.run(ctx(TUESDAY_CUTOFF, 'manual'))).rejects.toBeInstanceOf(PlanningSettingsMissingException);
    });

    it('does not run on a day that is not the previous operating day of the next route day', async () => {
        const { service, batches } = build();

        const summary = await service.run(ctx(SATURDAY));

        expect(summary.status).toBe('not_cutoff_day');
        expect(batches.findProvisionalBatches).not.toHaveBeenCalled();
    });

    it('lets a manual run work on the next operating day even on a weekend', async () => {
        const { service, batches } = build();

        const summary = await service.run(ctx(SATURDAY, 'manual'));

        // Saturday → Monday 2026-10-19.
        expect(batches.findProvisionalBatches).toHaveBeenCalledWith('2026-10-19');
        expect(summary.status).toBe('nothing_to_process');
    });

    it('reports nothing to process when no provisional batch is left', async () => {
        const { service, osrm } = build();

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(summary).toMatchObject({ status: 'nothing_to_process', shiftDate: SHIFT_DATE });
        expect(osrm.getDurationMatrix).not.toHaveBeenCalled();
    });

    it('asks OSRM before writing anything and writes nothing when it is down', async () => {
        const { service, writer } = build({ batches: [batch(1, [stop(1)])], osrmFails: true });

        await expect(service.run(ctx(TUESDAY_CUTOFF))).rejects.toBeInstanceOf(OsrmUnavailableException);
        expect(writer.applyGroup).not.toHaveBeenCalled();
    });

    it('writes one transaction per group and lists the batches that go to review', async () => {
        const a = batch(1, [stop(1)], { zoneId: 1 });
        const b = batch(2, [stop(2)], { zoneId: 2, zoneCode: 'ZON-2' });
        const { service, writer } = build({ batches: [a, b] });

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(writer.applyGroup).toHaveBeenCalledTimes(2);
        expect(summary.status).toBe('executed');
        expect(summary.pendingFinalReviewBatchIds.sort()).toEqual([1, 2]);
    });

    it('alerts the coordinator about a remnant and about a batch that failed validation', async () => {
        const a = batch(1, [stop(1), stop(2, { notifiedAt: NOTIFIED_TODAY, window: ['11:00', '13:00'] })]);
        const { service, writer, alerts } = build({ batches: [a] });
        writer.applyGroup.mockResolvedValueOnce({
            key: 'k', status: 'applied', createdBatchIds: [], cancelledBatchIds: [], releasedDispatchIds: [],
            remnantBatchIds: [7], remnantDispatchIds: [2], staleReasons: [],
            batches: [{ routeBatchId: 1, status: 'provisional', vehicleId: 1, stops: 1, warnings: [],
                failures: [{ code: 'capacity_exceeded', dispatchIds: [], detail: {} }] }],
        } as any);

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(summary.failedBatches).toEqual([{ routeBatchId: 1, reasons: ['capacity_exceeded'] }]);
        expect(summary.remnantBatchIds).toEqual([7]);
        const kinds = alerts.raise.mock.calls.map((call) => call[0]);
        expect(kinds).toEqual(expect.arrayContaining(['cutoff_batch_failed', 'cutoff_window_open']));
    });

    it('counts a stale group and keeps going with the others', async () => {
        const a = batch(1, [stop(1)], { zoneId: 1 });
        const b = batch(2, [stop(2)], { zoneId: 2, zoneCode: 'ZON-2' });
        const { service, writer } = build({ batches: [a, b] });
        writer.applyGroup.mockResolvedValueOnce({
            key: 'k', status: 'stale', batches: [], createdBatchIds: [], remnantBatchIds: [], cancelledBatchIds: [],
            releasedDispatchIds: [], remnantDispatchIds: [],
            staleReasons: [{ code: 'dispatch_version_changed', dispatchIds: [1], detail: {} }],
        } as any);

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(summary.staleGroups).toBe(1);
        expect(summary.pendingFinalReviewBatchIds).toEqual([2]);
    });

    it('records a failed run when a group cannot be written, after trying the others', async () => {
        const a = batch(1, [stop(1)], { zoneId: 1 });
        const b = batch(2, [stop(2)], { zoneId: 2, zoneCode: 'ZON-2' });
        const { service, writer } = build({ batches: [a, b] });
        writer.applyGroup.mockRejectedValueOnce(new Error('lock timeout'));

        await expect(service.run(ctx(TUESDAY_CUTOFF))).rejects.toThrow(/1 group\(s\) could not be written/);
        expect(writer.applyGroup).toHaveBeenCalledTimes(2);
    });

    it('tries a group again when Postgres chose it as the victim of a deadlock', async () => {
        const { service, writer } = build({ batches: [batch(1, [stop(1)])] });
        const deadlock = Object.assign(new Error('deadlock detected'), { driverError: { code: '40P01' } });
        writer.applyGroup.mockRejectedValueOnce(deadlock);

        const summary = await service.run(ctx(TUESDAY_CUTOFF));

        expect(writer.applyGroup).toHaveBeenCalledTimes(2);
        expect(summary.pendingFinalReviewBatchIds).toEqual([1]);
    });

    it('gives up after three deadlocks and records a failed run', async () => {
        const { service, writer } = build({ batches: [batch(1, [stop(1)])] });
        const deadlock = Object.assign(new Error('deadlock detected'), { driverError: { code: '40P01' } });
        writer.applyGroup.mockRejectedValue(deadlock);

        await expect(service.run(ctx(TUESDAY_CUTOFF))).rejects.toThrow(/1 group\(s\) could not be written/);
        expect(writer.applyGroup).toHaveBeenCalledTimes(3);
    });

    it('does not retry an error that is not a deadlock', async () => {
        const { service, writer } = build({ batches: [batch(1, [stop(1)])] });
        writer.applyGroup.mockRejectedValue(new Error('connection reset'));

        await expect(service.run(ctx(TUESDAY_CUTOFF))).rejects.toThrow();
        expect(writer.applyGroup).toHaveBeenCalledTimes(1);
    });
});
