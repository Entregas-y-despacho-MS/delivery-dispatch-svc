import { describe, expect, it } from 'vitest';
import { localInstant } from '../domain/operating-calendar.js';
import {
    dispatch, FakeOsrm, openBatch, openStop, planInput, settings, vehicle,
} from '../domain/plan-fixtures.helper-spec.js';
import { InsertionLotPlanner } from './insertion-lot-planner.js';

// Run: Monday 2026-10-12 08:30. Orders confirmed Monday 08:00 → D2 Wednesday, D3 Thursday.
const WED = '2026-10-14';
const THU = '2026-10-15';
const quiet = { plan_min_orders_per_route: '' };
const at = (date: string, time: string) => localInstant(date, time);

function planner() {
    return new InsertionLotPlanner(new FakeOsrm());
}

describe('slots of a new batch', () => {
    it('gives every stop the 2 h slot of its arrival, in route order', async () => {
        // 1 km = 1 min; 20 % margin; 15 min of service: arrivals 09:01.2, 09:26.4, 09:51.6 ... all in 09-11.
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 1 }), dispatch(2, { km: 2 }), dispatch(3, { km: 3 })],
        }));

        const stops = proposal.batches[0].stops;
        expect(stops.map((s) => s.dispatchId)).toEqual([1, 2, 3]);
        for (const stop of stops) {
            expect(stop.windowStart).toEqual(at(WED, '09:00'));
            expect(stop.windowEnd).toEqual(at(WED, '11:00'));
        }
    });

    it('moves the later stops to the next slots as the route advances', async () => {
        // 5 stops 1 km apart with 45 min of service: arrivals ~09:01, 09:47, 10:33, 11:19, 12:05.
        const proposal = await planner().plan(planInput({
            settings: settings({ ...quiet, stop_service_minutes: '45' }),
            dispatches: [1, 2, 3, 4, 5].map((id) => dispatch(id, { km: id })),
        }));

        const windows = proposal.batches[0].stops.map((s) => [s.windowStart!.toISOString(), s.windowEnd!.toISOString()]);
        expect(windows.map(([start]) => start)).toEqual([
            at(WED, '09:00'), at(WED, '09:00'), at(WED, '09:00'), at(WED, '11:00'), at(WED, '11:00'),
        ].map((d) => d.toISOString()));
    });

    it('keeps the window agreed with the customer for a rescheduled order and waits for it', async () => {
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, {
                status: 'rescheduled', fixedDate: WED, km: 1,
                agreedWindow: { start: at(WED, '14:00'), end: at(WED, '16:00') },
            })],
        }));

        const [stop] = proposal.batches[0].stops;
        expect(stop.windowStart).toEqual(at(WED, '14:00'));
        expect(stop.windowEnd).toEqual(at(WED, '16:00'));
    });

    it('does not put in the batch an order the day cannot reach, and tells why when no date is left', async () => {
        // 2000 km is 33 hours: no slot is ever reachable, on any date.
        const proposal = await planner().plan(planInput({
            dispatches: [dispatch(1, { km: 1 }), dispatch(2, { km: 2000 })],
        }));

        expect(proposal.batches[0].stops.map((s) => s.dispatchId)).toEqual([1]);
        expect(proposal.unplanned).toEqual([
            expect.objectContaining({
                dispatchId: 2, reason: 'deadline_exceeded', detail: expect.objectContaining({ motivo: 'no_feasible_route' }),
            }),
        ]);
    });

    it('opens a second batch with another vehicle when the route would end after the afternoon window', async () => {
        // 6 stops of 90 min each end at 18:30 in one route: the sixth goes to another vehicle.
        const proposal = await planner().plan(planInput({
            settings: settings({ ...quiet, stop_service_minutes: '90' }),
            dispatches: [1, 2, 3, 4, 5, 6].map((id) => dispatch(id, { km: 1 })),
            vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
        }));

        expect(proposal.batches.map((b) => b.stops.length)).toEqual([5, 1]);
        expect(proposal.batches.map((b) => b.vehicleId)).toEqual([1, 2]);
        expect(proposal.unplanned).toEqual([]);
    });

    it('sends that sixth order to the next date when there is no other vehicle', async () => {
        const proposal = await planner().plan(planInput({
            settings: settings({ ...quiet, stop_service_minutes: '90' }),
            dispatches: [1, 2, 3, 4, 5, 6].map((id) => dispatch(id, { km: 1 })),
            vehicles: [vehicle(1, 1000)],
        }));

        expect(proposal.batches.map((b) => [b.shiftDate, b.stops.length])).toEqual([[WED, 5], [THU, 1]]);
    });
});

describe('late orders into an open batch', () => {
    const base = () => [
        openStop(WED, 101, 1, { km: 1, notified: true, window: ['09:00', '11:00'] }),
        openStop(WED, 102, 2, { km: 5 }),
        openStop(WED, 103, 3, { km: 10 }),
    ];

    it('inserts at the cheapest position, renumbers the whole batch and leaves the notified window alone', async () => {
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 3 })],
            openBatches: [openBatch(WED, base())],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
        }));

        expect(proposal.batches).toEqual([]);
        expect(proposal.insertions).toHaveLength(1);
        const [insertion] = proposal.insertions;
        expect(insertion).toMatchObject({ routeBatchId: 500, expectedVersion: 3, shiftDate: WED, insertedDispatchIds: [1] });
        expect(insertion.stops.map((s) => [s.dispatchId, s.sequence, s.previousSequence, s.isNew])).toEqual([
            [101, 1, 1, false],
            [1, 2, null, true],
            [102, 3, 2, false],
            [103, 4, 3, false],
        ]);
        // The notified stop is not touched; the others get a proposal.
        expect(insertion.stops[0]).toMatchObject({ windowStart: null, windowEnd: null });
        expect(insertion.stops[1].windowStart).toEqual(at(WED, '09:00'));
    });

    it('discards the cheapest position when it would push a notified stop out of its slot', async () => {
        // Notified stop 101 at 5 km, told 09:00-09:15 (arrives 09:06). The late order at 2 km is on the way,
        // but 15 min of service before it would put 101 at 09:21.
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 2 })],
            openBatches: [openBatch(WED, [openStop(WED, 101, 1, { km: 5, notified: true, window: ['09:00', '09:15'] })])],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
        }));

        const [insertion] = proposal.insertions;
        expect(insertion.stops.map((s) => s.dispatchId)).toEqual([101, 1]);
        expect(insertion.stops[0]).toMatchObject({ sequence: 1, windowStart: null, windowEnd: null });
    });

    it('opens a new batch in the same zone when no position keeps the route inside the day', async () => {
        // The open batch has five stops of 90 min: it already ends at 17:00, so one more at any
        // position ends after 18:00. A second vehicle takes the late order in a new batch.
        const stops = [1, 2, 3, 4, 5].map((n) => openStop(WED, 100 + n, n, { km: 1, notified: n === 1, window: n === 1 ? ['09:00', '11:00'] : undefined }));
        const proposal = await planner().plan(planInput({
            settings: settings({ ...quiet, stop_service_minutes: '90' }),
            dispatches: [dispatch(1, { km: 1 })],
            openBatches: [openBatch(WED, stops)],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
            vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
        }));

        expect(proposal.insertions).toEqual([]);
        expect(proposal.batches).toHaveLength(1);
        expect(proposal.batches[0]).toMatchObject({ shiftDate: WED, vehicleId: 2, zoneId: 1 });
    });

    it('waits for the next date when it fits nowhere and there is no other vehicle', async () => {
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 3, estimatedWeightKg: 50 })],
            openBatches: [openBatch(WED, [openStop(WED, 101, 1, { km: 1, estimatedWeightKg: 80 })])],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
            vehicles: [vehicle(1, 100)],
        }));

        expect(proposal.insertions).toEqual([]);
        expect(proposal.batches).toHaveLength(1);
        expect(proposal.batches[0]).toMatchObject({ shiftDate: THU, vehicleId: 1 });
    });

    it('does not insert when it would break the capacity of the batch vehicle', async () => {
        const proposal = await planner().plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 2, estimatedWeightKg: 30 })],
            openBatches: [openBatch(WED, [openStop(WED, 101, 1, { km: 1, estimatedWeightKg: 80 })])],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
            vehicles: [vehicle(1, 100), vehicle(2, 500)],
        }));

        expect(proposal.insertions).toEqual([]);
        expect(proposal.batches[0]).toMatchObject({ shiftDate: WED, vehicleId: 2 });
    });

    it('never inserts into a batch whose cutoff has passed: it waits for the next one', async () => {
        // Tuesday 16:00: the cutoff of Wednesday (Tuesday 15:00) passed; the order can only be Thursday.
        const proposal = await planner().plan(planInput({
            now: at('2026-10-13', '16:00'),
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 3 })],
            openBatches: [openBatch(WED, base())],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
        }));

        expect(proposal.insertions).toEqual([]);
        expect(proposal.batches[0]).toMatchObject({ shiftDate: THU });
    });

    it('respects the stop limit of the table request in an open batch', async () => {
        const osrm = new FakeOsrm(3); // max 2 stops per batch
        const proposal = await new InsertionLotPlanner(osrm).plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 3 })],
            openBatches: [openBatch(WED, [
                openStop(WED, 101, 1, { km: 1 }),
                openStop(WED, 102, 2, { km: 2 }),
            ])],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
            vehicles: [vehicle(1, 1000), vehicle(2, 1000)],
        }));

        expect(proposal.insertions).toEqual([]);
        expect(proposal.batches[0]).toMatchObject({ shiftDate: WED, vehicleId: 2 });
    });

    it('asks OSRM one matrix per zone with the open stops and the late orders together', async () => {
        const osrm = new FakeOsrm();
        await new InsertionLotPlanner(osrm).plan(planInput({
            settings: settings(quiet),
            dispatches: [dispatch(1, { km: 3 })],
            openBatches: [openBatch(WED, base())],
            existingBatches: [{ shiftDate: WED, vehicleId: 1, driverId: null, proposedDriverId: 10 }],
        }));

        expect(osrm.calls).toHaveLength(1);
        expect(osrm.calls[0]).toHaveLength(1 + 3 + 1);
    });
});
