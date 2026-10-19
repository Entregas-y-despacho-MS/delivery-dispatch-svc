import { RouteBatchStatusEnum } from '../../../shared/enums/route-batch-status.enum.js';

/**
 * What taking one dispatch out of its route batch does to the batch (decision D8 of the plan of ST-52.2).
 *
 * - `provisional`: nobody has been told the sequence yet, so the gap is closed; an empty batch is cancelled.
 * - `pending_final_review`, `confirmed`: frozen, the sequence was already communicated, so the other stops are
 *   not renumbered; an empty batch is cancelled.
 * - `in_execution`: the route is on the street, the stops stay as they are and the automatic closing (D-50) is
 *   evaluated, because the dispatch that left may have been the last one keeping the batch open.
 * - `closed`, `cancelled`: history. The dispatch leaves and the event is recorded; the batch is not touched.
 */
export interface BatchExitPolicy {
    /** The batch row changes: its `version` goes up and it may be cancelled or closed. */
    touchBatch: boolean;
    closeSequenceGap: boolean;
    cancelWhenEmpty: boolean;
    evaluateClosing: boolean;
}

const UNTOUCHED: BatchExitPolicy = { touchBatch: false, closeSequenceGap: false, cancelWhenEmpty: false, evaluateClosing: false };

export function batchExitPolicy(batchStatus: string): BatchExitPolicy {
    switch (batchStatus) {
        case RouteBatchStatusEnum.PROVISIONAL:
            return { touchBatch: true, closeSequenceGap: true, cancelWhenEmpty: true, evaluateClosing: false };
        case RouteBatchStatusEnum.PENDING_FINAL_REVIEW:
        case RouteBatchStatusEnum.CONFIRMED:
            return { touchBatch: true, closeSequenceGap: false, cancelWhenEmpty: true, evaluateClosing: false };
        case RouteBatchStatusEnum.IN_EXECUTION:
            return { touchBatch: true, closeSequenceGap: false, cancelWhenEmpty: false, evaluateClosing: true };
        default:
            return UNTOUCHED;
    }
}
