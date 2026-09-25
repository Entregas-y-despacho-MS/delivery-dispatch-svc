import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../shared/orm/index.js';

export class SettingDto {
    @DtoField()
    @ApiProperty({ example: 'max_failed_login_attempts', description: 'Unique key of the setting; use it in PUT /settings/{key}' })
    key!: string;

    @DtoField()
    @ApiProperty({ example: '5', description: 'Current value, always text (numbers and times are sent as text too, e.g. "5", "08:00")' })
    value!: string;

    @DtoField()
    @ApiProperty({ type: String, example: 'Failed login attempts before an account is locked', nullable: true, description: 'What the setting controls' })
    description!: string | null;

    @DtoField()
    @ApiProperty({ type: String, format: 'date-time', example: '2024-01-01T00:00:00.000Z', description: 'Last time the value was changed (UTC)' })
    updatedAt!: Date;
}
