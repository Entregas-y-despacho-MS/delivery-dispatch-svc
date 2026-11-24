import { BadRequestException } from '@nestjs/common';

/**
 * The one answer for every way the access by code can fail to verify: unknown, malformed, expired or already used tracking
 * code, or a wrong one-time code. Nothing in it says which, so it cannot be used to find out whether a code exists.
 */
export class InvalidAccessCodeException extends BadRequestException {
    constructor() {
        super({ message: 'The tracking code or the verification code is not valid. Request a new code and try again.', error: 'INVALID_ACCESS_CODE' });
    }
}
