import { Injectable } from '@nestjs/common';
import { OsrmPort } from '../../../plugins/osrm/osrm.port.js';
import { LotPlanner } from '../ports/lot-planner.js';
import {
    cutoffBefore,
    evaluateCandidateDates,
    localInstant,
    minutesOfDay,
    rescheduledDateProblem,
    viableCandidateDates,
    weekStart,
} from '../domain/operating-calendar.js';
import { findCheapestInsertion, sequenceByInsertion } from '../domain/insertion.js';
import { composeBatches, type DurationLookup } from '../domain/proximity-split.js';
import type { SimParams, SimResult, SimStop } from '../domain/route-simulation.js';
import { buildTimeSlots } from '../domain/time-slots.js';
import { fitsVehicle } from '../domain/vehicle-selection.js';
import { toLocalMoment } from '../../scheduler/domain/task-schedule.js';
import type {
    InsertedStop,
    OpenBatch,
    OpenBatchStop,
    PlanDispatch,
    PlanInput,
    PlanProposal,
    PlanVehicle,
    PlanWarning,
    ProposedBatch,
    ProposedInsertion,
    ProposedStop,
    UnplannedDispatch,
} from '../domain/plan-types.js';

type Failure = 'no_vehicle_available' | 'no_feasible_route';

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

/** An open batch while the run decides which late orders go into it. */
interface OpenState {
    batch: OpenBatch;
    vehicle: PlanVehicle;
    stops: OpenBatchStop[];
    insertedIds: number[];
    simulation: SimResult | null;
}

/**
 * Own implementation of LotPlanner (D-41). For each day, zone and warehouse it first tries to insert
 * late orders into the batch that is already open (cheapest feasible position, without moving a
 * notified stop out of its window), and gives what is left new batches: the smallest free vehicle
 * where it fits, divided by proximity when it fits none, each batch sequenced by cheapest insertion
 * with the 2 h slots simulated. It never writes: it only proposes.
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
        const insertions: ProposedInsertion[] = [];

        const waiting = this.resolveDates(input, unplanned);
        const openStates = this.openStates(input);
        const matrices = await this.loadMatrices(input, waiting, openStates);

        const slots = buildTimeSlots(settings.morningWindow, settings.afternoonWindow, settings.slotDurationMinutes);
        const simParams = (matrix: ZoneMatrix): SimParams => ({
            slots,
            routeStartMinute: minutesOfDay(settings.morningWindow.start),
            routeEndMinute: minutesOfDay(settings.afternoonWindow.end),
            serviceMinutes: settings.stopServiceMinutes,
            marginPct: settings.planningMarginPct,
            travelSeconds: (from, to) =>
                matrix.durations[from === null ? 0 : matrix.indexOf.get(from)!][matrix.indexOf.get(to)!],
        });

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
            const date = active.reduce(
                (min, item) => (item.dates[item.pointer] < min ? item.dates[item.pointer] : min),
                active[0].dates[active[0].pointer],
            );
            const today = active.filter((item) => item.dates[item.pointer] === date);
            active = active.filter((item) => item.dates[item.pointer] !== date);

            const groups = new Map<string, Waiting[]>();
            for (const item of [...today].sort((a, b) => a.order - b.order)) {
                const key = zoneKey(item.dispatch);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(item);
            }

            for (const [key, items] of groups) {
                const first = items[0].dispatch;
                const matrix = matrices.get(key)!;
                const params = simParams(matrix);
                const byId = new Map(items.map((item) => [item.dispatch.dispatchId, item]));
                const queueOrder = new Map(items.map((item) => [item.dispatch.dispatchId, item.order]));
                const planned: number[] = [];

                // Rescheduled orders with an agreed window go first: their window cannot move.
                let pool = [
                    ...items.filter((item) => item.dispatch.agreedWindow),
                    ...items.filter((item) => !item.dispatch.agreedWindow),
                ].map((item) => item.dispatch);

                // 1. Late orders into the batches already open that day.
                const opens = openStates.get(`${date}|${key}`) ?? [];
                const stillWaiting: PlanDispatch[] = [];
                for (const dispatch of pool) {
                    let best: { state: OpenState; position: number; cost: number; simulation: SimResult } | null = null;
                    for (const state of opens) {
                        if (state.stops.length + 1 > maxStops) continue;
                        if (!fitsVehicle([...state.stops.map((stop) => stop.dispatch), dispatch], state.vehicle)) continue;
                        const choice = findCheapestInsertion(state.stops.map(toSimStop), toFreshSimStop(dispatch), params);
                        if (choice && (best === null || choice.costSeconds < best.cost)) {
                            best = { state, position: choice.position, cost: choice.costSeconds, simulation: choice.simulation };
                        }
                    }
                    if (!best) {
                        stillWaiting.push(dispatch);
                        continue;
                    }
                    best.state.stops.splice(best.position, 0, { dispatch, sequence: 0, notified: false, window: null });
                    best.state.insertedIds.push(dispatch.dispatchId);
                    best.state.simulation = best.simulation;
                    planned.push(dispatch.dispatchId);
                }
                pool = stillWaiting;
                for (const state of opens) {
                    if (state.insertedIds.length > 0) insertions.push(toInsertion(state, date));
                }

                // 2. What is left: new batches with the vehicles that are free that day.
                let freeVehicles = input.vehicles.filter((vehicle) => !usedVehicles.get(date)?.has(vehicle.vehicleId));
                const leftovers: { dispatch: PlanDispatch; failure: Failure }[] = [];
                let round = 0;

                while (pool.length > 0 && freeVehicles.length > 0) {
                    const globalIndex = [0, ...pool.map((dispatch) => matrix.indexOf.get(dispatch.dispatchId)!)];
                    const duration: DurationLookup = (from, to) => matrix.durations[globalIndex[from]][globalIndex[to]];
                    const composition = composeBatches(pool, duration, freeVehicles, input.vehicles, maxStops);

                    for (const dispatch of composition.unfittable) {
                        unplanned.push({ dispatchId: dispatch.dispatchId, reason: 'no_vehicle_fits', detail: zoneDetail(dispatch) });
                    }
                    if (round === 0 && composition.splitReason === 'table_limit') {
                        warnings.push({
                            kind: 'lot_split_by_table_limit',
                            detail: { shiftDate: date, ...zoneDetail(first), orders: pool.length, maxStops },
                        });
                    }

                    const overflow: PlanDispatch[] = [];
                    let created = 0;
                    for (const composed of composition.batches) {
                        const offered = [...composed.dispatches].sort(
                            (a, b) =>
                                Number(Boolean(b.agreedWindow)) - Number(Boolean(a.agreedWindow))
                                || queueOrder.get(a.dispatchId)! - queueOrder.get(b.dispatchId)!,
                        );
                        const byDispatch = new Map(offered.map((dispatch) => [dispatch.dispatchId, dispatch]));
                        const result = sequenceByInsertion(offered.map((dispatch) => toFreshSimStop(dispatch)), params);
                        for (const rejected of result.rejected) overflow.push(byDispatch.get(rejected.id)!);
                        if (result.sequence.length === 0) continue;

                        created++;
                        freeVehicles = freeVehicles.filter((vehicle) => vehicle.vehicleId !== composed.vehicle.vehicleId);
                        const driverId = pickDriver(date);
                        mark(usedVehicles, date, composed.vehicle.vehicleId);
                        if (driverId !== null) {
                            mark(busyDrivers, date, driverId);
                            countDriver(date, driverId);
                        }

                        const stops: ProposedStop[] = result.simulation.stops.map((stop, index) => {
                            const dispatch = byDispatch.get(stop.id)!;
                            return {
                                dispatchId: stop.id,
                                sequence: index + 1,
                                windowStart: windowInstant(date, dispatch.agreedWindow?.start ?? null, stop.window.startMinute),
                                windowEnd: windowInstant(date, dispatch.agreedWindow?.end ?? null, stop.window.endMinute),
                            };
                        });
                        const batch: ProposedBatch = {
                            shiftDate: date,
                            zoneId: first.zoneId,
                            zoneCode: first.zoneCode,
                            zoneName: first.zoneName,
                            warehouseId: first.warehouseId,
                            vehicleId: composed.vehicle.vehicleId,
                            alternativeVehicleIds: composed.alternativeVehicles
                                .filter((vehicle) => freeVehicles.some((candidate) => candidate.vehicleId === vehicle.vehicleId))
                                .map((vehicle) => vehicle.vehicleId),
                            proposedDriverId: driverId,
                            stops,
                            splitReason: composition.splitReason,
                            rescheduledDispatchIds: stops
                                .filter((stop) => byDispatch.get(stop.dispatchId)!.status === 'rescheduled')
                                .map((stop) => stop.dispatchId),
                        };
                        batches.push(batch);
                        planned.push(...stops.map((stop) => stop.dispatchId));

                        if (driverId === null) {
                            warnings.push({
                                kind: 'no_driver_available',
                                detail: { shiftDate: date, ...zoneDetail(first), vehicleId: batch.vehicleId },
                            });
                        }
                        const minimum = settings.minOrdersPerRoute;
                        if (minimum !== null && stops.length < minimum) {
                            warnings.push({
                                kind: 'below_min_orders',
                                detail: { shiftDate: date, ...zoneDetail(first), stops: stops.length, minimum },
                            });
                        }
                    }

                    for (const dispatch of composition.withoutVehicle) {
                        leftovers.push({ dispatch, failure: 'no_vehicle_available' });
                    }
                    pool = overflow;
                    round++;
                    // No batch could be built: the rest cannot be routed on this day.
                    if (created === 0) break;
                }
                for (const dispatch of pool) {
                    leftovers.push({
                        dispatch,
                        failure: freeVehicles.length === 0 ? 'no_vehicle_available' : 'no_feasible_route',
                    });
                }

                // A deleted zone is still planned; one warning per group lists what got a batch.
                if (first.zoneDeleted && planned.length > 0) {
                    warnings.push({
                        kind: 'zone_deleted',
                        detail: { ...zoneDetail(first), shiftDate: date, dispatchIds: planned },
                    });
                }

                for (const { dispatch, failure } of leftovers) {
                    const item = byId.get(dispatch.dispatchId)!;
                    item.pointer++;
                    if (item.pointer < item.dates.length) {
                        active.push(item);
                    } else if (dispatch.status === 'rescheduled') {
                        unplanned.push({
                            dispatchId: dispatch.dispatchId,
                            reason: 'no_vehicle_available',
                            detail: { date, motivo: failure },
                        });
                    } else {
                        unplanned.push({
                            dispatchId: dispatch.dispatchId,
                            reason: 'deadline_exceeded',
                            detail: { motivo: failure, dates: item.dates },
                        });
                    }
                }
            }
        }

        return { batches, insertions, unplanned, warnings };
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

    /** Open batches whose cutoff has not passed and whose vehicle is still in the active fleet. */
    private openStates(input: PlanInput): Map<string, OpenState[]> {
        const vehicles = new Map(input.vehicles.map((vehicle) => [vehicle.vehicleId, vehicle]));
        const { calendar, promiseRules } = input.settings;
        const states = new Map<string, OpenState[]>();
        for (const batch of input.openBatches) {
            const vehicle = vehicles.get(batch.vehicleId);
            if (!vehicle) continue;
            const { cutoffAt } = cutoffBefore(batch.shiftDate, promiseRules.routeCutoffTime, calendar);
            if (input.now.getTime() >= cutoffAt.getTime()) continue;

            const key = `${batch.shiftDate}|${batch.zoneId}:${batch.warehouseId}`;
            if (!states.has(key)) states.set(key, []);
            states.get(key)!.push({
                batch,
                vehicle,
                stops: [...batch.stops].sort((a, b) => a.sequence - b.sequence),
                insertedIds: [],
                simulation: null,
            });
        }
        return states;
    }

    /**
     * One matrix per zone and warehouse, over every order that may be planned there (any date) and the
     * stops of its open batches. Every request is made before anything is decided, so an OSRM failure
     * aborts with no side effects.
     */
    private async loadMatrices(
        input: PlanInput,
        waiting: Waiting[],
        openStates: Map<string, OpenState[]>,
    ): Promise<Map<string, ZoneMatrix>> {
        const warehouses = new Map(input.warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));
        const byKey = new Map<string, Map<number, PlanDispatch>>();
        for (const item of waiting) {
            const key = zoneKey(item.dispatch);
            if (!byKey.has(key)) byKey.set(key, new Map());
            byKey.get(key)!.set(item.dispatch.dispatchId, item.dispatch);
        }
        for (const states of openStates.values()) {
            for (const state of states) {
                const members = byKey.get(`${state.batch.zoneId}:${state.batch.warehouseId}`);
                if (!members) continue;
                for (const stop of state.stops) members.set(stop.dispatch.dispatchId, stop.dispatch);
            }
        }

        const matrices = new Map<string, ZoneMatrix>();
        for (const [key, members] of byKey) {
            const dispatches = [...members.values()];
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

/** The zone as a coordinator reads it: id for the screens, code and name for the person. */
function zoneDetail(dispatch: { zoneId: number; zoneCode: string; zoneName: string }): { zoneId: number; zoneCode: string; zoneName: string } {
    return { zoneId: dispatch.zoneId, zoneCode: dispatch.zoneCode, zoneName: dispatch.zoneName };
}

function zoneKey(dispatch: PlanDispatch): string {
    return `${dispatch.zoneId}:${dispatch.warehouseId}`;
}

function minuteOfInstant(instant: Date): number {
    return toLocalMoment(instant).minuteOfDay;
}

/** A stop of an open batch: a notified one keeps the window the customer was told. */
function toSimStop(stop: OpenBatchStop): SimStop {
    if (stop.notified && stop.window) {
        return {
            id: stop.dispatch.dispatchId,
            fixedWindow: { startMinute: minuteOfInstant(stop.window.start), endMinute: minuteOfInstant(stop.window.end) },
        };
    }
    return toFreshSimStop(stop.dispatch);
}

/** An order that is not notified yet: free, unless a rescheduled one with an agreed window. */
function toFreshSimStop(dispatch: PlanDispatch): SimStop {
    const window = dispatch.agreedWindow;
    return {
        id: dispatch.dispatchId,
        fixedWindow: window
            ? { startMinute: minuteOfInstant(window.start), endMinute: minuteOfInstant(window.end) }
            : null,
    };
}

function windowInstant(date: string, agreed: Date | null, minute: number): Date {
    if (agreed) return agreed;
    const hours = String(Math.floor(minute / 60)).padStart(2, '0');
    const minutes = String(Math.round(minute % 60)).padStart(2, '0');
    return localInstant(date, `${hours}:${minutes}`);
}

function toInsertion(state: OpenState, date: string): ProposedInsertion {
    const simulation = state.simulation!;
    const byId = new Map(simulation.stops.map((stop) => [stop.id, stop]));
    const previous = new Map(state.batch.stops.map((stop) => [stop.dispatch.dispatchId, stop.sequence]));
    const stops: InsertedStop[] = state.stops.map((stop, index) => {
        const id = stop.dispatch.dispatchId;
        const result = byId.get(id)!;
        const keepsWindow = stop.notified && stop.window !== null;
        return {
            dispatchId: id,
            sequence: index + 1,
            windowStart: keepsWindow ? null : windowInstant(date, stop.dispatch.agreedWindow?.start ?? null, result.window.startMinute),
            windowEnd: keepsWindow ? null : windowInstant(date, stop.dispatch.agreedWindow?.end ?? null, result.window.endMinute),
            previousSequence: previous.get(id) ?? null,
            isNew: !previous.has(id),
        };
    });
    return {
        routeBatchId: state.batch.routeBatchId,
        expectedVersion: state.batch.version,
        shiftDate: date,
        zoneId: state.batch.zoneId,
        zoneCode: state.batch.zoneCode,
        zoneName: state.batch.zoneName,
        vehicleId: state.batch.vehicleId,
        stops,
        insertedDispatchIds: [...state.insertedIds],
    };
}
