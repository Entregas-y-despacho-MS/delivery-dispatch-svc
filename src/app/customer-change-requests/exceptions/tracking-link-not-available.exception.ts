import { ConflictException } from '@nestjs/common';

/** `reason`: `has_contact_email` (the customer already got the link by email) or `no_live_token` (none, or it expired). */
export class TrackingLinkNotAvailableException extends ConflictException {
    constructor(reason: string) {
        super({ message: 'The tracking link of this customer cannot be shown.', error: 'TRACKING_LINK_NOT_AVAILABLE', details: { reason } });
    }
}
