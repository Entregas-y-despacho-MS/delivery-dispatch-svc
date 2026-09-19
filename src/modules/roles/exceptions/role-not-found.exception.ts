import { NotFoundException } from '@nestjs/common';

export class RoleNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Role not found.', error: 'ROLE_NOT_FOUND' });
    }
}
