/**
 * The date a delivery-promise query is anchored to (ST-301.1):
 * - `promise`: the OTD by cohort. The universe is the deliveries whose promise (end of the committed window) expired
 *   inside the range, open ones included.
 * - `deliveredAt`: the historic punctuality of the completed deliveries, as ES-54 measures it (closing time inside the
 *   range). It is a separate query so the two rates are never mixed.
 */
export enum OtdBasis {
    PROMISE      = 'promise',
    DELIVERED_AT = 'deliveredAt',
}

/** What each basis puts in `dateBasis`, so the screen can label the rate with the date it was measured on. */
export const OTD_DATE_BASIS: Record<OtdBasis, string> = {
    [OtdBasis.PROMISE]:      'promise_window_end',
    [OtdBasis.DELIVERED_AT]: 'closed_at',
};

/** Why a cancelled dispatch is left out of the OTD: only a cancellation before the promise expired does not count against it. */
export const CANCELLATION_EXCLUSION_REASON = 'cancelled_before_promise_expired';

/** With `basis=deliveredAt` a cancellation is not a completed delivery, so it is left out of the universe (as ES-54 does). */
export const DELIVERED_AT_CANCELLATION_EXCLUSION_REASON = 'cancelled_not_a_completed_delivery';

export const CANCELLATION_EXCLUSION_REASON_BY_BASIS: Record<OtdBasis, string> = {
    [OtdBasis.PROMISE]:      CANCELLATION_EXCLUSION_REASON,
    [OtdBasis.DELIVERED_AT]: DELIVERED_AT_CANCELLATION_EXCLUSION_REASON,
};

/** First-attempt delivery needs a normalized attempt (there is no attempts table yet): the rate is N/D until it exists. */
export const FIRST_ATTEMPT_UNAVAILABLE_REASON = 'attempt_not_normalized';
