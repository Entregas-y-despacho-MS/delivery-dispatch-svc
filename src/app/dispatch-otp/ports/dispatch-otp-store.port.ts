export type OtpIssueResult = 'issued' | 'already_issued' | 'not_issued' | 'locked' | 'consumed' | 'resend_limit';
export type OtpVerifyResult = 'verified' | 'invalid' | 'expired' | 'locked' | 'consumed' | 'replaced';

export abstract class DispatchOtpStore {
    /** Initial issue is idempotent for the entire dispatch lifecycle. */
    abstract issue(dispatchId: number, hash: string, ttlSeconds: number, resend?: boolean): Promise<OtpIssueResult>;
    abstract invalidate(dispatchId: number, expectedHash: string): Promise<void>;
    abstract readHash(dispatchId: number): Promise<string | null>;
    /**
     * Atomically checks the observed generation, applies the verdict and consumes a valid code. When the code is valid,
     * `evidenceId` is stored with the consumption in the same step, so a crash before the evidence row exists can be
     * completed later (see `readVerifiedEvidenceId`) without ever accepting the code a second time.
     */
    abstract verify(dispatchId: number, expectedHash: string, matches: boolean, evidenceId?: string): Promise<OtpVerifyResult>;
    /** The evidence id recorded by the verification that consumed the code, or null when none was recorded. */
    abstract readVerifiedEvidenceId(dispatchId: number): Promise<string | null>;
}
