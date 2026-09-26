import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateSettingDto {
    @ApiProperty({ example: '5', minLength: 1, description: 'New value, as text, valid for that key (e.g. "5" for a number of minutes, "08:00" for a time; an out-of-range value is 400 INVALID_SETTING_VALUE). Cannot be empty' })
    @IsString()
    @IsNotEmpty({ message: 'Value is required.' })
    @MaxLength(65535)
    value: string;
}
