import { ServiceUnavailableException } from '@nestjs/common';

export class VerificationCodeNotSentException extends ServiceUnavailableException {
    constructor() {
        super({ message: 'The verification code could not be sent. Try again in a moment.', error: 'VERIFICATION_CODE_NOT_SENT' });
    }
}
