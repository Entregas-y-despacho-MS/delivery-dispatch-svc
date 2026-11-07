import { ConflictException } from '@nestjs/common';

export class DispatchCancelNotAllowedException extends ConflictException {
    /** `allowed` defaults to the statuses of a delivery; a pickup passes its own list. */
    constructor(
        status: string,
        allowed: readonly string[] = ['pending', 'address_review', 'in_planning', 'scheduled', 'assigned'],
    ) {
        super({
            message: `A dispatch can only be cancelled by the coordinator before the route starts: ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]} (current status: ${status}).`,
            error:   'DISPATCH_CANCEL_NOT_ALLOWED',
        });
    }
}
