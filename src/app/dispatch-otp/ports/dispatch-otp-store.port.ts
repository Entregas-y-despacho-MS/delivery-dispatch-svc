export type OtpIssueResult = 'issued' | 'already_issued' | 'not_issued' | 'locked' | 'consumed' | 'resend_limit';
export type OtpVerifyResult = 'verified' | 'invalid' | 'expired' | 'locked' | 'consumed' | 'replaced';

export abstract class DispatchOtpStore {
    /** Initial issue is idempotent for the entire dispatch lifecycle. */
    abstract issue(dispatchId: number, hash: string, ttlSeconds: number, resend?: boolean): Promise<OtpIssueResult>;
    abstract invalidate(dispatchId: number, expectedHash: string): Promise<void>;
    abstract readHash(dispatchId: number): Promise<string | null>;
    /** Atomically checks the observed generation, applies the verdict and consumes a valid code. */
    abstract verify(dispatchId: number, expectedHash: string, matches: boolean): Promise<OtpVerifyResult>;
}
