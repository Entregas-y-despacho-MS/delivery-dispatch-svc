import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ConfirmTwoFactorDto {
    @ApiProperty({ example: '123456', description: 'Current 6-digit code shown by the authenticator app after scanning the QR from POST /auth/2fa/enable', minLength: 6, maxLength: 6 })
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @Length(6, 6, { message: 'Code must be 6 digits.' })
    code: string;
}
