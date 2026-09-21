import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from '../../../modules/auth/users/services/users.service.js';
import { UserForAuthDto } from '../../../modules/auth/users/dto/user-for-auth.dto.js';
import { TwoFactorService } from '../services/two-factor.service.js';
import { TwoFactorSecretDto } from '../dto/two-factor-secret.dto.js';
import { ConfirmTwoFactorDto } from '../dto/confirm-two-factor.dto.js';
import { DisableTwoFactorDto } from '../dto/disable-two-factor.dto.js';
import { CurrentUser } from '../../../shared/decorators/current-user.decorator.js';
import type { AuthUser } from '../strategies/jwt.strategy.js';
import { InvalidCredentialsException, InvalidTotpCodeException } from '../exceptions/index.js';
import { comparePassword } from '../../../shared/utils/crypto.util.js';
import { ApiUnauthorized, ApiValidationError } from '../../../shared/utils/swagger/index.js';

/**
 * Error dictionary for this module:
 *   INVALID_TOTP_CODE   401 — The 6-digit code does not match.
 *   INVALID_CREDENTIALS 401 — Wrong password (disable only).
 *   INVALID_TOKEN        401 — JWT is missing, malformed, or expired.
 *
 * Self-service — every endpoint here acts on the caller's own account (no role restriction
 * beyond being authenticated).
 */
@ApiTags('Auth — 2FA')
@ApiBearerAuth('access-token')
@Controller('auth/2fa')
export class TwoFactorController {
    constructor(
        private readonly usersService: UsersService,
        private readonly twoFactor:    TwoFactorService,
    ) {}

    @Post('enable')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary:     'Start 2FA enrollment',
        description: 'Generates a new TOTP secret and returns a QR code to scan with an authenticator app. 2FA is NOT enabled yet — confirm with POST /auth/2fa/confirm.',
    })
    @ApiOkResponse({ type: TwoFactorSecretDto })
    @ApiUnauthorized({ code: 'INVALID_TOKEN', message: 'Invalid or expired token.' })
    async enable(@CurrentUser() user: AuthUser): Promise<TwoFactorSecretDto> {
        const secret = this.twoFactor.generateSecret();
        await this.usersService.setTwoFactorSecret(user.id, secret);
        const qrCodeDataUrl = await this.twoFactor.generateQrCodeDataUrl(secret, user.username);
        return { secret, qrCodeDataUrl };
    }

    @Post('confirm')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Confirm 2FA enrollment',
        description: 'Verifies a code generated from the secret returned by POST /auth/2fa/enable. On success, 2FA becomes required at login.',
    })
    @ApiNoContentResponse({ description: '2FA enabled.' })
    @ApiValidationError()
    @ApiUnauthorized(
        { code: 'INVALID_TOTP_CODE', message: 'Invalid TOTP code.' },
        { code: 'INVALID_TOKEN',     message: 'Invalid or expired token.' },
    )
    async confirm(@CurrentUser('id') userId: number, @Body() dto: ConfirmTwoFactorDto): Promise<void> {
        const user = await this.usersService.findOneById(UserForAuthDto, userId);
        if (!user.twoFactorSecret || !(await this.twoFactor.verify(user.twoFactorSecret, dto.code))) {
            throw new InvalidTotpCodeException();
        }
        await this.usersService.setTwoFactorEnabled(userId, true);
    }

    @Post('disable')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary:     'Disable 2FA',
        description: 'Requires the current password as confirmation.',
    })
    @ApiNoContentResponse({ description: '2FA disabled.' })
    @ApiValidationError()
    @ApiUnauthorized(
        { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' },
        { code: 'INVALID_TOKEN',       message: 'Invalid or expired token.' },
    )
    async disable(@CurrentUser('id') userId: number, @Body() dto: DisableTwoFactorDto): Promise<void> {
        const user = await this.usersService.findOneById(UserForAuthDto, userId);
        if (!(await comparePassword(dto.password, user.passwordHash))) throw new InvalidCredentialsException();
        await this.usersService.setTwoFactorEnabled(userId, false);
    }
}
