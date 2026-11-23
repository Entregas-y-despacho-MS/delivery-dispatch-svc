/**
 * Why a dispatch is excluded from the planning universe of a cutoff (ST-302.2, ES-302). Every exclusion has a code and
 * a readable explanation: the database refuses an exclusion without both (`chk_planning_cutoff_dispatches_exclusion`).
 * The catalog lives here, not in a `CHECK`, because it grows with the rules of the cutoff.
 */
export const CUTOFF_EXCLUSION_CODES = ['cutoff_window_open', 'cutoff_no_promise'] as const;

export type CutoffExclusionCode = (typeof CUTOFF_EXCLUSION_CODES)[number];

/** The format the database accepts for a code (`chk_planning_cutoff_dispatches_exclusion`, `chk_route_manifest_stops_exclusion_code`). */
export const EXCLUSION_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/** What each code means for the coordinator, in English like the rest of the API messages. */
export const CUTOFF_EXCLUSION_EXPLANATIONS: Record<CutoffExclusionCode, string> = {
    cutoff_window_open:
        'The promise was notified but the customer can still answer it (or there is no valid notice yet), so it is not firm at the cutoff and waits for a later batch.',
    cutoff_no_promise:
        'The order was never approved, so the customer was promised nothing; it leaves the batch and goes back to pending for the next viable date.',
};

export interface CutoffExclusion {
    code: CutoffExclusionCode;
    detail: string;
}

export function cutoffExclusion(code: CutoffExclusionCode): CutoffExclusion {
    return { code, detail: CUTOFF_EXCLUSION_EXPLANATIONS[code] };
}
