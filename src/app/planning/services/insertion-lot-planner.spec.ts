import { describe, expect, it } from 'vitest';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { localInstant } from '../domain/operating-calendar.js';
import {
    dispatch, FakeOsrm, MONDAY_RUN, planInput, settings, vehicle,
} from '../domain/plan-fixtures.helper-spec.js';
import { InsertionLotPlanner } from './insertion-lot-planner.js';

const WEDNESDAY = '2026-10-14';
const THURSDAY = '2026-10-15';

function planner(osrm = new FakeOsrm()) {
    return { osrm, planner: new InsertionLotPlanner(osrm) };
}

describe('InsertionLotPlanner', () => {
    describe('a valid route', () => {
        it('groups the orders of a zone in one batch for D2, in the smallest vehicle, ordered by proximity', async () => {
            const { planner: p } = planner();
            const input = planInput({
                dispatches: [dispatch(1, { km: 4 }), dispatch(2, { km: 1 }), dispatch(3, { km: 3 }), dispatch(4, { km: 2 })],
                vehicles: [vehicle(1, 1000), vehicle(2, 100)],
            });

            const proposal = await p.plan(input);

            expect(proposal.unplanned).toEqual([]);
            expect(proposal.batches).toHaveLength(1);
            const [batch] = proposal.batches;
            expect(batch).toMatchObject({ shiftDate: WEDNESDAY, zoneId: 1, warehouseId: 1, vehicleId: 2, proposedDriverId: 10 });
            expect(batch.stops.map((stop) => [stop.dispatchId, stop.sequence])).toEqual([[2, 1], [4, 2], [3, 3], [1, 4]]);
        });

        it('asks OSRM once per zone and warehouse, with the depot first', async () => {
            const { osrm, planner: p } = planner();
            await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2), dispatch(3, { zoneId: 2 })],
                vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
            }));

            expect(osrm.calls).toHaveLength(2);
            expect(osrm.calls[0]).toHaveLength(3);
            expect(osrm.calls[0][0]).toEqual({ lat: -16.5, lon: -68.1 });
        });

        it('makes one batch per zone: a batch never mixes zones (D-06)', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2, { zoneId: 2 })],
                vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
            }));

            expect(proposal.batches.map((b) => [b.zoneId, b.vehicleId])).toEqual([[1, 1], [2, 2]]);
        });
    });

    describe('dates', () => {
        it('takes D3 when the 12 h of the customer end after the cutoff of D-1', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                now: localInstant('2026-10-13', '08:30'),
                dispatches: [dispatch(1, { orderConfirmedAt: localInstant('2026-10-12', '18:30') })],
            }));

            expect(proposal.batches[0].shiftDate).toBe(THURSDAY);
        });

        it('opens an exception, never D4, when neither D2 nor D3 is viable, and asks OSRM nothing', async () => {
            const { osrm, planner: p } = planner();
            const proposal = await p.plan(planInput({
                now: localInstant('2026-10-15', '09:00'),
                dispatches: [dispatch(1)],
            }));

            expect(proposal.batches).toEqual([]);
            expect(proposal.unplanned).toEqual([
                expect.objectContaining({ dispatchId: 1, reason: 'deadline_exceeded', detail: expect.objectContaining({ motivo: 'no_viable_date' }) }),
            ]);
            expect(osrm.calls).toEqual([]);
        });

        it('keeps the agreed date of a rescheduled order without recomputing D2-D3 (D-49)', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1, { status: 'rescheduled', fixedDate: '2026-10-27' })],
            }));

            expect(proposal.batches[0].shiftDate).toBe('2026-10-27');
            expect(proposal.batches[0].rescheduledDispatchIds).toEqual([1]);
        });

        it.each([
            ['a Saturday', '2026-10-17'],
            ['a date whose cutoff already passed', '2026-10-13'],
        ])('alerts instead of planning a rescheduled order on %s', async (_label, fixedDate) => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                now: localInstant('2026-10-13', '16:00'),
                dispatches: [dispatch(1, { status: 'rescheduled', fixedDate })],
            }));

            expect(proposal.batches).toEqual([]);
            expect(proposal.unplanned[0]).toMatchObject({ dispatchId: 1, reason: 'rescheduled_date_not_plannable' });
        });
    });

    describe('vehicles', () => {
        it('uses one vehicle per day: the second zone waits for D3 when there is only one vehicle', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2, { zoneId: 2 })],
                vehicles: [vehicle(1, 1000)],
            }));

            expect(proposal.batches.map((b) => [b.zoneId, b.shiftDate, b.vehicleId])).toEqual([
                [1, WEDNESDAY, 1],
                [2, THURSDAY, 1],
            ]);
        });

        it('does not take a vehicle that an existing batch already holds that day', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1)],
                vehicles: [vehicle(1, 100), vehicle(2, 1000)],
                existingBatches: [{ shiftDate: WEDNESDAY, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
            }));

            expect(proposal.batches[0]).toMatchObject({ shiftDate: WEDNESDAY, vehicleId: 2 });
        });

        it('reports an order that fits no vehicle and plans the others', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2, { estimatedWeightKg: 9000 })],
                vehicles: [vehicle(1, 100)],
            }));

            expect(proposal.unplanned).toEqual([
                expect.objectContaining({
                    dispatchId: 2,
                    reason: 'no_vehicle_fits',
                    detail: { zoneId: 1, zoneCode: 'ZON-1', zoneName: 'Zona 1' },
                }),
            ]);
            expect(proposal.batches[0].stops.map((s) => s.dispatchId)).toEqual([1]);
        });

        it('turns the exception into deadline_exceeded when no vehicle is free on any viable date', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1)],
                vehicles: [vehicle(1, 1000)],
                existingBatches: [
                    { shiftDate: WEDNESDAY, vehicleId: 1, driverId: null, proposedDriverId: 10 },
                    { shiftDate: THURSDAY, vehicleId: 1, driverId: null, proposedDriverId: 10 },
                ],
            }));

            expect(proposal.batches).toEqual([]);
            expect(proposal.unplanned[0]).toMatchObject({
                dispatchId: 1,
                reason: 'deadline_exceeded',
                detail: { motivo: 'no_vehicle_available' },
            });
        });

        it('divides by proximity when the zone does not fit one vehicle, warning nothing', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [
                    dispatch(1, { km: 20, estimatedWeightKg: 60 }), dispatch(2, { km: 1, estimatedWeightKg: 60 }),
                    dispatch(3, { km: 21, estimatedWeightKg: 60 }), dispatch(4, { km: 2, estimatedWeightKg: 60 }),
                ],
                vehicles: [vehicle(1, 130), vehicle(2, 130)],
            }));

            expect(proposal.batches.map((b) => b.stops.map((s) => s.dispatchId))).toEqual([[1, 3], [2, 4]]);
            expect(proposal.batches.every((b) => b.splitReason === 'capacity')).toBe(true);
        });
    });

    describe('drivers', () => {
        it('gives each batch of the day a different driver (D-21)', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2, { zoneId: 2 })],
                vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
                driverIds: [10, 11],
            }));

            expect(proposal.batches.map((b) => b.proposedDriverId)).toEqual([10, 11]);
        });

        it('balances by the batches the driver already has that week, then by id', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1)],
                driverIds: [10, 11],
                existingBatches: [{ shiftDate: '2026-10-12', vehicleId: 9, driverId: null, proposedDriverId: 10 }],
            }));

            expect(proposal.batches[0].proposedDriverId).toBe(11);
        });

        it('creates the batch without driver and warns when every driver is busy that day', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                dispatches: [dispatch(1), dispatch(2, { zoneId: 2 })],
                vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
                driverIds: [10],
            }));

            expect(proposal.batches.map((b) => b.proposedDriverId)).toEqual([10, null]);
            expect(proposal.warnings.filter((w) => w.kind === 'no_driver_available')).toEqual([
                expect.objectContaining({
                    kind: 'no_driver_available',
                    detail: expect.objectContaining({ zoneId: 2, zoneCode: 'ZON-2', zoneName: 'Zona 2' }),
                }),
            ]);
        });

        it('works with no drivers at all', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({ dispatches: [dispatch(1)], driverIds: [] }));

            expect(proposal.batches[0].proposedDriverId).toBeNull();
            expect(proposal.warnings.map((w) => w.kind)).toContain('no_driver_available');
        });
    });

    describe('warnings that never block', () => {
        it('warns when a batch has fewer orders than plan_min_orders_per_route, and still creates it', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                settings: settings({ plan_min_orders_per_route: '3' }),
                dispatches: [dispatch(1), dispatch(2)],
            }));

            expect(proposal.batches).toHaveLength(1);
            expect(proposal.warnings).toEqual([
                expect.objectContaining({
                    kind: 'below_min_orders',
                    detail: expect.objectContaining({ zoneCode: 'ZON-1', zoneName: 'Zona 1', stops: 2, minimum: 3 }),
                }),
            ]);
        });

        it('does not warn when there is no minimum configured', async () => {
            const { planner: p } = planner();
            const raw = { plan_min_orders_per_route: '' };
            const proposal = await p.plan(planInput({ settings: settings(raw), dispatches: [dispatch(1)] }));

            expect(proposal.warnings.map((w) => w.kind)).not.toContain('below_min_orders');
        });

        it('limits a batch to one stop less than the table limit and warns the split', async () => {
            const osrm = new FakeOsrm(4);
            const { planner: p } = planner(osrm);
            const proposal = await p.plan(planInput({
                settings: settings({ plan_min_orders_per_route: '1' }),
                dispatches: Array.from({ length: 7 }, (_, i) => dispatch(i + 1)),
                vehicles: [vehicle(1, 1000), vehicle(2, 1000), vehicle(3, 1000)],
            }));

            expect(Math.max(...proposal.batches.map((b) => b.stops.length))).toBe(3);
            expect(proposal.batches.flatMap((b) => b.stops)).toHaveLength(7);
            const split = proposal.warnings.find((w) => w.kind === 'lot_split_by_table_limit');
            expect(split).toBeDefined();
            expect(split!.detail).toMatchObject({ zoneCode: 'ZON-1', zoneName: 'Zona 1' });
        });
    });

    describe('zone deleted from the catalog', () => {
        const quiet = { plan_min_orders_per_route: '' };

        it('plans a group of an active zone with no zone_deleted warning', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                settings: settings(quiet),
                dispatches: [dispatch(1), dispatch(2)],
            }));

            expect(proposal.batches).toHaveLength(1);
            expect(proposal.warnings.map((w) => w.kind)).not.toContain('zone_deleted');
        });

        it('plans a group of a deleted zone all the same and warns exactly once, listing every order', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                settings: settings(quiet),
                dispatches: [1, 2, 3].map((id) => dispatch(id, { zoneDeleted: true, zoneCode: 'ZON-SUR', zoneName: 'Achumani' })),
            }));

            expect(proposal.batches).toHaveLength(1);
            expect(proposal.batches[0]).toMatchObject({ zoneCode: 'ZON-SUR', zoneName: 'Achumani' });
            expect(proposal.warnings).toEqual([
                {
                    kind: 'zone_deleted',
                    detail: {
                        zoneId: 1, zoneCode: 'ZON-SUR', zoneName: 'Achumani',
                        shiftDate: WEDNESDAY, dispatchIds: [1, 2, 3],
                    },
                },
            ]);
        });

        it('warns only for the deleted zone when two zones share the day', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                settings: settings(quiet),
                dispatches: [dispatch(1), dispatch(2, { zoneId: 2, zoneDeleted: true }), dispatch(3, { zoneId: 2, zoneDeleted: true })],
                vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
            }));

            expect(proposal.batches).toHaveLength(2);
            const deleted = proposal.warnings.filter((w) => w.kind === 'zone_deleted');
            expect(deleted).toHaveLength(1);
            expect(deleted[0].detail).toMatchObject({ zoneId: 2, dispatchIds: [2, 3] });
        });

        it('lists only the orders that got a batch each day, so one that waited is not repeated', async () => {
            const { planner: p } = planner();
            const proposal = await p.plan(planInput({
                settings: settings(quiet),
                dispatches: [
                    dispatch(1, { zoneDeleted: true, estimatedWeightKg: 80 }),
                    dispatch(2, { zoneDeleted: true, estimatedWeightKg: 80 }),
                ],
                vehicles: [vehicle(1, 100)],
            }));

            const deleted = proposal.warnings.filter((w) => w.kind === 'zone_deleted');
            expect(deleted.map((w) => [w.detail.shiftDate, w.detail.dispatchIds])).toEqual([
                [WEDNESDAY, [1]],
                [THURSDAY, [2]],
            ]);
        });
    });

    describe('OSRM down', () => {
        it('rejects with 503 and proposes nothing', async () => {
            const osrm = new FakeOsrm();
            osrm.failWith = new OsrmUnavailableException(5000);
            const { planner: p } = planner(osrm);

            await expect(p.plan(planInput({ dispatches: [dispatch(1)] }))).rejects.toBeInstanceOf(OsrmUnavailableException);
        });
    });

    it('serves an urgent order first when a single vehicle can carry only one of them', async () => {
        const { planner: p } = planner();
        // The repository hands the queue in order: urgent first.
        const proposal = await p.plan(planInput({
            now: MONDAY_RUN,
            dispatches: [
                dispatch(2, { priority: 'urgent', estimatedWeightKg: 80 }),
                dispatch(1, { estimatedWeightKg: 80 }),
            ],
            vehicles: [vehicle(1, 100)],
        }));

        expect(proposal.batches.map((b) => [b.shiftDate, b.stops.map((s) => s.dispatchId)])).toEqual([
            [WEDNESDAY, [2]],
            [THURSDAY, [1]],
        ]);
    });
});
