import type { ComplaintInvestigationStatus, ComplaintVerdict } from '../../../messaging/complaint-intake/entities/delivery-complaint-case.entity.js';

/** What the person in charge can do next with a case. `none` = nothing left for Dispatch to do. */
export const COMPLAINT_NEXT_ACTIONS = ['assign', 'start_investigation', 'issue_verdict', 'await_inventory_authorization', 'none'] as const;
export type ComplaintNextAction = typeof COMPLAINT_NEXT_ACTIONS[number];

export interface NextActionInput {
    investigationStatus: ComplaintInvestigationStatus;
    verdict: ComplaintVerdict | null;
    rmaId: string | null;
    /** The dispatch of the case is `delivered`: the only one a case can be investigated for. */
    eligible: boolean;
}

/**
 * Derives the next step of a case from its state (ES-45, RF-U22). `authorization_pending` is not stored:
 * a `request_RMA` verdict without `rma_id` is waiting for Inventory, which alone approves or rejects it.
 */
export function nextActionOf(input: NextActionInput): ComplaintNextAction {
    if (input.investigationStatus === 'decided') {
        return input.verdict === 'request_RMA' && !input.rmaId ? 'await_inventory_authorization' : 'none';
    }
    if (!input.eligible) return 'none';
    switch (input.investigationStatus) {
        case 'received':         return 'assign';
        case 'assigned':         return 'start_investigation';
        case 'in_investigation': return 'issue_verdict';
    }
}

/** `request_RMA` verdict that Inventory has not approved or rejected yet. */
export const isAuthorizationPending = (verdict: ComplaintVerdict | null, rmaId: string | null): boolean =>
    verdict === 'request_RMA' && !rmaId;
