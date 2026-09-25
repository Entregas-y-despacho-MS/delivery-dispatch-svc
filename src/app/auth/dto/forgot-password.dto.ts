import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
    @ApiProperty({ example: 'ana@hipermaxi.com', description: 'Email address registered on the account. A reset link/token is sent there if it matches an active account' })
    @IsEmail({}, { message: 'Email must be a valid email address.' })
    email: string;
}
