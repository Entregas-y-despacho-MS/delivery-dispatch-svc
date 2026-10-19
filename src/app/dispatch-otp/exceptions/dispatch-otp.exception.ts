import { HttpException } from '@nestjs/common';

export class DispatchOtpException extends HttpException {
    constructor(code: string, message: string, status = 409) {
        super({ error: code, message }, status);
    }
}
