import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpdateSettingDto {
    @ApiProperty({ example: '5', description: 'New setting value as text. Empty is accepted only for settings whose rules allow an empty list.' })
    @IsString()
    @MaxLength(65535)
    value: string;
}
