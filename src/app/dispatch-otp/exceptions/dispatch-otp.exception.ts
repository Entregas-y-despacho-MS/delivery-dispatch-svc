import { HttpException } from '@nestjs/common';

export class DispatchOtpException extends HttpException {
    constructor(code: string, message: string, status = 409) {
        super({ error: code, message }, status);
    }
}

export const OTP_CONSUMED_MESSAGE = 'The code was already used.';
