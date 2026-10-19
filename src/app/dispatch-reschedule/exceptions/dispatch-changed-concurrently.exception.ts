import { ConflictException } from '@nestjs/common';

export class DispatchChangedConcurrentlyException extends ConflictException {
    constructor() {
        super({
            message: 'The dispatch changed while the request was being processed (it moved to another route). Review its current state and try again.',
            error:   'DISPATCH_CHANGED_CONCURRENTLY',
        });
    }
}
