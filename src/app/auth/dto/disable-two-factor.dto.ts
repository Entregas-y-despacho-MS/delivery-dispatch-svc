import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DisableTwoFactorDto {
    @ApiProperty({ example: 'password123', description: 'Current password, required to disable 2FA.' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    password: string;
}
