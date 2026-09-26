import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsPositive, IsString, IsStrongPassword, Max, MaxLength } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { normalizeEmail } from './create-user.dto.js';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../../shared/validators/password.validator.js';

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

    @ApiPropertyOptional({ example: 'NewPassw0rd!', minLength: 8, maxLength: 255, description: 'Resets the password (admin action). Must be at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol, and meet the minimum length set in settings (password_min_length). null is rejected' })
    @OptionalNotNull()
    @IsString()
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    password?: string;

    @ApiPropertyOptional({ type: 'integer', example: 2, description: 'New role, an ID from GET /roles (an unknown ID is a 400 INVALID_ROLE). null is rejected' })
    @OptionalNotNull()
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    @Max(INT4_MAX, { message: 'Role ID is too large.' })
    roleId?: number;

    @ApiPropertyOptional({ example: false, description: 'false deactivates the user (cannot log in) without deleting it; true reactivates. null is rejected' })
    @OptionalNotNull()
    @IsBoolean()
    active?: boolean;
}
