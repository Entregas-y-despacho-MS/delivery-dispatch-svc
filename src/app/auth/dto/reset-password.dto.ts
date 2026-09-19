import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
    @ApiProperty({ description: 'Token received by email via POST /auth/forgot-password.' })
    @IsString()
    @IsNotEmpty({ message: 'Token is required.' })
    token: string;

    @ApiProperty({ example: 'newPassword123', minLength: 6, maxLength: 255 })
    @IsString()
    @IsNotEmpty({ message: 'New password is required.' })
    @MinLength(6, { message: 'Password must be at least 6 characters.' })
    @MaxLength(255)
    newPassword: string;
}
