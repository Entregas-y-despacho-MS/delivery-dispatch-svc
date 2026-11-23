import type { CapacityMeasure, RouteCapacityReport } from '../../../modules/dispatch/route-batches/domain/route-capacity.js';

/** One capacity dimension with its own unit. Weight and volume are never added or averaged into one figure. */
export interface UnitCapacity<U extends 'kg' | 'm3'> {
    unit: U;
    actual: number;
    capacity: number;
    usedPercent: number;
    remaining: number;
    excess: number;
    exceeded: boolean;
}

export interface PipelineCapacity {
    weight: UnitCapacity<'kg'>;
    volume: UnitCapacity<'m3'>;
    /** Packages longer, wider or taller than what the vehicle accepts (a separate check from weight and volume). */
    dimensionViolationCount: number;
}

/** Why a batch's load is invalid; each code names one unit, so a coordinator never reads a mixed percentage. */
export type CapacityExceptionCode = 'capacity_exceeded_kg' | 'capacity_exceeded_m3' | 'package_dimensions_exceeded';

function toUnit<U extends 'kg' | 'm3'>(unit: U, measure: CapacityMeasure): UnitCapacity<U> {
    return {
        unit,
        actual: measure.actual,
        capacity: measure.capacity,
        usedPercent: measure.usedPercent,
        remaining: measure.remaining,
        excess: measure.excess,
        exceeded: measure.excess > 0,
    };
}

/** Adapts the route capacity report (ST-215.5) to the pipeline view: kg against kg, m³ against m³. */
export function toPipelineCapacity(report: RouteCapacityReport): PipelineCapacity {
    return {
        weight: toUnit('kg', report.weight),
        volume: toUnit('m3', report.volume),
        dimensionViolationCount: report.dimensionViolations.length,
    };
}

/** The exception codes of a load. Without a vehicle (`null`) there is nothing to compare, so no code is invented. */
export function capacityExceptionCodes(capacity: PipelineCapacity | null): CapacityExceptionCode[] {
    if (capacity === null) return [];
    const codes: CapacityExceptionCode[] = [];
    if (capacity.weight.exceeded) codes.push('capacity_exceeded_kg');
    if (capacity.volume.exceeded) codes.push('capacity_exceeded_m3');
    if (capacity.dimensionViolationCount > 0) codes.push('package_dimensions_exceeded');
    return codes;
}
