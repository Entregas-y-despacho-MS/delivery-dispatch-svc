import { ConflictException } from '@nestjs/common';

export class DispatchCancelNotAllowedException extends ConflictException {
    constructor(status: string) {
        super({
            message: `A dispatch can only be cancelled by the coordinator before the route starts: pending, address_review, in_planning, scheduled or assigned (current status: ${status}).`,
            error:   'DISPATCH_CANCEL_NOT_ALLOWED',
        });
    }
}
