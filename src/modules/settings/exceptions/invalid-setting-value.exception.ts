import { BadRequestException } from '@nestjs/common';

export class InvalidSettingValueException extends BadRequestException {
    constructor(message: string) {
        super({ message, error: 'INVALID_SETTING_VALUE' });
    }
}
