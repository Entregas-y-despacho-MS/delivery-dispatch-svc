import { ConflictException } from '@nestjs/common';

export class ServiceLevelNameAlreadyExistsException extends ConflictException {
    constructor() {
        super({ message: 'A service level with this name already exists.', error: 'SERVICE_LEVEL_NAME_ALREADY_EXISTS' });
    }
}
