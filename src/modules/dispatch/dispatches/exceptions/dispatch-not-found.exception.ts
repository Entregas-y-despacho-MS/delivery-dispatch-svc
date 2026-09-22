import { NotFoundException } from '@nestjs/common';

export class DispatchNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Dispatch not found.', error: 'DISPATCH_NOT_FOUND' });
    }
}
