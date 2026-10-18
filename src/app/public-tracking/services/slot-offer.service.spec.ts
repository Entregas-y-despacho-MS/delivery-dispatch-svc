import { describe, expect, it, vi } from 'vitest';
import { OsrmUnavailableException } from '../../../plugins/osrm/exceptions/index.js';
import { localInstant } from '../../planning/domain/operating-calendar.js';
import {
    FakeOsrm, MONDAY_RUN, RAW_SETTINGS, WAREHOUSE, dispatch, openBatch, openStop, vehicle,
} from '../../planning/domain/plan-fixtures.helper-spec.js';
import type { OpenBatch, PlanDispatch } from '../../planning/domain/plan-types.js';
import { buildSlotId, parseSlotId } from '../domain/slot-offer.js';
import type { TrackingContext } from './public-tracking.service.js';
import { SlotOfferService } from './slot-offer.service.js';

// Monday 2026-10-12 08:30. The order was confirmed that morning: D2 is Wednesday the 14th, D3 Thursday the 15th.
// The customer is in a batch of Thursday the 15th, so the range is the 14th to the 17th.
const NOW = MONDAY_RUN;
const OWN_BATCH = 600;
const slotOf = (date: string, start: string) => localInstant(date, start);

interface Setup {
    settings?: Record<string, string>;
    batches?: OpenBatch[];
    vehicles?: ReturnType<typeof vehicle>[];
    own?: { dispatch: PlanDispatch; routeBatchId: number | null; shiftDate: string | null } | null;
    osrm?: FakeOsrm;
    proofIsValid?: boolean;
}

function setup(options: Setup = {}) {
    const osrm = options.osrm ?? new FakeOsrm();
    const values: Record<string, string> = {
        ...(RAW_SETTINGS as Record<string, string>),
        warehouse_prep_end_time: '08:15',
        warehouse_prep_lead_minutes: '60',
        reschedule_window_days: '2',
        ...options.settings,
    };
    const settings = {
        getString: vi.fn(async (key: string, fallback: string) => values[key] ?? fallback),
        getNumber: vi.fn(async (key: string, fallback: number) => (values[key] === undefined ? fallback : Number(values[key]))),
    };
    const own = options.own === undefined
        ? { dispatch: dispatch(1, { status: 'scheduled', km: 1 }), routeBatchId: OWN_BATCH, shiftDate: '2026-10-15' }
        : options.own;
    const planning = {
        findForRescheduling: vi.fn(async () => own),
        findOpenBatches: vi.fn(async () => options.batches ?? []),
        findVehicles: vi.fn(async () => options.vehicles ?? [vehicle(1, 1000), vehicle(2, 1000)]),
        findWarehouses: vi.fn(async () => [WAREHOUSE]),
    };
    const verification = { hasValidProof: vi.fn(async () => options.proofIsValid ?? true) };
    const service = new SlotOfferService(planning as any, osrm, settings as any, verification as any);
    return { service, planning, osrm, settings, verification };
}

function context(overrides: { canReschedule?: boolean; closedReason?: string | null } = {}): TrackingContext {
    return {
        dispatchId: 1,
        status: 'scheduled',
        version: 1,
        row: { contact_email: 'customer@example.test', has_contact_email: true } as any,
        selfService: {
            open: true,
            closedReason: (overrides.closedReason ?? null) as any,
            windowClosesAt: new Date(),
            rescheduleAttemptsLeft: 2,
            canConfirm: true,
            canReschedule: overrides.canReschedule ?? true,
            canRequestChange: true,
        },
    };
}

/** An open batch of the zone with one stop already told its window. */
const wednesday = (over: Partial<OpenBatch> = {}) =>
    openBatch('2026-10-14', [openStop('2026-10-14', 20, 1, { km: 2, notified: true, window: ['09:00', '11:00'] })], { routeBatchId: 500, ...over });

describe('SlotOfferService.computeOffers', () => {
    it('offers the slot the plan would give the stop in an open batch of its zone', async () => {
        const { service, osrm } = setup({ batches: [wednesday()] });

        const { offers, unavailableReason } = await service.computeOffers(1, NOW);

        expect(unavailableReason).toBeNull();
        expect(offers).toHaveLength(1);
        expect(offers[0]).toMatchObject({
            routeBatchId: 500, batchVersion: 3, deliveryDate: '2026-10-14',
            windowStart: slotOf('2026-10-14', '09:00'), windowEnd: slotOf('2026-10-14', '11:00'),
        });
        // One matrix for the depot, the customer's stop and the stops of the batch.
        expect(osrm.calls).toHaveLength(1);
        expect(osrm.calls[0]).toHaveLength(3);
    });

    it('keeps the window a notified customer was told: the route it describes never moves it', async () => {
        const { service } = setup({ batches: [wednesday()] });

        const [offer] = (await service.computeOffers(1, NOW)).offers;

        const told = offer.route.find((stop) => stop.id === 20)!;
        expect(told.fixed).toBe(true);
        expect(told.window).toEqual({ startMinute: 9 * 60, endMinute: 11 * 60 });
        expect(offer.route.map((stop) => stop.id)).toContain(1);
    });

    it('never offers the batch the dispatch is already in', async () => {
        const { service } = setup({ batches: [wednesday({ routeBatchId: OWN_BATCH })] });

        expect(await service.computeOffers(1, NOW)).toEqual({ offers: [], unavailableReason: 'no_slots' });
    });

    it('asks the repository for its own zone and warehouse only, and ignores a batch of another that slips through', async () => {
        const { service, planning } = setup({
            batches: [wednesday({ routeBatchId: 501, zoneId: 9 }), wednesday({ routeBatchId: 502, warehouseId: 2 })],
        });

        const result = await service.computeOffers(1, NOW);

        expect(planning.findOpenBatches).toHaveBeenCalledWith('2026-10-12', { zoneId: 1, warehouseId: 1 });
        expect(result.offers).toEqual([]);
    });

    it('offers only dates from D2 to reschedule_window_days after the current one', async () => {
        const { service } = setup({
            batches: [
                wednesday({ routeBatchId: 501, shiftDate: '2026-10-13', vehicleId: 2 }),
                wednesday({ routeBatchId: 502, shiftDate: '2026-10-17' }),
                wednesday({ routeBatchId: 503, shiftDate: '2026-10-19', vehicleId: 2 }),
            ],
        });

        const { offers } = await service.computeOffers(1, NOW);

        expect(offers.map((offer) => offer.deliveryDate)).toEqual(['2026-10-17']);
    });

    it('stops offering a batch the minute its cutoff passes', async () => {
        const batches = [wednesday()];
        const beforeCutoff = setup({ batches });
        const afterCutoff = setup({ batches });

        const before = await beforeCutoff.service.computeOffers(1, new Date(localInstant('2026-10-13', '15:00').getTime() - 1));
        const after = await afterCutoff.service.computeOffers(1, localInstant('2026-10-13', '15:00'));

        expect(before.offers).toHaveLength(1);
        expect(after).toEqual({ offers: [], unavailableReason: 'no_slots' });
        expect(afterCutoff.osrm.calls).toHaveLength(0);
    });

    it('respects the lead time of the warehouse', async () => {
        const justBeforeCutoff = new Date(localInstant('2026-10-13', '15:00').getTime() - 60_000);
        const tight = setup({ batches: [wednesday()], settings: { warehouse_prep_lead_minutes: '1440' } });
        const enough = setup({ batches: [wednesday()], settings: { warehouse_prep_lead_minutes: '60' } });

        expect((await tight.service.computeOffers(1, justBeforeCutoff)).offers).toEqual([]);
        expect((await enough.service.computeOffers(1, justBeforeCutoff)).offers).toHaveLength(1);
    });

    it('does not offer a batch whose vehicle cannot hold the load, or that is not in the active fleet', async () => {
        const small = setup({ batches: [wednesday()], vehicles: [vehicle(1, 5)] });
        const inactive = setup({ batches: [wednesday()], vehicles: [vehicle(2, 1000)] });

        expect((await small.service.computeOffers(1, NOW)).offers).toEqual([]);
        expect((await inactive.service.computeOffers(1, NOW)).offers).toEqual([]);
    });

    it('does not offer a batch that would not fit in one routing table', async () => {
        const { service } = setup({ batches: [wednesday()], osrm: new FakeOsrm(2) });

        expect((await service.computeOffers(1, NOW)).offers).toEqual([]);
    });

    it('does not offer a batch where a notified customer would be pushed out of their window', async () => {
        // The told customer is at 100 km: reaching them before 09:30 is impossible, and so is any detour.
        const farAway = openBatch('2026-10-14', [
            openStop('2026-10-14', 20, 1, { km: 100, notified: true, window: ['09:00', '09:30'] }),
        ], { routeBatchId: 500 });
        const { service } = setup({ batches: [farAway] });

        expect((await service.computeOffers(1, NOW)).offers).toEqual([]);
    });

    it('lists one slot per date and time even when two batches can take the customer', async () => {
        const { service } = setup({ batches: [wednesday({ routeBatchId: 501, vehicleId: 2 }), wednesday({ routeBatchId: 500 })] });

        const { offers } = await service.computeOffers(1, NOW);

        expect(offers).toHaveLength(1);
        expect(offers[0].routeBatchId).toBe(500);
    });

    it('offers several slots of the same date from different batches, earliest first', async () => {
        // A second batch whose first stop is told the afternoon: the customer lands in the afternoon there.
        const afternoon = openBatch('2026-10-14', [
            openStop('2026-10-14', 30, 1, { km: 2, notified: true, window: ['14:00', '16:00'] }),
        ], { routeBatchId: 501, vehicleId: 2 });
        const { service } = setup({ batches: [afternoon, wednesday()] });

        const { offers } = await service.computeOffers(1, NOW);

        expect(offers.length).toBeGreaterThanOrEqual(1);
        const starts = offers.map((offer) => offer.windowStart.getTime());
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
    });

    describe('when it cannot say', () => {
        it('reports planning_not_configured without asking OSRM when a planning setting is blank', async () => {
            const { service, osrm, planning } = setup({ batches: [wednesday()], settings: { stop_service_minutes: '' } });

            expect(await service.computeOffers(1, NOW)).toEqual({ offers: [], unavailableReason: 'planning_not_configured' });
            expect(osrm.calls).toHaveLength(0);
            expect(planning.findOpenBatches).not.toHaveBeenCalled();
        });

        it('reports no_location for a dispatch that cannot be simulated or has no route', async () => {
            const missing = setup({ batches: [wednesday()], own: null });
            const noRoute = setup({ batches: [wednesday()], own: { dispatch: dispatch(1, { status: 'scheduled' }), routeBatchId: null, shiftDate: null } });

            expect((await missing.service.computeOffers(1, NOW)).unavailableReason).toBe('no_location');
            expect((await noRoute.service.computeOffers(1, NOW)).unavailableReason).toBe('no_location');
        });

        it('reports no_slots when there is no open batch at all', async () => {
            const { service, osrm } = setup({ batches: [] });

            expect(await service.computeOffers(1, NOW)).toEqual({ offers: [], unavailableReason: 'no_slots' });
            expect(osrm.calls).toHaveLength(0);
        });

        it('lets an OSRM outage out as a 503 instead of an empty list', async () => {
            const osrm = new FakeOsrm();
            osrm.failWith = new OsrmUnavailableException();
            const { service } = setup({ batches: [wednesday()], osrm });

            await expect(service.computeOffers(1, NOW)).rejects.toBeInstanceOf(OsrmUnavailableException);
        });
    });
});

describe('SlotOfferService.offer', () => {
    it('answers only what the page needs: an id to choose, the date and the slot', async () => {
        const { service } = setup({ batches: [wednesday()] });

        const result = await service.offer(context(), 'a'.repeat(64), NOW);

        expect(result).toEqual({
            slots: [{
                slotId: buildSlotId(500, slotOf('2026-10-14', '09:00')),
                deliveryDate: '2026-10-14',
                windowStart: slotOf('2026-10-14', '09:00'),
                windowEnd: slotOf('2026-10-14', '11:00'),
            }],
            unavailableReason: null,
        });
        expect(parseSlotId(result.slots[0].slotId)).toEqual({ routeBatchId: 500, windowStart: slotOf('2026-10-14', '09:00') });
        expect(JSON.stringify(result)).not.toMatch(/version|position|cost|route"|vehicle|zone/i);
    });

    it('needs the proof of the verification code', async () => {
        const { service, planning, osrm } = setup({ batches: [wednesday()], proofIsValid: false });

        await expect(service.offer(context(), undefined, NOW)).rejects.toMatchObject({ status: 403, response: { error: 'VERIFICATION_REQUIRED' } });
        expect(planning.findOpenBatches).not.toHaveBeenCalled();
        expect(osrm.calls).toHaveLength(0);
    });

    it('checks the proof against this dispatch', async () => {
        const { service, verification } = setup({ batches: [wednesday()] });

        await service.offer(context(), 'b'.repeat(64), NOW);

        expect(verification.hasValidProof).toHaveBeenCalledWith(1, 'b'.repeat(64));
    });

    it('is a 409 when the self-service no longer allows rescheduling, before looking at the proof', async () => {
        const { service, verification } = setup({ batches: [wednesday()] });

        await expect(service.offer(context({ canReschedule: false, closedReason: 'window_elapsed' }), 'a'.repeat(64), NOW))
            .rejects.toMatchObject({ status: 409, response: { details: { reason: 'window_elapsed' } } });
        expect(verification.hasValidProof).not.toHaveBeenCalled();
    });

    it('answers an empty list with its reason when nothing fits', async () => {
        const { service } = setup({ batches: [] });

        expect(await service.offer(context(), 'a'.repeat(64), NOW)).toEqual({ slots: [], unavailableReason: 'no_slots' });
    });
});
