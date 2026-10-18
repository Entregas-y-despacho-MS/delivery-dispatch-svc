import { UnprocessableEntityException } from '@nestjs/common';

export class SyncOtpVerificationRequiredException extends UnprocessableEntityException {
    constructor() {
        super({ message: 'Legacy OTP submissions are rejected. Online validation belongs to ST-31.3.', error: 'SYNC_OTP_VERIFICATION_REQUIRED' });
    }
}
