import type { DeliveryEvidenceRefDto, DeliveryEvidenceType } from '../dto/delivery-evidence-ref.dto.js';
import { DispatchEvidenceInvalidException } from '../exceptions/dispatch-evidence-invalid.exception.js';
import { DispatchEvidenceRequiredException } from '../exceptions/dispatch-evidence-required.exception.js';

/** What `delivery_evidences` stores for a record; the domain never touches the entity or the database. */
export interface StoredEvidence {
    id: string;
    dispatchId: number;
    type: string;
    fileUrl: string | null;
    capturedAt: Date | null;
    receiverName: string | null;
    receiverDocument: string | null;
}

// One evidence type per policy. An OTP is never replaced by a signature or a photo (ES-31, Escenario 4).
const EVIDENCE_FOR_POLICY: Readonly<Record<string, DeliveryEvidenceType>> = {
    hand_delivery_standard: 'signature',
    contactless_delivery:   'photo',
    high_value_control:     'otp',
};

export function requiredEvidenceType(policy: string): DeliveryEvidenceType | undefined {
    return EVIDENCE_FOR_POLICY[policy];
}

const filled = (value: string | null): boolean => value !== null && value.trim() !== '';

/** Missing pieces of a record that is already known to be of the required type. An OTP row is complete by existing: it is only written after a correct code. */
function missingFields(evidence: StoredEvidence): string[] {
    if (evidence.type === 'otp') return [];
    const missing: string[] = [];
    if (!filled(evidence.fileUrl)) missing.push('file');
    if (evidence.capturedAt === null) missing.push('capturedAt');
    if (evidence.type === 'signature') {
        if (!filled(evidence.receiverName)) missing.push('receiverName');
        if (!filled(evidence.receiverDocument)) missing.push('receiverDocument');
    }
    return missing;
}

/**
 * Decides whether the evidence the app presented can back a `delivered` transition (ST-304.2). Pure: the caller reads
 * the stored record (or `null` when no row has that id) and the policy of the dispatch.
 */
export function assertDeliveryEvidence(input: {
    dispatchId: number;
    policy: string;
    reference: DeliveryEvidenceRefDto | undefined;
    stored: StoredEvidence | null;
}): void {
    const required = requiredEvidenceType(input.policy);
    // A policy this code does not know cannot be satisfied: refuse instead of delivering without proof (the stored value is not echoed).
    if (!required) throw new DispatchEvidenceInvalidException('DISPATCH_EVIDENCE_POLICY_UNKNOWN', 'The evidence policy of this dispatch is not supported.');
    if (!input.reference) throw new DispatchEvidenceRequiredException(required);

    const { stored, reference } = input;
    // Evidence of another dispatch answers exactly like an unknown id: the endpoint must not reveal which ids exist elsewhere.
    if (!stored || stored.dispatchId !== input.dispatchId) {
        throw new DispatchEvidenceInvalidException('DISPATCH_EVIDENCE_NOT_FOUND', 'The referenced evidence is not registered for this dispatch.');
    }
    if (reference.type !== required || stored.type !== required) {
        throw new DispatchEvidenceInvalidException('DISPATCH_EVIDENCE_TYPE_MISMATCH', `This dispatch requires ${required} evidence; the referenced evidence cannot replace it.`);
    }
    const missing = missingFields(stored);
    if (missing.length > 0) {
        throw new DispatchEvidenceInvalidException('DISPATCH_EVIDENCE_INCOMPLETE', `The ${required} evidence is incomplete: missing ${missing.join(', ')}.`);
    }
}
