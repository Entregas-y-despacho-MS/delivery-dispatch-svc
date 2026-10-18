import { Injectable } from '@nestjs/common';
import { SettingsService } from '../../../modules/settings/services/settings.service.js';
import { OsrmPort } from '../../../plugins/osrm/osrm.port.js';
import { findInsertionOptions } from '../../planning/domain/insertion.js';
import { localDate } from '../../planning/domain/operating-calendar.js';
import type { OpenBatch, PlanDispatch, PlanVehicle } from '../../planning/domain/plan-types.js';
import { loadPlanningSettings } from '../../planning/domain/planning-settings.js';
import { buildSimParams } from '../../planning/domain/sim-params.js';
import { fitsVehicle } from '../../planning/domain/vehicle-selection.js';
import { toFreshSimStop, toSimStop } from '../../planning/services/insertion-lot-planner.js';
import { PlanCandidatesRepository } from '../../planning/services/plan-candidates.repository.js';
import {
    batchIsOfferable, buildSlotId, chooseOffers, minuteToInstant, offerDateRange,
    type OfferRules, type RescheduleOffer,
} from '../domain/slot-offer.js';
import type { AvailableSlotsDto } from '../dto/available-slots.dto.js';
import { VerificationRequiredException } from '../exceptions/index.js';
import {
    WAREHOUSE_PREP_LEAD_KEY, assertCanReschedule, type TrackingContext,
} from './public-tracking.service.js';
import { VerificationCodeService } from './verification-code.service.js';

const RESCHEDULE_WINDOW_DAYS_KEY = 'reschedule_window_days';
const WAREHOUSE_PREP_END_KEY = 'warehouse_prep_end_time';
const DEFAULT_RESCHEDULE_WINDOW_DAYS = 2;
const DEFAULT_PREP_END_TIME = '08:15';

export type OfferUnavailableReason = 'no_slots' | 'planning_not_configured' | 'no_location';

export interface OfferComputation {
    offers: RescheduleOffer[];
    unavailableReason: OfferUnavailableReason | null;
}

/**
 * The slots a customer can move to (ST-224.1, D-47, flow §2.2). It asks the plan generator's own question:
 * «can this stop go in that open batch?». The answer comes from the same pieces the generator uses for a late
 * order (open batches, cutoff, vehicle fit, route simulation with the fixed windows of notified stops), so the
 * page never shows an option the plan would refuse. Nothing is written here.
 *
 * It needs OSRM, and asks it BEFORE anything else could be opened or locked: a failure is a 503 with nothing to
 * undo. The offers are advisory; the rescheduling calls `computeOffers` again and checks the batch again under lock.
 */
@Injectable()
export class SlotOfferService {
    constructor(
        private readonly planning: PlanCandidatesRepository,
        private readonly osrm: OsrmPort,
        private readonly settings: SettingsService,
        private readonly verification: VerificationCodeService,
    ) {}

    async offer(context: TrackingContext, proof: string | undefined, now: Date = new Date()): Promise<AvailableSlotsDto> {
        assertCanReschedule(context);
        if (!(await this.verification.hasValidProof(context.dispatchId, proof))) throw new VerificationRequiredException();

        const { offers, unavailableReason } = await this.computeOffers(context.dispatchId, now);
        return {
            slots: offers.map((offer) => ({
                slotId: buildSlotId(offer.routeBatchId, offer.windowStart),
                deliveryDate: offer.deliveryDate,
                windowStart: offer.windowStart,
                windowEnd: offer.windowEnd,
            })),
            unavailableReason,
        };
    }

    /** Every slot the dispatch can be moved to right now, with what is needed to apply one. Read only. */
    async computeOffers(dispatchId: number, now: Date = new Date()): Promise<OfferComputation> {
        const planning = await loadPlanningSettings(this.settings);
        if (!planning.ok || !planning.values) return none('planning_not_configured');
        const settings = planning.values;

        const current = await this.planning.findForRescheduling(dispatchId);
        if (!current || current.shiftDate === null) return none('no_location');
        const { dispatch } = current;

        const rules: OfferRules = {
            now,
            calendar: settings.calendar,
            routeCutoffTime: settings.promiseRules.routeCutoffTime,
            minOperatingDays: settings.promiseRules.minOperatingDays,
            orderConfirmedAt: dispatch.orderConfirmedAt,
            currentShiftDate: current.shiftDate,
            rescheduleWindowDays: await this.settings.getNumber(RESCHEDULE_WINDOW_DAYS_KEY, DEFAULT_RESCHEDULE_WINDOW_DAYS),
            prepLeadMinutes: await this.settings.getNumber(WAREHOUSE_PREP_LEAD_KEY, 0),
            prepEndTime: await this.settings.getString(WAREHOUSE_PREP_END_KEY, DEFAULT_PREP_END_TIME),
        };
        const range = offerDateRange(rules);

        const [batches, vehicles, warehouses] = await Promise.all([
            this.planning.findOpenBatches(localDate(now), { zoneId: dispatch.zoneId, warehouseId: dispatch.warehouseId }),
            this.planning.findVehicles(),
            this.planning.findWarehouses(),
        ]);
        const warehouse = warehouses.find((candidate) => candidate.warehouseId === dispatch.warehouseId);
        if (!warehouse) return none('no_slots');

        const open = this.openBatchesThatFit(batches, vehicles, dispatch, current.routeBatchId, rules, range);
        if (open.length === 0) return none('no_slots');

        // One matrix for everything that will be simulated, asked before anything else.
        const members = new Map<number, PlanDispatch>([[dispatch.dispatchId, dispatch]]);
        for (const batch of open) for (const stop of batch.stops) members.set(stop.dispatch.dispatchId, stop.dispatch);
        const ordered = [...members.values()];
        const { durations } = await this.osrm.getDurationMatrix([
            { lat: warehouse.latitude, lon: warehouse.longitude },
            ...ordered.map((member) => ({ lat: member.latitude, lon: member.longitude })),
        ]);
        const indexOf = new Map(ordered.map((member, i) => [member.dispatchId, i + 1]));
        const params = buildSimParams(settings, (from, to) =>
            durations[from === null ? 0 : indexOf.get(from)!][indexOf.get(to)!]);

        const all: RescheduleOffer[] = [];
        for (const batch of open) {
            const stops = [...batch.stops].sort((a, b) => a.sequence - b.sequence);
            for (const option of findInsertionOptions(stops.map(toSimStop), toFreshSimStop(dispatch), params)) {
                all.push({
                    routeBatchId: batch.routeBatchId,
                    batchVersion: batch.version,
                    deliveryDate: batch.shiftDate,
                    windowStart: minuteToInstant(batch.shiftDate, option.window.startMinute),
                    windowEnd: minuteToInstant(batch.shiftDate, option.window.endMinute),
                    costSeconds: option.costSeconds,
                    position: option.position,
                    route: option.simulation.stops,
                });
            }
        }
        const offers = chooseOffers(all);
        return { offers, unavailableReason: offers.length === 0 ? 'no_slots' : null };
    }

    /**
     * Batches of the customer's zone and warehouse (the query already narrowed it) other than the one it is in, in
     * date, before the cutoff, with time for the warehouse, with an active vehicle that holds the load plus this
     * order and room for one more stop in a single OSRM table.
     */
    private openBatchesThatFit(
        batches: OpenBatch[],
        vehicles: PlanVehicle[],
        dispatch: PlanDispatch,
        currentBatchId: number | null,
        rules: OfferRules,
        range: ReturnType<typeof offerDateRange>,
    ): OpenBatch[] {
        const fleet = new Map(vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
        const maxStops = Math.max(1, this.osrm.tableMaxCoordinates - 1);
        return batches.filter((batch) => {
            if (batch.routeBatchId === currentBatchId) return false;
            if (batch.zoneId !== dispatch.zoneId || batch.warehouseId !== dispatch.warehouseId) return false;
            if (!batchIsOfferable(batch, rules, range)) return false;
            const vehicle = fleet.get(batch.vehicleId);
            if (!vehicle || batch.stops.length + 1 > maxStops) return false;
            return fitsVehicle([...batch.stops.map((stop) => stop.dispatch), dispatch], vehicle);
        });
    }
}

function none(unavailableReason: OfferUnavailableReason): OfferComputation {
    return { offers: [], unavailableReason };
}
