import { ForbiddenException } from '@nestjs/common';

export class SettingManagedSeparatelyException extends ForbiddenException {
    constructor(endpoint: string) {
        super({ message: `This setting is changed only through ${endpoint}.`, error: 'SETTING_MANAGED_SEPARATELY' });
    }
}
