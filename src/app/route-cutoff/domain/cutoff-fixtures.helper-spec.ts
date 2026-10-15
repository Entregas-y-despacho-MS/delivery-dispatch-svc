/**
 * Builders shared by the specs of the D-1 cutoff (ST-51.3). Not a spec itself and excluded from the
 * build by `**\/*spec.ts`. The week is the simulated one of the plan: the cutoff runs on Tuesday
 * 2026-10-13 at 15:00 for the routes of Wednesday 2026-10-14.
 */
import { localInstant } from '../../planning/domain/operating-calendar.js';
import { dispatch, settings, vehicle } from '../../planning/domain/plan-fixtures.helper-spec.js';
import type { PlanVehicle } from '../../planning/domain/plan-types.js';
import type { CutoffBatch, CutoffInput, CutoffStop } from './cutoff-types.js';

export const SHIFT_DATE = '2026-10-14';
export const CUTOFF_NOW = localInstant('2026-10-13', '15:00');
/** Notified Monday 08:45: its 12 h ended Monday 20:45, before the cutoff. */
export const NOTIFIED_LONG_AGO = localInstant('2026-10-12', '08:45');
/** Notified Tuesday 10:00: its 12 h end Tuesday 22:00, after the cutoff. */
export const NOTIFIED_TODAY = localInstant('2026-10-13', '10:00');

export interface StopOptions {
    km?: number;
    kg?: number;
    window?: [string, string];
    status?: 'in_planning' | 'scheduled';
    firmed?: boolean;
    notifiedAt?: Date | null;
    sequence?: number;
    version?: number;
}

/** A promised stop by default: `scheduled`, notified long ago (window closed), with its slot. */
export function stop(id: number, options: StopOptions = {}): CutoffStop {
    const { km = id, kg = 10, window = ['09:00', '11:00'], status = 'scheduled', firmed = false } = options;
    const notifiedAt = options.notifiedAt === undefined ? NOTIFIED_LONG_AGO : options.notifiedAt;
    return {
        dispatch: dispatch(id, { km, estimatedWeightKg: kg, status }),
        sequence: options.sequence ?? id,
        version: options.version ?? 1,
        promiseNotifiedAt: status === 'in_planning' ? null : notifiedAt,
        promiseFirmedAt: firmed ? NOTIFIED_LONG_AGO : null,
        window: status === 'in_planning'
            ? null
            : { start: localInstant(SHIFT_DATE, window[0]), end: localInstant(SHIFT_DATE, window[1]) },
    };
}

export function batch(id: number, stops: CutoffStop[], over: Partial<CutoffBatch> = {}): CutoffBatch {
    return {
        routeBatchId: id,
        version: 4,
        shiftDate: SHIFT_DATE,
        zoneId: 1,
        zoneCode: 'ZON-1',
        zoneName: 'Zona 1',
        warehouseId: 1,
        vehicleId: id,
        proposedDriverId: 100 + id,
        reviewerUserId: 7,
        stops,
        ...over,
    };
}

/** 1 km of the fixtures is 60 s of driving; the depot is at km 0. Position of a dispatch = its `km`. */
export function travelByKm(batches: CutoffBatch[]): CutoffInput['travelFor'] {
    const km = new Map<number, number>();
    for (const b of batches) {
        for (const s of b.stops) km.set(s.dispatch.dispatchId, Math.round((-16.5 - s.dispatch.latitude) / 0.01));
    }
    return () => (from, to) => Math.abs((from === null ? 0 : km.get(from)!) - km.get(to)!) * 60;
}

export function cutoffInput(batches: CutoffBatch[], over: Partial<CutoffInput> = {}, fleet?: PlanVehicle[]): CutoffInput {
    return {
        now: CUTOFF_NOW,
        settings: settings(),
        batches,
        fleet: fleet ?? [vehicle(1, 1000), vehicle(2, 1000), vehicle(3, 1000)],
        occupiedVehicleIds: [],
        maxStopsPerBatch: 50,
        travelFor: travelByKm(batches),
        ...over,
    };
}
