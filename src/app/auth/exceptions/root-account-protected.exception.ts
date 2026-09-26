import { ForbiddenException } from '@nestjs/common';

export class RootAccountProtectedException extends ForbiddenException {
    constructor() {
        super({
            message: 'Only root can create, edit or delete root accounts, or give the root role.',
            error:   'ROOT_ACCOUNT_PROTECTED',
        });
    }
}
