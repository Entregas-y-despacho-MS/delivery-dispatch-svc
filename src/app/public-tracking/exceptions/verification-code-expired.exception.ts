import { BadRequestException } from '@nestjs/common';

/** No code is pending: it was never requested, it expired, it was used, or too many wrong guesses burned it. */
export class VerificationCodeExpiredException extends BadRequestException {
    constructor() {
        super({ message: 'There is no valid verification code. Request a new one.', error: 'VERIFICATION_CODE_EXPIRED' });
    }
}
