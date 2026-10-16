import { describe, expect, it } from 'vitest';
import { localInstant, minutesOfDay } from '../../planning/domain/operating-calendar.js';
import { dispatch, settings, vehicle } from '../../planning/domain/plan-fixtures.helper-spec.js';
import type { SimParams } from '../../planning/domain/route-simulation.js';
import { buildTimeSlots } from '../../planning/domain/time-slots.js';
import { SHIFT_DATE } from './cutoff-fixtures.helper-spec.js';
import { findDuplicatedDispatches, validateCutoffBatch, type BatchFacts, type StopFacts } from './cutoff-validation.js';

const cfg = settings();
const PARAMS: SimParams = {
    slots: buildTimeSlots(cfg.morningWindow, cfg.afternoonWindow, cfg.slotDurationMinutes),
    routeStartMinute: minutesOfDay(cfg.morningWindow.start),
    routeEndMinute: minutesOfDay(cfg.afternoonWindow.end),
    serviceMinutes: cfg.stopServiceMinutes,
    marginPct: cfg.planningMarginPct,
    // 1 km = 60 s; the depot is km 0 and a dispatch id is its km.
    travelSeconds: (from, to) => Math.abs((from ?? 0) - to) * 60,
};

function stopFacts(id: number, over: Partial<StopFacts> & { window?: [string, string]; kg?: number } = {}): StopFacts {
    const { window = ['09:00', '11:00'], kg = 10, ...rest } = over;
    return {
        dispatchId: id,
        sequence: id,
        expectedVersion: 1,
        currentVersion: 1,
        status: 'scheduled',
        currentRouteBatchId: 1,
        hasDestination: true,
        window: { start: localInstant(SHIFT_DATE, window[0]), end: localInstant(SHIFT_DATE, window[1]) },
        // Packages registered: 10 kg and 0.01 m³ each unless `kg` says otherwise.
        dispatch: dispatch(id, {
            km: id,
            estimatedWeightKg: null,
            packages: [{ dispatchId: id, packageId: id, lengthCm: 20, widthCm: 20, heightCm: 20, grossWeightKg: kg }],
        }),
        ...rest,
    };
}

function facts(over: Partial<BatchFacts> = {}): BatchFacts {
    return {
        routeBatchId: 1,
        expectedVersion: 4,
        currentVersion: 4,
        allowedBatchIds: [1],
        vehicleId: 1,
        vehicle: vehicle(1, 100),
        vehicleConflictBatchId: null,
        proposedDriverId: 50,
        driverActive: true,
        driverConflictBatchId: null,
        stops: [stopFacts(1), stopFacts(2, { window: ['11:00', '13:00'] })],
        reoptimizationIncomplete: false,
        ...over,
    };
}

const codes = (result: ReturnType<typeof validateCutoffBatch>) => result.failures.map((f) => f.code);

describe('validateCutoffBatch', () => {
    it('passes a batch whose versions, capacity, resources and slots are all right', () => {
        const result = validateCutoffBatch(facts(), PARAMS);
        expect(result.passed).toBe(true);
        expect(result.failures).toEqual([]);
        expect(result.capacity?.assignable).toBe(true);
    });

    it('fails when the batch version moved while the cutoff was computing', () => {
        const result = validateCutoffBatch(facts({ currentVersion: 5 }), PARAMS);
        expect(codes(result)).toEqual(['batch_version_changed']);
        expect(result.failures[0].detail).toEqual({ expected: 4, current: 5 });
    });

    it('fails when an order changed version and names it', () => {
        const result = validateCutoffBatch(facts({ stops: [stopFacts(1), stopFacts(2, { currentVersion: 2 })] }), PARAMS);
        expect(codes(result)).toEqual(['dispatch_version_changed']);
        expect(result.failures[0].dispatchIds).toEqual([2]);
    });

    it('fails when an order is no longer scheduled', () => {
        const result = validateCutoffBatch(facts({ stops: [stopFacts(1), stopFacts(2, { status: 'rescheduled' })] }), PARAMS);
        expect(codes(result)).toEqual(['dispatch_status_changed']);
    });

    it('fails when an order now belongs to a batch the plan did not know', () => {
        const result = validateCutoffBatch(facts({ stops: [stopFacts(1, { currentRouteBatchId: 99 }), stopFacts(2)] }), PARAMS);
        expect(codes(result)).toEqual(['dispatch_in_other_batch']);
        expect(result.failures[0].dispatchIds).toEqual([1]);
    });

    it('accepts an order still pointing to a batch that was absorbed into this one', () => {
        const result = validateCutoffBatch(
            facts({ allowedBatchIds: [1, 2], stops: [stopFacts(1), stopFacts(2, { currentRouteBatchId: 2 })] }),
            PARAMS,
        );
        expect(result.passed).toBe(true);
    });

    it('fails without destination or without registered packages', () => {
        const noPackages = stopFacts(2, { window: ['11:00', '13:00'] });
        noPackages.dispatch = { ...noPackages.dispatch, packages: [] };
        const result = validateCutoffBatch(facts({ stops: [stopFacts(1, { hasDestination: false }), noPackages] }), PARAMS);
        expect(codes(result)).toEqual(['destination_incomplete', 'packages_missing']);
    });

    it('fails with the exact excess when the load goes over the vehicle', () => {
        const result = validateCutoffBatch(
            facts({ stops: [stopFacts(1, { kg: 80 }), stopFacts(2, { kg: 40, window: ['11:00', '13:00'] })] }),
            PARAMS,
        );
        expect(codes(result)).toEqual(['capacity_exceeded']);
        expect(result.failures[0].detail).toMatchObject({ weightExcessKg: 20 });
    });

    it('fails when the vehicle is missing, inactive or taken by another batch', () => {
        expect(codes(validateCutoffBatch(facts({ vehicleId: null, vehicle: null }), PARAMS))).toEqual(['vehicle_missing']);
        expect(codes(validateCutoffBatch(facts({ vehicle: null }), PARAMS))).toEqual(['vehicle_inactive']);
        expect(codes(validateCutoffBatch(facts({ vehicleConflictBatchId: 9 }), PARAMS))).toEqual(['vehicle_conflict']);
    });

    it('fails when the proposed driver is inactive or has another batch that day', () => {
        expect(codes(validateCutoffBatch(facts({ driverActive: false }), PARAMS))).toEqual(['driver_inactive']);
        expect(codes(validateCutoffBatch(facts({ driverConflictBatchId: 8 }), PARAMS))).toEqual(['driver_conflict']);
    });

    it('only warns when no driver is proposed: the coordinator picks one in the 2nd approval', () => {
        const result = validateCutoffBatch(facts({ proposedDriverId: null }), PARAMS);
        expect(result.passed).toBe(true);
        expect(result.warnings.map((w) => w.code)).toEqual(['driver_missing']);
    });

    it('fails when a promised slot is not met with the margin', () => {
        // The second customer was promised 09:00-09:30 but the route reaches it after that.
        const result = validateCutoffBatch(
            facts({ stops: [stopFacts(1), stopFacts(30, { window: ['09:00', '09:30'] })] }),
            PARAMS,
        );
        expect(codes(result)).toEqual(['slot_not_met']);
        expect(result.failures[0].detail).toMatchObject({ reason: 'late_for_window', failedDispatchId: 30 });
    });

    it('keeps a batch the reoptimization could not complete out of review', () => {
        const result = validateCutoffBatch(facts({ reoptimizationIncomplete: true }), PARAMS);
        expect(codes(result)).toEqual(['reoptimization_incomplete']);
    });

    it('reports every reason at once', () => {
        const result = validateCutoffBatch(facts({ currentVersion: 9, vehicle: null, driverActive: false }), PARAMS);
        expect(codes(result)).toEqual(['batch_version_changed', 'vehicle_inactive', 'driver_inactive']);
    });
});

describe('findDuplicatedDispatches', () => {
    it('finds an order claimed by two batches of the proposal', () => {
        const batches = [{ stops: [{ dispatchId: 1 }, { dispatchId: 2 }] }, { stops: [{ dispatchId: 2 }, { dispatchId: 3 }] }];
        expect(findDuplicatedDispatches(batches)).toEqual([2]);
    });

    it('returns nothing when every order is in one batch', () => {
        expect(findDuplicatedDispatches([{ stops: [{ dispatchId: 1 }] }, { stops: [{ dispatchId: 2 }] }])).toEqual([]);
    });
});
