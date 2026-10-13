import { ConflictException } from '@nestjs/common';

export class DispatchPriorityNotChangeableException extends ConflictException {
    constructor(status: string) {
        super({
            message: `The priority of a dispatch can only be changed while it is pending, in planning or scheduled (current status: ${status}).`,
            error:   'DISPATCH_PRIORITY_NOT_CHANGEABLE',
        });
    }
}
