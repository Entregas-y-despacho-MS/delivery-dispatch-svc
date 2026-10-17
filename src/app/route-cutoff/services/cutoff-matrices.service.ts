import { Injectable } from '@nestjs/common';
import { OsrmPort, type Coordinate } from '../../../plugins/osrm/osrm.port.js';
import type { TravelSeconds } from '../../planning/domain/route-simulation.js';
import type { CutoffBatch, CutoffInput } from '../domain/cutoff-types.js';

export type CutoffMatrices = Map<string, TravelSeconds>;

/**
 * Driving-time matrices of the batches of a cutoff (or of one batch being revalidated, ST-51.6): one per
 * warehouse and zone, asked of OSRM before anything is written, so a failure leaves the data untouched.
 */
@Injectable()
export class CutoffMatricesService {
    constructor(private readonly osrm: OsrmPort) {}

    async load(
        batches: CutoffBatch[],
        warehouses: Array<{ warehouseId: number; latitude: number; longitude: number }>,
    ): Promise<CutoffMatrices> {
        const depots = new Map(warehouses.map((warehouse) => [warehouse.warehouseId, warehouse]));
        const members = new Map<string, Map<number, Coordinate>>();
        const depotOf = new Map<string, number>();
        for (const batch of batches) {
            const key = `${batch.warehouseId}|${batch.zoneId}`;
            depotOf.set(key, batch.warehouseId);
            if (!members.has(key)) members.set(key, new Map());
            for (const stop of batch.stops) {
                members.get(key)!.set(stop.dispatch.dispatchId, { lat: stop.dispatch.latitude, lon: stop.dispatch.longitude });
            }
        }

        const matrices: CutoffMatrices = new Map();
        for (const [key, stops] of members) {
            const depot = depots.get(depotOf.get(key)!);
            if (!depot) throw new Error(`Warehouse ${depotOf.get(key)} is not available for planning.`);
            const ids = [...stops.keys()];
            const { durations } = await this.osrm.getDurationMatrix([
                { lat: depot.latitude, lon: depot.longitude },
                ...ids.map((id) => stops.get(id)!),
            ]);
            const indexOf = new Map(ids.map((id, i) => [id, i + 1]));
            matrices.set(key, (from, to) => durations[from === null ? 0 : indexOf.get(from)!][indexOf.get(to)!]);
        }
        return matrices;
    }

    /** The lookup the reoptimization and the validation use to get the matrix of a warehouse and zone. */
    travelFor(matrices: CutoffMatrices): CutoffInput['travelFor'] {
        return (warehouseId, zoneId) => {
            const matrix = matrices.get(`${warehouseId}|${zoneId}`);
            if (!matrix) throw new Error(`No time matrix for warehouse ${warehouseId} and zone ${zoneId}.`);
            return matrix;
        };
    }
}
