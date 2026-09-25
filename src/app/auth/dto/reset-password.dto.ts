import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsStrongPassword, MaxLength } from 'class-validator';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../shared/validators/password.validator.js';

export class ResetPasswordDto {
    @ApiProperty({ example: '9f2c1e7a4b6d...', description: 'Token received by email after POST /auth/forgot-password. Single-use, and it expires' })
    @IsString()
    @IsNotEmpty({ message: 'Token is required.' })
    token: string;

    @ApiProperty({ example: 'NewPassw0rd!', minLength: 8, maxLength: 255, description: 'The new password. Must be at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol, and meet the minimum length set in settings. It must also differ from the current password and the last 3 used' })
    @IsString()
    @IsNotEmpty({ message: 'New password is required.' })
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    newPassword: string;
}
