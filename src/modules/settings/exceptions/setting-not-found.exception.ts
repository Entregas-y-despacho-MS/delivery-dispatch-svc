import { NotFoundException } from '@nestjs/common';

export class SettingNotFoundException extends NotFoundException {
    constructor() {
        super({ message: 'Setting not found.', error: 'SETTING_NOT_FOUND' });
    }
}
