import { ApiProperty } from '@nestjs/swagger';
import { DtoField } from '../../../shared/orm/index.js';

export class SettingDto {
    @DtoField()
    @ApiProperty({ example: 'max_failed_login_attempts' })
    key!: string;

    @DtoField()
    @ApiProperty({ example: '5' })
    value!: string;

    @DtoField()
    @ApiProperty({ example: 'Failed login attempts before an account is locked', nullable: true })
    description!: string | null;

    @DtoField()
    @ApiProperty({ example: '2024-01-01T00:00:00.000Z' })
    updatedAt!: Date;
}
