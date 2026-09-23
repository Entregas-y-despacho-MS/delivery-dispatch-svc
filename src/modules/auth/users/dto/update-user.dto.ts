import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsPositive, IsString, IsStrongPassword, MaxLength } from 'class-validator';
import { OptionalNotNull } from '../../../../shared/validators/optional-not-null.validator.js';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../../shared/validators/password.validator.js';

export class UpdateUserDto {
    @ApiPropertyOptional({ example: 'Ana Torrez', maxLength: 150 })
    @OptionalNotNull()
    @IsString()
    @MaxLength(150)
    fullName?: string;

    @ApiPropertyOptional({ example: 'atorrez', maxLength: 50 })
    @OptionalNotNull()
    @IsString()
    @MaxLength(50)
    username?: string;

    // Deliberately @IsOptional() (not OptionalNotNull): users.email is nullable, so null is a valid
    // way to clear it. Every other field here is NOT NULL.
    @ApiPropertyOptional({ example: 'ana@hipermaxi.com', maxLength: 150 })
    @IsOptional()
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    @MaxLength(150)
    email?: string;

    @ApiPropertyOptional({ example: 'NewPassw0rd!', minLength: 8 })
    @OptionalNotNull()
    @IsString()
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    password?: string;

    @ApiPropertyOptional({ example: 2, description: 'Role ID (must exist in the roles table)' })
    @OptionalNotNull()
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    roleId?: number;

    @ApiPropertyOptional({ example: false, description: 'Deactivate the user without deleting it.' })
    @OptionalNotNull()
    @IsBoolean()
    active?: boolean;
}
