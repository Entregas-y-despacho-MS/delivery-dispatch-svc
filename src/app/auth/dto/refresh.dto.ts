import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshDto {
    @ApiProperty({
        example:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        description: 'Refresh token received from the last successful login, register, or refresh.',
    })
    @IsString()
    @IsNotEmpty({ message: 'Refresh token is required.' })
    refreshToken: string;
}
