import { HttpException, HttpStatus } from '@nestjs/common';

export class VerificationCodeRateLimitedException extends HttpException {
    constructor() {
        super(
            { message: 'Too many verification codes were requested. Wait a few minutes and try again.', error: 'VERIFICATION_CODE_RATE_LIMITED' },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}
