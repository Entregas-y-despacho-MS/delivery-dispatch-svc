import { HttpException, HttpStatus } from '@nestjs/common';

/** Same message for any tracking code, existing or not: the limits are counted per fingerprint of the code. */
export class TrackingAccessRateLimitedException extends HttpException {
    constructor() {
        super(
            { message: 'Too many attempts. Wait a few minutes and try again.', error: 'TRACKING_ACCESS_RATE_LIMITED' },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}
