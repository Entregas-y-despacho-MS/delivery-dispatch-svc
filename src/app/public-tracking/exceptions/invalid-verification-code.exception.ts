import { BadRequestException } from '@nestjs/common';

export class InvalidVerificationCodeException extends BadRequestException {
    constructor(attemptsLeft: number) {
        super({ message: 'The verification code is not correct.', error: 'INVALID_VERIFICATION_CODE', details: { attemptsLeft } });
    }
}
