import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, IsStrongPassword, Max, MaxLength } from 'class-validator';
import { INT4_MAX } from '../../../../shared/constants/int4.js';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../../shared/validators/password.validator.js';

// Emails are stored and looked up in lowercase: "Ana@x.com" and "ana@x.com" are the same address.
export const normalizeEmail = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class CreateUserDto {
    @ApiProperty({ example: 'Ana Torrez', maxLength: 150, description: "The user's full name, as shown in the app" })
    @IsString()
    @IsNotEmpty({ message: 'Full name is required.' })
    @MaxLength(150)
    fullName: string;

    @ApiProperty({ example: 'atorrez', maxLength: 50, description: 'Login name. Must not belong to another user' })
    @IsString()
    @IsNotEmpty({ message: 'Username is required.' })
    @MaxLength(50, { message: 'Username must not exceed 50 characters.' })
    username: string;

    @ApiPropertyOptional({ example: 'ana@hipermaxi.com', maxLength: 150, description: 'Optional. A valid email address that must not belong to another user. Needed to recover the password by email' })
    @IsOptional()
    @Transform(normalizeEmail)
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    @MaxLength(150)
    email?: string;

    @ApiProperty({ example: 'Passw0rd!', minLength: 8, maxLength: 255, description: 'Must be at least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol, and meet the minimum length set in settings (password_min_length). It is stored hashed and never returned' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    password: string;

    @ApiProperty({ type: 'integer', example: 3, description: 'ID of the role to assign, from GET /roles (root, admin, coordinator, supervisor or driver). An unknown ID is a 400 INVALID_ROLE' })
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    @Max(INT4_MAX, { message: 'Role ID is too large.' })
    roleId: number;
}
