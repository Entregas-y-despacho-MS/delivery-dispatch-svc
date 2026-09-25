import { NotFoundException } from '@nestjs/common';

export class ServiceLevelNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Service level not found.', error: 'SERVICE_LEVEL_NOT_FOUND' });
    }
}
