import { InternalServerErrorException } from '@nestjs/common';

export class SettingsVersionException extends InternalServerErrorException {
    constructor() {
        super({ message: 'Settings version is missing or invalid.', error: 'SETTINGS_VERSION_UNAVAILABLE' });
    }
}
