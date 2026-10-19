import { ConflictException } from '@nestjs/common';

export class DispatchNotInTransitException extends ConflictException {
    constructor() {
        super({ message: 'Evidence can only be registered while the dispatch is in transit.', error: 'DISPATCH_NOT_IN_TRANSIT' });
    }
}
