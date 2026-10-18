import { NotFoundException } from '@nestjs/common';

/**
 * One answer for every link that does not work: unknown, malformed, expired, or a `tracking_code` used
 * as a token. Nothing in the body or the status tells them apart, so the response never reveals whether a
 * token exists (D-17).
 */
export class TrackingLinkNotFoundException extends NotFoundException {
    constructor() { super({ message: 'Tracking link not found.', error: 'TRACKING_LINK_NOT_FOUND' }); }
}
