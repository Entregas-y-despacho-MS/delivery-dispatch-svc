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
import { ApiUnauthorized, ApiBadRequests } from '../../../shared/utils/swagger/index.js';

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
        description: 'Step 1 of 2 to turn on two-factor authentication for your own account: generates a TOTP secret and returns it with a QR code to scan in an authenticator app (Google Authenticator, Authy, etc.). 2FA is NOT active yet: confirm it with POST /auth/2fa/confirm. Calling it again generates a new secret that replaces the previous one. Requires any authenticated user.',
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
        description: 'Step 2: send the current 6-digit code shown by the authenticator app to prove the secret was scanned. On success 2FA is enabled and every future login must include `totpCode` (401 INVALID_TOTP_CODE if the code does not match). Requires any authenticated user.',
    })
    @ApiBadRequests({ validation: true, example: ['Code must be 6 digits.'] })
    @ApiNoContentResponse({ description: '2FA enabled.' })
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
        description: 'Turns off two-factor authentication for your own account and discards the secret. Requires the current password as confirmation (401 INVALID_CREDENTIALS if wrong). Requires any authenticated user.',
    })
    @ApiBadRequests({ validation: true, example: ['Password is required.'] })
    @ApiNoContentResponse({ description: '2FA disabled.' })
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
