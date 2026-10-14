import { describe, expect, it, vi } from 'vitest';
import { PlanCandidatesRepository } from './plan-candidates.repository.js';

const row = (over: Record<string, unknown> = {}) => ({
    dispatch_id: 101,
    delivery_zone_id: 7,
    zone_code: 'ZON-SUR',
    zone_name: 'Achumani',
    zone_deleted: false,
    origin_warehouse_id: 1,
    delivery_latitude: '-16.540000',
    delivery_longitude: '-68.080000',
    priority: 'normal',
    confirmed_at: new Date('2026-10-12T12:00:00.000Z'),
    status: 'pending',
    estimated_weight_kg: '12.50',
    scheduled_window_start: null,
    reschedule_window_start: null,
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
});
