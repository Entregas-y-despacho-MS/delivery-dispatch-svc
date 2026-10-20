import { ConflictException } from '@nestjs/common';

export class DispatchCancelNotAllowedException extends ConflictException {
    constructor(status: string) {
        super({
            message: `A dispatch can only be cancelled by the coordinator while it is assigned (current status: ${status}).`,
            error:   'DISPATCH_CANCEL_NOT_ALLOWED',
        });
    }
}
