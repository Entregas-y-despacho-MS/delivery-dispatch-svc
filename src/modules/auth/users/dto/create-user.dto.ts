import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, IsStrongPassword, MaxLength } from 'class-validator';
import { STRONG_PASSWORD_OPTIONS, STRONG_PASSWORD_MESSAGE } from '../../../../shared/validators/password.validator.js';

export class CreateUserDto {
    @ApiProperty({ example: 'Ana Torrez', maxLength: 150 })
    @IsString()
    @IsNotEmpty({ message: 'Full name is required.' })
    @MaxLength(150)
    fullName: string;

    @ApiProperty({ example: 'atorrez', maxLength: 50 })
    @IsString()
    @IsNotEmpty({ message: 'Username is required.' })
    @MaxLength(50, { message: 'Username must not exceed 50 characters.' })
    username: string;

    @ApiPropertyOptional({ example: 'ana@hipermaxi.com', maxLength: 150 })
    @IsOptional()
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    @MaxLength(150)
    email?: string;

    @ApiProperty({ example: 'Passw0rd!', minLength: 8, maxLength: 255 })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    @IsStrongPassword(STRONG_PASSWORD_OPTIONS, { message: STRONG_PASSWORD_MESSAGE })
    @MaxLength(255)
    password: string;

    @ApiProperty({ example: 3, description: 'Role ID (must exist in the roles table)' })
    @IsInt({ message: 'Role ID must be an integer.' })
    @IsPositive({ message: 'Role ID must be a positive number.' })
    roleId: number;
}
