import { ConflictException } from '@nestjs/common';

export class DispatchReturnNotAllowedException extends ConflictException {
    constructor(status: string) {
        super({
            message: `A dispatch can only be returned to the warehouse from incident or not_delivered (current status: ${status}).`,
            error:   'DISPATCH_RETURN_NOT_ALLOWED',
        });
    }
}
