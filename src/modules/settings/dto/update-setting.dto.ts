import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateSettingDto {
    @ApiProperty({ example: '5' })
    @IsString()
    @IsNotEmpty({ message: 'Value is required.' })
    @MaxLength(65535)
    value: string;
}
