import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsStrongPassword, MaxLength } from 'class-validator';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../shared/validators/password.validator.js';

export class ChangePasswordDto {
    @ApiProperty({ example: 'OldPassw0rd!' })
    @IsString()
    @IsNotEmpty({ message: 'Current password is required.' })
    currentPassword: string;

    @ApiProperty({ example: 'NewPassw0rd!', minLength: 8, maxLength: 255 })
    @IsString()
    @IsNotEmpty({ message: 'New password is required.' })
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    newPassword: string;
}
