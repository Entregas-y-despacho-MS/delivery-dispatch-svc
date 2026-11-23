import { describe, expect, it } from 'vitest';
import type { RouteCapacityReport } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';
import { toPipelineCapacity, type PipelineCapacity } from './pipeline-capacity.js';
import { classifyDispatch, countByStage, isPlanExceptionOpen, PipelineStage, type PipelineDispatchInput } from './pipeline-stage.js';

const fitting: PipelineCapacity = toPipelineCapacity(report({ weight: [50, 100], volume: [0.5, 1] }));

function report({ weight, volume, violations = 0 }: { weight: [number, number]; volume: [number, number]; violations?: number }): RouteCapacityReport {
    const measure = ([actual, capacity]: [number, number]) => ({
        actual,
        capacity,
        usedPercent: capacity > 0 ? (actual / capacity) * 100 : 0,
        remaining: Math.max(0, capacity - actual),
        excess: Math.max(0, actual - capacity),
    });
    return {
        estimatedDispatchIds: [],
        weight: measure(weight),
        volume: measure(volume),
        dimensionViolations: Array.from({ length: violations }, (_, index) => ({ dispatchId: 1, packageId: index, exceeded: [] })),
        assignable: true,
    };
}

function input(overrides: Partial<PipelineDispatchInput> = {}): PipelineDispatchInput {
    return { status: 'pending', hasZone: true, batchStatus: null, planExceptionReason: null, batchCapacity: null, ...overrides };
}

describe('classifyDispatch', () => {
    it('puts a pending dispatch with zone and no batch in ready_unbatched', () => {
        expect(classifyDispatch(input())).toEqual({ stage: PipelineStage.READY_UNBATCHED, exceptionCodes: [] });
    });

    it('treats a pickup with zone like a pending delivery (D-56)', () => {
        expect(classifyDispatch(input({ status: 'pickup_scheduled' })).stage).toBe(PipelineStage.READY_UNBATCHED);
    });

    it('treats a rescheduled delivery without batch as ready, like a pending one', () => {
        expect(classifyDispatch(input({ status: 'rescheduled' })).stage).toBe(PipelineStage.READY_UNBATCHED);
        expect(classifyDispatch(input({ status: 'rescheduled', planExceptionReason: 'rescheduled_date_not_plannable' })).exceptionCodes).toEqual(['rescheduled_date_not_plannable']);
    });

    it('keeps a pickup inside a batch in the stage of its batch: it stays pickup_scheduled there (D-56)', () => {
        expect(classifyDispatch(input({ status: 'pickup_scheduled', batchStatus: 'provisional' })).stage).toBe(PipelineStage.PROVISIONAL_REVIEW);
        expect(classifyDispatch(input({ status: 'pickup_scheduled', batchStatus: 'confirmed' })).stage).toBe(PipelineStage.CONFIRMED_ASSIGNED);
    });

    it('puts dispatches of a provisional batch and of a batch in final review in provisional_review', () => {
        for (const batchStatus of ['provisional', 'pending_final_review']) {
            expect(classifyDispatch(input({ status: 'in_planning', batchStatus, batchCapacity: fitting })).stage).toBe(PipelineStage.PROVISIONAL_REVIEW);
        }
        expect(classifyDispatch(input({ status: 'scheduled', batchStatus: 'provisional' })).stage).toBe(PipelineStage.PROVISIONAL_REVIEW);
    });

    it('puts a dispatch of a confirmed batch in confirmed_assigned', () => {
        expect(classifyDispatch(input({ status: 'assigned', batchStatus: 'confirmed', batchCapacity: fitting })).stage).toBe(PipelineStage.CONFIRMED_ASSIGNED);
    });

    it('puts a dispatch on the route in in_execution, by its own status or by its batch', () => {
        expect(classifyDispatch(input({ status: 'out_for_delivery', batchStatus: 'in_execution' })).stage).toBe(PipelineStage.IN_EXECUTION);
        expect(classifyDispatch(input({ status: 'in_transit', batchStatus: 'in_execution' })).stage).toBe(PipelineStage.IN_EXECUTION);
        expect(classifyDispatch(input({ status: 'assigned', batchStatus: 'in_execution' })).stage).toBe(PipelineStage.IN_EXECUTION);
    });

    it('does not turn a capacity excess into an exception once the route runs', () => {
        const over = toPipelineCapacity(report({ weight: [150, 100], volume: [0.5, 1] }));
        expect(classifyDispatch(input({ status: 'out_for_delivery', batchStatus: 'in_execution', batchCapacity: over })).stage).toBe(PipelineStage.IN_EXECUTION);
    });

    it('leaves out the dispatches that are not in the pipeline', () => {
        for (const status of ['delivered', 'cancelled', 'returned', 'returned_to_warehouse', 'incident', 'not_delivered', 'picked_up_in_transit']) {
            expect(classifyDispatch(input({ status, batchStatus: 'closed' }))).toEqual({ stage: null, exceptionCodes: [] });
        }
    });

    describe('exceptions', () => {
        it('flags address_review as address_invalid', () => {
            expect(classifyDispatch(input({ status: 'address_review' }))).toEqual({ stage: PipelineStage.EXCEPTION, exceptionCodes: ['address_invalid'] });
        });

        it('flags a pending dispatch with an open plan exception with its reason', () => {
            expect(classifyDispatch(input({ planExceptionReason: 'no_vehicle_fits' }))).toEqual({ stage: PipelineStage.EXCEPTION, exceptionCodes: ['no_vehicle_fits'] });
        });

        it('ignores a plan exception once the dispatch left pending (it was solved)', () => {
            expect(isPlanExceptionOpen('in_planning', 'no_vehicle_fits')).toBe(false);
            expect(classifyDispatch(input({ status: 'in_planning', batchStatus: 'provisional', planExceptionReason: 'no_vehicle_fits', batchCapacity: fitting })).stage).toBe(PipelineStage.PROVISIONAL_REVIEW);
        });

        it('ignores an unknown plan exception reason', () => {
            expect(isPlanExceptionOpen('pending', 'something_else')).toBe(false);
        });

        it('flags a pending dispatch without zone as zone_missing', () => {
            expect(classifyDispatch(input({ hasZone: false }))).toEqual({ stage: PipelineStage.EXCEPTION, exceptionCodes: ['zone_missing'] });
        });

        it('flags the kg excess and the m3 excess with their own code, never a mixed one', () => {
            const kgOnly = toPipelineCapacity(report({ weight: [150, 100], volume: [0.5, 1] }));
            const m3Only = toPipelineCapacity(report({ weight: [50, 100], volume: [1.5, 1] }));
            const both = toPipelineCapacity(report({ weight: [150, 100], volume: [1.5, 1] }));
            const base = { status: 'scheduled', batchStatus: 'provisional' };
            expect(classifyDispatch(input({ ...base, batchCapacity: kgOnly })).exceptionCodes).toEqual(['capacity_exceeded_kg']);
            expect(classifyDispatch(input({ ...base, batchCapacity: m3Only })).exceptionCodes).toEqual(['capacity_exceeded_m3']);
            expect(classifyDispatch(input({ ...base, batchCapacity: both })).exceptionCodes).toEqual(['capacity_exceeded_kg', 'capacity_exceeded_m3']);
        });

        it('flags a package that does not fit the vehicle dimensions', () => {
            const capacity = toPipelineCapacity(report({ weight: [50, 100], volume: [0.5, 1], violations: 1 }));
            expect(classifyDispatch(input({ status: 'assigned', batchStatus: 'confirmed', batchCapacity: capacity })).exceptionCodes).toEqual(['package_dimensions_exceeded']);
        });

        it('does not invent an exception for a batch without vehicle', () => {
            expect(classifyDispatch(input({ status: 'in_planning', batchStatus: 'provisional', batchCapacity: null })).stage).toBe(PipelineStage.PROVISIONAL_REVIEW);
        });

        it('flags impossible combinations as inconsistent_state instead of guessing a stage', () => {
            expect(classifyDispatch(input({ status: 'assigned', batchStatus: null })).exceptionCodes).toEqual(['inconsistent_state']);
            expect(classifyDispatch(input({ status: 'assigned', batchStatus: 'closed' })).exceptionCodes).toEqual(['inconsistent_state']);
            expect(classifyDispatch(input({ status: 'pending', batchStatus: 'provisional' })).exceptionCodes).toEqual(['inconsistent_state']);
            expect(classifyDispatch(input({ status: 'rescheduled', batchStatus: 'provisional' })).exceptionCodes).toEqual(['inconsistent_state']);
        });
    });

    it('never puts one dispatch in two stages: every combination has a single stage', () => {
        const statuses = ['pending', 'rescheduled', 'pickup_scheduled', 'address_review', 'in_planning', 'scheduled', 'assigned', 'out_for_delivery', 'in_transit'];
        const batches = [null, 'provisional', 'pending_final_review', 'confirmed', 'in_execution', 'closed', 'cancelled'];
        const reasons = [null, 'no_vehicle_available'];
        for (const status of statuses) {
            for (const batchStatus of batches) {
                for (const planExceptionReason of reasons) {
                    const result = classifyDispatch(input({ status, batchStatus, planExceptionReason, hasZone: true }));
                    expect(result.stage).not.toBeNull();
                    const isException = result.stage === PipelineStage.EXCEPTION;
                    expect(isException ? result.exceptionCodes.length > 0 : result.exceptionCodes.length === 0).toBe(true);
                }
            }
        }
    });
});

describe('countByStage', () => {
    it('counts dispatches per stage, with 0 for the empty ones and ignoring those out of the pipeline', () => {
        const counts = countByStage([PipelineStage.READY_UNBATCHED, PipelineStage.READY_UNBATCHED, PipelineStage.EXCEPTION, null]);
        expect(counts).toEqual({
            [PipelineStage.READY_UNBATCHED]: 2,
            [PipelineStage.PROVISIONAL_REVIEW]: 0,
            [PipelineStage.CONFIRMED_ASSIGNED]: 0,
            [PipelineStage.IN_EXECUTION]: 0,
            [PipelineStage.EXCEPTION]: 1,
        });
    });

    it('counts a dispatch once however many dispatches share its batch (the batch is not a unit)', () => {
        const sameBatch = Array.from({ length: 4 }, () => classifyDispatch(input({ status: 'scheduled', batchStatus: 'provisional' })).stage);
        expect(countByStage(sameBatch)[PipelineStage.PROVISIONAL_REVIEW]).toBe(4);
    });
});
