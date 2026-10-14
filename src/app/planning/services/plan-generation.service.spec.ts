import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { PlanningSettingsMissingException } from '../exceptions/index.js';
import { RAW_SETTINGS, MONDAY_ORDER, MONDAY_RUN, dispatch, FakeOsrm, vehicle, WAREHOUSE } from '../domain/plan-fixtures.helper-spec.js';
import { InsertionLotPlanner } from './insertion-lot-planner.js';
import { PlanGenerationService } from './plan-generation.service.js';

const manual = { trigger: 'manual' as const, occurrence: null, startedAt: new Date() };
const scheduled = { trigger: 'schedule' as const, occurrence: 'plan-generation@2026-10-12T08:30', startedAt: new Date() };

function build(options: { raw?: Record<string, string>; osrm?: FakeOsrm; dispatches?: any[]; known?: boolean } = {}) {
    const raw = { ...RAW_SETTINGS, ...options.raw };
    const settings = { getString: vi.fn(async (key: string, fallback: string) => raw[key] ?? fallback) };
    const candidates = {
        findCandidates: vi.fn(async () => options.dispatches ?? []),
        findVehicles: vi.fn(async () => [vehicle(1, 1000), vehicle(2, 1000)]),
        findDriverIds: vi.fn(async () => [10, 11]),
        findWarehouses: vi.fn(async () => [WAREHOUSE]),
        findExistingBatches: vi.fn(async () => []),
        findOpenBatches: vi.fn(async () => []),
    };
    const writer = {
        writeNewBatch: vi.fn(async (batch: any) => ({
            routeBatchId: 900, vehicleId: batch.vehicleId, plannedDispatchIds: batch.stops.map((s: any) => s.dispatchId), skippedDispatchIds: [],
        })),
        writeInsertion: vi.fn(),
    };
    const alerts = { raise: vi.fn(async () => undefined) };
    const dataSource = {
        query: vi.fn(async (sql: string) => (sql.includes('SELECT 1') ? (options.known ? [{ '?column?': 1 }] : []) : [])),
    };
    const planner = new InsertionLotPlanner(options.osrm ?? new FakeOsrm());
    const service = new PlanGenerationService(
        settings as any, candidates as any, planner, writer as any, alerts as any, dataSource as any,
    );
    return { service, writer, alerts, dataSource, candidates };
}

describe('PlanGenerationService', () => {
    // The service reads the clock: it runs on Monday 08:30 (La Paz), like the simulated week.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(MONDAY_RUN);
    });
    afterEach(() => vi.useRealTimers());

    describe('blocked by missing settings', () => {
        it('a manual run answers 422 with the missing keys, alerts and writes nothing', async () => {
            const { service, writer, alerts, candidates } = build({ raw: { stop_service_minutes: '', planning_margin_pct: '' } });

            const error = await service.run(manual).catch((e) => e);

            expect(error).toBeInstanceOf(PlanningSettingsMissingException);
            expect(error.getResponse()).toMatchObject({
                error: 'PLANNING_SETTINGS_MISSING',
                details: { missingKeys: ['stop_service_minutes', 'planning_margin_pct'] },
            });
            expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.objectContaining({
                missingKeys: ['stop_service_minutes', 'planning_margin_pct'],
            }));
            expect(candidates.findCandidates).not.toHaveBeenCalled();
            expect(writer.writeNewBatch).not.toHaveBeenCalled();
        });

        it('a scheduled run ends without error as blocked, so it is not retried every minute', async () => {
            const { service, alerts } = build({ raw: { planning_margin_pct: '' } });

            const summary = await service.run(scheduled);

            expect(summary).toMatchObject({ status: 'blocked', missingKeys: ['planning_margin_pct'], createdBatchIds: [] });
            expect(alerts.raise).toHaveBeenCalledWith('settings_missing', expect.anything());
        });

        it('plan_min_orders_per_route high only warns: the batch is still created', async () => {
            const { service, writer, alerts } = build({
                raw: { plan_min_orders_per_route: '50' },
                dispatches: [dispatch(1), dispatch(2)],
            });

            const summary = await service.run(manual);

            expect(summary.status).toBe('executed');
            expect(writer.writeNewBatch).toHaveBeenCalledOnce();
            expect(alerts.raise).toHaveBeenCalledWith('below_min_orders', expect.objectContaining({ stops: 2, minimum: 50 }));
        });
    });

    describe('OSRM down', () => {
        it('alerts, rethrows the 503 and writes nothing', async () => {
            const osrm = new FakeOsrm();
            osrm.failWith = new OsrmUnavailableException(5000);
            const { service, writer, alerts } = build({ osrm, dispatches: [dispatch(1)] });

            await expect(service.run(manual)).rejects.toBeInstanceOf(OsrmUnavailableException);

            expect(alerts.raise).toHaveBeenCalledWith('osrm_unavailable', expect.anything());
            expect(writer.writeNewBatch).not.toHaveBeenCalled();
        });
    });

    describe('a valid run', () => {
        it('writes the batches and summarizes them', async () => {
            const { service, writer } = build({ dispatches: [dispatch(1), dispatch(2), dispatch(3)] });

            const summary = await service.run(manual);

            expect(writer.writeNewBatch).toHaveBeenCalledOnce();
            expect(writer.writeNewBatch.mock.calls[0][1]).toEqual({ trigger: 'manual', occurrence: null });
            expect(summary).toMatchObject({
                status: 'executed', createdBatchIds: [900], updatedBatchIds: [], plannedDispatchIds: [1, 2, 3], missingKeys: [],
            });
        });

        it('passes the scheduled occurrence to the writer', async () => {
            const { service, writer } = build({ dispatches: [dispatch(1)] });

            await service.run(scheduled);

            expect(writer.writeNewBatch.mock.calls[0][1]).toEqual({ trigger: 'scheduled', occurrence: 'plan-generation@2026-10-12T08:30' });
        });

        it('keeps going when one batch fails to be written', async () => {
            const { service, writer } = build({ dispatches: [dispatch(1), dispatch(2, { zoneId: 2 })] });
            writer.writeNewBatch.mockRejectedValueOnce(new Error('vehicle taken'));

            const summary = await service.run(manual);

            expect(writer.writeNewBatch).toHaveBeenCalledTimes(2);
            expect(summary.createdBatchIds).toEqual([900]);
        });

        it('does nothing and asks OSRM nothing when there are no orders', async () => {
            const osrm = new FakeOsrm();
            const { service, writer } = build({ osrm });

            const summary = await service.run(manual);

            expect(summary.plannedDispatchIds).toEqual([]);
            expect(osrm.calls).toEqual([]);
            expect(writer.writeNewBatch).not.toHaveBeenCalled();
        });
    });

    describe('exceptions', () => {
        // Run is "now" in the service, so an order confirmed long ago has no viable date left.
        const stale = () => dispatch(7, { orderConfirmedAt: new Date(MONDAY_ORDER.getTime() - 30 * 86_400_000) });

        it('records a dispatch event and alerts once for an order past D3, never promising D4', async () => {
            const { service, dataSource, alerts } = build({ dispatches: [stale()] });

            const summary = await service.run(manual);

            expect(summary.exceptions).toEqual([
                expect.objectContaining({ kind: 'deadline_exceeded', detail: expect.objectContaining({ dispatchId: 7, motivo: 'no_viable_date' }) }),
            ]);
            const insert = dataSource.query.mock.calls.find(([sql]: [string]) => sql.includes('INSERT INTO dispatch_events'));
            expect(insert[1][2]).toBe('promise_deadline_exceeded');
            expect(alerts.raise).toHaveBeenCalledWith('deadline_exceeded', expect.objectContaining({ dispatchId: 7 }));
        });

        it('does not raise it again on the next run, but still lists it in the summary', async () => {
            const { service, dataSource, alerts } = build({ dispatches: [stale()], known: true });

            const summary = await service.run(manual);

            expect(summary.exceptions).toHaveLength(1);
            expect(alerts.raise).not.toHaveBeenCalledWith('deadline_exceeded', expect.anything());
            expect(dataSource.query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO dispatch_events'))).toBe(false);
        });
    });
});
