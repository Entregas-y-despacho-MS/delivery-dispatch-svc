import { BadRequestException } from '@nestjs/common';

export class InvalidRoleException extends BadRequestException {
    constructor() {
        super({ message: 'The given role does not exist.', error: 'INVALID_ROLE' });
    }
}
