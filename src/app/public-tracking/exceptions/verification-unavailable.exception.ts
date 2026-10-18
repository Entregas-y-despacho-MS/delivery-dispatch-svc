import { ServiceUnavailableException } from '@nestjs/common';

/** The cache that holds codes and proofs is down. Viewing, confirming and asking for a change keep working. */
export class VerificationUnavailableException extends ServiceUnavailableException {
    constructor() {
        super({ message: 'Verification is temporarily unavailable. Try again in a moment.', error: 'VERIFICATION_UNAVAILABLE' });
    }
}
