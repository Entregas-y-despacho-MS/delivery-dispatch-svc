import { describe, expect, it, vi } from 'vitest';
import {
    BATCH_LOADS_SQL,
    BATCH_VEHICLES_SQL,
    PIPELINE_CANDIDATES_SQL,
    PIPELINE_STATUSES,
    PipelineRepository,
} from './pipeline.repository.js';

const candidateRow = {
    dispatch_id: 7, status: 'scheduled', priority: 'normal', window_start: new Date('2026-11-23T13:00:00Z'),
    route_batch_id: 3, batch_status: 'provisional', batch_version: 2, batch_shift_date: '2026-11-23',
    zone_id: 5, zone_name: 'Achumani', warehouse_id: 1, warehouse_name: 'Hub', operating_date: '2026-11-23', shift: 'morning',
    vehicle_id: 9, vehicle_plate: '1234ABC', driver_id: 4, driver_name: 'Ana', plan_reason: null, plan_detail: null,
};

describe('PipelineRepository.findCandidates', () => {
    it('sends the filters in order, with null for the missing ones, and the statuses of the pipeline', async () => {
        const query = vi.fn().mockResolvedValue([]);
        await new PipelineRepository({ query } as never).findCandidates({ date: '2026-11-23', zoneId: 5, shift: 'morning' });
        expect(query).toHaveBeenCalledWith(PIPELINE_CANDIDATES_SQL, ['2026-11-23', 5, null, 'morning', [...PIPELINE_STATUSES]]);
    });

    it('maps the row to the candidate with its batch as detail', async () => {
        const query = vi.fn().mockResolvedValue([candidateRow]);
        const [candidate] = await new PipelineRepository({ query } as never).findCandidates({ date: '2026-11-23' });
        expect(candidate).toEqual({
            dispatchId: 7, status: 'scheduled', priority: 'normal', windowStart: new Date('2026-11-23T13:00:00Z'),
            routeBatchId: 3, batchStatus: 'provisional', batchVersion: 2, batchShiftDate: '2026-11-23',
            zone: { id: 5, name: 'Achumani' }, warehouse: { id: 1, name: 'Hub' }, operatingDate: '2026-11-23', shift: 'morning',
            vehicle: { id: 9, name: '1234ABC' }, driver: { id: 4, name: 'Ana' }, planExceptionReason: null, planExceptionDetail: null,
        });
    });

    it('gives null refs for a dispatch without batch, zone, vehicle or driver', async () => {
        const query = vi.fn().mockResolvedValue([{ ...candidateRow, route_batch_id: null, batch_status: null, batch_version: null, batch_shift_date: null,
            zone_id: null, zone_name: null, warehouse_id: null, warehouse_name: null, vehicle_id: null, vehicle_plate: null, driver_id: null, driver_name: null }]);
        const [candidate] = await new PipelineRepository({ query } as never).findCandidates({ date: '2026-11-23' });
        expect(candidate).toMatchObject({ routeBatchId: null, batchStatus: null, zone: null, warehouse: null, vehicle: null, driver: null });
    });

    it('names the deadline reason of the generator `deadline_exceeded`', async () => {
        const query = vi.fn().mockResolvedValue([{ ...candidateRow, plan_reason: 'promise_deadline_exceeded', plan_detail: 'The order could not be planned.' }]);
        const [candidate] = await new PipelineRepository({ query } as never).findCandidates({ date: '2026-11-23' });
        expect(candidate).toMatchObject({ planExceptionReason: 'deadline_exceeded', planExceptionDetail: 'The order could not be planned.' });
    });

    it('places a dispatch by its batch day or its window day, and carries over the open work without either', () => {
        expect(PIPELINE_CANDIDATES_SQL).toContain('COALESCE(rb.shift_date');
        expect(PIPELINE_CANDIDATES_SQL).toContain('c.operating_date IS NULL AND c.route_batch_id IS NULL AND c.created_day <= $1::date');
    });

    it('drops a plan exception once a status change came after it, and ignores a deleted vehicle', () => {
        expect(PIPELINE_CANDIDATES_SQL).toContain("s.event_type = 'status_changed' AND s.dispatch_event_id > e.dispatch_event_id");
        expect(PIPELINE_CANDIDATES_SQL).toContain('v.deleted_at IS NULL');
        expect(PIPELINE_STATUSES).toContain('rescheduled');
    });

    it('takes only the latest plan exception of each dispatch, and the shift from the window start in La Paz', () => {
        expect(PIPELINE_CANDIDATES_SQL).toContain("e.event_type = 'plan_exception'");
        expect(PIPELINE_CANDIDATES_SQL).toContain('LIMIT 1');
        expect(PIPELINE_CANDIDATES_SQL).toContain("AT TIME ZONE 'America/La_Paz'");
    });
});

describe('PipelineRepository.loadBatches', () => {
    it('does not query when there are no batches', async () => {
        const query = vi.fn();
        expect((await new PipelineRepository({ query } as never).loadBatches([])).size).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });

    it('loads every batch with two queries, kg and m3 apart, and counts its dispatches', async () => {
        const query = vi.fn(async (sql: string) => {
            if (sql === BATCH_VEHICLES_SQL) {
                return [{ route_batch_id: 3, vehicle_id: 9, capacity_kg: '100.00', capacity_m3: '1.00', max_package_length_cm: null, max_package_width_cm: null, max_package_height_cm: null }];
            }
            return [
                { route_batch_id: 3, dispatch_id: 7, estimated_weight_kg: null, estimated_volume_m3: null, package_id: 1, length_cm: '100', width_cm: '100', height_cm: '100', gross_weight_kg: '130' },
                { route_batch_id: 3, dispatch_id: 8, estimated_weight_kg: null, estimated_volume_m3: null, package_id: 2, length_cm: '50', width_cm: '50', height_cm: '50', gross_weight_kg: '10' },
            ];
        });
        const loads = await new PipelineRepository({ query } as never).loadBatches([3]);
        expect(query).toHaveBeenCalledTimes(2);
        expect(query).toHaveBeenCalledWith(BATCH_VEHICLES_SQL, [[3]]);
        expect(query).toHaveBeenCalledWith(BATCH_LOADS_SQL, [[3]]);
        const load = loads.get(3)!;
        expect(load.dispatchCount).toBe(2);
        expect(load.capacity?.weight).toMatchObject({ unit: 'kg', actual: 140, capacity: 100, excess: 40, exceeded: true });
        expect(load.capacity?.volume).toMatchObject({ unit: 'm3', actual: 1.125, capacity: 1, excess: 0.125, exceeded: true });
    });

    it('gives a batch without vehicle no capacity instead of inventing one', async () => {
        const query = vi.fn(async (sql: string) => {
            if (sql === BATCH_VEHICLES_SQL) {
                return [{ route_batch_id: 4, vehicle_id: null, capacity_kg: null, capacity_m3: null, max_package_length_cm: null, max_package_width_cm: null, max_package_height_cm: null }];
            }
            return [{ route_batch_id: 4, dispatch_id: 11, estimated_weight_kg: '20', estimated_volume_m3: null, package_id: null, length_cm: null, width_cm: null, height_cm: null, gross_weight_kg: null }];
        });
        const load = (await new PipelineRepository({ query } as never).loadBatches([4])).get(4)!;
        expect(load).toEqual({ capacity: null, dispatchCount: 1 });
    });

    it('uses the estimated weight and volume of a dispatch without packages, like the vehicle assignment', async () => {
        const query = vi.fn(async (sql: string) => {
            if (sql === BATCH_VEHICLES_SQL) {
                return [{ route_batch_id: 5, vehicle_id: 2, capacity_kg: '50', capacity_m3: '2', max_package_length_cm: null, max_package_width_cm: null, max_package_height_cm: null }];
            }
            return [{ route_batch_id: 5, dispatch_id: 12, estimated_weight_kg: '60', estimated_volume_m3: '0.5', package_id: null, length_cm: null, width_cm: null, height_cm: null, gross_weight_kg: null }];
        });
        const capacity = (await new PipelineRepository({ query } as never).loadBatches([5])).get(5)!.capacity!;
        expect(capacity.weight).toMatchObject({ actual: 60, exceeded: true });
        expect(capacity.volume).toMatchObject({ actual: 0.5, exceeded: false });
    });

    it('never locks rows: the view is read-only', () => {
        expect(BATCH_VEHICLES_SQL).not.toMatch(/FOR UPDATE/i);
        expect(BATCH_LOADS_SQL).not.toMatch(/FOR UPDATE/i);
    });
});
