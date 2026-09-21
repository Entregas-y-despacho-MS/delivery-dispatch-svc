import { ApiProperty } from '@nestjs/swagger';
import { UserDto } from '../../../modules/auth/users/dto/user.dto.js';

export class AuthResponseDto {
    @ApiProperty({
        example:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        description: 'Short-lived access token (JWT_TIME_EXPIRE, default 15 min). Send as Authorization: Bearer <token> on every request.',
    })
    accessToken: string;

    @ApiProperty({
        example:     'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        description: 'Long-lived refresh token (JWT_REFRESH_TIME_EXPIRE, default 7 days). Use only at POST /auth/refresh. Store securely (httpOnly cookie or secure storage).',
    })
    refreshToken: string;

    @ApiProperty({ type: UserDto })
    user: UserDto;

    @ApiProperty({
        example:     false,
        description: 'true if the client must redirect to a forced password-change screen before continuing — ' +
                      'either an admin flagged the account, or the password is past password_expiration_days (RF-A25).',
    })
    mustChangePassword: boolean;
}
