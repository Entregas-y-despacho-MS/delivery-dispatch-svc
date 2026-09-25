import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DisableTwoFactorDto {
    @ApiProperty({ example: 'Passw0rd!', description: 'Your current password, required to confirm that you want to disable 2FA' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    password: string;
}
