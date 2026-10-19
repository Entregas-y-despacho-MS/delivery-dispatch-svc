export const DISPATCH_EVIDENCE_REGISTERED_EVENT = 'dispatch.evidence_registered';

export interface DispatchEvidenceRegisteredEvent {
    dispatchId:   number;
    evidenceId:   string;
    type:         string;
    /** UTC instant when the server registered the evidence. */
    registeredAt: string;
}
