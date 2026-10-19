/**
 * Who may be shown a customer's tracking link, and for which customer (ST-224.1, extension for ES-227). Pure.
 *
 * The link is the customer's only credential: whoever has it can confirm or reschedule that delivery. So it is shown
 * only when it is the ONLY way the customer can receive it (no email on the order), only to the coordinator (and root,
 * who passes every role check) and only while the token still works. A customer with an email already got it there.
 */
import { RoleEnum } from '../../../shared/enums/index.js';

/** Roles that can ask for a link: the ones that can also resolve the request (`POST /dispatches/:id/reschedule`). */
const LINK_ROLES: string[] = [RoleEnum.COORDINATOR, RoleEnum.ROOT];

export interface TrackingLinkFacts {
    hasContactEmail: boolean;
    /** The dispatch has a token and it has not expired. */
    hasLiveToken: boolean;
}

export function canViewTrackingLink(role: string): boolean {
    return LINK_ROLES.includes(role);
}

/** Why the link cannot be shown for this delivery, or `null` when it can. */
export function trackingLinkBlock(facts: TrackingLinkFacts): 'has_contact_email' | 'no_live_token' | null {
    if (facts.hasContactEmail) return 'has_contact_email';
    if (!facts.hasLiveToken) return 'no_live_token';
    return null;
}

export function canRevealTrackingLink(role: string, facts: TrackingLinkFacts): boolean {
    return canViewTrackingLink(role) && trackingLinkBlock(facts) === null;
}
