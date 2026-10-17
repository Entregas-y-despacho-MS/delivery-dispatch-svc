import { describe, expect, it, vi } from 'vitest';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { RAW_SETTINGS, vehicle, WAREHOUSE } from '../../planning/domain/plan-fixtures.helper-spec.js';
import { PlanningSettingsMissingException } from '../../planning/exceptions/index.js';
import { batch, SHIFT_DATE, stop } from '../domain/cutoff-fixtures.helper-spec.js';
import { BatchRevalidationService } from './batch-revalidation.service.js';
import type { SingleBatchRead } from './cutoff-batches.repository.js';
import { CutoffMatricesService } from './cutoff-matrices.service.js';

/** A stop with registered packages, which the validation requires. */
function packed(id: number) {
    const base = stop(id);
    return {
        ...base,
        dispatch: { ...base.dispatch, packages: [{ dispatchId: id, packageId: id, lengthCm: 20, widthCm: 20, heightCm: 20, grossWeightKg: 10 }] },
    };
}

function read(over: Partial<SingleBatchRead> = {}): SingleBatchRead {
    return {
        batch: batch(12, [packed(1), packed(2)], { vehicleId: 1, proposedDriverId: 50 }),
        incompleteDispatchIds: [],
        hasWarehouse: true,
        ...over,
    };
}

function build(over: { settings?: Record<string, string>; read?: SingleBatchRead | null; osrmFails?: boolean } = {}) {
    const raw = { ...RAW_SETTINGS, ...over.settings };
    const settings = { getString: vi.fn((key: string) => raw[key] ?? '') };
    const batches = { findBatch: vi.fn(async () => (over.read === undefined ? read() : over.read)) };
    const candidates = {
        findVehicles: vi.fn(async () => [vehicle(1, 1000), vehicle(2, 1000)]),
        findWarehouses: vi.fn(async () => [WAREHOUSE]),
    };
    const osrm = {
        getDurationMatrix: vi.fn(async (coordinates: unknown[]) => {
            if (over.osrmFails) throw new OsrmUnavailableException();
            return { durations: coordinates.map((_, i) => coordinates.map((__, j) => (i === j ? 0 : 60))) };
        }),
    };
    const service = new BatchRevalidationService(settings as any, batches as any, candidates as any, new CutoffMatricesService(osrm as any));
    return { service, batches, candidates, osrm };
}

/** Rows the locked read of dispatches returns, and the answers of the vehicle and driver queries. */
function managerFor(over: { dispatches?: unknown[]; vehicleConflict?: number | null; driverActive?: boolean; driverConflict?: number | null } = {}) {
    const dispatches = over.dispatches ?? [1, 2].map((id) => ({ dispatch_id: id, status: 'scheduled', version: 1, route_batch_id: 12, has_destination: true }));
    const query = vi.fn(async (sql: string) => {
        if (sql.includes('FROM dispatches d')) return dispatches;
        if (sql.includes('WHERE vehicle_id = $1')) return over.vehicleConflict == null ? [] : [{ route_batch_id: over.vehicleConflict }];
        if (sql.includes('FROM users u')) return over.driverActive === false ? [] : [{ user_id: 50 }];
        if (sql.includes('driver_id = $1')) return over.driverConflict == null ? [] : [{ route_batch_id: over.driverConflict }];
        return [];
    });
    return { query } as any;
}

const state = { version: 4, vehicleId: 1, proposedDriverId: 50 };
const codes = (outcome: Awaited<ReturnType<BatchRevalidationService['evaluate']>>) =>
    outcome.kind === 'evaluated' ? outcome.validation.failures.map((failure) => failure.code) : ['stale'];

describe('BatchRevalidationService.prepare', () => {
    it('fails like the cutoff when a mandatory setting is empty, before reading the batch', async () => {
        const { service, batches } = build({ settings: { stop_service_minutes: '' } });
        await expect(service.prepare(12)).rejects.toBeInstanceOf(PlanningSettingsMissingException);
        expect(batches.findBatch).not.toHaveBeenCalled();
    });

    it.each([
        ['a batch without dispatches', { read: null }, 'no_dispatches'],
        ['a batch without origin warehouse', { read: read({ hasWarehouse: false }) }, 'no_warehouse'],
        ['a batch with a stop that has no sequence or no point on the map', { read: read({ incompleteDispatchIds: [2] }) }, 'stops_incomplete'],
    ])('cannot simulate %s, and does not call OSRM', async (_name, over, reason) => {
        const { service, osrm } = build(over);
        const prepared = await service.prepare(12);
        expect(prepared.unvalidatable).toBe(reason);
        expect(osrm.getDurationMatrix).not.toHaveBeenCalled();
    });

    it('asks OSRM once for the batch and builds the simulation parameters', async () => {
        const { service, osrm } = build();
        const prepared = await service.prepare(12);
        expect(prepared.unvalidatable).toBeNull();
        expect(prepared.params).not.toBeNull();
        expect(prepared.fleet.map((v) => v.vehicleId)).toEqual([1, 2]);
        expect(osrm.getDurationMatrix).toHaveBeenCalledTimes(1);
    });

    it('lets the OSRM failure through, so the caller answers 503 before locking anything', async () => {
        const { service } = build({ osrmFails: true });
        await expect(service.prepare(12)).rejects.toBeInstanceOf(OsrmUnavailableException);
    });
});

describe('BatchRevalidationService.evaluate', () => {
    it('passes a viable batch with the same rules the cutoff applies', async () => {
        const { service } = build();
        const outcome = await service.evaluate(managerFor(), await service.prepare(12), state);
        expect(outcome).toMatchObject({ kind: 'evaluated', validation: { passed: true, failures: [] } });
    });

    it('validates the assignment the correction leaves in the batch, not the one it was read with', async () => {
        const { service } = build();
        const prepared = await service.prepare(12);
        const inactiveVehicle = await service.evaluate(managerFor(), prepared, { ...state, vehicleId: 99 });
        expect(codes(inactiveVehicle)).toContain('vehicle_inactive');
        const busyDriver = await service.evaluate(managerFor({ driverConflict: 77 }), prepared, state);
        expect(codes(busyDriver)).toEqual(['driver_conflict']);
        const goneDriver = await service.evaluate(managerFor({ driverActive: false }), prepared, state);
        expect(codes(goneDriver)).toEqual(['driver_inactive']);
    });

    it('treats a missing driver as a warning, not a failure (D-21)', async () => {
        const { service } = build();
        const outcome = await service.evaluate(managerFor(), await service.prepare(12), { ...state, proposedDriverId: null });
        expect(outcome).toMatchObject({ kind: 'evaluated', validation: { passed: true, warnings: [{ code: 'driver_missing' }] } });
    });

    it('reports every content failure at once and keeps them as a validation, not as stale', async () => {
        const { service } = build();
        const dispatches = [
            { dispatch_id: 1, status: 'scheduled', version: 1, route_batch_id: 12, has_destination: false },
            { dispatch_id: 2, status: 'cancelled', version: 1, route_batch_id: 12, has_destination: true },
        ];
        const outcome = await service.evaluate(managerFor({ dispatches, vehicleConflict: 8 }), await service.prepare(12), state);
        expect(codes(outcome)).toEqual(expect.arrayContaining(['destination_incomplete', 'dispatch_status_changed', 'vehicle_conflict']));
        expect(outcome.kind).toBe('evaluated');
    });

    it('answers stale, without validating, when the batch version moved after it was read', async () => {
        const { service } = build();
        const manager = managerFor();
        const outcome = await service.evaluate(manager, await service.prepare(12), { ...state, version: 5 });
        expect(outcome).toMatchObject({ kind: 'stale', issues: [{ code: 'batch_version_changed' }] });
        expect(manager.query).toHaveBeenCalledTimes(1);
    });

    it('answers stale when an order was added to the batch, or one changed version, after the read', async () => {
        const { service } = build();
        const prepared = await service.prepare(12);
        const added = [1, 2, 3].map((id) => ({ dispatch_id: id, status: 'scheduled', version: 1, route_batch_id: 12, has_destination: true }));
        expect(await service.evaluate(managerFor({ dispatches: added }), prepared, state))
            .toMatchObject({ kind: 'stale', issues: [{ code: 'dispatch_version_changed', dispatchIds: [3] }] });
        const bumped = [1, 2].map((id) => ({ dispatch_id: id, status: 'scheduled', version: id === 2 ? 2 : 1, route_batch_id: 12, has_destination: true }));
        expect(await service.evaluate(managerFor({ dispatches: bumped }), prepared, state))
            .toMatchObject({ kind: 'stale', issues: [{ code: 'dispatch_version_changed', dispatchIds: [2] }] });
    });

    it('fails a batch that cannot be simulated with batch_not_validatable and reads nothing', async () => {
        const { service } = build({ read: read({ incompleteDispatchIds: [2] }) });
        const manager = managerFor();
        const outcome = await service.evaluate(manager, await service.prepare(12), state);
        expect(outcome).toMatchObject({
            kind: 'evaluated',
            validation: { passed: false, failures: [{ code: 'batch_not_validatable', dispatchIds: [2], detail: { reason: 'stops_incomplete' } }] },
        });
        expect(manager.query).not.toHaveBeenCalled();
    });

    it('uses the date of the batch to look for the resources of that day', async () => {
        const { service } = build();
        const manager = managerFor();
        await service.evaluate(manager, await service.prepare(12), state);
        const vehicleCall = manager.query.mock.calls.find(([sql]: [string]) => sql.includes('WHERE vehicle_id = $1'));
        expect(vehicleCall[1]).toEqual([1, SHIFT_DATE, [12]]);
    });
});
