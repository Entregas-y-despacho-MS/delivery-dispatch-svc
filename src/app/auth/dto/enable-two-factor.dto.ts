import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class EnableTwoFactorDto {
    @ApiProperty({ example: 'Passw0rd!', description: 'Your current password, to confirm that it is really you who is turning 2FA on (a stolen access token alone is not enough)' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    password: string;
}
