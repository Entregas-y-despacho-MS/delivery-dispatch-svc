import { capacityExceptionCodes, type CapacityExceptionCode, type PipelineCapacity } from './pipeline-capacity.js';

/**
 * Where a dispatch is in the planning pipeline. One dispatch is in exactly one stage; the batch only
 * tells which stage, it is never the unit that is counted.
 */
export enum PipelineStage {
    READY_UNBATCHED = 'ready_unbatched',
    PROVISIONAL_REVIEW = 'provisional_review',
    CONFIRMED_ASSIGNED = 'confirmed_assigned',
    IN_EXECUTION = 'in_execution',
    EXCEPTION = 'exception',
}

/** Why a dispatch is an exception. The plan codes come from the `plan_exception` events of the generator. */
export type PipelineExceptionCode =
    | CapacityExceptionCode
    | 'address_invalid'
    | 'zone_missing'
    | 'inconsistent_state'
    | 'deadline_exceeded'
    | 'no_vehicle_fits'
    | 'no_vehicle_available'
    | 'rescheduled_date_not_plannable';

export interface PipelineDispatchInput {
    /** Current dispatch status (`dispatch_statuses.name`). */
    status: string;
    hasZone: boolean;
    /** Status of the batch the dispatch belongs to, `null` when it has none. */
    batchStatus: string | null;
    /** Reason of the open `plan_exception` of the dispatch, `null` when there is none (see `isPlanExceptionOpen`). */
    planExceptionReason: string | null;
    /** The load of the batch against its vehicle, `null` when the batch has no vehicle yet. */
    batchCapacity: PipelineCapacity | null;
}

export interface PipelineClassification {
    /** `null`: the dispatch is not part of the pipeline (finished, cancelled, returned, rescheduled, in incident...). */
    stage: PipelineStage | null;
    exceptionCodes: PipelineExceptionCode[];
}

const PLAN_REASONS: ReadonlySet<string> = new Set(['deadline_exceeded', 'no_vehicle_fits', 'no_vehicle_available', 'rescheduled_date_not_plannable']);
/** Statuses that wait for a batch: a `rescheduled` delivery and a pickup with zone enter the generator like a `pending` one (D-56). */
const UNBATCHED_STATUSES: ReadonlySet<string> = new Set(['pending', 'rescheduled', 'pickup_scheduled']);
/** A delivery that is in a batch has moved on to `in_planning`; a pickup keeps `pickup_scheduled` inside its batch (D-56). */
const WAITING_DELIVERY_STATUSES: ReadonlySet<string> = new Set(['pending', 'rescheduled']);
const BATCHED_STATUSES: ReadonlySet<string> = new Set(['in_planning', 'scheduled', 'assigned']);
const ROUTE_STATUSES: ReadonlySet<string> = new Set(['out_for_delivery', 'in_transit']);
/** Batches whose load can still be corrected: once the route runs a capacity excess is history, not an exception. */
const EDITABLE_BATCH_STATUSES: ReadonlySet<string> = new Set(['provisional', 'pending_final_review', 'confirmed']);

function inPipeline(status: string): boolean {
    return status === 'address_review' || UNBATCHED_STATUSES.has(status) || BATCHED_STATUSES.has(status) || ROUTE_STATUSES.has(status);
}

/**
 * A `plan_exception` stays open while the dispatch is still waiting for a plan: the generator
 * reports each reason once, and a dispatch that left `pending` has been resolved.
 */
export function isPlanExceptionOpen(status: string, reason: string | null): boolean {
    return reason !== null && PLAN_REASONS.has(reason) && UNBATCHED_STATUSES.has(status);
}

function exception(...codes: PipelineExceptionCode[]): PipelineClassification {
    return { stage: PipelineStage.EXCEPTION, exceptionCodes: codes };
}

/** Classifies one dispatch into a single stage. Exceptions take precedence; the other stages never overlap. */
export function classifyDispatch(input: PipelineDispatchInput): PipelineClassification {
    const { status, batchStatus } = input;
    if (!inPipeline(status)) return { stage: null, exceptionCodes: [] };

    if (status === 'address_review') return exception('address_invalid');

    if (ROUTE_STATUSES.has(status) || batchStatus === 'in_execution') {
        return { stage: PipelineStage.IN_EXECUTION, exceptionCodes: [] };
    }

    const open = isPlanExceptionOpen(status, input.planExceptionReason);
    if (batchStatus === null) {
        if (!UNBATCHED_STATUSES.has(status)) return exception('inconsistent_state');
        if (open) return exception(input.planExceptionReason as PipelineExceptionCode);
        if (!input.hasZone) return exception('zone_missing');
        return { stage: PipelineStage.READY_UNBATCHED, exceptionCodes: [] };
    }

    // The dispatch has a batch: its status says the stage, but a batch that is closed or cancelled cannot hold an active dispatch.
    if (!EDITABLE_BATCH_STATUSES.has(batchStatus) || WAITING_DELIVERY_STATUSES.has(status)) return exception('inconsistent_state');

    const capacityCodes = capacityExceptionCodes(input.batchCapacity);
    if (capacityCodes.length > 0) return exception(...capacityCodes);

    const stage = batchStatus === 'confirmed' ? PipelineStage.CONFIRMED_ASSIGNED : PipelineStage.PROVISIONAL_REVIEW;
    return { stage, exceptionCodes: [] };
}

export type StageCounts = Record<PipelineStage, number>;

/** Counts dispatches per stage (never batches). Every stage is present, with 0 when empty. */
export function countByStage(stages: ReadonlyArray<PipelineStage | null>): StageCounts {
    const counts = Object.fromEntries(Object.values(PipelineStage).map((stage) => [stage, 0])) as StageCounts;
    for (const stage of stages) {
        if (stage !== null) counts[stage] += 1;
    }
    return counts;
}
