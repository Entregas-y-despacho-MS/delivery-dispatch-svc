import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MIN_LENGTH_FLOOR, PASSWORD_TOO_SHORT_FLOOR_MESSAGE } from '../../../shared/validators/password.validator.js';

export class ResetPasswordDto {
    @ApiProperty({ example: '9f2c1e7a4b6d...', description: 'Token received by email after POST /auth/forgot-password. Single-use, and it expires' })
    @IsString()
    @IsNotEmpty({ message: 'Token is required.' })
    token: string;

    @ApiProperty({ example: 'NewPassw0rd!', minLength: 8, maxLength: 255, description: 'The new password. Must meet the password policy set by the administrator: at least the minimum length in settings (password_min_length, never below 8) and the required character classes (password_require_*; all required by default). It must also differ from the current password and the last 3 used' })
    @IsString()
    @IsNotEmpty({ message: 'New password is required.' })
    @MinLength(PASSWORD_MIN_LENGTH_FLOOR, { message: PASSWORD_TOO_SHORT_FLOOR_MESSAGE })
    @MaxLength(255)
    newPassword: string;
}
