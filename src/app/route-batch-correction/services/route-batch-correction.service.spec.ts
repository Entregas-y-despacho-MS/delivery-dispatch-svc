import { QueryFailedError } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { RouteBatchApprovalConflictException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-approval-conflict.exception.js';
import { RouteBatchNotCorrectableException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-correctable.exception.js';
import { RouteBatchNotFoundException } from '../../../modules/dispatch/route-batches/exceptions/route-batch-not-found.exception.js';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import type { CutoffValidation } from '../../route-cutoff/domain/cutoff-validation.js';
import { RouteBatchCorrectionService } from './route-batch-correction.service.js';

const PASSED: CutoffValidation = { passed: true, failures: [], warnings: [], capacity: null };
const FAILED: CutoffValidation = {
    passed: false,
    failures: [{ code: 'slot_not_met', dispatchIds: [77], detail: {} }, { code: 'packages_missing', dispatchIds: [78], detail: {} }],
    warnings: [],
    capacity: null,
};

function build(over: {
    status?: string;
    version?: number;
    statusAtLock?: string;
    vehicleId?: number | null;
    driverId?: number | null;
    outcome?: { kind: 'evaluated'; validation: CutoffValidation } | { kind: 'stale'; issues: Array<{ code: string }> };
    prepareFails?: boolean;
    gateFails?: 'driver' | 'vehicle-active' | 'vehicle-resources' | 'capacity';
    missing?: boolean;
    updateRows?: Array<{ version: number }>;
} = {}) {
    const status = over.status ?? 'pending_final_review';
    const batch = {
        id: 12,
        version: over.version ?? 4,
        status: over.statusAtLock ?? status,
        shift_date: '2026-10-20',
        vehicle_id: over.vehicleId === undefined ? 56 : over.vehicleId,
        proposed_driver_id: over.driverId === undefined ? 34 : over.driverId,
    };
    const order: string[] = [];
    const manager = {
        query: vi.fn(async (sql: string) => {
            if (sql.includes('FOR UPDATE')) { order.push('lock'); return over.missing ? [] : [batch]; }
            if (sql.includes('UPDATE route_batches')) {
                order.push('update');
                const rows = over.updateRows ?? [{ version: batch.version + 1 }];
                return [rows, rows.length]; // the shape TypeORM gives an UPDATE ... RETURNING
            }
            if (sql.includes('INSERT INTO route_batch_events')) { order.push('event'); return []; }
            return [];
        }),
    };
    const dataSource = {
        query: vi.fn(async () => (over.missing ? [] : [{ status, vehicle_id: batch.vehicle_id, proposed_driver_id: batch.proposed_driver_id }])),
        transaction: vi.fn(async (callback: (m: unknown) => unknown) => {
            order.push('transaction');
            return await callback(manager);
        }),
    };
    const report = { assignable: true, weight: { actual: 10, capacity: 100 } };
    const capacity = {
        assertAssignable: vi.fn(async () => {
            if (over.gateFails === 'capacity') throw new Error('ROUTE_CAPACITY_EXCEEDED');
            return report;
        }),
    };
    const resources = {
        assertVehicleActive: vi.fn(async () => { if (over.gateFails === 'vehicle-active') throw new Error('VEHICLE_NOT_ACTIVE'); }),
        assertResourcesAvailable: vi.fn(async () => { if (over.gateFails === 'vehicle-resources') throw new Error('RESOURCE_CONFLICT'); }),
        assertDriverAvailable: vi.fn(async () => { if (over.gateFails === 'driver') throw new Error('DRIVER_NOT_AVAILABLE'); }),
    };
    const prepared = { routeBatchId: 12 };
    const revalidation = {
        prepare: vi.fn(async () => {
            order.push('prepare');
            if (over.prepareFails) throw new OsrmUnavailableException();
            return prepared;
        }),
        evaluate: vi.fn(async () => {
            order.push('evaluate');
            return over.outcome ?? { kind: 'evaluated', validation: PASSED };
        }),
    };
    const service = new RouteBatchCorrectionService(dataSource as any, capacity as any, resources as any, revalidation as any);
    const events = () => manager.query.mock.calls
        .filter(([sql]) => (sql as string).includes('INSERT INTO route_batch_events'))
        .map(([, params]) => ({ type: (params as unknown[])[1], actor: (params as unknown[])[2], actorType: (params as unknown[])[3], reason: (params as unknown[])[4], metadata: JSON.parse((params as unknown[])[5] as string) }));
    const updates = () => manager.query.mock.calls.filter(([sql]) => (sql as string).includes('UPDATE route_batches'));
    return { service, manager, dataSource, capacity, resources, revalidation, prepared, order, events, updates };
}

const catchError = async (call: Promise<unknown>) => await call.then(() => null, (error: unknown) => error);

describe('RouteBatchCorrectionService — driver', () => {
    it('assigns a driver to a provisional batch that had none: version +1, one event, no revalidation', async () => {
        const h = build({ status: 'provisional', driverId: null });

        const result = await h.service.changeDriver(12, 50, 4, 9);

        expect(result).toMatchObject({ routeBatchId: 12, version: 5, status: 'provisional', proposedDriverId: 50, vehicleId: 56, changed: true, capacity: null, validation: null });
        expect(h.revalidation.prepare).not.toHaveBeenCalled();
        expect(h.revalidation.evaluate).not.toHaveBeenCalled();
        expect(h.resources.assertDriverAvailable).toHaveBeenCalledWith(h.manager, 50, '2026-10-20', 12);
        expect(h.updates()[0][1]).toEqual([12, 4, 56, 50, 'provisional']);
        expect(h.events()).toEqual([{
            type: 'driver_changed', actor: 9, actorType: 'user', reason: null,
            metadata: { previous: null, current: 50, previousVersion: 4, version: 5, previousStatus: 'provisional', status: 'provisional' },
        }]);
    });

    it('keeps a batch pending final review when the new validation passes, and records both events', async () => {
        const h = build();

        const result = await h.service.changeDriver(12, 50, 4, 9);

        expect(result).toMatchObject({ version: 5, status: 'pending_final_review', changed: true, validation: { passed: true, failures: [] } });
        expect(h.revalidation.evaluate).toHaveBeenCalledWith(h.manager, h.prepared, { version: 4, vehicleId: 56, proposedDriverId: 50 });
        expect(h.updates()[0][1]).toEqual([12, 4, 56, 50, 'pending_final_review']);
        expect(h.events().map((e) => e.type)).toEqual(['driver_changed', 'cutoff_validated']);
        expect(h.events()[1]).toMatchObject({ actor: null, actorType: 'system', reason: null, metadata: { trigger: 'correction', correction: 'driver', correctedByUserId: 9 } });
    });

    it('sends the batch back to provisional when the new validation fails, keeps the correction and records why', async () => {
        const h = build({ outcome: { kind: 'evaluated', validation: FAILED } });

        const result = await h.service.changeDriver(12, 50, 4, 9);

        expect(result).toMatchObject({ version: 5, status: 'provisional', proposedDriverId: 50, validation: { passed: false } });
        expect(result.validation!.failures.map((f) => f.code)).toEqual(['slot_not_met', 'packages_missing']);
        expect(h.updates()).toHaveLength(1);
        expect(h.updates()[0][1]).toEqual([12, 4, 56, 50, 'provisional']);
        const [correction, validation] = h.events();
        expect(correction.metadata).toMatchObject({ previousStatus: 'pending_final_review', status: 'provisional', version: 5 });
        expect(validation).toMatchObject({ type: 'cutoff_failed', reason: 'slot_not_met,packages_missing', metadata: { trigger: 'correction', status: 'provisional' } });
    });

    it('asks OSRM before opening the transaction, and validates the orders before checking the driver', async () => {
        const h = build();
        await h.service.changeDriver(12, 50, 4, 9);
        expect(h.order.indexOf('prepare')).toBeLessThan(h.order.indexOf('transaction'));
        expect(h.order.indexOf('lock')).toBeLessThan(h.order.indexOf('evaluate'));
        expect(h.order.indexOf('evaluate')).toBeLessThan(h.order.indexOf('update'));
    });

    it('rejects an inactive or busy driver without writing anything', async () => {
        const h = build({ gateFails: 'driver' });
        expect(await catchError(h.service.changeDriver(12, 50, 4, 9))).toBeInstanceOf(Error);
        expect(h.updates()).toHaveLength(0);
        expect(h.events()).toHaveLength(0);
    });

    it('answers 200 and writes nothing when the driver is the one the batch already has, without asking OSRM', async () => {
        const h = build();
        const result = await h.service.changeDriver(12, 34, 4, 9);
        expect(h.revalidation.prepare).not.toHaveBeenCalled();
        expect(result).toMatchObject({ changed: false, version: 4, proposedDriverId: 34, validation: null });
        expect(h.updates()).toHaveLength(0);
        expect(h.events()).toHaveLength(0);
        expect(h.resources.assertDriverAvailable).not.toHaveBeenCalled();
    });
});

describe('RouteBatchCorrectionService — vehicle', () => {
    it('checks capacity, an active vehicle and the vehicle of the day (not the driver), then reports the capacity', async () => {
        const h = build({ status: 'provisional' });

        const result = await h.service.changeVehicle(12, 60, 4, 9);

        expect(h.capacity.assertAssignable).toHaveBeenCalledWith(12, 60, h.manager);
        expect(h.resources.assertVehicleActive).toHaveBeenCalledWith(h.manager, 60);
        expect(h.resources.assertResourcesAvailable).toHaveBeenCalledWith(h.manager, null, 60, '2026-10-20', 12);
        expect(result).toMatchObject({ version: 5, vehicleId: 60, proposedDriverId: 34, changed: true, capacity: { assignable: true }, validation: null });
        expect(h.events()[0]).toMatchObject({ type: 'vehicle_changed', metadata: { previous: 56, current: 60 } });
    });

    it('validates the new vehicle in a batch pending final review', async () => {
        const h = build();
        await h.service.changeVehicle(12, 60, 4, 9);
        expect(h.revalidation.evaluate).toHaveBeenCalledWith(h.manager, h.prepared, { version: 4, vehicleId: 60, proposedDriverId: 34 });
        expect(h.events().map((e) => e.type)).toEqual(['vehicle_changed', 'cutoff_validated']);
    });

    it.each(['capacity', 'vehicle-active', 'vehicle-resources'] as const)('rejects the vehicle when %s fails, without writing', async (gateFails) => {
        const h = build({ gateFails });
        expect(await catchError(h.service.changeVehicle(12, 60, 4, 9))).toBeInstanceOf(Error);
        expect(h.updates()).toHaveLength(0);
        expect(h.events()).toHaveLength(0);
    });
});

describe('RouteBatchCorrectionService — concurrency and state', () => {
    it('answers 409 when the version changed, before checking anything else', async () => {
        const h = build({ version: 5 });
        const error = await catchError(h.service.changeDriver(12, 50, 4, 9));
        expect(error).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect((error as RouteBatchApprovalConflictException).getResponse()).toMatchObject({ error: 'ROUTE_BATCH_VERSION_CONFLICT' });
        expect(h.revalidation.evaluate).not.toHaveBeenCalled();
        expect(h.updates()).toHaveLength(0);
    });

    it.each(['confirmed', 'in_execution', 'closed', 'cancelled'])('answers 409 ROUTE_BATCH_NOT_CORRECTABLE for a %s batch, without asking OSRM', async (status) => {
        const h = build({ status });
        const error = await catchError(h.service.changeVehicle(12, 60, 4, 9));
        expect(error).toBeInstanceOf(RouteBatchNotCorrectableException);
        expect(h.revalidation.prepare).not.toHaveBeenCalled();
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers 404 for a batch that does not exist', async () => {
        const h = build({ missing: true });
        expect(await catchError(h.service.changeDriver(12, 50, 4, 9))).toBeInstanceOf(RouteBatchNotFoundException);
    });

    it('answers 409 instead of demoting the batch when it or its orders changed while it was validated', async () => {
        const h = build({ outcome: { kind: 'stale', issues: [{ code: 'dispatch_version_changed' }] } });
        const error = await catchError(h.service.changeDriver(12, 50, 4, 9));
        expect(error).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect((error as Error).message).toContain('dispatch_version_changed');
        expect(h.updates()).toHaveLength(0);
        expect(h.events()).toHaveLength(0);
    });

    it('answers 409 when the status changed between the unlocked read and the lock', async () => {
        const h = build({ status: 'provisional', statusAtLock: 'pending_final_review' });
        expect(await catchError(h.service.changeDriver(12, 50, 4, 9))).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect(h.updates()).toHaveLength(0);
    });

    it('lets the OSRM failure through before any lock, so nothing changed (503)', async () => {
        const h = build({ prepareFails: true });
        expect(await catchError(h.service.changeDriver(12, 50, 4, 9))).toBeInstanceOf(OsrmUnavailableException);
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('maps a unique violation on the vehicle of the day to a 409 and leaves any other unique violation untouched', async () => {
        const unique = (constraint: string) => new QueryFailedError('UPDATE route_batches', [], Object.assign(new Error('duplicate'), { code: '23505', constraint }));
        const h = build();
        h.dataSource.transaction.mockRejectedValueOnce(unique('uq_route_batches_vehicle_shift_date'));
        const vehicle = await catchError(h.service.changeVehicle(12, 60, 4, 9));
        expect((vehicle as RouteBatchApprovalConflictException).getResponse()).toMatchObject({ error: 'ROUTE_BATCH_RESOURCE_CONFLICT' });

        const other = unique('uq_something_else');
        h.dataSource.transaction.mockRejectedValueOnce(other);
        expect(await catchError(h.service.changeVehicle(12, 60, 4, 9))).toBe(other);
    });

    it('answers 409 (try again) when Postgres picks the correction as a deadlock victim', async () => {
        const h = build();
        const victim = new QueryFailedError('SELECT', [], Object.assign(new Error('deadlock detected'), { code: '40P01' }));
        h.dataSource.transaction.mockRejectedValueOnce(victim);
        const error = await catchError(h.service.changeDriver(12, 50, 4, 9));
        expect(error).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect((error as RouteBatchApprovalConflictException).getResponse()).toMatchObject({ error: 'ROUTE_BATCH_VERSION_CONFLICT' });
    });

    it('answers 409 when the guarded UPDATE finds a different version', async () => {
        const h = build({ updateRows: [] });
        expect(await catchError(h.service.changeDriver(12, 50, 4, 9))).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect(h.events()).toHaveLength(0);
    });

    it('maps a unique violation on the day of the driver or the vehicle to a 409', async () => {
        const h = build();
        const violation = new QueryFailedError('UPDATE route_batches', [], Object.assign(new Error('duplicate'), { code: '23505', constraint: 'uq_route_batches_driver_shift_date' }));
        h.dataSource.transaction.mockRejectedValueOnce(violation);
        const error = await catchError(h.service.changeDriver(12, 50, 4, 9));
        expect(error).toBeInstanceOf(RouteBatchApprovalConflictException);
        expect((error as RouteBatchApprovalConflictException).getResponse()).toMatchObject({ error: 'ROUTE_BATCH_DRIVER_NOT_AVAILABLE' });
    });
});
