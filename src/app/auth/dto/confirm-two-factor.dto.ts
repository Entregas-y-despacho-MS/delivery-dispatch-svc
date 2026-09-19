import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class ConfirmTwoFactorDto {
    @ApiProperty({ example: '123456', description: 'Current 6-digit code from the authenticator app.' })
    @IsString()
    @IsNotEmpty({ message: 'Code is required.' })
    @Length(6, 6, { message: 'Code must be 6 digits.' })
    code: string;
}
