import { UnauthorizedException } from '@nestjs/common';

/** Missing, malformed, expired or unknown session: one answer for all of them. */
export class TrackingSessionInvalidException extends UnauthorizedException {
    constructor() {
        super({ message: 'The tracking session is not valid or has expired. Verify your tracking code again.', error: 'TRACKING_SESSION_INVALID' });
    }
}
