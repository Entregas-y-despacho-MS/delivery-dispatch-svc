import { Injectable } from '@nestjs/common';
import { OsrmPort } from '../../../plugins/osrm/osrm.port.js';
import { LotPlanner } from '../ports/lot-planner.js';
import {
    evaluateCandidateDates,
    rescheduledDateProblem,
    viableCandidateDates,
    weekStart,
} from '../domain/operating-calendar.js';
import { composeBatches, type DurationLookup } from '../domain/proximity-split.js';
import type {
    PlanDispatch,
    PlanInput,
    PlanProposal,
    PlanWarning,
    ProposedBatch,
    UnplannedDispatch,
} from '../domain/plan-types.js';

interface Waiting {
    /** Position in the queue the repository returned (urgent first, then oldest). */
    order: number;
    dispatch: PlanDispatch;
    /** Viable dates, earliest first; a rescheduled order has exactly its agreed one. */
    dates: string[];
    pointer: number;
}

interface ZoneMatrix {
    /** Matrix index of each dispatch (depot is 0). */
    indexOf: Map<number, number>;
    durations: (number | null)[][];
}

/**
 * Own implementation of LotPlanner (D-41): groups the orders of a day by zone and warehouse, gives each
 * group the smallest free vehicle where it fits, divides by proximity when it fits none, and hands a
 * driver to every batch. It never writes: it only proposes.
 */
@Injectable()
export class InsertionLotPlanner extends LotPlanner {
    constructor(private readonly osrm: OsrmPort) {
        super();
    }

    async plan(input: PlanInput): Promise<PlanProposal> {
        const { settings } = input;
        const unplanned: UnplannedDispatch[] = [];
        const warnings: PlanWarning[] = [];
        const batches: ProposedBatch[] = [];

        const waiting = this.resolveDates(input, unplanned);
        const matrices = await this.loadMatrices(input, waiting);

        // Vehicles and drivers are one per day (D-21). Seeded with the batches that already exist.
        const usedVehicles = new Map<string, Set<number>>();
        const busyDrivers = new Map<string, Set<number>>();
        const weeklyLoad = new Map<string, Map<number, number>>();
        const mark = <K>(map: Map<string, Set<K>>, date: string, value: K) => {
            if (!map.has(date)) map.set(date, new Set());
            map.get(date)!.add(value);
        };
        const countDriver = (date: string, driverId: number) => {
            const week = weekStart(date);
            if (!weeklyLoad.has(week)) weeklyLoad.set(week, new Map());
            const counts = weeklyLoad.get(week)!;
            counts.set(driverId, (counts.get(driverId) ?? 0) + 1);
        };
        for (const existing of input.existingBatches) {
            if (existing.vehicleId !== null) mark(usedVehicles, existing.shiftDate, existing.vehicleId);
            const driverId = existing.driverId ?? existing.proposedDriverId;
            if (driverId !== null) {
                mark(busyDrivers, existing.shiftDate, driverId);
                countDriver(existing.shiftDate, driverId);
            }
        }

        const pickDriver = (date: string): number | null => {
            const busy = busyDrivers.get(date);
            const counts = weeklyLoad.get(weekStart(date));
            const free = input.driverIds.filter((id) => !busy?.has(id));
            if (free.length === 0) return null;
            return [...free].sort(
                (a, b) => (counts?.get(a) ?? 0) - (counts?.get(b) ?? 0) || a - b,
            )[0];
        };

        const maxStops = Math.max(1, this.osrm.tableMaxCoordinates - 1);
        let active = waiting;
        while (active.length > 0) {
            const date = active.reduce((min, item) => (item.dates[item.pointer] < min ? item.dates[item.pointer] : min), active[0].dates[active[0].pointer]);
            const today = active.filter((item) => item.dates[item.pointer] === date);
            active = active.filter((item) => item.dates[item.pointer] !== date);

            const groups = new Map<string, Waiting[]>();
            for (const item of [...today].sort((a, b) => a.order - b.order)) {
                const key = zoneKey(item.dispatch);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(item);
            }

            for (const items of groups.values()) {
                const first = items[0].dispatch;
                const matrix = matrices.get(zoneKey(first))!;
                const group = items.map((item) => item.dispatch);
                const globalIndex = [0, ...group.map((dispatch) => matrix.indexOf.get(dispatch.dispatchId)!)];
                const duration: DurationLookup = (from, to) => matrix.durations[globalIndex[from]][globalIndex[to]];

                const free = input.vehicles.filter((vehicle) => !usedVehicles.get(date)?.has(vehicle.vehicleId));
                const composition = composeBatches(group, duration, free, input.vehicles, maxStops);

                for (const composed of composition.batches) {
                    const driverId = pickDriver(date);
                    mark(usedVehicles, date, composed.vehicle.vehicleId);
                    if (driverId !== null) {
                        mark(busyDrivers, date, driverId);
                        countDriver(date, driverId);
                    }

                    const batch: ProposedBatch = {
                        shiftDate: date,
                        zoneId: first.zoneId,
                        warehouseId: first.warehouseId,
                        vehicleId: composed.vehicle.vehicleId,
                        alternativeVehicleIds: composed.alternativeVehicles.map((vehicle) => vehicle.vehicleId),
                        proposedDriverId: driverId,
                        stops: composed.dispatches.map((dispatch, i) => ({ dispatchId: dispatch.dispatchId, sequence: i + 1 })),
                        splitReason: composition.splitReason,
                        rescheduledDispatchIds: composed.dispatches
                            .filter((dispatch) => dispatch.status === 'rescheduled')
                            .map((dispatch) => dispatch.dispatchId),
                    };
                    batches.push(batch);

                    if (driverId === null) {
                        warnings.push({ kind: 'no_driver_available', detail: { shiftDate: date, zoneId: first.zoneId, vehicleId: batch.vehicleId } });
                    }
                    const minimum = settings.minOrdersPerRoute;
                    if (minimum !== null && batch.stops.length < minimum) {
                        warnings.push({
                            kind: 'below_min_orders',
                            detail: { shiftDate: date, zoneId: first.zoneId, stops: batch.stops.length, minimum },
                        });
                    }
                }

                if (composition.splitReason === 'table_limit') {
                    warnings.push({
                        kind: 'lot_split_by_table_limit',
                        detail: { shiftDate: date, zoneId: first.zoneId, orders: group.length, maxStops },
                    });
                }

                for (const dispatch of composition.unfittable) {
                    unplanned.push({ dispatchId: dispatch.dispatchId, reason: 'no_vehicle_fits', detail: { zoneId: dispatch.zoneId } });
                }

                const byId = new Map(items.map((item) => [item.dispatch.dispatchId, item]));
                for (const dispatch of composition.withoutVehicle) {
                    const item = byId.get(dispatch.dispatchId)!;
                    item.pointer++;
                    if (item.pointer < item.dates.length) {
                        active.push(item);
                    } else if (dispatch.status === 'rescheduled') {
                        unplanned.push({ dispatchId: dispatch.dispatchId, reason: 'no_vehicle_available', detail: { date } });
                    } else {
                        unplanned.push({
                            dispatchId: dispatch.dispatchId,
                            reason: 'deadline_exceeded',
                            detail: { motivo: 'no_vehicle_available', dates: item.dates },
                        });
                    }
                }
            }
        }

        return { batches, unplanned, warnings };
    }

    /** First pass: which dates can each order take, and which ones already have none. */
    private resolveDates(input: PlanInput, unplanned: UnplannedDispatch[]): Waiting[] {
        const { now, settings } = input;
        const waiting: Waiting[] = [];
        input.dispatches.forEach((dispatch, order) => {
            if (dispatch.status === 'rescheduled') {
                const date = dispatch.fixedDate;
                const problem = date === null
                    ? 'no-agreed-date'
                    : rescheduledDateProblem(date, now, settings.calendar, settings.promiseRules.routeCutoffTime);
                if (problem !== null || date === null) {
                    unplanned.push({
                        dispatchId: dispatch.dispatchId,
                        reason: 'rescheduled_date_not_plannable',
                        detail: { date, problem },
                    });
                    return;
                }
                waiting.push({ order, dispatch, dates: [date], pointer: 0 });
                return;
            }

            const viable = viableCandidateDates(dispatch.orderConfirmedAt, now, settings.calendar, settings.promiseRules);
            if (viable.length === 0) {
                const evaluated = evaluateCandidateDates(dispatch.orderConfirmedAt, now, settings.calendar, settings.promiseRules);
                unplanned.push({
                    dispatchId: dispatch.dispatchId,
                    reason: 'deadline_exceeded',
                    detail: {
                        motivo: 'no_viable_date',
                        candidates: evaluated.map((c) => ({ operatingDay: c.operatingDay, date: c.date, cutoffAt: c.cutoffAt.toISOString() })),
                    },
                });
                return;
            }
            waiting.push({ order, dispatch, dates: viable.map((candidate) => candidate.date), pointer: 0 });
        });
        return waiting;
    }

    /**
     * One matrix per zone and warehouse, over every order that may be planned there (any date).
     * Every request is made before anything is decided, so an OSRM failure aborts with no side effects.
     */
    private async loadMatrices(input: PlanInput, waiting: Waiting[]): Promise<Map<string, ZoneMatrix>> {
        const warehouses = new Map(input.warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));
        const byKey = new Map<string, PlanDispatch[]>();
        for (const item of waiting) {
            const key = zoneKey(item.dispatch);
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key)!.push(item.dispatch);
        }

        const matrices = new Map<string, ZoneMatrix>();
        for (const [key, dispatches] of byKey) {
            const warehouse = warehouses.get(dispatches[0].warehouseId);
            if (!warehouse) throw new Error(`Warehouse ${dispatches[0].warehouseId} is not available for planning.`);
            const coordinates = [
                { lat: warehouse.latitude, lon: warehouse.longitude },
                ...dispatches.map((dispatch) => ({ lat: dispatch.latitude, lon: dispatch.longitude })),
            ];
            const { durations } = await this.osrm.getDurationMatrix(coordinates);
            matrices.set(key, {
                indexOf: new Map(dispatches.map((dispatch, i) => [dispatch.dispatchId, i + 1])),
                durations,
            });
        }
        return matrices;
    }
}

function zoneKey(dispatch: PlanDispatch): string {
    return `${dispatch.zoneId}:${dispatch.warehouseId}`;
}
