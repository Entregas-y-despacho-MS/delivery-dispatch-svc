import { RouteBatchNotConfirmedException } from '../exceptions/route-batch-not-confirmed.exception.js';

/** The only status in which a driver may accept a batch (D-46): the 2nd approval froze it. */
export const ACCEPTABLE_BATCH_STATUS = 'confirmed';

/**
 * Whether a driver can accept (check the load of) a batch in `status`. A batch still `provisional` or
 * `pending_final_review` is not approved, and there is no automatic approval, so it cannot be accepted
 * however late the hour is (ST-51.4).
 */
export function canDriverAcceptBatch(status: string): boolean {
    return status === ACCEPTABLE_BATCH_STATUS;
}

/**
 * Guard for the acceptance flow (`accepted_at`, ST-210.1): throws 409 `ROUTE_BATCH_NOT_CONFIRMED` unless the
 * batch is `confirmed`. Call it before writing anything. The acceptance endpoint itself does not exist yet.
 */
export function assertDriverCanAcceptBatch(status: string): void {
    if (!canDriverAcceptBatch(status)) throw new RouteBatchNotConfirmedException(status);
}
