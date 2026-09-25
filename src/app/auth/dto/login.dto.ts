import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class LoginDto {
    @ApiProperty({ example: 'atorrez', description: 'Login name of the account (not the email)' })
    @IsString()
    @IsNotEmpty({ message: 'Username is required.' })
    username: string;

    @ApiProperty({ example: 'Passw0rd!', description: 'Account password' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    password: string;

    @ApiPropertyOptional({ example: '123456', description: 'Current 6-digit code from the authenticator app. Send it only if the account has 2FA enabled: without it the answer is 401 TOTP_REQUIRED (and a wrong one 401 INVALID_TOTP_CODE), which is the signal to ask the user for the code and repeat the request' })
    @IsOptional()
    @IsString()
    @Length(6, 6, { message: 'Code must be 6 digits.' })
    totpCode?: string;
}
