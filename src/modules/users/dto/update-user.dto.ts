import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsPositive, IsString, IsStrongPassword, MaxLength } from 'class-validator';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../shared/validators/password.validator.js';

export class UpdateUserDto {
    @ApiPropertyOptional({ example: 'Ana Torrez', maxLength: 150 })
    @IsOptional()
    @IsString()
    @MaxLength(150)
    fullName?: string;

    @ApiPropertyOptional({ example: 'atorrez', maxLength: 50 })
    @IsOptional()
    @IsString()
    @MaxLength(50)
    username?: string;

    @ApiPropertyOptional({ example: 'ana@hipermaxi.com', maxLength: 150 })
    @IsOptional()
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    @MaxLength(150)
    email?: string;

    @ApiPropertyOptional({ example: 'NewPassw0rd!', minLength: 8 })
    @IsOptional()
    @IsString()
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    password?: string;

    @ApiPropertyOptional({ example: 2, description: 'Role ID (must exist in the roles table)' })
    @IsOptional()
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    roleId?: number;

    @ApiPropertyOptional({ example: false, description: 'Deactivate the user without deleting it.' })
    @IsOptional()
    @IsBoolean()
    active?: boolean;
}
