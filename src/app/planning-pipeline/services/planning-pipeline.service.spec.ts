import { describe, expect, it, vi } from 'vitest';
import { toPipelineCapacity } from '../domain/pipeline-capacity.js';
import { PipelineStage } from '../domain/pipeline-stage.js';
import type { BatchLoad, PipelineCandidate } from '../repositories/pipeline.repository.js';
import { PlanningPipelineService } from './planning-pipeline.service.js';

function candidate(overrides: Partial<PipelineCandidate> = {}): PipelineCandidate {
    return {
        dispatchId: 1, status: 'pending', priority: 'normal', windowStart: null, routeBatchId: null, batchStatus: null, batchVersion: null,
        batchShiftDate: null, zone: { id: 5, name: 'Achumani' }, warehouse: { id: 1, name: 'Hub' }, operatingDate: null, shift: null,
        vehicle: null, driver: null, planExceptionReason: null, planExceptionDetail: null, ...overrides,
    };
}

function capacity(weight: [number, number], volume: [number, number]) {
    const measure = ([actual, cap]: [number, number]) => ({ actual, capacity: cap, usedPercent: (actual / cap) * 100, remaining: Math.max(0, cap - actual), excess: Math.max(0, actual - cap) });
    return toPipelineCapacity({ estimatedDispatchIds: [], weight: measure(weight), volume: measure(volume), dimensionViolations: [], assignable: true });
}

function setup(candidates: PipelineCandidate[], loads: Array<[number, BatchLoad]> = []) {
    const repository = {
        findCandidates: vi.fn().mockResolvedValue(candidates),
        loadBatches: vi.fn().mockResolvedValue(new Map(loads)),
    };
    return { service: new PlanningPipelineService(repository as never), repository };
}

const params = (overrides: object = {}) => ({ page: 1, limit: 10, date: '2026-11-23', ...overrides }) as never;

const inBatch = (dispatchId: number, routeBatchId: number, batchStatus = 'provisional', status = 'scheduled') =>
    candidate({ dispatchId, routeBatchId, batchStatus, batchVersion: 1, batchShiftDate: '2026-11-23', status, vehicle: { id: 9, name: '1234ABC' } });

describe('PlanningPipelineService', () => {
    it('asks the repository for the filters of the request and loads each batch once', async () => {
        const { service, repository } = setup([inBatch(1, 3), inBatch(2, 3), inBatch(3, 4)]);
        await service.getPipeline(params({ zoneId: 5, warehouseId: 1, shift: 'morning' }));
        expect(repository.findCandidates).toHaveBeenCalledWith({ date: '2026-11-23', zoneId: 5, warehouseId: 1, shift: 'morning' });
        expect(repository.loadBatches).toHaveBeenCalledWith([3, 4]);
    });

    it('counts dispatches, not batches: three dispatches of one batch are three, and the batch is only detail', async () => {
        const { service } = setup([inBatch(1, 3), inBatch(2, 3), inBatch(3, 3)], [[3, { capacity: capacity([50, 100], [0.5, 1]), dispatchCount: 3 }]]);
        const result = await service.getPipeline(params());
        expect(result.summary.byStage[PipelineStage.PROVISIONAL_REVIEW]).toBe(3);
        expect(result.summary.total).toBe(3);
        expect(result.data).toHaveLength(3);
        expect(result.batches).toHaveLength(1);
        expect(result.batches[0]).toMatchObject({ id: 3, status: 'provisional', dispatchCount: 3 });
    });

    it('puts every dispatch of an overloaded batch in exception with the unit that exceeds, never a mixed one', async () => {
        const { service } = setup([inBatch(1, 3), inBatch(2, 3)], [[3, { capacity: capacity([150, 100], [0.5, 1]), dispatchCount: 2 }]]);
        const result = await service.getPipeline(params());
        expect(result.summary.byStage[PipelineStage.EXCEPTION]).toBe(2);
        expect(result.data[0].exception?.codes).toEqual(['capacity_exceeded_kg']);
        expect(result.data[0].exception?.reason).toContain('(kg)');
        expect(result.batches[0].capacity?.weight).toMatchObject({ unit: 'kg', exceeded: true, excess: 50 });
        expect(result.batches[0].capacity?.volume).toMatchObject({ unit: 'm3', exceeded: false });
    });

    it('lists the stages of one day side by side and leaves out the dispatches that are not in the pipeline', async () => {
        const { service } = setup([
            candidate({ dispatchId: 1 }),
            inBatch(2, 3, 'confirmed', 'assigned'),
            inBatch(3, 4, 'in_execution', 'in_transit'),
            candidate({ dispatchId: 4, status: 'address_review' }),
            candidate({ dispatchId: 5, status: 'delivered' }),
        ], [[3, { capacity: null, dispatchCount: 1 }], [4, { capacity: null, dispatchCount: 1 }]]);
        const result = await service.getPipeline(params());
        expect(result.summary).toEqual({
            byStage: { ready_unbatched: 1, provisional_review: 0, confirmed_assigned: 1, in_execution: 1, exception: 1 },
            total: 4,
        });
        expect(result.data.map((item) => item.dispatchId)).toEqual([1, 2, 3, 4]);
    });

    it('filters the list by stage without hiding the rest of the summary', async () => {
        const { service } = setup([candidate({ dispatchId: 1 }), candidate({ dispatchId: 2, status: 'address_review' })]);
        const result = await service.getPipeline(params({ stage: PipelineStage.EXCEPTION }));
        expect(result.data.map((item) => item.dispatchId)).toEqual([2]);
        expect(result.summary.total).toBe(2);
        expect(result.meta.total).toBe(1);
    });

    it('paginates the dispatches and brings only the batches of the page', async () => {
        const { service } = setup([inBatch(1, 3), inBatch(2, 3), inBatch(3, 4)], [[3, { capacity: null, dispatchCount: 2 }], [4, { capacity: null, dispatchCount: 1 }]]);
        const result = await service.getPipeline(params({ page: 2, limit: 2 }));
        expect(result.data.map((item) => item.dispatchId)).toEqual([3]);
        expect(result.batches.map((batch) => batch.id)).toEqual([4]);
        expect(result.meta).toEqual({ page: 2, limit: 2, total: 3, pages: 2 });
    });

    it('gives a batch without vehicle no capacity, and an exception its readable reason and the path to solve it', async () => {
        const { service } = setup([inBatch(1, 3), candidate({ dispatchId: 2, planExceptionReason: 'no_vehicle_fits' })], [[3, { capacity: null, dispatchCount: 1 }]]);
        const result = await service.getPipeline(params());
        expect(result.batches[0].capacity).toBeNull();
        const exception = result.data.find((item) => item.dispatchId === 2)!;
        expect(exception.stage).toBe(PipelineStage.EXCEPTION);
        expect(exception.exception).toEqual({ codes: ['no_vehicle_fits'], reason: 'No vehicle has the capacity for this dispatch.' });
        expect(exception.detailPath).toBe('/dispatches/2/detail');
        expect(result.data.find((item) => item.dispatchId === 1)!.exception).toBeNull();
    });

    it('answers an empty day with zeros and no pages', async () => {
        const { service, repository } = setup([]);
        const result = await service.getPipeline(params());
        expect(result.summary.total).toBe(0);
        expect(result.data).toEqual([]);
        expect(result.meta).toEqual({ page: 1, limit: 10, total: 0, pages: 0 });
        expect(repository.loadBatches).toHaveBeenCalledWith([]);
    });

    it('uses today in La Paz when the request has no date', async () => {
        const { service, repository } = setup([]);
        await service.getPipeline({ page: 1, limit: 10 } as never);
        expect(repository.findCandidates.mock.calls[0][0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
