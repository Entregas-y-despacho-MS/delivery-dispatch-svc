import type { PipelineExceptionCode } from './pipeline-stage.js';

/** What each exception code means for the coordinator, in English like the rest of the API messages. */
export const EXCEPTION_REASONS: Record<PipelineExceptionCode, string> = {
    address_invalid: 'The delivery address has no valid coordinates; the coordinator must set the point.',
    zone_missing: 'The dispatch has no delivery zone, so it cannot enter a batch.',
    deadline_exceeded: 'The promise deadline can no longer be met by any plan.',
    no_vehicle_fits: 'No vehicle has the capacity for this dispatch.',
    no_vehicle_available: 'No vehicle is available on the planned day.',
    rescheduled_date_not_plannable: 'The rescheduled date cannot be planned.',
    capacity_exceeded_kg: 'The weight of the batch exceeds the weight capacity of its vehicle (kg).',
    capacity_exceeded_m3: 'The volume of the batch exceeds the volume capacity of its vehicle (m³).',
    package_dimensions_exceeded: 'A package of the batch exceeds the maximum dimensions the vehicle accepts.',
    inconsistent_state: 'The status of the dispatch does not match the status of its batch.',
};

/** The reason text of an exception: every code explained, in the order of the codes. */
export function exceptionReason(codes: readonly PipelineExceptionCode[]): string | null {
    return codes.length === 0 ? null : codes.map((code) => EXCEPTION_REASONS[code]).join(' ');
}
