import { describe, expect, it, vi } from 'vitest';
import { PlanCandidatesRepository } from './plan-candidates.repository.js';

const row = (over: Record<string, unknown> = {}) => ({
    dispatch_id: 101,
    delivery_zone_id: 7,
    zone_code: 'ZON-SUR',
    zone_name: 'Achumani',
    zone_deleted: false,
    warehouse_id: 1,
    delivery_latitude: '-16.540000',
    delivery_longitude: '-68.080000',
    priority: 'normal',
    confirmed_at: new Date('2026-10-12T12:00:00.000Z'),
    status: 'pending',
    estimated_weight_kg: '12.50',
    scheduled_window_start: null,
    reschedule_window_start: null,
    preferred_pickup_date: null,
    ...over,
});

function build(rows: Record<string, unknown>[], packages: Record<string, unknown>[] = []) {
    const query = vi.fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce(packages);
    return { query, repository: new PlanCandidatesRepository({ query } as any) };
}

describe('PlanCandidatesRepository.findCandidates', () => {
    it('reads the zone code, name and whether it was deleted from the catalog', async () => {
        const { repository } = build([row(), row({ dispatch_id: 102, zone_deleted: true })]);

        const candidates = await repository.findCandidates();

        expect(candidates[0]).toMatchObject({ dispatchId: 101, zoneId: 7, zoneCode: 'ZON-SUR', zoneName: 'Achumani', zoneDeleted: false });
        expect(candidates[1]).toMatchObject({ dispatchId: 102, zoneDeleted: true });
    });

    it('joins the zone catalog without filtering out deleted zones, because those orders are planned too', async () => {
        const { query, repository } = build([row()]);

        await repository.findCandidates();

        const sql: string = query.mock.calls[0][0];
        expect(sql).toMatch(/JOIN delivery_zones z ON z\.delivery_zone_id = d\.delivery_zone_id/);
        expect(sql).toMatch(/z\.deleted_at IS NOT NULL\) AS zone_deleted/);
        expect(sql).not.toMatch(/z\.deleted_at IS NULL/);
    });

    it('leaves out orders being edited, incomplete ones and non deliveries in the query itself', async () => {
        const { query, repository } = build([row()]);

        await repository.findCandidates();

        const sql: string = query.mock.calls[0][0];
        expect(sql).toContain("t.name = 'delivery'");
        expect(sql).toContain('shipment_ready = TRUE');
        expect(sql).toContain('dispatch_reservations');
        expect(sql).toContain('d.delivery_latitude IS NOT NULL');
        // address_review is out because only pending / rescheduled are selected (D-19).
        expect(sql).not.toContain('address_review');
    });

    it('does not read packages when there are no candidates', async () => {
        const { query, repository } = build([]);

        await expect(repository.findCandidates()).resolves.toEqual([]);
        expect(query).toHaveBeenCalledOnce();
    });

    it('maps numbers, packages and the fixed date of a rescheduled order', async () => {
        const { repository } = build(
            [row({
                status: 'rescheduled',
                reschedule_window_start: new Date('2026-10-27T13:00:00.000Z'),
                scheduled_window_start: new Date('2026-10-14T13:00:00.000Z'),
            })],
            [{ dispatch_id: 101, dispatch_package_id: 5, length_cm: '40.00', width_cm: '30.00', height_cm: '20.00', gross_weight_kg: '7.25' }],
        );

        const [candidate] = await repository.findCandidates();

        expect(candidate.latitude).toBe(-16.54);
        expect(candidate.estimatedWeightKg).toBe(12.5);
        expect(candidate.fixedDate).toBe('2026-10-27');
        expect(candidate.packages).toEqual([
            { dispatchId: 101, packageId: 5, lengthCm: 40, widthCm: 30, heightCm: 20, grossWeightKg: 7.25 },
        ]);
    });

    it('takes the agreed window of a rescheduled order from its last reschedule, else from the order', async () => {
        const start = new Date('2026-10-27T13:00:00.000Z');
        const end = new Date('2026-10-27T15:00:00.000Z');
        const { repository } = build([
            row({ status: 'rescheduled', reschedule_window_start: start, reschedule_window_end: end }),
            row({
                dispatch_id: 102, status: 'rescheduled',
                scheduled_window_start: new Date('2026-10-14T13:00:00.000Z'),
                scheduled_window_end: new Date('2026-10-14T15:00:00.000Z'),
            }),
            row({ dispatch_id: 103 }),
        ]);

        const candidates = await repository.findCandidates();

        expect(candidates[0].agreedWindow).toEqual({ start, end });
        expect(candidates[1].agreedWindow).toEqual({
            start: new Date('2026-10-14T13:00:00.000Z'), end: new Date('2026-10-14T15:00:00.000Z'),
        });
        // Only rescheduled orders carry an agreed window; a pending one is free.
        expect(candidates[2].agreedWindow).toBeNull();
    });

    it("includes pickup_scheduled customer pickups alongside deliveries in the query", async () => {
        const { query, repository } = build([row()]);

        await repository.findCandidates();

        const sql: string = query.mock.calls[0][0];
        expect(sql).toContain("t.name = 'warehouse_return_pickup' AND s.name = 'pickup_scheduled'");
        expect(sql).toContain('COALESCE(d.origin_warehouse_id, d.destination_warehouse_id)');
    });

    it('fixes a pickup to its preferred day when it gave one, and resolves its warehouse from the destination', async () => {
        const { repository } = build([
            row({ status: 'pickup_scheduled', warehouse_id: 9, preferred_pickup_date: '2026-11-10' }),
        ]);

        const [candidate] = await repository.findCandidates();

        expect(candidate).toMatchObject({ status: 'pickup_scheduled', warehouseId: 9, fixedDate: '2026-11-10', agreedWindow: null });
    });

    it('leaves an undated pickup free, planned like a plain pending delivery', async () => {
        const { repository } = build([row({ status: 'pickup_scheduled', preferred_pickup_date: null })]);

        const [candidate] = await repository.findCandidates();

        expect(candidate.fixedDate).toBeNull();
    });
});

describe('PlanCandidatesRepository.findOpenBatches', () => {
    const stopRow = (over: Record<string, unknown> = {}) => ({
        route_batch_id: 500, version: 3, shift_date: '2026-10-14', delivery_zone_id: 7,
        zone_code: 'ZON-SUR', zone_name: 'Achumani', zone_deleted: false, origin_warehouse_id: 1, vehicle_id: 4,
        dispatch_id: 101, sequence_order: 1, status: 'scheduled', priority: 'normal',
        confirmed_at: new Date('2026-10-12T12:00:00.000Z'),
        delivery_latitude: '-16.540000', delivery_longitude: '-68.080000', estimated_weight_kg: '10.00',
        scheduled_window_start: new Date('2026-10-14T13:00:00.000Z'),
        scheduled_window_end: new Date('2026-10-14T15:00:00.000Z'),
        promise_notified_at: new Date('2026-10-12T13:00:00.000Z'),
        ...over,
    });

    it('reads only provisional batches from today, in visiting order', async () => {
        const { query, repository } = build([stopRow()], []);

        await repository.findOpenBatches('2026-10-12');

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain("b.status = 'provisional'");
        expect(sql).toContain('ORDER BY b.route_batch_id, d.sequence_order');
        expect(params).toEqual(['2026-10-12']);
    });

    it('marks a stop as notified only when the customer was told, and keeps its window', async () => {
        const { repository } = build([
            stopRow(),
            stopRow({ dispatch_id: 102, sequence_order: 2, status: 'in_planning', promise_notified_at: null, scheduled_window_start: null, scheduled_window_end: null }),
        ]);

        const [batch] = await repository.findOpenBatches('2026-10-12');

        expect(batch).toMatchObject({ routeBatchId: 500, version: 3, shiftDate: '2026-10-14', zoneCode: 'ZON-SUR', vehicleId: 4 });
        expect(batch.stops.map((s) => [s.dispatch.dispatchId, s.sequence, s.notified, s.dispatch.status])).toEqual([
            [101, 1, true, 'scheduled'],
            [102, 2, false, 'in_planning'],
        ]);
        expect(batch.stops[0].window).toEqual({
            start: new Date('2026-10-14T13:00:00.000Z'), end: new Date('2026-10-14T15:00:00.000Z'),
        });
        expect(batch.stops[1].window).toBeNull();
    });

    it('leaves out a batch with a stop that cannot be simulated', async () => {
        const { repository } = build([
            stopRow(),
            stopRow({ dispatch_id: 102, sequence_order: null }),
            stopRow({ route_batch_id: 501, dispatch_id: 201 }),
        ]);

        const batches = await repository.findOpenBatches('2026-10-12');

        expect(batches.map((b) => b.routeBatchId)).toEqual([501]);
    });

    it('does not read packages when there are no open batches', async () => {
        const { query, repository } = build([]);

        await expect(repository.findOpenBatches('2026-10-12')).resolves.toEqual([]);
        expect(query).toHaveBeenCalledOnce();
    });
});

describe('PlanCandidatesRepository.findOpenBatches filter', () => {
    it('reads every open batch when no filter is given, exactly as before', async () => {
        const { query, repository } = build([]);

        await repository.findOpenBatches('2026-10-12');

        const [sql, params] = query.mock.calls[0];
        expect(sql).not.toContain('b.delivery_zone_id =');
        expect(params).toEqual(['2026-10-12']);
    });

    it('narrows to one zone and one warehouse with bound parameters, never concatenated values', async () => {
        const { query, repository } = build([]);

        await repository.findOpenBatches('2026-10-12', { zoneId: 7, warehouseId: 3 });

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('AND b.delivery_zone_id = $2 AND b.origin_warehouse_id = $3');
        expect(sql).not.toMatch(/= 7\b|= 3\b/);
        expect(params).toEqual(['2026-10-12', 7, 3]);
    });

    it('narrows by the zone alone', async () => {
        const { query, repository } = build([]);

        await repository.findOpenBatches('2026-10-12', { zoneId: 7 });

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('AND b.delivery_zone_id = $2');
        expect(sql).not.toContain('b.origin_warehouse_id = $');
        expect(params).toEqual(['2026-10-12', 7]);
    });
});

describe('PlanCandidatesRepository.findForRescheduling', () => {
    const own = (over: Record<string, unknown> = {}) => ({
        ...row({ status: 'scheduled' }),
        route_batch_id: 500,
        shift_date: '2026-10-15',
        ...over,
    });

    it('reads the customer\'s own dispatch as the planner sees it, with its batch and date', async () => {
        const { repository } = build([own()], [
            { dispatch_id: 101, dispatch_package_id: 9, length_cm: '40', width_cm: '30', height_cm: '25', gross_weight_kg: '6.4' },
        ]);

        const found = await repository.findForRescheduling(101);

        expect(found).toMatchObject({ routeBatchId: 500, shiftDate: '2026-10-15' });
        expect(found!.dispatch).toMatchObject({
            dispatchId: 101, zoneId: 7, warehouseId: 1, latitude: -16.54, longitude: -68.08, status: 'scheduled',
            fixedDate: null, agreedWindow: null, estimatedWeightKg: 12.5,
        });
        expect(found!.dispatch.packages).toEqual([
            { dispatchId: 101, packageId: 9, lengthCm: 40, widthCm: 30, heightCm: 25, grossWeightKg: 6.4 },
        ]);
    });

    it('is null when the dispatch cannot be simulated (no point, zone or warehouse) or does not exist', async () => {
        const { query, repository } = build([]);

        await expect(repository.findForRescheduling(999)).resolves.toBeNull();
        expect(query).toHaveBeenCalledOnce();
        expect(String(query.mock.calls[0][0])).toContain('d.delivery_latitude IS NOT NULL');
    });

    it('has no batch and no date for a dispatch without a route', async () => {
        const { repository } = build([own({ route_batch_id: null, shift_date: null })]);

        await expect(repository.findForRescheduling(101)).resolves.toMatchObject({ routeBatchId: null, shiftDate: null });
    });
});
