import { ForbiddenException } from '@nestjs/common';

/** The request carries no proof of verification, or the proof is wrong or expired: ask for a code again. */
export class VerificationRequiredException extends ForbiddenException {
    constructor() {
        super({ message: 'Verify the code sent to your email first.', error: 'VERIFICATION_REQUIRED' });
    }
}
