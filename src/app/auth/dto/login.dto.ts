import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class LoginDto {
    @ApiProperty({ example: 'atorrez' })
    @IsString()
    @IsNotEmpty({ message: 'Username is required.' })
    username: string;

    @ApiProperty({ example: 'password123' })
    @IsString()
    @IsNotEmpty({ message: 'Password is required.' })
    password: string;

    @ApiPropertyOptional({ example: '123456', description: 'Required only if the account has 2FA enabled.' })
    @IsOptional()
    @IsString()
    @Length(6, 6, { message: 'Code must be 6 digits.' })
    totpCode?: string;
}
