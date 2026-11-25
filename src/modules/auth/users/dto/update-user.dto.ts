import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeEmail } from './create-user.dto.js';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { PASSWORD_MIN_LENGTH_FLOOR, PASSWORD_TOO_SHORT_FLOOR_MESSAGE } from '../../../../shared/validators/password.validator.js';

export class UpdateUserDto {
    @ApiPropertyOptional({ example: 'Ana Torrez', maxLength: 150, description: 'New full name. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(150)
    fullName?: string;

    @ApiPropertyOptional({ example: 'atorrez', maxLength: 50, description: 'New login name. Must not belong to another user. null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MaxLength(50)
    username?: string;

    // Deliberately @IsOptional() (not OptionalNotNull): users.email is nullable, so null is a valid
    // way to clear it. Every other field here is NOT NULL.
    @ApiPropertyOptional({ type: String, example: 'ana@hipermaxi.com', maxLength: 150, nullable: true, description: 'New email, which must not belong to another user. null clears it' })
    @IsOptional()
    @Transform(normalizeEmail)
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    @MaxLength(150)
    email?: string;

    @ApiPropertyOptional({ example: 'NewPassw0rd!', minLength: 8, maxLength: 255, description: 'Resets the password (admin action). Must meet the password policy set by the administrator: at least the minimum length in settings (password_min_length, never below 8) and the required character classes (password_require_uppercase, password_require_lowercase, password_require_number, password_require_symbol; all required by default). null is rejected' })
    @OptionalNotNull()
    @IsString()
    @MinLength(PASSWORD_MIN_LENGTH_FLOOR, { message: PASSWORD_TOO_SHORT_FLOOR_MESSAGE })
    @MaxLength(255)
    password?: string;

    @ApiPropertyOptional({ example: false, description: 'false deactivates the user (cannot log in) without deleting it; true reactivates. null is rejected' })
    @OptionalNotNull()
    @IsBoolean()
    active?: boolean;
}
